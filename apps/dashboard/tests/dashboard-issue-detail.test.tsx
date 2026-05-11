import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  openHarnessDatabase,
  runStatement,
} from 'harness-os/dashboard-server';

import {
  DashboardIssueNotFound,
  IssueDetailShell,
} from '../components/issue-detail-shell';
import { getDashboardIssueDetailPageState } from '../lib/dashboard-issue-detail';

test('issue detail loader renders status, agent notes, lease history, and evidence', () => {
  const dbPath = seedIssueDetailDatabase();
  const state = getDashboardIssueDetailPageState('I-detail-done', {
    HARNESS_DASHBOARD_DB_PATH: dbPath,
    HARNESS_DASHBOARD_PROJECT_ID: 'P-detail',
    HARNESS_DASHBOARD_CAMPAIGN_ID: 'C-detail',
  });

  assert.equal(state.kind, 'ready');
  assert.equal(state.kind === 'ready' ? state.detail.card.status : null, 'done');
  assert.equal(state.kind === 'ready' ? state.detail.artifacts.length : null, 2);
  assert.equal(state.kind === 'ready' ? state.detail.checkpoints.length : null, 1);
  assert.equal(state.kind === 'ready' ? state.detail.leases.length : null, 1);

  const html = renderToStaticMarkup(
    state.kind === 'ready' ? (
      <IssueDetailShell
        claimIssueAction="/claim-issue"
        dataSource="live"
        detail={state.detail}
      />
    ) : (
      <div />
    ),
  );

  assert.match(html, /data-testid="issue-detail-dashboard"/);
  assert.match(html, /Final implementation summary/);
  assert.match(html, /What the agent wrote/);
  assert.match(html, /Implemented detail view and attached evidence/);
  assert.match(html, /agent-detail-1/);
  assert.match(html, /e2e_report/);
  assert.match(html, /state_export/);
  assert.match(html, /global-checkpoint-artifact/);
  assert.match(html, /Issue cannot be claimed from status done/);
});

test('issue detail shell enables claim for live ready issues and disables demo claims', () => {
  const dbPath = seedIssueDetailDatabase();
  const state = getDashboardIssueDetailPageState('I-detail-ready', {
    HARNESS_DASHBOARD_DB_PATH: dbPath,
    HARNESS_DASHBOARD_PROJECT_ID: 'P-detail',
    HARNESS_DASHBOARD_CAMPAIGN_ID: 'C-detail',
  });

  assert.equal(state.kind, 'ready');

  const liveHtml = renderToStaticMarkup(
    state.kind === 'ready' ? (
      <IssueDetailShell
        claimIssueAction="/claim-issue"
        dataSource="live"
        detail={state.detail}
      />
    ) : (
      <div />
    ),
  );
  const demoHtml = renderToStaticMarkup(
    state.kind === 'ready' ? (
      <IssueDetailShell dataSource="demo" detail={state.detail} />
    ) : (
      <div />
    ),
  );

  assert.match(liveHtml, /data-testid="claim-issue-form"/);
  assert.match(liveHtml, /name="issueId"/);
  assert.doesNotMatch(liveHtml, /disabled=""/);
  assert.match(demoHtml, /Claim is available only in live DB mode/);
  assert.match(demoHtml, /disabled=""/);
});

test('issue detail shell does not expose broken claim actions for pending issues', () => {
  const dbPath = seedIssueDetailDatabase();
  const state = getDashboardIssueDetailPageState('I-detail-pending', {
    HARNESS_DASHBOARD_DB_PATH: dbPath,
    HARNESS_DASHBOARD_PROJECT_ID: 'P-detail',
    HARNESS_DASHBOARD_CAMPAIGN_ID: 'C-detail',
  });

  assert.equal(state.kind, 'ready');

  const html = renderToStaticMarkup(
    state.kind === 'ready' ? (
      <IssueDetailShell
        claimIssueAction="/claim-issue"
        dataSource="live"
        detail={state.detail}
      />
    ) : (
      <div />
    ),
  );

  assert.match(html, /Issue cannot be claimed from status pending/);
  assert.match(html, /disabled=""/);
});

test('issue detail not-found and stylesheet guardrails are deterministic', () => {
  const notFoundHtml = renderToStaticMarkup(
    <DashboardIssueNotFound
      issueId="I-missing"
      message="Issue &quot;I-missing&quot; was not found."
    />,
  );
  const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');

  assert.match(notFoundHtml, /data-testid="issue-detail-not-found"/);
  assert.match(notFoundHtml, /Issue not found/);
  assert.match(css, /\.issue-card-link:focus-visible/);
  assert.match(css, /\.detail-grid/);
  assert.match(css, /\.claim-panel/);
});

