import {
  orchestrationDashboardIssueFilterSignalSchema,
  orchestrationDashboardIssueFilterSignalValues,
  orchestrationDashboardIssueFiltersInputSchema,
  orchestrationDashboardLaneOrder,
  type OrchestrationDashboardIssueCard,
  type OrchestrationDashboardIssueFilterSignal,
  type OrchestrationDashboardIssueFiltersInput,
  type OrchestrationDashboardIssueLane,
  type OrchestrationDashboardLaneId,
  type OrchestrationDashboardOverview,
  type OrchestrationDashboardViewModel,
} from '../contracts/orchestration-dashboard-contracts.js';

export interface OrchestrationDashboardIssueFilters {
  q?: string;
  lane: string[];
  status: string[];
  priority: string[];
  evidenceKind: string[];
  csqr: string[];
  signal?: OrchestrationDashboardIssueFilterSignal;
  hasCsqr: boolean;
}

export type OrchestrationDashboardSearchParams = Record<
  string,
  string | string[] | undefined
>;

const allowedLaneIds = new Set<string>(orchestrationDashboardLaneOrder);
const allowedPriorities = new Set(['critical', 'high', 'medium', 'low']);
const allowedSignals = new Set<OrchestrationDashboardIssueFilterSignal>(
  orchestrationDashboardIssueFilterSignalValues,
);

export const emptyOrchestrationDashboardIssueFilters: OrchestrationDashboardIssueFilters = {
  lane: [],
  status: [],
  priority: [],
  evidenceKind: [],
  csqr: [],
  hasCsqr: false,
};

export function parseOrchestrationDashboardIssueFilters(
  searchParams: OrchestrationDashboardSearchParams,
): OrchestrationDashboardIssueFilters {
  return normalizeOrchestrationDashboardIssueFilters(searchParams);
}

export function normalizeOrchestrationDashboardIssueFilters(
  input:
    | OrchestrationDashboardIssueFiltersInput
    | OrchestrationDashboardSearchParams
    | undefined,
): OrchestrationDashboardIssueFilters {
  const source = input ?? {};
  const q = firstNonEmptyValue(source.q);
  const csqrValues = normalizeList(source.csqr);
  const signal = parseSignal(firstNonEmptyValue(source.signal));
  const hasCsqr =
    readBooleanFlag(source.hasCsqr) ||
    signal === 'csqr' ||
    csqrValues.some((value) => value === 'any' || value === 'true');

  return {
    ...(q === undefined ? {} : { q }),
    lane: filterAllowed(normalizeList(source.lane), allowedLaneIds),
    status: normalizeList(source.status),
    priority: filterAllowed(
      normalizeList(source.priority).map((value) => value.toLowerCase()),
      allowedPriorities,
    ),
    evidenceKind: normalizeList(source.evidenceKind),
    csqr: csqrValues.filter((value) => value !== 'any' && value !== 'true'),
    ...(signal === undefined ? {} : { signal }),
    hasCsqr,
  };
}

export function applyOrchestrationDashboardIssueFilters(
  viewModel: OrchestrationDashboardViewModel,
  filters: OrchestrationDashboardIssueFilters,
): OrchestrationDashboardViewModel {
  if (!hasOrchestrationDashboardIssueFilters(filters)) {
    return viewModel;
  }

  const issueLanes = viewModel.issueLanes.map((lane) => {
    const cards = lane.cards.filter((card) => matchesFilters(card, filters));

    return {
      ...lane,
      count: cards.length,
      cards,
    };
  });
  const filteredCards = issueLanes.flatMap((lane) => lane.cards);

  return {
    ...viewModel,
    overview: buildFilteredOverview(viewModel.overview, issueLanes, filteredCards),
    issueLanes,
  };
}

export function hasOrchestrationDashboardIssueFilters(
  filters: OrchestrationDashboardIssueFilters,
): boolean {
  return Boolean(
    filters.q ||
      filters.lane.length > 0 ||
      filters.status.length > 0 ||
      filters.priority.length > 0 ||
      filters.evidenceKind.length > 0 ||
      filters.csqr.length > 0 ||
      filters.signal ||
      filters.hasCsqr,
  );
}

