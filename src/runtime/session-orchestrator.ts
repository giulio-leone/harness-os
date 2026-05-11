import { randomUUID } from 'node:crypto';
import type {
  IncrementalSessionInput,
  QueuePromotionInput,
  QueuePromotionResult,
  RecoverySessionInput,
  SessionArtifactReference,
  SessionCheckpointInput,
  SessionCloseInput,
  SessionContext,
  SessionMemoryContext,
} from '../contracts/session-contracts.js';
import { isTerminalTaskStatus } from '../contracts/session-contracts.js';
import {
  csqrLiteScorecardSchema,
  type CsqrLiteScorecard,
} from '../contracts/csqr-lite-contracts.js';
import {
  evaluateCsqrLiteCompletionGate,
  type CsqrLiteCompletionGateResult,
  type CsqrLiteCompletionGateScorecardInput,
} from '../contracts/csqr-lite-completion-gate.js';
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
  selectAll,
  selectOne,
} from '../db/store.js';
import { assertValidTransition } from '../db/state-machine.js';
import { assertNoOrchestrationConflicts } from './orchestration-conflicts.js';
import { Mem0SessionBridge } from './mem0-session-bridge.js';

export interface SessionCheckpointResult {
  context: SessionContext;
  checkpoint: CheckpointRecord;
  memoryId?: string;
  mem0WriteSkippedReason?: string;
  promotedIssueIds?: string[];
  csqrLiteScorecardArtifactIds?: string[];
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
  csqrLiteScorecardArtifacts: PersistedCsqrLiteScorecardArtifact[];
}

interface PersistedCsqrLiteScorecardArtifact {
  id: string;
  kind: 'csqr_lite_scorecard';
  path: string;
  scorecardId: string;
  scope: CsqrLiteScorecard['scope'];
  runId?: string;
  assignmentId?: string;
  weightedAverage: number;
  targetScore: number;
}

