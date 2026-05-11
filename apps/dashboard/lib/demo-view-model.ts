import {
  buildOrchestrationDashboardViewModel,
  orchestrationDashboardViewModelSchema,
  type OrchestrationDashboardViewModel,
  type OrchestrationInspectorSummary,
} from 'harness-os/orchestration';

const generatedAt = '2026-05-10T20:00:00.000Z';

const demoSummary = {
  summaryVersion: 1,
  generatedAt,
  scope: {
    projectId: 'harness-os',
    campaignId: 'symphony-dashboard',
    issueId: null,
  },
  issues: {
    total: 7,
    statusCounts: {
      ready: 2,
      in_progress: 1,
      blocked: 1,
      needs_recovery: 1,
      done: 1,
      failed: 1,
    },
    items: [
      {
        id: 'M7-I2',
        projectId: 'harness-os',
        campaignId: 'symphony-dashboard',
        task: 'Implement the Linear-like orchestration dashboard',
        priority: 'critical',
        status: 'in_progress',
        size: 'L',
        nextBestAction: 'Render campaign state, leases, evidence, and CSQR scorecards.',
        blockedReason: null,
        createdAt: '2026-05-10T18:15:00.000Z',
        deadlineAt: '2026-05-11T22:00:00.000Z',
      },
      {
        id: 'M7-I2-A',
        projectId: 'harness-os',
        campaignId: 'symphony-dashboard',
        task: 'Wire dashboard data through the stable view-model boundary',
        priority: 'critical',
        status: 'ready',
        size: 'M',
        nextBestAction: 'Connect the Next.js server page to the orchestration read model.',
        blockedReason: null,
        createdAt: '2026-05-10T18:10:00.000Z',
        deadlineAt: '2026-05-11T14:00:00.000Z',
      },
      {
        id: 'M7-I2-B',
        projectId: 'harness-os',
        campaignId: 'symphony-dashboard',
        task: 'Capture screenshot-backed E2E evidence for the UI flow',
        priority: 'high',
        status: 'ready',
        size: 'M',
        nextBestAction: 'Attach screenshot and E2E report artifacts after build verification.',
        blockedReason: null,
        createdAt: '2026-05-10T18:12:00.000Z',
        deadlineAt: '2026-05-11T18:00:00.000Z',
      },
      {
        id: 'M7-I2-C',
        projectId: 'harness-os',
        campaignId: 'symphony-dashboard',
        task: 'Publish dashboard operator runbook',
        priority: 'medium',
        status: 'blocked',
        size: 'S',
        nextBestAction: 'Unblock after the app scripts stabilize.',
        blockedReason: 'Waiting for final script names and environment contract.',
        createdAt: '2026-05-10T18:20:00.000Z',
        deadlineAt: null,
      },
      {
        id: 'M6-I3',
        projectId: 'harness-os',
        campaignId: 'symphony-dashboard',
        task: 'Enforce CSQR-lite threshold completion gates',
        priority: 'high',
        status: 'done',
        size: 'M',
        nextBestAction: null,
        blockedReason: null,
        createdAt: '2026-05-09T10:00:00.000Z',
        deadlineAt: null,
      },
      {
        id: 'M7-I2-D',
        projectId: 'harness-os',
        campaignId: 'symphony-dashboard',
        task: 'Recover a stale dashboard screenshot worker',
        priority: 'high',
        status: 'needs_recovery',
        size: 'S',
        nextBestAction: 'Run recovery with a clean worktree allocation.',
        blockedReason: 'The previous lease expired before artifact upload.',
        createdAt: '2026-05-10T18:26:00.000Z',
        deadlineAt: null,
      },
      {
        id: 'M7-I2-E',
        projectId: 'harness-os',
        campaignId: 'symphony-dashboard',
        task: 'Discard failed visual experiment with insufficient contrast',
        priority: 'medium',
        status: 'failed',
        size: 'S',
        nextBestAction: 'Keep the accessible contrast baseline and open a fresh experiment.',
        blockedReason: null,
        createdAt: '2026-05-10T18:28:00.000Z',
        deadlineAt: null,
      },
    ],
  },
  leases: {
    activeCount: 2,
    active: [
      {
        id: 'lease-dashboard-primary',
        issueId: 'M7-I2',
        agentId: 'ui-dashboard-agent',
        status: 'active',
        acquiredAt: '2026-05-10T19:30:00.000Z',
        expiresAt: '2026-05-10T21:30:00.000Z',
        lastHeartbeatAt: '2026-05-10T19:58:00.000Z',
        releasedAt: null,
        expired: false,
      },
      {
        id: 'lease-screenshot-recovery',
        issueId: 'M7-I2-D',
        agentId: 'e2e-evidence-agent',
        status: 'active',
        acquiredAt: '2026-05-10T17:20:00.000Z',
        expiresAt: '2026-05-10T18:20:00.000Z',
        lastHeartbeatAt: '2026-05-10T18:05:00.000Z',
        releasedAt: null,
        expired: true,
      },
    ],
  },
  artifacts: {
    total: 8,
    byKind: [
      {
        kind: 'orchestration_worktree',
        count: 3,
        artifacts: [
          {
            id: 'artifact-worktree-dashboard',
            kind: 'orchestration_worktree',
            path: '/worktrees/M7-I2-dashboard',
            issueId: 'M7-I2',
            campaignId: 'symphony-dashboard',
            createdAt: '2026-05-10T19:31:00.000Z',
            metadata: {
              source: 'session_orchestrator',
              status: 'active',
            },
            references: {
              worktreeId: 'worktree-dashboard',
              worktreePath: '/worktrees/M7-I2-dashboard',
              subagentId: 'ui-dashboard-agent',
            },
          },
          {
            id: 'artifact-worktree-duplicate-a',
            kind: 'orchestration_worktree',
            path: '/worktrees/M7-I2-screenshot',
            issueId: 'M7-I2-B',
            campaignId: 'symphony-dashboard',
            createdAt: '2026-05-10T19:33:00.000Z',
            metadata: {
              source: 'session_orchestrator',
              status: 'active',
            },
            references: {
              worktreeId: 'worktree-screenshot-a',
              worktreePath: '/worktrees/M7-I2-screenshot',
              subagentId: 'e2e-evidence-agent',
            },
          },
          {
            id: 'artifact-worktree-duplicate-b',
            kind: 'orchestration_worktree',
            path: '/worktrees/M7-I2-screenshot',
            issueId: 'M7-I2-D',
            campaignId: 'symphony-dashboard',
            createdAt: '2026-05-10T19:35:00.000Z',
            metadata: {
              source: 'session_orchestrator',
              status: 'active',
            },
            references: {
              worktreeId: 'worktree-screenshot-b',
              worktreePath: '/worktrees/M7-I2-screenshot',
              subagentId: 'e2e-evidence-agent',
            },
          },
        ],
      },
      {
        kind: 'test_report',
        count: 1,
        artifacts: [
          {
            id: 'artifact-test-report-dashboard',
            kind: 'test_report',
            path: 'artifacts/M7-I2/test-report.json',
            issueId: 'M7-I2',
            campaignId: 'symphony-dashboard',
            createdAt: '2026-05-10T19:42:00.000Z',
            metadata: {
              status: 'passed',
              testCount: '233',
            },
            references: {
              evidencePacketId: 'packet-dashboard',
              subagentId: 'ui-dashboard-agent',
            },
          },
        ],
      },
      {
        kind: 'e2e_report',
        count: 1,
        artifacts: [
          {
            id: 'artifact-e2e-dashboard',
            kind: 'e2e_report',
            path: 'artifacts/M7-I2/e2e-report.json',
            issueId: 'M7-I2-B',
            campaignId: 'symphony-dashboard',
            createdAt: '2026-05-10T19:44:00.000Z',
            metadata: {
              status: 'pending',
              flow: 'dashboard-smoke',
            },
            references: {
              evidencePacketId: 'packet-dashboard',
              subagentId: 'e2e-evidence-agent',
            },
          },
        ],
      },
      {
        kind: 'screenshot',
        count: 1,
        artifacts: [
          {
            id: 'artifact-screenshot-dashboard',
            kind: 'screenshot',
            path: 'artifacts/M7-I2/dashboard-home.png',
            issueId: 'M7-I2-B',
            campaignId: 'symphony-dashboard',
            createdAt: '2026-05-10T19:45:00.000Z',
            metadata: {
              viewport: '1440x1200',
            },
            references: {
              evidencePacketId: 'packet-dashboard',
              subagentId: 'e2e-evidence-agent',
            },
          },
        ],
      },
      {
        kind: 'csqr_lite_scorecard',
        count: 1,
        artifacts: [
          {
            id: 'artifact-csqr-m6-i3',
            kind: 'csqr_lite_scorecard',
            path: 'artifacts/M6-I3/csqr-lite-scorecard.json',
            issueId: 'M6-I3',
            campaignId: 'symphony-dashboard',
            createdAt: '2026-05-10T16:45:00.000Z',
            metadata: {
              score: '9.4',
              status: 'passed',
            },
            references: {
              csqrLiteScorecardId: 'scorecard-m6-i3',
              evidencePacketId: 'packet-m6-i3',
              subagentId: 'quality-gate-agent',
            },
          },
        ],
      },
      {
        kind: 'state_export',
        count: 1,
        artifacts: [
          {
            id: 'artifact-orphan-state-export',
            kind: 'state_export',
            path: 'artifacts/campaign/state-export.json',
            issueId: null,
            campaignId: 'symphony-dashboard',
            createdAt: '2026-05-10T19:50:00.000Z',
            metadata: {
              scope: 'campaign',
            },
            references: {
              evidencePacketId: 'packet-dashboard',
            },
          },
        ],
      },
    ],
    references: {
      worktreeIds: ['worktree-dashboard', 'worktree-screenshot-a', 'worktree-screenshot-b'],
      worktreePaths: ['/worktrees/M7-I2-dashboard', '/worktrees/M7-I2-screenshot'],
      subagentIds: ['e2e-evidence-agent', 'quality-gate-agent', 'ui-dashboard-agent'],
      evidencePacketIds: ['packet-dashboard', 'packet-m6-i3'],
      csqrLiteScorecardIds: ['scorecard-m6-i3'],
    },
  },
  events: {
    recentCount: 3,
    recent: [
      {
        id: 'event-dashboard-dispatched',
        issueId: 'M7-I2',
        runId: 'run-dashboard-001',
        kind: 'orchestration_assignment_dispatched',
        payload: {
          agentId: 'ui-dashboard-agent',
          worktreePath: '/worktrees/M7-I2-dashboard',
        },
        createdAt: '2026-05-10T19:31:00.000Z',
      },
      {
        id: 'event-dashboard-evidence',
        issueId: 'M7-I2-B',
        runId: 'run-dashboard-001',
        kind: 'orchestration_evidence_registered',
        payload: {
          artifactKinds: ['e2e_report', 'screenshot'],
        },
        createdAt: '2026-05-10T19:45:00.000Z',
      },
      {
        id: 'event-dashboard-recovery',
        issueId: 'M7-I2-D',
        runId: 'run-dashboard-001',
        kind: 'orchestration_recovery_requested',
        payload: {
          reason: 'expired_active_lease',
        },
        createdAt: '2026-05-10T19:48:00.000Z',
      },
    ],
  },
  health: {
    status: 'warning',
    flags: [
      {
        kind: 'expired_active_lease',
        severity: 'high',
        leaseId: 'lease-screenshot-recovery',
        issueId: 'M7-I2-D',
        expiresAt: '2026-05-10T18:20:00.000Z',
        message: 'The screenshot evidence worker lease expired before completion.',
      },
      {
        kind: 'duplicate_active_worktree_artifact_path',
        severity: 'high',
        path: '/worktrees/M7-I2-screenshot',
        artifactIds: ['artifact-worktree-duplicate-a', 'artifact-worktree-duplicate-b'],
        message: 'Two active worktree artifacts point at the same screenshot workspace.',
      },
      {
        kind: 'done_issue_missing_evidence',
        severity: 'medium',
        issueId: 'M6-I3',
        message: 'A completed issue is missing a screenshot artifact for dashboard replay.',
      },
    ],
  },
} satisfies OrchestrationInspectorSummary;

export const demoDashboardViewModel: OrchestrationDashboardViewModel =
  orchestrationDashboardViewModelSchema.parse(
    buildOrchestrationDashboardViewModel(demoSummary),
  );
