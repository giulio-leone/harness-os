import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createHarnessCampaign,
  initHarnessWorkspace,
  openHarnessDatabase,
  planHarnessIssues,
  rollbackHarnessIssue,
  runStatement,
  selectAll,
  selectOne,
} from '../index.js';

// ─── Helper types for test assertions ───────────────────────────────

interface PlanResult {
  milestoneId: string;
  issueCount: number;
  generatedIssues: Array<{ id: string; task: string; dependsOn: string[] }>;
}

interface CampaignResult {
  projectId: string;
  projectKey: string;
  campaignId: string;
}

interface WorkspaceResult {
  workspaceId: string;
}

interface RollbackResult {
  issueId: string;
  previousStatus: string;
  newStatus: string;
  rollbackRunId: string;
}

// ─── Tests ──────────────────────────────────────────────────────────

test('createHarnessCampaign isolates projects by workspace and is idempotent within one workspace', () => {
  const tempDir = createTempDir('harness-planning-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    const firstWorkspace = initHarnessWorkspace({
      dbPath,
      workspaceName: 'Workspace One',
    }) as unknown as WorkspaceResult;
    const secondWorkspace = initHarnessWorkspace({
      dbPath,
      workspaceName: 'Workspace Two',
    }) as unknown as WorkspaceResult;

    const firstCampaign = createHarnessCampaign({
      dbPath,
      workspaceId: firstWorkspace.workspaceId,
      projectName: 'Shared Project',
      campaignName: 'Campaign Alpha',
      objective: 'Ship the first branch',
    }) as unknown as CampaignResult;
    const repeatedCampaign = createHarnessCampaign({
      dbPath,
      workspaceId: firstWorkspace.workspaceId,
      projectName: 'Shared Project',
      campaignName: 'Campaign Alpha',
      objective: 'Ship the first branch',
    }) as unknown as CampaignResult;
    const secondCampaign = createHarnessCampaign({
      dbPath,
      workspaceId: secondWorkspace.workspaceId,
      projectName: 'Shared Project',
      campaignName: 'Campaign Alpha',
      objective: 'Ship the second branch',
    }) as unknown as CampaignResult;

    assert.equal(repeatedCampaign.projectId, firstCampaign.projectId);
    assert.equal(repeatedCampaign.campaignId, firstCampaign.campaignId);
    assert.notEqual(secondCampaign.projectId, firstCampaign.projectId);
    assert.notEqual(secondCampaign.projectKey, firstCampaign.projectKey);

    const database = openHarnessDatabase({ dbPath });

    try {
      const projects = selectAll<{ id: string }>(
        database.connection,
        'SELECT id FROM projects ORDER BY id ASC',
      );
      const campaigns = selectAll<{ id: string }>(
        database.connection,
        'SELECT id FROM campaigns ORDER BY id ASC',
      );

      assert.equal(projects.length, 2);
      assert.equal(campaigns.length, 2);
    } finally {
      database.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('planHarnessIssues stores validated backward dependencies', () => {
  const tempDir = createTempDir('harness-plan-issues-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    const workspace = initHarnessWorkspace({
      dbPath,
      workspaceName: 'Planning Workspace',
    }) as unknown as WorkspaceResult;
    const campaign = createHarnessCampaign({
      dbPath,
      workspaceId: workspace.workspaceId,
      projectName: 'Planner',
      campaignName: 'Campaign Beta',
      objective: 'Plan the queue',
    }) as unknown as CampaignResult;
    const planned = planHarnessIssues({
      dbPath,
      projectId: campaign.projectId,
      campaignId: campaign.campaignId,
      milestoneDescription: 'Milestone for testing',
      issues: [
        {
          task: 'Bootstrap workspace',
          priority: 'high',
          size: 'S',
        },
        {
          task: 'Seed campaigns',
          priority: 'critical',
          size: 'M',
          depends_on_indices: [0],
        },
        {
          task: 'Review output',
          priority: 'medium',
          size: 'S',
          depends_on_indices: [0, 1],
        },
      ],
    }) as unknown as PlanResult;

    assert.equal(planned.generatedIssues.length, 3);
    assert.deepEqual(planned.generatedIssues[1].dependsOn, [
      planned.generatedIssues[0].id,
    ]);
    assert.deepEqual(planned.generatedIssues[2].dependsOn, [
      planned.generatedIssues[0].id,
      planned.generatedIssues[1].id,
    ]);

    const database = openHarnessDatabase({ dbPath });

    try {
      const milestone = selectOne<{ priority: string }>(
        database.connection,
        'SELECT priority FROM milestones WHERE id = ?',
        [planned.milestoneId],
      );
      const thirdIssue = selectOne<{ depends_on: string }>(
        database.connection,
        'SELECT depends_on FROM issues WHERE id = ?',
        [planned.generatedIssues[2].id],
      );

      assert.equal(milestone?.priority, 'critical');
      assert.deepEqual(
        JSON.parse(thirdIssue?.depends_on ?? '[]'),
        planned.generatedIssues[2].dependsOn,
      );
    } finally {
      database.close();
    }

    assert.throws(
      () =>
        planHarnessIssues({
          dbPath,
          projectId: campaign.projectId,
          campaignId: campaign.campaignId,
          milestoneDescription: 'Invalid milestone',
          issues: [
            {
              task: 'Invalid self dependency',
              priority: 'high',
              size: 'S',
              depends_on_indices: [0],
            },
          ],
        }),
      /can depend only on earlier issues/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('rollbackHarnessIssue creates a rollback run and releases active leases atomically', () => {
  const tempDir = createTempDir('harness-rollback-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    const workspace = initHarnessWorkspace({
      dbPath,
      workspaceName: 'Rollback Workspace',
    }) as unknown as WorkspaceResult;
    const campaign = createHarnessCampaign({
      dbPath,
      workspaceId: workspace.workspaceId,
      projectName: 'Rollback Project',
      campaignName: 'Campaign Gamma',
      objective: 'Recover broken work',
    }) as unknown as CampaignResult;
    const planned = planHarnessIssues({
      dbPath,
      projectId: campaign.projectId,
      campaignId: campaign.campaignId,
      milestoneDescription: 'Rollback milestone',
      issues: [
        {
          task: 'Recover failed issue',
          priority: 'high',
          size: 'M',
        },
      ],
    }) as unknown as PlanResult;

    const database = openHarnessDatabase({ dbPath });

    try {
      runStatement(
        database.connection,
        `UPDATE issues SET status = 'blocked', next_best_action = 'Resume later' WHERE id = ?`,
        [planned.generatedIssues[0].id],
      );
      runStatement(
        database.connection,
        `INSERT INTO leases (id, workspace_id, project_id, campaign_id, issue_id, agent_id, status, acquired_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        [
          'lease-1',
          workspace.workspaceId,
          campaign.projectId,
          campaign.campaignId,
          planned.generatedIssues[0].id,
          'agent-1',
          '2026-03-22T00:00:00.000Z',
          '2026-03-22T01:00:00.000Z',
        ],
      );
    } finally {
      database.close();
    }

    const rollback = rollbackHarnessIssue({
      dbPath,
      issueId: planned.generatedIssues[0].id,
    }) as unknown as RollbackResult;

    assert.equal(rollback.newStatus, 'pending');

    const reopenedDatabase = openHarnessDatabase({ dbPath });

    try {
      const issue = selectOne<{ status: string; next_best_action: string | null }>(
        reopenedDatabase.connection,
        'SELECT status, next_best_action FROM issues WHERE id = ?',
        [planned.generatedIssues[0].id],
      );
      const lease = selectOne<{ status: string; released_at: string | null }>(
        reopenedDatabase.connection,
        'SELECT status, released_at FROM leases WHERE id = ?',
        ['lease-1'],
      );
      const run = selectOne<{ session_type: string; status: string }>(
        reopenedDatabase.connection,
        'SELECT session_type, status FROM runs WHERE id = ?',
        [rollback.rollbackRunId],
      );
      const event = selectOne<{ run_id: string; payload: string }>(
        reopenedDatabase.connection,
        `SELECT run_id, payload
           FROM events
          WHERE issue_id = ? AND kind = 'issue_rollback'
          LIMIT 1`,
        [planned.generatedIssues[0].id],
      );

      assert.equal(issue?.status, 'pending');
      assert.equal(issue?.next_best_action, null);
      assert.equal(lease?.status, 'released');
      assert.notEqual(lease?.released_at, null);
      assert.equal(run?.session_type, 'system_rollback');
      assert.equal(run?.status, 'finished');
      assert.equal(event?.run_id, rollback.rollbackRunId);
      assert.deepEqual(JSON.parse(event?.payload ?? '{}'), {
        previousStatus: 'blocked',
        rolledBackTo: 'pending',
      });
    } finally {
      reopenedDatabase.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
