import { hostname } from 'node:os';

import type {
  IncrementalSessionInput,
  QueuePromotionInput,
  QueuePromotionResult,
  RecoverySessionInput,
  SessionCheckpointInput,
  SessionCloseInput,
  SessionContext,
  TaskStatus,
} from '../contracts/session-contracts.js';
import { isTerminalTaskStatus } from '../contracts/session-contracts.js';
import {
  appendRunEvent,
  linkMemoryRecord,
  writeCheckpoint,
  type CheckpointRecord,
} from '../db/checkpoint-writer.js';
import {
  claimSpecificIssueLease,
  claimOrResumeLease,
  findRecoverableLeasesForIssue,
  loadRecoveryIssue,
  promoteEligiblePendingIssues,
  reconcileProjectState,
  selectNextRecoveryIssue,
  markLeaseRecovered,
  releaseLease,
  updateIssueStatus,
} from '../db/lease-manager.js';
import { openHarnessDatabase, runStatement } from '../db/store.js';
import type { Mem0Adapter, MemoryKind, MemoryScope } from 'mem0-mcp';
import { Mem0SessionBridge } from './mem0-session-bridge.js';

export interface SessionCheckpointResult {
  context: SessionContext;
  checkpoint: CheckpointRecord;
  memoryId?: string;
  mem0WriteSkippedReason?: string;
  promotedIssueIds?: string[];
}

export interface SessionOrchestratorOptions {
  mem0Adapter?: Mem0Adapter | null;
  defaultLeaseTtlSeconds?: number;
  defaultCheckpointFreshnessSeconds?: number;
  defaultMemorySearchLimit?: number;
}

export class SessionOrchestrator {
  private readonly mem0Bridge: Mem0SessionBridge;
  private readonly defaultLeaseTtlSeconds: number;
  private readonly defaultCheckpointFreshnessSeconds: number;
  private readonly defaultMemorySearchLimit: number;

  constructor(options: SessionOrchestratorOptions = {}) {
    this.mem0Bridge = new Mem0SessionBridge(options.mem0Adapter ?? null);
    this.defaultLeaseTtlSeconds = options.defaultLeaseTtlSeconds ?? 1800;
    this.defaultCheckpointFreshnessSeconds =
      options.defaultCheckpointFreshnessSeconds ??
      this.defaultLeaseTtlSeconds;
    this.defaultMemorySearchLimit = options.defaultMemorySearchLimit ?? 5;
  }

