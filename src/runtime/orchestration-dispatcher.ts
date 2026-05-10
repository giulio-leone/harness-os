import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import {
  orchestrationPlanSchema,
  orchestrationSubagentSchema,
  type OrchestrationAssignment,
  type OrchestrationPlan,
  type OrchestrationSubagent,
  type OrchestrationWorktree,
  type OrchestrationWorktreeCleanupPolicy,
} from '../contracts/orchestration-contracts.js';
import {
  harnessHostCapabilitiesSchema,
  type HarnessHostCapabilities,
} from '../contracts/policy-contracts.js';
import type {
  SessionArtifactReference,
  SessionContext,
} from '../contracts/session-contracts.js';
import {
  openReadonlyHarnessDatabase,
  selectAll,
} from '../db/store.js';
import {
  buildWorktreeAllocation,
  validateWorktreeCandidate,
} from './worktree-manager.js';
import {
  checkSubagentCompatibility,
  createDefaultGpt5HighSubagents,
  createSubagentRegistry,
  type SubagentRegistry,
} from './subagent-registry.js';
import { SessionOrchestrator } from './session-orchestrator.js';

const orchestrationDispatcherContractVersion = '1.0.0';
const defaultMaxConcurrentAgents = 4;
const defaultLeaseTtlSeconds = 1800;

const nonEmptyString = z.string().min(1);
const positiveInteger = z.number().int().positive();

const dispatchIssueRequirementSchema = z
  .object({
    issueId: nonEmptyString,
    requiredCapabilityIds: z.array(nonEmptyString).optional(),
  })
  .strict();

export const dispatchReadyOrchestrationIssuesInputSchema = z
  .object({
    dbPath: nonEmptyString,
    workspaceId: nonEmptyString,
    projectId: nonEmptyString,
    campaignId: nonEmptyString.optional(),
    repoRoot: nonEmptyString,
    worktreeRoot: nonEmptyString,
    baseRef: nonEmptyString,
    host: nonEmptyString,
    hostCapabilities: harnessHostCapabilitiesSchema,
    dispatchId: nonEmptyString.optional(),
    objective: nonEmptyString.optional(),
    branchPrefix: nonEmptyString.optional(),
    cleanupPolicy: z
      .enum([
        'retain',
        'delete_on_success',
        'delete_on_failure',
        'delete_on_completion',
      ])
      .optional(),
    maxAssignments: positiveInteger.optional(),
    maxConcurrentAgents: positiveInteger.optional(),
    leaseTtlSeconds: positiveInteger.optional(),
    checkpointFreshnessSeconds: positiveInteger.optional(),
    mem0Enabled: z.boolean().optional(),
    memorySearchLimit: positiveInteger.optional(),
    artifacts: z
      .array(
        z
          .object({
            kind: nonEmptyString,
            path: nonEmptyString,
          })
          .strict(),
      )
      .optional(),
    subagents: z.array(orchestrationSubagentSchema).min(1).optional(),
    issueRequirements: z.array(dispatchIssueRequirementSchema).optional(),
  })
  .strict();

export type DispatchReadyOrchestrationIssuesInput = z.infer<
  typeof dispatchReadyOrchestrationIssuesInputSchema
>;

export type OrchestrationDispatcherStatus =
  | 'idle'
  | 'dispatched'
  | 'partial'
  | 'failed';

export type OrchestrationDispatchUnassignedReason =
  | 'dispatch_limit_reached'
  | 'no_compatible_subagent'
  | 'subagent_capacity_exhausted';

export interface OrchestrationDispatchIssueCandidate {
  readonly id: string;
  readonly task: string;
  readonly priority: string;
  readonly status: 'ready';
  readonly createdAt: string;
}

export interface OrchestrationDispatchUnassignedIssue {
  readonly issueId: string;
  readonly reason: OrchestrationDispatchUnassignedReason;
  readonly requiredCapabilityIds: readonly string[];
  readonly message: string;
}

export interface OrchestrationDispatchFailure {
  readonly issueId: string;
  readonly subagentId?: string;
  readonly worktreeId?: string;
  readonly message: string;
}

export interface OrchestrationIssueDispatch {
  readonly assignment: OrchestrationAssignment;
  readonly issue: OrchestrationDispatchIssueCandidate;
  readonly subagent: OrchestrationSubagent;
  readonly worktree: OrchestrationWorktree;
  readonly session: SessionContext;
}

