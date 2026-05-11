import { existsSync } from 'node:fs';

import type {
  OrchestrationSupervisorDecision,
  OrchestrationSupervisorStopReason,
  OrchestrationSupervisorTickInput,
  OrchestrationSupervisorTickResult,
} from '../contracts/orchestration-contracts.js';
import {
  orchestrationSupervisorTickInputSchema,
  orchestrationSupervisorTickResultSchema,
} from '../contracts/orchestration-contracts.js';
import type { QueuePromotionInput, QueuePromotionResult } from '../contracts/session-contracts.js';
import { openHarnessDatabase } from '../db/store.js';
import type { OrchestrationDashboardViewModel } from '../contracts/orchestration-dashboard-contracts.js';
import {
  applyOrchestrationDashboardIssueFilters,
  hasOrchestrationDashboardIssueFilters,
  normalizeOrchestrationDashboardIssueFilters,
  type OrchestrationDashboardIssueFilters,
} from './orchestration-dashboard-filters.js';
import {
  loadOrchestrationDashboardViewModel,
} from './orchestration-dashboard.js';
import type { InspectOrchestrationInput } from './orchestration-inspector.js';
import {
  dispatchReadyOrchestrationIssues,
  type DispatchReadyOrchestrationIssuesInput,
  type OrchestrationDispatchResult,
} from './orchestration-dispatcher.js';
import {
  resolveCampaignId,
  resolveProjectId,
} from './harness-agentic-helpers.js';
import { SessionOrchestrator } from './session-orchestrator.js';

export interface OrchestrationSupervisorTickDependencies {
  readonly clock?: () => string;
  readonly fileExists?: (path: string) => boolean;
  readonly loadDashboardViewModel?: (
    input: InspectOrchestrationInput,
  ) => OrchestrationDashboardViewModel;
  readonly promoteQueue?: (
    input: QueuePromotionInput,
  ) => Promise<QueuePromotionResult>;
  readonly dispatchReady?: (
    input: DispatchReadyOrchestrationIssuesInput,
  ) => Promise<OrchestrationDispatchResult>;
}

interface SupervisorScope {
  readonly projectId: string;
  readonly campaignId?: string;
}

interface DashboardRead {
  readonly viewModel: OrchestrationDashboardViewModel;
  readonly filters: OrchestrationDashboardIssueFilters;
  readonly filtersActive: boolean;
  readonly unfilteredIssueCount: number;
  readonly visibleReadyIssueIds: readonly string[];
}

const supervisorContractVersion = '1.0.0';

