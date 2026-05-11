import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOrchestrationDashboardViewModel,
  loadOrchestrationDashboardViewModel,
} from '../runtime/orchestration-dashboard.js';
import {
  applyOrchestrationDashboardIssueFilters,
  normalizeOrchestrationDashboardIssueFilters,
  parseOrchestrationDashboardIssueFilters,
} from '../runtime/orchestration-dashboard-filters.js';
import {
  orchestrationDashboardLaneOrder,
  orchestrationDashboardViewModelSchema,
} from '../contracts/orchestration-dashboard-contracts.js';
import type { OrchestrationInspectorSummary } from '../runtime/orchestration-inspector.js';

const generatedAt = '2026-05-10T20:00:00.000Z';

test('dashboard view model exposes stable empty-state lanes and summaries', () => {
  const viewModel = buildOrchestrationDashboardViewModel(createEmptySummary());

  assert.equal(viewModel.contractVersion, '1.0.0');
  assert.equal(viewModel.generatedAt, generatedAt);
  assert.deepEqual(
    viewModel.issueLanes.map((lane) => lane.id),
    orchestrationDashboardLaneOrder,
  );
  assert.equal(viewModel.issueLanes.every((lane) => lane.count === 0), true);
  assert.equal(viewModel.overview.totalIssues, 0);
  assert.deepEqual(viewModel.activeAgents, []);
  assert.deepEqual(viewModel.recentTimeline, []);
  assert.deepEqual(viewModel.health.globalFlags, []);
  assert.deepEqual(orchestrationDashboardViewModelSchema.parse(viewModel), viewModel);
});

test('dashboard view model enriches issue lanes with leases, evidence, and scoped health', () => {
  const viewModel = buildOrchestrationDashboardViewModel(createPopulatedSummary());
  const readyLane = viewModel.issueLanes.find((lane) => lane.id === 'ready');
  const inProgressLane = viewModel.issueLanes.find(
    (lane) => lane.id === 'in_progress',
  );
  const doneLane = viewModel.issueLanes.find((lane) => lane.id === 'done');
  const otherLane = viewModel.issueLanes.find((lane) => lane.id === 'other');
  const progressCard = inProgressLane?.cards[0];
  const doneCard = doneLane?.cards[0];

  assert.deepEqual(
    readyLane?.cards.map((card) => card.id),
    ['issue-ready-critical', 'issue-ready-high'],
  );
  assert.equal(viewModel.overview.totalIssues, 5);
  assert.equal(viewModel.overview.readyCount, 2);
  assert.equal(viewModel.overview.activeIssueCount, 1);
  assert.equal(viewModel.overview.doneCount, 1);
  assert.equal(viewModel.overview.otherCount, 1);
  assert.equal(viewModel.overview.expiredLeaseCount, 1);
  assert.deepEqual(otherLane?.cards.map((card) => card.id), ['issue-cancelled']);

  assert.ok(progressCard);
  assert.equal(progressCard.primaryLeaseId, 'lease-progress-new');
  assert.deepEqual(
    progressCard.activeLeases.map((lease) => [
      lease.leaseId,
      lease.primaryForIssue,
    ]),
    [
      ['lease-progress-new', true],
      ['lease-progress-old', false],
    ],
  );
  assert.deepEqual(progressCard.artifactKinds, {
    evidence_packet: 1,
    orchestration_worktree: 1,
  });
  assert.deepEqual(progressCard.worktreePaths, ['worktrees/issue-progress']);
  assert.deepEqual(progressCard.evidencePacketIds, ['packet-progress']);
  assert.deepEqual(
    progressCard.healthFlags.map((flag) => flag.kind),
    ['expired_active_lease', 'duplicate_active_worktree_artifact_path'],
  );

  assert.ok(doneCard);
  assert.deepEqual(doneCard.csqrLiteScorecardIds, ['scorecard-done']);
  assert.deepEqual(
    doneCard.healthFlags.map((flag) => flag.kind),
    ['done_issue_missing_evidence'],
  );
  assert.deepEqual(
    viewModel.health.globalFlags.map((flag) => flag.kind),
    [],
  );
  assert.deepEqual(viewModel.health.severityCounts, {
    high: 2,
    medium: 1,
    low: 0,
  });
  assert.equal(viewModel.evidence.totalArtifacts, 4);
  assert.equal(viewModel.evidence.orphanArtifactCount, 1);
  assert.equal(viewModel.evidence.worktreePathCount, 1);
  assert.equal(viewModel.evidence.evidencePacketCount, 1);
  assert.equal(viewModel.evidence.csqrLiteScorecardCount, 1);
  assert.deepEqual(viewModel.recentTimeline.map((event) => event.id), [
    'event-progress',
  ]);
});