  async beginIncrementalSession(
    input: IncrementalSessionInput,
  ): Promise<SessionContext> {
    const database = openHarnessDatabase({ dbPath: input.dbPath });

    try {
      const now = new Date().toISOString();
      const agentId = input.agentId ?? input.sessionId;
      const host = input.host ?? hostname();
      const runId = input.sessionId;

      createRunRecord(database.connection, {
        runId,
        sessionType: 'incremental',
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        campaignId: input.campaignId,
        host,
        status: 'reconciling',
        startedAt: now,
        notes: JSON.stringify({
          progressPath: input.progressPath,
          featureListPath: input.featureListPath,
          planPath: input.planPath,
          syncManifestPath: input.syncManifestPath,
          mem0Enabled: input.mem0Enabled,
          agentId,
        }),
      });
      const reconciliationBlockers = reconcileProjectState(database.connection, {
        projectId: input.projectId,
        campaignId: input.campaignId,
        checkpointFreshnessSeconds:
          input.checkpointFreshnessSeconds ??
          this.defaultCheckpointFreshnessSeconds,
        now,
      });

      if (reconciliationBlockers.length > 0) {
        for (const blocker of reconciliationBlockers) {
          writeCheckpoint(database.connection, {
            runId,
            issueId: blocker.issueId,
            title: 'needs_recovery',
            summary: blocker.summary,
            taskStatus: 'needs_recovery',
            nextStep: blocker.nextStep,
            artifactIds: [],
            createdAt: now,
          });
        }

        appendRunEvent(database.connection, {
          runId,
          kind: 'reconciliation_blocked',
          payload: {
            blockers: reconciliationBlockers,
          },
          createdAt: now,
        });

        updateRunStatus(
          database.connection,
          runId,
          'needs_recovery',
          now,
        );

        throw new Error(
          `Reconciliation is required before new claims: ${reconciliationBlockers
            .map((blocker) => `${blocker.issueId}:${blocker.reason}`)
            .join(', ')}`,
        );
      }

      const leaseResult = claimOrResumeLease(database.connection, {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        campaignId: input.campaignId,
        preferredIssueId: input.preferredIssueId,
        agentId,
        leaseTtlSeconds: input.leaseTtlSeconds ?? this.defaultLeaseTtlSeconds,
        now,
      });
      updateRunStatus(database.connection, runId, 'in_progress', undefined);

      updateIssueStatus(database.connection, leaseResult.issue.id, 'in_progress');

      const claimCheckpoint = writeCheckpoint(database.connection, {
        runId,
        issueId: leaseResult.issue.id,
        title: leaseResult.resumed ? 'resume' : 'claim',
        summary: leaseResult.resumed
          ? `Resumed issue ${leaseResult.issue.id} under active lease ${leaseResult.lease.id}.`
          : `Claimed issue ${leaseResult.issue.id} under lease ${leaseResult.lease.id}.`,
        taskStatus: 'in_progress',
        nextStep:
          leaseResult.issue.nextBestAction ??
          `Continue work on issue ${leaseResult.issue.id}.`,
        artifactIds: [],
        createdAt: now,
      });

      const scope = buildMemoryScope({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        campaignId: input.campaignId,
        issueId: leaseResult.issue.id,
        runId,
      });
      const recallScope = buildRecallScope({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        campaignId: input.campaignId,
        issueId: leaseResult.issue.id,
      });
      const memoryQuery = input.memoryQuery ?? leaseResult.issue.task;
      const mem0Context = await this.mem0Bridge.loadContext({
        enabled: input.mem0Enabled,
        scope: recallScope,
        query: memoryQuery,
        limit: input.memorySearchLimit ?? this.defaultMemorySearchLimit,
      });

      appendRunEvent(database.connection, {
        runId,
        issueId: leaseResult.issue.id,
        kind: mem0Context.available ? 'mem0_context_loaded' : 'mem0_context_unavailable',
        payload: {
          query: memoryQuery,
          recalledMemoryCount: mem0Context.recalledMemories.length,
          details: mem0Context.details,
        },
        createdAt: now,
      });

      return {
        sessionId: input.sessionId,
        dbPath: input.dbPath,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        campaignId: input.campaignId,
        agentId,
        host,
        runId,
        leaseId: leaseResult.lease.id,
        leaseExpiresAt: leaseResult.lease.expiresAt,
        issueId: leaseResult.issue.id,
        issueTask: leaseResult.issue.task,
        claimMode: leaseResult.resumed ? 'resume' : 'claim',
        scope,
        currentTaskStatus: 'in_progress',
        currentCheckpointId: claimCheckpoint.id,
        mem0: mem0Context,
      };
    } finally {
      database.close();
    }
  }

  async beginRecoverySession(
    input: RecoverySessionInput,
  ): Promise<SessionContext> {
    const database = openHarnessDatabase({ dbPath: input.dbPath });

    try {
      const now = new Date().toISOString();
      const agentId = input.agentId ?? input.sessionId;
      const host = input.host ?? hostname();
      const runId = input.sessionId;

      createRunRecord(database.connection, {
        runId,
        sessionType: 'incremental-recovery',
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        campaignId: input.campaignId,
        host,
        status: 'recovering',
        startedAt: now,
        notes: JSON.stringify({
          progressPath: input.progressPath,
          featureListPath: input.featureListPath,
          planPath: input.planPath,
          syncManifestPath: input.syncManifestPath,
          mem0Enabled: input.mem0Enabled,
          agentId,
          recoverySummary: input.recoverySummary,
        }),
      });

      const recoveryIssue =
        input.preferredIssueId !== undefined
          ? loadRecoveryIssue(database.connection, input.preferredIssueId)
          : selectNextRecoveryIssue(
              database.connection,
              input.projectId,
              input.campaignId,
            );
      const recoverableLeases = findRecoverableLeasesForIssue(
        database.connection,
        recoveryIssue.id,
      );

      for (const lease of recoverableLeases) {
        markLeaseRecovered(database.connection, lease.id, now);
      }

      const recoveryLease = claimSpecificIssueLease(database.connection, {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        campaignId: input.campaignId,
        issueId: recoveryIssue.id,
        agentId,
        leaseTtlSeconds: input.leaseTtlSeconds ?? this.defaultLeaseTtlSeconds,
        now,
      });

      updateRunStatus(database.connection, runId, 'in_progress', undefined);
      updateIssueStatus(database.connection, recoveryIssue.id, 'in_progress');

      const recoveryCheckpoint = writeCheckpoint(database.connection, {
        runId,
        issueId: recoveryIssue.id,
        title: 'recovery_claim',
        summary: input.recoverySummary,
        taskStatus: 'in_progress',
        nextStep:
          input.recoveryNextStep ??
          recoveryIssue.nextBestAction ??
          `Continue recovery work on issue ${recoveryIssue.id}.`,
        artifactIds: [],
        createdAt: now,
      });

      appendRunEvent(database.connection, {
        runId,
        issueId: recoveryIssue.id,
        kind: 'recovery_resolved',
        payload: {
          recoveredLeaseIds: recoverableLeases.map((lease) => lease.id),
          replacementLeaseId: recoveryLease.id,
        },
        createdAt: now,
      });

      const scope = buildMemoryScope({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        campaignId: input.campaignId,
        issueId: recoveryIssue.id,
        runId,
      });
      const recallScope = buildRecallScope({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        campaignId: input.campaignId,
        issueId: recoveryIssue.id,
      });
      const memoryQuery = input.memoryQuery ?? recoveryIssue.task;
      const mem0Context = await this.mem0Bridge.loadContext({
        enabled: input.mem0Enabled,
        scope: recallScope,
        query: memoryQuery,
        limit: input.memorySearchLimit ?? this.defaultMemorySearchLimit,
      });

      appendRunEvent(database.connection, {
        runId,
        issueId: recoveryIssue.id,
        kind: mem0Context.available ? 'mem0_context_loaded' : 'mem0_context_unavailable',
        payload: {
          query: memoryQuery,
          recalledMemoryCount: mem0Context.recalledMemories.length,
          details: mem0Context.details,
          recovery: true,
        },
        createdAt: now,
      });

      return {
        sessionId: input.sessionId,
        dbPath: input.dbPath,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        campaignId: input.campaignId,
        agentId,
        host,
        runId,
        leaseId: recoveryLease.id,
        leaseExpiresAt: recoveryLease.expiresAt,
        issueId: recoveryIssue.id,
        issueTask: recoveryIssue.task,
        claimMode: 'recovery',
        scope,
        currentTaskStatus: 'in_progress',
        currentCheckpointId: recoveryCheckpoint.id,
        mem0: mem0Context,
      };
    } finally {
      database.close();
    }
  }