export async function runOrchestrationSupervisorTick(
  rawInput: unknown,
  dependencies: OrchestrationSupervisorTickDependencies = {},
): Promise<OrchestrationSupervisorTickResult> {
  const input = orchestrationSupervisorTickInputSchema.parse(rawInput);
  const clock = dependencies.clock ?? (() => new Date().toISOString());
  const fileExists = dependencies.fileExists ?? existsSync;
  const decisions: OrchestrationSupervisorDecision[] = [];
  const startedAt = clock();
  let observedReadyIssueCount = 0;
  let observedPromotedIssueIds: string[] = [];
  let observedDispatchedIssueIds: string[] = [];

  if (
    input.stopCondition.externalStopFile !== undefined &&
    fileExists(input.stopCondition.externalStopFile)
  ) {
    decisions.push(
      buildDecision({
        tickId: input.tickId,
        suffix: 'external-stop',
        kind: 'idle',
        summary: `External stop file "${input.stopCondition.externalStopFile}" is present; no supervisor work was executed.`,
        wouldMutate: false,
        executed: true,
        clock,
      }),
    );

    return buildTickResult({
      input,
      startedAt,
      completedAt: clock(),
      decisions,
      readyIssueCount: 0,
      promotedIssueIds: [],
      dispatchedIssueIds: [],
      stopReason: 'external_stop',
      summary: 'Supervisor tick stopped before side effects because an external stop file was present.',
    });
  }

  try {
    const scope = resolveSupervisorScope(input);
    const initialDashboard = loadFilteredDashboard(input, scope, dependencies);
    observedReadyIssueCount = initialDashboard.visibleReadyIssueIds.length;

    decisions.push(
      buildDashboardDecision(input.tickId, 'inspect-dashboard', initialDashboard, clock),
    );

    if (input.mode === 'dry_run') {
      return buildDryRunResult({
        input,
        startedAt,
        completedAt: clock(),
        initialDashboard,
        decisions,
      });
    }

    const promotion = await executePromotion({
      input,
      scope,
      dependencies,
      decisions,
      clock,
    });
    observedPromotedIssueIds = [...promotion.promotedIssueIds];
    const postPromotionDashboard = loadFilteredDashboard(input, scope, dependencies);
    observedReadyIssueCount = postPromotionDashboard.visibleReadyIssueIds.length;

    decisions.push(
      buildDashboardDecision(
        input.tickId,
        'inspect-dashboard-after-promotion',
        postPromotionDashboard,
        clock,
      ),
    );

    if (postPromotionDashboard.visibleReadyIssueIds.length === 0) {
      return buildExecuteResult({
        input,
        startedAt,
        completedAt: clock(),
        decisions,
        dashboard: postPromotionDashboard,
        promotedIssueIds: promotion.promotedIssueIds,
        dispatchedIssueIds: [],
        summary:
          promotion.promotedIssueIds.length > 0
            ? `Promoted ${promotion.promotedIssueIds.length} issue(s), but none are visible in the filtered ready lane.`
            : 'No visible ready issues were available after queue promotion.',
      });
    }

    const dispatchResult = await executeDispatch({
      input,
      scope,
      visibleReadyIssueIds: postPromotionDashboard.visibleReadyIssueIds,
      dependencies,
      decisions,
      clock,
    });
    const dispatchedIssueIds = dispatchResult.dispatches.map(
      (dispatch) => dispatch.issue.id,
    );
    const promotedIssueIds = uniqueStrings([
      ...promotion.promotedIssueIds,
      ...dispatchResult.promotedIssueIds,
    ]);
    observedPromotedIssueIds = promotedIssueIds;
    observedDispatchedIssueIds = dispatchedIssueIds;

    return buildExecuteResult({
      input,
      startedAt,
      completedAt: clock(),
      decisions,
      dashboard: postPromotionDashboard,
      promotedIssueIds,
      dispatchedIssueIds,
      dispatchResult,
      summary:
        dispatchedIssueIds.length > 0
          ? `Dispatched ${dispatchedIssueIds.length} visible ready issue(s) after promoting ${promotedIssueIds.length} issue(s).`
          : `No visible ready issues were dispatched; ${dispatchResult.unassignedIssues.length} unassigned issue(s) and ${dispatchResult.failures.length} failure(s) were reported.`,
    });
  } catch (error) {
    const message = getErrorMessage(error);
    decisions.push(
      buildDecision({
        tickId: input.tickId,
        suffix: 'error',
        kind: 'error',
        summary: `Supervisor tick failed: ${message}`,
        wouldMutate: false,
        executed: true,
        clock,
        metadata: {
          errorMessage: message,
        },
      }),
    );

    return buildTickResult({
      input,
      startedAt,
      completedAt: clock(),
      decisions,
      readyIssueCount: observedReadyIssueCount,
      promotedIssueIds: observedPromotedIssueIds,
      dispatchedIssueIds: observedDispatchedIssueIds,
      stopReason: 'error',
      nextDelayMs: input.backoff.errorDelayMs,
      summary: `Supervisor tick failed before completion: ${message}`,
    });
  }
}

