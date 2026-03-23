import { hostname } from 'node:os';

import type {
  IncrementalSessionInput,
  QueuePromotionInput,
  QueuePromotionResult,
  RecoverySessionInput,
  SessionCheckpointInput,
  SessionCloseInput,
  SessionContext,
  SessionMemoryContext,
} from '../contracts/session-contracts.js';
import { isTerminalTaskStatus } from '../contracts/session-contracts.js';
import type {
  Mem0Adapter,
  MemoryKind,
  MemoryScope,
} from '../contracts/memory-contracts.js';
import type { TaskStatus } from '../contracts/task-domain.js';
import {
  appendRunEvent,
  linkMemoryRecord,
  writeCheckpoint,
  type CheckpointRecord,
} from '../db/checkpoint-writer.js';
import {
  claimOrResumeLease,
  claimSpecificIssueLease,
  findRecoverableLeasesForIssue,
  loadRecoveryIssue,
  markLeaseRecovered,
  promoteEligiblePendingIssues,
  reconcileProjectState,
  releaseLease,
  selectNextRecoveryIssue,
  updateIssueStatus,
  type ClaimedLeaseResult,
  type IssueRecord,
} from '../db/lease-manager.js';
import {
  openHarnessDatabase,
  runInTransaction,
  runStatement,
} from '../db/store.js';
import { Mem0SessionBridge } from './mem0-session-bridge.js';

export interface SessionCheckpointResult {
  context: SessionContext;
  checkpoint: CheckpointRecord;
  memoryId?: string;
  mem0WriteSkippedReason?: string;
  promotedIssueIds?: string[];
}

export interface SessionAdvanceResult {
  advanced: boolean;
  closeResult: SessionCheckpointResult;
  nextContext?: SessionContext;
  stopReason?: string;
}

export interface SessionOrchestratorOptions {
  mem0Adapter?: Mem0Adapter | null;
  defaultLeaseTtlSeconds?: number;
  defaultCheckpointFreshnessSeconds?: number;
  defaultMemorySearchLimit?: number;
}

interface BeginClaimCanonicalResult {
  kind: 'claimed';
  runId: string;
  issueId: string;
  recallScope: MemoryScope;
  memoryQuery: string;
  contextBase: Omit<SessionContext, 'mem0'>;
}

interface BeginBlockedCanonicalResult {
  kind: 'blocked';
  message: string;
}

type BeginCanonicalResult =
  | BeginClaimCanonicalResult
  | BeginBlockedCanonicalResult;

interface CanonicalCheckpointState {
  context: SessionContext;
  checkpoint: CheckpointRecord;
  promotedIssueIds: string[];
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
      const canonical = runInTransaction(database.connection, () =>
        this.beginIncrementalCanonical(database.connection, input),
      );

      if (canonical.kind === 'blocked') {
        throw new Error(canonical.message);
      }

      const mem0Context = await this.loadMem0Context({
        enabled: input.mem0Enabled,
        scope: canonical.recallScope,
        query: canonical.memoryQuery,
        limit: input.memorySearchLimit ?? this.defaultMemorySearchLimit,
      });

      this.recordMem0ContextEvent(
        database.connection,
        canonical.runId,
        canonical.issueId,
        canonical.memoryQuery,
        mem0Context,
      );

      return {
        ...canonical.contextBase,
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
      const canonical = runInTransaction(database.connection, () =>
        this.beginRecoveryCanonical(database.connection, input),
      );

      const mem0Context = await this.loadMem0Context({
        enabled: input.mem0Enabled,
        scope: canonical.recallScope,
        query: canonical.memoryQuery,
        limit: input.memorySearchLimit ?? this.defaultMemorySearchLimit,
      });

      this.recordMem0ContextEvent(
        database.connection,
        canonical.runId,
        canonical.issueId,
        canonical.memoryQuery,
        mem0Context,
        { recovery: true },
      );

      return {
        ...canonical.contextBase,
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
      const canonical = runInTransaction(database.connection, () =>
        this.writeCanonicalCheckpoint(
          database.connection,
          context,
          input,
          new Date().toISOString(),
        ),
      );

      return await this.finalizeCheckpointSideEffects(
        database.connection,
        canonical,
        input,
      );
    } finally {
      database.close();
    }
  }

