import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import type { OrchestrationSubagent } from '../contracts/orchestration-contracts.js';
import {
  orchestrationSupervisorRunSummarySchema,
  orchestrationSupervisorTickResultSchema,
} from '../contracts/orchestration-contracts.js';
import {
  openHarnessDatabase,
  runStatement,
  selectOne,
} from '../db/store.js';
import {
  runOrchestrationSupervisor,
  runOrchestrationSupervisorTick,
} from '../runtime/orchestration-supervisor.js';

let tempCounter = 0;

const repoRoot = '/workspace/harness-os';
const worktreeRoot = '/workspace/worktrees';
const hostCapabilities = {
  workloadClasses: ['default', 'typescript'],
  capabilities: ['node', 'sqlite'],
};
const timestamp = '2026-05-12T00:00:00.000Z';

test('supervisor dry-run inspects filtered dashboard without mutating queue or dispatching', async () => {
  const tempDir = createLocalTempDir('dry-run');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    seedIssue(dbPath, {
      issueId: 'issue-critical-ready',
      status: 'ready',
      priority: 'critical',
    });
    seedIssue(dbPath, {
      issueId: 'issue-low-ready',
      status: 'ready',
      priority: 'low',
    });

    const result = await runOrchestrationSupervisorTick(
      {
        ...baseTickInput(dbPath),
        mode: 'dry_run',
        dashboardFilters: {
          priority: 'critical',
        },
      },
      {
        clock: () => timestamp,
        promoteQueue: async () => {
          throw new Error('dry-run must not promote');
        },
        dispatchReady: async () => {
          throw new Error('dry-run must not dispatch');
        },
      },
    );

    assert.deepEqual(orchestrationSupervisorTickResultSchema.parse(result), result);
    assert.equal(result.mode, 'dry_run');
    assert.equal(result.readyIssueCount, 1);
    assert.deepEqual(
      result.decisions.map((decision) => [
        decision.kind,
        decision.wouldMutate,
        decision.executed,
      ]),
      [
        ['inspect_dashboard', false, true],
        ['dispatch_ready', true, false],
      ],
    );
    assert.deepEqual(readIssueStatuses(dbPath), {
      'issue-critical-ready': 'ready',
      'issue-low-ready': 'ready',
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('supervisor execute tick promotes first, dispatches only filtered visible ready issues, and returns a decision trace', async () => {
  const tempDir = createLocalTempDir('execute-filtered-dispatch');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    seedIssue(dbPath, {
      issueId: 'issue-critical-pending',
      status: 'pending',
      priority: 'critical',
    });
    seedIssue(dbPath, {
      issueId: 'issue-high-ready',
      status: 'ready',
      priority: 'high',
    });

    const result = await runOrchestrationSupervisorTick(
      {
        ...baseTickInput(dbPath),
        mode: 'execute',
        dashboardFilters: {
          priority: 'critical',
        },
        dispatch: {
          ...baseTickInput(dbPath).dispatch,
          subagents: [createSubagent('agent-a')],
        },
      },
      {
        runAssignment: async (input) => ({
          contractVersion: '1.0.0',
          assignmentId: input.assignment.id,
          issueId: input.issue.id,
          runId: input.session.runId,
          status: 'succeeded',
          startedAt: timestamp,
          completedAt: timestamp,
          evidenceArtifacts: [],
          evidenceArtifactIds: ['artifact-test-report'],
          csqrLiteScorecardArtifactIds: [],
          checkpointId: 'checkpoint-agent-runner',
          summary: 'assignment executed by fake runner',
          durationMs: 1,
        }),
      },
    );

    assert.deepEqual(orchestrationSupervisorTickResultSchema.parse(result), result);
    assert.equal(result.mode, 'execute');
    assert.equal(result.readyIssueCount, 1);
    assert.deepEqual(result.promotedIssueIds, ['issue-critical-pending']);
    assert.deepEqual(result.dispatchedIssueIds, ['issue-critical-pending']);
    assert.deepEqual(
      result.decisions.map((decision) => decision.kind),
      [
        'inspect_dashboard',
        'promote_queue',
        'inspect_dashboard',
        'dispatch_ready',
        'run_assignment',
      ],
    );
    assert.deepEqual(result.evidenceArtifactIds, ['artifact-test-report']);
    assert.equal(result.stopReason, undefined);
    assert.deepEqual(readIssueStatuses(dbPath), {
      'issue-critical-pending': 'in_progress',
      'issue-high-ready': 'ready',
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('supervisor execute tick errors before dispatch when assignment runner is absent', async () => {
  const tempDir = createLocalTempDir('missing-assignment-runner');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    seedIssue(dbPath, {
      issueId: 'issue-ready',
      status: 'ready',
      priority: 'critical',
    });

    const result = await runOrchestrationSupervisorTick(
      {
        ...baseTickInput(dbPath),
        mode: 'execute',
        dispatch: {
          repoRoot,
          worktreeRoot,
          baseRef: 'main',
          host: 'copilot',
          hostCapabilities,
          maxConcurrentAgents: 4,
          subagents: [createSubagent('agent-a')],
        },
      },
      {
        dispatchReady: async () => {
          throw new Error('dispatch should not run without assignmentRunner');
        },
      },
    );

    assert.deepEqual(orchestrationSupervisorTickResultSchema.parse(result), result);
    assert.equal(result.stopReason, 'error');
    assert.match(result.summary, /dispatch\.assignmentRunner/);
    assert.deepEqual(
      result.decisions.map((decision) => decision.kind),
      ['inspect_dashboard', 'promote_queue', 'inspect_dashboard', 'error'],
    );
    assert.equal(readIssueStatuses(dbPath)['issue-ready'], 'ready');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('supervisor execute tick reports blocked delay when promoted visible ready issues cannot be assigned', async () => {
  const tempDir = createLocalTempDir('blocked-dispatch');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    seedIssue(dbPath, {
      issueId: 'issue-ready',
      status: 'pending',
      priority: 'critical',
    });

    const result = await runOrchestrationSupervisorTick({
      ...baseTickInput(dbPath),
      mode: 'execute',
      backoff: {
        idleDelayMs: 30_000,
        blockedDelayMs: 45_000,
        errorDelayMs: 120_000,
      },
      dispatch: {
        ...baseTickInput(dbPath).dispatch,
        host: 'copilot',
        subagents: [
          {
            ...createSubagent('agent-other-host'),
            host: 'cursor',
          },
        ],
      },
    });

    assert.deepEqual(orchestrationSupervisorTickResultSchema.parse(result), result);
    assert.equal(result.stopReason, 'blocked');
    assert.equal(result.nextDelayMs, 45_000);
    assert.deepEqual(result.promotedIssueIds, ['issue-ready']);
    assert.deepEqual(result.dispatchedIssueIds, []);
    assert.equal(
      result.decisions.some((decision) => decision.kind === 'blocked'),
      true,
    );
    assert.equal(readIssueStatuses(dbPath)['issue-ready'], 'ready');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('supervisor execute tick idles with backoff when no work is visible', async () => {
  const tempDir = createLocalTempDir('idle');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);

    const result = await runOrchestrationSupervisorTick({
      ...baseTickInput(dbPath),
      mode: 'execute',
      backoff: {
        idleDelayMs: 12_000,
        blockedDelayMs: 45_000,
        errorDelayMs: 120_000,
      },
      dispatch: {
        ...baseTickInput(dbPath).dispatch,
        subagents: [createSubagent('agent-a')],
      },
    });

    assert.deepEqual(orchestrationSupervisorTickResultSchema.parse(result), result);
    assert.equal(result.stopReason, 'idle');
    assert.equal(result.nextDelayMs, 12_000);
    assert.deepEqual(result.promotedIssueIds, []);
    assert.deepEqual(result.dispatchedIssueIds, []);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('supervisor external stop short-circuits before database reads or mutations', async () => {
  const result = await runOrchestrationSupervisorTick(
    {
      contractVersion: '1.0.0',
      tickId: 'tick-external-stop',
      dbPath: '/tmp/does-not-need-to-exist.sqlite',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      mode: 'execute',
      stopCondition: {
        stopWhenIdle: false,
        stopWhenBlocked: false,
        externalStopFile: '/tmp/harness-supervisor.stop',
      },
      dispatch: {
        repoRoot,
        worktreeRoot,
        baseRef: 'main',
        host: 'copilot',
        hostCapabilities,
        maxConcurrentAgents: 4,
      },
    },
    {
      clock: () => timestamp,
      fileExists: () => true,
      loadDashboardViewModel: () => {
        throw new Error('external stop must not inspect');
      },
    },
  );

  assert.deepEqual(orchestrationSupervisorTickResultSchema.parse(result), result);
  assert.equal(result.stopReason, 'external_stop');
  assert.deepEqual(result.decisions.map((decision) => decision.kind), ['idle']);
});

test('supervisor returns an auditable error result with error backoff', async () => {
  const tempDir = createLocalTempDir('error');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);

    const result = await runOrchestrationSupervisorTick(
      {
        ...baseTickInput(dbPath),
        mode: 'execute',
        backoff: {
          idleDelayMs: 30_000,
          blockedDelayMs: 60_000,
          errorDelayMs: 5_000,
        },
        dispatch: {
          ...baseTickInput(dbPath).dispatch,
          subagents: [createSubagent('agent-a')],
        },
      },
      {
        clock: () => timestamp,
        promoteQueue: async () => {
          throw new Error('promotion unavailable');
        },
      },
    );

    assert.deepEqual(orchestrationSupervisorTickResultSchema.parse(result), result);
    assert.equal(result.stopReason, 'error');
    assert.equal(result.nextDelayMs, 5_000);
    assert.deepEqual(
      result.decisions.map((decision) => decision.kind),
      ['inspect_dashboard', 'promote_queue', 'error'],
    );
    assert.match(result.summary, /promotion unavailable/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('supervisor run performs bounded polling with deterministic tick ids and backoff sleeps', async () => {
  const tempDir = createLocalTempDir('bounded-run');
  const dbPath = join(tempDir, 'harness.sqlite');
  const sleeps: number[] = [];

  try {
    seedBaseProject(dbPath);

    const result = await runOrchestrationSupervisor(
      {
        ...baseRunInput(dbPath),
        stopCondition: {
          maxTicks: 2,
          stopWhenIdle: false,
          stopWhenBlocked: false,
        },
        backoff: {
          idleDelayMs: 7,
          blockedDelayMs: 11,
          errorDelayMs: 13,
        },
      },
      {
        clock: () => timestamp,
        sleep: async (delayMs) => {
          sleeps.push(delayMs);
        },
      },
    );

    assert.deepEqual(orchestrationSupervisorRunSummarySchema.parse(result), result);
    assert.equal(result.runId, 'run-supervisor-test');
    assert.equal(result.status, 'partial');
    assert.equal(result.stopReason, 'tick_limit_reached');
    assert.deepEqual(
      result.tickResults.map((tick) => tick.tickId),
      ['run-supervisor-test-tick-1', 'run-supervisor-test-tick-2'],
    );
    assert.deepEqual(
      result.tickResults.map((tick) => tick.stopReason),
      ['idle', 'idle'],
    );
    assert.deepEqual(sleeps, [7]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('supervisor run stops on idle when stop condition is enabled', async () => {
  const tempDir = createLocalTempDir('idle-run-stop');
  const dbPath = join(tempDir, 'harness.sqlite');
  const sleeps: number[] = [];

  try {
    seedBaseProject(dbPath);

    const result = await runOrchestrationSupervisor(
      {
        ...baseRunInput(dbPath),
        stopCondition: {
          maxTicks: 5,
          stopWhenIdle: true,
          stopWhenBlocked: false,
        },
      },
      {
        clock: () => timestamp,
        sleep: async (delayMs) => {
          sleeps.push(delayMs);
        },
      },
    );

    assert.deepEqual(orchestrationSupervisorRunSummarySchema.parse(result), result);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.stopReason, 'idle');
    assert.equal(result.tickResults.length, 1);
    assert.deepEqual(sleeps, []);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function baseTickInput(dbPath: string) {
  return {
    contractVersion: '1.0.0' as const,
    tickId: 'tick-supervisor-test',
    dbPath,
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    objective: 'Run one deterministic supervisor tick.',
    dispatch: {
      repoRoot,
      worktreeRoot,
      baseRef: 'main',
      host: 'copilot',
      hostCapabilities,
      maxConcurrentAgents: 4,
      assignmentRunner: {
        command: 'node',
        args: ['runner.js'],
        requiredEvidenceArtifactKinds: ['test_report', 'e2e_report'],
        includeCsqrLiteScorecard: true,
        maxAssignmentsPerTick: 1,
      },
    },
  };
}

function baseRunInput(dbPath: string) {
  return {
    contractVersion: '1.0.0' as const,
    runId: 'run-supervisor-test',
    dbPath,
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    objective: 'Run a bounded deterministic supervisor loop.',
  };
}

function createSubagent(id: string): OrchestrationSubagent {
  return {
    id,
    role: 'worker',
    host: 'copilot',
    modelProfile: 'gpt-5-high',
    capabilities: ['implementation', 'typescript'],
    maxConcurrency: 1,
  };
}

function createLocalTempDir(name: string): string {
  const dir = join(
    process.cwd(),
    '.test-output',
    `orchestration-supervisor-${process.pid}-${tempCounter++}-${name}`,
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
        'Supervisor Workspace',
        'global',
        '2026-05-12T00:00:00.000Z',
        '2026-05-12T00:00:00.000Z',
      ],
    );
    runStatement(
      database.connection,
      `INSERT INTO projects (id, workspace_id, key, name, domain, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'project-1',
        'workspace-1',
        'supervisor-project',
        'Supervisor Project',
        'runtime',
        'active',
        '2026-05-12T00:00:00.000Z',
        '2026-05-12T00:00:00.000Z',
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
        null,
        null,
        `Implement ${input.issueId}`,
        input.priority,
        input.status,
        'M',
        JSON.stringify([]),
        null,
        '{}',
        'Run through the supervisor tick.',
        null,
        '2026-05-12T00:00:00.000Z',
      ],
    );
  } finally {
    database.close();
  }
}

function readIssueStatuses(dbPath: string): Record<string, string> {
  const database = openHarnessDatabase({ dbPath });

  try {
    const statuses: Record<string, string> = {};
    for (const issueId of [
      'issue-critical-ready',
      'issue-low-ready',
      'issue-critical-pending',
      'issue-high-ready',
      'issue-ready',
    ]) {
      const row = selectOne<{ status: string }>(
        database.connection,
        'SELECT status FROM issues WHERE id = ?',
        [issueId],
      );
      if (row !== null) {
        statuses[issueId] = row.status;
      }
    }

    return statuses;
  } finally {
    database.close();
  }
}