function resolveSupervisorScope(input: OrchestrationSupervisorTickInput): SupervisorScope {
  const database = openHarnessDatabase({ dbPath: input.dbPath });

  try {
    const projectId = resolveProjectId(database.connection, {
      projectId: input.projectId,
      projectName: input.projectName,
      workspaceId: input.workspaceId,
    });
    const campaignId =
      input.campaignId !== undefined
        ? input.campaignId
        : input.campaignName !== undefined
          ? resolveCampaignId(database.connection, projectId, {
              campaignName: input.campaignName,
            })
          : undefined;

    return {
      projectId,
      ...(campaignId !== undefined ? { campaignId } : {}),
    };
  } finally {
    database.close();
  }
}

function loadFilteredDashboard(
  input: OrchestrationSupervisorTickInput,
  scope: SupervisorScope,
  dependencies: OrchestrationSupervisorTickDependencies,
): DashboardRead {
  const loader =
    dependencies.loadDashboardViewModel ?? loadOrchestrationDashboardViewModel;
  const unfilteredViewModel = loader({
    dbPath: input.dbPath,
    projectId: scope.projectId,
    ...(scope.campaignId !== undefined ? { campaignId: scope.campaignId } : {}),
    issueId: input.issueId,
    eventLimit: input.eventLimit,
  });
  const filters = normalizeOrchestrationDashboardIssueFilters(
    input.dashboardFilters,
  );
  const viewModel = applyOrchestrationDashboardIssueFilters(
    unfilteredViewModel,
    filters,
  );
  const readyLane = viewModel.issueLanes.find((lane) => lane.id === 'ready');

  return {
    viewModel,
    filters,
    filtersActive: hasOrchestrationDashboardIssueFilters(filters),
    unfilteredIssueCount: unfilteredViewModel.overview.totalIssues,
    visibleReadyIssueIds: readyLane?.cards.map((card) => card.id) ?? [],
  };
}

function buildDryRunResult(input: {
  input: OrchestrationSupervisorTickInput;
  startedAt: string;
  completedAt: string;
  initialDashboard: DashboardRead;
  decisions: OrchestrationSupervisorDecision[];
}): OrchestrationSupervisorTickResult {
  const pendingCount = input.initialDashboard.viewModel.overview.laneCounts.pending ?? 0;
  const readyCount = input.initialDashboard.visibleReadyIssueIds.length;

  if (pendingCount > 0) {
    input.decisions.push(
      buildDecision({
        tickId: input.input.tickId,
        suffix: 'promote-queue-plan',
        kind: 'promote_queue',
        tool: 'harness_orchestrator',
        action: 'promote_queue',
        summary: `Dry-run would promote eligible pending work; ${pendingCount} pending issue(s) are visible in the filtered dashboard.`,
        wouldMutate: true,
        executed: false,
        clock: () => input.completedAt,
        metadata: {
          visiblePendingIssueCount: String(pendingCount),
        },
      }),
    );
  }

  if (readyCount > 0) {
    input.decisions.push(
      buildDecision({
        tickId: input.input.tickId,
        suffix: 'dispatch-ready-plan',
        kind: 'dispatch_ready',
        tool: 'harness_symphony',
        action: 'dispatch_ready',
        summary: `Dry-run would dispatch ${readyCount} visible ready issue(s).`,
        wouldMutate: true,
        executed: false,
        clock: () => input.completedAt,
        metadata: {
          visibleReadyIssueIds: input.initialDashboard.visibleReadyIssueIds.join(','),
        },
      }),
    );
  }

  const stopReason = deriveNonActiveStopReason(input.initialDashboard);
  if (readyCount === 0 && pendingCount === 0 && stopReason !== undefined) {
    input.decisions.push(
      buildIdleOrBlockedDecision(input.input.tickId, stopReason, input.completedAt),
    );
  }

  return buildTickResult({
    input: input.input,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    decisions: input.decisions,
    readyIssueCount: readyCount,
    promotedIssueIds: [],
    dispatchedIssueIds: [],
    stopReason: readyCount === 0 && pendingCount === 0 ? stopReason : undefined,
    nextDelayMs:
      readyCount === 0 && pendingCount === 0
        ? deriveNextDelay(input.input, stopReason)
        : undefined,
    summary:
      readyCount > 0 || pendingCount > 0
        ? `Dry-run found ${readyCount} visible ready issue(s) and ${pendingCount} visible pending issue(s); no state was mutated.`
        : 'Dry-run found no visible actionable supervisor work.',
  });
}