  async close(
    context: SessionContext,
    input: SessionCloseInput,
  ): Promise<SessionCheckpointResult> {
    const database = openHarnessDatabase({ dbPath: context.dbPath });
    const normalizedInput = normalizeCloseInput(input);

    try {
      const canonical = runInTransaction(database.connection, () =>
        this.closeCanonical(
          database.connection,
          context,
          normalizedInput,
          new Date().toISOString(),
        ),
      );

      return await this.finalizeCheckpointSideEffects(
        database.connection,
        canonical,
        normalizedInput,
      );
    } finally {
      database.close();
    }
  }

  async advanceSession(
    context: SessionContext,
    closeInput: SessionCloseInput,
    nextInput: IncrementalSessionInput,
  ): Promise<SessionAdvanceResult> {
    const database = openHarnessDatabase({ dbPath: context.dbPath });
    const normalizedCloseInput = normalizeCloseInput(closeInput);

    try {
      const canonical = runInTransaction(database.connection, () => {
        const closeState = this.closeCanonical(
          database.connection,
          context,
          normalizedCloseInput,
          new Date().toISOString(),
        );

        try {
          const nextState = this.beginIncrementalCanonical(
            database.connection,
            nextInput,
          );

          return { closeState, nextState };
        } catch (error) {
          if (isExpectedAdvanceStop(error)) {
            return {
              closeState,
              nextState: {
                kind: 'blocked',
                message: getErrorMessage(error),
              } satisfies BeginBlockedCanonicalResult,
            };
          }

          throw error;
        }
      });

      const closeResult = await this.finalizeCheckpointSideEffects(
        database.connection,
        canonical.closeState,
        normalizedCloseInput,
      );

      if (canonical.nextState.kind === 'blocked') {
        return {
          advanced: false,
          closeResult,
          stopReason: canonical.nextState.message,
        };
      }

      const mem0Context = await this.loadMem0Context({
        enabled: nextInput.mem0Enabled,
        scope: canonical.nextState.recallScope,
        query: canonical.nextState.memoryQuery,
        limit: nextInput.memorySearchLimit ?? this.defaultMemorySearchLimit,
      });

      this.recordMem0ContextEvent(
        database.connection,
        canonical.nextState.runId,
        canonical.nextState.issueId,
        canonical.nextState.memoryQuery,
        mem0Context,
      );

      return {
        advanced: true,
        closeResult,
        nextContext: {
          ...canonical.nextState.contextBase,
          mem0: mem0Context,
        },
      };
    } finally {
      database.close();
    }
  }

  async promoteQueue(input: QueuePromotionInput): Promise<QueuePromotionResult> {
    const database = openHarnessDatabase({ dbPath: input.dbPath });

    try {
      const promotedIssueIds = runInTransaction(database.connection, () =>
        promoteEligiblePendingIssues(database.connection, {
          projectId: input.projectId,
          campaignId: input.campaignId,
        }).map((issue) => issue.id),
      );

      return {
        promotedIssueIds,
      };
    } finally {
      database.close();
    }
  }

