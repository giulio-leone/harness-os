import React from 'react';
import type { UrlObject } from 'node:url';
import Link from 'next/link';

import type {
  OrchestrationDashboardActiveAgent,
  OrchestrationDashboardHealthFlag,
  OrchestrationDashboardIssueCard,
  OrchestrationDashboardIssueFilters,
  OrchestrationDashboardIssueLane,
  OrchestrationDashboardLaneId,
  OrchestrationDashboardViewModel,
} from 'harness-os/orchestration';
import {
  applyOrchestrationDashboardIssueFilters,
  emptyOrchestrationDashboardIssueFilters,
  hasOrchestrationDashboardIssueFilters,
} from 'harness-os/orchestration';
import type { DashboardPageState } from '../lib/dashboard-data';
import { MetricTile, Panel, Pill, SectionHeader } from './ui';

interface DashboardShellProps {
  viewModel: OrchestrationDashboardViewModel;
  dataSource?: 'live' | 'demo';
  createIssueAction?: React.ComponentProps<'form'>['action'];
  filters?: OrchestrationDashboardIssueFilters;
  savedViewModel?: OrchestrationDashboardViewModel;
  unfilteredIssueCount?: number;
}

const HEALTH_FLAG_LABELS: Record<OrchestrationDashboardHealthFlag['kind'], string> = {
  duplicate_active_worktree_artifact_path: 'Duplicate worktree path',
  done_issue_missing_evidence: 'Done issue missing evidence',
  expired_active_lease: 'Expired lease',
};

interface SavedView {
  id: string;
  label: string;
  href: UrlObject;
  count: number;
}

export function DashboardShell({
  createIssueAction,
  dataSource = 'live',
  filters = emptyOrchestrationDashboardIssueFilters,
  savedViewModel,
  unfilteredIssueCount,
  viewModel,
}: DashboardShellProps) {
  const filtersActive = hasOrchestrationDashboardIssueFilters(filters);
  const totalIssueCount = unfilteredIssueCount ?? viewModel.overview.totalIssues;
  const savedViewsSource = savedViewModel ?? viewModel;
  const savedViews = buildSavedViews(savedViewsSource);

  return (
    <main className="dashboard-root" data-testid="orchestration-dashboard">
      <div className="dashboard-frame board-focus-frame">
        <BoardFocusHeader
          dataSource={dataSource}
          filters={filters}
          savedViews={savedViews}
          totalIssueCount={totalIssueCount}
          viewModel={viewModel}
        />
        <section className="board-focus-layout" aria-labelledby="dashboard-title">
          <div className="board-region board-region-primary">
            <IssueFilterPanel
              filters={filters}
              totalIssueCount={totalIssueCount}
              visibleIssueCount={viewModel.overview.totalIssues}
            />
            <LaneBoard
              filtersActive={filtersActive}
              lanes={viewModel.issueLanes}
              visibleIssueCount={viewModel.overview.totalIssues}
            />
          </div>
          <details className="board-support-details">
            <summary>
              <span>Operational context</span>
              <span className="summary-hint">Health, agents, evidence, timeline, and ticket creation</span>
            </summary>
            <div className="dashboard-inspector board-support-grid" aria-label="Evidence and health summaries">
              <OverviewPanel dataSource={dataSource} viewModel={viewModel} />
              <CreateTicketPanel action={createIssueAction} dataSource={dataSource} />
              <HealthPanel viewModel={viewModel} />
              <ActiveAgentsPanel agents={viewModel.activeAgents} />
              <EvidencePanel viewModel={viewModel} />
              <TimelinePanel viewModel={viewModel} />
            </div>
          </details>
        </section>
      </div>
    </main>
  );
}