test('dashboard loader delegates to an injected inspector for testable API boundaries', () => {
  const viewModel = loadOrchestrationDashboardViewModel(
    {
      dbPath: '/tmp/unused.sqlite',
      projectId: 'project-1',
      campaignId: 'campaign-a',
      eventLimit: 10,
    },
    {
      inspector(input) {
        assert.equal(input.projectId, 'project-1');
        assert.equal(input.campaignId, 'campaign-a');
        assert.equal(input.eventLimit, 10);
        return createEmptySummary();
      },
    },
  );

  assert.equal(viewModel.scope.projectId, 'project-1');
});

test('dashboard schema enforces complete ordered v1 lane coverage', () => {
  const viewModel = buildOrchestrationDashboardViewModel(createEmptySummary());

  assert.equal(
    orchestrationDashboardViewModelSchema.safeParse({
      ...viewModel,
      issueLanes: [],
    }).success,
    false,
  );

  const mismatchedCount = structuredClone(viewModel);
  mismatchedCount.issueLanes[0]!.count = 1;
  assert.equal(
    orchestrationDashboardViewModelSchema.safeParse(mismatchedCount).success,
    false,
  );

  const mismatchedCardLane = buildOrchestrationDashboardViewModel(
    createPopulatedSummary(),
  );
  const readyCard = mismatchedCardLane.issueLanes
    .find((lane) => lane.id === 'ready')
    ?.cards.at(0);
  assert.ok(readyCard);
  readyCard.laneId = 'done';
  assert.equal(
    orchestrationDashboardViewModelSchema.safeParse(mismatchedCardLane).success,
    false,
  );
});

test('dashboard builder rejects unsupported inspector summary versions', () => {
  assert.throws(
    () =>
      buildOrchestrationDashboardViewModel({
        ...createEmptySummary(),
        summaryVersion: 2,
      } as unknown as OrchestrationInspectorSummary),
    /Unsupported orchestration inspector summaryVersion/,
  );
});

test('dashboard filters preserve lane order and recompute overview semantics', () => {
  const viewModel = buildOrchestrationDashboardViewModel(createPopulatedSummary());
  const filtered = applyOrchestrationDashboardIssueFilters(
    viewModel,
    normalizeOrchestrationDashboardIssueFilters({
      evidenceKind: ['evidence_packet'],
      signal: 'active',
    }),
  );

  assert.deepEqual(
    filtered.issueLanes.map((lane) => lane.id),
    orchestrationDashboardLaneOrder,
  );
  assert.deepEqual(cardIds(filtered), ['issue-progress']);
  assert.equal(filtered.overview.totalIssues, 1);
  assert.equal(filtered.overview.readyCount, 0);
  assert.equal(filtered.overview.activeIssueCount, 1);
  assert.equal(filtered.overview.laneCounts.in_progress, 1);
  assert.equal(filtered.overview.activeLeaseCount, 2);
  assert.equal(filtered.overview.expiredLeaseCount, 1);
  assert.equal(filtered.overview.evidenceArtifactCount, 2);
  assert.deepEqual(orchestrationDashboardViewModelSchema.parse(filtered), filtered);
});

test('dashboard filters match text, issue state, CSQR, and health signals', () => {
  const viewModel = buildOrchestrationDashboardViewModel(createPopulatedSummary());

  assert.deepEqual(
    cardIds(
      applyOrchestrationDashboardIssueFilters(
        viewModel,
        normalizeOrchestrationDashboardIssueFilters({ q: 'scorecard' }),
      ),
    ),
    ['issue-done'],
  );
  assert.deepEqual(
    cardIds(
      applyOrchestrationDashboardIssueFilters(
        viewModel,
        normalizeOrchestrationDashboardIssueFilters({
          lane: 'ready',
          status: ['ready'],
          priority: ['critical'],
        }),
      ),
    ),
    ['issue-ready-critical'],
  );
  assert.deepEqual(
    cardIds(
      applyOrchestrationDashboardIssueFilters(
        viewModel,
        normalizeOrchestrationDashboardIssueFilters({ csqr: 'any' }),
      ),
    ),
    ['issue-done'],
  );
  assert.deepEqual(
    cardIds(
      applyOrchestrationDashboardIssueFilters(
        viewModel,
        normalizeOrchestrationDashboardIssueFilters({ signal: 'health' }),
      ),
    ),
    ['issue-progress', 'issue-done'],
  );
});

