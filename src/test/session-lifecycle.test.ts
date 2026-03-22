import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { Mem0Adapter } from '../memory/mem0-adapter.interface.js';
import type {
  HealthCheckResult,
  MemoryRecallInput,
  MemorySearchInput,
  MemorySearchResult,
  MemoryStoreInput,
  PublicMemoryRecord,
} from '../memory/mem0.schemas.js';
import {
  SessionOrchestrator,
  openHarnessDatabase,
  runStatement,
  selectAll,
  selectOne,
} from '../index.js';

class InMemoryMem0Adapter implements Mem0Adapter {
  private readonly memories: PublicMemoryRecord[] = [];

  async healthCheck(): Promise<HealthCheckResult> {
    return {
      ok: true,
      storePath: ':memory:',
      ollamaBaseUrl: 'memory://local',
      embedModel: 'stub',
      modelAvailable: true,
      recordCount: this.memories.length,
    };
  }

  async storeMemory(input: MemoryStoreInput): Promise<PublicMemoryRecord> {
    const record: PublicMemoryRecord = {
      ...input,
      id: createStubUuid(this.memories.length + 1),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.memories.push(record);

    return record;
  }

  async recallMemory(
    input: MemoryRecallInput,
  ): Promise<PublicMemoryRecord | null> {
    const memory =
      this.memories.find(
        (candidate) =>
          candidate.id === input.memoryId &&
          matchesScope(candidate.scope, input.scope),
      ) ?? null;

    return memory;
  }

  async searchMemory(
    input: MemorySearchInput,
  ): Promise<MemorySearchResult[]> {
    return this.memories
      .filter((candidate) => matchesScope(candidate.scope, input.scope))
      .slice(0, input.limit)
      .map((memory) => ({ memory, score: 1 }));
  }
}

test('orchestrator supports claim, resume, checkpoint, mem0 recall, and close', async () => {
  const tempDir = createTempDir('orchestrator-resume-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    insertIssue({
      dbPath,
      issueId: 'issue-1',
      task: 'Resume lifecycle work',
      status: 'ready',
      nextBestAction: 'Resume from prior checkpoint',
    });

    const orchestrator = new SessionOrchestrator({
      mem0Adapter: new InMemoryMem0Adapter(),
      defaultCheckpointFreshnessSeconds: 3600,
    });

    const firstSession = await orchestrator.beginIncrementalSession({
      sessionId: 'run-1',
      dbPath,
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      progressPath: '/tmp/progress.md',
      featureListPath: '/tmp/features.json',
      planPath: '/tmp/plan.md',
      syncManifestPath: '/tmp/manifest.yaml',
      mem0Enabled: true,
      agentId: 'agent-1',
      preferredIssueId: 'issue-1',
    });
    const blocked = await orchestrator.checkpoint(firstSession, {
      title: 'blocked',
      summary: 'Blocked and waiting for recovery context.',
      taskStatus: 'blocked',
      nextStep: 'Resume after loading the derived memory.',
      artifactIds: ['artifact-1'],
    });
    const resumedSession = await orchestrator.beginIncrementalSession({
      sessionId: 'run-2',
      dbPath,
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      progressPath: '/tmp/progress.md',
      featureListPath: '/tmp/features.json',
      planPath: '/tmp/plan.md',
      syncManifestPath: '/tmp/manifest.yaml',
      mem0Enabled: true,
      agentId: 'agent-1',
      preferredIssueId: 'issue-1',
    });
    const closed = await orchestrator.close(resumedSession, {
      title: 'close',
      summary: 'Completed after resume.',
      taskStatus: 'done',
      nextStep: 'Select the next ready issue.',
      artifactIds: ['artifact-2'],
    });

    const inspected = openHarnessDatabase({ dbPath });
    try {
      const issue = selectOne<{ status: string }>(
        inspected.connection,
        'SELECT status FROM issues WHERE id = ?',
        ['issue-1'],
      );
      const lease = selectOne<{ status: string }>(
        inspected.connection,
        'SELECT status FROM leases WHERE id = ?',
        [resumedSession.leaseId],
      );
      const memoryLinks = selectAll<{ memory_kind: string }>(
        inspected.connection,
        'SELECT memory_kind FROM memory_links WHERE issue_id = ? ORDER BY created_at ASC',
        ['issue-1'],
      );

      assert.equal(firstSession.claimMode, 'claim');
      assert.equal(blocked.memoryId !== undefined, true);
      assert.equal(resumedSession.claimMode, 'resume');
      assert.equal(resumedSession.mem0.recalledMemories.length, 1);
      assert.equal(closed.memoryId !== undefined, true);
      assert.equal(issue?.status, 'done');
      assert.equal(lease?.status, 'released');
      assert.deepEqual(memoryLinks.map((link) => link.memory_kind), [
        'decision',
        'summary',
      ]);
    } finally {
      inspected.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('reconciliation marks stale work as needs_recovery and blocks fresh claims', async () => {
  const tempDir = createTempDir('reconciliation-block-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    insertIssue({
      dbPath,
      issueId: 'issue-stale',
      task: 'Recover stale lifecycle work',
      status: 'ready',
      nextBestAction: 'Inspect stale evidence before claiming',
    });
    seedRun(dbPath, 'old-run', 'in_progress');
    seedLease(dbPath, 'lease-stale', 'issue-stale', 'active');
    seedCheckpoint(dbPath, 'checkpoint-old', 'old-run', 'issue-stale', 'claim');

    const orchestrator = new SessionOrchestrator({
      mem0Adapter: new InMemoryMem0Adapter(),
      defaultCheckpointFreshnessSeconds: 60,
    });

    await assert.rejects(
      () =>
        orchestrator.beginIncrementalSession({
          sessionId: 'run-blocked',
          dbPath,
          workspaceId: 'workspace-1',
          projectId: 'project-1',
          progressPath: '/tmp/progress.md',
          featureListPath: '/tmp/features.json',
          planPath: '/tmp/plan.md',
          syncManifestPath: '/tmp/manifest.yaml',
          mem0Enabled: true,
          agentId: 'agent-new',
        }),
      /Reconciliation is required/,
    );

    const inspected = openHarnessDatabase({ dbPath });
    try {
      const issue = selectOne<{ status: string }>(
        inspected.connection,
        'SELECT status FROM issues WHERE id = ?',
        ['issue-stale'],
      );
      const lease = selectOne<{ status: string }>(
        inspected.connection,
        'SELECT status FROM leases WHERE id = ?',
        ['lease-stale'],
      );
      const run = selectOne<{ status: string }>(
        inspected.connection,
        'SELECT status FROM runs WHERE id = ?',
        ['run-blocked'],
      );
      const checkpoints = selectAll<{ title: string }>(
        inspected.connection,
        'SELECT title FROM checkpoints WHERE run_id = ? ORDER BY created_at ASC',
        ['run-blocked'],
      );
      const events = selectAll<{ kind: string }>(
        inspected.connection,
        'SELECT kind FROM events WHERE run_id = ? ORDER BY created_at ASC',
        ['run-blocked'],
      );

      assert.equal(issue?.status, 'needs_recovery');
      assert.equal(lease?.status, 'needs_recovery');
      assert.equal(run?.status, 'needs_recovery');
      assert.deepEqual(checkpoints.map((checkpoint) => checkpoint.title), [
        'needs_recovery',
      ]);
      assert.deepEqual(events.map((event) => event.kind), [
        'checkpoint_payload',
        'reconciliation_blocked',
      ]);
    } finally {
      inspected.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('beginRecoverySession replaces stale leases with a fresh recovery lease', async () => {
  const tempDir = createTempDir('recovery-flow-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    insertIssue({
      dbPath,
      issueId: 'issue-recovery',
      task: 'Resolve recovery path',
      status: 'needs_recovery',
      nextBestAction: 'Recover explicitly',
    });
    seedLease(dbPath, 'lease-recovery-old', 'issue-recovery', 'needs_recovery');

    const orchestrator = new SessionOrchestrator({
      mem0Adapter: new InMemoryMem0Adapter(),
      defaultCheckpointFreshnessSeconds: 3600,
    });

    const recoverySession = await orchestrator.beginRecoverySession({
      sessionId: 'run-recovery',
      dbPath,
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      progressPath: '/tmp/progress.md',
      featureListPath: '/tmp/features.json',
      planPath: '/tmp/plan.md',
      syncManifestPath: '/tmp/manifest.yaml',
      mem0Enabled: true,
      agentId: 'agent-recovery',
      preferredIssueId: 'issue-recovery',
      recoverySummary: 'Recover the flagged issue with a new lease.',
      recoveryNextStep: 'Continue under the fresh recovery lease.',
    });
    await orchestrator.close(recoverySession, {
      title: 'close',
      summary: 'Closed the recovered issue.',
      taskStatus: 'done',
      nextStep: 'Pick the next ready issue.',
      artifactIds: ['artifact-recovery'],
    });

    const inspected = openHarnessDatabase({ dbPath });
    try {
      const issue = selectOne<{ status: string }>(
        inspected.connection,
        'SELECT status FROM issues WHERE id = ?',
        ['issue-recovery'],
      );
      const leases = selectAll<{ status: string }>(
        inspected.connection,
        'SELECT status FROM leases WHERE issue_id = ? ORDER BY acquired_at ASC',
        ['issue-recovery'],
      );
      const checkpoints = selectAll<{ title: string }>(
        inspected.connection,
        'SELECT title FROM checkpoints WHERE run_id = ? ORDER BY created_at ASC',
        ['run-recovery'],
      );

      assert.equal(recoverySession.claimMode, 'recovery');
      assert.equal(issue?.status, 'done');
      assert.deepEqual(leases.map((lease) => lease.status), [
        'recovered',
        'released',
      ]);
      assert.deepEqual(checkpoints.map((checkpoint) => checkpoint.title), [
        'recovery_claim',
        'close',
      ]);
    } finally {
      inspected.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('close promotes dependent pending issues and the next session can claim them', async () => {
  const tempDir = createTempDir('queue-promotion-close-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    insertIssue({
      dbPath,
      issueId: 'issue-primary',
      task: 'Complete the first queue item',
      status: 'ready',
      nextBestAction: 'Finish this issue to unlock the next one.',
    });
    insertIssue({
      dbPath,
      issueId: 'issue-followup',
      task: 'Claim the promoted follow-up issue',
      status: 'pending',
      dependsOn: ['issue-primary'],
      nextBestAction: 'Claim after issue-primary is done.',
    });
    insertIssue({
      dbPath,
      issueId: 'issue-final',
      task: 'Stay pending until the follow-up issue completes',
      status: 'pending',
      dependsOn: ['issue-followup'],
      nextBestAction: 'Wait for issue-followup to complete.',
    });

    const orchestrator = new SessionOrchestrator({
      mem0Adapter: new InMemoryMem0Adapter(),
      defaultCheckpointFreshnessSeconds: 3600,
    });

    const session = await orchestrator.beginIncrementalSession({
      sessionId: 'run-primary',
      dbPath,
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      progressPath: '/tmp/progress.md',
      featureListPath: '/tmp/features.json',
      planPath: '/tmp/plan.md',
      syncManifestPath: '/tmp/manifest.yaml',
      mem0Enabled: false,
      agentId: 'agent-primary',
      preferredIssueId: 'issue-primary',
    });
    const closed = await orchestrator.close(session, {
      title: 'close',
      summary: 'Closed the first issue and unlocked the next queue item.',
      taskStatus: 'done',
      nextStep: 'Claim the promoted follow-up issue.',
      artifactIds: ['artifact-primary'],
    });

    const inspectedAfterClose = openHarnessDatabase({ dbPath });
    try {
      const followup = selectOne<{ status: string }>(
        inspectedAfterClose.connection,
        'SELECT status FROM issues WHERE id = ?',
        ['issue-followup'],
      );
      const finalIssue = selectOne<{ status: string }>(
        inspectedAfterClose.connection,
        'SELECT status FROM issues WHERE id = ?',
        ['issue-final'],
      );
      const events = selectAll<{ kind: string }>(
        inspectedAfterClose.connection,
        'SELECT kind FROM events WHERE run_id = ? ORDER BY created_at ASC',
        ['run-primary'],
      );

      assert.deepEqual(closed.promotedIssueIds, ['issue-followup']);
      assert.equal(followup?.status, 'ready');
      assert.equal(finalIssue?.status, 'pending');
      assert.equal(events.map((event) => event.kind).includes('queue_promoted'), true);
    } finally {
      inspectedAfterClose.close();
    }

    const nextSession = await orchestrator.beginIncrementalSession({
      sessionId: 'run-followup',
      dbPath,
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      progressPath: '/tmp/progress.md',
      featureListPath: '/tmp/features.json',
      planPath: '/tmp/plan.md',
      syncManifestPath: '/tmp/manifest.yaml',
      mem0Enabled: false,
      agentId: 'agent-primary',
    });

    assert.equal(nextSession.issueId, 'issue-followup');
    assert.equal(nextSession.claimMode, 'claim');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('CLI supports lifecycle commands and read-only inspection commands', async () => {
  const tempDir = createTempDir('cli-surface-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    insertIssue({
      dbPath,
      issueId: 'issue-cli',
      task: 'Drive lifecycle through CLI',
      status: 'ready',
      nextBestAction: 'Use the CLI adapter',
    });
    insertIssue({
      dbPath,
      issueId: 'issue-cli-recovery',
      task: 'Recover through CLI',
      status: 'needs_recovery',
      nextBestAction: 'Recover with the CLI adapter',
    });
    seedLease(
      dbPath,
      'lease-cli-recovery',
      'issue-cli-recovery',
      'needs_recovery',
    );

    const recovery = await runCliCommand(tempDir, {
      action: 'begin_recovery',
      input: {
        sessionId: 'cli-run-recovery',
        dbPath,
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        progressPath: '/tmp/progress.md',
        featureListPath: '/tmp/features.json',
        planPath: '/tmp/plan.md',
        syncManifestPath: '/tmp/manifest.yaml',
        mem0Enabled: false,
        agentId: 'cli-agent-recovery',
        preferredIssueId: 'issue-cli-recovery',
        recoverySummary: 'Recover via CLI.',
        recoveryNextStep: 'Close the recovered issue.',
      },
    });
    await runCliCommand(tempDir, {
      action: 'close',
      context: recovery.context,
      input: {
        title: 'close',
        summary: 'Closed the recovered CLI task.',
        taskStatus: 'done',
        nextStep: 'Proceed to the ready task.',
        artifactIds: ['artifact-cli-recovery'],
      },
    });

    const begin = await runCliCommand(tempDir, {
      action: 'begin_incremental',
      input: {
        sessionId: 'cli-run-1',
        dbPath,
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        progressPath: '/tmp/progress.md',
        featureListPath: '/tmp/features.json',
        planPath: '/tmp/plan.md',
        syncManifestPath: '/tmp/manifest.yaml',
        mem0Enabled: false,
        agentId: 'cli-agent',
        preferredIssueId: 'issue-cli',
        checkpointFreshnessSeconds: 3600,
      },
    });
    const checkpoint = await runCliCommand(tempDir, {
      action: 'checkpoint',
      context: begin.context,
      input: {
        title: 'checkpoint',
        summary: 'Moved the CLI task forward.',
        taskStatus: 'in_progress',
        nextStep: 'Close it successfully.',
        persistToMem0: false,
      },
    });
    await runCliCommand(tempDir, {
      action: 'close',
      context: checkpoint.result.context,
      input: {
        title: 'close',
        summary: 'Closed the CLI task.',
        taskStatus: 'done',
        nextStep: 'Stop.',
        artifactIds: ['artifact-cli-close'],
      },
    });

    const overview = await runCliCommand(tempDir, {
      action: 'inspect_overview',
      input: {
        dbPath,
        projectId: 'project-1',
      },
    });
    const issue = await runCliCommand(tempDir, {
      action: 'inspect_issue',
      input: {
        dbPath,
        issueId: 'issue-cli',
      },
    });

    assert.equal(recovery.action, 'begin_recovery');
    assert.equal(begin.action, 'begin_incremental');
    assert.equal(checkpoint.action, 'checkpoint');
    assert.equal(overview.action, 'inspect_overview');
    assert.equal(issue.action, 'inspect_issue');
    assert.equal(overview.result.counts.readyIssues, 0);
    assert.equal(overview.result.counts.recoveryIssues, 0);
    assert.equal(issue.result.issue.status, 'done');
    assert.equal(issue.result.checkpoints.length, 3);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('CLI supports promote_queue for eligible pending issues', async () => {
  const tempDir = createTempDir('cli-promote-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    insertIssue({
      dbPath,
      issueId: 'issue-done',
      task: 'Already completed dependency',
      status: 'done',
      nextBestAction: 'Nothing else.',
    });
    insertIssue({
      dbPath,
      issueId: 'issue-promoted',
      task: 'Should become ready through the CLI helper',
      status: 'pending',
      dependsOn: ['issue-done'],
      nextBestAction: 'Claim after the dependency is complete.',
    });

    const promoted = await runCliCommand(tempDir, {
      action: 'promote_queue',
      input: {
        dbPath,
        projectId: 'project-1',
      },
    });
    const overview = await runCliCommand(tempDir, {
      action: 'inspect_overview',
      input: {
        dbPath,
        projectId: 'project-1',
      },
    });

    assert.equal(promoted.action, 'promote_queue');
    assert.deepEqual(promoted.result.promotedIssueIds, ['issue-promoted']);
    assert.equal(overview.result.counts.readyIssues, 1);
    assert.equal(overview.result.readyIssues[0].id, 'issue-promoted');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function seedBaseProject(dbPath: string): void {
  const seeded = openHarnessDatabase({ dbPath });

  try {
    runStatement(
      seeded.connection,
      `INSERT INTO workspaces (id, name, kind, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        'workspace-1',
        'Copilot Runtime',
        'global',
        '2026-03-21T00:00:00.000Z',
        '2026-03-21T00:00:00.000Z',
      ],
    );
    runStatement(
      seeded.connection,
      `INSERT INTO projects (id, workspace_id, key, name, domain, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'project-1',
        'workspace-1',
        'agent-harness-core',
        'agent-harness-core',
        'copilot',
        'active',
        '2026-03-21T00:00:00.000Z',
        '2026-03-21T00:00:00.000Z',
      ],
    );
  } finally {
    seeded.close();
  }
}

function insertIssue(input: {
  dbPath: string;
  issueId: string;
  task: string;
  status: string;
  nextBestAction: string;
  dependsOn?: string[];
  priority?: string;
}): void {
  const database = openHarnessDatabase({ dbPath: input.dbPath });

  try {
    runStatement(
      database.connection,
      `INSERT INTO issues (id, project_id, campaign_id, milestone_id, task, priority, status, size, depends_on, next_best_action)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.issueId,
        'project-1',
        null,
        null,
        input.task,
        input.priority ?? 'high',
        input.status,
        'M',
        JSON.stringify(input.dependsOn ?? []),
        input.nextBestAction,
      ],
    );
  } finally {
    database.close();
  }
}

function seedRun(dbPath: string, runId: string, status: string): void {
  const database = openHarnessDatabase({ dbPath });

  try {
    runStatement(
      database.connection,
      `INSERT INTO runs (id, workspace_id, project_id, campaign_id, session_type, host, status, started_at, finished_at, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        runId,
        'workspace-1',
        'project-1',
        null,
        'incremental',
        'host-old',
        status,
        '2026-03-21T00:00:00.000Z',
        null,
        '{}',
      ],
    );
  } finally {
    database.close();
  }
}

function seedLease(
  dbPath: string,
  leaseId: string,
  issueId: string,
  status: string,
): void {
  const database = openHarnessDatabase({ dbPath });

  try {
    runStatement(
      database.connection,
      `INSERT INTO leases (id, workspace_id, project_id, campaign_id, issue_id, agent_id, status, acquired_at, expires_at, released_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        leaseId,
        'workspace-1',
        'project-1',
        null,
        issueId,
        'agent-old',
        status,
        '2026-03-21T00:00:00.000Z',
        '2099-03-21T00:00:00.000Z',
        null,
      ],
    );
  } finally {
    database.close();
  }
}

function seedCheckpoint(
  dbPath: string,
  checkpointId: string,
  runId: string,
  issueId: string,
  title: string,
): void {
  const database = openHarnessDatabase({ dbPath });

  try {
    runStatement(
      database.connection,
      `INSERT INTO checkpoints (id, run_id, issue_id, title, summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        checkpointId,
        runId,
        issueId,
        title,
        'Old checkpoint evidence',
        '2026-03-21T00:05:00.000Z',
      ],
    );
  } finally {
    database.close();
  }
}

async function runCliCommand(
  tempDir: string,
  command: Record<string, unknown>,
): Promise<any> {
  const cliPath = join(process.cwd(), 'dist/bin/session-lifecycle.js');
  const storePath = join(tempDir, 'mem0');

  return new Promise((resolve, reject) => {
    const child = spawn('node', [cliPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MEM0_STORE_PATH: storePath,
        OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
        MEM0_EMBED_MODEL: 'qwen3-embedding:latest',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `CLI exited with code ${code}`));
        return;
      }

      resolve(JSON.parse(stdout));
    });

    child.stdin.write(JSON.stringify(command));
    child.stdin.end();
  });
}

function matchesScope(
  storedScope: PublicMemoryRecord['scope'],
  requestedScope: MemorySearchInput['scope'],
): boolean {
  return (
    storedScope.workspace === requestedScope.workspace &&
    storedScope.project === requestedScope.project &&
    matchesOptionalScopeField(storedScope.campaign, requestedScope.campaign) &&
    matchesOptionalScopeField(storedScope.task, requestedScope.task) &&
    matchesOptionalScopeField(storedScope.run, requestedScope.run)
  );
}

function matchesOptionalScopeField(
  storedValue: string | undefined,
  requestedValue: string | undefined,
): boolean {
  if (requestedValue === undefined) {
    return true;
  }

  return storedValue === requestedValue;
}

function createStubUuid(index: number): string {
  return `00000000-0000-0000-0000-${index.toString().padStart(12, '0')}`;
}
