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
  promoteEligiblePendingIssues,
  rollbackHarnessIssue,
  runStatement,
  selectAll,
  selectOne,
} from '../index.js';

// ─── Helper types for test assertions ───────────────────────────────

interface BatchPlanResult {
  milestoneCount: number;
  issueCount: number;
  generatedMilestones: Array<{
    key: string;
    id: string;
    description: string;
    dependsOnMilestoneIds: string[];
    generatedIssues: Array<{ id: string; task: string; dependsOn: string[] }>;
  }>;
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

test('createHarnessCampaign requires workspaceId when multiple workspaces exist', () => {
  const tempDir = createTempDir('harness-planning-ambiguous-workspace-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    initHarnessWorkspace({
      dbPath,
      workspaceName: 'Workspace One',
    });
    initHarnessWorkspace({
      dbPath,
      workspaceName: 'Workspace Two',
    });

    assert.throws(
      () =>
        createHarnessCampaign({
          dbPath,
          projectName: 'Shared Project',
          campaignName: 'Campaign Ambiguous',
          objective: 'Force explicit scope selection',
        }),
      /workspaceId is required/i,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('planHarnessIssues stores validated issue dependencies inside a canonical milestone batch', () => {
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
      milestones: [
        {
          milestone_key: 'test-milestone',
          description: 'Milestone for testing',
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
        },
      ],
    }) as unknown as BatchPlanResult;

    const milestone = planned.generatedMilestones[0];

    assert.equal(planned.generatedMilestones.length, 1);
    assert.equal(milestone.generatedIssues.length, 3);
    assert.deepEqual(milestone.generatedIssues[1].dependsOn, [
      milestone.generatedIssues[0].id,
    ]);
    assert.deepEqual(milestone.generatedIssues[2].dependsOn, [
      milestone.generatedIssues[0].id,
      milestone.generatedIssues[1].id,
    ]);

    const database = openHarnessDatabase({ dbPath });

    try {
      const storedMilestone = selectOne<{ priority: string }>(
        database.connection,
        'SELECT priority FROM milestones WHERE id = ?',
        [milestone.id],
      );
      const thirdIssue = selectOne<{ depends_on: string }>(
        database.connection,
        'SELECT depends_on FROM issues WHERE id = ?',
        [milestone.generatedIssues[2].id],
      );

      assert.equal(storedMilestone?.priority, 'critical');
      assert.deepEqual(
        JSON.parse(thirdIssue?.depends_on ?? '[]'),
        milestone.generatedIssues[2].dependsOn,
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
          milestones: [
            {
              milestone_key: 'invalid-milestone',
              description: 'Invalid milestone',
              issues: [
                {
                  task: 'Invalid self dependency',
                  priority: 'high',
                  size: 'S',
                  depends_on_indices: [0],
                },
              ],
            },
          ],
        }),
      /can depend only on earlier issues/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('planHarnessIssues supports milestone-level dependencies across canonical batch imports', () => {
  const tempDir = createTempDir('harness-plan-cross-milestone-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    const workspace = initHarnessWorkspace({
      dbPath,
      workspaceName: 'Cross Milestone Workspace',
    }) as unknown as WorkspaceResult;
    const campaign = createHarnessCampaign({
      dbPath,
      workspaceId: workspace.workspaceId,
      projectName: 'Planner',
      campaignName: 'Campaign Delta',
      objective: 'Preserve milestone hierarchy in the live queue',
    }) as unknown as CampaignResult;

    const foundation = planHarnessIssues({
      dbPath,
      projectId: campaign.projectId,
      campaignId: campaign.campaignId,
      milestones: [
        {
          milestone_key: 'foundation',
          description: 'Foundation',
          issues: [
            {
              task: 'Build the base layer',
              priority: 'high',
              size: 'M',
            },
          ],
        },
      ],
    }) as unknown as BatchPlanResult;

    const followUp = planHarnessIssues({
      dbPath,
      projectId: campaign.projectId,
      campaignId: campaign.campaignId,
      milestones: [
        {
          milestone_key: 'follow-up',
          description: 'Follow-up',
          depends_on_milestone_ids: [foundation.generatedMilestones[0].id],
          issues: [
            {
              task: 'Polish the base layer',
              priority: 'medium',
              size: 'S',
            },
          ],
        },
      ],
    }) as unknown as BatchPlanResult;

    const batch = planHarnessIssues({
      dbPath,
      projectId: campaign.projectId,
      campaignId: campaign.campaignId,
      milestones: [
        {
          milestone_key: 'qa',
          description: 'QA',
          depends_on_milestone_keys: ['polish'],
          issues: [
            {
              task: 'Run QA pass',
              priority: 'medium',
              size: 'S',
            },
          ],
        },
        {
          milestone_key: 'polish',
          description: 'Batch polish',
          issues: [
            {
              task: 'Batch polish task',
              priority: 'high',
              size: 'S',
            },
          ],
        },
      ],
    }) as unknown as BatchPlanResult;

    const foundationMilestone = foundation.generatedMilestones[0];
    const followUpMilestone = followUp.generatedMilestones[0];

    assert.equal(followUpMilestone.dependsOnMilestoneIds[0], foundationMilestone.id);
    assert.equal(batch.milestoneCount, 2);
    assert.equal(batch.issueCount, 2);

    const polishMilestone = batch.generatedMilestones.find((item) => item.key === 'polish');
    const qaMilestone = batch.generatedMilestones.find((item) => item.key === 'qa');

    assert.ok(polishMilestone);
    assert.ok(qaMilestone);
    assert.deepEqual(qaMilestone?.dependsOnMilestoneIds, [polishMilestone?.id]);

    const database = openHarnessDatabase({ dbPath });

    try {
      const initialPromotion = promoteEligiblePendingIssues(database.connection, {
        projectId: campaign.projectId,
        campaignId: campaign.campaignId,
      }).map((issue) => issue.id);

      assert.deepEqual(
        [...initialPromotion].sort(),
        [
          foundationMilestone.generatedIssues[0].id,
          polishMilestone?.generatedIssues[0].id,
        ].sort(),
      );

      const followUpStatus = selectOne<{ status: string; depends_on: string }>(
        database.connection,
        'SELECT status, depends_on FROM milestones WHERE id = ?',
        [followUpMilestone.id],
      );
      const qaStatus = selectOne<{ status: string; depends_on: string }>(
        database.connection,
        'SELECT status, depends_on FROM milestones WHERE id = ?',
        [qaMilestone?.id],
      );

      assert.equal(followUpStatus?.status, 'blocked');
      assert.deepEqual(JSON.parse(followUpStatus?.depends_on ?? '[]'), [foundationMilestone.id]);
      assert.equal(qaStatus?.status, 'blocked');
      assert.deepEqual(JSON.parse(qaStatus?.depends_on ?? '[]'), [polishMilestone?.id]);

      runStatement(
        database.connection,
        `UPDATE issues
         SET status = 'done'
         WHERE id IN (?, ?)`,
        [foundationMilestone.generatedIssues[0].id, polishMilestone?.generatedIssues[0].id],
      );

      const secondPromotion = promoteEligiblePendingIssues(database.connection, {
        projectId: campaign.projectId,
        campaignId: campaign.campaignId,
      }).map((issue) => issue.id);

      assert.deepEqual(
        [...secondPromotion].sort(),
        [
          followUpMilestone.generatedIssues[0].id,
          qaMilestone?.generatedIssues[0].id,
        ].sort(),
      );

      const refreshedFollowUp = selectOne<{ status: string }>(
        database.connection,
        'SELECT status FROM milestones WHERE id = ?',
        [followUpMilestone.id],
      );
      const refreshedQa = selectOne<{ status: string }>(
        database.connection,
        'SELECT status FROM milestones WHERE id = ?',
        [qaMilestone?.id],
      );

      assert.equal(refreshedFollowUp?.status, 'ready');
      assert.equal(refreshedQa?.status, 'ready');
    } finally {
      database.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('planHarnessIssues rejects ambiguous projectName across workspaces without workspaceId', () => {
  const tempDir = createTempDir('harness-plan-ambiguous-project-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    const workspaceOne = initHarnessWorkspace({
      dbPath,
      workspaceName: 'Workspace One',
    }) as unknown as WorkspaceResult;
    const workspaceTwo = initHarnessWorkspace({
      dbPath,
      workspaceName: 'Workspace Two',
    }) as unknown as WorkspaceResult;

    const firstCampaign = createHarnessCampaign({
      dbPath,
      workspaceId: workspaceOne.workspaceId,
      projectName: 'Shared Project',
      campaignName: 'Campaign One',
      objective: 'Plan queue one',
    }) as unknown as CampaignResult;
    createHarnessCampaign({
      dbPath,
      workspaceId: workspaceTwo.workspaceId,
      projectName: 'Shared Project',
      campaignName: 'Campaign Two',
      objective: 'Plan queue two',
    });

    assert.throws(
      () =>
        planHarnessIssues({
          dbPath,
          projectName: 'Shared Project',
          campaignId: firstCampaign.campaignId,
          milestones: [
            {
              milestone_key: 'ambiguous-scope',
              description: 'Ambiguous project resolution',
              issues: [
                {
                  task: 'Do the work',
                  priority: 'high',
                  size: 'S',
                },
              ],
            },
          ],
        }),
      /workspaceId is required|matches multiple projects|is ambiguous/i,
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
      milestones: [
        {
          milestone_key: 'rollback-milestone',
          description: 'Rollback milestone',
          issues: [
            {
              task: 'Recover failed issue',
              priority: 'high',
              size: 'M',
            },
          ],
        },
      ],
    }) as unknown as BatchPlanResult;
    const plannedIssue = planned.generatedMilestones[0].generatedIssues[0];

    const database = openHarnessDatabase({ dbPath });

    try {
      runStatement(
        database.connection,
        `UPDATE issues SET status = 'blocked', next_best_action = 'Resume later' WHERE id = ?`,
        [plannedIssue.id],
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
          plannedIssue.id,
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
      issueId: plannedIssue.id,
    }) as unknown as RollbackResult;

    assert.equal(rollback.newStatus, 'pending');

    const reopenedDatabase = openHarnessDatabase({ dbPath });

    try {
      const issue = selectOne<{ status: string; next_best_action: string | null }>(
        reopenedDatabase.connection,
        'SELECT status, next_best_action FROM issues WHERE id = ?',
        [plannedIssue.id],
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
        [plannedIssue.id],
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
