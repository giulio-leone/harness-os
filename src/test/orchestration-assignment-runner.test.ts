import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { SessionContext } from '../contracts/session-contracts.js';
import {
  buildCsqrLiteScorecard,
  openHarnessDatabase,
  runStatement,
  selectAll,
  selectOne,
  SessionOrchestrator,
} from '../index.js';
import {
  runSymphonyAssignment,
} from '../runtime/orchestration-assignment-runner.js';
import type { SymphonyWorktreeCommand } from '../runtime/symphony-worktree-adapter.js';

const hostCapabilities = {
  workloadClasses: ['default', 'typescript'],
  capabilities: ['node', 'sqlite'],
};

test('assignment runner executes command, requires command-produced proof, and closes done', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'assignment-runner-success-'));
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    seedIssue(dbPath, 'issue-assignment-success', 'ready');
    const session = await beginSession(dbPath, 'issue-assignment-success');
    const input = buildAssignmentRunnerInput(tempDir, session);

    const result = await runSymphonyAssignment(input, {
      executor: async (command) => {
        writeSuccessfulProofFiles(command, session.runId);
        return {
          command: command.command,
          args: [...command.args],
          cwd: command.cwd,
          exitCode: 0,
          timedOut: false,
          stdout: 'verification passed',
          stderr: '',
          durationMs: 42,
        };
      },
    });

    assert.equal(result.status, 'succeeded');
    assert.equal(result.evidenceArtifacts.length, 3);
    assert.deepEqual(
      result.evidenceArtifacts.map((artifact) => artifact.kind).sort(),
      ['diagnostic_log', 'e2e_report', 'test_report'],
    );
    assert.equal(result.csqrLiteScorecardArtifactIds.length, 1);

    const inspected = openHarnessDatabase({ dbPath });
    try {
      const issue = selectOne<{ status: string }>(
        inspected.connection,
        'SELECT status FROM issues WHERE id = ?',
        ['issue-assignment-success'],
      );
      const artifactRows = selectAll<{ kind: string; path: string }>(
        inspected.connection,
        'SELECT kind, path FROM artifacts WHERE issue_id = ? ORDER BY kind ASC',
        ['issue-assignment-success'],
      );

      assert.equal(issue?.status, 'done');
      assert.equal(
        artifactRows.some((artifact) => artifact.kind === 'csqr_lite_scorecard'),
        true,
      );
      assert.equal(
        artifactRows.some((artifact) => artifact.kind === 'test_report'),
        true,
      );
    } finally {
      inspected.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('assignment runner closes failed when required evidence is missing', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'assignment-runner-missing-evidence-'));
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    seedIssue(dbPath, 'issue-assignment-failure', 'ready');
    const session = await beginSession(dbPath, 'issue-assignment-failure');
    const input = buildAssignmentRunnerInput(tempDir, session);

    const result = await runSymphonyAssignment(input, {
      executor: async (command) => ({
        command: command.command,
        args: [...command.args],
        cwd: command.cwd,
        exitCode: 0,
        timedOut: false,
        stdout: 'command forgot proof files',
        stderr: '',
        durationMs: 7,
      }),
    });

    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /Required test_report artifact/);
    assert.deepEqual(
      result.evidenceArtifacts.map((artifact) => artifact.kind),
      ['diagnostic_log'],
    );

    const inspected = openHarnessDatabase({ dbPath });
    try {
      const issue = selectOne<{ status: string }>(
        inspected.connection,
        'SELECT status FROM issues WHERE id = ?',
        ['issue-assignment-failure'],
      );
      assert.equal(issue?.status, 'failed');
    } finally {
      inspected.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('assignment runner closes failed when cleanup throws after proof creation', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'assignment-runner-cleanup-failure-'));
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    seedIssue(dbPath, 'issue-assignment-cleanup', 'ready');
    const session = await beginSession(dbPath, 'issue-assignment-cleanup');
    const input = buildAssignmentRunnerInput(tempDir, session, {
      workspaceMode: 'create_physical_worktree',
      cleanupWorktree: true,
    });

    const result = await runSymphonyAssignment(input, {
      prepareWorkspace: async () => {},
      cleanupWorkspace: async () => {
        throw new Error('cleanup storage unavailable');
      },
      executor: async (command) => {
        writeSuccessfulProofFiles(command, session.runId);
        return {
          command: command.command,
          args: [...command.args],
          cwd: command.cwd,
          exitCode: 0,
          timedOut: false,
          stdout: 'verification passed before cleanup',
          stderr: '',
          durationMs: 31,
        };
      },
    });

    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /Assignment cleanup failed/);
    assert.deepEqual(
      result.evidenceArtifacts.map((artifact) => artifact.kind).sort(),
      ['diagnostic_log', 'e2e_report', 'test_report'],
    );

    const inspected = openHarnessDatabase({ dbPath });
    try {
      const issue = selectOne<{ status: string }>(
        inspected.connection,
        'SELECT status FROM issues WHERE id = ?',
        ['issue-assignment-cleanup'],
      );
      assert.equal(issue?.status, 'failed');
    } finally {
      inspected.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('assignment runner rejects evidence roots inside removable worktrees', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'assignment-runner-evidence-root-'));
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    seedIssue(dbPath, 'issue-assignment-root', 'ready');
    const session = await beginSession(dbPath, 'issue-assignment-root');
    const input = buildAssignmentRunnerInput(tempDir, session, {
      evidenceRoot: join(tempDir, 'worktrees', 'issue-assignment-root', 'evidence'),
    });

    const result = await runSymphonyAssignment(input, {
      executor: async () => {
        throw new Error('executor should not run for invalid evidence roots');
      },
    });

    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /must not be inside removable worktree path/);

    const inspected = openHarnessDatabase({ dbPath });
    try {
      const issue = selectOne<{ status: string }>(
        inspected.connection,
        'SELECT status FROM issues WHERE id = ?',
        ['issue-assignment-root'],
      );
      assert.equal(issue?.status, 'failed');
    } finally {
      inspected.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

async function beginSession(
  dbPath: string,
  issueId: string,
): Promise<SessionContext> {
  return new SessionOrchestrator().beginIncrementalSession({
    sessionId: `run-${issueId}`,
    dbPath,
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    preferredIssueId: issueId,
    agentId: `agent-${issueId}`,
    host: 'copilot',
    hostCapabilities,
    artifacts: [],
    mem0Enabled: false,
  });
}

function buildAssignmentRunnerInput(
  tempDir: string,
  session: SessionContext,
  overrides: {
    evidenceRoot?: string;
    workspaceMode?: 'existing_worktree' | 'create_physical_worktree';
    cleanupWorktree?: boolean;
  } = {},
) {
  const repoRoot = join(tempDir, 'repo');
  const worktreeRoot = join(tempDir, 'worktrees');
  const worktreePath = join(worktreeRoot, session.issueId);

  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(worktreePath, { recursive: true });

  return {
    contractVersion: '1.0.0' as const,
    assignment: {
      id: `assignment-${session.issueId}`,
      issueId: session.issueId,
      subagentId: session.agentId,
      worktreeId: `worktree-${session.issueId}`,
    },
    issue: {
      id: session.issueId,
      task: session.issueTask,
      priority: 'high',
      status: 'in_progress',
    },
    subagent: {
      id: session.agentId,
      role: 'implementation',
      host: 'copilot',
      modelProfile: 'gpt-5-high' as const,
      capabilities: ['node', 'sqlite'],
      maxConcurrency: 1,
    },
    worktree: {
      id: `worktree-${session.issueId}`,
      repoRoot,
      root: worktreeRoot,
      path: worktreePath,
      branch: `feat/${session.issueId}`,
      baseRef: 'main',
      cleanupPolicy: 'retain' as const,
      containment: {
        expectedParentPath: worktreeRoot,
        requirePathWithinRoot: true,
      },
    },
    session,
    runner: {
      command: 'node',
      args: ['fake-runner.js'],
      timeoutMs: 30_000,
      maxOutputBytes: 4096,
      requiredEvidenceArtifactKinds: ['test_report', 'e2e_report'],
      includeCsqrLiteScorecard: true,
      maxAssignmentsPerTick: 1,
      workspaceMode: overrides.workspaceMode ?? ('existing_worktree' as const),
      cleanupWorktree: overrides.cleanupWorktree ?? false,
      ...(overrides.evidenceRoot !== undefined
        ? { evidenceRoot: overrides.evidenceRoot }
        : {}),
    },
  };
}

function writeSuccessfulProofFiles(
  command: SymphonyWorktreeCommand,
  runId: string,
): void {
  const env = command.env ?? {};
  const testReportPath = readRequiredEnv(env, 'HARNESS_TEST_REPORT_PATH');
  const e2eReportPath = readRequiredEnv(env, 'HARNESS_E2E_REPORT_PATH');
  const scorecardPath = readRequiredEnv(env, 'HARNESS_CSQR_SCORECARD_PATH');

  writeFileSync(
    testReportPath,
    `${JSON.stringify({ status: 'passed', suite: 'unit' }, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(
    e2eReportPath,
    `${JSON.stringify({ status: 'passed', flow: 'assignment-runner' }, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(
    scorecardPath,
    `${JSON.stringify(buildPassingScorecard(runId), null, 2)}\n`,
    'utf8',
  );
  assert.equal(readFileSync(testReportPath, 'utf8').includes('passed'), true);
}

function buildPassingScorecard(runId: string) {
  return buildCsqrLiteScorecard({
    id: `scorecard-${runId}`,
    scope: 'run',
    runId,
    targetScore: 8,
    createdAt: '2026-05-13T00:00:00.000Z',
    scores: [
      {
        criterionId: 'correctness',
        score: 9,
        notes: 'Assignment behavior matches the requested contract.',
        evidenceArtifactIds: ['artifact-test'],
      },
      {
        criterionId: 'security',
        score: 9,
        notes: 'No unsafe inputs or secret-handling changes were introduced.',
        evidenceArtifactIds: ['artifact-test'],
      },
      {
        criterionId: 'quality',
        score: 9,
        notes: 'The implementation remains maintainable and deterministic.',
        evidenceArtifactIds: ['artifact-test'],
      },
      {
        criterionId: 'runtime-evidence',
        score: 9,
        notes: 'Unit and E2E proof reports were produced by the command.',
        evidenceArtifactIds: ['artifact-test'],
      },
    ],
  });
}

function readRequiredEnv(
  env: Record<string, string | undefined>,
  key: string,
): string {
  const value = env[key];
  if (typeof value !== 'string') {
    assert.fail(`${key} should be set`);
  }
  return value;
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
        'Assignment Runner Workspace',
        'global',
        '2026-05-13T00:00:00.000Z',
        '2026-05-13T00:00:00.000Z',
      ],
    );
    runStatement(
      database.connection,
      `INSERT INTO projects (id, workspace_id, key, name, domain, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'project-1',
        'workspace-1',
        'assignment-runner-project',
        'Assignment Runner Project',
        'runtime',
        'active',
        '2026-05-13T00:00:00.000Z',
        '2026-05-13T00:00:00.000Z',
      ],
    );
  } finally {
    database.close();
  }
}

function seedIssue(dbPath: string, issueId: string, status: string): void {
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
        issueId,
        'project-1',
        null,
        null,
        `Implement ${issueId}`,
        'high',
        status,
        'M',
        JSON.stringify([]),
        null,
        '{}',
        'Run through the assignment runner.',
        null,
        '2026-05-13T00:00:00.000Z',
      ],
    );
  } finally {
    database.close();
  }
}
