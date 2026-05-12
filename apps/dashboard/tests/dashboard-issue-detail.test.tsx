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
  assert.equal(state.kind === 'ready' ? state.detail.artifacts.length : null, 5);
  assert.equal(state.kind === 'ready' ? state.detail.checkpoints.length : null, 2);
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
  assert.match(html, /class="detail-layout"/);
  assert.match(html, /class="detail-primary"/);
  assert.match(html, /class="detail-inspector" aria-label="Issue proof inspector"/);
  assert.match(html, /class="status-pill done"/);
  assert.match(html, /Final implementation summary/);
  assert.match(html, /What the agent wrote/);
  assert.match(html, /Implemented detail view and attached evidence/);
  assert.match(html, /agent-detail-1/);
  assert.match(html, /e2e_report/);
  assert.match(html, /state_export/);
  assert.match(html, /global-checkpoint-artifact/);
  assert.match(html, /Evidence drilldown/);
  assert.match(html, /CSQR-lite scorecards/);
  assert.match(html, /scorecard-detail/);
  assert.match(html, /Passed/);
  assert.match(html, /data-testid="issue-proof-review-panel"/);
  assert.match(html, /data-testid="automated-proof-note"/);
  assert.match(html, /Automated proof only - no human review is required for completion/);
  assert.match(html, /aria-label="Proof review summary"/);
  assert.match(html, /Metadata warnings/);
  assert.match(html, /Latest checkpoint:/);
  assert.match(html, /role="meter"/);
  assert.match(html, /aria-valuenow="9.5"/);
  assert.match(html, /class="score-meter-fill" style="width:95%"/);
  assert.match(html, /Weighted average/);
  assert.match(html, /9\.5/);
  assert.match(html, /8\.5/);
  assert.match(html, /A-detail-null-metadata/);
  assert.match(html, />null</);
  assert.match(html, /A-detail-incomplete-scorecard/);
  assert.match(html, /CSQR-lite artifact metadata is missing scorecardJson/);
  assert.match(html, /Checkpoint provenance/);
  assert.match(html, /class="provenance-timeline"/);
  assert.match(html, /Raw metadata - collapsed by default for safe inspection/);
  assert.match(html, /Inspect raw JSON only when provenance or parser diagnostics require it/);
  assert.match(html, /CP-detail-newer/);
  assert.match(html, /Raw event payload/);
  assert.match(html, /class="proof-detail-summary timeline-event-payload"/);
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
  assert.deepEqual(state.kind === 'ready' ? state.detail.artifacts : null, []);
  assert.deepEqual(state.kind === 'ready' ? state.detail.checkpoints : null, []);

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
  assert.match(liveHtml, /No checkpoint notes have been written for this issue yet/);
  assert.match(liveHtml, /No evidence artifacts are attached to this issue yet/);
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
  const detailInspectorRule = readCssRule(css, '.detail-inspector');
  const responsiveDetailInspectorRule = readCssRule(
    css,
    '.detail-inspector',
    '@media (max-width: 1280px)',
  );
  const claimPanelRule = readCssRule(css, '.claim-panel');
  const detailIssueActionRule = readCssRule(css, '.detail-layout .issue-action,\n.detail-layout .issue-blocker');

  assert.match(notFoundHtml, /data-testid="issue-detail-not-found"/);
  assert.match(notFoundHtml, /Issue not found/);
  assert.match(css, /\.issue-card-link:focus-visible/);
  assert.match(css, /\.detail-grid/);
  assert.match(css, /\.detail-layout/);
  assert.doesNotMatch(detailInspectorRule, /max-height|overflow-y/);
  assert.doesNotMatch(responsiveDetailInspectorRule, /order\s*:\s*-1/);
  assert.match(claimPanelRule, /position:\s*sticky/);
  assert.match(detailIssueActionRule, /-webkit-line-clamp:\s*initial/);
  assert.match(css, /\.proof-review-panel/);
  assert.match(css, /\.automated-proof-note/);
  assert.match(css, /\.score-meter/);
  assert.match(css, /\.provenance-timeline/);
  assert.match(css, /\.metadata-safety-copy/);
  assert.match(css, /\.timeline-event-payload/);
  assert.match(css, /@media \(max-width: 1280px\)\s*\{[\s\S]*\.detail-layout/);
  assert.match(css, /\.claim-panel/);
  assert.match(css, /\.proof-card-grid/);
  assert.match(css, /\.scorecard-outcome\.passed/);
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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'A-detail-scorecard',
        'W-detail',
        'P-detail',
        'C-detail',
        'I-detail-done',
        'csqr_lite_scorecard',
        '/tmp/detail-scorecard.json',
        buildScorecardMetadata(),
        '2026-01-02T03:04:08.000Z',
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
        'A-detail-incomplete-scorecard',
        'W-detail',
        'P-detail',
        'C-detail',
        'I-detail-done',
        'csqr_lite_scorecard',
        '/tmp/detail-incomplete-scorecard.json',
        '{}',
        '2026-01-02T03:04:07.000Z',
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
        'A-detail-null-metadata',
        'W-detail',
        'P-detail',
        'C-detail',
        'I-detail-done',
        'evidence_packet',
        '/tmp/detail-null.json',
        'null',
        '2026-01-02T03:04:06.000Z',
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
        'CP-detail-newer',
        'RUN-detail',
        'I-detail-done',
        'proof-review',
        'Verified CSQR-lite scorecard and checkpoint evidence.',
        'done',
        'Inspect proof drilldown.',
        '["A-detail-global","A-detail-scorecard","A-detail-global","A-detail-missing",17]',
        '2026-01-02T03:04:09.000Z',
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

function buildScorecardMetadata(): string {
  const scorecard = {
    contractVersion: '1.0.0',
    id: 'scorecard-detail',
    scope: 'run',
    runId: 'RUN-detail',
    summary: 'Automated proof checks passed for the dashboard detail flow.',
    criteria: [
      {
        id: 'correctness-detail',
        dimension: 'correctness',
        name: 'Correctness gate',
        description: 'The implementation satisfies the issue behavior.',
        weight: 1,
      },
      {
        id: 'security-detail',
        dimension: 'security',
        name: 'Security gate',
        description: 'Inputs are validated and database access remains scoped.',
        weight: 1,
      },
      {
        id: 'quality-detail',
        dimension: 'quality',
        name: 'Quality gate',
        description: 'The implementation remains maintainable and typed.',
        weight: 1,
      },
      {
        id: 'runtime-detail',
        dimension: 'runtime_evidence',
        name: 'Runtime evidence gate',
        description: 'E2E evidence and screenshots validate the flow.',
        weight: 1,
      },
    ],
    scores: [
      {
        criterionId: 'correctness-detail',
        score: 10,
        notes: 'Detail page renders evidence and agent state.',
        evidenceArtifactIds: ['A-detail-e2e'],
      },
      {
        criterionId: 'security-detail',
        score: 9,
        notes: 'Queries remain project and campaign scoped.',
        evidenceArtifactIds: ['A-detail-global'],
      },
      {
        criterionId: 'quality-detail',
        score: 9,
        notes: 'Proof drilldown is deterministic and typed.',
        evidenceArtifactIds: ['A-detail-scorecard'],
      },
      {
        criterionId: 'runtime-detail',
        score: 10,
        notes: 'Checkpoint provenance links evidence to the run.',
        evidenceArtifactIds: ['A-detail-e2e', 'A-detail-global'],
      },
    ],
    weightedAverage: 9.5,
    targetScore: 8.5,
    createdAt: '2026-01-02T03:04:08.000Z',
    metadata: {
      gate: 'completion',
    },
  };

  return JSON.stringify({
    csqrLiteScorecardId: 'scorecard-detail',
    scorecardJson: JSON.stringify(scorecard),
  });
}

function readCssRule(css: string, selector: string, within?: string): string {
  const source = within === undefined
    ? css
    : css.slice(css.indexOf(within));
  const pattern = new RegExp(`${escapeRegex(selector)}\\s*\\{([^}]*)\\}`);
  const match = source.match(pattern);

  assert.ok(match, `Expected CSS rule for ${selector}`);
  return match[1] ?? '';
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
