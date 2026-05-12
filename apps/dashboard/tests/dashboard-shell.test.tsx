import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  applyOrchestrationDashboardIssueFilters as applyDashboardIssueFilters,
  orchestrationDashboardLaneOrder,
  parseOrchestrationDashboardIssueFilters as parseDashboardIssueFilters,
  type OrchestrationDashboardViewModel,
} from 'harness-os/orchestration';

import { DashboardSetup, DashboardShell } from '../components/dashboard-shell';
import { MetricTile, Panel, Pill, SectionHeader } from '../components/ui';
import { demoDashboardViewModel } from '../lib/demo-view-model';

test('dashboard shell renders the stable lane order and orchestration evidence summaries', () => {
  const html = renderToStaticMarkup(
    <DashboardShell dataSource="demo" viewModel={demoDashboardViewModel} />,
  );

  assert.match(html, /Linear-like command center/);
  assert.match(html, /data-testid="orchestration-dashboard"/);
  assert.match(html, /data-testid="issue-card-M7-I2"/);
  assert.match(html, /href="\/issues\/M7-I2"/);
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

test('dashboard shell renders Linear-style sidebar, topbar, command search, and saved views', () => {
  const filtered = applyDashboardIssueFilters(demoDashboardViewModel, {
    ...emptyFilters(),
    q: 'threshold',
  });
  const html = renderToStaticMarkup(
    <DashboardShell
      dataSource="demo"
      filters={{ ...emptyFilters(), q: 'threshold' }}
      savedViewModel={demoDashboardViewModel}
      unfilteredIssueCount={demoDashboardViewModel.overview.totalIssues}
      viewModel={filtered}
    />,
  );

  assert.match(html, /data-testid="dashboard-sidebar"/);
  assert.match(html, /aria-label="Workspace navigation"/);
  assert.match(html, /data-testid="dashboard-topbar"/);
  assert.match(html, /aria-label="Command search"/);
  assert.match(html, /class="command-search"/);
  assert.match(html, /placeholder="Search issues, blockers, agents, proof..."/);
  assert.match(html, /value="threshold"/);
  assert.match(html, /data-testid="saved-view-all"/);
  assert.match(html, /data-testid="saved-view-ready"/);
  assert.match(html, /data-testid="saved-view-active"/);
  assert.match(html, /data-testid="saved-view-blocked"/);
  assert.match(html, /data-testid="saved-view-proof"/);
  assert.match(html, /href="\/\?status=ready"/);
  assert.match(html, /href="\/\?signal=active"/);
  assert.match(html, /href="\/\?signal=evidence"/);
  assert.match(html, /All work/);
  assert.match(html, /Ready to claim/);
  assert.match(html, /Proof artifacts/);
  assertSavedViewCount(html, 'all', demoDashboardViewModel.overview.totalIssues);
  assertSavedViewCount(
    html,
    'active',
    cardIds(applyDashboardIssueFilters(demoDashboardViewModel, { ...emptyFilters(), signal: 'active' })).length,
  );
  assertSavedViewCount(
    html,
    'proof',
    cardIds(applyDashboardIssueFilters(demoDashboardViewModel, { ...emptyFilters(), signal: 'evidence' })).length,
  );
});

test('dashboard board renders dense lanes, proof badges, and keyboard-scroll affordance', () => {
  const html = renderToStaticMarkup(
    <DashboardShell dataSource="demo" viewModel={demoDashboardViewModel} />,
  );

  assert.match(html, /class="board" role="region" tabindex="0"/);
  assert.match(html, /aria-label="Issue lane board"/);
  assert.match(html, /class="lane lane-ready" data-testid="lane-ready"/);
  assert.match(html, /aria-label="2 issues in Ready"/);
  assert.match(html, /class="issue-card-topline"/);
  assert.match(html, /class="issue-meta issue-meta-grid"/);
  assert.match(html, /aria-label="Proof summary for M7-I2"/);
  assert.match(html, /class="proof-badge proof-badge-positive"/);
  assert.match(html, /class="proof-badge proof-badge-success"/);
  assert.match(html, /class="proof-badge proof-badge-info"/);
  assert.match(html, /<span class="proof-count">[^<]+<\/span>artifacts/);
  assert.match(html, /<span class="proof-count">[^<]+<\/span>CSQR/);
  assert.match(html, /<span class="proof-count">[^<]+<\/span>worktrees/);
  assert.match(html, /class="small-pill truncate-pill" title="\/worktrees\/M7-I2-dashboard">M7-I2-dashboard<\/span>/);
  assert.match(html, /class="issue-health health-high"/);
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

test('dashboard issue filters match text, status, and priority deterministically', () => {
  assert.deepEqual(
    cardIds(applyDashboardIssueFilters(demoDashboardViewModel, { ...emptyFilters(), q: 'threshold' })),
    ['M6-I3'],
  );

  assert.deepEqual(
    cardIds(applyDashboardIssueFilters(demoDashboardViewModel, { ...emptyFilters(), status: ['ready'] })),
    ['M7-I2-A', 'M7-I2-B'],
  );

  assert.deepEqual(
    cardIds(applyDashboardIssueFilters(demoDashboardViewModel, { ...emptyFilters(), priority: ['critical'] })),
    ['M7-I2-A', 'M7-I2'],
  );
});

test('dashboard issue filters match evidence kind and CSQR scorecard ids', () => {
  assert.deepEqual(
    cardIds(applyDashboardIssueFilters(demoDashboardViewModel, { ...emptyFilters(), evidenceKind: ['screenshot'] })),
    ['M7-I2-B'],
  );

  assert.deepEqual(
    cardIds(applyDashboardIssueFilters(demoDashboardViewModel, { ...emptyFilters(), evidenceKind: ['test_report'] })),
    ['M7-I2'],
  );

  assert.deepEqual(
    cardIds(applyDashboardIssueFilters(demoDashboardViewModel, { ...emptyFilters(), csqr: ['scorecard-m6-i3'] })),
    ['M6-I3'],
  );

  assert.deepEqual(
    cardIds(applyDashboardIssueFilters(demoDashboardViewModel, { ...emptyFilters(), hasCsqr: true })),
    ['M6-I3'],
  );
});

test('dashboard issue filters match operational signal shortcuts', () => {
  const activeFiltered = applyDashboardIssueFilters(demoDashboardViewModel, {
    ...emptyFilters(),
    signal: 'active',
  });
  const healthFiltered = applyDashboardIssueFilters(demoDashboardViewModel, {
    ...emptyFilters(),
    signal: 'health',
  });

  assert.deepEqual(
    cardIds(activeFiltered),
    ['M7-I2', 'M7-I2-D'],
  );
  assert.equal(activeFiltered.overview.activeIssueCount, 1);
  assert.equal(activeFiltered.overview.laneCounts.in_progress, 1);

  assert.deepEqual(
    cardIds(applyDashboardIssueFilters(demoDashboardViewModel, { ...emptyFilters(), signal: 'evidence' })),
    ['M7-I2-B', 'M7-I2', 'M7-I2-D', 'M6-I3'],
  );

  assert.deepEqual(
    cardIds(healthFiltered),
    ['M7-I2-B', 'M7-I2-D', 'M6-I3'],
  );
  assert.equal(healthFiltered.overview.activeIssueCount, 0);
  assert.equal(healthFiltered.overview.laneCounts.in_progress, 0);

  assert.deepEqual(
    cardIds(applyDashboardIssueFilters(demoDashboardViewModel, { ...emptyFilters(), signal: 'blocked' })),
    ['M7-I2-C', 'M7-I2-D'],
  );
});

test('dashboard shell renders filter form and reset link with current values', () => {
  const filtered = applyDashboardIssueFilters(demoDashboardViewModel, {
    ...emptyFilters(),
    q: 'dashboard',
    priority: ['high'],
    status: ['ready'],
    evidenceKind: ['screenshot'],
    signal: 'evidence',
  });

  const html = renderToStaticMarkup(
    <DashboardShell
      filters={{
        ...emptyFilters(),
        q: 'dashboard',
        priority: ['high'],
        status: ['ready'],
        evidenceKind: ['screenshot'],
        signal: 'evidence',
      }}
      unfilteredIssueCount={demoDashboardViewModel.overview.totalIssues}
      viewModel={filtered}
    />,
  );

  assert.match(html, /Find issues and proof artifacts/);
  assert.match(html, /name="q"/);
  assert.match(html, /value="dashboard"/);
  assert.match(html, /<option value="high" selected="">High<\/option>/);
  assert.match(html, /<option value="ready" selected="">Ready<\/option>/);
  assert.match(html, /name="evidenceKind"/);
  assert.match(html, /value="screenshot"/);
  assert.match(html, /<option value="evidence" selected="">Has evidence<\/option>/);
  assert.match(html, /href="\/"/);
  assert.match(html, /Reset filters/);
});


test('dashboard issue filters preserve lane order and empty lanes after filtering', () => {
  const filtered = applyDashboardIssueFilters(demoDashboardViewModel, {
    ...emptyFilters(),
    evidenceKind: ['screenshot'],
  });

  assert.deepEqual(
    filtered.issueLanes.map((lane) => lane.id),
    orchestrationDashboardLaneOrder,
  );
  assert.equal(filtered.overview.totalIssues, 1);
  assert.equal(filtered.overview.readyCount, 1);
  assert.equal(filtered.overview.evidenceArtifactCount, 3);
  assert.equal(filtered.issueLanes.find((lane) => lane.id === 'ready')?.count, 1);

  const html = renderToStaticMarkup(
    <DashboardShell
      filters={{ ...emptyFilters(), evidenceKind: ['screenshot'] }}
      unfilteredIssueCount={demoDashboardViewModel.overview.totalIssues}
      viewModel={filtered}
    />,
  );

  for (const laneId of orchestrationDashboardLaneOrder) {
    assert.match(html, new RegExp(`data-testid="lane-${laneId}"`));
  }

  assertRenderedCards(html, ['M7-I2-B'], ['M7-I2', 'M6-I3', 'M7-I2-A']);
  assert.equal([...html.matchAll(/No matching issues in this lane/g)].length, 7);
  assert.match(html, /Showing 1 of 7 issues/);
});

test('dashboard issue filters parse URL search params deterministically', () => {
  assert.deepEqual(
    parseDashboardIssueFilters({
      q: '  threshold  ',
      status: ['ready', 'done'],
      priority: 'critical',
      evidenceKind: ['screenshot', 'csqr_lite_scorecard'],
      csqr: 'scorecard-m6-i3',
    }),
    {
      q: 'threshold',
      lane: [],
      status: ['ready', 'done'],
      priority: ['critical'],
      evidenceKind: ['screenshot', 'csqr_lite_scorecard'],
      csqr: ['scorecard-m6-i3'],
      hasCsqr: false,
    },
  );

  assert.deepEqual(
    parseDashboardIssueFilters({
      q: '   ',
      lane: 'ready',
      status: '',
      priority: undefined,
      evidenceKind: [],
      csqr: 'any',
      signal: 'csqr',
    }),
    {
      lane: ['ready'],
      status: [],
      priority: [],
      evidenceKind: [],
      csqr: [],
      signal: 'csqr',
      hasCsqr: true,
    },
  );
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

test('dashboard UI primitives render server-side foundation classes', () => {
  const html = renderToStaticMarkup(
    <Panel aria-labelledby="foundation-title">
      <SectionHeader
        actions={<Pill tone="accent">Command ready</Pill>}
        copy="Design primitives stay server-renderable and additive."
        eyebrow="Foundation"
        title="Linear-like primitives"
        titleId="foundation-title"
      />
      <MetricTile
        caption="Stable data-testid contract."
        id="foundation"
        label="Foundation score"
        value={10}
      />
    </Panel>,
  );
  const primitiveSource = readFileSync(
    new URL('../components/ui.tsx', import.meta.url),
    'utf8',
  );

  assert.match(html, /class="panel ui-panel"/);
  assert.match(html, /class="panel-header ui-section-header"/);
  assert.match(html, /class="small-pill ui-pill tone-accent"/);
  assert.match(html, /data-testid="metric-foundation"/);
  assert.doesNotMatch(primitiveSource, /'use client'|"use client"|useState|useEffect|window\./);
});

test('dashboard stylesheet contains responsive overflow guardrails for dense live data', () => {
  const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');

  assert.match(css, /overflow-x:\s*hidden/);
  assert.match(css, /\.board\s*\{[\s\S]*grid-auto-flow:\s*column/);
  assert.match(css, /\.board\s*\{[\s\S]*overflow-x:\s*auto/);
  assert.match(css, /\.board\s*\{[\s\S]*overflow-y:\s*visible/);
  assert.match(css, /\.board:focus-visible\s*\{[\s\S]*box-shadow:\s*var\(--ds-focus-ring\)/);
  assert.match(css, /\.lane-header\s*\{[\s\S]*position:\s*sticky/);
  assert.match(css, /\.proof-strip\s*\{[\s\S]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.proof-badge/);
  assert.match(css, /\.issue-meta-grid/);
  assert.match(css, /\.truncate-pill/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
  assert.match(css, /\.filter-grid/);
  assert.match(css, /\.empty-board/);
  assert.match(css, /--ds-color-bg-canvas/);
  assert.match(css, /--ds-space-4/);
  assert.match(css, /--ds-focus-ring/);
  assert.match(css, /\.ui-panel/);
  assert.match(css, /\.dashboard-workspace\s*\{[\s\S]*grid-template-columns:\s*minmax\(220px, 248px\) minmax\(0, 1fr\)/);
  assert.match(css, /\.workspace-sidebar\s*\{[\s\S]*position:\s*sticky/);
  assert.match(css, /\.workspace-topbar\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(min\(100%, 420px\), 480px\)/);
  assert.match(css, /\.command-search:focus-within\s*\{[\s\S]*box-shadow:\s*var\(--ds-focus-ring\)/);
  assert.match(css, /@media \(max-width: 1280px\)\s*\{[\s\S]*\.dashboard-workspace/);
  assert.match(css, /@media \(max-width: 760px\)\s*\{[\s\S]*\.workspace-nav\s*\{[\s\S]*overflow-x:\s*auto/);
  assert.match(css, /\.issue-card-link:focus-visible\s*\{[\s\S]*outline:\s*2px solid var\(--accent-strong\)/);
  assert.doesNotMatch(css, /outline:\s*none/);
});

function emptyFilters() {
  return {
    lane: [],
    status: [],
    priority: [],
    evidenceKind: [],
    csqr: [],
    hasCsqr: false,
  };
}

function cardIds(viewModel: OrchestrationDashboardViewModel): string[] {
  return viewModel.issueLanes.flatMap((lane) => lane.cards.map((card) => card.id));
}

function assertRenderedCards(
  html: string,
  present: string[],
  absent: string[],
): void {
  for (const id of present) {
    assert.match(html, new RegExp(`data-testid="issue-card-${id}"`));
  }

  for (const id of absent) {
    assert.doesNotMatch(html, new RegExp(`data-testid="issue-card-${id}"`));
  }
}

function assertSavedViewCount(html: string, savedViewId: string, count: number): void {
  assert.match(
    html,
    new RegExp(`data-testid="saved-view-${savedViewId}"[^>]*>[\\s\\S]*?<span class="nav-count">${count}</span>`),
  );
}