function BoardFocusHeader({
  dataSource,
  filters,
  savedViews,
  totalIssueCount,
  viewModel,
}: {
  dataSource: 'live' | 'demo';
  filters: OrchestrationDashboardIssueFilters;
  savedViews: SavedView[];
  totalIssueCount: number;
  viewModel: OrchestrationDashboardViewModel;
}) {
  return (
    <header className="board-focus-header" data-testid="dashboard-topbar">
      <div className="board-focus-title-row">
        <div className="workspace-brand">
          <span className="workspace-logo" aria-hidden="true">
            H
          </span>
          <div>
            <p className="eyebrow">HarnessOS Symphony</p>
            <p className="workspace-name">Agentic board</p>
          </div>
        </div>
        <div>
          <h1 className="workspace-title" id="dashboard-title">
            Kanban.
          </h1>
          <p className="workspace-subtitle">
            Minimal execution board for autonomous work, blockers, and proof signals.
          </p>
        </div>
      </div>
      <div className="board-focus-tools">
        <form action="/" aria-label="Command search" className="command-search" method="get" role="search">
          <span className="command-icon" aria-hidden="true">
            CMD K
          </span>
          <input
            defaultValue={filters.q ?? ''}
            name="q"
            placeholder="Search issues, blockers, agents, proof..."
            type="search"
          />
          <button className="secondary-button compact-button" type="submit">
            Search
          </button>
        </form>
        <div className="topbar-pills" aria-label="Dashboard state">
          <Pill>{viewModel.overview.totalIssues} visible</Pill>
          <Pill>{totalIssueCount} total</Pill>
          <Pill className={`status-pill ${viewModel.health.status}`}>
            {dataSource} / {viewModel.health.status}
          </Pill>
        </div>
      </div>
      <nav className="saved-view-tabs" data-testid="dashboard-view-tabs" aria-label="Saved dashboard views">
        {savedViews.map((view) => (
          <Link className="nav-item saved-view-tab" data-testid={`saved-view-${view.id}`} href={view.href} key={view.id}>
            <span>{view.label}</span>
            <span className="nav-count">{view.count}</span>
          </Link>
        ))}
      </nav>
      <div className="workspace-scope board-scope-grid" aria-label="Dashboard scope">
        <ScopePill label="Project" value={viewModel.scope.projectId} />
        <ScopePill label="Campaign" value={viewModel.scope.campaignId ?? 'All campaigns'} />
        <ScopePill label="Issue" value={viewModel.scope.issueId ?? 'All issues'} />
      </div>
    </header>
  );
}

function buildSavedViews(viewModel: OrchestrationDashboardViewModel): SavedView[] {
  return [
    {
      id: 'all',
      label: 'All',
      href: { pathname: '/' },
      count: viewModel.overview.totalIssues,
    },
    {
      id: 'ready',
      label: 'Ready',
      href: { pathname: '/', query: { status: 'ready' } },
      count: countSavedViewIssues(viewModel, { status: ['ready'] }),
    },
    {
      id: 'active',
      label: 'Active',
      href: { pathname: '/', query: { signal: 'active' } },
      count: countSavedViewIssues(viewModel, { signal: 'active' }),
    },
    {
      id: 'blocked',
      label: 'Blocked',
      href: { pathname: '/', query: { signal: 'blocked' } },
      count: countSavedViewIssues(viewModel, { signal: 'blocked' }),
    },
    {
      id: 'proof',
      label: 'Proof',
      href: { pathname: '/', query: { signal: 'evidence' } },
      count: countSavedViewIssues(viewModel, { signal: 'evidence' }),
    },
  ];
}

function countSavedViewIssues(
  viewModel: OrchestrationDashboardViewModel,
  filters: Partial<OrchestrationDashboardIssueFilters>,
): number {
  return applyOrchestrationDashboardIssueFilters(viewModel, {
    ...emptyOrchestrationDashboardIssueFilters,
    ...filters,
  }).overview.totalIssues;
}