test('dashboard filter parser normalizes URL-like inputs without widening contracts', () => {
  assert.deepEqual(
    parseOrchestrationDashboardIssueFilters({
      q: '  dashboard  ',
      lane: ['ready', 'unsupported'],
      status: 'ready,done',
      priority: ['HIGH', 'invalid'],
      evidenceKind: 'screenshot,csqr_lite_scorecard',
      csqr: 'any',
      signal: 'csqr',
    }),
    {
      q: 'dashboard',
      lane: ['ready'],
      status: ['ready', 'done'],
      priority: ['high'],
      evidenceKind: ['screenshot', 'csqr_lite_scorecard'],
      csqr: [],
      signal: 'csqr',
      hasCsqr: true,
    },
  );
});

function createEmptySummary(): OrchestrationInspectorSummary {
  return {
    summaryVersion: 1,
    generatedAt,
    scope: {
      projectId: 'project-1',
      campaignId: null,
      issueId: null,
    },
    issues: {
      total: 0,
      statusCounts: {},
      items: [],
    },
    leases: {
      activeCount: 0,
      active: [],
    },
    artifacts: {
      total: 0,
      byKind: [],
      references: {
        worktreeIds: [],
        worktreePaths: [],
        subagentIds: [],
        evidencePacketIds: [],
        csqrLiteScorecardIds: [],
      },
    },
    events: {
      recentCount: 0,
      recent: [],
    },
    health: {
      status: 'healthy',
      flags: [],
    },
  };
}

function cardIds(viewModel: ReturnType<typeof buildOrchestrationDashboardViewModel>): string[] {
  return viewModel.issueLanes.flatMap((lane) => lane.cards.map((card) => card.id));
}