  private beginIncrementalCanonical(
    connection: ReturnType<typeof openHarnessDatabase>['connection'],
    input: IncrementalSessionInput,
  ): BeginCanonicalResult {
    const now = new Date().toISOString();
    const agentId = input.agentId ?? input.sessionId;
    const host = input.host ?? hostname();
    const runId = input.sessionId;

    createRunRecord(connection, {
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

    const reconciliationBlockers = reconcileProjectState(connection, {
      projectId: input.projectId,
      campaignId: input.campaignId,
      checkpointFreshnessSeconds:
        input.checkpointFreshnessSeconds ??
        this.defaultCheckpointFreshnessSeconds,
      now,
    });

    if (reconciliationBlockers.length > 0) {
      for (const blocker of reconciliationBlockers) {
        writeCheckpoint(connection, {
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

      appendRunEvent(connection, {
        runId,
        kind: 'reconciliation_blocked',
        payload: {
          blockers: reconciliationBlockers,
        },
        createdAt: now,
      });

      updateRunStatus(connection, runId, 'needs_recovery', now);

      return {
        kind: 'blocked',
        message: `Reconciliation is required before new claims: ${reconciliationBlockers
          .map((blocker) => `${blocker.issueId}:${blocker.reason}`)
          .join(', ')}`,
      };
    }

    const leaseResult = claimOrResumeLease(connection, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      campaignId: input.campaignId,
      preferredIssueId: input.preferredIssueId,
      agentId,
      leaseTtlSeconds: input.leaseTtlSeconds ?? this.defaultLeaseTtlSeconds,
      now,
    });

    return buildClaimedBeginResult({
      connection,
      input,
      now,
      runId,
      agentId,
      host,
      leaseResult,
    });
  }

  private beginRecoveryCanonical(
    connection: ReturnType<typeof openHarnessDatabase>['connection'],
    input: RecoverySessionInput,
  ): BeginClaimCanonicalResult {
    const now = new Date().toISOString();
    const agentId = input.agentId ?? input.sessionId;
    const host = input.host ?? hostname();
    const runId = input.sessionId;

    createRunRecord(connection, {
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
        ? loadRecoveryIssue(connection, input.preferredIssueId)
        : selectNextRecoveryIssue(
            connection,
            input.projectId,
            input.campaignId,
          );
    const recoverableLeases = findRecoverableLeasesForIssue(
      connection,
      recoveryIssue.id,
    );

    for (const lease of recoverableLeases) {
      markLeaseRecovered(connection, lease.id, now);
    }

    const recoveryLease = claimSpecificIssueLease(connection, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      campaignId: input.campaignId,
      issueId: recoveryIssue.id,
      agentId,
      leaseTtlSeconds: input.leaseTtlSeconds ?? this.defaultLeaseTtlSeconds,
      now,
    });

    updateRunStatus(connection, runId, 'in_progress', undefined);
    updateIssueStatus(connection, recoveryIssue.id, 'in_progress');

    const recoveryCheckpoint = writeCheckpoint(connection, {
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

    appendRunEvent(connection, {
      runId,
      issueId: recoveryIssue.id,
      kind: 'recovery_resolved',
      payload: {
        recoveredLeaseIds: recoverableLeases.map((lease) => lease.id),
        replacementLeaseId: recoveryLease.id,
      },
      createdAt: now,
    });

    const contextBase = buildContextBase({
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
      currentTaskStatus: 'in_progress',
      currentCheckpointId: recoveryCheckpoint.id,
    });
    const memoryQuery = input.memoryQuery ?? recoveryIssue.task;

    return {
      kind: 'claimed',
      runId,
      issueId: recoveryIssue.id,
      recallScope: buildRecallScope({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        campaignId: input.campaignId,
        issueId: recoveryIssue.id,
      }),
      memoryQuery,
      contextBase,
    };
  }

  private writeCanonicalCheckpoint(
    connection: ReturnType<typeof openHarnessDatabase>['connection'],
    context: SessionContext,
    input: SessionCheckpointInput,
    createdAt: string,
  ): CanonicalCheckpointState {
    updateIssueStatus(connection, context.issueId, input.taskStatus);
    updateRunStatus(connection, context.runId, input.taskStatus, undefined);

    const checkpoint = writeCheckpoint(connection, {
      runId: context.runId,
      issueId: context.issueId,
      title: input.title,
      summary: input.summary,
      taskStatus: input.taskStatus,
      nextStep: input.nextStep,
      artifactIds: input.artifactIds ?? [],
      createdAt,
    });

    return {
      context: {
        ...context,
        currentTaskStatus: input.taskStatus,
        currentCheckpointId: checkpoint.id,
      },
      checkpoint,
      promotedIssueIds: [],
    };
  }

  private closeCanonical(
    connection: ReturnType<typeof openHarnessDatabase>['connection'],
    context: SessionContext,
    input: SessionCloseInput,
    finishedAt: string,
  ): CanonicalCheckpointState {
    const checkpointState = this.writeCanonicalCheckpoint(
      connection,
      context,
      input,
      finishedAt,
    );

    updateRunStatus(connection, context.runId, input.taskStatus, finishedAt);

    if (input.releaseLease !== false) {
      releaseLease(connection, context.leaseId, finishedAt);
    }

    const promotedIssueIds =
      input.taskStatus === 'done'
        ? promoteEligiblePendingIssues(connection, {
            projectId: context.projectId,
            campaignId: context.campaignId,
          }).map((issue) => issue.id)
        : [];

    if (promotedIssueIds.length > 0) {
      appendRunEvent(connection, {
        runId: context.runId,
        issueId: context.issueId,
        kind: 'queue_promoted',
        payload: {
          promotedIssueIds,
        },
        createdAt: finishedAt,
      });
    }

    appendRunEvent(connection, {
      runId: context.runId,
      issueId: context.issueId,
      kind: 'session_closed',
      payload: {
        checkpointId: checkpointState.checkpoint.id,
        releasedLease: input.releaseLease !== false,
        finalStatus: input.taskStatus,
      },
      createdAt: finishedAt,
    });

    return {
      ...checkpointState,
      promotedIssueIds,
    };
  }

  private async finalizeCheckpointSideEffects(
    connection: ReturnType<typeof openHarnessDatabase>['connection'],
    canonical: CanonicalCheckpointState,
    input: SessionCheckpointInput,
  ): Promise<SessionCheckpointResult> {
    const shouldPersistMemory =
      input.persistToMem0 ?? isTerminalTaskStatus(input.taskStatus);
    const baseResult: SessionCheckpointResult = {
      context: canonical.context,
      checkpoint: canonical.checkpoint,
      ...(canonical.promotedIssueIds.length > 0
        ? { promotedIssueIds: canonical.promotedIssueIds }
        : {}),
    };

    if (!shouldPersistMemory) {
      return baseResult;
    }

    const memoryResult = await this.mem0Bridge.storeCheckpointMemory({
      context: canonical.context.mem0,
      scope: canonical.context.scope,
      checkpointId: canonical.checkpoint.id,
      kind: input.memoryKind ?? defaultMemoryKindForStatus(input.taskStatus),
      content: input.memoryContent ?? input.summary,
      artifactIds: input.artifactIds ?? [],
      metadata: input.metadata ?? {},
      note: input.nextStep,
    });

    const recordedAt = new Date().toISOString();

    if (memoryResult.memory === null) {
      runInTransaction(connection, () => {
        appendRunEvent(connection, {
          runId: canonical.context.runId,
          issueId: canonical.context.issueId,
          kind: 'mem0_write_skipped',
          payload: {
            checkpointId: canonical.checkpoint.id,
            reason: memoryResult.skippedReason,
          },
          createdAt: recordedAt,
        });
      });

      return {
        ...baseResult,
        mem0WriteSkippedReason: memoryResult.skippedReason,
      };
    }

    const memory = memoryResult.memory;

    runInTransaction(connection, () => {
      linkMemoryRecord(connection, {
        workspaceId: canonical.context.workspaceId,
        projectId: canonical.context.projectId,
        campaignId: canonical.context.campaignId,
        issueId: canonical.context.issueId,
        memoryKind: memory.kind as string,
        memoryRef: memory.id as string,
        summary: input.summary,
        createdAt: recordedAt,
      });

      appendRunEvent(connection, {
        runId: canonical.context.runId,
        issueId: canonical.context.issueId,
        kind: 'mem0_memory_linked',
        payload: {
          checkpointId: canonical.checkpoint.id,
          memoryId: memory.id,
          memoryKind: memory.kind,
        },
        createdAt: recordedAt,
      });
    });

    return {
      ...baseResult,
      memoryId: memory.id as string,
    };
  }

  private async loadMem0Context(input: {
    enabled: boolean;
    scope: MemoryScope;
    query: string;
    limit: number;
  }): Promise<SessionMemoryContext> {
    return this.mem0Bridge.loadContext(input);
  }

  private recordMem0ContextEvent(
    connection: ReturnType<typeof openHarnessDatabase>['connection'],
    runId: string,
    issueId: string,
    query: string,
    mem0Context: SessionMemoryContext,
    payloadExtras?: Record<string, unknown>,
  ): void {
    runInTransaction(connection, () => {
      appendRunEvent(connection, {
        runId,
        issueId,
        kind: mem0Context.available
          ? 'mem0_context_loaded'
          : 'mem0_context_unavailable',
        payload: {
          query,
          recalledMemoryCount: mem0Context.recalledMemories.length,
          details: mem0Context.details,
          ...payloadExtras,
        },
        createdAt: new Date().toISOString(),
      });
    });
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

interface BuildClaimedBeginInput {
  connection: ReturnType<typeof openHarnessDatabase>['connection'];
  input: IncrementalSessionInput;
  now: string;
  runId: string;
  agentId: string;
  host: string;
  leaseResult: ClaimedLeaseResult;
}

function buildClaimedBeginResult(
  input: BuildClaimedBeginInput,
): BeginClaimCanonicalResult {
  updateRunStatus(input.connection, input.runId, 'in_progress', undefined);
  updateIssueStatus(input.connection, input.leaseResult.issue.id, 'in_progress');

  const claimCheckpoint = writeCheckpoint(input.connection, {
    runId: input.runId,
    issueId: input.leaseResult.issue.id,
    title: input.leaseResult.resumed ? 'resume' : 'claim',
    summary: input.leaseResult.resumed
      ? `Resumed issue ${input.leaseResult.issue.id} under active lease ${input.leaseResult.lease.id}.`
      : `Claimed issue ${input.leaseResult.issue.id} under lease ${input.leaseResult.lease.id}.`,
    taskStatus: 'in_progress',
    nextStep:
      input.leaseResult.issue.nextBestAction ??
      `Continue work on issue ${input.leaseResult.issue.id}.`,
    artifactIds: [],
    createdAt: input.now,
  });

  return {
    kind: 'claimed',
    runId: input.runId,
    issueId: input.leaseResult.issue.id,
    recallScope: buildRecallScope({
      workspaceId: input.input.workspaceId,
      projectId: input.input.projectId,
      campaignId: input.input.campaignId,
      issueId: input.leaseResult.issue.id,
    }),
    memoryQuery: input.input.memoryQuery ?? input.leaseResult.issue.task,
    contextBase: buildContextBase({
      sessionId: input.input.sessionId,
      dbPath: input.input.dbPath,
      workspaceId: input.input.workspaceId,
      projectId: input.input.projectId,
      campaignId: input.input.campaignId,
      agentId: input.agentId,
      host: input.host,
      runId: input.runId,
      leaseId: input.leaseResult.lease.id,
      leaseExpiresAt: input.leaseResult.lease.expiresAt,
      issueId: input.leaseResult.issue.id,
      issueTask: input.leaseResult.issue.task,
      claimMode: input.leaseResult.resumed ? 'resume' : 'claim',
      currentTaskStatus: 'in_progress',
      currentCheckpointId: claimCheckpoint.id,
    }),
  };
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
  status: string,
  finishedAt?: string,
): void {
  runStatement(
    connection,
    `UPDATE runs
     SET status = ?, finished_at = COALESCE(?, finished_at)
     WHERE id = ?`,
    [status, finishedAt ?? null, runId],
  );
}

function buildContextBase(input: {
  sessionId: string;
  dbPath: string;
  workspaceId: string;
  projectId: string;
  campaignId?: string;
  agentId: string;
  host: string;
  runId: string;
  leaseId: string;
  leaseExpiresAt: string;
  issueId: string;
  issueTask: string;
  claimMode: 'claim' | 'resume' | 'recovery';
  currentTaskStatus: TaskStatus;
  currentCheckpointId: string;
}): Omit<SessionContext, 'mem0'> {
  return {
    sessionId: input.sessionId,
    dbPath: input.dbPath,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    campaignId: input.campaignId,
    agentId: input.agentId,
    host: input.host,
    runId: input.runId,
    leaseId: input.leaseId,
    leaseExpiresAt: input.leaseExpiresAt,
    issueId: input.issueId,
    issueTask: input.issueTask,
    claimMode: input.claimMode,
    scope: buildMemoryScope({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      campaignId: input.campaignId,
      issueId: input.issueId,
      runId: input.runId,
    }),
    currentTaskStatus: input.currentTaskStatus,
    currentCheckpointId: input.currentCheckpointId,
  };
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

function normalizeCloseInput(input: SessionCloseInput): SessionCloseInput {
  return {
    ...input,
    persistToMem0: input.persistToMem0 ?? true,
    memoryKind: input.memoryKind ?? 'summary',
    memoryContent: input.memoryContent ?? input.summary,
  };
}

function isExpectedAdvanceStop(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.startsWith('No ready issues are available for project ');
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