function seedIssueDetailDatabase(): string {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'harness-dashboard-detail-')), 'harness.sqlite');
  const database = openHarnessDatabase({ dbPath });
  const now = '2026-01-02T03:04:05.000Z';

  try {
    runStatement(
      database.connection,
      `INSERT INTO workspaces (id, name, kind, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      ['W-detail', 'Detail Workspace', 'local', now, now],
    );
    runStatement(
      database.connection,
      `INSERT INTO projects (id, workspace_id, key, name, domain, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'P-detail',
        'W-detail',
        'detail',
        'Detail Project',
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
        'C-detail',
        'P-detail',
        'Detail Campaign',
        'Expose issue detail evidence.',
        'active',
        now,
        now,
      ],
    );
    insertIssue(database.connection, {
      id: 'I-detail-done',
      status: 'done',
      task: 'Final implementation summary',
      nextBestAction: 'Review attached evidence.',
      now,
    });
    insertIssue(database.connection, {
      id: 'I-detail-ready',
      status: 'ready',
      task: 'Ready issue for dashboard claim',
      nextBestAction: 'Claim and start work.',
      now,
    });
    insertIssue(database.connection, {
      id: 'I-detail-pending',
      status: 'pending',
      task: 'Pending issue awaiting queue promotion',
      nextBestAction: 'Promote queue before claiming.',
      now,
    });
    runStatement(
      database.connection,
      `INSERT INTO runs (
         id,
         workspace_id,
         project_id,
         campaign_id,
         session_type,
         host,
         status,
         started_at,
         finished_at,
         notes
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'RUN-detail',
        'W-detail',
        'P-detail',
        'C-detail',
        'incremental',
        'copilot',
        'done',
        now,
        now,
        '{}',
      ],
    );
    runStatement(
      database.connection,
      `INSERT INTO leases (
         id,
         workspace_id,
         project_id,
         campaign_id,
         issue_id,
         agent_id,
         status,
         acquired_at,
         expires_at,
         last_heartbeat_at,
         released_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'L-detail',
        'W-detail',
        'P-detail',
        'C-detail',
        'I-detail-done',
        'agent-detail-1',
        'released',
        now,
        '2026-01-02T03:34:05.000Z',
        now,
        now,
      ],
    );
    runStatement(
      database.connection,
      `INSERT INTO artifacts (
         id,
         workspace_id,
         project_id,
         campaign_id,
         issue_id,
         kind,
         path,
         metadata_json,
         created_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'A-detail-e2e',
        'W-detail',
        'P-detail',
        'C-detail',
        'I-detail-done',
        'e2e_report',
        '/tmp/detail-e2e.json',
        '{"evidencePacketId":"packet-detail","worktreePath":"/tmp/detail-worktree"}',
        now,
      ],
    );
    runStatement(
      database.connection,
      `INSERT INTO artifacts (
         id,
         workspace_id,
         project_id,
         campaign_id,
         issue_id,
         kind,
         path,
         metadata_json,
         created_at
       )
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      [
        'A-detail-global',
        'W-detail',
        'P-detail',
        'C-detail',
        'state_export',
        '/tmp/detail-state.json',
        '{"label":"global-checkpoint-artifact"}',
        now,
      ],
    );
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
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'CP-detail',
        'RUN-detail',
        'I-detail-done',
        'completion',
        'Implemented detail view and attached evidence.',
        'done',
        'Ship after completion gate.',
        '["A-detail-e2e","A-detail-global"]',
        now,
      ],
    );
    runStatement(
      database.connection,
      `INSERT INTO events (id, run_id, issue_id, kind, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        'E-detail',
        'RUN-detail',
        'I-detail-done',
        'issue_completed',
        '{"summary":"Detail work completed"}',
        now,
      ],
    );
  } finally {
    database.close();
  }

  return dbPath;
}

function insertIssue(
  connection: Parameters<typeof runStatement>[0],
  input: { id: string; status: string; task: string; nextBestAction: string; now: string },
): void {
  runStatement(
    connection,
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
      input.id,
      'P-detail',
      'C-detail',
      input.task,
      'high',
      input.status,
      'M',
      input.nextBestAction,
      input.now,
    ],
  );
}