async function executePromotion(input: {
  input: OrchestrationSupervisorTickInput;
  scope: SupervisorScope;
  dependencies: OrchestrationSupervisorTickDependencies;
  decisions: OrchestrationSupervisorDecision[];
  clock: () => string;
}): Promise<QueuePromotionResult> {
  const startedAt = input.clock();
  const promoteQueue =
    input.dependencies.promoteQueue ??
    ((promotionInput: QueuePromotionInput) =>
      new SessionOrchestrator().promoteQueue(promotionInput));

  try {
    const result = await promoteQueue({
      dbPath: input.input.dbPath,
      projectId: input.scope.projectId,
      ...(input.scope.campaignId !== undefined
        ? { campaignId: input.scope.campaignId }
        : {}),
    });

    input.decisions.push(
      buildDecision({
        tickId: input.input.tickId,
        suffix: 'promote-queue',
        kind: 'promote_queue',
        tool: 'harness_orchestrator',
        action: 'promote_queue',
        summary: `Promoted ${result.promotedIssueIds.length} eligible pending issue(s).`,
        wouldMutate: true,
        executed: true,
        startedAt,
        completedAt: input.clock(),
        metadata: {
          promotedIssueIds: result.promotedIssueIds.join(','),
        },
      }),
    );

    return result;
  } catch (error) {
    input.decisions.push(
      buildDecision({
        tickId: input.input.tickId,
        suffix: 'promote-queue-failed',
        kind: 'promote_queue',
        tool: 'harness_orchestrator',
        action: 'promote_queue',
        summary: `Queue promotion failed: ${getErrorMessage(error)}`,
        wouldMutate: true,
        executed: true,
        startedAt,
        completedAt: input.clock(),
        metadata: {
          errorMessage: getErrorMessage(error),
        },
      }),
    );
    throw error;
  }
}

async function executeDispatch(input: {
  input: OrchestrationSupervisorTickInput;
  scope: SupervisorScope;
  visibleReadyIssueIds: readonly string[];
  dependencies: OrchestrationSupervisorTickDependencies;
  decisions: OrchestrationSupervisorDecision[];
  clock: () => string;
}): Promise<OrchestrationDispatchResult> {
  const dispatch = input.input.dispatch;
  if (dispatch === undefined || input.input.workspaceId === undefined) {
    throw new Error('execute supervisor ticks require dispatch and workspaceId.');
  }

  const startedAt = input.clock();
  const dispatchReady =
    input.dependencies.dispatchReady ?? dispatchReadyOrchestrationIssues;

  try {
    const result = await dispatchReady({
      dbPath: input.input.dbPath,
      workspaceId: input.input.workspaceId,
      projectId: input.scope.projectId,
      ...(input.scope.campaignId !== undefined
        ? { campaignId: input.scope.campaignId }
        : {}),
      repoRoot: dispatch.repoRoot,
      worktreeRoot: dispatch.worktreeRoot,
      baseRef: dispatch.baseRef,
      host: dispatch.host,
      hostCapabilities: dispatch.hostCapabilities,
      dispatchId: `dispatch-${input.input.tickId}`,
      objective: input.input.objective,
      branchPrefix: dispatch.branchPrefix,
      cleanupPolicy: dispatch.cleanupPolicy,
      maxAssignments: Math.min(
        input.visibleReadyIssueIds.length,
        dispatch.maxConcurrentAgents,
      ),
      maxConcurrentAgents: dispatch.maxConcurrentAgents,
      promoteBeforeDispatch: false,
      subagents: dispatch.subagents,
      issueIds: [...input.visibleReadyIssueIds],
    });

    input.decisions.push(
      buildDecision({
        tickId: input.input.tickId,
        suffix: 'dispatch-ready',
        kind: 'dispatch_ready',
        tool: 'harness_symphony',
        action: 'dispatch_ready',
        summary: `Dispatch completed with status "${result.status}" for ${result.dispatches.length} visible ready issue(s).`,
        wouldMutate: true,
        executed: true,
        startedAt,
        completedAt: input.clock(),
        metadata: {
          dispatchId: result.dispatchId,
          status: result.status,
          dispatchedIssueIds: result.dispatches
            .map((dispatchResult) => dispatchResult.issue.id)
            .join(','),
          unassignedIssueCount: String(result.unassignedIssues.length),
          failureCount: String(result.failures.length),
        },
      }),
    );

    return result;
  } catch (error) {
    input.decisions.push(
      buildDecision({
        tickId: input.input.tickId,
        suffix: 'dispatch-ready-failed',
        kind: 'dispatch_ready',
        tool: 'harness_symphony',
        action: 'dispatch_ready',
        summary: `Dispatch failed: ${getErrorMessage(error)}`,
        wouldMutate: true,
        executed: true,
        startedAt,
        completedAt: input.clock(),
        metadata: {
          errorMessage: getErrorMessage(error),
        },
      }),
    );
    throw error;
  }
}