function createPopulatedSummary(): OrchestrationInspectorSummary {
  return {
    ...createEmptySummary(),
    issues: {
      total: 5,
      statusCounts: {
        cancelled: 1,
        done: 1,
        in_progress: 1,
        ready: 2,
      },
      items: [
        {
          id: 'issue-ready-high',
          projectId: 'project-1',
          campaignId: 'campaign-a',
          task: 'Implement evidence card filters',
          priority: 'high',
          status: 'ready',
          size: 'M',
          nextBestAction: 'Dispatch to a UI boundary agent.',
          blockedReason: null,
          createdAt: '2026-05-10T20:03:00.000Z',
          deadlineAt: '2026-05-11T20:00:00.000Z',
        },
        {
          id: 'issue-ready-critical',
          projectId: 'project-1',
          campaignId: 'campaign-a',
          task: 'Stabilize dashboard contracts',
          priority: 'critical',
          status: 'ready',
          size: 'S',
          nextBestAction: 'Lock the public view model.',
          blockedReason: null,
          createdAt: '2026-05-10T20:04:00.000Z',
          deadlineAt: null,
        },
        {
          id: 'issue-progress',
          projectId: 'project-1',
          campaignId: 'campaign-a',
          task: 'Render orchestration lane cards',
          priority: 'medium',
          status: 'in_progress',
          size: 'M',
          nextBestAction: 'Continue under the active leases.',
          blockedReason: null,
          createdAt: '2026-05-10T20:01:00.000Z',
          deadlineAt: null,
        },
        {
          id: 'issue-done',
          projectId: 'project-1',
          campaignId: 'campaign-a',
          task: 'Persist scorecard evidence',
          priority: 'low',
          status: 'done',
          size: 'M',
          nextBestAction: 'Archive evidence.',
          blockedReason: null,
          createdAt: '2026-05-10T20:02:00.000Z',
          deadlineAt: null,
        },
        {
          id: 'issue-cancelled',
          projectId: 'project-1',
          campaignId: 'campaign-a',
          task: 'Handle a future status without dropping cards',
          priority: 'medium',
          status: 'cancelled',
          size: 'M',
          nextBestAction: null,
          blockedReason: null,
          createdAt: '2026-05-10T20:05:00.000Z',
          deadlineAt: null,
        },
      ],
    },
    leases: {
      activeCount: 3,
      active: [
        {
          id: 'lease-progress-old',
          issueId: 'issue-progress',
          agentId: 'agent-a',
          status: 'active',
          acquiredAt: '2026-05-10T19:00:00.000Z',
          expiresAt: '2026-05-10T19:30:00.000Z',
          lastHeartbeatAt: null,
          releasedAt: null,
          expired: true,
        },
        {
          id: 'lease-progress-new',
          issueId: 'issue-progress',
          agentId: 'agent-b',
          status: 'active',
          acquiredAt: '2026-05-10T20:00:00.000Z',
          expiresAt: '2026-05-10T21:00:00.000Z',
          lastHeartbeatAt: '2026-05-10T20:15:00.000Z',
          releasedAt: null,
          expired: false,
        },
        {
          id: 'lease-global',
          issueId: null,
          agentId: 'agent-global',
          status: 'active',
          acquiredAt: '2026-05-10T20:10:00.000Z',
          expiresAt: '2026-05-10T21:10:00.000Z',
          lastHeartbeatAt: null,
          releasedAt: null,
          expired: false,
        },
      ],
    },
    artifacts: {
      total: 4,
      byKind: [
        {
          kind: 'csqr_lite_scorecard',
          count: 1,
          artifacts: [
            {
              id: 'artifact-scorecard-done',
              kind: 'csqr_lite_scorecard',
              path: 'evidence/scorecard-done.json',
              issueId: 'issue-done',
              campaignId: 'campaign-a',
              createdAt: '2026-05-10T20:04:00.000Z',
              metadata: { csqrLiteScorecardId: 'scorecard-done' },
              references: { csqrLiteScorecardId: 'scorecard-done' },
            },
          ],
        },
        {
          kind: 'evidence_packet',
          count: 1,
          artifacts: [
            {
              id: 'artifact-evidence-progress',
              kind: 'evidence_packet',
              path: 'evidence/packet-progress.json',
              issueId: 'issue-progress',
              campaignId: 'campaign-a',
              createdAt: '2026-05-10T20:03:00.000Z',
              metadata: { evidencePacketId: 'packet-progress' },
              references: { evidencePacketId: 'packet-progress' },
            },
          ],
        },
        {
          kind: 'orchestration_worktree',
          count: 1,
          artifacts: [
            {
              id: 'artifact-worktree-progress',
              kind: 'orchestration_worktree',
              path: 'worktrees/issue-progress',
              issueId: 'issue-progress',
              campaignId: 'campaign-a',
              createdAt: '2026-05-10T20:02:00.000Z',
              metadata: { worktreePath: 'worktrees/issue-progress' },
              references: { worktreePath: 'worktrees/issue-progress' },
            },
          ],
        },
        {
          kind: 'state_export',
          count: 1,
          artifacts: [
            {
              id: 'artifact-orphan-state',
              kind: 'state_export',
              path: 'evidence/orphan-state.json',
              issueId: null,
              campaignId: 'campaign-a',
              createdAt: '2026-05-10T20:01:00.000Z',
              metadata: {},
              references: {},
            },
          ],
        },
      ],
      references: {
        worktreeIds: [],
        worktreePaths: ['worktrees/issue-progress'],
        subagentIds: [],
        evidencePacketIds: ['packet-progress'],
        csqrLiteScorecardIds: ['scorecard-done'],
      },
    },
    events: {
      recentCount: 1,
      recent: [
        {
          id: 'event-progress',
          issueId: 'issue-progress',
          runId: 'run-progress',
          kind: 'orchestration_status',
          payload: { phase: 'running' },
          createdAt: '2026-05-10T20:05:00.000Z',
        },
      ],
    },
    health: {
      status: 'warning',
      flags: [
        {
          kind: 'expired_active_lease',
          severity: 'high',
          leaseId: 'lease-progress-old',
          issueId: 'issue-progress',
          expiresAt: '2026-05-10T19:30:00.000Z',
          message: 'Active lease lease-progress-old expired.',
        },
        {
          kind: 'done_issue_missing_evidence',
          severity: 'medium',
          issueId: 'issue-done',
          message: 'Done issue issue-done has no registered evidence.',
        },
        {
          kind: 'duplicate_active_worktree_artifact_path',
          severity: 'high',
          path: 'worktrees/issue-progress',
          artifactIds: [
            'artifact-worktree-progress',
            'artifact-evidence-progress',
          ],
          message: 'Multiple active worktree artifacts share a path.',
        },
      ],
    },
  };
}
