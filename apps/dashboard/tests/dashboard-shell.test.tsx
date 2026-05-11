import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { orchestrationDashboardLaneOrder } from 'harness-os/orchestration';

import { DashboardSetup, DashboardShell } from '../components/dashboard-shell';
import { demoDashboardViewModel } from '../lib/demo-view-model';

test('dashboard shell renders the stable lane order and orchestration evidence summaries', () => {
  const html = renderToStaticMarkup(
    <DashboardShell dataSource="demo" viewModel={demoDashboardViewModel} />,
  );

  assert.match(html, /Linear-like command center/);
  assert.match(html, /data-testid="orchestration-dashboard"/);
  assert.match(html, /data-testid="issue-card-M7-I2"/);
  assert.match(html, /CSQR scorecards/);
  assert.match(html, /demo data/);
  assert.match(html, /Expired lease/);
  assert.match(html, /Duplicate worktree path/);
  assert.match(html, /Proof-of-work packet/);

  const laneIndexes = orchestrationDashboardLaneOrder.map((laneId) =>
    html.indexOf(`data-testid="lane-${laneId}"`),
  );

  assert.equal(laneIndexes.every((index) => index >= 0), true);
  assert.deepEqual(
    laneIndexes,
    [...laneIndexes].sort((left, right) => left - right),
  );
});

test('dashboard setup renders required live configuration instead of placeholder data', () => {
  const html = renderToStaticMarkup(
    <DashboardSetup
      state={{
        kind: 'not_configured',
        message: 'Set live environment variables.',
        requiredEnvironment: ['HARNESS_DASHBOARD_DB_PATH', 'HARNESS_DASHBOARD_PROJECT_ID'],
      }}
    />,
  );

  assert.match(html, /data-testid="dashboard-setup"/);
  assert.match(html, /Connect a live HarnessOS database/);
  assert.match(html, /HARNESS_DASHBOARD_DB_PATH/);
  assert.match(html, /HARNESS_DASHBOARD_DEMO=1/);
  assert.doesNotMatch(html, /data-testid="issue-card-M7-I2"/);
});

test('dashboard shell preserves empty lanes instead of dropping future board columns', () => {
  const emptyReadyViewModel = structuredClone(demoDashboardViewModel);
  const pendingLane = emptyReadyViewModel.issueLanes.find((lane) => lane.id === 'pending');

  assert.ok(pendingLane);
  assert.equal(pendingLane.count, 0);
  assert.equal(pendingLane.cards.length, 0);

  const html = renderToStaticMarkup(
    <DashboardShell viewModel={emptyReadyViewModel} />,
  );

  assert.match(html, /data-testid="lane-pending"/);
  assert.match(html, /No issues in this lane/);
});

test('dashboard shell renders a live create-ticket form and disables it for demo data', () => {
  const liveHtml = renderToStaticMarkup(
    <DashboardShell
      createIssueAction="/dashboard-create-ticket"
      dataSource="live"
      viewModel={demoDashboardViewModel}
    />,
  );

  assert.match(liveHtml, /data-testid="create-ticket-panel"/);
  assert.match(liveHtml, /name="task"/);
  assert.match(liveHtml, /name="priority"/);
  assert.match(liveHtml, /Create ready ticket/);
  assert.doesNotMatch(liveHtml, /Ticket creation is available only in live DB mode/);

  const demoHtml = renderToStaticMarkup(
    <DashboardShell dataSource="demo" viewModel={demoDashboardViewModel} />,
  );

  assert.match(demoHtml, /Ticket creation is available only in live DB mode/);
  assert.match(demoHtml, /disabled=""/);
});

test('dashboard stylesheet contains responsive overflow guardrails for dense live data', () => {
  const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');

  assert.match(css, /overflow-x:\s*hidden/);
  assert.match(css, /repeat\(auto-fit,\s*minmax\(min\(100%, 260px\), 1fr\)\)/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
});
