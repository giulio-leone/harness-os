/**
 * Stringent MCP-level tests for the 4 consolidated mega-tools.
 *
 * Tests exercise tools through the same handler surface the LLM uses,
 * verifying action dispatch, error handling, _meta hints, and DB state.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

// ─── Helpers ────────────────────────────────────────────────────────

class StubMem0Adapter implements Mem0Adapter {
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
      id: `mem-${this.memories.length + 1}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.memories.push(record);
    return record;
  }

  async recallMemory(input: MemoryRecallInput): Promise<PublicMemoryRecord | null> {
    return this.memories.find((m) => m.id === input.memoryId) ?? null;
  }

  async searchMemory(
    input: MemorySearchInput,
  ): Promise<MemorySearchResult[]> {
    return this.memories
      .filter(() => true)
      .slice(0, input.limit)
      .map((memory) => ({ memory, score: 1 }));
  }

  async updateMemory(): Promise<PublicMemoryRecord> { throw new Error('stub'); }
  async deleteMemory(): Promise<void> {}
  async listWorkspaces(): Promise<string[]> { return []; }
  async listProjects(): Promise<string[]> { return []; }
}

interface ServerInternals {
  tools: Map<string, { handler: (args: unknown) => Promise<unknown> }>;
  tokenStore: { resolve(token: string): unknown };
}

function createServer(): {
  server: SessionLifecycleMcpServer;
  internals: ServerInternals;
} {
  const orchestrator = new SessionOrchestrator({
    mem0Adapter: new StubMem0Adapter(),
    defaultCheckpointFreshnessSeconds: 3600,
  });
  const adapter = new SessionLifecycleAdapter(orchestrator);
  const server = new SessionLifecycleMcpServer(adapter);
  const internals = server as unknown as ServerInternals;
  return { server, internals };
}

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function seedProject(dbPath: string): void {
  seedWorkspaceAndProject(dbPath, {
    workspaceId: 'ws-1',
    workspaceName: 'Test Workspace',
    projectId: 'proj-1',
    projectKey: 'test-project',
    projectName: 'Test Project',
  });
}

function seedWorkspaceAndProject(
  dbPath: string,
  input: {
    workspaceId: string;
    workspaceName: string;
    projectId: string;
    projectKey: string;
    projectName: string;
  },
): void {
  const db = openHarnessDatabase({ dbPath });
  try {
    runStatement(
      db.connection,
      `INSERT INTO workspaces (id, name, kind, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        input.workspaceId,
        input.workspaceName,
        'global',
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:00:00Z',
      ],
    );
    runStatement(
      db.connection,
      `INSERT INTO projects (id, workspace_id, key, name, domain, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.projectId,
        input.workspaceId,
        input.projectKey,
        input.projectName,
        'test',
        'active',
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:00:00Z',
      ],
    );
  } finally {
    db.close();
  }
}

function seedIssue(dbPath: string, issueId: string, status: string, dependsOn: string[] = []): void {
  const db = openHarnessDatabase({ dbPath });
  try {
    runStatement(
      db.connection,
      `INSERT INTO issues (id, project_id, campaign_id, milestone_id, task, priority, status, size, depends_on, next_best_action)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [issueId, 'proj-1', null, null, `Task for ${issueId}`, 'high', status, 'M', JSON.stringify(dependsOn), 'Do the work.'],
    );
  } finally {
    db.close();
  }
}

const beginArgs = (dbPath: string, extras?: Record<string, unknown>) => ({
  sessionId: `run-${Date.now()}`,
  dbPath,
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  progressPath: '/tmp/progress.md',
  featureListPath: '/tmp/features.json',
  planPath: '/tmp/plan.md',
  syncManifestPath: '/tmp/manifest.yaml',
  mem0Enabled: false,
  agentId: 'test-agent',
  ...extras,
});

// ─── 1. harness_inspector ───────────────────────────────────────────

test('harness_inspector: get_context returns workspace, project, queue status', async () => {
  const tempDir = createTempDir('inspector-ctx-');
  const dbPath = join(tempDir, 'harness.sqlite');
  try {
    seedProject(dbPath);
    seedIssue(dbPath, 'issue-ready', 'ready');
    seedIssue(dbPath, 'issue-pending', 'pending', ['issue-ready']);

    const { internals } = createServer();
    const tool = internals.tools.get('harness_inspector')!;
    const result = (await tool.handler({ action: 'get_context', dbPath })) as Record<string, unknown>;

    assert.ok(result.workspace, 'workspace must be present');
    assert.ok(result.project, 'project must be present');
    const queue = result.queue as Record<string, number>;
    assert.equal(queue['ready'], 1, 'should have 1 ready issue');
    assert.equal(queue['pending'], 1, 'should have 1 pending issue');
    assert.ok((result._meta as Record<string, unknown>).hint, '_meta.hint must be present');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('harness_inspector: get_context returns init_workspace hint when no workspace exists', async () => {
  const tempDir = createTempDir('inspector-empty-');
  const dbPath = join(tempDir, 'harness.sqlite');
  try {
    // Initialize DB but don't seed any data
    const db = openHarnessDatabase({ dbPath });
    db.close();

    const { internals } = createServer();
    const tool = internals.tools.get('harness_inspector')!;
    const result = (await tool.handler({ action: 'get_context', dbPath })) as Record<string, unknown>;

    assert.equal(result.workspace, null);
    const meta = result._meta as { nextTools: string[] };
    assert.ok(meta.nextTools.includes('harness_orchestrator'), 'should suggest harness_orchestrator');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('harness_inspector: get_context asks for explicit workspace when multiple workspaces exist', async () => {
  const tempDir = createTempDir('inspector-ctx-ambiguous-workspace-');
  const dbPath = join(tempDir, 'harness.sqlite');
  try {
    seedWorkspaceAndProject(dbPath, {
      workspaceId: 'ws-1',
      workspaceName: 'Workspace One',
      projectId: 'proj-1',
      projectKey: 'project-one',
      projectName: 'Project One',
    });
    seedWorkspaceAndProject(dbPath, {
      workspaceId: 'ws-2',
      workspaceName: 'Workspace Two',
      projectId: 'proj-2',
      projectKey: 'project-two',
      projectName: 'Project Two',
    });

    const { internals } = createServer();
    const tool = internals.tools.get('harness_inspector')!;
    const result = (await tool.handler({
      action: 'get_context',
      dbPath,
    })) as Record<string, unknown>;

    assert.equal(result.action, 'clarify_scope');
    const meta = result._meta as { nextTools: string[] };
    assert.ok(meta.nextTools.includes('harness_inspector'));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('harness_inspector: next_action returns correct NBA directive', async () => {
  const tempDir = createTempDir('inspector-nba-');
  const dbPath = join(tempDir, 'harness.sqlite');
  try {
    seedProject(dbPath);
    seedIssue(dbPath, 'issue-1', 'ready');

    const { internals } = createServer();
    const tool = internals.tools.get('harness_inspector')!;
    const result = (await tool.handler({ action: 'next_action', dbPath })) as Record<string, unknown>;

    assert.equal(result.action, 'call_tool');
    assert.equal(result.tool, 'harness_session');
    assert.ok(result.suggestedPayload, 'should include suggestedPayload');
    const payload = result.suggestedPayload as Record<string, unknown>;
    assert.equal(payload.action, 'begin');
    assert.equal(payload.preferredIssueId, 'issue-1');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('harness_inspector: next_action returns idle when queue is empty', async () => {
  const tempDir = createTempDir('inspector-idle-');
  const dbPath = join(tempDir, 'harness.sqlite');
  try {
    seedProject(dbPath);

    const { internals } = createServer();
    const tool = internals.tools.get('harness_inspector')!;
    const result = (await tool.handler({ action: 'next_action', dbPath })) as Record<string, unknown>;

    assert.equal(result.action, 'idle');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('harness_inspector: next_action asks for explicit project when scope is ambiguous', async () => {
  const tempDir = createTempDir('inspector-nba-ambiguous-project-');
  const dbPath = join(tempDir, 'harness.sqlite');
  try {
    seedWorkspaceAndProject(dbPath, {
      workspaceId: 'ws-1',
      workspaceName: 'Workspace One',
      projectId: 'proj-1',
      projectKey: 'shared-project-1',
      projectName: 'Shared Project',
    });
    seedWorkspaceAndProject(dbPath, {
      workspaceId: 'ws-2',
      workspaceName: 'Workspace Two',
      projectId: 'proj-2',
      projectKey: 'shared-project-2',
      projectName: 'Shared Project',
    });
    seedIssue(dbPath, 'issue-one', 'ready');

    const db = openHarnessDatabase({ dbPath });
    try {
      runStatement(
        db.connection,
        `INSERT INTO issues (id, project_id, campaign_id, milestone_id, task, priority, status, size, depends_on, next_best_action)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'issue-two',
          'proj-2',
          null,
          null,
          'Task for issue-two',
          'high',
          'ready',
          'M',
          '[]',
          'Do the other work.',
        ],
      );
    } finally {
      db.close();
    }

    const { internals } = createServer();
    const tool = internals.tools.get('harness_inspector')!;
    const result = (await tool.handler({
      action: 'next_action',
      dbPath,
      projectName: 'Shared Project',
    })) as Record<string, unknown>;

    assert.equal(result.action, 'clarify_scope');
    assert.match(String(result.message ?? ''), /projectId/i);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('harness_inspector: overview returns counts and issue lists', async () => {
  const tempDir = createTempDir('inspector-overview-');
  const dbPath = join(tempDir, 'harness.sqlite');
  try {
    seedProject(dbPath);
    seedIssue(dbPath, 'issue-r1', 'ready');
    seedIssue(dbPath, 'issue-r2', 'ready');
    seedIssue(dbPath, 'issue-p1', 'pending', ['issue-r1']);

    const { internals } = createServer();
    const tool = internals.tools.get('harness_inspector')!;
    const result = (await tool.handler({
      action: 'overview',
      dbPath,
      projectName: 'Test Project',
    })) as { result: Record<string, unknown>; _meta: Record<string, unknown> };

    const counts = result.result.counts as Record<string, number>;
    assert.equal(counts.readyIssues, 2);
    assert.ok(result._meta, '_meta must exist');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('harness_inspector: issue deep-dive returns lifecycle evidence', async () => {
  const tempDir = createTempDir('inspector-issue-');
  const dbPath = join(tempDir, 'harness.sqlite');
  try {
    seedProject(dbPath);
    seedIssue(dbPath, 'issue-detail', 'ready');

    const { internals } = createServer();
    const tool = internals.tools.get('harness_inspector')!;
    const result = (await tool.handler({
      action: 'issue',
      dbPath,
      issueId: 'issue-detail',
    })) as { result: Record<string, unknown>; _meta: Record<string, unknown> };

    const issue = result.result.issue as Record<string, unknown>;
    assert.equal(issue.id, 'issue-detail');
    assert.equal(issue.status, 'ready');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('harness_inspector: issue without issueId throws AgenticToolError', async () => {
  const tempDir = createTempDir('inspector-issue-err-');
  const dbPath = join(tempDir, 'harness.sqlite');
  try {
    seedProject(dbPath);

    const { internals } = createServer();
    const tool = internals.tools.get('harness_inspector')!;
    await assert.rejects(
      () => tool.handler({ action: 'issue', dbPath }),
      /issueId is required/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ─── 2. harness_orchestrator ────────────────────────────────────────

test('harness_orchestrator: promote_queue promotes eligible pending issues', async () => {
  const tempDir = createTempDir('orch-promote-');
  const dbPath = join(tempDir, 'harness.sqlite');
  try {
    seedProject(dbPath);
    seedIssue(dbPath, 'issue-done', 'done');
    seedIssue(dbPath, 'issue-waiting', 'pending', ['issue-done']);

    const { internals } = createServer();
    const tool = internals.tools.get('harness_orchestrator')!;
    const result = (await tool.handler({
      action: 'promote_queue',
      dbPath,
      projectId: 'proj-1',
    })) as { result: Record<string, unknown>; _meta: Record<string, unknown> };

    const promoted = result.result.promotedIssueIds as string[];
    assert.deepEqual(promoted, ['issue-waiting']);

    // Verify DB state
    const db = openHarnessDatabase({ dbPath });
    try {
      const issue = selectOne<{ status: string }>(db.connection, 'SELECT status FROM issues WHERE id = ?', ['issue-waiting']);
      assert.equal(issue?.status, 'ready');
    } finally {
      db.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('harness_orchestrator: rollback_issue resets a failed issue', async () => {
  const tempDir = createTempDir('orch-rollback-');
  const dbPath = join(tempDir, 'harness.sqlite');
  try {
    seedProject(dbPath);
    seedIssue(dbPath, 'issue-stuck', 'in_progress');

    const { internals } = createServer();
    const tool = internals.tools.get('harness_orchestrator')!;
    const result = (await tool.handler({
      action: 'rollback_issue',
      dbPath,
      issueId: 'issue-stuck',
    })) as Record<string, unknown>;

    assert.ok(result);

    // Verify DB state
    const db = openHarnessDatabase({ dbPath });
    try {
      const issue = selectOne<{ status: string }>(db.connection, 'SELECT status FROM issues WHERE id = ?', ['issue-stuck']);
      assert.equal(issue?.status, 'pending');
    } finally {
      db.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ─── 3. harness_session: Full lifecycle ─────────────────────────────

test('harness_session: full begin → checkpoint → close lifecycle via mega-tool', async () => {
  const tempDir = createTempDir('session-lifecycle-');
  const dbPath = join(tempDir, 'harness.sqlite');
  try {
    seedProject(dbPath);
    seedIssue(dbPath, 'issue-lifecycle', 'ready');

    const { internals } = createServer();
    const tool = internals.tools.get('harness_session')!;

    // 1. Begin
    const started = (await tool.handler({
      action: 'begin',
      ...beginArgs(dbPath, { preferredIssueId: 'issue-lifecycle' }),
    })) as { sessionToken: string; context: Record<string, unknown> };
    assert.ok(started.sessionToken, 'sessionToken must be present');
    assert.ok(started.context, 'context must be present');

    // 2. Checkpoint
    const checkpointed = (await tool.handler({
      action: 'checkpoint',
      sessionToken: started.sessionToken,
      input: {
        title: 'progress',
        summary: 'Making progress on the task.',
        taskStatus: 'in_progress',
        nextStep: 'Continue working.',
      },
    })) as { _meta: Record<string, unknown> };
    assert.ok(checkpointed._meta, 'checkpoint should return _meta');

    // 3. Close
    const closed = (await tool.handler({
      action: 'close',
      sessionToken: started.sessionToken,
      closeInput: {
        title: 'done',
        summary: 'Completed the task.',
        taskStatus: 'done',
        nextStep: 'Nothing more.',
      },
    })) as Record<string, unknown>;
    assert.ok(closed._meta, 'close should return _meta');

    // Verify DB state
    const db = openHarnessDatabase({ dbPath });
    try {
      const issue = selectOne<{ status: string }>(db.connection, 'SELECT status FROM issues WHERE id = ?', ['issue-lifecycle']);
      assert.equal(issue?.status, 'done');
    } finally {
      db.close();
    }

    // Verify token was cleaned up
    assert.throws(() => internals.tokenStore.resolve(started.sessionToken), 'token should be invalidated after close');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('harness_session: advance atomically closes current and begins next', async () => {
  const tempDir = createTempDir('session-advance-');
  const dbPath = join(tempDir, 'harness.sqlite');
  try {
    seedProject(dbPath);
    seedIssue(dbPath, 'issue-first', 'ready');
    seedIssue(dbPath, 'issue-second', 'pending', ['issue-first']);

    const { internals } = createServer();
    const tool = internals.tools.get('harness_session')!;

    // Begin first task
    const started = (await tool.handler({
      action: 'begin',
      ...beginArgs(dbPath, { preferredIssueId: 'issue-first' }),
    })) as { sessionToken: string };

    // Advance → close first, promote, begin second
    const advanced = (await tool.handler({
      action: 'advance',
      sessionToken: started.sessionToken,
      closeInput: {
        title: 'done',
        summary: 'First task complete.',
        taskStatus: 'done',
        nextStep: 'Auto-advance.',
      },
    })) as { sessionToken: string; context: Record<string, unknown> };

    assert.ok(advanced.sessionToken, 'new sessionToken must be returned');
    assert.notEqual(advanced.sessionToken, started.sessionToken, 'token must be different from old');

    // Verify DB: first done, second now in_progress
    const db = openHarnessDatabase({ dbPath });
    try {
      const first = selectOne<{ status: string }>(db.connection, 'SELECT status FROM issues WHERE id = ?', ['issue-first']);
      const second = selectOne<{ status: string }>(db.connection, 'SELECT status FROM issues WHERE id = ?', ['issue-second']);
      assert.equal(first?.status, 'done');
      assert.equal(second?.status, 'in_progress');
    } finally {
      db.close();
    }

    // Old token invalidated
    assert.throws(() => internals.tokenStore.resolve(started.sessionToken));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('harness_session: begin with invalid action rejects cleanly', async () => {
  const { internals } = createServer();
  const tool = internals.tools.get('harness_session')!;
  await assert.rejects(
    () => tool.handler({ action: 'nonexistent' }),
    /Invalid/,
  );
});

// ─── 4. harness_artifacts: save + list round-trip ───────────────────

test('harness_artifacts: save registers an artifact and list retrieves it', async () => {
  const tempDir = createTempDir('artifacts-roundtrip-');
  const dbPath = join(tempDir, 'harness.sqlite');
  try {
    seedProject(dbPath);

    const { internals } = createServer();
    const tool = internals.tools.get('harness_artifacts')!;

    // Save
    const saved = (await tool.handler({
      action: 'save',
      dbPath,
      projectId: 'proj-1',
      kind: 'browser_state',
      path: '/tmp/cookies.json',
      metadata: { account: 'primary', browser: 'chromium' },
    })) as { artifactId: string; kind: string; path: string };
    assert.ok(saved.artifactId, 'artifactId must be returned');
    assert.equal(saved.kind, 'browser_state');
    assert.equal(saved.path, '/tmp/cookies.json');

    // List - should find it
    const listed = (await tool.handler({
      action: 'list',
      dbPath,
      projectId: 'proj-1',
      kind: 'browser_state',
    })) as { artifacts: Array<{ id: string; kind: string; path: string; metadata: Record<string, unknown> }> };
    assert.equal(listed.artifacts.length, 1);
    assert.equal(listed.artifacts[0].id, saved.artifactId);
    assert.equal(listed.artifacts[0].kind, 'browser_state');
    assert.equal(listed.artifacts[0].path, '/tmp/cookies.json');
    assert.equal(listed.artifacts[0].metadata.account, 'primary');

    // List with wrong kind - should find nothing
    const empty = (await tool.handler({
      action: 'list',
      dbPath,
      projectId: 'proj-1',
      kind: 'screenshot',
    })) as { artifacts: unknown[] };
    assert.equal(empty.artifacts.length, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('harness_artifacts: save scoped to issueId, list filters by it', async () => {
  const tempDir = createTempDir('artifacts-scoped-');
  const dbPath = join(tempDir, 'harness.sqlite');
  try {
    seedProject(dbPath);
    seedIssue(dbPath, 'issue-A', 'ready');
    seedIssue(dbPath, 'issue-B', 'ready');

    const { internals } = createServer();
    const tool = internals.tools.get('harness_artifacts')!;

    // Save artifact scoped to issue-A
    await tool.handler({
      action: 'save',
      dbPath,
      projectId: 'proj-1',
      issueId: 'issue-A',
      kind: 'auth_cookies',
      path: '/tmp/cookies-a.json',
    });

    // Save artifact scoped to issue-B
    await tool.handler({
      action: 'save',
      dbPath,
      projectId: 'proj-1',
      issueId: 'issue-B',
      kind: 'auth_cookies',
      path: '/tmp/cookies-b.json',
    });

    // List for issue-A only
    const resultA = (await tool.handler({
      action: 'list',
      dbPath,
      projectId: 'proj-1',
      issueId: 'issue-A',
    })) as { artifacts: Array<{ path: string }> };
    assert.equal(resultA.artifacts.length, 1);
    assert.equal(resultA.artifacts[0].path, '/tmp/cookies-a.json');

    // List all for project
    const resultAll = (await tool.handler({
      action: 'list',
      dbPath,
      projectId: 'proj-1',
    })) as { artifacts: unknown[] };
    assert.equal(resultAll.artifacts.length, 2);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('harness_artifacts: save without kind throws AgenticToolError', async () => {
  const tempDir = createTempDir('artifacts-err-kind-');
  const dbPath = join(tempDir, 'harness.sqlite');
  try {
    seedProject(dbPath);

    const { internals } = createServer();
    const tool = internals.tools.get('harness_artifacts')!;
    await assert.rejects(
      () => tool.handler({ action: 'save', dbPath, projectId: 'proj-1', path: '/tmp/file' }),
      /kind is required/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('harness_artifacts: save without path throws AgenticToolError', async () => {
  const tempDir = createTempDir('artifacts-err-path-');
  const dbPath = join(tempDir, 'harness.sqlite');
  try {
    seedProject(dbPath);

    const { internals } = createServer();
    const tool = internals.tools.get('harness_artifacts')!;
    await assert.rejects(
      () => tool.handler({ action: 'save', dbPath, projectId: 'proj-1', kind: 'test' }),
      /path is required/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ─── 5. Cross-tool integrity ────────────────────────────────────────

test('cross-tool: only 4 tools are registered on the server', async () => {
  const { internals } = createServer();
  const toolNames = [...internals.tools.keys()].sort();
  assert.deepEqual(toolNames, [
    'harness_artifacts',
    'harness_inspector',
    'harness_orchestrator',
    'harness_session',
  ]);
});

test('cross-tool: every tool handler rejects missing action param', async () => {
  const { internals } = createServer();
  for (const name of ['harness_inspector', 'harness_orchestrator', 'harness_session', 'harness_artifacts']) {
    const tool = internals.tools.get(name)!;
    await assert.rejects(
      () => tool.handler({}),
      /Required|Invalid/i,
      `${name} should reject missing action`,
    );
  }
});
