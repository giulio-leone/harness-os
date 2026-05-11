import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openHarnessDatabase, runStatement, selectOne } from 'harness-os/dashboard-server';

import {
  createDashboardIssue,
  createDashboardIssueFromFormData,
} from '../lib/dashboard-ticket-writer';

test('dashboard ticket writer creates a ready issue in the configured live scope', () => {
  const dbPath = seedDashboardDatabase();

  const result = createDashboardIssue(
    {
      dbPath,
      projectId: 'P-dashboard',
      campaignId: 'C-dashboard',
      task: '  Add operational dashboard ticket creation  ',
      priority: 'high',
      size: 'M',
      nextBestAction: '  Dispatch after scope review  ',
    },
    {
      idFactory: () => 'I-dashboard-created',
      now: () => '2026-01-02T03:04:05.000Z',
    },
  );

  assert.deepEqual(result, {
    issueId: 'I-dashboard-created',
    projectId: 'P-dashboard',
    campaignId: 'C-dashboard',
    status: 'ready',
  });

  const database = openHarnessDatabase({ dbPath });
  try {
    const row = selectOne<{
      id: string;
      project_id: string;
      campaign_id: string;
      task: string;
      priority: string;
      status: string;
      size: string;
      next_best_action: string;
      external_refs_json: string;
      created_at: string;
    }>(
      database.connection,
      `SELECT id,
              project_id,
              campaign_id,
              task,
              priority,
              status,
              size,
              next_best_action,
              external_refs_json,
              created_at
       FROM issues
       WHERE id = ?`,
      ['I-dashboard-created'],
    );

    assert.deepEqual({ ...row }, {
      id: 'I-dashboard-created',
      project_id: 'P-dashboard',
      campaign_id: 'C-dashboard',
      task: 'Add operational dashboard ticket creation',
      priority: 'high',
      status: 'ready',
      size: 'M',
      next_best_action: 'Dispatch after scope review',
      external_refs_json:
        '[{"id":"dashboard-create-ticket","kind":"dashboard","value":"create-ticket","label":"Created from HarnessOS dashboard"}]',
      created_at: '2026-01-02T03:04:05.000Z',
    });
  } finally {
    database.close();
  }
});

test('dashboard ticket form parser uses live dashboard environment scope', () => {
  const dbPath = seedDashboardDatabase();
  const formData = new FormData();
  formData.set('task', 'Create a deterministic evidence packet');
  formData.set('priority', 'critical');
  formData.set('size', 'S');
  formData.set('nextBestAction', 'Run the E2E matrix');

  const result = createDashboardIssueFromFormData(
    formData,
    {
      HARNESS_DASHBOARD_DB_PATH: dbPath,
      HARNESS_DASHBOARD_PROJECT_ID: 'P-dashboard',
      HARNESS_DASHBOARD_CAMPAIGN_ID: 'C-dashboard',
    },
    {
      idFactory: () => 'I-form-created',
      now: () => '2026-01-02T03:04:05.000Z',
    },
  );

  assert.equal(result.issueId, 'I-form-created');
  assert.equal(result.status, 'ready');
});

test('dashboard ticket writer rejects invalid live scopes and form values', () => {
  const dbPath = seedDashboardDatabase();
  const formData = new FormData();
  formData.set('task', 'Valid task body');
  formData.set('priority', 'urgent');
  formData.set('size', 'M');

  assert.throws(
    () =>
      createDashboardIssueFromFormData(formData, {
        HARNESS_DASHBOARD_DB_PATH: dbPath,
        HARNESS_DASHBOARD_PROJECT_ID: 'P-dashboard',
      }),
    /priority must be one of/,
  );

  assert.throws(
    () =>
      createDashboardIssue({
        dbPath,
        projectId: 'P-missing',
        task: 'Valid task body',
        priority: 'medium',
        size: 'L',
      }),
    /Unknown HarnessOS project/,
  );

  assert.throws(
    () =>
      createDashboardIssue({
        dbPath,
        projectId: 'P-dashboard',
        task: 'abc',
        priority: 'medium',
        size: 'L',
      }),
    /task must be between 4 and 280 characters/,
  );
});

function seedDashboardDatabase(): string {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'harness-dashboard-')), 'harness.sqlite');
  const database = openHarnessDatabase({ dbPath });

  try {
    runStatement(
      database.connection,
      `INSERT INTO workspaces (id, name, kind, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        'W-dashboard',
        'Dashboard Workspace',
        'local',
        '2026-01-02T03:04:05.000Z',
        '2026-01-02T03:04:05.000Z',
      ],
    );
    runStatement(
      database.connection,
      `INSERT INTO projects (id, workspace_id, key, name, domain, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'P-dashboard',
        'W-dashboard',
        'dashboard',
        'Dashboard Operations',
        'orchestration',
        'active',
        '2026-01-02T03:04:05.000Z',
        '2026-01-02T03:04:05.000Z',
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
        'C-dashboard',
        'P-dashboard',
        'Operational Dashboard',
        'Make the orchestration dashboard actionable.',
        'active',
        '2026-01-02T03:04:05.000Z',
        '2026-01-02T03:04:05.000Z',
      ],
    );
  } finally {
    database.close();
  }

  return dbPath;
}
