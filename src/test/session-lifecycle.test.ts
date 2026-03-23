import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import type {
  HealthCheckResult,
  Mem0Adapter,
  MemoryRecallInput,
  MemorySearchInput,
  MemorySearchResult,
  MemoryStoreInput,
  PublicMemoryRecord,
} from '../contracts/memory-contracts.js';
import {
  SessionLifecycleAdapter,
  SessionLifecycleMcpServer,
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
          matchesScope(candidate.scope as any, input.scope as any),
      ) ?? null;

    return memory;
  }

  async searchMemory(
    input: MemorySearchInput,
  ): Promise<MemorySearchResult[]> {
    return this.memories
      .filter((candidate) => matchesScope(candidate.scope as any, input.scope as any))
      .slice(0, input.limit)
      .map((memory) => ({ memory, score: 1 }));
  }

  async updateMemory(): Promise<PublicMemoryRecord> { throw new Error('stub'); }
  async deleteMemory(): Promise<void> {}
  async listWorkspaces(): Promise<string[]> { return []; }
  async listProjects(): Promise<string[]> { return []; }
}

class FailingStoreMem0Adapter extends InMemoryMem0Adapter {
  override async storeMemory(_input: MemoryStoreInput): Promise<PublicMemoryRecord> {
    throw new Error('simulated mem0 store failure');
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

test('beginIncrementalSession rolls back canonical state when lease claim fails', async () => {
  const tempDir = createTempDir('claim-rollback-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    insertIssue({
      dbPath,
      issueId: 'issue-rollback',
      task: 'Verify transactional rollback on claim failure',
      status: 'ready',
      nextBestAction: 'Attempt a conflicting claim.',
    });
    seedRun(dbPath, 'run-existing', 'in_progress');
    seedLease(dbPath, 'lease-existing', 'issue-rollback', 'active');
    seedCheckpoint(
      dbPath,
      'checkpoint-existing',
      'run-existing',
      'issue-rollback',
      'claim',
      new Date().toISOString(),
    );

    const orchestrator = new SessionOrchestrator({
      mem0Adapter: new InMemoryMem0Adapter(),
      defaultCheckpointFreshnessSeconds: 3600,
    });

    await assert.rejects(
      () =>
        orchestrator.beginIncrementalSession({
          sessionId: 'run-candidate',
          dbPath,
          workspaceId: 'workspace-1',
          projectId: 'project-1',
          progressPath: '/tmp/progress.md',
          featureListPath: '/tmp/features.json',
          planPath: '/tmp/plan.md',
          syncManifestPath: '/tmp/manifest.yaml',
          mem0Enabled: false,
          agentId: 'agent-candidate',
          preferredIssueId: 'issue-rollback',
        }),
      /already has an active lease/i,
    );

    const inspected = openHarnessDatabase({ dbPath });
    try {
      const issue = selectOne<{ status: string }>(
        inspected.connection,
        'SELECT status FROM issues WHERE id = ?',
        ['issue-rollback'],
      );
      const runs = selectAll<{ id: string }>(
        inspected.connection,
        'SELECT id FROM runs WHERE id = ?',
        ['run-candidate'],
      );
      const activeLeases = selectAll<{ agent_id: string }>(
        inspected.connection,
        `SELECT agent_id
         FROM leases
         WHERE issue_id = ?
           AND status = 'active'
           AND released_at IS NULL`,
        ['issue-rollback'],
      );

      assert.equal(issue?.status, 'ready');
      assert.equal(runs.length, 0);
      assert.deepEqual(activeLeases.map((lease) => lease.agent_id), ['agent-old']);
    } finally {
      inspected.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('checkpoint keeps canonical state valid when mem0 persistence fails', async () => {
  const tempDir = createTempDir('mem0-derived-failure-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    insertIssue({
      dbPath,
      issueId: 'issue-mem0-failure',
      task: 'Keep canonical state despite mem0 failure',
      status: 'ready',
      nextBestAction: 'Checkpoint with derived memory enabled.',
    });

    const orchestrator = new SessionOrchestrator({
      mem0Adapter: new FailingStoreMem0Adapter(),
      defaultCheckpointFreshnessSeconds: 3600,
    });

    const started = await orchestrator.beginIncrementalSession({
      sessionId: 'run-mem0-failure',
      dbPath,
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      progressPath: '/tmp/progress.md',
      featureListPath: '/tmp/features.json',
      planPath: '/tmp/plan.md',
      syncManifestPath: '/tmp/manifest.yaml',
      mem0Enabled: true,
      agentId: 'agent-mem0-failure',
      preferredIssueId: 'issue-mem0-failure',
    });
    const checkpoint = await orchestrator.checkpoint(started, {
      title: 'blocked',
      summary: 'Persist canonical state even if mem0 storage fails.',
      taskStatus: 'blocked',
      nextStep: 'Retry after mem0 recovers.',
      persistToMem0: true,
      memoryKind: 'summary',
      memoryContent: 'Derived memory payload',
    });

    assert.match(
      checkpoint.mem0WriteSkippedReason ?? '',
      /simulated mem0 store failure/i,
    );

    const inspected = openHarnessDatabase({ dbPath });
    try {
      const issue = selectOne<{ status: string }>(
        inspected.connection,
        'SELECT status FROM issues WHERE id = ?',
        ['issue-mem0-failure'],
      );
      const latestCheckpoint = selectOne<{
        task_status: string;
        next_step: string;
      }>(
        inspected.connection,
        `SELECT task_status, next_step
         FROM checkpoints
         WHERE issue_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
        ['issue-mem0-failure'],
      );
      const skippedEvents = selectAll<{ kind: string }>(
        inspected.connection,
        `SELECT kind
         FROM events
         WHERE issue_id = ?
           AND kind = 'mem0_write_skipped'`,
        ['issue-mem0-failure'],
      );
      const memoryLinks = selectAll<{ id: string }>(
        inspected.connection,
        'SELECT id FROM memory_links WHERE issue_id = ?',
        ['issue-mem0-failure'],
      );

      assert.equal(issue?.status, 'blocked');
      assert.equal(latestCheckpoint?.task_status, 'blocked');
      assert.equal(latestCheckpoint?.next_step, 'Retry after mem0 recovers.');
      assert.equal(skippedEvents.length, 1);
      assert.equal(memoryLinks.length, 0);
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

test('advance_session closes cleanly when no next ready issue exists', async () => {
  const tempDir = createTempDir('mcp-advance-no-next-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    insertIssue({
      dbPath,
      issueId: 'issue-only',
      task: 'Complete the only ready issue',
      status: 'ready',
      nextBestAction: 'Finish this issue.',
    });

    const orchestrator = new SessionOrchestrator({
      mem0Adapter: new InMemoryMem0Adapter(),
      defaultCheckpointFreshnessSeconds: 3600,
    });
    const adapter = new SessionLifecycleAdapter(orchestrator);
    const server = new SessionLifecycleMcpServer(adapter);
    const tools = (server as unknown as {
      tools: Map<string, { handler: (args: unknown) => Promise<unknown> }>;
      tokenStore: { resolve(token: string): unknown };
    }).tools;
    const tokenStore = (server as unknown as {
      tools: Map<string, { handler: (args: unknown) => Promise<unknown> }>;
      tokenStore: { resolve(token: string): unknown };
    }).tokenStore;
    const sessionTool = tools.get('harness_session');

    assert.ok(sessionTool);

    const started = (await sessionTool.handler({
      action: 'begin',
      sessionId: 'run-mcp-1',
      dbPath,
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      progressPath: '/tmp/progress.md',
      featureListPath: '/tmp/features.json',
      planPath: '/tmp/plan.md',
      syncManifestPath: '/tmp/manifest.yaml',
      mem0Enabled: false,
      agentId: 'agent-mcp',
      preferredIssueId: 'issue-only',
    })) as {
      sessionToken: string;
    };

    const advanced = (await sessionTool.handler({
      action: 'advance',
      sessionToken: started.sessionToken,
      closeInput: {
        title: 'close',
        summary: 'Finished the only issue.',
        taskStatus: 'done',
        nextStep: 'Stop.',
        artifactIds: ['artifact-only'],
      },
    })) as {
      advanced: boolean;
      _meta: { nextTools: string[] };
    };

    const inspected = openHarnessDatabase({ dbPath });
    try {
      const issue = selectOne<{ status: string }>(
        inspected.connection,
        'SELECT status FROM issues WHERE id = ?',
        ['issue-only'],
      );

      assert.equal(advanced.advanced, false);
      assert.deepEqual(advanced._meta.nextTools, [
        'harness_inspector',
      ]);
      assert.equal(issue?.status, 'done');
      assert.throws(() => tokenStore.resolve(started.sessionToken));
    } finally {
      inspected.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('harness_session resolves persisted session tokens after restart', async () => {
  const tempDir = createTempDir('token-restart-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    insertIssue({
      dbPath,
      issueId: 'issue-token',
      task: 'Recover token after restart',
      status: 'ready',
      nextBestAction: 'Begin through one server and continue in another.',
    });

    const server1 = new SessionLifecycleMcpServer(
      new SessionLifecycleAdapter(
        new SessionOrchestrator({
          mem0Adapter: new InMemoryMem0Adapter(),
          defaultCheckpointFreshnessSeconds: 3600,
        }),
      ),
    );
    const tools1 = (server1 as unknown as {
      tools: Map<string, { handler: (args: unknown) => Promise<unknown> }>;
    }).tools;
    const beginTool = tools1.get('harness_session');

    assert.ok(beginTool);

    const started = (await beginTool.handler({
      action: 'begin',
      sessionId: 'run-token',
      dbPath,
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      progressPath: '/tmp/progress.md',
      featureListPath: '/tmp/features.json',
      planPath: '/tmp/plan.md',
      syncManifestPath: '/tmp/manifest.yaml',
      mem0Enabled: false,
      agentId: 'agent-token',
      preferredIssueId: 'issue-token',
    })) as { sessionToken: string };

    const server2 = new SessionLifecycleMcpServer(
      new SessionLifecycleAdapter(
        new SessionOrchestrator({
          mem0Adapter: new InMemoryMem0Adapter(),
          defaultCheckpointFreshnessSeconds: 3600,
        }),
      ),
    );
    const tools2 = (server2 as unknown as {
      tools: Map<string, { handler: (args: unknown) => Promise<unknown> }>;
    }).tools;
    const sessionTool = tools2.get('harness_session');

    assert.ok(sessionTool);

    const checkpointed = (await sessionTool.handler({
      action: 'checkpoint',
      dbPath,
      sessionToken: started.sessionToken,
      input: {
        title: 'checkpoint',
        summary: 'Resolved persisted token from SQLite.',
        taskStatus: 'in_progress',
        nextStep: 'Close from the restarted server.',
      },
    })) as { result: { context: { issueId: string } } };
    const closed = (await sessionTool.handler({
      action: 'close',
      dbPath,
      sessionToken: started.sessionToken,
      closeInput: {
        title: 'close',
        summary: 'Closed after restart.',
        taskStatus: 'done',
        nextStep: 'Stop.',
      },
    })) as { result: { context: { issueId: string } } };

    const inspected = openHarnessDatabase({ dbPath });
    try {
      const activeSession = selectOne<{
        status: string;
        closed_at: string | null;
      }>(
        inspected.connection,
        'SELECT status, closed_at FROM active_sessions WHERE token = ?',
        [started.sessionToken],
      );

      assert.equal(checkpointed.result.context.issueId, 'issue-token');
      assert.equal(closed.result.context.issueId, 'issue-token');
      assert.equal(activeSession?.status, 'closed');
      assert.notEqual(activeSession?.closed_at, null);
    } finally {
      inspected.close();
    }
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

test('runtime rejects unsupported pre-v2 harness schemas', () => {
  const tempDir = createTempDir('legacy-schema-');
  const dbPath = join(tempDir, 'harness.sqlite');
  const legacy = new DatabaseSync(dbPath);

  try {
    legacy.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY
      );
      PRAGMA user_version = 1;
    `);
  } finally {
    legacy.close();
  }

  assert.throws(
    () => openHarnessDatabase({ dbPath }),
    /schema version 1 is no longer supported|schema v2/i,
  );

  rmSync(tempDir, { recursive: true, force: true });
});

test('CLI inspection and promotion commands work with default mem0 loader disabled', async () => {
  const tempDir = createTempDir('cli-no-mem0-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    insertIssue({
      dbPath,
      issueId: 'issue-cli-nomem0',
      task: 'Inspect without mem0',
      status: 'ready',
      nextBestAction: 'Exercise read-only commands.',
    });

    const overview = await runCliCommand(
      tempDir,
      {
        action: 'inspect_overview',
        input: {
          dbPath,
          projectId: 'project-1',
        },
      },
      { AGENT_HARNESS_DISABLE_DEFAULT_MEM0: '1' },
    );
    const issue = await runCliCommand(
      tempDir,
      {
        action: 'inspect_issue',
        input: {
          dbPath,
          issueId: 'issue-cli-nomem0',
        },
      },
      { AGENT_HARNESS_DISABLE_DEFAULT_MEM0: '1' },
    );
    const promoted = await runCliCommand(
      tempDir,
      {
        action: 'promote_queue',
        input: {
          dbPath,
          projectId: 'project-1',
        },
      },
      { AGENT_HARNESS_DISABLE_DEFAULT_MEM0: '1' },
    );

    assert.equal(overview.action, 'inspect_overview');
    assert.equal(overview.result.counts.readyIssues, 1);
    assert.equal(issue.result.issue.id, 'issue-cli-nomem0');
    assert.deepEqual(promoted.result.promotedIssueIds, []);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('two CLI begin processes cannot create two active leases for the same issue', async () => {
  const tempDir = createTempDir('cli-lease-race-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    insertIssue({
      dbPath,
      issueId: 'issue-race',
      task: 'Race on one preferred issue',
      status: 'ready',
      nextBestAction: 'Only one process may claim this.',
    });

    const command = (sessionId: string, agentId: string) => ({
      action: 'begin_incremental',
      input: {
        sessionId,
        dbPath,
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        progressPath: '/tmp/progress.md',
        featureListPath: '/tmp/features.json',
        planPath: '/tmp/plan.md',
        syncManifestPath: '/tmp/manifest.yaml',
        mem0Enabled: false,
        agentId,
        preferredIssueId: 'issue-race',
      },
    });

    const [first, second] = await Promise.all([
      runCliCommandRaw(
        tempDir,
        command('run-race-1', 'agent-race-1'),
        { AGENT_HARNESS_DISABLE_DEFAULT_MEM0: '1' },
      ),
      runCliCommandRaw(
        tempDir,
        command('run-race-2', 'agent-race-2'),
        { AGENT_HARNESS_DISABLE_DEFAULT_MEM0: '1' },
      ),
    ]);

    const successes = [first, second].filter((result) => result.code === 0);
    const failures = [first, second].filter((result) => result.code !== 0);

    assert.equal(successes.length, 1);
    assert.equal(failures.length, 1);
    assert.match(
      failures[0]?.stderr ?? '',
      /(already has an active lease|No ready issues are available|database is locked|not claimable from status in_progress)/i,
    );

    const inspected = openHarnessDatabase({ dbPath });
    try {
      const activeLeases = selectAll<{ agent_id: string }>(
        inspected.connection,
        `SELECT agent_id
         FROM leases
         WHERE issue_id = ?
           AND status = 'active'
           AND released_at IS NULL`,
        ['issue-race'],
      );

      assert.equal(activeLeases.length, 1);
    } finally {
      inspected.close();
    }
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
  createdAt: string = '2026-03-21T00:05:00.000Z',
): void {
  const database = openHarnessDatabase({ dbPath });

  try {
    runStatement(
      database.connection,
      `INSERT INTO checkpoints (
         id,
         run_id,
         issue_id,
         title,
         summary,
         task_status,
         next_step,
         artifact_ids_json,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        checkpointId,
        runId,
        issueId,
        title,
        'Old checkpoint evidence',
        'in_progress',
        'Inspect stale work.',
        '[]',
        createdAt,
      ],
    );
  } finally {
    database.close();
  }
}

async function runCliCommand(
  tempDir: string,
  command: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
): Promise<any> {
  const result = await runCliCommandRaw(tempDir, command, extraEnv);

  if (result.code !== 0) {
    throw new Error(result.stderr || `CLI exited with code ${result.code}`);
  }

  return JSON.parse(result.stdout);
}

async function runCliCommandRaw(
  tempDir: string,
  command: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cliPath = join(process.cwd(), 'dist/bin/session-lifecycle.js');
  const storePath = join(tempDir, 'mem0');

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', cliPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MEM0_STORE_PATH: storePath,
        OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
        MEM0_EMBED_MODEL: 'qwen3-embedding:latest',
        ...extraEnv,
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
      resolve({
        code: code ?? 0,
        stdout,
        stderr,
      });
    });

    child.stdin.write(JSON.stringify(command));
    child.stdin.end();
  });
}

function matchesScope(
  storedScope: any,
  requestedScope: any,
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