export interface OrchestrationDispatchResult {
  readonly dispatchId: string;
  readonly status: OrchestrationDispatcherStatus;
  readonly promotedIssueIds: readonly string[];
  readonly plan?: OrchestrationPlan;
  readonly dispatches: readonly OrchestrationIssueDispatch[];
  readonly unassignedIssues: readonly OrchestrationDispatchUnassignedIssue[];
  readonly failures: readonly OrchestrationDispatchFailure[];
}

interface ReadyIssueRow {
  id: string;
  task: string;
  priority: string;
  status: 'ready';
  created_at: string;
}

interface ActiveLeaseCountRow {
  agent_id: string;
  active_count: number;
}

export async function dispatchReadyOrchestrationIssues(
  rawInput: DispatchReadyOrchestrationIssuesInput,
  orchestrator = new SessionOrchestrator(),
): Promise<OrchestrationDispatchResult> {
  const input = dispatchReadyOrchestrationIssuesInputSchema.parse(rawInput);
  const dispatchId = input.dispatchId ?? `dispatch-${randomUUID()}`;
  const subagents = input.subagents ?? createDefaultGpt5HighSubagents();
  const registry = createSubagentRegistry({ subagents });
  const maxConcurrentAgents =
    input.maxConcurrentAgents ?? defaultMaxConcurrentAgents;
  const maxAssignments = Math.min(
    input.maxAssignments ?? maxConcurrentAgents,
    maxConcurrentAgents,
  );
  const promoted = await orchestrator.promoteQueue({
    dbPath: input.dbPath,
    projectId: input.projectId,
    ...(input.campaignId !== undefined ? { campaignId: input.campaignId } : {}),
  });
  const readyIssues = selectReadyIssues(input);
  const activeCounts = selectActiveLeaseCounts(input);
  const plannedCounts = new Map<string, number>();
  const requirementByIssueId = indexIssueRequirements(input.issueRequirements ?? []);
  const dispatches: OrchestrationIssueDispatch[] = [];
  const unassignedIssues: OrchestrationDispatchUnassignedIssue[] = [];
  const failures: OrchestrationDispatchFailure[] = [];
  const worktrees: OrchestrationWorktree[] = [];

  for (const issue of readyIssues) {
    const requiredCapabilityIds = requirementByIssueId.get(issue.id) ?? [];

    if (dispatches.length >= maxAssignments) {
      unassignedIssues.push({
        issueId: issue.id,
        reason: 'dispatch_limit_reached',
        requiredCapabilityIds,
        message: `Dispatch limit ${maxAssignments} reached before issue ${issue.id}.`,
      });
      continue;
    }

    const selection = selectSubagentForIssue({
      registry,
      host: input.host,
      hostCapabilities: input.hostCapabilities,
      requiredCapabilityIds,
      activeCounts,
      plannedCounts,
    });

    if (selection.kind !== 'selected') {
      unassignedIssues.push({
        issueId: issue.id,
        reason: selection.reason,
        requiredCapabilityIds,
        message: selection.message,
      });
      continue;
    }

    const worktree = buildWorktreeForIssue(input, dispatchId, issue.id);
    const worktreeValidation = validateWorktreeCandidate(worktree, worktrees);

    if (!worktreeValidation.ok) {
      failures.push({
        issueId: issue.id,
        subagentId: selection.subagent.id,
        worktreeId: worktree.id,
        message: worktreeValidation.issues
          .map((validationIssue) => validationIssue.message)
          .join('; '),
      });
      continue;
    }

    try {
      const assignment = buildAssignment({
        issueId: issue.id,
        subagentId: selection.subagent.id,
        worktreeId: worktreeValidation.worktree.id,
        requiredCapabilityIds,
      });
      const session = await orchestrator.beginIncrementalSession({
        sessionId: `${dispatchId}-${assignment.id}`,
        dbPath: input.dbPath,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        ...(input.campaignId !== undefined ? { campaignId: input.campaignId } : {}),
        preferredIssueId: issue.id,
        agentId: selection.subagent.id,
        host: input.host,
        hostCapabilities: input.hostCapabilities,
        artifacts: buildSessionArtifacts(input.artifacts ?? [], {
          assignment,
          worktree: worktreeValidation.worktree,
        }),
        mem0Enabled: input.mem0Enabled ?? false,
        leaseTtlSeconds: input.leaseTtlSeconds ?? defaultLeaseTtlSeconds,
        agentMaxConcurrentLeases: selection.subagent.maxConcurrency,
        ...(input.checkpointFreshnessSeconds !== undefined
          ? { checkpointFreshnessSeconds: input.checkpointFreshnessSeconds }
          : {}),
        ...(input.memorySearchLimit !== undefined
          ? { memorySearchLimit: input.memorySearchLimit }
          : {}),
      });

      incrementCount(plannedCounts, selection.subagent.id);
      worktrees.push(worktreeValidation.worktree);
      dispatches.push({
        assignment,
        issue,
        subagent: selection.subagent,
        worktree: worktreeValidation.worktree,
        session,
      });
    } catch (error) {
      failures.push({
        issueId: issue.id,
        subagentId: selection.subagent.id,
        worktreeId: worktreeValidation.worktree.id,
        message: getErrorMessage(error),
      });
    }
  }

  return {
    dispatchId,
    status: deriveDispatchStatus(dispatches, failures),
    promotedIssueIds: promoted.promotedIssueIds,
    ...(dispatches.length > 0
      ? {
          plan: buildPlan({
            objective:
              input.objective ??
              `Dispatch ${dispatches.length} ready orchestration issue(s).`,
            maxConcurrentAgents,
            dispatches,
          }),
        }
      : {}),
    dispatches,
    unassignedIssues,
    failures,
  };
}

