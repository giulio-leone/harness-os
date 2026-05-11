import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { openHarnessDatabase, runStatement } from '../db/store.js';
import { inspectOrchestration } from '../runtime/orchestration-inspector.js';

let tempCounter = 0;

test('orchestration inspector returns empty summary for scoped project with no orchestration state', () => {
  const tempDir = createLocalTempDir('empty');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);

    const summary = inspectOrchestration({ dbPath, projectId: 'project-1' });

    assert.equal(summary.scope.projectId, 'project-1');
    assert.equal(summary.issues.total, 0);
    assert.deepEqual(summary.issues.statusCounts, {});
    assert.equal(summary.leases.activeCount, 0);
    assert.equal(summary.artifacts.total, 0);
    assert.equal(summary.health.status, 'healthy');
    assert.deepEqual(summary.health.flags, []);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('orchestration inspector summarizes active leases', () => {
  const tempDir = createLocalTempDir('lease');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    seedIssue(dbPath, { issueId: 'issue-active', status: 'in_progress' });
    seedIssue(dbPath, { issueId: 'issue-expired', status: 'in_progress' });
    seedLease(dbPath, {
      leaseId: 'lease-active',
      issueId: 'issue-active',
      agentId: 'agent-1',
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    seedLease(dbPath, {
      leaseId: 'lease-expired',
      issueId: 'issue-expired',
      agentId: 'agent-2',
      expiresAt: '2000-01-01T00:00:00.000Z',
    });

    const summary = inspectOrchestration({ dbPath, projectId: 'project-1' });
    const expiredLeaseFlag = summary.health.flags.find(
      (flag) => flag.kind === 'expired_active_lease',
    );

    assert.equal(summary.issues.statusCounts.in_progress, 2);
    assert.equal(summary.leases.activeCount, 2);
    assert.equal(summary.leases.active[0]?.id, 'lease-active');
    assert.equal(summary.leases.active[0]?.issueId, 'issue-active');
    assert.equal(summary.leases.active[0]?.expired, false);
    assert.ok(expiredLeaseFlag);
    assert.equal(expiredLeaseFlag.leaseId, 'lease-expired');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('orchestration inspector groups artifacts and surfaces orchestration references', () => {
  const tempDir = createLocalTempDir('artifacts');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    seedIssue(dbPath, { issueId: 'issue-artifacts', status: 'in_progress' });
    seedArtifact(dbPath, {
      artifactId: 'artifact-worktree',
      issueId: 'issue-artifacts',
      kind: 'worktree',
      path: 'worktrees/agent-a',
      metadata: {
        worktreeId: 'wt-1',
        worktreePath: 'worktrees/agent-a',
        subagentId: 'agent-a',
      },
    });
    seedArtifact(dbPath, {
      artifactId: 'artifact-evidence',
      issueId: 'issue-artifacts',
      kind: 'evidence_packet',
      path: 'evidence/packet.json',
      metadata: { evidencePacketId: 'packet-1' },
    });
    seedRunAndEvent(dbPath, {
      runId: 'run-artifacts',
      issueId: 'issue-artifacts',
      eventId: 'event-orchestration',
      kind: 'orchestration_status',
      payload: { phase: 'evidence_collected' },
    });

    const summary = inspectOrchestration({ dbPath, projectId: 'project-1' });

    assert.deepEqual(
      summary.artifacts.byKind.map((group) => [group.kind, group.count]),
      [
        ['evidence_packet', 1],
        ['worktree', 1],
      ],
    );
    assert.deepEqual(summary.artifacts.references.worktreeIds, ['wt-1']);
    assert.deepEqual(summary.artifacts.references.worktreePaths, [
      'worktrees/agent-a',
    ]);
    assert.deepEqual(summary.artifacts.references.subagentIds, ['agent-a']);
    assert.deepEqual(summary.artifacts.references.evidencePacketIds, [
      'packet-1',
    ]);
    assert.equal(summary.events.recentCount, 1);
    assert.deepEqual(summary.events.recent[0]?.payload, {
      phase: 'evidence_collected',
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('orchestration inspector scopes issues artifacts leases and events by campaign and issue', () => {
  const tempDir = createLocalTempDir('scoped');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    seedCampaign(dbPath, 'campaign-a');
    seedCampaign(dbPath, 'campaign-b');
    seedIssue(dbPath, {
      issueId: 'issue-a',
      status: 'in_progress',
      campaignId: 'campaign-a',
    });
    seedIssue(dbPath, {
      issueId: 'issue-b',
      status: 'in_progress',
      campaignId: 'campaign-b',
    });
    seedLease(dbPath, {
      leaseId: 'lease-a',
      issueId: 'issue-a',
      agentId: 'agent-a',
      expiresAt: '2999-01-01T00:00:00.000Z',
      campaignId: 'campaign-a',
    });
    seedLease(dbPath, {
      leaseId: 'lease-b',
      issueId: 'issue-b',
      agentId: 'agent-b',
      expiresAt: '2999-01-01T00:00:00.000Z',
      campaignId: 'campaign-b',
    });
    seedArtifact(dbPath, {
      artifactId: 'artifact-a',
      issueId: 'issue-a',
      campaignId: 'campaign-a',
      kind: 'evidence_packet',
      path: 'evidence/a.json',
      metadata: { evidencePacketId: 'packet-a' },
    });
    seedArtifact(dbPath, {
      artifactId: 'artifact-b',
      issueId: 'issue-b',
      campaignId: 'campaign-b',
      kind: 'evidence_packet',
      path: 'evidence/b.json',
      metadata: { evidencePacketId: 'packet-b' },
    });
    seedRunAndEvent(dbPath, {
      runId: 'run-a-1',
      issueId: 'issue-a',
      campaignId: 'campaign-a',
      eventId: 'event-a-1',
      kind: 'orchestration_status',
      payload: { phase: 'first' },
      createdAt: '2026-03-21T00:01:00.000Z',
    });
    seedRunAndEvent(dbPath, {
      runId: 'run-a-2',
      issueId: 'issue-a',
      campaignId: 'campaign-a',
      eventId: 'event-a-2',
      kind: 'orchestration_status',
      payload: { phase: 'second' },
      createdAt: '2026-03-21T00:02:00.000Z',
    });
    seedRunAndEvent(dbPath, {
      runId: 'run-b',
      issueId: 'issue-b',
      campaignId: 'campaign-b',
      eventId: 'event-b',
      kind: 'orchestration_status',
      payload: { phase: 'other-campaign' },
      createdAt: '2026-03-21T00:03:00.000Z',
    });

    const summary = inspectOrchestration({
      dbPath,
      projectId: 'project-1',
      campaignId: 'campaign-a',
      issueId: 'issue-a',
      eventLimit: 1,
    });

    assert.equal(summary.scope.campaignId, 'campaign-a');
    assert.equal(summary.scope.issueId, 'issue-a');
    assert.deepEqual(summary.issues.items.map((issue) => issue.id), ['issue-a']);
    assert.deepEqual(summary.leases.active.map((lease) => lease.id), ['lease-a']);
    assert.deepEqual(
      summary.artifacts.byKind.flatMap((group) =>
        group.artifacts.map((artifact) => artifact.id),
      ),
      ['artifact-a'],
    );
    assert.equal(summary.events.recentCount, 1);
    assert.equal(summary.events.recent[0]?.id, 'event-a-2');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('orchestration inspector flags duplicate active worktree artifact paths', () => {
  const tempDir = createLocalTempDir('duplicate-worktree');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    seedIssue(dbPath, { issueId: 'issue-dup', status: 'in_progress' });
    seedArtifact(dbPath, {
      artifactId: 'artifact-wt-1',
      issueId: 'issue-dup',
      kind: 'worktree',
      path: 'worktrees/shared',
      metadata: { status: 'active' },
    });
    seedArtifact(dbPath, {
      artifactId: 'artifact-wt-2',
      issueId: 'issue-dup',
      kind: 'worktree',
      path: 'worktrees/shared',
      metadata: { status: 'active' },
    });

    const summary = inspectOrchestration({ dbPath, projectId: 'project-1' });
    const duplicateFlag = summary.health.flags.find(
      (flag) => flag.kind === 'duplicate_active_worktree_artifact_path',
    );

    assert.ok(duplicateFlag);
    assert.equal(duplicateFlag.path, 'worktrees/shared');
    assert.deepEqual(duplicateFlag.artifactIds, [
      'artifact-wt-1',
      'artifact-wt-2',
    ]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('orchestration inspector ignores released worktree artifacts for active duplicate health', () => {
  const tempDir = createLocalTempDir('released-worktree');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    seedIssue(dbPath, { issueId: 'issue-released', status: 'in_progress' });
    seedArtifact(dbPath, {
      artifactId: 'artifact-wt-active',
      issueId: 'issue-released',
      kind: 'worktree',
      path: 'worktrees/shared',
      metadata: { status: 'active' },
    });
    seedArtifact(dbPath, {
      artifactId: 'artifact-wt-released',
      issueId: 'issue-released',
      kind: 'worktree',
      path: 'worktrees/shared',
      metadata: { status: 'released' },
    });

    const summary = inspectOrchestration({ dbPath, projectId: 'project-1' });

    assert.equal(
      summary.health.flags.some(
        (flag) => flag.kind === 'duplicate_active_worktree_artifact_path',
      ),
      false,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('orchestration inspector flags done issues missing evidence', () => {
  const tempDir = createLocalTempDir('missing-evidence');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    seedIssue(dbPath, { issueId: 'issue-done', status: 'done' });

    const summary = inspectOrchestration({ dbPath, projectId: 'project-1' });
    const missingEvidenceFlag = summary.health.flags.find(
      (flag) => flag.kind === 'done_issue_missing_evidence',
    );

    assert.ok(missingEvidenceFlag);
    assert.equal(missingEvidenceFlag.issueId, 'issue-done');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('orchestration inspector treats checkpoint artifact ids as evidence only when artifacts exist', () => {
  const tempDir = createLocalTempDir('checkpoint-evidence');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    seedBaseProject(dbPath);
    seedIssue(dbPath, { issueId: 'issue-real-evidence', status: 'done' });
    seedIssue(dbPath, { issueId: 'issue-dangling-evidence', status: 'done' });
    seedArtifact(dbPath, {
      artifactId: 'artifact-test-report',
      issueId: 'issue-real-evidence',
      kind: 'test_report',
      path: 'evidence/test-report.json',
      metadata: { status: 'released' },
    });
    seedRun(dbPath, {
      runId: 'run-real-evidence',
      issueId: 'issue-real-evidence',
    });
    seedRun(dbPath, {
      runId: 'run-dangling-evidence',
      issueId: 'issue-dangling-evidence',
    });
    seedCheckpoint(dbPath, {
      checkpointId: 'checkpoint-real-evidence',
      runId: 'run-real-evidence',
      issueId: 'issue-real-evidence',
      artifactIds: ['artifact-test-report'],
    });
    seedCheckpoint(dbPath, {
      checkpointId: 'checkpoint-dangling-evidence',
      runId: 'run-dangling-evidence',
      issueId: 'issue-dangling-evidence',
      artifactIds: ['missing-artifact'],
    });

    const summary = inspectOrchestration({ dbPath, projectId: 'project-1' });
    const missingEvidenceIssueIds = summary.health.flags
      .filter((flag) => flag.kind === 'done_issue_missing_evidence')
      .map((flag) => flag.issueId);

    assert.deepEqual(missingEvidenceIssueIds, ['issue-dangling-evidence']);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('orchestration inspector refuses to create or initialize databases', () => {
  const missingDir = createLocalTempDir('missing-db');
  const missingDbPath = join(missingDir, 'missing.sqlite');
  const emptyDir = createLocalTempDir('empty-db-file');
  const emptyDbPath = join(emptyDir, 'empty.sqlite');

  try {
    assert.throws(
      () => inspectOrchestration({ dbPath: missingDbPath, projectId: 'project-1' }),
      /unable to open database file|cannot open/,
    );
    assert.equal(existsSync(missingDbPath), false);

    writeFileSync(emptyDbPath, '');

    assert.throws(
      () => inspectOrchestration({ dbPath: emptyDbPath, projectId: 'project-1' }),
      /not a current agent-harness database/,
    );
    assert.equal(statSync(emptyDbPath).size, 0);
  } finally {
    rmSync(missingDir, { recursive: true, force: true });
    rmSync(emptyDir, { recursive: true, force: true });
  }
});

function createLocalTempDir(name: string): string {
  const dir = join(
    process.cwd(),
    '.test-output',
    `orchestration-inspector-${process.pid}-${tempCounter++}-${name}`,
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
        'Inspector Workspace',
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
        'inspector-project',
        'Inspector Project',
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
        'Inspect a campaign-scoped orchestration slice.',
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

function seedIssue(
  dbPath: string,
  input: { issueId: string; status: string; campaignId?: string },
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
        `Task ${input.issueId}`,
        'medium',
        input.status,
        'M',
        '[]',
        null,
        '{}',
        'Inspect orchestration state.',
        null,
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
    campaignId?: string;
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
        input.campaignId ?? null,
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

function seedArtifact(
  dbPath: string,
  input: {
    artifactId: string;
    issueId: string;
    campaignId?: string;
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
        input.campaignId ?? null,
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

function seedRunAndEvent(
  dbPath: string,
  input: {
    runId: string;
    issueId: string;
    campaignId?: string;
    eventId: string;
    kind: string;
    payload: Record<string, unknown>;
    createdAt?: string;
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
        'host-1',
        'running',
        '2026-03-21T00:00:00.000Z',
        null,
        null,
      ],
    );
    runStatement(
      database.connection,
      `INSERT INTO events (id, run_id, issue_id, kind, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        input.eventId,
        input.runId,
        input.issueId,
        input.kind,
        JSON.stringify(input.payload),
        input.createdAt ?? '2026-03-21T00:05:00.000Z',
      ],
    );
  } finally {
    database.close();
  }
}

function seedRun(
  dbPath: string,
  input: { runId: string; issueId: string; campaignId?: string },
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
        'host-1',
        'finished',
        '2026-03-21T00:00:00.000Z',
        '2026-03-21T00:06:00.000Z',
        null,
      ],
    );
  } finally {
    database.close();
  }
}

function seedCheckpoint(
  dbPath: string,
  input: {
    checkpointId: string;
    runId: string;
    issueId: string;
    artifactIds: readonly string[];
  },
): void {
  const database = openHarnessDatabase({ dbPath });

  try {
    runStatement(
      database.connection,
      `INSERT INTO checkpoints (
         id, run_id, issue_id, title, summary, task_status, next_step,
         artifact_ids_json, created_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.checkpointId,
        input.runId,
        input.issueId,
        'close',
        'Closed with automated evidence references.',
        'done',
        'Continue to the next issue.',
        JSON.stringify(input.artifactIds),
        '2026-03-21T00:05:00.000Z',
      ],
    );
  } finally {
    database.close();
  }
}
