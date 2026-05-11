import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { orchestrationDashboardLaneOrder } from 'harness-os/orchestration';

import { DashboardShell } from '../components/dashboard-shell';
import { demoDashboardViewModel } from '../lib/demo-view-model';

test('dashboard shell renders the stable lane order and orchestration evidence summaries', () => {
  const html = renderToStaticMarkup(
    <DashboardShell viewModel={demoDashboardViewModel} />,
  );

  assert.match(html, /Linear-like command center/);
  assert.match(html, /data-testid="orchestration-dashboard"/);
  assert.match(html, /data-testid="issue-card-M7-I2"/);
  assert.match(html, /CSQR scorecards/);
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
