import {
  orchestrationDashboardContractVersion,
  orchestrationDashboardLaneOrder,
  orchestrationDashboardViewModelSchema,
  type OrchestrationDashboardActiveAgent,
  type OrchestrationDashboardHealthFlag,
  type OrchestrationDashboardIssueCard,
  type OrchestrationDashboardLaneId,
  type OrchestrationDashboardViewModel,
} from '../contracts/orchestration-dashboard-contracts.js';
import {
  inspectOrchestration,
  type InspectOrchestrationInput,
  type OrchestrationArtifactSummary,
  type OrchestrationHealthFlag,
  type OrchestrationInspectorSummary,
  type OrchestrationIssueSummary,
  type OrchestrationLeaseSummary,
} from './orchestration-inspector.js';

export interface LoadOrchestrationDashboardViewModelOptions {
  inspector?: (input: InspectOrchestrationInput) => OrchestrationInspectorSummary;
}

const LANE_LABELS = {
  ready: {
    label: 'Ready',
    description: 'Issues ready for agentic dispatch.',
  },
  in_progress: {
    label: 'In progress',
    description: 'Issues currently owned by active sessions or agents.',
  },
  blocked: {
    label: 'Blocked',
    description: 'Issues waiting on an explicit blocker to clear.',
  },
  needs_recovery: {
    label: 'Needs recovery',
    description: 'Issues requiring controlled recovery before normal dispatch.',
  },
  pending: {
    label: 'Pending',
    description: 'Issues waiting for dependencies or queue promotion.',
  },
  done: {
    label: 'Done',
    description: 'Issues completed with durable evidence.',
  },
  failed: {
    label: 'Failed',
    description: 'Issues that failed and need triage or rollback.',
  },
  other: {
    label: 'Other',
    description: 'Issues with non-canonical or future statuses.',
  },
} as const satisfies Record<
  (typeof orchestrationDashboardLaneOrder)[number],
  { label: string; description: string }
>;

const CANONICAL_STATUS_LANES = new Set<string>(orchestrationDashboardLaneOrder);
const PRIORITY_ORDER = new Map([
  ['critical', 0],
  ['high', 1],
  ['medium', 2],
  ['low', 3],
]);

export function loadOrchestrationDashboardViewModel(
  input: InspectOrchestrationInput,
  options: LoadOrchestrationDashboardViewModelOptions = {},
): OrchestrationDashboardViewModel {
  const inspector = options.inspector ?? inspectOrchestration;

  return buildOrchestrationDashboardViewModel(inspector(input));
}