function matchesFilters(
  card: OrchestrationDashboardIssueCard,
  filters: OrchestrationDashboardIssueFilters,
): boolean {
  if (filters.q !== undefined && !matchesTextSearch(card, filters.q)) {
    return false;
  }

  if (filters.lane.length > 0 && !filters.lane.includes(card.laneId)) {
    return false;
  }

  if (filters.status.length > 0 && !filters.status.includes(card.status)) {
    return false;
  }

  if (filters.priority.length > 0 && !filters.priority.includes(card.priority)) {
    return false;
  }

  if (
    filters.evidenceKind.length > 0 &&
    !filters.evidenceKind.some((kind) => card.artifactKinds[kind] !== undefined)
  ) {
    return false;
  }

  if (filters.hasCsqr && card.csqrLiteScorecardIds.length === 0) {
    return false;
  }

  if (
    filters.csqr.length > 0 &&
    !filters.csqr.some((scorecardId) =>
      card.csqrLiteScorecardIds.includes(scorecardId),
    )
  ) {
    return false;
  }

  if (filters.signal !== undefined && !matchesSignal(card, filters.signal)) {
    return false;
  }

  return true;
}

function matchesTextSearch(
  card: OrchestrationDashboardIssueCard,
  query: string,
): boolean {
  const needle = query.toLowerCase();
  const haystack = [
    card.id,
    card.task,
    card.nextBestAction,
    card.blockedReason,
    card.status,
    card.priority,
    card.size,
    ...card.artifactIds,
    ...Object.keys(card.artifactKinds),
    ...card.worktreePaths,
    ...card.evidencePacketIds,
    ...card.csqrLiteScorecardIds,
    ...card.healthFlags.flatMap((flag) => [flag.kind, flag.message, flag.severity]),
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();

  return haystack.includes(needle);
}

function matchesSignal(
  card: OrchestrationDashboardIssueCard,
  signal: OrchestrationDashboardIssueFilterSignal,
): boolean {
  switch (signal) {
    case 'active':
      return card.activeLeases.length > 0;
    case 'evidence':
      return card.artifactIds.length > 0;
    case 'csqr':
      return card.csqrLiteScorecardIds.length > 0;
    case 'health':
      return card.healthFlags.length > 0;
    case 'blocked':
      return card.blockedReason !== null || card.status === 'blocked';
  }
}

function buildFilteredOverview(
  source: OrchestrationDashboardOverview,
  issueLanes: OrchestrationDashboardIssueLane[],
  cards: OrchestrationDashboardIssueCard[],
): OrchestrationDashboardOverview {
  const laneCounts = Object.fromEntries(
    orchestrationDashboardLaneOrder.map((laneId) => [
      laneId,
      issueLanes.find((lane) => lane.id === laneId)?.count ?? 0,
    ]),
  ) as Record<OrchestrationDashboardLaneId, number>;
  const statusCounts = cards.reduce<Record<string, number>>((counts, card) => {
    counts[card.status] = (counts[card.status] ?? 0) + 1;
    return counts;
  }, {});
  const activeLeaseCount = cards.reduce(
    (count, card) => count + card.activeLeases.length,
    0,
  );
  const expiredLeaseCount = cards.reduce(
    (count, card) =>
      count + card.activeLeases.filter((lease) => lease.expired).length,
    0,
  );

  return {
    ...source,
    totalIssues: cards.length,
    readyCount: laneCounts.ready,
    activeIssueCount: laneCounts.in_progress,
    blockedCount: laneCounts.blocked,
    needsRecoveryCount: laneCounts.needs_recovery,
    doneCount: laneCounts.done,
    failedCount: laneCounts.failed,
    otherCount: laneCounts.other,
    activeLeaseCount,
    expiredLeaseCount,
    evidenceArtifactCount: cards.reduce(
      (count, card) => count + card.artifactIds.length,
      0,
    ),
    statusCounts,
    laneCounts,
  };
}

function normalizeList(value: string | string[] | boolean | undefined): string[] {
  const values = Array.isArray(value) ? value : [value];

  return [
    ...new Set(
      values
        .filter((entry): entry is string => typeof entry === 'string')
        .flatMap((entry) => entry.split(','))
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  ];
}

function filterAllowed(values: string[], allowed: ReadonlySet<string>): string[] {
  return values.filter((value) => allowed.has(value));
}

function firstNonEmptyValue(
  value: string | string[] | boolean | undefined,
): string | undefined {
  return normalizeList(value)[0];
}

function parseSignal(
  value: string | undefined,
): OrchestrationDashboardIssueFilterSignal | undefined {
  if (
    value === undefined ||
    !allowedSignals.has(value as OrchestrationDashboardIssueFilterSignal)
  ) {
    return undefined;
  }

  return value as OrchestrationDashboardIssueFilterSignal;
}

function readBooleanFlag(value: string | string[] | boolean | undefined): boolean {
  if (typeof value === 'boolean') {
    return value;
  }

  return normalizeList(value).some((entry) => entry === 'true' || entry === '1');
}