function IssueFilterPanel({
  filters,
  totalIssueCount,
  visibleIssueCount,
}: {
  filters: OrchestrationDashboardIssueFilters;
  totalIssueCount: number;
  visibleIssueCount: number;
}) {
  return (
    <section className="filter-panel board-toolbar" aria-labelledby="filters-title">
      <div className="board-toolbar-heading">
        <h2 className="toolbar-title" id="filters-title">
          Board controls
        </h2>
        <span aria-live="polite" className="results-summary" id="filter-summary">
          {visibleIssueCount} / {totalIssueCount} issues
        </span>
      </div>
      <form action="/" aria-describedby="filter-summary" className="filter-form" method="get">
        <div className="filter-grid primary-filter-grid">
          <label className="field">
            <span className="label">Search</span>
            <input
              defaultValue={filters.q ?? ''}
              name="q"
              placeholder="Issue id, task, blocker, artifact"
              type="search"
            />
          </label>
          <label className="field">
            <span className="label">Lane</span>
            <select defaultValue={filters.lane[0] ?? ''} name="lane">
              <option value="">All lanes</option>
              {LANE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="label">Priority</span>
            <select defaultValue={filters.priority[0] ?? ''} name="priority">
              <option value="">All priorities</option>
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </label>
          <label className="field">
            <span className="label">Focus</span>
            <select defaultValue={filters.signal ?? ''} name="signal">
              <option value="">Any signal</option>
              <option value="active">Active lease</option>
              <option value="evidence">Has evidence</option>
              <option value="csqr">Has CSQR</option>
              <option value="health">Has health flag</option>
              <option value="blocked">Has blocker</option>
            </select>
          </label>
        </div>
        <details className="advanced-filters">
          <summary>More filters</summary>
          <div className="filter-grid advanced-filter-grid">
            <label className="field">
              <span className="label">Status</span>
              <select defaultValue={filters.status[0] ?? ''} name="status">
                <option value="">All statuses</option>
                {STATUS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="label">Evidence kind</span>
              <input
                defaultValue={filters.evidenceKind[0] ?? ''}
                name="evidenceKind"
                placeholder="screenshot, test_report, csqr_lite_scorecard"
              />
            </label>
            <label className="field">
              <span className="label">CSQR scorecard</span>
              <input
                defaultValue={filters.hasCsqr ? 'any' : filters.csqr[0] ?? ''}
                name="csqr"
                placeholder="any or scorecard id"
              />
            </label>
          </div>
        </details>
        <div className="filter-actions">
          <button className="primary-button" type="submit">
            Apply
          </button>
          <Link className="secondary-button" href="/">
            Reset filters
          </Link>
        </div>
      </form>
    </section>
  );
}

function CreateTicketPanel({
  action,
  dataSource,
}: {
  action?: React.ComponentProps<'form'>['action'];
  dataSource: 'live' | 'demo';
}) {
  const disabled = dataSource !== 'live' || action === undefined;

  return (
    <Panel className="create-ticket-panel" data-testid="create-ticket-panel" aria-labelledby="create-ticket-title">
      <SectionHeader
        copy="Creates a real ready issue in the configured HarnessOS database."
        eyebrow="Create ticket"
        title="Add work to this campaign"
        titleId="create-ticket-title"
      />
      <form action={action} className="ticket-form">
        <label className="field">
          <span className="label">Task</span>
          <textarea
            disabled={disabled}
            maxLength={280}
            minLength={4}
            name="task"
            placeholder="Describe the next concrete task"
            required
            rows={4}
          />
        </label>
        <div className="field-row">
          <label className="field">
            <span className="label">Priority</span>
            <select defaultValue="high" disabled={disabled} name="priority" required>
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </label>
          <label className="field">
            <span className="label">Size</span>
            <select defaultValue="M" disabled={disabled} name="size" required>
              <option value="S">S</option>
              <option value="M">M</option>
              <option value="L">L</option>
              <option value="XL">XL</option>
            </select>
          </label>
        </div>
        <label className="field">
          <span className="label">Next best action</span>
          <input
            disabled={disabled}
            maxLength={360}
            name="nextBestAction"
            placeholder="Review scope and dispatch to the best available agent"
          />
        </label>
        <button className="primary-button" disabled={disabled} type="submit">
          Create ready ticket
        </button>
        {disabled ? (
          <p className="form-note">Ticket creation is available only in live DB mode.</p>
        ) : null}
      </form>
    </Panel>
  );
}

export function DashboardSetup({
  state,
}: {
  state: Extract<DashboardPageState, { kind: 'not_configured' }>;
}) {
  return (
    <main className="dashboard-root setup-root" data-testid="dashboard-setup">
      <section className="hero-panel setup-panel" aria-labelledby="setup-title">
        <p className="eyebrow">HarnessOS dashboard setup</p>
        <h1 className="hero-title" id="setup-title">
          Connect a live HarnessOS database.
        </h1>
        <p className="hero-copy">{state.message}</p>
        <div className="setup-code" aria-label="Required environment variables">
          {state.requiredEnvironment.map((name) => (
            <code key={name}>{name}</code>
          ))}
        </div>
        <p className="panel-copy">
          Sample data is intentionally opt-in only: set <code>HARNESS_DASHBOARD_DEMO=1</code>
          when you explicitly want the demo campaign.
        </p>
      </section>
    </main>
  );
}

function ScopePill({ label, value }: { label: string; value: string }) {
  return (
    <div className="scope-pill">
      <span className="label">{label}</span>
      <span className="value">{value}</span>
    </div>
  );
}

function OverviewPanel({ dataSource = 'live', viewModel }: DashboardShellProps) {
  const metrics = [
    {
      id: 'total-issues',
      label: 'Total issues',
      value: viewModel.overview.totalIssues,
      caption: 'Every card appears in exactly one lane.',
    },
    {
      id: 'ready',
      label: 'Ready',
      value: viewModel.overview.readyCount,
      caption: 'Eligible for agentic dispatch.',
    },
    {
      id: 'active',
      label: 'Active agents',
      value: viewModel.overview.activeLeaseCount,
      caption: `${viewModel.overview.activeIssueCount} issues currently leased.`,
    },
    {
      id: 'evidence',
      label: 'Evidence artifacts',
      value: viewModel.overview.evidenceArtifactCount,
      caption: 'Tests, screenshots, scorecards, and state exports.',
    },
  ];

  return (
    <Panel aria-labelledby="overview-title">
      <SectionHeader
        actions={
          <>
            <Pill className="status-pill">{dataSource} data</Pill>
            <Pill className={`status-pill ${viewModel.health.status}`}>
              {viewModel.health.status}
            </Pill>
          </>
        }
        eyebrow="Live overview"
        title="Campaign pulse"
        titleId="overview-title"
      />
      <div className="metric-grid">
        {metrics.map((metric) => (
          <MetricTile
            caption={metric.caption}
            id={metric.id}
            key={metric.id}
            label={metric.label}
            value={metric.value}
          />
        ))}
      </div>
    </Panel>
  );
}

function LaneBoard({
  filtersActive,
  lanes,
  visibleIssueCount,
}: {
  filtersActive: boolean;
  lanes: OrchestrationDashboardIssueLane[];
  visibleIssueCount: number;
}) {
  return (
    <section className="kanban-shell" aria-labelledby="lanes-title">
      <div className="kanban-heading">
        <div>
          <p className="eyebrow">Board</p>
          <h2 className="panel-title" id="lanes-title">
            Execution lanes
          </h2>
        </div>
        <Pill>{visibleIssueCount} visible</Pill>
      </div>
      {filtersActive && visibleIssueCount === 0 ? (
        <div className="empty-board">
          <p>No issues match these filters.</p>
          <Link className="secondary-button" href="/">
            Reset filters
          </Link>
        </div>
      ) : null}
      <div
        aria-label="Issue lane board"
        className="board"
        role="region"
        tabIndex={0}
      >
        {lanes.map((lane) => (
          <LaneColumn filtersActive={filtersActive} lane={lane} key={lane.id} />
        ))}
      </div>
    </section>
  );
}

function LaneColumn({
  filtersActive,
  lane,
}: {
  filtersActive: boolean;
  lane: OrchestrationDashboardIssueLane;
}) {
  return (
    <section
      className={`lane lane-${normalizeClassName(lane.id)}`}
      data-testid={`lane-${lane.id}`}
      aria-labelledby={`${lane.id}-title`}
    >
      <div className="lane-header">
        <div>
          <h3 className="lane-title" id={`${lane.id}-title`}>
            {lane.label}
          </h3>
        </div>
        <span className="count-pill" aria-label={`${lane.count} issues in ${lane.label}`}>
          {lane.count}
        </span>
      </div>
      <div className="lane-card-stack">
        {lane.cards.length === 0 ? (
          <div className="empty-lane">
            {filtersActive ? 'No matching issues in this lane' : 'No issues in this lane'}
          </div>
        ) : (
          lane.cards.map((card) => <IssueCard card={card} key={card.id} />)
        )}
      </div>
    </section>
  );
}

const LANE_OPTIONS: ReadonlyArray<{ value: OrchestrationDashboardLaneId; label: string }> = [
  { value: 'ready', label: 'Ready' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'needs_recovery', label: 'Needs recovery' },
  { value: 'pending', label: 'Pending' },
  { value: 'done', label: 'Done' },
  { value: 'failed', label: 'Failed' },
  { value: 'other', label: 'Other' },
];

const STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = LANE_OPTIONS.filter(
  (option) => option.value !== 'other',
);

function IssueCard({ card }: { card: OrchestrationDashboardIssueCard }) {
  const artifactEntries = Object.entries(card.artifactKinds).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const totalArtifactCount = artifactEntries.reduce((total, [, count]) => total + count, 0);
  const proofBadges = buildProofBadges(card, totalArtifactCount).filter((badge) => badge.count > 0);
  const healthSeverity = getHighestHealthSeverity(card.healthFlags);
  const healthSignal =
    card.healthFlags.length > 0
      ? `${card.healthFlags.length} gate signal${card.healthFlags.length === 1 ? '' : 's'}`
      : null;

  return (
    <Link
      aria-label={`Open issue ${card.id}: ${card.task}`}
      className={`issue-card issue-card-link card-status-${normalizeClassName(card.status)}${
        healthSeverity ? ` card-health-${healthSeverity}` : ''
      }`}
      data-testid={`issue-card-${card.id}`}
      href={`/issues/${encodeURIComponent(card.id)}`}
    >
      <div className="issue-card-topline">
        <span className="issue-id">{card.id}</span>
        <span className={`priority-pill ${normalizeClassName(card.priority)}`}>{card.priority}</span>
      </div>
      <h4 className="issue-title">{card.task}</h4>
      <div className="issue-meta issue-meta-row" aria-label={`Execution metadata for ${card.id}`}>
        <span>size {card.size}</span>
        {card.deadlineAt ? (
          <span>due {formatDate(card.deadlineAt)}</span>
        ) : null}
        {card.activeLeases.length > 0 ? (
          <span>{card.activeLeases.length} active lease(s)</span>
        ) : null}
      </div>
      {proofBadges.length > 0 ? (
        <div className="proof-strip compact-proof-strip" aria-label={`Proof summary for ${card.id}`}>
          {proofBadges.map((badge) => (
            <span className={`proof-badge ${badge.className}`} key={badge.label}>
              <span className="proof-count">{badge.count}</span>
              {badge.label}
            </span>
          ))}
        </div>
      ) : null}
      {card.nextBestAction ? (
        <p className="issue-action">
          <strong>Next:</strong> {card.nextBestAction}
        </p>
      ) : null}
      {card.blockedReason ? (
        <p className="issue-blocker">
          <strong>Blocker:</strong> {card.blockedReason}
        </p>
      ) : null}
      {healthSignal ? (
        <p className={`issue-health health-${healthSeverity ?? 'medium'}`}>{healthSignal}</p>
      ) : null}
    </Link>
  );
}

interface ProofBadge {
  label: string;
  count: number;
  className: string;
}

type HealthSeverity = 'high' | 'medium' | 'low';

function buildProofBadges(
  card: OrchestrationDashboardIssueCard,
  totalArtifactCount: number,
): ProofBadge[] {
  return [
    {
      label: 'artifacts',
      count: totalArtifactCount,
      className: totalArtifactCount > 0 ? 'proof-badge-positive' : 'proof-badge-muted',
    },
    {
      label: 'CSQR',
      count: card.csqrLiteScorecardIds.length,
      className: card.csqrLiteScorecardIds.length > 0 ? 'proof-badge-success' : 'proof-badge-muted',
    },
    {
      label: 'worktrees',
      count: card.worktreePaths.length,
      className: card.worktreePaths.length > 0 ? 'proof-badge-info' : 'proof-badge-muted',
    },
  ];
}

function getHighestHealthSeverity(
  flags: OrchestrationDashboardHealthFlag[],
): HealthSeverity | null {
  if (flags.some((flag) => flag.severity === 'high')) {
    return 'high';
  }

  if (flags.some((flag) => flag.severity === 'medium')) {
    return 'medium';
  }

  return flags.length > 0 ? 'low' : null;
}

function HealthPanel({ viewModel }: DashboardShellProps) {
  return (
    <section className="panel" data-testid="health-panel" aria-labelledby="health-title">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Health</p>
          <h2 className="panel-title" id="health-title">
            Automated gate signals
          </h2>
        </div>
        <span className={`status-pill ${viewModel.health.status}`}>
          {viewModel.health.status}
        </span>
      </div>
      <div className="issue-meta" aria-label="Severity counts">
        <span className="small-pill">high {viewModel.health.severityCounts.high}</span>
        <span className="small-pill">medium {viewModel.health.severityCounts.medium}</span>
        <span className="small-pill">low {viewModel.health.severityCounts.low}</span>
      </div>
      <div className="stack health-stack">
        {viewModel.health.globalFlags.length === 0 ? (
          <p className="panel-copy">No global orchestration health flags.</p>
        ) : (
          viewModel.health.globalFlags.map((flag) => (
            <HealthFlagCard flag={flag} key={`${flag.kind}-${flag.message}`} />
          ))
        )}
      </div>
    </section>
  );
}

function HealthFlagCard({ flag }: { flag: OrchestrationDashboardHealthFlag }) {
  return (
    <article className="health-flag">
      <p className="flag-title">
        {HEALTH_FLAG_LABELS[flag.kind]}
        <span className="small-pill">{flag.severity}</span>
      </p>
      <p className="flag-copy">{flag.message}</p>
    </article>
  );
}

function ActiveAgentsPanel({ agents }: { agents: OrchestrationDashboardActiveAgent[] }) {
  return (
    <section className="panel" data-testid="active-agents" aria-labelledby="agents-title">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Agents</p>
          <h2 className="panel-title" id="agents-title">
            Active leases
          </h2>
        </div>
        <span className="count-pill">{agents.length}</span>
      </div>
      <div className="stack">
        {agents.length === 0 ? (
          <p className="panel-copy">No active leases are currently claimed.</p>
        ) : (
          agents.map((agent) => (
            <article
              className={`agent-card${agent.expired ? ' expired' : ''}`}
              key={agent.leaseId}
            >
              <p className="agent-title">
                {agent.agentId}
                <span className="small-pill">{agent.expired ? 'expired' : agent.status}</span>
              </p>
              <p className="agent-meta">
                Lease {agent.leaseId} owns {agent.issueId ?? 'unscoped work'} until{' '}
                {formatDate(agent.expiresAt)}.
              </p>
              {agent.primaryForIssue ? <span className="small-pill">primary lease</span> : null}
            </article>
          ))
        )}
      </div>
    </section>
  );
}

function EvidencePanel({ viewModel }: DashboardShellProps) {
  const evidenceMetrics = [
    ['Total artifacts', viewModel.evidence.totalArtifacts],
    ['Worktree paths', viewModel.evidence.worktreePathCount],
    ['Evidence packets', viewModel.evidence.evidencePacketCount],
    ['CSQR scorecards', viewModel.evidence.csqrLiteScorecardCount],
    ['Orphan artifacts', viewModel.evidence.orphanArtifactCount],
  ];

  return (
    <section className="panel" data-testid="evidence-summary" aria-labelledby="evidence-title">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Evidence</p>
          <h2 className="panel-title" id="evidence-title">
            Proof-of-work packet
          </h2>
        </div>
      </div>
      <div className="evidence-grid">
        {evidenceMetrics.map(([label, value]) => (
          <div className="evidence-card" key={label}>
            <span className="label">{label}</span>
            <span className="metric-value">{value}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function TimelinePanel({ viewModel }: DashboardShellProps) {
  return (
    <section className="panel" data-testid="timeline" aria-labelledby="timeline-title">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Timeline</p>
          <h2 className="panel-title" id="timeline-title">
            Recent orchestration events
          </h2>
        </div>
      </div>
      <div className="stack">
        {viewModel.recentTimeline.length === 0 ? (
          <p className="panel-copy">No recent orchestration events.</p>
        ) : (
          viewModel.recentTimeline.map((event) => (
            <article className="timeline-item" key={event.id}>
              <p className="timeline-title">
                {formatKind(event.kind)}
                <span className="small-pill">{formatDate(event.createdAt)}</span>
              </p>
              <p className="timeline-meta">
                Run {event.runId} {event.issueId ? `for ${event.issueId}` : 'at campaign scope'}
              </p>
              <pre className="timeline-payload">
                {JSON.stringify(event.payload, null, 2)}
              </pre>
            </article>
          ))
        )}
      </div>
    </section>
  );
}

function formatKind(kind: string): string {
  return kind
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatDate(value: string): string {
  return value.slice(0, 10);
}

function normalizeClassName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
}