function selectReadyIssues(
  input: Pick<
    DispatchReadyOrchestrationIssuesInput,
    'dbPath' | 'projectId' | 'campaignId'
  >,
): OrchestrationDispatchIssueCandidate[] {
  const database = openReadonlyHarnessDatabase({ dbPath: input.dbPath });

  try {
    const rows = selectAll<ReadyIssueRow>(
      database.connection,
      `SELECT id, task, priority, status, created_at
       FROM issues
       WHERE project_id = ?
         AND (? IS NULL OR campaign_id = ?)
         AND status = 'ready'
       ORDER BY
         CASE priority
           WHEN 'critical' THEN 0
           WHEN 'high' THEN 1
           WHEN 'medium' THEN 2
           ELSE 3
         END,
         created_at ASC,
         id ASC`,
      [input.projectId, input.campaignId ?? null, input.campaignId ?? null],
    );

    return rows.map((row) => ({
      id: row.id,
      task: row.task,
      priority: row.priority,
      status: row.status,
      createdAt: row.created_at,
    }));
  } finally {
    database.close();
  }
}

function selectActiveLeaseCounts(
  input: Pick<
    DispatchReadyOrchestrationIssuesInput,
    'dbPath' | 'projectId'
  >,
): Map<string, number> {
  const database = openReadonlyHarnessDatabase({ dbPath: input.dbPath });

  try {
    const rows = selectAll<ActiveLeaseCountRow>(
      database.connection,
      `SELECT agent_id, COUNT(*) AS active_count
       FROM leases
       WHERE project_id = ?
         AND status = 'active'
         AND released_at IS NULL
       GROUP BY agent_id
       ORDER BY agent_id ASC`,
      [input.projectId],
    );

    return new Map(
      rows.map((row) => [row.agent_id, Number(row.active_count)]),
    );
  } finally {
    database.close();
  }
}

function selectSubagentForIssue(input: {
  registry: SubagentRegistry;
  host: string;
  hostCapabilities: HarnessHostCapabilities;
  requiredCapabilityIds: readonly string[];
  activeCounts: ReadonlyMap<string, number>;
  plannedCounts: ReadonlyMap<string, number>;
}):
  | { readonly kind: 'selected'; readonly subagent: OrchestrationSubagent }
  | {
      readonly kind: 'unassigned';
      readonly reason: Exclude<
        OrchestrationDispatchUnassignedReason,
        'dispatch_limit_reached'
      >;
      readonly message: string;
    } {
  const compatibleSubagents = input.registry.subagents.filter((subagent) => {
    if (subagent.host !== input.host) {
      return false;
    }

    if (!hasRequiredCapabilities(subagent, input.requiredCapabilityIds)) {
      return false;
    }

    return checkSubagentCompatibility(subagent, {
      hostCapabilities: input.hostCapabilities,
    }).compatible;
  });

  if (compatibleSubagents.length === 0) {
    return {
      kind: 'unassigned',
      reason: 'no_compatible_subagent',
      message: 'No compatible subagent satisfies host and capability constraints.',
    };
  }

  const availableSubagent = compatibleSubagents.find((subagent) => {
    const activeCount = input.activeCounts.get(subagent.id) ?? 0;
    const plannedCount = input.plannedCounts.get(subagent.id) ?? 0;
    return activeCount + plannedCount < subagent.maxConcurrency;
  });

  if (availableSubagent === undefined) {
    return {
      kind: 'unassigned',
      reason: 'subagent_capacity_exhausted',
      message: 'All compatible subagents are at their active lease capacity.',
    };
  }

  return {
    kind: 'selected',
    subagent: availableSubagent,
  };
}