const CSQR_LITE_SCORECARD_ARTIFACT_KIND = 'csqr_lite_scorecard' as const;
const CSQR_LITE_SCORECARD_METADATA_SOURCE = 'csqr_lite_scorecard' as const;
const MAX_CSQR_LITE_SCORECARD_JSON_BYTES = 64 * 1024;

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
    const host = input.host;
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
          artifacts: input.artifacts,
          mem0Enabled: input.mem0Enabled,
          agentId,
          hostCapabilities: input.hostCapabilities,
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

    if (input.orchestrationConflictGuard !== undefined) {
      assertNoOrchestrationConflicts(connection, {
        projectId: input.projectId,
        campaignId: input.campaignId,
        excludeRunId: runId,
        guard: {
          worktreePath: input.orchestrationConflictGuard.worktreePath,
          worktreeBranch: input.orchestrationConflictGuard.worktreeBranch,
          candidateFilePaths:
            input.orchestrationConflictGuard.candidateFilePaths ?? [],
        },
      });
    }

    const leaseResult = claimOrResumeLease(connection, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      campaignId: input.campaignId,
      preferredIssueId: input.preferredIssueId,
      agentId,
      host,
      hostCapabilities: input.hostCapabilities,
      leaseTtlSeconds: input.leaseTtlSeconds ?? this.defaultLeaseTtlSeconds,
      agentMaxConcurrentLeases: input.agentMaxConcurrentLeases,
      now,
    });

    return buildClaimedBeginResult({
      connection,
      input,
      now,
      runId,
      agentId,
      host,
      hostCapabilities: input.hostCapabilities,
      leaseResult,
    });
  }

  private beginRecoveryCanonical(
    connection: ReturnType<typeof openHarnessDatabase>['connection'],
    input: RecoverySessionInput,
  ): BeginClaimCanonicalResult {
    const now = new Date().toISOString();
    const agentId = input.agentId ?? input.sessionId;
    const host = input.host;
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
          artifacts: input.artifacts,
          mem0Enabled: input.mem0Enabled,
          agentId,
          hostCapabilities: input.hostCapabilities,
          recoverySummary: input.recoverySummary,
        }),
      });

    const recoveryIssue =
      input.preferredIssueId !== undefined
        ? loadRecoveryIssue(
            connection,
            input.preferredIssueId,
            host,
            input.hostCapabilities,
            input.projectId,
            input.campaignId,
          )
        : selectNextRecoveryIssue(
            connection,
            input.projectId,
            host,
            input.hostCapabilities,
            input.campaignId,
          );
    const recoverableLeases = findRecoverableLeasesForIssue(
      connection,
      recoveryIssue.id,
    );

    if (input.orchestrationConflictGuard !== undefined) {
      assertNoOrchestrationConflicts(connection, {
        projectId: input.projectId,
        campaignId: input.campaignId,
        excludeRunId: runId,
        guard: {
          worktreePath: input.orchestrationConflictGuard.worktreePath,
          worktreeBranch: input.orchestrationConflictGuard.worktreeBranch,
          candidateFilePaths:
            input.orchestrationConflictGuard.candidateFilePaths ?? [],
        },
      });
    }

    for (const lease of recoverableLeases) {
      markLeaseRecovered(connection, lease.id, now);
    }

    const recoveryLease = claimSpecificIssueLease(connection, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      campaignId: input.campaignId,
      issueId: recoveryIssue.id,
      agentId,
      host,
      hostCapabilities: input.hostCapabilities,
      leaseTtlSeconds: input.leaseTtlSeconds ?? this.defaultLeaseTtlSeconds,
      now,
    });

    updateRunStatus(connection, runId, 'in_progress', undefined);
    updateIssueStatus(connection, recoveryIssue.id, 'in_progress', null);
    const registeredArtifacts = persistSessionArtifacts(connection, {
      runId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      campaignId: input.campaignId,
      issueId: recoveryIssue.id,
      leaseId: recoveryLease.id,
      agentId,
      host,
      claimMode: 'recovery',
      artifacts: input.artifacts,
      createdAt: now,
    });
    const artifactIds = registeredArtifacts.map((artifact) => artifact.id!);

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
      artifactIds,
      createdAt: now,
    });
    appendSessionArtifactsRegisteredEvent(connection, {
      runId,
      issueId: recoveryIssue.id,
      checkpointId: recoveryCheckpoint.id,
      claimMode: 'recovery',
      artifacts: registeredArtifacts,
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
      hostCapabilities: input.hostCapabilities,
      runId,
      leaseId: recoveryLease.id,
      leaseExpiresAt: recoveryLease.expiresAt,
      issueId: recoveryIssue.id,
      issueTask: recoveryIssue.task,
      claimMode: 'recovery',
      artifacts: registeredArtifacts,
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
    assertBlockedReasonCompatibility(input);
    const csqrLiteCompletionGate =
      input.taskStatus === 'done'
        ? assertSessionCsqrLiteCompletionGate(connection, context, input)
        : undefined;
    updateIssueStatus(
      connection,
      context.issueId,
      input.taskStatus,
      input.taskStatus === 'blocked' ? input.blockedReason : null,
    );
    updateRunStatus(connection, context.runId, input.taskStatus, undefined);

    const csqrLiteScorecardArtifacts = persistCsqrLiteScorecardArtifacts(
      connection,
      context,
      input.csqrLiteScorecards ?? [],
      createdAt,
    );
    const artifactIds = [
      ...(input.artifactIds ?? []),
      ...csqrLiteScorecardArtifacts.map((artifact) => artifact.id),
    ];

    const checkpoint = writeCheckpoint(connection, {
      runId: context.runId,
      issueId: context.issueId,
      title: input.title,
      summary: input.summary,
      taskStatus: input.taskStatus,
      nextStep: input.nextStep,
      artifactIds,
      createdAt,
    });

    if (csqrLiteScorecardArtifacts.length > 0) {
      appendCsqrLiteScorecardsRegisteredEvent(connection, {
        runId: context.runId,
        issueId: context.issueId,
        checkpointId: checkpoint.id,
        artifacts: csqrLiteScorecardArtifacts,
        createdAt,
      });
    }
    if (csqrLiteCompletionGate !== undefined) {
      const persistedCompletionGate = assertPersistedSessionCsqrLiteCompletionGate(
        connection,
        context,
      );
      appendCsqrLiteCompletionGateEvaluatedEvent(connection, {
        runId: context.runId,
        issueId: context.issueId,
        checkpointId: checkpoint.id,
        result: persistedCompletionGate,
        createdAt,
      });
    }

    return {
      context: {
        ...context,
        currentTaskStatus: input.taskStatus,
        currentCheckpointId: checkpoint.id,
      },
      checkpoint,
      promotedIssueIds: [],
      csqrLiteScorecardArtifacts,
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
    const releasedArtifactIds = releaseSessionArtifacts(connection, {
      runId: context.runId,
      issueId: context.issueId,
      finalTaskStatus: input.taskStatus,
      releasedAt: finishedAt,
    });

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
    if (releasedArtifactIds.length > 0) {
      appendRunEvent(connection, {
        runId: context.runId,
        issueId: context.issueId,
        kind: 'session_artifacts_released',
        payload: {
          source: 'session_orchestrator',
          checkpointId: checkpointState.checkpoint.id,
          artifactIds: releasedArtifactIds,
          finalStatus: input.taskStatus,
        },
        createdAt: finishedAt,
      });
    }

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
      ...(canonical.csqrLiteScorecardArtifacts.length > 0
        ? {
            csqrLiteScorecardArtifactIds:
              canonical.csqrLiteScorecardArtifacts.map((artifact) => artifact.id),
          }
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
      artifactIds: canonical.checkpoint.artifactIds,
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
  hostCapabilities: SessionContext['hostCapabilities'];
  leaseResult: ClaimedLeaseResult;
}

interface ArtifactMetadataRow {
  id: string;
  metadata_json: string;
}

function buildClaimedBeginResult(
  input: BuildClaimedBeginInput,
): BeginClaimCanonicalResult {
  const claimMode = input.leaseResult.resumed ? 'resume' : 'claim';
  updateRunStatus(input.connection, input.runId, 'in_progress', undefined);
  updateIssueStatus(
    input.connection,
    input.leaseResult.issue.id,
    'in_progress',
    null,
  );
  const registeredArtifacts = persistSessionArtifacts(input.connection, {
    runId: input.runId,
    workspaceId: input.input.workspaceId,
    projectId: input.input.projectId,
    campaignId: input.input.campaignId,
    issueId: input.leaseResult.issue.id,
    leaseId: input.leaseResult.lease.id,
    agentId: input.agentId,
    host: input.host,
    claimMode,
    artifacts: input.input.artifacts,
    createdAt: input.now,
  });
  const artifactIds = registeredArtifacts.map((artifact) => artifact.id!);

  const claimCheckpoint = writeCheckpoint(input.connection, {
    runId: input.runId,
    issueId: input.leaseResult.issue.id,
    title: claimMode,
    summary: claimMode === 'resume'
      ? `Resumed issue ${input.leaseResult.issue.id} under active lease ${input.leaseResult.lease.id}.`
      : `Claimed issue ${input.leaseResult.issue.id} under lease ${input.leaseResult.lease.id}.`,
    taskStatus: 'in_progress',
    nextStep:
      input.leaseResult.issue.nextBestAction ??
      `Continue work on issue ${input.leaseResult.issue.id}.`,
    artifactIds,
    createdAt: input.now,
  });
  appendSessionArtifactsRegisteredEvent(input.connection, {
    runId: input.runId,
    issueId: input.leaseResult.issue.id,
    checkpointId: claimCheckpoint.id,
    claimMode,
    artifacts: registeredArtifacts,
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
      hostCapabilities: input.hostCapabilities,
      runId: input.runId,
      leaseId: input.leaseResult.lease.id,
      leaseExpiresAt: input.leaseResult.lease.expiresAt,
      issueId: input.leaseResult.issue.id,
      issueTask: input.leaseResult.issue.task,
      claimMode,
      artifacts: registeredArtifacts,
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

function persistSessionArtifacts(
  connection: ReturnType<typeof openHarnessDatabase>['connection'],
  input: {
    runId: string;
    workspaceId: string;
    projectId: string;
    campaignId?: string;
    issueId: string;
    leaseId: string;
    agentId: string;
    host: string;
    claimMode: 'claim' | 'resume' | 'recovery';
    artifacts: readonly SessionArtifactReference[];
    createdAt: string;
  },
): SessionArtifactReference[] {
  const seen = new Set<string>();

  return input.artifacts.map((artifact, index) => {
    const kind = normalizeNonEmptyArtifactField('kind', artifact.kind);
    const path = normalizeNonEmptyArtifactField('path', artifact.path);
    const logicalKey = `${kind}\u0000${path}`;

    if (seen.has(logicalKey)) {
      throw new Error(`duplicate session artifact "${kind}" at "${path}".`);
    }
    seen.add(logicalKey);

    supersedePriorSessionArtifacts(connection, {
      projectId: input.projectId,
      issueId: input.issueId,
      kind,
      path,
      supersededAt: input.createdAt,
      supersededByRunId: input.runId,
    });

    const id = buildSessionArtifactId(input.runId, index);
    const metadata = buildSessionArtifactMetadata({
      runId: input.runId,
      leaseId: input.leaseId,
      agentId: input.agentId,
      host: input.host,
      claimMode: input.claimMode,
      status: 'active',
    });

    runStatement(
      connection,
      `INSERT INTO artifacts (
         id, workspace_id, project_id, campaign_id, issue_id, kind, path,
         metadata_json, created_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.workspaceId,
        input.projectId,
        input.campaignId ?? null,
        input.issueId,
        kind,
        path,
        JSON.stringify(metadata),
        input.createdAt,
      ],
    );

    return {
      id,
      kind,
      path,
    };
  });
}

function persistCsqrLiteScorecardArtifacts(
  connection: ReturnType<typeof openHarnessDatabase>['connection'],
  context: SessionContext,
  scorecardArtifacts: NonNullable<SessionCheckpointInput['csqrLiteScorecards']>,
  createdAt: string,
): PersistedCsqrLiteScorecardArtifact[] {
  const persistedArtifacts: PersistedCsqrLiteScorecardArtifact[] = [];
  const seenScorecardIds = new Set<string>();
  const seenPaths = new Set<string>();

  for (const [index, input] of scorecardArtifacts.entries()) {
    const scorecard = csqrLiteScorecardSchema.parse(input.scorecard);
    const path = normalizeNonEmptyArtifactField(
      `csqrLiteScorecards[${index}].path`,
      input.path,
    );

    if (seenScorecardIds.has(scorecard.id)) {
      throw new Error(
        `Duplicate CSQR-lite scorecard id "${scorecard.id}" in checkpoint input.`,
      );
    }
    if (seenPaths.has(path)) {
      throw new Error(
        `Duplicate CSQR-lite scorecard path "${path}" in checkpoint input.`,
      );
    }
    seenScorecardIds.add(scorecard.id);
    seenPaths.add(path);

    if (scorecard.scope === 'run' && scorecard.runId !== context.runId) {
      throw new Error(
        `csqrLiteScorecards[${index}].scorecard.runId must match the active session runId "${context.runId}".`,
      );
    }

    const scorecardJson = serializeCsqrLiteScorecard(scorecard, index);
    const artifactId = buildCsqrLiteScorecardArtifactId(scorecard.id, index);
    const persistedArtifact: PersistedCsqrLiteScorecardArtifact = {
      id: artifactId,
      kind: CSQR_LITE_SCORECARD_ARTIFACT_KIND,
      path,
      scorecardId: scorecard.id,
      scope: scorecard.scope,
      ...(scorecard.runId !== undefined ? { runId: scorecard.runId } : {}),
      ...(scorecard.assignmentId !== undefined
        ? { assignmentId: scorecard.assignmentId }
        : {}),
      weightedAverage: scorecard.weightedAverage,
      targetScore: scorecard.targetScore,
    };

    runStatement(
      connection,
      `INSERT INTO artifacts (
         id, workspace_id, project_id, campaign_id, issue_id, kind, path,
         metadata_json, created_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        artifactId,
        context.workspaceId,
        context.projectId,
        context.campaignId ?? null,
        context.issueId,
        CSQR_LITE_SCORECARD_ARTIFACT_KIND,
        path,
        JSON.stringify(
          buildCsqrLiteScorecardArtifactMetadata({
            context,
            scorecard,
            scorecardJson,
          }),
        ),
        createdAt,
      ],
    );

    persistedArtifacts.push(persistedArtifact);
  }

  return persistedArtifacts;
}

function assertSessionCsqrLiteCompletionGate(
  connection: ReturnType<typeof openHarnessDatabase>['connection'],
  context: SessionContext,
  input: SessionCheckpointInput,
): CsqrLiteCompletionGateResult {
  const result = evaluateCsqrLiteCompletionGate({
    requiredScope: 'run',
    scorecards: [
      ...loadPersistedCsqrLiteScorecardInputs(connection, context),
      ...(input.csqrLiteScorecards ?? []).map((artifact) => ({
        scorecard: artifact.scorecard,
        path: artifact.path,
        source: 'checkpoint_input',
      })),
    ],
  });

  if (result.status !== 'passed') {
    throw new Error(result.message);
  }

  return result;
}

function assertPersistedSessionCsqrLiteCompletionGate(
  connection: ReturnType<typeof openHarnessDatabase>['connection'],
  context: SessionContext,
): CsqrLiteCompletionGateResult {
  const result = evaluateCsqrLiteCompletionGate({
    requiredScope: 'run',
    scorecards: loadPersistedCsqrLiteScorecardInputs(connection, context),
  });

  if (result.status !== 'passed') {
    throw new Error(result.message);
  }

  return result;
}

function loadPersistedCsqrLiteScorecardInputs(
  connection: ReturnType<typeof openHarnessDatabase>['connection'],
  context: SessionContext,
): CsqrLiteCompletionGateScorecardInput[] {
  const rows = selectAll<{
    id: string;
    path: string;
    metadata_json: string;
  }>(
    connection,
    `SELECT id, path, metadata_json
     FROM artifacts
     WHERE issue_id = ?
       AND kind = ?
     ORDER BY created_at ASC, id ASC`,
    [context.issueId, CSQR_LITE_SCORECARD_ARTIFACT_KIND],
  );

  return rows
    .map((row): CsqrLiteCompletionGateScorecardInput | null => {
      const metadata = parseMetadata(row.metadata_json);

      if (metadata['sessionRunId'] !== context.runId) {
        return null;
      }

      const scorecardJson = metadata['scorecardJson'];
      if (scorecardJson === undefined) {
        throw new Error(
          `CSQR-lite scorecard artifact "${row.id}" is missing metadata.scorecardJson.`,
        );
      }

      return {
        artifactId: row.id,
        path: row.path,
        scorecard: JSON.parse(scorecardJson) as unknown,
        source: 'artifact',
      };
    })
    .filter((scorecard): scorecard is CsqrLiteCompletionGateScorecardInput => scorecard !== null);
}

function appendCsqrLiteScorecardsRegisteredEvent(
  connection: ReturnType<typeof openHarnessDatabase>['connection'],
  input: {
    runId: string;
    issueId: string;
    checkpointId: string;
    artifacts: readonly PersistedCsqrLiteScorecardArtifact[];
    createdAt: string;
  },
): void {
  appendRunEvent(connection, {
    runId: input.runId,
    issueId: input.issueId,
    kind: 'csqr_lite_scorecards_registered',
    payload: {
      source: CSQR_LITE_SCORECARD_METADATA_SOURCE,
      checkpointId: input.checkpointId,
      artifactIds: input.artifacts.map((artifact) => artifact.id),
      scorecards: input.artifacts.map((artifact) => ({
        artifactId: artifact.id,
        path: artifact.path,
        scorecardId: artifact.scorecardId,
        scope: artifact.scope,
        ...(artifact.runId !== undefined ? { runId: artifact.runId } : {}),
        ...(artifact.assignmentId !== undefined
          ? { assignmentId: artifact.assignmentId }
          : {}),
        weightedAverage: artifact.weightedAverage,
        targetScore: artifact.targetScore,
      })),
    },
    createdAt: input.createdAt,
  });
}

function appendCsqrLiteCompletionGateEvaluatedEvent(
  connection: ReturnType<typeof openHarnessDatabase>['connection'],
  input: {
    runId: string;
    issueId: string;
    checkpointId: string;
    result: CsqrLiteCompletionGateResult;
    createdAt: string;
  },
): void {
  appendRunEvent(connection, {
    runId: input.runId,
    issueId: input.issueId,
    kind: 'csqr_lite_completion_gate_evaluated',
    payload: {
      source: 'csqr_lite_completion_gate',
      outcome: input.result.status,
      checkpointId: input.checkpointId,
      requiredScope: input.result.requiredScope,
      minimumTargetScore: input.result.minimumTargetScore,
      message: input.result.message,
      artifactIds: input.result.evaluatedScorecards
        .map((scorecard) => scorecard.artifactId)
        .filter((artifactId): artifactId is string => artifactId !== undefined),
      scorecards: input.result.evaluatedScorecards.map((scorecard) => ({
        id: scorecard.id,
        scope: scorecard.scope,
        weightedAverage: scorecard.weightedAverage,
        targetScore: scorecard.targetScore,
        threshold: scorecard.threshold,
        status: scorecard.status,
        ...(scorecard.artifactId !== undefined
          ? { artifactId: scorecard.artifactId }
          : {}),
        ...(scorecard.path !== undefined ? { path: scorecard.path } : {}),
      })),
    },
    createdAt: input.createdAt,
  });
}

function buildCsqrLiteScorecardArtifactMetadata(input: {
  context: SessionContext;
  scorecard: CsqrLiteScorecard;
  scorecardJson: string;
}): Record<string, string> {
  return {
    source: CSQR_LITE_SCORECARD_METADATA_SOURCE,
    scorecardId: input.scorecard.id,
    csqrLiteScorecardId: input.scorecard.id,
    contractVersion: input.scorecard.contractVersion,
    scope: input.scorecard.scope,
    scorecardScope: input.scorecard.scope,
    sessionRunId: input.context.runId,
    issueId: input.context.issueId,
    weightedAverage: String(input.scorecard.weightedAverage),
    targetScore: String(input.scorecard.targetScore),
    criteriaCount: String(input.scorecard.criteria.length),
    scoreCount: String(input.scorecard.scores.length),
    ...(input.scorecard.runId !== undefined
      ? {
          runId: input.scorecard.runId,
          scorecardRunId: input.scorecard.runId,
        }
      : {}),
    ...(input.scorecard.assignmentId !== undefined
      ? { assignmentId: input.scorecard.assignmentId }
      : {}),
    scorecardJson: input.scorecardJson,
  };
}

function serializeCsqrLiteScorecard(
  scorecard: CsqrLiteScorecard,
  index: number,
): string {
  const scorecardJson = JSON.stringify(scorecard);
  const byteLength = Buffer.byteLength(scorecardJson, 'utf8');

  if (byteLength > MAX_CSQR_LITE_SCORECARD_JSON_BYTES) {
    throw new Error(
      `csqrLiteScorecards[${index}].scorecard is ${byteLength} bytes; maximum supported metadata payload is ${MAX_CSQR_LITE_SCORECARD_JSON_BYTES} bytes.`,
    );
  }

  return scorecardJson;
}

function buildCsqrLiteScorecardArtifactId(
  scorecardId: string,
  index: number,
): string {
  return normalizeNonEmptyArtifactField(
    'id',
    `csqr-lite-scorecard-${sanitizeArtifactIdSegment(scorecardId)}-${String(index + 1).padStart(3, '0')}-${randomUUID()}`,
  );
}

function supersedePriorSessionArtifacts(
  connection: ReturnType<typeof openHarnessDatabase>['connection'],
  input: {
    projectId: string;
    issueId: string;
    kind: string;
    path: string;
    supersededAt: string;
    supersededByRunId: string;
  },
): void {
  const rows = selectSessionArtifactRows(connection, {
    projectId: input.projectId,
    issueId: input.issueId,
    kind: input.kind,
    path: input.path,
  });

  for (const row of rows) {
    const metadata = parseMetadata(row.metadata_json);

    if (!isActiveSessionArtifactMetadata(metadata)) {
      continue;
    }

    updateArtifactMetadata(connection, row.id, {
      ...metadata,
      status: 'released',
      supersededAt: input.supersededAt,
      supersededByRunId: input.supersededByRunId,
    });
  }
}

function releaseSessionArtifacts(
  connection: ReturnType<typeof openHarnessDatabase>['connection'],
  input: {
    runId: string;
    issueId: string;
    finalTaskStatus: TaskStatus;
    releasedAt: string;
  },
): string[] {
  const rows = selectAll<ArtifactMetadataRow>(
    connection,
    `SELECT id, metadata_json
     FROM artifacts
     WHERE issue_id = ?
     ORDER BY created_at ASC, id ASC`,
    [input.issueId],
  );
  const releasedArtifactIds: string[] = [];

  for (const row of rows) {
    const metadata = parseMetadata(row.metadata_json);

    if (
      metadata['source'] !== 'session_orchestrator' ||
      metadata['runId'] !== input.runId ||
      !isActiveSessionArtifactMetadata(metadata)
    ) {
      continue;
    }

    updateArtifactMetadata(connection, row.id, {
      ...metadata,
      status: 'released',
      finalTaskStatus: input.finalTaskStatus,
      releasedAt: input.releasedAt,
    });
    releasedArtifactIds.push(row.id);
  }

  return releasedArtifactIds;
}

function selectSessionArtifactRows(
  connection: ReturnType<typeof openHarnessDatabase>['connection'],
  input: {
    projectId: string;
    issueId: string;
    kind: string;
    path: string;
  },
): ArtifactMetadataRow[] {
  return selectAll<ArtifactMetadataRow>(
    connection,
    `SELECT id, metadata_json
     FROM artifacts
     WHERE project_id = ?
       AND issue_id = ?
       AND kind = ?
       AND path = ?
     ORDER BY created_at ASC, id ASC`,
    [input.projectId, input.issueId, input.kind, input.path],
  );
}

function updateArtifactMetadata(
  connection: ReturnType<typeof openHarnessDatabase>['connection'],
  artifactId: string,
  metadata: Record<string, string>,
): void {
  runStatement(
    connection,
    `UPDATE artifacts
     SET metadata_json = ?
     WHERE id = ?`,
    [JSON.stringify(metadata), artifactId],
  );
}

function appendSessionArtifactsRegisteredEvent(
  connection: ReturnType<typeof openHarnessDatabase>['connection'],
  input: {
    runId: string;
    issueId: string;
    checkpointId: string;
    claimMode: 'claim' | 'resume' | 'recovery';
    artifacts: readonly SessionArtifactReference[];
    createdAt: string;
  },
): void {
  appendRunEvent(connection, {
    runId: input.runId,
    issueId: input.issueId,
    kind: 'session_artifacts_registered',
    payload: {
      source: 'session_orchestrator',
      checkpointId: input.checkpointId,
      claimMode: input.claimMode,
      artifactIds: input.artifacts.map((artifact) => artifact.id),
      artifacts: input.artifacts.map((artifact) => ({
        id: artifact.id,
        kind: artifact.kind,
        path: artifact.path,
      })),
    },
    createdAt: input.createdAt,
  });
}

function buildSessionArtifactMetadata(input: {
  runId: string;
  leaseId: string;
  agentId: string;
  host: string;
  claimMode: string;
  status: string;
}): Record<string, string> {
  return {
    source: 'session_orchestrator',
    runId: input.runId,
    leaseId: input.leaseId,
    agentId: input.agentId,
    host: input.host,
    claimMode: input.claimMode,
    status: input.status,
  };
}

function buildSessionArtifactId(runId: string, index: number): string {
  return normalizeNonEmptyArtifactField(
    'id',
    `session-artifact-${sanitizeArtifactIdSegment(runId)}-${String(index + 1).padStart(3, '0')}-${randomUUID()}`,
  );
}

function sanitizeArtifactIdSegment(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeNonEmptyArtifactField(label: string, value: string): string {
  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new Error(`session artifact ${label} must not be empty.`);
  }

  return normalized;
}

function parseMetadata(metadataJson: string): Record<string, string> {
  const parsed = JSON.parse(metadataJson) as unknown;

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function isActiveSessionArtifactMetadata(
  metadata: Record<string, string>,
): boolean {
  if (metadata['source'] !== 'session_orchestrator') {
    return false;
  }

  return !['archived', 'closed', 'done', 'inactive', 'released'].includes(
    metadata['status']?.toLowerCase() ?? '',
  );
}

function updateRunStatus(
  connection: ReturnType<typeof openHarnessDatabase>['connection'],
  runId: string,
  status: string,
  finishedAt?: string,
): void {
  const current = selectOne<{ status: string }>(
    connection,
    'SELECT status FROM runs WHERE id = ?',
    [runId],
  );

  if (current !== null) {
    assertValidTransition('run', runId, current.status, status);
  }

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
  hostCapabilities: SessionContext['hostCapabilities'];
  runId: string;
  leaseId: string;
  leaseExpiresAt: string;
  issueId: string;
  issueTask: string;
  claimMode: 'claim' | 'resume' | 'recovery';
  artifacts: SessionArtifactReference[];
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
    hostCapabilities: input.hostCapabilities,
    runId: input.runId,
    leaseId: input.leaseId,
    leaseExpiresAt: input.leaseExpiresAt,
    issueId: input.issueId,
    issueTask: input.issueTask,
    claimMode: input.claimMode,
    artifacts: input.artifacts,
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

function assertBlockedReasonCompatibility(input: SessionCheckpointInput): void {
  if (input.blockedReason !== undefined && input.taskStatus !== 'blocked') {
    throw new Error('blockedReason can only be provided when taskStatus is blocked.');
  }
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