  async checkpoint(
    context: SessionContext,
    input: SessionCheckpointInput,
  ): Promise<SessionCheckpointResult> {
    const database = openHarnessDatabase({ dbPath: context.dbPath });

    try {
      const now = new Date().toISOString();

      updateIssueStatus(database.connection, context.issueId, input.taskStatus);
      updateRunStatus(database.connection, context.runId, input.taskStatus, undefined);

      const checkpoint = writeCheckpoint(database.connection, {
        runId: context.runId,
        issueId: context.issueId,
        title: input.title,
        summary: input.summary,
        taskStatus: input.taskStatus,
        nextStep: input.nextStep,
        artifactIds: input.artifactIds ?? [],
        createdAt: now,
      });

      const updatedContext: SessionContext = {
        ...context,
        currentTaskStatus: input.taskStatus,
        currentCheckpointId: checkpoint.id,
      };

      const shouldPersistMemory =
        input.persistToMem0 ?? isTerminalTaskStatus(input.taskStatus);

      if (!shouldPersistMemory) {
        return {
          context: updatedContext,
          checkpoint,
        };
      }

      const memoryResult = await this.mem0Bridge.storeCheckpointMemory({
        context: updatedContext.mem0,
        scope: updatedContext.scope,
        checkpointId: checkpoint.id,
        kind: input.memoryKind ?? defaultMemoryKindForStatus(input.taskStatus),
        content: input.memoryContent ?? input.summary,
        artifactIds: input.artifactIds ?? [],
        metadata: input.metadata ?? {},
        note: input.nextStep,
      });

      if (memoryResult.memory === null) {
        appendRunEvent(database.connection, {
          runId: context.runId,
          issueId: context.issueId,
          kind: 'mem0_write_skipped',
          payload: {
            checkpointId: checkpoint.id,
            reason: memoryResult.skippedReason,
          },
          createdAt: now,
        });

        return {
          context: updatedContext,
          checkpoint,
          mem0WriteSkippedReason: memoryResult.skippedReason,
        };
      }

      linkMemoryRecord(database.connection, {
        workspaceId: context.workspaceId,
        projectId: context.projectId,
        campaignId: context.campaignId,
        issueId: context.issueId,
        memoryKind: memoryResult.memory.kind,
        memoryRef: memoryResult.memory.id,
        summary: input.summary,
        createdAt: now,
      });

      appendRunEvent(database.connection, {
        runId: context.runId,
        issueId: context.issueId,
        kind: 'mem0_memory_linked',
        payload: {
          checkpointId: checkpoint.id,
          memoryId: memoryResult.memory.id,
          memoryKind: memoryResult.memory.kind,
        },
        createdAt: now,
      });

      return {
        context: updatedContext,
        checkpoint,
        memoryId: memoryResult.memory.id,
      };
    } finally {
      database.close();
    }
  }