function buildExecuteResult(input: {
  input: OrchestrationSupervisorTickInput;
  startedAt: string;
  completedAt: string;
  decisions: OrchestrationSupervisorDecision[];
  dashboard: DashboardRead;
  promotedIssueIds: readonly string[];
  dispatchedIssueIds: readonly string[];
  dispatchResult?: OrchestrationDispatchResult;
  summary: string;
}): OrchestrationSupervisorTickResult {
  const readyCount = input.dashboard.visibleReadyIssueIds.length;
  const blockedByDispatch =
    readyCount > 0 &&
    input.dispatchResult !== undefined &&
    input.dispatchedIssueIds.length === 0 &&
    (input.dispatchResult.unassignedIssues.length > 0 ||
      input.dispatchResult.failures.length > 0);
  const stopReason =
    input.dispatchedIssueIds.length > 0
      ? undefined
      : blockedByDispatch
        ? 'blocked'
        : input.promotedIssueIds.length > 0
          ? undefined
        : deriveNonActiveStopReason(input.dashboard);

  if (
    (stopReason === 'idle' || stopReason === 'blocked') &&
    !hasDecisionKind(input.decisions, stopReason)
  ) {
    input.decisions.push(
      buildIdleOrBlockedDecision(input.input.tickId, stopReason, input.completedAt),
    );
  }

  return buildTickResult({
    input: input.input,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    decisions: input.decisions,
    readyIssueCount: readyCount,
    promotedIssueIds: [...input.promotedIssueIds],
    dispatchedIssueIds: [...input.dispatchedIssueIds],
    stopReason,
    nextDelayMs: deriveNextDelay(input.input, stopReason),
    summary: input.summary,
  });
}

function buildDashboardDecision(
  tickId: string,
  suffix: string,
  dashboard: DashboardRead,
  clock: () => string,
): OrchestrationSupervisorDecision {
  return buildDecision({
    tickId,
    suffix,
    kind: 'inspect_dashboard',
    tool: 'harness_symphony',
    action: 'dashboard_view',
    summary: dashboard.filtersActive
      ? `Loaded filtered dashboard view with ${dashboard.viewModel.overview.totalIssues} of ${dashboard.unfilteredIssueCount} issue(s) visible.`
      : `Loaded dashboard view with ${dashboard.viewModel.overview.totalIssues} issue(s).`,
    wouldMutate: false,
    executed: true,
    clock,
    metadata: {
      filtersActive: String(dashboard.filtersActive),
      readyIssueCount: String(dashboard.visibleReadyIssueIds.length),
      pendingIssueCount: String(
        dashboard.viewModel.overview.laneCounts.pending ?? 0,
      ),
      healthStatus: dashboard.viewModel.health.status,
    },
  });
}

