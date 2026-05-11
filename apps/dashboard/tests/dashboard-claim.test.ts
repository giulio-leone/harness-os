import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  openHarnessDatabase,
  runStatement,
  selectOne,
} from 'harness-os/dashboard-server';

import {
  claimDashboardIssue,
  claimDashboardIssueFromFormData,
} from '../lib/dashboard-claim';

test('dashboard claim helper uses canonical session lifecycle to claim a ready issue', async () => {
  const dbPath = seedClaimDatabase();

  const result = await claimDashboardIssue(
    {
      dbPath,
      projectId: 'P-claim',
      campaignId: 'C-claim',
      issueId: 'I-claim-ready',
      agentId: 'dashboard-agent-1',
      host: 'dashboard-host',
      hostCapabilities: {
        workloadClasses: ['default', 'typescript'],
        capabilities: ['node', 'sqlite', 'dashboard'],
      },
      leaseTtlSeconds: 1200,
    },
    {
      sessionIdFactory: () => 'RUN-dashboard-claim',
    },
  );

  assert.equal(result.issueId, 'I-claim-ready');
  assert.equal(result.runId, 'RUN-dashboard-claim');
  assert.equal(result.agentId, 'dashboard-agent-1');
  assert.equal(result.claimMode, 'claim');

  const database = openHarnessDatabase({ dbPath });
  try {
    const issue = selectOne<{ status: string }>(
      database.connection,
      'SELECT status FROM issues WHERE id = ?',
      ['I-claim-ready'],
    );
    const lease = selectOne<{ agent_id: string; status: string }>(
      database.connection,
      'SELECT agent_id, status FROM leases WHERE issue_id = ?',
      ['I-claim-ready'],
    );
    const artifact = selectOne<{ kind: string; path: string }>(
      database.connection,
      'SELECT kind, path FROM artifacts WHERE issue_id = ?',
      ['I-claim-ready'],
    );
    const checkpoint = selectOne<{ title: string; task_status: string }>(
      database.connection,
      'SELECT title, task_status FROM checkpoints WHERE issue_id = ?',
      ['I-claim-ready'],
    );

    assert.deepEqual({ ...issue }, { status: 'in_progress' });
    assert.deepEqual({ ...lease }, { agent_id: 'dashboard-agent-1', status: 'active' });
    assert.equal(artifact?.kind, 'dashboard_claim');
    assert.match(artifact?.path ?? '', /^harness-dashboard:\/\/claims\/RUN-dashboard-claim\/I-claim-ready$/);
    assert.deepEqual({ ...checkpoint }, { title: 'claim', task_status: 'in_progress' });
  } finally {
    database.close();
  }
});

test('dashboard claim form parser reads live env and rejects invalid host config', async () => {
  const dbPath = seedClaimDatabase();
  const formData = new FormData();
  formData.set('issueId', 'I-claim-ready');

  const result = await claimDashboardIssueFromFormData(
    formData,
    {
      HARNESS_DASHBOARD_DB_PATH: dbPath,
      HARNESS_DASHBOARD_PROJECT_ID: 'P-claim',
      HARNESS_DASHBOARD_CAMPAIGN_ID: 'C-claim',
      HARNESS_DASHBOARD_CLAIM_AGENT_ID: 'dashboard-agent-form',
    },
    {
      sessionIdFactory: () => 'RUN-dashboard-form',
    },
  );

  assert.equal(result.issueId, 'I-claim-ready');
  assert.equal(result.agentId, 'dashboard-agent-form');

  assert.rejects(
    () =>
      claimDashboardIssueFromFormData(formData, {
        HARNESS_DASHBOARD_DB_PATH: dbPath,
        HARNESS_DASHBOARD_PROJECT_ID: 'P-claim',
        HARNESS_DASHBOARD_WORKLOAD_CLASSES: ',,,',
      }),
    /HARNESS_DASHBOARD_WORKLOAD_CLASSES must include at least one non-empty value/,
  );
});

test('dashboard claim helper rejects pending issues before invoking lifecycle claim', async () => {
  const dbPath = seedClaimDatabase();

  await assert.rejects(
    () =>
      claimDashboardIssue(
        {
          dbPath,
          projectId: 'P-claim',
          campaignId: 'C-claim',
          issueId: 'I-claim-pending',
        },
        {
          orchestrator: {
            beginIncrementalSession: async () => {
              throw new Error('orchestrator should not be called for pending issues');
            },
          },
        },
      ),
    /dashboard claims require ready issues/,
  );
});

function seedClaimDatabase(): string {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'harness-dashboard-claim-')), 'harness.sqlite');
  const database = openHarnessDatabase({ dbPath });
  const now = '2026-01-02T03:04:05.000Z';

  try {
    runStatement(
      database.connection,
      `INSERT INTO workspaces (id, name, kind, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      ['W-claim', 'Claim Workspace', 'local', now, now],
    );
    runStatement(
      database.connection,
      `INSERT INTO projects (id, workspace_id, key, name, domain, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'P-claim',
        'W-claim',
        'claim',
        'Claim Project',
        'orchestration',
        'active',
        now,
        now,
      ],
    );
    runStatement(
      database.connection,
      `INSERT INTO campaigns (
         id,
         project_id,
         name,
         objective,
         status,
         scope_json,
         policy_json,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, '{}', '{}', ?, ?)`,
      [
        'C-claim',
        'P-claim',
        'Claim Campaign',
        'Validate dashboard claim actions.',
        'active',
        now,
        now,
      ],
    );
    runStatement(
      database.connection,
      `INSERT INTO issues (
         id,
         project_id,
         campaign_id,
         task,
         priority,
         status,
         size,
         depends_on,
         recipients_json,
         approvals_json,
         external_refs_json,
         policy_json,
         next_best_action,
         created_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', '[]', '[]', '{}', ?, ?)`,
      [
        'I-claim-ready',
        'P-claim',
        'C-claim',
        'Claim this issue from the dashboard',
        'high',
        'ready',
        'M',
        'Start implementation with evidence capture.',
        now,
      ],
    );
    runStatement(
      database.connection,
      `INSERT INTO issues (
         id,
         project_id,
         campaign_id,
         task,
         priority,
         status,
         size,
         depends_on,
         recipients_json,
         approvals_json,
         external_refs_json,
         policy_json,
         next_best_action,
         created_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', '[]', '[]', '{}', ?, ?)`,
      [
        'I-claim-pending',
        'P-claim',
        'C-claim',
        'Pending issue awaiting promotion',
        'high',
        'pending',
        'M',
        'Promote queue before claiming from the dashboard.',
        now,
      ],
    );
  } finally {
    database.close();
  }

  return dbPath;
}