  async close(
    context: SessionContext,
    input: SessionCloseInput,
  ): Promise<SessionCheckpointResult> {
    const checkpointResult = await this.checkpoint(context, {
      ...input,
      title: input.title,
      summary: input.summary,
      taskStatus: input.taskStatus,
      nextStep: input.nextStep,
      artifactIds: input.artifactIds,
      persistToMem0: input.persistToMem0 ?? true,
      memoryKind: input.memoryKind ?? 'summary',
      memoryContent: input.memoryContent ?? input.summary,
      metadata: input.metadata,
    });
    const database = openHarnessDatabase({ dbPath: context.dbPath });

    try {
      const finishedAt = new Date().toISOString();

      updateRunStatus(
        database.connection,
        context.runId,
        input.taskStatus,
        finishedAt,
      );

      if (input.releaseLease !== false) {
        releaseLease(database.connection, context.leaseId, finishedAt);
      }

      const promotedIssueIds =
        input.taskStatus === 'done'
          ? promoteEligiblePendingIssues(database.connection, {
              projectId: context.projectId,
              campaignId: context.campaignId,
            }).map((issue) => issue.id)
          : [];

      if (promotedIssueIds.length > 0) {
        appendRunEvent(database.connection, {
          runId: context.runId,
          issueId: context.issueId,
          kind: 'queue_promoted',
          payload: {
            promotedIssueIds,
          },
          createdAt: finishedAt,
        });
      }

      appendRunEvent(database.connection, {
        runId: context.runId,
        issueId: context.issueId,
        kind: 'session_closed',
        payload: {
          checkpointId: checkpointResult.checkpoint.id,
          releasedLease: input.releaseLease !== false,
          finalStatus: input.taskStatus,
        },
        createdAt: finishedAt,
      });

      return promotedIssueIds.length === 0
        ? checkpointResult
        : {
            ...checkpointResult,
            promotedIssueIds,
          };
    } finally {
      database.close();
    }
  }

  async promoteQueue(input: QueuePromotionInput): Promise<QueuePromotionResult> {
    const database = openHarnessDatabase({ dbPath: input.dbPath });

    try {
      const promotedIssueIds = promoteEligiblePendingIssues(database.connection, {
        projectId: input.projectId,
        campaignId: input.campaignId,
      }).map((issue) => issue.id);

      return {
        promotedIssueIds,
      };
    } finally {
      database.close();
    }
  }
}

interface CreateRunRecordInput {
  runId: string;
  sessionType: string;
  workspaceId: string;
  projectId: string;
  campaignId?: string;
  host: string;
  status: string;
  startedAt: string;
  notes: string;
}

function createRunRecord(
  connection: ReturnType<typeof openHarnessDatabase>['connection'],
  input: CreateRunRecordInput,
): void {
  runStatement(
    connection,
    `INSERT OR REPLACE INTO runs (
       id,
       workspace_id,
       project_id,
       campaign_id,
       session_type,
       host,
       status,
       started_at,
       finished_at,
       notes
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.runId,
      input.workspaceId,
      input.projectId,
      input.campaignId ?? null,
      input.sessionType,
      input.host,
      input.status,
      input.startedAt,
      null,
      input.notes,
    ],
  );
}

function updateRunStatus(
  connection: ReturnType<typeof openHarnessDatabase>['connection'],
  runId: string,
  taskStatus: TaskStatus,
  finishedAt?: string,
): void {
  runStatement(
    connection,
    `UPDATE runs
     SET status = ?, finished_at = COALESCE(?, finished_at)
     WHERE id = ?`,
    [taskStatus, finishedAt ?? null, runId],
  );
}

function buildMemoryScope(input: {
  workspaceId: string;
  projectId: string;
  campaignId?: string;
  issueId: string;
  runId: string;
}): MemoryScope {
  return {
    workspace: input.workspaceId,
    project: input.projectId,
    ...(input.campaignId ? { campaign: input.campaignId } : {}),
    task: input.issueId,
    run: input.runId,
  };
}

function buildRecallScope(input: {
  workspaceId: string;
  projectId: string;
  campaignId?: string;
  issueId: string;
}): MemoryScope {
  return {
    workspace: input.workspaceId,
    project: input.projectId,
    ...(input.campaignId ? { campaign: input.campaignId } : {}),
    task: input.issueId,
  };
}

function defaultMemoryKindForStatus(taskStatus: TaskStatus): MemoryKind {
  switch (taskStatus) {
    case 'done':
      return 'summary';
    case 'failed':
      return 'artifact_context';
    case 'blocked':
    case 'needs_recovery':
      return 'decision';
    default:
      return 'note';
  }
}
