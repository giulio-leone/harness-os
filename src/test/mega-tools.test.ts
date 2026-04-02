/**
 * Stringent MCP-level tests for the 5 consolidated mega-tools.
 *
 * Tests exercise tools through the same handler surface the LLM uses,
 * verifying action dispatch, error handling, _meta hints, and DB state.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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

  readonly metadata = {
    adapterId: 'stub-test',
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

const TEST_HOST_ROUTING_CONTEXT = {
  host: 'ci-linux',
  hostCapabilities: {
    workloadClasses: ['default', 'typescript'],
    capabilities: ['node', 'sqlite'],
  },
};

class StrictHarnessAdminMem0Adapter extends StubMem0Adapter {
  readonly storedInputs: MemoryStoreInput[] = [];

  override async storeMemory(input: MemoryStoreInput): Promise<PublicMemoryRecord> {
    assert.ok(input.metadata, 'harness_admin must pass metadata to mem0');
    assert.equal(input.metadata['source'], 'harness_admin');
    assert.ok(
      input.metadata['action'] === 'mem0_snapshot' || input.metadata['action'] === 'mem0_rollup',
      'harness_admin metadata.action must identify the admin operation',
    );
    this.storedInputs.push(input);
    return super.storeMemory(input);
  }
}

interface ServerInternals {
  tools: Map<string, { handler: (args: unknown) => Promise<unknown> }>;
  tokenStore: { resolve(token: string): unknown };
}

function createServer(): {
  server: SessionLifecycleMcpServer;
  internals: ServerInternals;
}
function createServer(input: {
  adminMem0Loader?: () => Promise<Mem0Adapter | null>;
}): {
  server: SessionLifecycleMcpServer;
  internals: ServerInternals;
}
function createServer(input: {
  adminMem0Loader?: () => Promise<Mem0Adapter | null>;
} = {}): {
  server: SessionLifecycleMcpServer;
  internals: ServerInternals;
} {
  const orchestrator = new SessionOrchestrator({
    mem0Adapter: new StubMem0Adapter(),
    defaultCheckpointFreshnessSeconds: 3600,
  });
  const adapter = new SessionLifecycleAdapter(orchestrator);
  const server = new SessionLifecycleMcpServer(
    adapter,
    undefined,
    input.adminMem0Loader,
  );
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

function seedIssue(
  dbPath: string,
  issueId: string,
  status: string,
  dependsOn: string[] = [],
  options?: {
    createdAt?: string;
    deadlineAt?: string;
    policy?: Record<string, unknown>;
    priority?: string;
  },
): void {
  const db = openHarnessDatabase({ dbPath });
  try {
    runStatement(
      db.connection,
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
         created_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        issueId,
        'proj-1',
        null,
        null,
        `Task for ${issueId}`,
        options?.priority ?? 'high',
        status,
        'M',
        JSON.stringify(dependsOn),
        options?.deadlineAt ?? null,
        JSON.stringify(options?.policy ?? {}),
        'Do the work.',
        options?.createdAt ?? '2026-01-01T00:00:00Z',
      ],
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
  artifacts: [
    { kind: 'session_handoff', path: '/tmp/progress.md' },
    { kind: 'task_catalog', path: '/tmp/features.json' },
    { kind: 'execution_plan', path: '/tmp/plan.md' },
    { kind: 'sync_manifest', path: '/tmp/manifest.yaml' },
  ],
  mem0Enabled: false,
  agentId: 'test-agent',
  ...TEST_HOST_ROUTING_CONTEXT,
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

test('harness_inspector: capabilities returns tool catalog, bundled skills, and mem0 status', async () => {
  const adminMem0 = new StrictHarnessAdminMem0Adapter();
  const { internals } = createServer({
    adminMem0Loader: async () => adminMem0,
  });
  const tool = internals.tools.get('harness_inspector')!;
  const result = (await tool.handler({
    action: 'capabilities',
  })) as Record<string, unknown>;

  const tools = result.tools as Array<Record<string, unknown>>;
  const skills = result.skills as Array<Record<string, unknown>>;
  const mem0 = result.mem0 as Record<string, unknown>;

  assert.ok(tools.some((entry) => entry.name === 'harness_inspector'));
  assert.ok(
    tools.some(
      (entry) =>
        Array.isArray(entry.actions) &&
        entry.actions.some(
          (action) =>
            typeof action === 'object' &&
            action !== null &&
            'action' in action &&
            action['action'] === 'capabilities',
        ),
    ),
  );
  assert.ok(skills.some((entry) => entry.id === 'harness-lifecycle'));
  assert.ok(
    skills.some(
      (entry) =>
        entry.id === 'harness-lifecycle' &&
        typeof entry.version === 'string' &&
        typeof entry.bundleVersion === 'string' &&
        Array.isArray(entry.workloadProfileIds),
    ),
  );
  assert.equal(mem0.configured, true);
  assert.equal(mem0.available, true);
  assert.equal(mem0.adapterId, 'stub-test');
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
    const result = (await tool.handler({
      action: 'next_action',
      dbPath,
      ...TEST_HOST_ROUTING_CONTEXT,
    })) as Record<string, unknown>;

    assert.equal(result.action, 'call_tool');
    assert.equal(result.tool, 'harness_session');
    assert.ok(result.suggestedPayload, 'should include suggestedPayload');
    const payload = result.suggestedPayload as Record<string, unknown>;
    const context = result.context as {
      stage: string;
      priority: number;
      host?: { host: string; hostCapabilities: { workloadClasses: string[] } };
      issue?: { id: string; status: string; nextBestAction: string | null };
      dispatch?: { eligible: boolean };
    };
    assert.equal(payload.action, 'begin');
    assert.equal(payload.preferredIssueId, 'issue-1');
    assert.equal(payload.host, TEST_HOST_ROUTING_CONTEXT.host);
    assert.deepEqual(
      payload.hostCapabilities,
      TEST_HOST_ROUTING_CONTEXT.hostCapabilities,
    );
    assert.equal(context.stage, 'ready_issue');
    assert.equal(context.priority, 3);
    assert.equal(context.host?.host, TEST_HOST_ROUTING_CONTEXT.host);
    assert.equal(context.issue?.id, 'issue-1');
    assert.equal(context.issue?.status, 'ready');
    assert.equal(context.issue?.nextBestAction, 'Do the work.');
    assert.equal(context.dispatch?.eligible, true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('harness_inspector: next_action honors policy-driven escalation and exposes policy state', async () => {
  const tempDir = createTempDir('inspector-nba-policy-');
  const dbPath = join(tempDir, 'harness.sqlite');
  try {
    seedProject(dbPath);
    seedIssue(dbPath, 'issue-high', 'ready', [], {
      priority: 'high',
      createdAt: '2026-04-02T11:45:00.000Z',
    });
    seedIssue(dbPath, 'issue-overdue', 'ready', [], {
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

    const { internals } = createServer();
    const tool = internals.tools.get('harness_inspector')!;
    const result = (await tool.handler({
      action: 'next_action',
      dbPath,
      projectId: 'proj-1',
      ...TEST_HOST_ROUTING_CONTEXT,
    })) as Record<string, unknown>;

    const payload = result.suggestedPayload as Record<string, unknown>;
    const context = result.context as {
      issue?: {
        id: string;
        deadlineAt?: string;
        policyState?: {
          effectivePriority: string;
          escalated: boolean;
          breaches: Array<{ trigger: string; action: string; priority?: string }>;
        };
      };
    };

    assert.equal(result.action, 'call_tool');
    assert.equal(result.tool, 'harness_session');
    assert.equal(payload.action, 'begin');
    assert.equal(payload.preferredIssueId, 'issue-overdue');
    assert.equal(context.issue?.id, 'issue-overdue');
    assert.equal(context.issue?.deadlineAt, '2026-04-02T09:00:00.000Z');
    assert.equal(context.issue?.policyState?.effectivePriority, 'critical');
    assert.equal(context.issue?.policyState?.escalated, true);
    assert.equal(context.issue?.policyState?.breaches.length, 1);
    assert.equal(
      context.issue?.policyState?.breaches[0]?.trigger,
      'deadline_breached',
    );
    assert.equal(
      context.issue?.policyState?.breaches[0]?.action,
      'raise_priority',
    );
    assert.equal(
      context.issue?.policyState?.breaches[0]?.priority,
      'critical',
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('harness_inspector: next_action reports dispatch mismatches when no ready issue matches host context', async () => {
  const tempDir = createTempDir('inspector-nba-dispatch-mismatch-');
  const dbPath = join(tempDir, 'harness.sqlite');
  try {
    seedProject(dbPath);
    seedIssue(dbPath, 'issue-python', 'ready', [], {
      priority: 'critical',
      policy: {
        dispatch: {
          workloadClass: 'python',
          requiredHostCapabilities: ['python'],
        },
      },
    });

    const { internals } = createServer();
    const tool = internals.tools.get('harness_inspector')!;
    const result = (await tool.handler({
      action: 'next_action',
      dbPath,
      host: 'ci-linux',
      hostCapabilities: {
        workloadClasses: ['typescript'],
        capabilities: ['node', 'sqlite'],
      },
    })) as Record<string, unknown>;

    const payload = result.suggestedPayload as Record<string, unknown>;
    const context = result.context as {
      stage: string;
      blocker?: { kind: string; summary: string };
      candidates?: Array<{
        id: string;
        dispatch?: {
          eligible: boolean;
          missingWorkloadClass?: string;
          missingHostCapabilities?: string[];
        };
      }>;
    };

    assert.equal(result.action, 'call_tool');
    assert.equal(result.tool, 'harness_inspector');
    assert.equal(payload.action, 'export');
    assert.equal(context.stage, 'dispatch_mismatch');
    assert.equal(context.blocker?.kind, 'dispatch_mismatch');
    assert.equal(context.candidates?.[0]?.id, 'issue-python');
    assert.equal(context.candidates?.[0]?.dispatch?.eligible, false);
    assert.equal(
      context.candidates?.[0]?.dispatch?.missingWorkloadClass,
      'python',
    );
    assert.deepEqual(
      context.candidates?.[0]?.dispatch?.missingHostCapabilities,
      ['python'],
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('harness_inspector: next_action exposes recovery context for needs_recovery issues', async () => {
  const tempDir = createTempDir('inspector-nba-recovery-');
  const dbPath = join(tempDir, 'harness.sqlite');
  try {
    seedProject(dbPath);
    seedIssue(dbPath, 'issue-recovery', 'needs_recovery');

    const { internals } = createServer();
    const tool = internals.tools.get('harness_inspector')!;
    const result = (await tool.handler({
      action: 'next_action',
      dbPath,
      ...TEST_HOST_ROUTING_CONTEXT,
    })) as Record<string, unknown>;

    const payload = result.suggestedPayload as Record<string, unknown>;
    const context = result.context as {
      stage: string;
      priority: number;
      issue?: { id: string; status: string };
      blocker?: { kind: string; refId: string; refType: string };
    };

    assert.equal(result.action, 'call_tool');
    assert.equal(result.tool, 'harness_session');
    assert.equal(payload.action, 'begin_recovery');
    assert.equal(payload.preferredIssueId, 'issue-recovery');
    assert.equal(context.stage, 'needs_recovery');
    assert.equal(context.priority, 2);
    assert.equal(context.issue?.id, 'issue-recovery');
    assert.equal(context.issue?.status, 'needs_recovery');
    assert.equal(context.blocker?.kind, 'issue_needs_recovery');
    assert.equal(context.blocker?.refId, 'issue-recovery');
    assert.equal(context.blocker?.refType, 'issue');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('harness_inspector: next_action exposes concrete lease context for expired leases', async () => {
  const tempDir = createTempDir('inspector-nba-expired-lease-');
  const dbPath = join(tempDir, 'harness.sqlite');
  try {
    seedProject(dbPath);
    seedIssue(dbPath, 'issue-stale', 'in_progress');

    const db = openHarnessDatabase({ dbPath });
    try {
      runStatement(
        db.connection,
        `INSERT INTO leases (
          id, workspace_id, project_id, campaign_id, issue_id, agent_id, status,
          acquired_at, expires_at, last_heartbeat_at, released_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'lease-stale',
          'ws-1',
          'proj-1',
          null,
          'issue-stale',
          'agent-stale',
          'active',
          '2025-01-01T00:00:00Z',
          '2025-01-01T00:05:00Z',
          '2025-01-01T00:02:00Z',
          null,
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
      ...TEST_HOST_ROUTING_CONTEXT,
    })) as Record<string, unknown>;

    const payload = result.suggestedPayload as Record<string, unknown>;
    const context = result.context as {
      stage: string;
      priority: number;
      issue?: { id: string; status: string };
      lease?: { id: string; issueId: string; agentId: string; status: string };
      blocker?: { kind: string; refId: string; refType: string };
    };

    assert.equal(result.action, 'call_tool');
    assert.equal(result.tool, 'harness_session');
    assert.equal(payload.action, 'begin_recovery');
    assert.equal(payload.preferredIssueId, 'issue-stale');
    assert.equal(context.stage, 'expired_lease');
    assert.equal(context.priority, 1);
    assert.equal(context.issue?.id, 'issue-stale');
    assert.equal(context.issue?.status, 'in_progress');
    assert.equal(context.lease?.id, 'lease-stale');
    assert.equal(context.lease?.issueId, 'issue-stale');
    assert.equal(context.lease?.agentId, 'agent-stale');
    assert.equal(context.lease?.status, 'active');
    assert.equal(context.blocker?.kind, 'lease_expired');
    assert.equal(context.blocker?.refId, 'lease-stale');
    assert.equal(context.blocker?.refType, 'lease');
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
    const result = (await tool.handler({
      action: 'next_action',
      dbPath,
      ...TEST_HOST_ROUTING_CONTEXT,
    })) as Record<string, unknown>;

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
      ...TEST_HOST_ROUTING_CONTEXT,
    })) as Record<string, unknown>;

    assert.equal(result.action, 'clarify_scope');
    assert.match(String(result.message ?? ''), /projectId/i);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('harness_inspector: export returns machine-readable observability state', async () => {
  const tempDir = createTempDir('inspector-export-');
  const dbPath = join(tempDir, 'harness.sqlite');
  try {
    seedProject(dbPath);
    seedIssue(dbPath, 'issue-r1', 'ready');
    seedIssue(dbPath, 'issue-r2', 'ready');
    seedIssue(dbPath, 'issue-p1', 'pending', ['issue-r1']);

    const { internals } = createServer();
    const tool = internals.tools.get('harness_inspector')!;
    const result = (await tool.handler({
      action: 'export',
      dbPath,
      projectName: 'Test Project',
    })) as { result: Record<string, unknown>; _meta: Record<string, unknown> };

    const queue = result.result.queue as Record<string, unknown>;
    const statusCounts = queue.statusCounts as Record<string, number>;
    assert.equal(statusCounts.ready, 2);
    assert.equal(Array.isArray(queue.readyIssues), true);
    assert.ok(result._meta, '_meta must exist');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('harness_inspector: audit returns lifecycle evidence and timeline entries', async () => {
  const tempDir = createTempDir('inspector-audit-');
  const dbPath = join(tempDir, 'harness.sqlite');
  try {
    seedProject(dbPath);
    seedIssue(dbPath, 'issue-detail', 'ready');

    const { internals } = createServer();
    const tool = internals.tools.get('harness_inspector')!;
    const result = (await tool.handler({
      action: 'audit',
      dbPath,
      issueId: 'issue-detail',
    })) as { result: Record<string, unknown>; _meta: Record<string, unknown> };

    const issue = result.result.issue as Record<string, unknown>;
    const timeline = result.result.timeline as Array<Record<string, unknown>>;
    assert.equal(issue.id, 'issue-detail');
    assert.equal(issue.status, 'ready');
    assert.ok(Array.isArray(timeline));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('harness_inspector: audit rejects missing issueId at the public boundary', async () => {
  const tempDir = createTempDir('inspector-audit-err-');
  const dbPath = join(tempDir, 'harness.sqlite');
  try {
    seedProject(dbPath);

    const { internals } = createServer();
    const tool = internals.tools.get('harness_inspector')!;
    await assert.rejects(
      () => tool.handler({ action: 'audit', dbPath }),
      /issueId|expected string/i,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('harness_inspector: health_snapshot reports policy breaches as alerts', async () => {
  const tempDir = createTempDir('inspector-health-snapshot-');
  const dbPath = join(tempDir, 'harness.sqlite');
  try {
    seedProject(dbPath);
    seedIssue(dbPath, 'issue-overdue', 'ready', [], {
      deadlineAt: '2026-04-01T10:00:00.000Z',
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

    const { internals } = createServer();
    const tool = internals.tools.get('harness_inspector')!;
    const result = (await tool.handler({
      action: 'health_snapshot',
      dbPath,
      projectId: 'proj-1',
    })) as { result: Record<string, unknown>; _meta: Record<string, unknown> };

    const policy = result.result.policy as Record<string, unknown>;
    const alerts = result.result.alerts as Array<Record<string, unknown>>;

    assert.equal(result.result.snapshotVersion, 1);
    assert.equal(policy.breachedIssueCount, 1);
    assert.equal(alerts.some((alert) => alert.kind === 'policy_breaches'), true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ─── 2. harness_orchestrator ────────────────────────────────────────

test('harness_orchestrator: init_workspace and create_campaign succeed via the mega-tool contract', async () => {
  const tempDir = createTempDir('orch-setup-');
  const dbPath = join(tempDir, 'harness.sqlite');
  try {
    const { internals } = createServer();
    const tool = internals.tools.get('harness_orchestrator')!;

    const initialized = (await tool.handler({
      action: 'init_workspace',
      dbPath,
      workspaceName: 'Mega Tool Workspace',
    })) as { workspaceId: string };

    assert.match(initialized.workspaceId, /^W-/);

    const created = (await tool.handler({
      action: 'create_campaign',
      dbPath,
      workspaceId: initialized.workspaceId,
      projectName: 'Mega Tool Project',
      campaignName: 'Launch',
      objective: 'Ship the release-safe setup flow.',
    })) as { projectId: string; campaignId: string };

    assert.match(created.projectId, /^P-/);
    assert.match(created.campaignId, /^C-/);

    const db = openHarnessDatabase({ dbPath });
    try {
      const workspace = selectOne<{ name: string }>(
        db.connection,
        'SELECT name FROM workspaces WHERE id = ?',
        [initialized.workspaceId],
      );
      const project = selectOne<{ name: string }>(
        db.connection,
        'SELECT name FROM projects WHERE id = ?',
        [created.projectId],
      );
      const campaign = selectOne<{ name: string }>(
        db.connection,
        'SELECT name FROM campaigns WHERE id = ?',
        [created.campaignId],
      );

      assert.equal(workspace?.name, 'Mega Tool Workspace');
      assert.equal(project?.name, 'Mega Tool Project');
      assert.equal(campaign?.name, 'Launch');
    } finally {
      db.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test(
  'harness_orchestrator: HARNESS_DB_PATH pins MCP writes and ignores conflicting dbPath overrides',
  { concurrency: false },
  async () => {
    const tempDir = createTempDir('orch-pinned-db-');
    const pinnedDbPath = join(tempDir, 'canonical', 'harness.sqlite');
    const spoofedDbPath = join(tempDir, 'session-state', 'hallucinated.sqlite');
    const previousDbPath = process.env['HARNESS_DB_PATH'];

    process.env['HARNESS_DB_PATH'] = pinnedDbPath;

    try {
      const { internals } = createServer();
      const tool = internals.tools.get('harness_orchestrator')!;

      const initialized = (await tool.handler({
        action: 'init_workspace',
        dbPath: spoofedDbPath,
        workspaceName: 'Pinned Workspace',
      })) as { workspaceId: string };

      assert.match(initialized.workspaceId, /^W-/);
      assert.equal(existsSync(spoofedDbPath), false);

      const pinnedDb = openHarnessDatabase({ dbPath: pinnedDbPath });
      try {
        const workspace = selectOne<{ name: string }>(
          pinnedDb.connection,
          'SELECT name FROM workspaces WHERE id = ?',
          [initialized.workspaceId],
        );

        assert.equal(workspace?.name, 'Pinned Workspace');
      } finally {
        pinnedDb.close();
      }
    } finally {
      if (previousDbPath === undefined) {
        delete process.env['HARNESS_DB_PATH'];
      } else {
        process.env['HARNESS_DB_PATH'] = previousDbPath;
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  },
);

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

test('harness_session: begin auto-generates sessionId when omitted', async () => {
  const tempDir = createTempDir('session-autogen-id-');
  const dbPath = join(tempDir, 'harness.sqlite');
  try {
    seedProject(dbPath);
    seedIssue(dbPath, 'issue-autogen', 'ready');

    const { internals } = createServer();
    const tool = internals.tools.get('harness_session')!;

    const started = (await tool.handler({
      action: 'begin',
      dbPath,
      workspaceId: 'ws-1',
      projectId: 'proj-1',
      artifacts: [
        { kind: 'session_handoff', path: '/tmp/progress.md' },
        { kind: 'task_catalog', path: '/tmp/features.json' },
        { kind: 'execution_plan', path: '/tmp/plan.md' },
        { kind: 'sync_manifest', path: '/tmp/manifest.yaml' },
      ],
      mem0Enabled: false,
      ...TEST_HOST_ROUTING_CONTEXT,
      preferredIssueId: 'issue-autogen',
    })) as {
      context: { runId: string; sessionId: string };
      sessionToken: string;
    };

    assert.ok(started.sessionToken, 'sessionToken must be present');
    assert.match(started.context.sessionId, /^RUN-[0-9a-f-]{36}$/i);
    assert.equal(started.context.runId, started.context.sessionId);
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

test('harness_artifacts: save rejects missing kind at the public boundary', async () => {
  const tempDir = createTempDir('artifacts-err-kind-');
  const dbPath = join(tempDir, 'harness.sqlite');
  try {
    seedProject(dbPath);

    const { internals } = createServer();
    const tool = internals.tools.get('harness_artifacts')!;
    await assert.rejects(
      () => tool.handler({ action: 'save', dbPath, projectId: 'proj-1', path: '/tmp/file' }),
      /kind|expected string/i,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('harness_artifacts: save rejects missing path at the public boundary', async () => {
  const tempDir = createTempDir('artifacts-err-path-');
  const dbPath = join(tempDir, 'harness.sqlite');
  try {
    seedProject(dbPath);

    const { internals } = createServer();
    const tool = internals.tools.get('harness_artifacts')!;
    await assert.rejects(
      () => tool.handler({ action: 'save', dbPath, projectId: 'proj-1', kind: 'test' }),
      /path|expected string/i,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('harness_admin: mem0_snapshot persists project memory with explicit metadata', async () => {
  const tempDir = createTempDir('admin-mem0-snapshot-');
  const dbPath = join(tempDir, 'harness.sqlite');
  const adminMem0 = new StrictHarnessAdminMem0Adapter();

  try {
    seedProject(dbPath);

    const { internals } = createServer({
      adminMem0Loader: async () => adminMem0,
    });
    const tool = internals.tools.get('harness_admin')!;
    const result = (await tool.handler({
      action: 'mem0_snapshot',
      dbPath,
      projectId: 'proj-1',
      content: 'Persist the approved agentic-web roadmap snapshot.',
    })) as { stored: boolean; memoryId: string };

    assert.equal(result.stored, true);
    assert.equal(result.memoryId, 'mem-1');
    assert.equal(adminMem0.storedInputs.length, 1);
    assert.deepEqual(adminMem0.storedInputs[0].metadata, {
      source: 'harness_admin',
      action: 'mem0_snapshot',
      project_id: 'proj-1',
    });
    assert.equal(adminMem0.storedInputs[0].scope.workspace, 'ws-1');
    assert.equal(adminMem0.storedInputs[0].scope.project, 'proj-1');

    const db = openHarnessDatabase({ dbPath });
    try {
      const links = selectAll<{ memory_ref: string; memory_kind: string }>(
        db.connection,
        'SELECT memory_ref, memory_kind FROM memory_links WHERE project_id = ? ORDER BY created_at DESC',
        ['proj-1'],
      );
      assert.equal(links.length, 1);
      assert.equal(links[0].memory_ref, 'mem-1');
      assert.equal(links[0].memory_kind, 'summary');
    } finally {
      db.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('harness_admin: mem0_rollup persists rollup memory with explicit metadata', async () => {
  const tempDir = createTempDir('admin-mem0-rollup-');
  const dbPath = join(tempDir, 'harness.sqlite');
  const adminMem0 = new StrictHarnessAdminMem0Adapter();

  try {
    seedProject(dbPath);
    const db = openHarnessDatabase({ dbPath });
    try {
      runStatement(
        db.connection,
        `INSERT INTO memory_links (id, workspace_id, project_id, campaign_id, issue_id, memory_kind, memory_ref, summary, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['link-1', 'ws-1', 'proj-1', null, null, 'summary', 'mem-existing-1', 'First summary', '2026-01-01T00:00:00Z'],
      );
      runStatement(
        db.connection,
        `INSERT INTO memory_links (id, workspace_id, project_id, campaign_id, issue_id, memory_kind, memory_ref, summary, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['link-2', 'ws-1', 'proj-1', null, null, 'decision', 'mem-existing-2', 'Second summary', '2026-01-01T00:00:01Z'],
      );
    } finally {
      db.close();
    }

    const { internals } = createServer({
      adminMem0Loader: async () => adminMem0,
    });
    const tool = internals.tools.get('harness_admin')!;
    const result = (await tool.handler({
      action: 'mem0_rollup',
      dbPath,
      projectId: 'proj-1',
    })) as { rolledUp: boolean; memoryId: string; sourceCount: number };

    assert.equal(result.rolledUp, true);
    assert.equal(result.memoryId, 'mem-1');
    assert.equal(result.sourceCount, 2);
    assert.equal(adminMem0.storedInputs.length, 1);
    assert.deepEqual(adminMem0.storedInputs[0].metadata, {
      source: 'harness_admin',
      action: 'mem0_rollup',
      project_id: 'proj-1',
      source_count: '2',
    });
    assert.equal(adminMem0.storedInputs[0].scope.workspace, 'ws-1');
    assert.equal(adminMem0.storedInputs[0].scope.project, 'proj-1');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('harness_admin: mem0_rollup filters by milestoneId via linked issues', async () => {
  const tempDir = createTempDir('admin-mem0-rollup-milestone-');
  const dbPath = join(tempDir, 'harness.sqlite');
  const adminMem0 = new StrictHarnessAdminMem0Adapter();

  try {
    seedProject(dbPath);
    const db = openHarnessDatabase({ dbPath });
    try {
      runStatement(
        db.connection,
        `INSERT INTO milestones (id, project_id, description, priority, status)
         VALUES (?, ?, ?, ?, ?)`,
        ['milestone-a', 'proj-1', 'Milestone A', 'high', 'in_progress'],
      );
      runStatement(
        db.connection,
        `INSERT INTO milestones (id, project_id, description, priority, status)
         VALUES (?, ?, ?, ?, ?)`,
        ['milestone-b', 'proj-1', 'Milestone B', 'medium', 'in_progress'],
      );
      runStatement(
        db.connection,
        `INSERT INTO issues (id, project_id, campaign_id, milestone_id, task, priority, status, size, depends_on, next_best_action)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['issue-a', 'proj-1', null, 'milestone-a', 'Task A', 'high', 'done', 'M', '[]', 'Done'],
      );
      runStatement(
        db.connection,
        `INSERT INTO issues (id, project_id, campaign_id, milestone_id, task, priority, status, size, depends_on, next_best_action)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['issue-b', 'proj-1', null, 'milestone-b', 'Task B', 'high', 'done', 'M', '[]', 'Done'],
      );
      runStatement(
        db.connection,
        `INSERT INTO memory_links (id, workspace_id, project_id, campaign_id, issue_id, memory_kind, memory_ref, summary, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['link-a', 'ws-1', 'proj-1', null, 'issue-a', 'summary', 'mem-a', 'Milestone A memory', '2026-01-01T00:00:00Z'],
      );
      runStatement(
        db.connection,
        `INSERT INTO memory_links (id, workspace_id, project_id, campaign_id, issue_id, memory_kind, memory_ref, summary, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['link-b', 'ws-1', 'proj-1', null, 'issue-b', 'summary', 'mem-b', 'Milestone B memory', '2026-01-01T00:01:00Z'],
      );
    } finally {
      db.close();
    }

    const { internals } = createServer({
      adminMem0Loader: async () => adminMem0,
    });
    const tool = internals.tools.get('harness_admin')!;
    const result = (await tool.handler({
      action: 'mem0_rollup',
      dbPath,
      projectId: 'proj-1',
      milestoneId: 'milestone-a',
    })) as { rolledUp: boolean; sourceCount: number };

    assert.equal(result.rolledUp, true);
    assert.equal(result.sourceCount, 1);
    assert.equal(adminMem0.storedInputs.length, 1);
    assert.match(adminMem0.storedInputs[0].content, /Milestone A memory/);
    assert.doesNotMatch(adminMem0.storedInputs[0].content, /Milestone B memory/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ─── 5. Cross-tool integrity ────────────────────────────────────────

test('cross-tool: only 5 tools are registered on the server', async () => {
  const { internals } = createServer();
  const toolNames = [...internals.tools.keys()].sort();
  assert.deepEqual(toolNames, [
    'harness_admin',
    'harness_artifacts',
    'harness_inspector',
    'harness_orchestrator',
    'harness_session',
  ]);
});

test('cross-tool: every tool handler rejects missing action param', async () => {
  const { internals } = createServer();
  for (const name of ['harness_inspector', 'harness_orchestrator', 'harness_session', 'harness_artifacts', 'harness_admin']) {
    const tool = internals.tools.get(name)!;
    await assert.rejects(
      () => tool.handler({}),
      /Required|Invalid/i,
      `${name} should reject missing action`,
    );
  }
});

test('cross-tool: strict public actions reject unexpected top-level fields', async () => {
  const tempDir = createTempDir('strict-public-surface-');
  const dbPath = join(tempDir, 'harness.sqlite');
  try {
    seedProject(dbPath);
    seedIssue(dbPath, 'issue-strict', 'ready');

    const { internals } = createServer();
    const cases = [
      {
        name: 'harness_inspector',
        args: { action: 'get_context', dbPath, projectId: 'proj-1', legacyField: true },
      },
      {
        name: 'harness_orchestrator',
        args: { action: 'promote_queue', dbPath, projectId: 'proj-1', legacyField: true },
      },
      {
        name: 'harness_session',
        args: { action: 'begin', ...beginArgs(dbPath, { preferredIssueId: 'issue-strict' }), legacyField: true },
      },
      {
        name: 'harness_artifacts',
        args: { action: 'list', dbPath, projectId: 'proj-1', legacyField: true },
      },
      {
        name: 'harness_admin',
        args: { action: 'cleanup', dbPath, projectId: 'proj-1', legacyField: true },
      },
    ] as const;

    for (const testCase of cases) {
      const tool = internals.tools.get(testCase.name)!;
      await assert.rejects(
        () => tool.handler(testCase.args),
        /legacyField/i,
        `${testCase.name} should reject legacyField`,
      );
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