export function buildOrchestrationDashboardViewModel(
  summary: OrchestrationInspectorSummary,
): OrchestrationDashboardViewModel {
  if (summary.summaryVersion !== 1) {
    throw new Error(
      `Unsupported orchestration inspector summaryVersion "${summary.summaryVersion}".`,
    );
  }

  const issueIds = new Set(summary.issues.items.map((issue) => issue.id));
  const activeAgentsByIssueId = groupActiveAgentsByIssueId(summary.leases.active);
  const primaryLeaseIds = selectPrimaryLeaseIds(activeAgentsByIssueId);
  const artifactsByIssueId = groupArtifactsByIssueId(summary.artifacts.byKind);
  const artifactIssueIdById = indexArtifactIssueIds(summary.artifacts.byKind);
  const healthByIssueId = new Map<string, OrchestrationDashboardHealthFlag[]>();
  const globalHealthFlags: OrchestrationDashboardHealthFlag[] = [];

  for (const flag of summary.health.flags) {
    const routedIssueIds = extractHealthFlagIssueIds(flag, artifactIssueIdById)
      .filter((issueId) => issueIds.has(issueId));
    const dashboardFlag = flag as OrchestrationDashboardHealthFlag;

    if (routedIssueIds.length > 0) {
      for (const issueId of routedIssueIds) {
        const issueFlags = healthByIssueId.get(issueId) ?? [];
        issueFlags.push(dashboardFlag);
        healthByIssueId.set(issueId, issueFlags);
      }
    } else {
      globalHealthFlags.push(dashboardFlag);
    }
  }

  const issueCards = summary.issues.items.map((issue) =>
    buildIssueCard({
      issue,
      activeAgents: activeAgentsByIssueId.get(issue.id) ?? [],
      primaryLeaseId: primaryLeaseIds.get(issue.id) ?? null,
      artifacts: artifactsByIssueId.get(issue.id) ?? [],
      healthFlags: healthByIssueId.get(issue.id) ?? [],
    }),
  );
  const issueLanes = orchestrationDashboardLaneOrder.map((laneId) => {
    const laneCards = issueCards
      .filter((card) => card.laneId === laneId)
      .sort(compareIssueCards);
    const laneMetadata = LANE_LABELS[laneId];

    return {
      id: laneId,
      label: laneMetadata.label,
      description: laneMetadata.description,
      count: laneCards.length,
      cards: laneCards,
    };
  });
  const activeAgents = summary.leases.active
    .map((lease) =>
      buildActiveAgent(lease, primaryLeaseIds.get(lease.issueId ?? '') === lease.id),
    )
    .sort(compareActiveAgents);
  const laneCounts = Object.fromEntries(
    issueLanes.map((lane) => [lane.id, lane.count]),
  );

  return orchestrationDashboardViewModelSchema.parse({
    contractVersion: orchestrationDashboardContractVersion,
    sourceSummaryVersion: summary.summaryVersion,
    generatedAt: summary.generatedAt,
    scope: summary.scope,
    overview: {
      totalIssues: summary.issues.total,
      readyCount: laneCounts.ready ?? 0,
      activeIssueCount: laneCounts.in_progress ?? 0,
      blockedCount: laneCounts.blocked ?? 0,
      needsRecoveryCount: laneCounts.needs_recovery ?? 0,
      doneCount: laneCounts.done ?? 0,
      failedCount: laneCounts.failed ?? 0,
      otherCount: laneCounts.other ?? 0,
      activeLeaseCount: summary.leases.activeCount,
      expiredLeaseCount: summary.leases.active.filter((lease) => lease.expired).length,
      evidenceArtifactCount: summary.artifacts.total,
      healthStatus: summary.health.status,
      statusCounts: sortCountRecord(summary.issues.statusCounts),
      laneCounts: sortCountRecord(laneCounts),
    },
    issueLanes,
    activeAgents,
    evidence: {
      totalArtifacts: summary.artifacts.total,
      countsByKind: sortCountRecord(
        Object.fromEntries(
          summary.artifacts.byKind.map((group) => [group.kind, group.count]),
        ),
      ),
      orphanArtifactCount: summary.artifacts.byKind
        .flatMap((group) => group.artifacts)
        .filter((artifact) => artifact.issueId === null).length,
      worktreePathCount: summary.artifacts.references.worktreePaths.length,
      evidencePacketCount: summary.artifacts.references.evidencePacketIds.length,
      csqrLiteScorecardCount:
        summary.artifacts.references.csqrLiteScorecardIds.length,
      references: summary.artifacts.references,
    },
    recentTimeline: summary.events.recent.map((event) => ({
      id: event.id,
      issueId: event.issueId,
      runId: event.runId,
      kind: event.kind,
      payload: event.payload,
      createdAt: event.createdAt,
    })),
    health: {
      status: summary.health.status,
      severityCounts: buildSeverityCounts(summary.health.flags),
      flags: summary.health.flags,
      globalFlags: globalHealthFlags,
    },
  });
}