function buildIdleOrBlockedDecision(
  tickId: string,
  stopReason: OrchestrationSupervisorStopReason,
  timestamp: string,
): OrchestrationSupervisorDecision {
  const isBlocked = stopReason === 'blocked';
  return buildDecision({
    tickId,
    suffix: isBlocked ? 'blocked' : 'idle',
    kind: isBlocked ? 'blocked' : 'idle',
    summary: isBlocked
      ? 'Supervisor found no dispatchable work and blocked or recovery signals are visible.'
      : 'Supervisor found no visible actionable work.',
    wouldMutate: false,
    executed: true,
    clock: () => timestamp,
  });
}

function buildDecision(input: {
  tickId: string;
  suffix: string;
  kind: OrchestrationSupervisorDecision['kind'];
  summary: string;
  wouldMutate: boolean;
  executed: boolean;
  clock?: () => string;
  tool?: string;
  action?: string;
  startedAt?: string;
  completedAt?: string;
  metadata?: Record<string, string>;
}): OrchestrationSupervisorDecision {
  const timestamp =
    input.clock?.() ?? input.completedAt ?? input.startedAt ?? new Date().toISOString();
  return {
    id: `${input.tickId}:${input.suffix}`,
    kind: input.kind,
    summary: input.summary,
    ...(input.tool !== undefined ? { tool: input.tool } : {}),
    ...(input.action !== undefined ? { action: input.action } : {}),
    wouldMutate: input.wouldMutate,
    executed: input.executed,
    startedAt: input.startedAt ?? timestamp,
    completedAt: input.completedAt ?? timestamp,
    evidenceArtifactIds: [],
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  };
}

function deriveNonActiveStopReason(
  dashboard: DashboardRead,
): OrchestrationSupervisorStopReason | undefined {
  if (
    dashboard.viewModel.overview.blockedCount > 0 ||
    dashboard.viewModel.overview.needsRecoveryCount > 0 ||
    dashboard.viewModel.overview.healthStatus === 'warning'
  ) {
    return 'blocked';
  }

  return 'idle';
}

function deriveNextDelay(
  input: OrchestrationSupervisorTickInput,
  stopReason: OrchestrationSupervisorStopReason | undefined,
): number | undefined {
  if (stopReason === 'idle') {
    return input.stopCondition.stopWhenIdle
      ? undefined
      : input.backoff.idleDelayMs;
  }

  if (stopReason === 'blocked') {
    return input.stopCondition.stopWhenBlocked
      ? undefined
      : input.backoff.blockedDelayMs;
  }

  if (stopReason === 'error') {
    return input.backoff.errorDelayMs;
  }

  return undefined;
}

function buildTickResult(input: {
  input: OrchestrationSupervisorTickInput;
  startedAt: string;
  completedAt: string;
  decisions: readonly OrchestrationSupervisorDecision[];
  readyIssueCount: number;
  promotedIssueIds: readonly string[];
  dispatchedIssueIds: readonly string[];
  summary: string;
  stopReason?: OrchestrationSupervisorStopReason;
  nextDelayMs?: number;
}): OrchestrationSupervisorTickResult {
  return orchestrationSupervisorTickResultSchema.parse({
    contractVersion: supervisorContractVersion,
    tickId: input.input.tickId,
    mode: input.input.mode,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    ...(input.stopReason !== undefined ? { stopReason: input.stopReason } : {}),
    decisions: input.decisions,
    readyIssueCount: input.readyIssueCount,
    promotedIssueIds: input.promotedIssueIds,
    dispatchedIssueIds: input.dispatchedIssueIds,
    evidenceArtifactIds: [],
    ...(input.nextDelayMs !== undefined ? { nextDelayMs: input.nextDelayMs } : {}),
    summary: input.summary,
  });
}

function hasDecisionKind(
  decisions: readonly OrchestrationSupervisorDecision[],
  kind: OrchestrationSupervisorDecision['kind'],
): boolean {
  return decisions.some((decision) => decision.kind === kind);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
