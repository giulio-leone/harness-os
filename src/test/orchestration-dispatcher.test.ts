import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import type { OrchestrationSubagent } from '../contracts/orchestration-contracts.js';
import { orchestrationPlanSchema } from '../contracts/orchestration-contracts.js';
import {
  openHarnessDatabase,
  runStatement,
  selectAll,
  selectOne,
} from '../db/store.js';
import {
  encodeCandidateFilesArtifactPath,
  encodeWorktreeBranchArtifactPath,
} from '../runtime/orchestration-conflicts.js';
import { dispatchReadyOrchestrationIssues } from '../runtime/orchestration-dispatcher.js';

let tempCounter = 0;

const repoRoot = '/workspace/harness-os';
const worktreeRoot = '/workspace/worktrees';
const hostCapabilities = {
  workloadClasses: ['default', 'typescript'],
  capabilities: ['node', 'sqlite'],
};

test('orchestration dispatcher claims ready issues through session lifecycle APIs', async () => {
  const tempDir = createLocalTempDir('dispatch-ready');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    seedIssue(dbPath, {
      issueId: 'issue-critical',
      status: 'ready',
      priority: 'critical',
    });
    seedIssue(dbPath, {
      issueId: 'issue-high',
      status: 'ready',
      priority: 'high',
    });
    seedIssue(dbPath, {
      issueId: 'issue-medium',
      status: 'ready',
      priority: 'medium',
    });

    const result = await dispatchReadyOrchestrationIssues({
      ...baseDispatchInput(dbPath),
      dispatchId: 'dispatch-test',
      maxAssignments: 2,
      maxConcurrentAgents: 2,
      subagents: [
        createSubagent('agent-a', ['implementation']),
        createSubagent('agent-b', ['implementation']),
      ],
    });

    assert.equal(result.status, 'dispatched');
    assert.equal(result.dispatches.length, 2);
    assert.deepEqual(
      result.dispatches.map((dispatch) => dispatch.issue.id),
      ['issue-critical', 'issue-high'],
    );
    assert.deepEqual(
      result.dispatches.map((dispatch) => dispatch.subagent.id),
      ['agent-a', 'agent-b'],
    );
    assert.equal(orchestrationPlanSchema.safeParse(result.plan).success, true);
    assert.equal(result.plan?.dispatch.strategy, 'fanout');
    assert.equal(result.plan?.dispatch.assignments.length, 2);
    assert.deepEqual(
      result.plan?.worktrees.map((worktree) => worktree.path),
      [
        '/workspace/worktrees/issue-critical',
        '/workspace/worktrees/issue-high',
      ],
    );
    assert.ok(
      result.dispatches.every(
        (dispatch) =>
          dispatch.session.claimMode === 'claim' &&
          dispatch.session.agentId === dispatch.subagent.id,
      ),
    );

    assert.deepEqual(readIssueStatuses(dbPath), {
      'issue-critical': 'in_progress',
      'issue-high': 'in_progress',
      'issue-medium': 'ready',
    });
    assert.deepEqual(readActiveLeases(dbPath), [
      ['agent-a', 'issue-critical'],
      ['agent-b', 'issue-high'],
    ]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('orchestration dispatcher never bypasses pending dependency gates', async () => {
  const tempDir = createLocalTempDir('pending-gate');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    seedIssue(dbPath, {
      issueId: 'issue-dependent',
      status: 'pending',
      priority: 'critical',
      dependsOn: ['missing-upstream'],
    });

    const result = await dispatchReadyOrchestrationIssues({
      ...baseDispatchInput(dbPath),
      dispatchId: 'dispatch-pending-gate',
      subagents: [createSubagent('agent-a', ['implementation'])],
    });
    const dependent = selectIssue(dbPath, 'issue-dependent');

    assert.equal(result.status, 'idle');
    assert.equal(result.dispatches.length, 0);
    assert.equal(dependent?.status, 'pending');
    assert.equal(dependent?.blocked_reason, 'issue_dependency:missing-upstream');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('orchestration dispatcher respects active subagent lease capacity', async () => {
  const tempDir = createLocalTempDir('capacity');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    seedIssue(dbPath, {
      issueId: 'issue-active',
      status: 'in_progress',
      priority: 'critical',
    });
    seedIssue(dbPath, {
      issueId: 'issue-ready',
      status: 'ready',
      priority: 'critical',
    });
    seedLease(dbPath, {
      leaseId: 'lease-active',
      issueId: 'issue-active',
      agentId: 'agent-a',
      expiresAt: '2999-01-01T00:00:00.000Z',
    });

    const result = await dispatchReadyOrchestrationIssues({
      ...baseDispatchInput(dbPath),
      dispatchId: 'dispatch-capacity',
      subagents: [createSubagent('agent-a', ['implementation'])],
    });

    assert.equal(result.status, 'idle');
    assert.equal(result.dispatches.length, 0);
    assert.deepEqual(result.unassignedIssues, [
      {
        issueId: 'issue-ready',
        reason: 'subagent_capacity_exhausted',
        requiredCapabilityIds: [],
        message: 'All compatible subagents are at their active lease capacity.',
      },
    ]);
    assert.equal(selectIssue(dbPath, 'issue-ready')?.status, 'ready');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('orchestration dispatcher enforces subagent capacity during concurrent claims', async () => {
  const tempDir = createLocalTempDir('concurrent-capacity');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    seedIssue(dbPath, {
      issueId: 'issue-one',
      status: 'ready',
      priority: 'critical',
    });
    seedIssue(dbPath, {
      issueId: 'issue-two',
      status: 'ready',
      priority: 'critical',
    });

    const subagents = [createSubagent('agent-a', ['implementation'])];
    const [first, second] = await Promise.all([
      dispatchReadyOrchestrationIssues({
        ...baseDispatchInput(dbPath),
        dispatchId: 'dispatch-concurrent-a',
        subagents,
      }),
      dispatchReadyOrchestrationIssues({
        ...baseDispatchInput(dbPath),
        dispatchId: 'dispatch-concurrent-b',
        subagents,
      }),
    ]);
    const results = [first, second];
    const totalDispatches = results.reduce(
      (sum, result) => sum + result.dispatches.length,
      0,
    );
    const totalNonDispatched = results.reduce(
      (sum, result) =>
        sum + result.failures.length + result.unassignedIssues.length,
      0,
    );

    assert.equal(totalDispatches, 1);
    assert.ok(totalNonDispatched >= 1);
    assert.deepEqual(readActiveLeases(dbPath), [['agent-a', 'issue-one']]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('orchestration dispatcher enforces subagent capacity across campaigns', async () => {
  const tempDir = createLocalTempDir('cross-campaign-capacity');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    seedCampaign(dbPath, 'campaign-a');
    seedCampaign(dbPath, 'campaign-b');
    seedIssue(dbPath, {
      issueId: 'issue-campaign-a',
      status: 'ready',
      priority: 'critical',
      campaignId: 'campaign-a',
    });
    seedIssue(dbPath, {
      issueId: 'issue-campaign-b',
      status: 'ready',
      priority: 'critical',
      campaignId: 'campaign-b',
    });

    const subagents = [createSubagent('agent-a', ['implementation'])];
    const [first, second] = await Promise.all([
      dispatchReadyOrchestrationIssues({
        ...baseDispatchInput(dbPath),
        campaignId: 'campaign-a',
        dispatchId: 'dispatch-campaign-a',
        subagents,
      }),
      dispatchReadyOrchestrationIssues({
        ...baseDispatchInput(dbPath),
        campaignId: 'campaign-b',
        dispatchId: 'dispatch-campaign-b',
        subagents,
      }),
    ]);
    const totalDispatches = [first, second].reduce(
      (sum, result) => sum + result.dispatches.length,
      0,
    );

    assert.equal(totalDispatches, 1);
    assert.equal(readActiveLeases(dbPath).length, 1);
    assert.equal(readActiveLeases(dbPath)[0]?.[0], 'agent-a');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('orchestration dispatcher reports incompatible issue capability requirements', async () => {
  const tempDir = createLocalTempDir('capabilities');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    seedIssue(dbPath, {
      issueId: 'issue-test',
      status: 'ready',
      priority: 'critical',
    });

    const result = await dispatchReadyOrchestrationIssues({
      ...baseDispatchInput(dbPath),
      dispatchId: 'dispatch-capability',
      subagents: [createSubagent('agent-a', ['implementation'])],
      issueRequirements: [
        {
          issueId: 'issue-test',
          requiredCapabilityIds: ['e2e.testing'],
        },
      ],
    });

    assert.equal(result.status, 'idle');
    assert.equal(result.dispatches.length, 0);
    assert.equal(result.unassignedIssues[0]?.reason, 'no_compatible_subagent');
    assert.equal(selectIssue(dbPath, 'issue-test')?.status, 'ready');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('orchestration dispatcher blocks active worktree path conflicts before claim', async () => {
  const tempDir = createLocalTempDir('worktree-path-conflict');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    seedIssue(dbPath, {
      issueId: 'issue-conflict',
      status: 'ready',
      priority: 'critical',
    });
    seedActiveRunArtifacts(dbPath, {
      runId: 'run-active-worktree',
      artifacts: [
        {
          kind: 'orchestration_worktree',
          path: '/workspace/worktrees/issue-conflict',
        },
      ],
    });

    const result = await dispatchReadyOrchestrationIssues({
      ...baseDispatchInput(dbPath),
      dispatchId: 'dispatch-path-conflict',
      subagents: [createSubagent('agent-a', ['implementation'])],
    });

    assert.equal(result.status, 'idle');
    assert.equal(result.dispatches.length, 0);
    assert.equal(result.unassignedIssues[0]?.reason, 'worktree_path_conflict');
    assert.equal(selectIssue(dbPath, 'issue-conflict')?.status, 'ready');
    assert.deepEqual(readActiveLeases(dbPath), []);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('orchestration dispatcher blocks active worktree branch conflicts before claim', async () => {
  const tempDir = createLocalTempDir('worktree-branch-conflict');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    seedIssue(dbPath, {
      issueId: 'issue-branch',
      status: 'ready',
      priority: 'critical',
    });
    seedActiveRunArtifacts(dbPath, {
      runId: 'run-active-branch',
      artifacts: [
        {
          kind: 'orchestration_worktree_branch',
          path: encodeWorktreeBranchArtifactPath(
            'orchestration/dispatch-branch/issue-branch',
          ),
        },
      ],
    });

    const result = await dispatchReadyOrchestrationIssues({
      ...baseDispatchInput(dbPath),
      dispatchId: 'dispatch-branch',
      worktreeRoot: '/workspace/alternate-worktrees',
      subagents: [createSubagent('agent-a', ['implementation'])],
    });

    assert.equal(result.status, 'idle');
    assert.equal(result.dispatches.length, 0);
    assert.equal(result.unassignedIssues[0]?.reason, 'worktree_branch_conflict');
    assert.equal(selectIssue(dbPath, 'issue-branch')?.status, 'ready');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('orchestration dispatcher blocks overlapping candidate files in one dispatch', async () => {
  const tempDir = createLocalTempDir('candidate-overlap');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    seedIssue(dbPath, {
      issueId: 'issue-api',
      status: 'ready',
      priority: 'critical',
    });
    seedIssue(dbPath, {
      issueId: 'issue-api-user',
      status: 'ready',
      priority: 'critical',
    });

    const result = await dispatchReadyOrchestrationIssues({
      ...baseDispatchInput(dbPath),
      dispatchId: 'dispatch-candidate-overlap',
      maxAssignments: 2,
      maxConcurrentAgents: 2,
      subagents: [
        createSubagent('agent-a', ['implementation']),
        createSubagent('agent-b', ['implementation']),
      ],
      issueRequirements: [
        {
          issueId: 'issue-api',
          candidateFilePaths: ['src/api'],
        },
        {
          issueId: 'issue-api-user',
          candidateFilePaths: ['src/api/user.ts'],
        },
      ],
    });

    assert.equal(result.status, 'dispatched');
    assert.deepEqual(
      result.dispatches.map((dispatch) => dispatch.issue.id),
      ['issue-api'],
    );
    assert.equal(result.unassignedIssues[0]?.issueId, 'issue-api-user');
    assert.equal(result.unassignedIssues[0]?.reason, 'candidate_file_conflict');
    assert.deepEqual(readActiveLeases(dbPath), [['agent-a', 'issue-api']]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('orchestration dispatcher blocks active candidate file conflicts', async () => {
  const tempDir = createLocalTempDir('active-candidate-conflict');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    seedIssue(dbPath, {
      issueId: 'issue-auth',
      status: 'ready',
      priority: 'critical',
    });
    seedActiveRunArtifacts(dbPath, {
      runId: 'run-active-candidate',
      artifacts: [
        {
          kind: 'orchestration_candidate_files',
          path: encodeCandidateFilesArtifactPath(['src/auth/session.ts']),
        },
      ],
    });

    const result = await dispatchReadyOrchestrationIssues({
      ...baseDispatchInput(dbPath),
      dispatchId: 'dispatch-active-candidate',
      subagents: [createSubagent('agent-a', ['implementation'])],
      issueRequirements: [
        {
          issueId: 'issue-auth',
          candidateFilePaths: ['src/auth'],
        },
      ],
    });

    assert.equal(result.status, 'idle');
    assert.equal(result.dispatches.length, 0);
    assert.equal(result.unassignedIssues[0]?.reason, 'candidate_file_conflict');
    assert.equal(selectIssue(dbPath, 'issue-auth')?.status, 'ready');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('orchestration dispatcher ignores malformed run notes during conflict scans', async () => {
  const tempDir = createLocalTempDir('malformed-run-notes');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    seedIssue(dbPath, {
      issueId: 'issue-safe',
      status: 'ready',
      priority: 'critical',
    });
    seedRunNotes(dbPath, {
      runId: 'run-malformed',
      status: 'in_progress',
      notes: '{not-json',
    });

    const result = await dispatchReadyOrchestrationIssues({
      ...baseDispatchInput(dbPath),
      dispatchId: 'dispatch-malformed-notes',
      subagents: [createSubagent('agent-a', ['implementation'])],
      issueRequirements: [
        {
          issueId: 'issue-safe',
          candidateFilePaths: ['src/runtime/safe.ts'],
        },
      ],
    });

    assert.equal(result.status, 'dispatched');
    assert.deepEqual(
      result.dispatches.map((dispatch) => dispatch.issue.id),
      ['issue-safe'],
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('orchestration dispatcher uses artifact-table worktree locks as a fallback', async () => {
  const tempDir = createLocalTempDir('artifact-table-lock');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    seedIssue(dbPath, {
      issueId: 'issue-active-source',
      status: 'in_progress',
      priority: 'critical',
    });
    seedIssue(dbPath, {
      issueId: 'issue-target',
      status: 'ready',
      priority: 'critical',
    });
    seedArtifact(dbPath, {
      artifactId: 'artifact-worktree-lock',
      issueId: 'issue-active-source',
      kind: 'orchestration_worktree',
      path: '/workspace/worktrees/issue-target',
      metadata: { status: 'active' },
    });

    const result = await dispatchReadyOrchestrationIssues({
      ...baseDispatchInput(dbPath),
      dispatchId: 'dispatch-artifact-lock',
      subagents: [createSubagent('agent-a', ['implementation'])],
    });

    assert.equal(result.status, 'idle');
    assert.equal(result.dispatches.length, 0);
    assert.equal(result.unassignedIssues[0]?.reason, 'worktree_path_conflict');
    assert.equal(selectIssue(dbPath, 'issue-target')?.status, 'ready');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('orchestration dispatcher enforces worktree conflicts across campaigns', async () => {
  const tempDir = createLocalTempDir('cross-campaign-worktree-conflict');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    seedCampaign(dbPath, 'campaign-a');
    seedCampaign(dbPath, 'campaign-b');
    seedIssue(dbPath, {
      issueId: 'issue-campaign-a',
      status: 'ready',
      priority: 'critical',
      campaignId: 'campaign-a',
    });
    seedActiveRunArtifacts(dbPath, {
      runId: 'run-campaign-b-worktree',
      campaignId: 'campaign-b',
      artifacts: [
        {
          kind: 'orchestration_worktree',
          path: '/workspace/worktrees/issue-campaign-a',
        },
      ],
    });

    const result = await dispatchReadyOrchestrationIssues({
      ...baseDispatchInput(dbPath),
      campaignId: 'campaign-a',
      dispatchId: 'dispatch-cross-campaign-worktree',
      subagents: [createSubagent('agent-a', ['implementation'])],
    });

    assert.equal(result.status, 'idle');
    assert.equal(result.dispatches.length, 0);
    assert.equal(result.unassignedIssues[0]?.reason, 'worktree_path_conflict');
    assert.equal(selectIssue(dbPath, 'issue-campaign-a')?.status, 'ready');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('orchestration dispatcher allows non-overlapping candidate files', async () => {
  const tempDir = createLocalTempDir('candidate-non-overlap');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    seedIssue(dbPath, {
      issueId: 'issue-api-orders',
      status: 'ready',
      priority: 'critical',
    });
    seedIssue(dbPath, {
      issueId: 'issue-ui-orders',
      status: 'ready',
      priority: 'critical',
    });

    const result = await dispatchReadyOrchestrationIssues({
      ...baseDispatchInput(dbPath),
      dispatchId: 'dispatch-candidate-non-overlap',
      maxAssignments: 2,
      maxConcurrentAgents: 2,
      subagents: [
        createSubagent('agent-a', ['implementation']),
        createSubagent('agent-b', ['implementation']),
      ],
      issueRequirements: [
        {
          issueId: 'issue-api-orders',
          candidateFilePaths: ['src/api/orders.ts'],
        },
        {
          issueId: 'issue-ui-orders',
          candidateFilePaths: ['src/ui/orders.ts'],
        },
      ],
    });

    assert.equal(result.status, 'dispatched');
    assert.deepEqual(
      result.dispatches.map((dispatch) => dispatch.issue.id),
      ['issue-api-orders', 'issue-ui-orders'],
    );
    assert.equal(result.unassignedIssues.length, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function baseDispatchInput(dbPath: string) {
  return {
    dbPath,
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    repoRoot,
    worktreeRoot,
    baseRef: 'main',
    host: 'copilot',
    hostCapabilities,
    mem0Enabled: false,
  };
}

function createSubagent(
  id: string,
  capabilities: readonly string[],
): OrchestrationSubagent {
  return {
    id,
    role: 'worker',
    host: 'copilot',
    modelProfile: 'gpt-5-high',
    capabilities: [...capabilities],
    maxConcurrency: 1,
  };
}

function createLocalTempDir(name: string): string {
  const dir = join(
    process.cwd(),
    '.test-output',
    `orchestration-dispatcher-${process.pid}-${tempCounter++}-${name}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function seedBaseProject(dbPath: string): void {
  const database = openHarnessDatabase({ dbPath });

  try {
    runStatement(
      database.connection,
      `INSERT INTO workspaces (id, name, kind, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        'workspace-1',
        'Dispatcher Workspace',
        'global',
        '2026-03-21T00:00:00.000Z',
        '2026-03-21T00:00:00.000Z',
      ],
    );
    runStatement(
      database.connection,
      `INSERT INTO projects (id, workspace_id, key, name, domain, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'project-1',
        'workspace-1',
        'dispatcher-project',
        'Dispatcher Project',
        'runtime',
        'active',
        '2026-03-21T00:00:00.000Z',
        '2026-03-21T00:00:00.000Z',
      ],
    );
  } finally {
    database.close();
  }
}

function seedIssue(
  dbPath: string,
  input: {
    issueId: string;
    status: string;
    priority: 'critical' | 'high' | 'medium' | 'low';
    campaignId?: string;
    dependsOn?: readonly string[];
  },
): void {
  const database = openHarnessDatabase({ dbPath });

  try {
    runStatement(
      database.connection,
      `INSERT INTO issues (
         id, project_id, campaign_id, milestone_id, task, priority, status, size,
         depends_on, deadline_at, policy_json, next_best_action, blocked_reason,
         created_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.issueId,
        'project-1',
        input.campaignId ?? null,
        null,
        `Implement ${input.issueId}`,
        input.priority,
        input.status,
        'M',
        JSON.stringify(input.dependsOn ?? []),
        null,
        '{}',
        'Dispatch via orchestration dispatcher.',
        null,
        '2026-03-21T00:00:00.000Z',
      ],
    );
  } finally {
    database.close();
  }
}

function seedCampaign(dbPath: string, campaignId: string): void {
  const database = openHarnessDatabase({ dbPath });

  try {
    runStatement(
      database.connection,
      `INSERT INTO campaigns (
         id, project_id, name, objective, status, scope_json, policy_json,
         created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        campaignId,
        'project-1',
        `Campaign ${campaignId}`,
        'Validate campaign-scoped dispatch capacity.',
        'active',
        '{}',
        '{}',
        '2026-03-21T00:00:00.000Z',
        '2026-03-21T00:00:00.000Z',
      ],
    );
  } finally {
    database.close();
  }
}

function seedLease(
  dbPath: string,
  input: {
    leaseId: string;
    issueId: string;
    agentId: string;
    expiresAt: string;
  },
): void {
  const database = openHarnessDatabase({ dbPath });

  try {
    runStatement(
      database.connection,
      `INSERT INTO leases (
         id, workspace_id, project_id, campaign_id, issue_id, agent_id, status,
         acquired_at, expires_at, last_heartbeat_at, released_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.leaseId,
        'workspace-1',
        'project-1',
        null,
        input.issueId,
        input.agentId,
        'active',
        '2026-03-21T00:00:00.000Z',
        input.expiresAt,
        null,
        null,
      ],
    );
  } finally {
    database.close();
  }
}

function seedActiveRunArtifacts(
  dbPath: string,
  input: {
    runId: string;
    campaignId?: string;
    artifacts: ReadonlyArray<{ kind: string; path: string }>;
  },
): void {
  seedRunNotes(dbPath, {
    runId: input.runId,
    campaignId: input.campaignId,
    status: 'in_progress',
    notes: JSON.stringify({ artifacts: input.artifacts }),
  });
}

function seedRunNotes(
  dbPath: string,
  input: {
    runId: string;
    campaignId?: string;
    status: string;
    notes: string;
  },
): void {
  const database = openHarnessDatabase({ dbPath });

  try {
    runStatement(
      database.connection,
      `INSERT INTO runs (
         id, workspace_id, project_id, campaign_id, session_type, host, status,
         started_at, finished_at, notes
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.runId,
        'workspace-1',
        'project-1',
        input.campaignId ?? null,
        'incremental',
        'copilot',
        input.status,
        '2026-03-21T00:00:00.000Z',
        null,
        input.notes,
      ],
    );
  } finally {
    database.close();
  }
}

function seedArtifact(
  dbPath: string,
  input: {
    artifactId: string;
    issueId: string;
    kind: string;
    path: string;
    metadata: Record<string, unknown>;
  },
): void {
  const database = openHarnessDatabase({ dbPath });

  try {
    runStatement(
      database.connection,
      `INSERT INTO artifacts (
         id, workspace_id, project_id, campaign_id, issue_id, kind, path,
         metadata_json, created_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.artifactId,
        'workspace-1',
        'project-1',
        null,
        input.issueId,
        input.kind,
        input.path,
        JSON.stringify(input.metadata),
        '2026-03-21T00:00:00.000Z',
      ],
    );
  } finally {
    database.close();
  }
}

function readIssueStatuses(dbPath: string): Record<string, string> {
  const database = openHarnessDatabase({ dbPath });

  try {
    const rows = selectAll<{ id: string; status: string }>(
      database.connection,
      `SELECT id, status FROM issues ORDER BY id ASC`,
    );

    return Object.fromEntries(rows.map((row) => [row.id, row.status]));
  } finally {
    database.close();
  }
}

function readActiveLeases(dbPath: string): Array<[string, string | null]> {
  const database = openHarnessDatabase({ dbPath });

  try {
    const rows = selectAll<{ agent_id: string; issue_id: string | null }>(
      database.connection,
      `SELECT agent_id, issue_id
       FROM leases
       WHERE status = 'active' AND released_at IS NULL
       ORDER BY agent_id ASC, issue_id ASC`,
    );

    return rows.map((row) => [row.agent_id, row.issue_id]);
  } finally {
    database.close();
  }
}

function selectIssue(
  dbPath: string,
  issueId: string,
): { status: string; blocked_reason: string | null } | null {
  const database = openHarnessDatabase({ dbPath });

  try {
    return selectOne<{ status: string; blocked_reason: string | null }>(
      database.connection,
      `SELECT status, blocked_reason
       FROM issues
       WHERE id = ?`,
      [issueId],
    );
  } finally {
    database.close();
  }
}