function buildIssueCard(input: {
  issue: OrchestrationIssueSummary;
  activeAgents: OrchestrationDashboardActiveAgent[];
  primaryLeaseId: string | null;
  artifacts: OrchestrationArtifactSummary[];
  healthFlags: OrchestrationDashboardHealthFlag[];
}): OrchestrationDashboardIssueCard {
  const sortedArtifacts = [...input.artifacts].sort(compareArtifacts);

  return {
    id: input.issue.id,
    campaignId: input.issue.campaignId,
    task: input.issue.task,
    priority: input.issue.priority,
    status: input.issue.status,
    laneId: toLaneId(input.issue.status),
    size: input.issue.size,
    nextBestAction: input.issue.nextBestAction,
    blockedReason: input.issue.blockedReason,
    createdAt: input.issue.createdAt,
    deadlineAt: input.issue.deadlineAt,
    activeLeases: input.activeAgents.sort(compareActiveAgents),
    primaryLeaseId: input.primaryLeaseId,
    artifactIds: sortedArtifacts.map((artifact) => artifact.id),
    artifactKinds: countArtifactsByKind(sortedArtifacts),
    worktreePaths: sortedUnique(
      sortedArtifacts.flatMap((artifact) =>
        artifact.references.worktreePath !== undefined
          ? [artifact.references.worktreePath]
          : [],
      ),
    ),
    evidencePacketIds: sortedUnique(
      sortedArtifacts.flatMap((artifact) =>
        artifact.references.evidencePacketId !== undefined
          ? [artifact.references.evidencePacketId]
          : [],
      ),
    ),
    csqrLiteScorecardIds: sortedUnique(
      sortedArtifacts.flatMap((artifact) =>
        artifact.references.csqrLiteScorecardId !== undefined
          ? [artifact.references.csqrLiteScorecardId]
          : [],
      ),
    ),
    healthFlags: input.healthFlags,
  };
}

function buildActiveAgent(
  lease: OrchestrationLeaseSummary,
  primaryForIssue: boolean,
): OrchestrationDashboardActiveAgent {
  return {
    leaseId: lease.id,
    issueId: lease.issueId,
    agentId: lease.agentId,
    status: lease.status,
    acquiredAt: lease.acquiredAt,
    expiresAt: lease.expiresAt,
    lastHeartbeatAt: lease.lastHeartbeatAt,
    releasedAt: lease.releasedAt,
    expired: lease.expired,
    primaryForIssue,
  };
}

function groupActiveAgentsByIssueId(
  leases: OrchestrationLeaseSummary[],
): Map<string, OrchestrationDashboardActiveAgent[]> {
  const groups = new Map<string, OrchestrationDashboardActiveAgent[]>();

  for (const lease of leases) {
    if (lease.issueId === null) {
      continue;
    }

    const leasesForIssue = groups.get(lease.issueId) ?? [];
    leasesForIssue.push(buildActiveAgent(lease, false));
    groups.set(lease.issueId, leasesForIssue);
  }

  return groups;
}

function selectPrimaryLeaseIds(
  activeAgentsByIssueId: Map<string, OrchestrationDashboardActiveAgent[]>,
): Map<string, string> {
  const primaryLeaseIds = new Map<string, string>();

  for (const [issueId, activeAgents] of activeAgentsByIssueId.entries()) {
    const [primaryLease] = [...activeAgents].sort(comparePrimaryLeaseCandidates);

    if (primaryLease !== undefined) {
      primaryLeaseIds.set(issueId, primaryLease.leaseId);
    }
  }

  for (const [issueId, activeAgents] of activeAgentsByIssueId.entries()) {
    const primaryLeaseId = primaryLeaseIds.get(issueId);
    activeAgentsByIssueId.set(
      issueId,
      activeAgents.map((agent) => ({
        ...agent,
        primaryForIssue: agent.leaseId === primaryLeaseId,
      })),
    );
  }

  return primaryLeaseIds;
}

function indexArtifactIssueIds(
  artifactGroups: OrchestrationInspectorSummary['artifacts']['byKind'],
): Map<string, string> {
  const issueIdsByArtifactId = new Map<string, string>();

  for (const artifact of artifactGroups.flatMap((group) => group.artifacts)) {
    if (artifact.issueId !== null) {
      issueIdsByArtifactId.set(artifact.id, artifact.issueId);
    }
  }

  return issueIdsByArtifactId;
}