function buildWorktreeForIssue(
  input: Pick<
    DispatchReadyOrchestrationIssuesInput,
    'repoRoot' | 'worktreeRoot' | 'baseRef' | 'branchPrefix' | 'cleanupPolicy'
  >,
  dispatchId: string,
  issueId: string,
): OrchestrationWorktree {
  const branchPrefix = input.branchPrefix ?? `orchestration/${dispatchId}`;

  return buildWorktreeAllocation({
    issueId,
    repoRoot: input.repoRoot,
    worktreeRoot: input.worktreeRoot,
    baseRef: input.baseRef,
    branchPrefix,
    cleanupPolicy: input.cleanupPolicy ?? 'delete_on_completion',
  });
}

function buildAssignment(input: {
  issueId: string;
  subagentId: string;
  worktreeId: string;
  requiredCapabilityIds: readonly string[];
}): OrchestrationAssignment {
  return {
    id: `assignment-${input.worktreeId}`,
    issueId: input.issueId,
    subagentId: input.subagentId,
    worktreeId: input.worktreeId,
    ...(input.requiredCapabilityIds.length > 0
      ? { requiredCapabilityIds: [...input.requiredCapabilityIds] }
      : {}),
  };
}

function buildSessionArtifacts(
  artifacts: readonly SessionArtifactReference[],
  input: {
    assignment: OrchestrationAssignment;
    worktree: OrchestrationWorktree;
  },
): SessionArtifactReference[] {
  return [
    ...artifacts,
    {
      kind: 'orchestration_assignment',
      path: `orchestration://${input.assignment.id}`,
    },
    {
      kind: 'orchestration_worktree',
      path: input.worktree.path,
    },
  ];
}

function buildPlan(input: {
  objective: string;
  maxConcurrentAgents: number;
  dispatches: readonly OrchestrationIssueDispatch[];
}): OrchestrationPlan {
  const selectedSubagents = uniqueBy(
    input.dispatches.map((dispatch) => dispatch.subagent),
    (subagent) => subagent.id,
  );
  const worktrees = input.dispatches.map((dispatch) => dispatch.worktree);
  const assignments = input.dispatches.map((dispatch) => dispatch.assignment);

  return orchestrationPlanSchema.parse({
    contractVersion: orchestrationDispatcherContractVersion,
    objective: input.objective,
    subagents: selectedSubagents,
    worktrees,
    dispatch: {
      strategy: 'fanout',
      maxConcurrentAgents: Math.min(input.maxConcurrentAgents, assignments.length),
      assignments,
    },
  });
}

function indexIssueRequirements(
  requirements: readonly z.infer<typeof dispatchIssueRequirementSchema>[],
): Map<string, readonly string[]> {
  return new Map(
    requirements.map((requirement) => [
      requirement.issueId,
      normalizeStringSet(requirement.requiredCapabilityIds ?? []),
    ]),
  );
}

function hasRequiredCapabilities(
  subagent: OrchestrationSubagent,
  requiredCapabilityIds: readonly string[],
): boolean {
  const capabilities = new Set(subagent.capabilities);
  return requiredCapabilityIds.every((capability) => capabilities.has(capability));
}

function incrementCount(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function deriveDispatchStatus(
  dispatches: readonly OrchestrationIssueDispatch[],
  failures: readonly OrchestrationDispatchFailure[],
): OrchestrationDispatcherStatus {
  if (dispatches.length > 0 && failures.length === 0) {
    return 'dispatched';
  }

  if (dispatches.length > 0) {
    return 'partial';
  }

  if (failures.length > 0) {
    return 'failed';
  }

  return 'idle';
}

function normalizeStringSet(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()))].sort((left, right) =>
    left.localeCompare(right),
  );
}

function uniqueBy<T>(values: readonly T[], keyOf: (value: T) => string): T[] {
  const byKey = new Map<string, T>();

  for (const value of values) {
    const key = keyOf(value);

    if (!byKey.has(key)) {
      byKey.set(key, value);
    }
  }

  return [...byKey.values()];
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
