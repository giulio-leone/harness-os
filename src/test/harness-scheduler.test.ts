import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createHarnessCampaign,
  initHarnessWorkspace,
  matchesCronExpression,
  openHarnessDatabase,
  runHarnessScheduler,
  selectAll,
  selectOne,
} from '../index.js';

test('matchesCronExpression supports steps and weekday ranges', () => {
  assert.equal(
    matchesCronExpression('*/5 10 * * 1-5', new Date(2026, 2, 23, 10, 15, 0)),
    true,
  );
  assert.equal(
    matchesCronExpression('*/5 10 * * 1-5', new Date(2026, 2, 23, 10, 16, 0)),
    false,
  );
  assert.equal(
    matchesCronExpression('0 9 * * 1-5', new Date(2026, 2, 22, 9, 0, 0)),
    false,
  );
});

test('runHarnessScheduler injects due jobs once per minute and skips duplicates', () => {
  const tempDir = createTempDir('harness-scheduler-');
  const dbPath = join(tempDir, 'harness.sqlite');
  const configPath = join(tempDir, 'scheduler.json');

  try {
    const workspace = initHarnessWorkspace({
      dbPath,
      workspaceName: 'Scheduler Workspace',
    });
    const campaign = createHarnessCampaign({
      dbPath,
      workspaceId: workspace.workspaceId,
      projectName: 'Scheduler Project',
      campaignName: 'Campaign Delta',
      objective: 'Inject scheduled work',
    });

    writeFileSync(
      configPath,
      JSON.stringify(
        [
          {
            task: 'Run recurring sync',
            cron: '* * * * *',
            projectKey: campaign.projectKey,
            campaignName: 'Campaign Delta',
            priority: 'high',
            size: 'S',
            deadlineAt: '2026-03-23T10:45:00.000Z',
            recipients: [
              {
                id: 'scheduler-bot',
                kind: 'service',
                label: 'Scheduler Bot',
              },
            ],
            policy: {
              owner: 'scheduler-bot',
              serviceLevel: {
                resolveWithinMinutes: 60,
              },
            },
          },
          {
            task: 'Never due here',
            cron: '0 0 1 1 *',
            projectKey: campaign.projectKey,
            campaignName: 'Campaign Delta',
            priority: 'low',
            size: 'S',
          },
        ],
        null,
        2,
      ),
    );

    const firstRun = runHarnessScheduler({
      dbPath,
      configPath,
      now: new Date('2026-03-23T10:15:00Z'),
    });
    const duplicateRun = runHarnessScheduler({
      dbPath,
      configPath,
      now: new Date('2026-03-23T10:15:30Z'),
    });
    const nextMinuteRun = runHarnessScheduler({
      dbPath,
      configPath,
      now: new Date('2026-03-23T10:16:00Z'),
    });

    assert.equal(firstRun.loadedJobs, 2);
    assert.equal(firstRun.dueJobs, 1);
    assert.equal(firstRun.insertedIssues.length, 1);
    assert.equal(
      firstRun.skippedJobs.some((job) => job.reason.startsWith('Not due')),
      true,
    );

    assert.equal(duplicateRun.insertedIssues.length, 0);
    assert.equal(
      duplicateRun.skippedJobs.some((job) =>
        job.reason.startsWith('Already injected'),
      ),
      true,
    );

    assert.equal(nextMinuteRun.insertedIssues.length, 1);

    const database = openHarnessDatabase({ dbPath });

    try {
      const issues = selectAll<{ id: string }>(
        database.connection,
        'SELECT id FROM issues ORDER BY id ASC',
      );
      const injections = selectAll<{ job_key: string; scheduled_for: string }>(
        database.connection,
        'SELECT job_key, scheduled_for FROM scheduler_injections ORDER BY scheduled_for ASC',
      );
      const scheduledIssue = selectOne<{
        deadline_at: string | null;
        recipients_json: string;
        policy_json: string;
      }>(
        database.connection,
        `SELECT deadline_at, recipients_json, policy_json
          FROM issues
          WHERE task = ?
          ORDER BY created_at ASC
         LIMIT 1`,
        ['Run recurring sync'],
      );

      assert.equal(issues.length, 2);
      assert.equal(injections.length, 2);
      assert.equal(scheduledIssue?.deadline_at, '2026-03-23T10:45:00.000Z');
      assert.deepEqual(JSON.parse(scheduledIssue?.recipients_json ?? '[]'), [
        {
          id: 'scheduler-bot',
          kind: 'service',
          label: 'Scheduler Bot',
        },
      ]);
      assert.deepEqual(JSON.parse(scheduledIssue?.policy_json ?? '{}'), {
        owner: 'scheduler-bot',
        serviceLevel: {
          resolveWithinMinutes: 60,
        },
      });
    } finally {
      database.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