function groupArtifactsByIssueId(
  artifactGroups: OrchestrationInspectorSummary['artifacts']['byKind'],
): Map<string, OrchestrationArtifactSummary[]> {
  const groups = new Map<string, OrchestrationArtifactSummary[]>();

  for (const artifact of artifactGroups.flatMap((group) => group.artifacts)) {
    if (artifact.issueId === null) {
      continue;
    }

    const artifacts = groups.get(artifact.issueId) ?? [];
    artifacts.push(artifact);
    groups.set(artifact.issueId, artifacts);
  }

  return groups;
}

function extractHealthFlagIssueIds(
  flag: OrchestrationHealthFlag,
  artifactIssueIdById: Map<string, string>,
): string[] {
  if (flag.kind === 'done_issue_missing_evidence') {
    return [flag.issueId];
  }

  if (flag.kind === 'expired_active_lease') {
    return flag.issueId === null ? [] : [flag.issueId];
  }

  if (flag.kind === 'duplicate_active_worktree_artifact_path') {
    return sortedUnique(
      flag.artifactIds.flatMap((artifactId) => {
        const issueId = artifactIssueIdById.get(artifactId);

        return issueId === undefined ? [] : [issueId];
      }),
    );
  }

  return [];
}

function toLaneId(status: string): OrchestrationDashboardLaneId {
  return CANONICAL_STATUS_LANES.has(status)
    ? (status as OrchestrationDashboardLaneId)
    : 'other';
}

function buildSeverityCounts(flags: readonly OrchestrationHealthFlag[]): {
  high: number;
  medium: number;
  low: number;
} {
  return flags.reduce(
    (counts, flag) => ({
      ...counts,
      [flag.severity]: counts[flag.severity] + 1,
    }),
    { high: 0, medium: 0, low: 0 },
  );
}

function countArtifactsByKind(
  artifacts: readonly OrchestrationArtifactSummary[],
): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const artifact of artifacts) {
    counts[artifact.kind] = (counts[artifact.kind] ?? 0) + 1;
  }

  return sortCountRecord(counts);
}

function sortCountRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function compareIssueCards(
  left: OrchestrationDashboardIssueCard,
  right: OrchestrationDashboardIssueCard,
): number {
  return (
    comparePriority(left.priority, right.priority) ||
    compareNullableIso(left.deadlineAt, right.deadlineAt) ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

function comparePriority(left: string, right: string): number {
  return (
    (PRIORITY_ORDER.get(left) ?? Number.MAX_SAFE_INTEGER) -
    (PRIORITY_ORDER.get(right) ?? Number.MAX_SAFE_INTEGER)
  );
}

function compareNullableIso(left: string | null, right: string | null): number {
  if (left === null && right === null) {
    return 0;
  }

  if (left === null) {
    return 1;
  }

  if (right === null) {
    return -1;
  }

  return left.localeCompare(right);
}

function comparePrimaryLeaseCandidates(
  left: OrchestrationDashboardActiveAgent,
  right: OrchestrationDashboardActiveAgent,
): number {
  return (
    right.acquiredAt.localeCompare(left.acquiredAt) ||
    left.leaseId.localeCompare(right.leaseId)
  );
}

function compareActiveAgents(
  left: OrchestrationDashboardActiveAgent,
  right: OrchestrationDashboardActiveAgent,
): number {
  return (
    (left.issueId ?? '').localeCompare(right.issueId ?? '') ||
    right.acquiredAt.localeCompare(left.acquiredAt) ||
    left.leaseId.localeCompare(right.leaseId)
  );
}

function compareArtifacts(
  left: OrchestrationArtifactSummary,
  right: OrchestrationArtifactSummary,
): number {
  return (
    right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id)
  );
}
