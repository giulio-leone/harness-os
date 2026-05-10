import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  SESSION_LIFECYCLE_CLI_CONTRACT_VERSION,
  SessionLifecycleAdapter,
  SessionLifecycleInspector,
  SessionLifecycleMcpServer,
  SessionOrchestrator,
  openHarnessDatabase,
  promoteEligiblePendingIssues,
  runStatement,
  selectAll,
  selectOne,
} from '../index.js';
import { inspectOrchestration } from '../runtime/orchestration-inspector.js';

class InMemoryMem0Adapter implements Mem0Adapter {
  private readonly memories: PublicMemoryRecord[] = [];

  readonly metadata = {
    adapterId: 'in-memory-test',
    contractVersion: '1.0' as const,
    capabilities: {
      supportsRecall: true,
      supportsUpdate: false,
      supportsDelete: false,
      supportsWorkspaceList: false,
      supportsProjectList: false,
    },
  };

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

const TEST_HOST_ROUTING_CONTEXT: {
  host: string;
  hostCapabilities: {
    workloadClasses: string[];
    capabilities: string[];
  };
} = {
  host: 'host-1',
  hostCapabilities: {
    workloadClasses: ['default', 'typescript'],
    capabilities: ['node', 'sqlite'],
  },
};

const TEST_SESSION_ARTIFACTS = [
  { kind: 'session_handoff', path: '/tmp/progress.md' },
  { kind: 'task_catalog', path: '/tmp/features.json' },
  { kind: 'execution_plan', path: '/tmp/plan.md' },
  { kind: 'sync_manifest', path: '/tmp/manifest.yaml' },
] as const;

function buildTestSessionArtifacts(): Array<{
  kind: string;
  path: string;
}> {
  return TEST_SESSION_ARTIFACTS.map((artifact) => ({
    kind: artifact.kind,
    path: artifact.path,
  }));
}

function findArtifactPath(
  artifacts: Array<{ kind: string; path: string }>,
  kind: string,
): string | undefined {
  return artifacts.find((artifact) => artifact.kind === kind)?.path;
}

function withHostRoutingContext<
  T extends Record<string, unknown> & {
    host?: string;
    hostCapabilities?: typeof TEST_HOST_ROUTING_CONTEXT.hostCapabilities;
    artifacts?: Array<{ kind: string; path: string }>;
  },
>(input: T): T &
  typeof TEST_HOST_ROUTING_CONTEXT & {
    artifacts: Array<{ kind: string; path: string }>;
  } {
  return {
    ...input,
    host: input.host ?? TEST_HOST_ROUTING_CONTEXT.host,
    hostCapabilities:
      input.hostCapabilities ?? TEST_HOST_ROUTING_CONTEXT.hostCapabilities,
    artifacts: input.artifacts ?? buildTestSessionArtifacts(),
  } as T &
    typeof TEST_HOST_ROUTING_CONTEXT & {
      artifacts: Array<{ kind: string; path: string }>;
    };
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

    const firstSession = await orchestrator.beginIncrementalSession(withHostRoutingContext({
      sessionId: 'run-1',
      dbPath,
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      artifacts: buildTestSessionArtifacts(),
      mem0Enabled: true,
      agentId: 'agent-1',
      preferredIssueId: 'issue-1',
    }));
    const blocked = await orchestrator.checkpoint(firstSession, {
      title: 'blocked',
      summary: 'Blocked and waiting for recovery context.',
      taskStatus: 'blocked',
      nextStep: 'Resume after loading the derived memory.',
      blockedReason: 'manual_blocker:derived_memory_pending',
      artifactIds: ['artifact-1'],
    });
    const resumedSession = await orchestrator.beginIncrementalSession(withHostRoutingContext({
      sessionId: 'run-2',
      dbPath,
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      artifacts: buildTestSessionArtifacts(),
      mem0Enabled: true,
      agentId: 'agent-1',
      preferredIssueId: 'issue-1',
    }));
    const closed = await orchestrator.close(resumedSession, {
      title: 'close',
      summary: 'Completed after resume.',
      taskStatus: 'done',
      nextStep: 'Select the next ready issue.',
      artifactIds: ['artifact-2'],
    });

    const inspected = openHarnessDatabase({ dbPath });
    try {
      const issue = selectOne<{ status: string; blocked_reason: string | null }>(
        inspected.connection,
        'SELECT status, blocked_reason FROM issues WHERE id = ?',
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
      assert.equal(
        findArtifactPath(firstSession.artifacts, 'session_handoff'),
        '/tmp/progress.md',
      );
      assert.equal(
        findArtifactPath(firstSession.artifacts, 'execution_plan'),
        '/tmp/plan.md',
      );
      assert.equal(blocked.memoryId !== undefined, true);
      assert.equal(resumedSession.claimMode, 'resume');
      assert.equal(
        findArtifactPath(resumedSession.artifacts, 'sync_manifest'),
        '/tmp/manifest.yaml',
      );
      assert.equal(resumedSession.mem0.recalledMemories.length, 1);
      assert.equal(closed.memoryId !== undefined, true);
      assert.equal(issue?.status, 'done');
      assert.equal(issue?.blocked_reason, null);
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

test('orchestrator persists session artifacts through artifacts checkpoints and events', async () => {
  const tempDir = createTempDir('orchestrator-artifacts-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    insertIssue({
      dbPath,
      issueId: 'issue-artifact-flow',
      task: 'Persist artifact evidence through lifecycle state',
      status: 'ready',
      nextBestAction: 'Validate artifact persistence.',
    });

    const orchestrator = new SessionOrchestrator();
    const session = await orchestrator.beginIncrementalSession(withHostRoutingContext({
      sessionId: 'run-artifact-flow',
      dbPath,
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      artifacts: buildTestSessionArtifacts(),
      mem0Enabled: false,
      agentId: 'agent-artifacts',
      preferredIssueId: 'issue-artifact-flow',
    }));
    const artifactIds = session.artifacts.map((artifact) => artifact.id);

    assert.equal(artifactIds.every((artifactId) => artifactId !== undefined), true);

    const inspected = openHarnessDatabase({ dbPath });
    try {
      const persistedArtifacts = selectAll<{
        id: string;
        kind: string;
        path: string;
        metadata_json: string;
      }>(
        inspected.connection,
        `SELECT id, kind, path, metadata_json
         FROM artifacts
         WHERE issue_id = ?
         ORDER BY id ASC`,
        ['issue-artifact-flow'],
      );
      const claimCheckpoint = selectOne<{ artifact_ids_json: string }>(
        inspected.connection,
        `SELECT artifact_ids_json
         FROM checkpoints
         WHERE run_id = ? AND title = ?
         LIMIT 1`,
        ['run-artifact-flow', 'claim'],
      );
      const registeredEvent = selectOne<{ payload: string }>(
        inspected.connection,
        `SELECT payload
         FROM events
         WHERE run_id = ? AND kind = ?
         LIMIT 1`,
        ['run-artifact-flow', 'session_artifacts_registered'],
      );
      const persistedIds = persistedArtifacts.map((artifact) => artifact.id);
      const checkpointIds = parseJsonArray(claimCheckpoint?.artifact_ids_json);
      const registeredPayload = parseJsonObject(registeredEvent?.payload);

      assert.deepEqual(persistedIds, [...artifactIds].sort());
      assert.deepEqual(checkpointIds.sort(), persistedIds);
      assert.deepEqual(
        parseJsonArray(registeredPayload['artifactIds']).sort(),
        persistedIds,
      );
      assert.equal(
        persistedArtifacts.every((artifact) => {
          const metadata = parseJsonObject(artifact.metadata_json);
          return (
            metadata['source'] === 'session_orchestrator' &&
            metadata['runId'] === 'run-artifact-flow' &&
            metadata['status'] === 'active'
          );
        }),
        true,
      );
    } finally {
      inspected.close();
    }

    await orchestrator.close(session, {
      title: 'done',
      summary: 'Artifact evidence persisted and released.',
      taskStatus: 'done',
      nextStep: 'Continue with the next ready issue.',
      artifactIds: artifactIds.filter((id): id is string => id !== undefined),
    });

    const closed = openHarnessDatabase({ dbPath });
    try {
      const releasedArtifacts = selectAll<{ id: string; metadata_json: string }>(
        closed.connection,
        `SELECT id, metadata_json
         FROM artifacts
         WHERE issue_id = ?
         ORDER BY id ASC`,
        ['issue-artifact-flow'],
      );
      const releaseEvent = selectOne<{ payload: string }>(
        closed.connection,
        `SELECT payload
         FROM events
         WHERE run_id = ? AND kind = ?
         LIMIT 1`,
        ['run-artifact-flow', 'session_artifacts_released'],
      );
      const releasePayload = parseJsonObject(releaseEvent?.payload);

      assert.equal(
        releasedArtifacts.every((artifact) => {
          const metadata = parseJsonObject(artifact.metadata_json);
          return (
            metadata['status'] === 'released' &&
            metadata['finalTaskStatus'] === 'done' &&
            typeof metadata['releasedAt'] === 'string'
          );
        }),
        true,
      );
      assert.deepEqual(
        parseJsonArray(releasePayload['artifactIds']).sort(),
        releasedArtifacts.map((artifact) => artifact.id),
      );
    } finally {
      closed.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('orchestrator supersedes active worktree artifacts on resume', async () => {
  const tempDir = createTempDir('orchestrator-artifact-resume-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    insertIssue({
      dbPath,
      issueId: 'issue-resume-artifacts',
      task: 'Resume with an existing orchestration worktree artifact',
      status: 'ready',
      nextBestAction: 'Resume the same isolated worktree.',
    });

    const orchestrator = new SessionOrchestrator();
    const initialSession = await orchestrator.beginIncrementalSession(withHostRoutingContext({
      sessionId: 'run-resume-artifacts',
      dbPath,
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      artifacts: [
        {
          kind: 'orchestration_worktree',
          path: '/workspace/worktrees/issue-resume-artifacts',
        },
      ],
      mem0Enabled: false,
      agentId: 'agent-resume-artifacts',
      preferredIssueId: 'issue-resume-artifacts',
    }));
    const resumedSession = await orchestrator.beginIncrementalSession(withHostRoutingContext({
      sessionId: 'run-resume-artifacts',
      dbPath,
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      artifacts: initialSession.artifacts,
      mem0Enabled: false,
      agentId: 'agent-resume-artifacts',
      preferredIssueId: 'issue-resume-artifacts',
    }));

    const inspected = openHarnessDatabase({ dbPath });
    try {
      const artifacts = selectAll<{ id: string; metadata_json: string }>(
        inspected.connection,
        `SELECT id, metadata_json
         FROM artifacts
         WHERE issue_id = ? AND kind = ?
         ORDER BY created_at ASC, id ASC`,
        ['issue-resume-artifacts', 'orchestration_worktree'],
      );
      const statuses = artifacts.map(
        (artifact) => parseJsonObject(artifact.metadata_json)['status'],
      );
      const firstMetadata = parseJsonObject(artifacts[0]?.metadata_json);
      const summary = inspectOrchestration({ dbPath, projectId: 'project-1' });

      assert.deepEqual(statuses, ['released', 'active']);
      assert.notEqual(resumedSession.artifacts[0]?.id, initialSession.artifacts[0]?.id);
      assert.equal(artifacts[1]?.id, resumedSession.artifacts[0]?.id);
      assert.equal(firstMetadata['supersededByRunId'], 'run-resume-artifacts');
      assert.equal(
        summary.health.flags.some(
          (flag) => flag.kind === 'duplicate_active_worktree_artifact_path',
        ),
        false,
      );
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
        orchestrator.beginIncrementalSession(withHostRoutingContext({
          sessionId: 'run-blocked',
          dbPath,
          workspaceId: 'workspace-1',
          projectId: 'project-1',
          artifacts: buildTestSessionArtifacts(),
          mem0Enabled: true,
          agentId: 'agent-new',
        })),
      /Reconciliation is required/,
    );

    const inspected = openHarnessDatabase({ dbPath });
    try {
      const issue = selectOne<{ status: string; blocked_reason: string | null }>(
        inspected.connection,
        'SELECT status, blocked_reason FROM issues WHERE id = ?',
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
      assert.equal(issue?.blocked_reason, 'checkpoint_stale');
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

test('reconciliation records explicit lease_expired blocker reasons on issues', async () => {
  const tempDir = createTempDir('reconciliation-expired-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    insertIssue({
      dbPath,
      issueId: 'issue-expired',
      task: 'Recover expired lease before claiming',
      status: 'ready',
      nextBestAction: 'Inspect the expired lease first.',
    });
    seedRun(dbPath, 'run-expired', 'in_progress');
    seedLease(dbPath, 'lease-expired', 'issue-expired', 'active');

    const database = openHarnessDatabase({ dbPath });
    try {
      runStatement(
        database.connection,
        `UPDATE leases
         SET expires_at = ?
         WHERE id = ?`,
        ['2026-03-20T00:00:00.000Z', 'lease-expired'],
      );
    } finally {
      database.close();
    }

    const orchestrator = new SessionOrchestrator({
      mem0Adapter: new InMemoryMem0Adapter(),
      defaultCheckpointFreshnessSeconds: 60,
    });

    await assert.rejects(
      () =>
        orchestrator.beginIncrementalSession(withHostRoutingContext({
          sessionId: 'run-expired-blocked',
          dbPath,
          workspaceId: 'workspace-1',
          projectId: 'project-1',
          artifacts: buildTestSessionArtifacts(),
          mem0Enabled: true,
          agentId: 'agent-new',
        })),
      /Reconciliation is required/,
    );

    const inspected = openHarnessDatabase({ dbPath });
    try {
      const issue = selectOne<{ status: string; blocked_reason: string | null }>(
        inspected.connection,
        'SELECT status, blocked_reason FROM issues WHERE id = ?',
        ['issue-expired'],
      );
      assert.equal(issue?.status, 'needs_recovery');
      assert.equal(issue?.blocked_reason, 'lease_expired');
    } finally {
      inspected.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('concurrent begin_incremental calls keep stale lease reconciliation deterministic', async () => {
  const tempDir = createTempDir('reconciliation-load-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    insertIssue({
      dbPath,
      issueId: 'issue-stale-load',
      task: 'Recover stale work before new claims',
      status: 'ready',
      nextBestAction: 'Recover the stale lease first.',
    });
    insertIssue({
      dbPath,
      issueId: 'issue-ready-load',
      task: 'Stay ready until recovery is resolved',
      status: 'ready',
      nextBestAction: 'Wait for stale recovery to finish.',
    });
    seedRun(dbPath, 'run-stale-load', 'in_progress');
    seedLease(dbPath, 'lease-stale-load', 'issue-stale-load', 'active');
    seedCheckpoint(
      dbPath,
      'checkpoint-stale-load',
      'run-stale-load',
      'issue-stale-load',
      'claim',
    );

    const attempts = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        runCliCommandRaw(
          tempDir,
          buildBeginIncrementalCommand({
            sessionId: `run-blocked-${index + 1}`,
            dbPath,
            agentId: `agent-blocked-${index + 1}`,
          }),
          DISABLE_DEFAULT_MEM0_ENV,
        ),
      ),
    );

    attempts.forEach((result) => {
      assert.notEqual(result.code, 0);
      assert.match(
        result.stderr,
        /Reconciliation is required|Cannot claim new work while stale leases remain unresolved|database is locked/i,
      );
    });

    const inspected = openHarnessDatabase({ dbPath });
    try {
      const staleIssue = selectOne<{ status: string }>(
        inspected.connection,
        'SELECT status FROM issues WHERE id = ?',
        ['issue-stale-load'],
      );
      const readyIssue = selectOne<{ status: string }>(
        inspected.connection,
        'SELECT status FROM issues WHERE id = ?',
        ['issue-ready-load'],
      );
      const needsRecoveryLeases = selectAll<{ id: string }>(
        inspected.connection,
        `SELECT id
         FROM leases
         WHERE status = 'needs_recovery'
           AND released_at IS NULL`,
      );
      const activeLeases = selectAll<{ id: string }>(
        inspected.connection,
        `SELECT id
         FROM leases
         WHERE status = 'active'
           AND released_at IS NULL`,
      );
      const blockedRuns = selectAll<{ status: string }>(
        inspected.connection,
        `SELECT status
         FROM runs
         WHERE id LIKE 'run-blocked-%'
         ORDER BY id ASC`,
      );

      assert.equal(staleIssue?.status, 'needs_recovery');
      assert.equal(readyIssue?.status, 'ready');
      assert.equal(needsRecoveryLeases.length, 1);
      assert.equal(activeLeases.length, 0);
      assert.ok(blockedRuns.length >= 1);
      assert.ok(
        blockedRuns.every((run) => run.status === 'needs_recovery'),
      );
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
        orchestrator.beginIncrementalSession(withHostRoutingContext({
          sessionId: 'run-candidate',
          dbPath,
          workspaceId: 'workspace-1',
          projectId: 'project-1',
          artifacts: buildTestSessionArtifacts(),
          mem0Enabled: false,
          agentId: 'agent-candidate',
          preferredIssueId: 'issue-rollback',
        })),
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

    const started = await orchestrator.beginIncrementalSession(withHostRoutingContext({
      sessionId: 'run-mem0-failure',
      dbPath,
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      artifacts: buildTestSessionArtifacts(),
      mem0Enabled: true,
      agentId: 'agent-mem0-failure',
      preferredIssueId: 'issue-mem0-failure',
    }));
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

    const recoverySession = await orchestrator.beginRecoverySession(withHostRoutingContext({
      sessionId: 'run-recovery',
      dbPath,
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      artifacts: buildTestSessionArtifacts(),
      mem0Enabled: true,
      agentId: 'agent-recovery',
      preferredIssueId: 'issue-recovery',
      recoverySummary: 'Recover the flagged issue with a new lease.',
      recoveryNextStep: 'Continue under the fresh recovery lease.',
    }));
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

test('concurrent begin_recovery calls create one fresh recovery lease', async () => {
  const tempDir = createTempDir('recovery-race-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    insertIssue({
      dbPath,
      issueId: 'issue-recovery-race',
      task: 'Recover one issue under concurrent pressure',
      status: 'needs_recovery',
      nextBestAction: 'Recover this issue explicitly.',
    });
    seedLease(
      dbPath,
      'lease-recovery-race-old',
      'issue-recovery-race',
      'needs_recovery',
    );

    const attempts = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        runCliCommandRaw(
          tempDir,
          buildBeginRecoveryCommand({
            sessionId: `run-recovery-race-${index + 1}`,
            dbPath,
            agentId: `agent-recovery-race-${index + 1}`,
            preferredIssueId: 'issue-recovery-race',
            recoverySummary: `Recover attempt ${index + 1}.`,
            recoveryNextStep: 'Continue under the winning recovery lease.',
          }),
          DISABLE_DEFAULT_MEM0_ENV,
        ),
      ),
    );

    const successes = attempts.filter((result) => result.code === 0);
    const failures = attempts.filter((result) => result.code !== 0);

    assert.equal(successes.length, 1);
    assert.equal(failures.length, 3);

    const successPayload = JSON.parse(successes[0]?.stdout ?? '{}');
    assert.equal(successPayload.action, 'begin_recovery');
    assert.equal(successPayload.context?.claimMode, 'recovery');
    assert.equal(successPayload.context?.issueId, 'issue-recovery-race');

    failures.forEach((result) => {
      assert.match(
        result.stderr,
        /No needs_recovery issues are available|not recoverable from status in_progress|already has an active lease|database is locked/i,
      );
    });

    const inspected = openHarnessDatabase({ dbPath });
    try {
      const issue = selectOne<{ status: string }>(
        inspected.connection,
        'SELECT status FROM issues WHERE id = ?',
        ['issue-recovery-race'],
      );
      const leaseStatuses = selectAll<{ status: string }>(
        inspected.connection,
        `SELECT status
         FROM leases
         WHERE issue_id = ?
         ORDER BY acquired_at ASC`,
        ['issue-recovery-race'],
      );
      const activeLeases = selectAll<{ id: string }>(
        inspected.connection,
        `SELECT id
         FROM leases
         WHERE issue_id = ?
           AND status = 'active'
           AND released_at IS NULL`,
        ['issue-recovery-race'],
      );

      assert.equal(issue?.status, 'in_progress');
      assert.deepEqual(leaseStatuses.map((lease) => lease.status), [
        'recovered',
        'active',
      ]);
      assert.equal(activeLeases.length, 1);
    } finally {
      inspected.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('checkpoint rejects blockedReason unless taskStatus is blocked', async () => {
  const tempDir = createTempDir('checkpoint-blocked-reason-validation-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    insertIssue({
      dbPath,
      issueId: 'issue-invalid-blocked-reason',
      task: 'Reject invalid blocked reason combinations',
      status: 'ready',
      nextBestAction: 'Start the task.',
    });

    const orchestrator = new SessionOrchestrator({
      mem0Adapter: new InMemoryMem0Adapter(),
      defaultCheckpointFreshnessSeconds: 3600,
    });
    const session = await orchestrator.beginIncrementalSession(withHostRoutingContext({
      sessionId: 'run-invalid-blocked-reason',
      dbPath,
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      artifacts: buildTestSessionArtifacts(),
      mem0Enabled: false,
      agentId: 'agent-invalid-blocked-reason',
      preferredIssueId: 'issue-invalid-blocked-reason',
    }));

    await assert.rejects(
      () => orchestrator.checkpoint(session, {
        title: 'invalid',
        summary: 'This should be rejected.',
        taskStatus: 'done',
        nextStep: 'Stop.',
        blockedReason: 'issue_dependency:issue-other',
      }),
      /blockedReason can only be provided when taskStatus is blocked/,
    );
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

    const session = await orchestrator.beginIncrementalSession(withHostRoutingContext({
      sessionId: 'run-primary',
      dbPath,
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      artifacts: buildTestSessionArtifacts(),
      mem0Enabled: false,
      agentId: 'agent-primary',
      preferredIssueId: 'issue-primary',
    }));
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

    const nextSession = await orchestrator.beginIncrementalSession(withHostRoutingContext({
      sessionId: 'run-followup',
      dbPath,
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      artifacts: buildTestSessionArtifacts(),
      mem0Enabled: false,
      agentId: 'agent-primary',
    }));

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
      artifacts: buildTestSessionArtifacts(),
      mem0Enabled: false,
      agentId: 'agent-mcp',
      preferredIssueId: 'issue-only',
      ...TEST_HOST_ROUTING_CONTEXT,
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
      artifacts: buildTestSessionArtifacts(),
      mem0Enabled: false,
      agentId: 'agent-token',
      preferredIssueId: 'issue-token',
      ...TEST_HOST_ROUTING_CONTEXT,
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
    })) as {
      result: {
        context: { issueId: string; artifacts: Array<{ kind: string; path: string }> };
      };
    };
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
    })) as {
      result: {
        context: { issueId: string; artifacts: Array<{ kind: string; path: string }> };
      };
    };

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
      assert.equal(
        findArtifactPath(closed.result.context.artifacts, 'task_catalog'),
        '/tmp/features.json',
      );
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
        artifacts: buildTestSessionArtifacts(),
        mem0Enabled: false,
        agentId: 'cli-agent-recovery',
        host: TEST_HOST_ROUTING_CONTEXT.host,
        hostCapabilities: TEST_HOST_ROUTING_CONTEXT.hostCapabilities,
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
        artifacts: buildTestSessionArtifacts(),
        mem0Enabled: false,
        agentId: 'cli-agent',
        host: TEST_HOST_ROUTING_CONTEXT.host,
        hostCapabilities: TEST_HOST_ROUTING_CONTEXT.hostCapabilities,
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
      action: 'inspect_export',
      input: {
        dbPath,
        projectId: 'project-1',
      },
    });
    const issue = await runCliCommand(tempDir, {
      action: 'inspect_audit',
      input: {
        dbPath,
        issueId: 'issue-cli',
      },
    });

    assert.equal(recovery.action, 'begin_recovery');
    assert.equal(begin.action, 'begin_incremental');
    assert.equal(checkpoint.action, 'checkpoint');
    assert.equal(overview.action, 'inspect_export');
    assert.equal(issue.action, 'inspect_audit');
    assert.equal(overview.result.queue.statusCounts.ready ?? 0, 0);
    assert.equal(overview.result.queue.statusCounts.needs_recovery ?? 0, 0);
    assert.equal(issue.result.issue.status, 'done');
    assert.equal(issue.result.evidence.checkpoints.length, 3);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('CLI begin_incremental auto-generates sessionId when omitted', async () => {
  const tempDir = createTempDir('cli-autogen-session-id-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    insertIssue({
      dbPath,
      issueId: 'issue-cli-autogen',
      task: 'Allow begin without caller session id',
      status: 'ready',
      nextBestAction: 'Let the CLI generate the run id.',
    });

    const begin = await runCliCommand(tempDir, {
      action: 'begin_incremental',
      input: {
        dbPath,
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        artifacts: buildTestSessionArtifacts(),
        mem0Enabled: false,
        host: TEST_HOST_ROUTING_CONTEXT.host,
        hostCapabilities: TEST_HOST_ROUTING_CONTEXT.hostCapabilities,
        preferredIssueId: 'issue-cli-autogen',
      },
    });

    assert.equal(begin.action, 'begin_incremental');
    assert.match(begin.context.sessionId, /^RUN-[0-9a-f-]{36}$/i);
    assert.equal(begin.context.runId, begin.context.sessionId);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('CLI rejects missing contractVersion at the public boundary', async () => {
  const tempDir = createTempDir('cli-missing-contract-version-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    insertIssue({
      dbPath,
      issueId: 'issue-cli-missing-contract',
      task: 'Reject missing CLI contract version',
      status: 'ready',
      nextBestAction: 'Fail fast on stale payloads.',
    });

    const result = await runCliCommandRaw(
      tempDir,
      {
        action: 'begin_incremental',
        input: {
          dbPath,
          workspaceId: 'workspace-1',
          projectId: 'project-1',
          artifacts: buildTestSessionArtifacts(),
          mem0Enabled: false,
          host: TEST_HOST_ROUTING_CONTEXT.host,
          hostCapabilities: TEST_HOST_ROUTING_CONTEXT.hostCapabilities,
          preferredIssueId: 'issue-cli-missing-contract',
        },
      },
      DISABLE_DEFAULT_MEM0_ENV,
      false,
    );

    assert.equal(result.code, 1);
    assert.match(result.stderr, /contractVersion/i);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('CLI rejects stale contractVersion at the public boundary', async () => {
  const tempDir = createTempDir('cli-stale-contract-version-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    insertIssue({
      dbPath,
      issueId: 'issue-cli-stale-contract',
      task: 'Reject stale CLI contract version',
      status: 'ready',
      nextBestAction: 'Fail fast on stale payloads.',
    });

    const result = await runCliCommandRaw(
      tempDir,
      {
        contractVersion: '2.0.0',
        action: 'begin_incremental',
        input: {
          dbPath,
          workspaceId: 'workspace-1',
          projectId: 'project-1',
          artifacts: buildTestSessionArtifacts(),
          mem0Enabled: false,
          host: TEST_HOST_ROUTING_CONTEXT.host,
          hostCapabilities: TEST_HOST_ROUTING_CONTEXT.hostCapabilities,
          preferredIssueId: 'issue-cli-stale-contract',
        },
      },
      DISABLE_DEFAULT_MEM0_ENV,
      false,
    );

    assert.equal(result.code, 1);
    assert.match(result.stderr, /contractVersion/i);
    assert.match(result.stderr, /6\.0\.0/i);
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
      action: 'inspect_export',
      input: {
        dbPath,
        projectId: 'project-1',
      },
    });

    assert.equal(promoted.action, 'promote_queue');
    assert.deepEqual(promoted.result.promotedIssueIds, ['issue-promoted']);
    assert.equal(overview.result.queue.statusCounts.ready, 1);
    assert.equal(overview.result.queue.readyIssues[0].id, 'issue-promoted');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('promote_queue records dependency blocker reasons and next_action explains them', async () => {
  const tempDir = createTempDir('queue-blocked-reasons-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    insertIssue({
      dbPath,
      issueId: 'issue-dependency',
      task: 'Finish the dependency first',
      status: 'in_progress',
      nextBestAction: 'Complete the dependency first.',
    });
    insertIssue({
      dbPath,
      issueId: 'issue-blocked',
      task: 'Wait for the dependency',
      status: 'pending',
      dependsOn: ['issue-dependency'],
      nextBestAction: 'Wait for issue-dependency.',
    });

    const database = openHarnessDatabase({ dbPath });
    try {
      const promoted = promoteEligiblePendingIssues(database.connection, {
        projectId: 'project-1',
      });
      assert.deepEqual(promoted, []);
    } finally {
      database.close();
    }

    const inspector = new SessionLifecycleInspector();
    const overview = inspector.inspectExport({
      dbPath,
      projectId: 'project-1',
    }) as {
      queue: {
        blockedIssues: Array<{ id: string; status: string; blockedReason?: string }>;
      };
    };
    const issueDetails = inspector.inspectAudit({
      dbPath,
      issueId: 'issue-blocked',
    }) as {
      issue: { id: string; blockedReason?: string };
    };

    const inspected = openHarnessDatabase({ dbPath });
    try {
      const blockedIssue = selectOne<{ blocked_reason: string | null }>(
        inspected.connection,
        'SELECT blocked_reason FROM issues WHERE id = ?',
        ['issue-blocked'],
      );

      assert.equal(
        blockedIssue?.blocked_reason,
        'issue_dependency:issue-dependency',
      );
    } finally {
      inspected.close();
    }

    const server = new SessionLifecycleMcpServer(
      new SessionLifecycleAdapter(
        new SessionOrchestrator({
          mem0Adapter: new InMemoryMem0Adapter(),
          defaultCheckpointFreshnessSeconds: 3600,
        }),
      ),
    );
    const inspectorTool = (
      server as unknown as {
        tools: Map<string, { handler: (args: unknown) => Promise<unknown> }>;
      }
    ).tools.get('harness_inspector');

    assert.ok(inspectorTool);

    const nextAction = (await inspectorTool.handler({
      action: 'next_action',
      dbPath,
      projectId: 'project-1',
      host: TEST_HOST_ROUTING_CONTEXT.host,
      hostCapabilities: TEST_HOST_ROUTING_CONTEXT.hostCapabilities,
    })) as {
      action: string;
      tool?: string;
      reason: string;
      suggestedPayload?: { action?: string; issueId?: string };
      context?: {
        stage: string;
        priority: number;
        issue?: { id: string; status: string; blockedReason?: string | null };
        blocker?: { kind: string; refId: string; refType: string; code: string };
        blockingIssue?: { id: string; status: string; nextBestAction?: string | null };
      };
    };

    assert.equal(overview.queue.blockedIssues.length, 1);
    assert.equal(overview.queue.blockedIssues[0]?.id, 'issue-blocked');
    assert.equal(overview.queue.blockedIssues[0]?.status, 'pending');
    assert.equal(
      overview.queue.blockedIssues[0]?.blockedReason,
      'issue_dependency:issue-dependency',
    );
    assert.equal(issueDetails.issue.id, 'issue-blocked');
    assert.equal(
      issueDetails.issue.blockedReason,
      'issue_dependency:issue-dependency',
    );
    assert.equal(nextAction.action, 'call_tool');
    assert.equal(nextAction.tool, 'harness_inspector');
    assert.match(nextAction.reason, /issue-dependency/);
    assert.equal(nextAction.suggestedPayload?.action, 'audit');
    assert.equal(nextAction.suggestedPayload?.issueId, 'issue-blocked');
    assert.equal(nextAction.context?.stage, 'blocked_issue');
    assert.equal(nextAction.context?.priority, 4);
    assert.equal(nextAction.context?.issue?.id, 'issue-blocked');
    assert.equal(nextAction.context?.issue?.status, 'pending');
    assert.equal(
      nextAction.context?.issue?.blockedReason,
      'issue_dependency:issue-dependency',
    );
    assert.equal(nextAction.context?.blocker?.kind, 'issue_dependency');
    assert.equal(nextAction.context?.blocker?.refId, 'issue-dependency');
    assert.equal(nextAction.context?.blocker?.refType, 'issue');
    assert.equal(
      nextAction.context?.blocker?.code,
      'issue_dependency:issue-dependency',
    );
    assert.equal(nextAction.context?.blockingIssue?.id, 'issue-dependency');
    assert.equal(nextAction.context?.blockingIssue?.status, 'in_progress');
    assert.equal(
      nextAction.context?.blockingIssue?.nextBestAction,
      'Complete the dependency first.',
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('promote_queue records milestone blocker reasons and overview exposes blocked milestones', () => {
  const tempDir = createTempDir('milestone-blocked-reasons-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    insertMilestone({
      dbPath,
      milestoneId: 'milestone-root',
      description: 'Root milestone',
      status: 'pending',
    });
    insertMilestone({
      dbPath,
      milestoneId: 'milestone-child',
      description: 'Child milestone',
      status: 'pending',
      dependsOn: ['milestone-root'],
    });
    insertIssue({
      dbPath,
      issueId: 'issue-milestone-blocked',
      milestoneId: 'milestone-child',
      task: 'Wait for the parent milestone',
      status: 'pending',
      nextBestAction: 'Wait for milestone-root.',
    });

    const database = openHarnessDatabase({ dbPath });
    try {
      const promoted = promoteEligiblePendingIssues(database.connection, {
        projectId: 'project-1',
      });
      assert.deepEqual(promoted, []);
    } finally {
      database.close();
    }

    const inspected = openHarnessDatabase({ dbPath });
    try {
      const milestone = selectOne<{ status: string; blocked_reason: string | null }>(
        inspected.connection,
        'SELECT status, blocked_reason FROM milestones WHERE id = ?',
        ['milestone-child'],
      );
      const issue = selectOne<{ status: string; blocked_reason: string | null }>(
        inspected.connection,
        'SELECT status, blocked_reason FROM issues WHERE id = ?',
        ['issue-milestone-blocked'],
      );

      assert.equal(milestone?.status, 'blocked');
      assert.equal(
        milestone?.blocked_reason,
        'milestone_dependency:milestone-root',
      );
      assert.equal(issue?.status, 'pending');
      assert.equal(
        issue?.blocked_reason,
        'milestone_dependency:milestone-root',
      );
    } finally {
      inspected.close();
    }

    const overview = new SessionLifecycleInspector().inspectExport({
      dbPath,
      projectId: 'project-1',
    }) as {
      queue: {
        blockedMilestones: Array<{ id: string; blockedReason?: string }>;
      };
    };

    assert.equal(overview.queue.blockedMilestones.length, 1);
    assert.equal(overview.queue.blockedMilestones[0]?.id, 'milestone-child');
    assert.equal(
      overview.queue.blockedMilestones[0]?.blockedReason,
      'milestone_dependency:milestone-root',
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('promote_queue clears blocker reasons when dependencies complete and dependents become ready', () => {
  const tempDir = createTempDir('queue-unblock-drill-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    insertIssue({
      dbPath,
      issueId: 'issue-dependency-drill',
      task: 'Complete the dependency first',
      status: 'in_progress',
      nextBestAction: 'Finish the dependency.',
    });
    insertIssue({
      dbPath,
      issueId: 'issue-independent-drill',
      task: 'Promote independently',
      status: 'pending',
      nextBestAction: 'Promote immediately.',
    });
    insertIssue({
      dbPath,
      issueId: 'issue-blocked-drill',
      task: 'Wait for the dependency to complete',
      status: 'pending',
      dependsOn: ['issue-dependency-drill'],
      nextBestAction: 'Wait for issue-dependency-drill.',
    });

    const firstPass = openHarnessDatabase({ dbPath });
    try {
      const promoted = promoteEligiblePendingIssues(firstPass.connection, {
        projectId: 'project-1',
      });

      assert.deepEqual(promoted.map((issue) => issue.id), [
        'issue-independent-drill',
      ]);
    } finally {
      firstPass.close();
    }

    const afterFirstPass = openHarnessDatabase({ dbPath });
    try {
      const blockedIssue = selectOne<{ status: string; blocked_reason: string | null }>(
        afterFirstPass.connection,
        'SELECT status, blocked_reason FROM issues WHERE id = ?',
        ['issue-blocked-drill'],
      );
      const independentIssue = selectOne<{ status: string; blocked_reason: string | null }>(
        afterFirstPass.connection,
        'SELECT status, blocked_reason FROM issues WHERE id = ?',
        ['issue-independent-drill'],
      );

      assert.equal(blockedIssue?.status, 'pending');
      assert.equal(
        blockedIssue?.blocked_reason,
        'issue_dependency:issue-dependency-drill',
      );
      assert.equal(independentIssue?.status, 'ready');
      assert.equal(independentIssue?.blocked_reason, null);

      runStatement(
        afterFirstPass.connection,
        `UPDATE issues
         SET status = 'done', blocked_reason = NULL
         WHERE id = ?`,
        ['issue-dependency-drill'],
      );
    } finally {
      afterFirstPass.close();
    }

    const secondPass = openHarnessDatabase({ dbPath });
    try {
      const promoted = promoteEligiblePendingIssues(secondPass.connection, {
        projectId: 'project-1',
      });

      assert.deepEqual(promoted.map((issue) => issue.id), [
        'issue-blocked-drill',
      ]);
    } finally {
      secondPass.close();
    }

    const afterSecondPass = openHarnessDatabase({ dbPath });
    try {
      const blockedIssue = selectOne<{ status: string; blocked_reason: string | null }>(
        afterSecondPass.connection,
        'SELECT status, blocked_reason FROM issues WHERE id = ?',
        ['issue-blocked-drill'],
      );

      assert.equal(blockedIssue?.status, 'ready');
      assert.equal(blockedIssue?.blocked_reason, null);
    } finally {
      afterSecondPass.close();
    }
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
    /Harness schema version mismatch/,
  );

  rmSync(tempDir, { recursive: true, force: true });
});

test('openHarnessDatabase rejects v3 databases with an explicit recreate instruction', () => {
  const tempDir = createTempDir('schema-v3-hard-break-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    const raw = new DatabaseSync(dbPath);
    try {
      raw.exec('PRAGMA journal_mode = WAL');
      raw.exec('PRAGMA foreign_keys = OFF');
      const schemaPath = join(
        import.meta.dirname ?? '.',
        '..', 'db', 'sqlite.schema.sql',
      );
      const schemaSql = readFileSync(schemaPath, 'utf8');
      raw.exec(schemaSql);
      raw.exec('PRAGMA user_version = 3');
    } finally {
      raw.close();
    }

    assert.throws(
      () => openHarnessDatabase({ dbPath }),
      /expected v5, got v3.*Backward compatibility is disabled.*recreate the harness database/i,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
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
        action: 'inspect_export',
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
        action: 'inspect_audit',
        input: {
          dbPath,
          issueId: 'issue-cli-nomem0',
        },
      },
      { AGENT_HARNESS_DISABLE_DEFAULT_MEM0: '1' },
    );
    const healthSnapshot = await runCliCommand(
      tempDir,
      {
        action: 'inspect_health_snapshot',
        input: {
          dbPath,
          projectId: 'project-1',
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

    assert.equal(overview.action, 'inspect_export');
    assert.equal(overview.result.queue.statusCounts.ready, 1);
    assert.equal(issue.result.issue.id, 'issue-cli-nomem0');
    assert.equal(healthSnapshot.action, 'inspect_health_snapshot');
    assert.equal(healthSnapshot.result.snapshotVersion, 1);
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
        artifacts: buildTestSessionArtifacts(),
        mem0Enabled: false,
        agentId,
        host: TEST_HOST_ROUTING_CONTEXT.host,
        hostCapabilities: TEST_HOST_ROUTING_CONTEXT.hostCapabilities,
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

test('many CLI begin processes still create only one active lease for the same issue', async () => {
  const tempDir = createTempDir('cli-lease-stress-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    insertIssue({
      dbPath,
      issueId: 'issue-race-stress',
      task: 'Race on one preferred issue under load',
      status: 'ready',
      nextBestAction: 'Only one process may claim this issue.',
    });

    const attempts = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        runCliCommandRaw(
          tempDir,
          buildBeginIncrementalCommand({
            sessionId: `run-race-stress-${index + 1}`,
            dbPath,
            agentId: `agent-race-stress-${index + 1}`,
            preferredIssueId: 'issue-race-stress',
          }),
          DISABLE_DEFAULT_MEM0_ENV,
        ),
      ),
    );

    const successes = attempts.filter((result) => result.code === 0);
    const failures = attempts.filter((result) => result.code !== 0);

    assert.equal(successes.length, 1);
    assert.equal(failures.length, 5);

    const successPayload = JSON.parse(successes[0]?.stdout ?? '{}');
    assert.equal(successPayload.action, 'begin_incremental');
    assert.equal(successPayload.context?.claimMode, 'claim');
    assert.equal(successPayload.context?.issueId, 'issue-race-stress');

    failures.forEach((result) => {
      assert.match(
        result.stderr,
        /(already has an active lease|No ready issues are available|database is locked|not claimable from status in_progress)/i,
      );
    });

    const inspected = openHarnessDatabase({ dbPath });
    try {
      const activeLeases = selectAll<{ agent_id: string }>(
        inspected.connection,
        `SELECT agent_id
         FROM leases
         WHERE issue_id = ?
           AND status = 'active'
           AND released_at IS NULL`,
        ['issue-race-stress'],
      );

      assert.equal(activeLeases.length, 1);
    } finally {
      inspected.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('policy-driven escalation reorders overview and begin() while exposing policy state', async () => {
  const tempDir = createTempDir('policy-dispatch-order-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    insertIssue({
      dbPath,
      issueId: 'issue-standard',
      task: 'Handle routine work',
      status: 'ready',
      nextBestAction: 'Claim the standard task.',
      priority: 'high',
      createdAt: '2026-04-02T11:45:00.000Z',
    });
    insertIssue({
      dbPath,
      issueId: 'issue-policy-escalated',
      task: 'Handle overdue work',
      status: 'ready',
      nextBestAction: 'Claim the overdue task first.',
      priority: 'low',
      createdAt: '2026-04-01T10:00:00.000Z',
      deadlineAt: '2026-04-02T09:00:00.000Z',
      policy: {
        escalationRules: [
          {
            trigger: 'deadline_breached',
            action: 'raise_priority',
            priority: 'critical',
          },
        ],
      },
    });

    const inspector = new SessionLifecycleInspector();
    const overview = inspector.inspectExport({
      dbPath,
      projectId: 'project-1',
    }) as {
      queue: {
        readyIssues: Array<{
          id: string;
          deadlineAt?: string;
          policyState?: {
            effectivePriority: string;
            escalated: boolean;
            breaches: Array<{ trigger: string; action: string; priority?: string }>;
          };
        }>;
      };
    };
    const issueDetails = inspector.inspectAudit({
      dbPath,
      issueId: 'issue-policy-escalated',
    }) as {
      issue: {
        id: string;
        deadlineAt?: string;
        policyState?: {
          effectivePriority: string;
          escalated: boolean;
          breaches: Array<{ trigger: string; action: string; priority?: string }>;
        };
      };
    };

    const orchestrator = new SessionOrchestrator({
      mem0Adapter: new InMemoryMem0Adapter(),
      defaultCheckpointFreshnessSeconds: 3600,
    });
    const session = await orchestrator.beginIncrementalSession(withHostRoutingContext({
      sessionId: 'run-policy-order',
      dbPath,
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      artifacts: buildTestSessionArtifacts(),
      mem0Enabled: false,
      agentId: 'policy-agent',
    }));

    assert.equal(overview.queue.readyIssues[0]?.id, 'issue-policy-escalated');
    assert.equal(
      overview.queue.readyIssues[0]?.deadlineAt,
      '2026-04-02T09:00:00.000Z',
    );
    assert.equal(
      overview.queue.readyIssues[0]?.policyState?.effectivePriority,
      'critical',
    );
    assert.equal(overview.queue.readyIssues[0]?.policyState?.escalated, true);
    assert.equal(
      overview.queue.readyIssues[0]?.policyState?.breaches[0]?.trigger,
      'deadline_breached',
    );
    assert.equal(
      overview.queue.readyIssues[0]?.policyState?.breaches[0]?.action,
      'raise_priority',
    );
    assert.equal(
      overview.queue.readyIssues[0]?.policyState?.breaches[0]?.priority,
      'critical',
    );
    assert.equal(issueDetails.issue.id, 'issue-policy-escalated');
    assert.equal(
      issueDetails.issue.deadlineAt,
      '2026-04-02T09:00:00.000Z',
    );
    assert.equal(
      issueDetails.issue.policyState?.effectivePriority,
      'critical',
    );
    assert.equal(issueDetails.issue.policyState?.escalated, true);
    assert.equal(session.issueId, 'issue-policy-escalated');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('host routing context filters dispatchable issues before claim ordering', async () => {
  const tempDir = createTempDir('host-routing-dispatch-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    insertIssue({
      dbPath,
      issueId: 'issue-python',
      task: 'Handle Python-only workload',
      status: 'ready',
      nextBestAction: 'Claim the Python task.',
      priority: 'critical',
      policy: {
        dispatch: {
          workloadClass: 'python',
          requiredHostCapabilities: ['python'],
        },
      },
    });
    insertIssue({
      dbPath,
      issueId: 'issue-typescript',
      task: 'Handle TypeScript workload',
      status: 'ready',
      nextBestAction: 'Claim the TypeScript task.',
      priority: 'low',
      policy: {
        dispatch: {
          workloadClass: 'typescript',
          requiredHostCapabilities: ['sqlite'],
        },
      },
    });

    const orchestrator = new SessionOrchestrator({
      mem0Adapter: new InMemoryMem0Adapter(),
      defaultCheckpointFreshnessSeconds: 3600,
    });
    const session = await orchestrator.beginIncrementalSession(
      withHostRoutingContext({
        sessionId: 'run-routing-match',
        dbPath,
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        artifacts: buildTestSessionArtifacts(),
        mem0Enabled: false,
        agentId: 'routing-agent',
      }),
    );

    assert.equal(session.issueId, 'issue-typescript');

    await assert.rejects(
      () =>
        orchestrator.beginIncrementalSession({
          sessionId: 'run-routing-mismatch',
          dbPath,
          workspaceId: 'workspace-1',
          projectId: 'project-1',
          artifacts: buildTestSessionArtifacts(),
          mem0Enabled: false,
          agentId: 'routing-agent',
          preferredIssueId: 'issue-python',
          host: 'host-1',
          hostCapabilities: {
            workloadClasses: ['typescript'],
            capabilities: ['node', 'sqlite'],
          },
        }),
      /cannot be dispatched to host "host-1": requires workload class "python", requires host capability "python"/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('begin clears stale blocked_reason when a ready issue moves to in_progress', async () => {
  const tempDir = createTempDir('claim-clears-blocked-reason-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    insertIssue({
      dbPath,
      issueId: 'issue-cleared-blocker',
      task: 'Resume cleanly',
      status: 'ready',
      nextBestAction: 'Start the task.',
      blockedReason: 'issue_dependency:stale-reference',
    });

    const orchestrator = new SessionOrchestrator({
      mem0Adapter: new InMemoryMem0Adapter(),
      defaultCheckpointFreshnessSeconds: 3600,
    });
    await orchestrator.beginIncrementalSession(withHostRoutingContext({
      sessionId: 'run-clear-blocker',
      dbPath,
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      artifacts: buildTestSessionArtifacts(),
      mem0Enabled: false,
      agentId: 'agent-clear-blocker',
      preferredIssueId: 'issue-cleared-blocker',
    }));

    const inspected = openHarnessDatabase({ dbPath });
    try {
      const issue = selectOne<{ status: string; blocked_reason: string | null }>(
        inspected.connection,
        'SELECT status, blocked_reason FROM issues WHERE id = ?',
        ['issue-cleared-blocker'],
      );

      assert.equal(issue?.status, 'in_progress');
      assert.equal(issue?.blocked_reason, null);
    } finally {
      inspected.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------- Issue #4: schema validation coverage ----------

test('openHarnessDatabase rejects schema-v5 DB with missing workspaces table', () => {
  const tempDir = createTempDir('schema-no-workspaces-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    const raw = new DatabaseSync(dbPath);
    try {
      raw.exec('PRAGMA journal_mode = WAL');
      raw.exec('PRAGMA foreign_keys = OFF');
      const schemaPath = join(
        import.meta.dirname ?? '.',
        '..', 'db', 'sqlite.schema.sql',
      );
      const schemaSql = readFileSync(schemaPath, 'utf8');
      raw.exec(schemaSql);
      raw.exec(`PRAGMA user_version = 5`);
      raw.exec('DROP TABLE workspaces');
    } finally {
      raw.close();
    }

    assert.throws(
      () => openHarnessDatabase({ dbPath }),
      /table:workspaces/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('openHarnessDatabase rejects schema-v5 DB with missing projects table', () => {
  const tempDir = createTempDir('schema-no-projects-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    const raw = new DatabaseSync(dbPath);
    try {
      raw.exec('PRAGMA journal_mode = WAL');
      raw.exec('PRAGMA foreign_keys = OFF');
      const schemaPath = join(
        import.meta.dirname ?? '.',
        '..', 'db', 'sqlite.schema.sql',
      );
      const schemaSql = readFileSync(schemaPath, 'utf8');
      raw.exec(schemaSql);
      raw.exec(`PRAGMA user_version = 5`);
      raw.exec('DROP TABLE projects');
    } finally {
      raw.close();
    }

    assert.throws(
      () => openHarnessDatabase({ dbPath }),
      /table:projects/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('openHarnessDatabase rejects schema-v5 DB with missing issues table', () => {
  const tempDir = createTempDir('schema-no-issues-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    const raw = new DatabaseSync(dbPath);
    try {
      raw.exec('PRAGMA journal_mode = WAL');
      raw.exec('PRAGMA foreign_keys = OFF');
      const schemaPath = join(
        import.meta.dirname ?? '.',
        '..', 'db', 'sqlite.schema.sql',
      );
      const schemaSql = readFileSync(schemaPath, 'utf8');
      raw.exec(schemaSql);
      raw.exec(`PRAGMA user_version = 5`);
      raw.exec('DROP TABLE issues');
    } finally {
      raw.close();
    }

    assert.throws(
      () => openHarnessDatabase({ dbPath }),
      /table:issues/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('openHarnessDatabase rejects schema-v5 DB with missing critical index', () => {
  const tempDir = createTempDir('schema-no-idx-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    const raw = new DatabaseSync(dbPath);
    try {
      raw.exec('PRAGMA journal_mode = WAL');
      raw.exec('PRAGMA foreign_keys = OFF');
      const schemaPath = join(
        import.meta.dirname ?? '.',
        '..', 'db', 'sqlite.schema.sql',
      );
      const schemaSql = readFileSync(schemaPath, 'utf8');
      raw.exec(schemaSql);
      raw.exec(`PRAGMA user_version = 5`);
      raw.exec('DROP INDEX idx_leases_unique_active_issue');
    } finally {
      raw.close();
    }

    assert.throws(
      () => openHarnessDatabase({ dbPath }),
      /index:idx_leases_unique_active_issue/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------- Issue #5: schema migration path ----------

test('openHarnessDatabase rejects unversioned DB as corrupted', () => {
  const tempDir = createTempDir('schema-unversioned-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    const raw = new DatabaseSync(dbPath);
    try {
      raw.exec('PRAGMA journal_mode = WAL');
      raw.exec('PRAGMA foreign_keys = OFF');
      const schemaPath = join(
        import.meta.dirname ?? '.',
        '..', 'db', 'sqlite.schema.sql',
      );
      const schemaSql = readFileSync(schemaPath, 'utf8');
      raw.exec(schemaSql);
      // Deliberately leave user_version at 0
    } finally {
      raw.close();
    }

    assert.throws(
      () => openHarnessDatabase({ dbPath }),
      /Harness schema version mismatch/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('openHarnessDatabase rejects newer schema with upgrade hint', () => {
  const tempDir = createTempDir('schema-future-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    const raw = new DatabaseSync(dbPath);
    try {
      raw.exec('PRAGMA journal_mode = WAL');
      raw.exec('PRAGMA foreign_keys = OFF');
      const schemaPath = join(
        import.meta.dirname ?? '.',
        '..', 'db', 'sqlite.schema.sql',
      );
      const schemaSql = readFileSync(schemaPath, 'utf8');
      raw.exec(schemaSql);
      raw.exec('PRAGMA user_version = 999');
    } finally {
      raw.close();
    }

    assert.throws(
      () => openHarnessDatabase({ dbPath }),
      /Harness schema version mismatch/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('openHarnessDatabase distinguishes non-harness DB from corrupted harness DB', () => {
  const tempDir = createTempDir('schema-foreign-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    const raw = new DatabaseSync(dbPath);
    try {
      raw.exec('CREATE TABLE random_table (id TEXT PRIMARY KEY)');
    } finally {
      raw.close();
    }

    assert.throws(
      () => openHarnessDatabase({ dbPath }),
      /not a current agent-harness database/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------- Issue #3: campaign-scoped lease resume ----------

test('begin with campaignId resumes only same-campaign lease', async () => {
  const tempDir = createTempDir('campaign-scope-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);

    const database = openHarnessDatabase({ dbPath });
    try {
      // Create campaign A and campaign B
      runStatement(database.connection,
        `INSERT INTO campaigns (id, project_id, name, objective, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ['camp-a', 'project-1', 'Campaign A', 'objective-a', 'active', '2026-03-21T00:00:00.000Z', '2026-03-21T00:00:00.000Z']);
      runStatement(database.connection,
        `INSERT INTO campaigns (id, project_id, name, objective, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ['camp-b', 'project-1', 'Campaign B', 'objective-b', 'active', '2026-03-21T00:00:00.000Z', '2026-03-21T00:00:00.000Z']);

      // Issue in campaign A (ready) and campaign B (ready)
      runStatement(database.connection,
        `INSERT INTO issues (id, project_id, campaign_id, milestone_id, task, priority, status, size, depends_on, next_best_action)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['issue-camp-a', 'project-1', 'camp-a', null, 'Task A', 'high', 'ready', 'M', '[]', 'Start A']);
      runStatement(database.connection,
        `INSERT INTO issues (id, project_id, campaign_id, milestone_id, task, priority, status, size, depends_on, next_best_action)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['issue-camp-b', 'project-1', 'camp-b', null, 'Task B', 'high', 'ready', 'M', '[]', 'Start B']);
    } finally {
      database.close();
    }

    const orchestrator = new SessionOrchestrator({
      mem0Adapter: new InMemoryMem0Adapter(),
      defaultCheckpointFreshnessSeconds: 3600,
    });

    // First begin for campaign A — claims issue-camp-a
    const sessionA = await orchestrator.beginIncrementalSession(withHostRoutingContext({
      sessionId: 'run-camp-a1',
      dbPath,
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      campaignId: 'camp-a',
      agentId: 'test-agent',
      host: 'host-1',
      artifacts: buildTestSessionArtifacts(),
      mem0Enabled: false,
    }));
    assert.equal(sessionA.issueId, 'issue-camp-a');
    assert.equal(sessionA.claimMode, 'claim');

    // Checkpoint to keep the lease fresh
    await orchestrator.checkpoint(sessionA, {
      title: 'WIP on A',
      summary: 'Working on campaign A task.',
      taskStatus: 'in_progress',
      nextStep: 'Continue A',
    });

    // Begin for campaign B — should NOT resume campaign A's lease
    const sessionB = await orchestrator.beginIncrementalSession(withHostRoutingContext({
      sessionId: 'run-camp-b1',
      dbPath,
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      campaignId: 'camp-b',
      agentId: 'test-agent',
      host: 'host-1',
      artifacts: buildTestSessionArtifacts(),
      mem0Enabled: false,
    }));

    // Must claim campaign B's issue, not resume campaign A's
    assert.equal(sessionB.issueId, 'issue-camp-b');
    assert.equal(sessionB.claimMode, 'claim');

    // Begin again for campaign A — should resume A's lease
    const sessionA2 = await orchestrator.beginIncrementalSession(withHostRoutingContext({
      sessionId: 'run-camp-a2',
      dbPath,
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      campaignId: 'camp-a',
      agentId: 'test-agent',
      host: 'host-1',
      artifacts: buildTestSessionArtifacts(),
      mem0Enabled: false,
    }));

    assert.equal(sessionA2.issueId, 'issue-camp-a');
    assert.equal(sessionA2.claimMode, 'resume');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('concurrent campaign-scoped resumes stay isolated under load', async () => {
  const tempDir = createTempDir('campaign-scope-load-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);

    const database = openHarnessDatabase({ dbPath });
    try {
      for (const [campaignId, campaignName, issueId, task] of [
        ['camp-a', 'Campaign A', 'issue-camp-a-load', 'Task A under load'],
        ['camp-b', 'Campaign B', 'issue-camp-b-load', 'Task B under load'],
        ['camp-c', 'Campaign C', 'issue-camp-c-load', 'Task C under load'],
      ]) {
        runStatement(
          database.connection,
          `INSERT INTO campaigns (id, project_id, name, objective, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            campaignId,
            'project-1',
            campaignName,
            `${campaignName} objective`,
            'active',
            '2026-03-21T00:00:00.000Z',
            '2026-03-21T00:00:00.000Z',
          ],
        );
        runStatement(
          database.connection,
          `INSERT INTO issues (id, project_id, campaign_id, milestone_id, task, priority, status, size, depends_on, next_best_action)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            issueId,
            'project-1',
            campaignId,
            null,
            task,
            'high',
            'ready',
            'M',
            '[]',
            `Resume ${issueId}`,
          ],
        );
      }
    } finally {
      database.close();
    }

    for (const campaignId of ['camp-a', 'camp-b', 'camp-c']) {
      const initial = await runCliCommand(
        tempDir,
        buildBeginIncrementalCommand({
          sessionId: `seed-${campaignId}`,
          dbPath,
          agentId: 'agent-shared',
          campaignId,
        }),
        DISABLE_DEFAULT_MEM0_ENV,
      );

      assert.equal(initial.action, 'begin_incremental');
      assert.equal(initial.context.claimMode, 'claim');
    }

    const resumePlans = [
      { campaignId: 'camp-a', expectedIssueId: 'issue-camp-a-load' },
      { campaignId: 'camp-a', expectedIssueId: 'issue-camp-a-load' },
      { campaignId: 'camp-b', expectedIssueId: 'issue-camp-b-load' },
      { campaignId: 'camp-b', expectedIssueId: 'issue-camp-b-load' },
      { campaignId: 'camp-c', expectedIssueId: 'issue-camp-c-load' },
      { campaignId: 'camp-c', expectedIssueId: 'issue-camp-c-load' },
    ];

    const resumes = await Promise.all(
      resumePlans.map((plan, index) =>
        runCliCommand(
          tempDir,
          buildBeginIncrementalCommand({
            sessionId: `resume-${plan.campaignId}-${index + 1}`,
            dbPath,
            agentId: 'agent-shared',
            campaignId: plan.campaignId,
          }),
          DISABLE_DEFAULT_MEM0_ENV,
        ),
      ),
    );

    resumes.forEach((result, index) => {
      assert.equal(result.action, 'begin_incremental');
      assert.equal(result.context.claimMode, 'resume');
      assert.equal(result.context.issueId, resumePlans[index]?.expectedIssueId);
    });

    const inspected = openHarnessDatabase({ dbPath });
    try {
      const activeLeases = selectAll<{ campaign_id: string; lease_count: number }>(
        inspected.connection,
        `SELECT campaign_id, COUNT(*) AS lease_count
         FROM leases
         WHERE status = 'active'
           AND released_at IS NULL
         GROUP BY campaign_id
         ORDER BY campaign_id ASC`,
      );

      assert.deepEqual(
        activeLeases.map((lease) => [lease.campaign_id, lease.lease_count]),
        [
          ['camp-a', 1],
          ['camp-b', 1],
          ['camp-c', 1],
        ],
      );
    } finally {
      inspected.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------- Issue #2: scope-safe preferred issue claims ----------

test('preferredIssueId from wrong project is rejected', async () => {
  const tempDir = createTempDir('scope-preferred-proj-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);

    const database = openHarnessDatabase({ dbPath });
    try {
      // Create project-2
      runStatement(database.connection,
        `INSERT INTO projects (id, workspace_id, key, name, domain, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ['project-2', 'workspace-1', 'other-project', 'Other Project', 'other', 'active', '2026-03-21T00:00:00.000Z', '2026-03-21T00:00:00.000Z']);

      // Ready issue in project-2
      runStatement(database.connection,
        `INSERT INTO issues (id, project_id, campaign_id, milestone_id, task, priority, status, size, depends_on, next_best_action)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['issue-proj2', 'project-2', null, null, 'Other project task', 'high', 'ready', 'M', '[]', 'Do it']);
    } finally {
      database.close();
    }

    const orchestrator = new SessionOrchestrator({
      mem0Adapter: new InMemoryMem0Adapter(),
      defaultCheckpointFreshnessSeconds: 3600,
    });

    await assert.rejects(
      () => orchestrator.beginIncrementalSession(withHostRoutingContext({
        sessionId: 'run-cross-proj',
        dbPath,
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        agentId: 'test-agent',
        host: 'host-1',
        preferredIssueId: 'issue-proj2',
        artifacts: buildTestSessionArtifacts(),
        mem0Enabled: false,
      })),
      /belongs to project project-2, not project-1/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('preferredIssueId from wrong campaign is rejected', async () => {
  const tempDir = createTempDir('scope-preferred-camp-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);

    const database = openHarnessDatabase({ dbPath });
    try {
      // Create campaign X and campaign Y
      runStatement(database.connection,
        `INSERT INTO campaigns (id, project_id, name, objective, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ['camp-x', 'project-1', 'Campaign X', 'obj-x', 'active', '2026-03-21T00:00:00.000Z', '2026-03-21T00:00:00.000Z']);
      runStatement(database.connection,
        `INSERT INTO campaigns (id, project_id, name, objective, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ['camp-y', 'project-1', 'Campaign Y', 'obj-y', 'active', '2026-03-21T00:00:00.000Z', '2026-03-21T00:00:00.000Z']);

      // Issue in campaign X
      runStatement(database.connection,
        `INSERT INTO issues (id, project_id, campaign_id, milestone_id, task, priority, status, size, depends_on, next_best_action)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['issue-camp-x', 'project-1', 'camp-x', null, 'Task X', 'high', 'ready', 'M', '[]', 'Do X']);
    } finally {
      database.close();
    }

    const orchestrator = new SessionOrchestrator({
      mem0Adapter: new InMemoryMem0Adapter(),
      defaultCheckpointFreshnessSeconds: 3600,
    });

    await assert.rejects(
      () => orchestrator.beginIncrementalSession(withHostRoutingContext({
        sessionId: 'run-cross-camp',
        dbPath,
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        campaignId: 'camp-y',
        agentId: 'test-agent',
        host: 'host-1',
        preferredIssueId: 'issue-camp-x',
        artifacts: buildTestSessionArtifacts(),
        mem0Enabled: false,
      })),
      /belongs to campaign camp-x, not camp-y/,
    );
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
  milestoneId?: string;
  blockedReason?: string;
  priority?: string;
  createdAt?: string;
  deadlineAt?: string;
  policy?: Record<string, unknown>;
}): void {
  const database = openHarnessDatabase({ dbPath: input.dbPath });

  try {
    runStatement(
      database.connection,
      `INSERT INTO issues (
         id,
         project_id,
         campaign_id,
         milestone_id,
         task,
         priority,
         status,
         size,
         depends_on,
         deadline_at,
         policy_json,
         next_best_action,
         blocked_reason,
         created_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.issueId,
        'project-1',
        null,
        input.milestoneId ?? null,
        input.task,
        input.priority ?? 'high',
        input.status,
        'M',
        JSON.stringify(input.dependsOn ?? []),
        input.deadlineAt ?? null,
        JSON.stringify(input.policy ?? {}),
        input.nextBestAction,
        input.blockedReason ?? null,
        input.createdAt ?? '2026-03-21T00:00:00.000Z',
      ],
    );
  } finally {
    database.close();
  }
}

function insertMilestone(input: {
  dbPath: string;
  milestoneId: string;
  description: string;
  status: string;
  dependsOn?: string[];
  priority?: string;
}): void {
  const database = openHarnessDatabase({ dbPath: input.dbPath });

  try {
    runStatement(
      database.connection,
      `INSERT INTO milestones (id, project_id, description, priority, status, depends_on, blocked_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.milestoneId,
        'project-1',
        input.description,
        input.priority ?? 'high',
        input.status,
        JSON.stringify(input.dependsOn ?? []),
        null,
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

function parseJsonObject(json: string | undefined): Record<string, unknown> {
  if (json === undefined) {
    return {};
  }

  const parsed = JSON.parse(json) as unknown;
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function parseJsonArray(value: unknown): string[] {
  const parsed =
    typeof value === 'string' ? JSON.parse(value) as unknown : value;

  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === 'string')
    : [];
}

async function runCliCommand(
  tempDir: string,
  command: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
  injectContractVersion = true,
): Promise<any> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await runCliCommandRaw(tempDir, command, extraEnv, injectContractVersion);

    if (result.code === 0) {
      return JSON.parse(result.stdout);
    }

    if (
      attempt < 2 &&
      /database is locked/i.test(result.stderr)
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      continue;
    }

    throw new Error(result.stderr || `CLI exited with code ${result.code}`);
  }

  throw new Error('CLI retry loop exhausted unexpectedly.');
}

async function runCliCommandRaw(
  tempDir: string,
  command: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
  injectContractVersion = true,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cliPath = join(process.cwd(), 'dist/bin/session-lifecycle.js');
  const storePath = mkdtempSync(join(tempDir, 'mem0-'));

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

    child.stdin.write(
      JSON.stringify(
        injectContractVersion
          ? withCliContractVersion(command)
          : command,
      ),
    );
    child.stdin.end();
  });
}

const DISABLE_DEFAULT_MEM0_ENV = {
  AGENT_HARNESS_DISABLE_DEFAULT_MEM0: '1',
};

function buildBeginIncrementalCommand(input: {
  sessionId: string;
  dbPath: string;
  agentId: string;
  preferredIssueId?: string;
  campaignId?: string;
}): Record<string, unknown> {
  return {
    contractVersion: SESSION_LIFECYCLE_CLI_CONTRACT_VERSION,
    action: 'begin_incremental',
    input: {
      sessionId: input.sessionId,
      dbPath: input.dbPath,
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      campaignId: input.campaignId,
      artifacts: buildTestSessionArtifacts(),
      mem0Enabled: false,
      agentId: input.agentId,
      host: TEST_HOST_ROUTING_CONTEXT.host,
      hostCapabilities: TEST_HOST_ROUTING_CONTEXT.hostCapabilities,
      ...(input.preferredIssueId === undefined
        ? {}
        : { preferredIssueId: input.preferredIssueId }),
    },
  };
}

function buildBeginRecoveryCommand(input: {
  sessionId: string;
  dbPath: string;
  agentId: string;
  preferredIssueId?: string;
  campaignId?: string;
  recoverySummary?: string;
  recoveryNextStep?: string;
}): Record<string, unknown> {
  return {
    contractVersion: SESSION_LIFECYCLE_CLI_CONTRACT_VERSION,
    action: 'begin_recovery',
    input: {
      sessionId: input.sessionId,
      dbPath: input.dbPath,
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      campaignId: input.campaignId,
      artifacts: buildTestSessionArtifacts(),
      mem0Enabled: false,
      agentId: input.agentId,
      host: TEST_HOST_ROUTING_CONTEXT.host,
      hostCapabilities: TEST_HOST_ROUTING_CONTEXT.hostCapabilities,
      recoverySummary:
        input.recoverySummary ?? 'Recover the flagged issue with a fresh lease.',
      recoveryNextStep:
        input.recoveryNextStep ?? 'Continue under the fresh recovery lease.',
      ...(input.preferredIssueId === undefined
        ? {}
        : { preferredIssueId: input.preferredIssueId }),
    },
  };
}

function withCliContractVersion(command: Record<string, unknown>): Record<string, unknown> {
  if ('contractVersion' in command) {
    return command;
  }

  return {
    contractVersion: SESSION_LIFECYCLE_CLI_CONTRACT_VERSION,
    ...command,
  };
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
