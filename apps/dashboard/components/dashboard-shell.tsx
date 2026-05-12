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

  return (
    <main className="dashboard-root" data-testid="orchestration-dashboard">
      <div className="dashboard-frame dashboard-workspace">
        <WorkspaceSidebar
          dataSource={dataSource}
          savedViewModel={savedViewsSource}
          viewModel={viewModel}
        />
        <section className="dashboard-main" aria-labelledby="dashboard-title">
          <DashboardTopbar
            dataSource={dataSource}
            filters={filters}
            totalIssueCount={totalIssueCount}
            viewModel={viewModel}
          />
          <OverviewPanel dataSource={dataSource} viewModel={viewModel} />

          <section className="content-grid">
            <div className="board-region">
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
            <aside className="dashboard-inspector" aria-label="Evidence and health summaries">
              <CreateTicketPanel action={createIssueAction} dataSource={dataSource} />
              <HealthPanel viewModel={viewModel} />
              <ActiveAgentsPanel agents={viewModel.activeAgents} />
              <EvidencePanel viewModel={viewModel} />
              <TimelinePanel viewModel={viewModel} />
            </aside>
          </section>
        </section>
      </div>
    </main>
  );
}

function WorkspaceSidebar({
  dataSource,
  savedViewModel,
  viewModel,
}: {
  dataSource: 'live' | 'demo';
  savedViewModel: OrchestrationDashboardViewModel;
  viewModel: OrchestrationDashboardViewModel;
}) {
  const savedViews = buildSavedViews(savedViewModel);

  return (
    <aside className="workspace-sidebar" data-testid="dashboard-sidebar" aria-label="Workspace navigation">
      <div className="workspace-brand">
        <span className="workspace-logo" aria-hidden="true">
          H
        </span>
        <div>
          <p className="eyebrow">HarnessOS</p>
          <p className="workspace-name">Symphony</p>
        </div>
      </div>
      <nav className="workspace-nav" aria-label="Saved dashboard views">
        <p className="nav-section-label">Saved views</p>
        {savedViews.map((view) => (
          <Link className="nav-item" data-testid={`saved-view-${view.id}`} href={view.href} key={view.id}>
            <span>{view.label}</span>
            <span className="nav-count">{view.count}</span>
          </Link>
        ))}
      </nav>
      <div className="workspace-scope" aria-label="Dashboard scope">
        <ScopePill label="Project" value={viewModel.scope.projectId} />
        <ScopePill label="Campaign" value={viewModel.scope.campaignId ?? 'All campaigns'} />
        <ScopePill label="Issue" value={viewModel.scope.issueId ?? 'All issues'} />
      </div>
      <div className="workspace-footer">
        <Pill className="status-pill">{dataSource} data</Pill>
        <Pill className={`status-pill ${viewModel.health.status}`}>
          {viewModel.health.status}
        </Pill>
      </div>
    </aside>
  );
}

function DashboardTopbar({
  dataSource,
  filters,
  totalIssueCount,
  viewModel,
}: {
  dataSource: 'live' | 'demo';
  filters: OrchestrationDashboardIssueFilters;
  totalIssueCount: number;
  viewModel: OrchestrationDashboardViewModel;
}) {
  return (
    <header className="workspace-topbar" data-testid="dashboard-topbar">
      <div className="workspace-title-block">
        <p className="eyebrow">HarnessOS Symphony dashboard</p>
        <h1 className="workspace-title" id="dashboard-title">
          Linear-like command center for fully agentic campaigns.
        </h1>
        <p className="workspace-subtitle">
          Track lanes, leases, proof artifacts, CSQR scorecards, and recovery signals
          from the stable orchestration dashboard view model.
        </p>
      </div>
      <div className="workspace-command-stack">
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
    </header>
  );
}

function buildSavedViews(viewModel: OrchestrationDashboardViewModel): SavedView[] {
  return [
    {
      id: 'all',
      label: 'All work',
      href: { pathname: '/' },
      count: viewModel.overview.totalIssues,
    },
    {
      id: 'ready',
      label: 'Ready to claim',
      href: { pathname: '/', query: { status: 'ready' } },
      count: countSavedViewIssues(viewModel, { status: ['ready'] }),
    },
    {
      id: 'active',
      label: 'Active leases',
      href: { pathname: '/', query: { signal: 'active' } },
      count: countSavedViewIssues(viewModel, { signal: 'active' }),
    },
    {
      id: 'blocked',
      label: 'Blocked / recovery',
      href: { pathname: '/', query: { signal: 'blocked' } },
      count: countSavedViewIssues(viewModel, { signal: 'blocked' }),
    },
    {
      id: 'proof',
      label: 'Proof artifacts',
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
    <Panel className="filter-panel" aria-labelledby="filters-title">
      <SectionHeader
        copy={
          <span aria-live="polite" className="results-summary" id="filter-summary">
            Showing {visibleIssueCount} of {totalIssueCount} issues.
          </span>
        }
        eyebrow="Dashboard filters"
        title="Find issues and proof artifacts"
        titleId="filters-title"
      />
      <form action="/" aria-describedby="filter-summary" className="filter-form" method="get">
        <div className="filter-grid">
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
          <label className="field">
            <span className="label">Signal</span>
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
        <div className="filter-actions">
          <button className="primary-button" type="submit">
            Apply filters
          </button>
          <Link className="secondary-button" href="/">
            Reset filters
          </Link>
        </div>
      </form>
    </Panel>
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
    <Panel aria-labelledby="lanes-title">
      <SectionHeader
        actions={<Pill>{visibleIssueCount} visible issues</Pill>}
        copy="Lanes keep the stable v1 contract order, preserve future states in Other, and support dense horizontal navigation."
        eyebrow="Issue lanes"
        title="Dependency-ordered execution board"
        titleId="lanes-title"
      />
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
    </Panel>
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
          <p className="lane-description">{lane.description}</p>
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
  const proofBadges = buildProofBadges(card, totalArtifactCount);
  const healthSeverity = getHighestHealthSeverity(card.healthFlags);

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
        <span className={`status-pill ${normalizeClassName(card.status)}`}>
          {formatKind(card.status)}
        </span>
      </div>
      <div className="issue-card-header">
        <h4 className="issue-title">{card.task}</h4>
        <span className={`priority-pill ${normalizeClassName(card.priority)}`}>
          {card.priority}
        </span>
      </div>
      <div className="issue-meta issue-meta-grid" aria-label={`Execution metadata for ${card.id}`}>
        <span className="small-pill">size {card.size}</span>
        {card.deadlineAt ? (
          <span className="small-pill">due {formatDate(card.deadlineAt)}</span>
        ) : null}
        {card.activeLeases.length > 0 ? (
          <span className="small-pill">{card.activeLeases.length} active lease(s)</span>
        ) : null}
      </div>
      <div className="proof-strip" aria-label={`Proof summary for ${card.id}`}>
        {proofBadges.map((badge) => (
          <span className={`proof-badge ${badge.className}`} key={badge.label}>
            <span className="proof-count">{badge.count}</span>
            {badge.label}
          </span>
        ))}
      </div>
      {card.nextBestAction ? (
        <p className="issue-action">
          <strong>Next action:</strong> {card.nextBestAction}
        </p>
      ) : null}
      {card.blockedReason ? (
        <p className="issue-blocker">
          <strong>Blocker:</strong> {card.blockedReason}
        </p>
      ) : null}
      {artifactEntries.length > 0 ? (
        <div className="artifact-list compact-artifact-list" aria-label={`Evidence artifacts for ${card.id}`}>
          {artifactEntries.map(([kind, count]) => (
            <span className="small-pill proof-kind-pill" key={kind}>
              {formatKind(kind)} x {count}
            </span>
          ))}
        </div>
      ) : null}
      {card.csqrLiteScorecardIds.length > 0 ? (
        <div className="artifact-list" aria-label={`CSQR scorecards for ${card.id}`}>
          {card.csqrLiteScorecardIds.map((scorecardId) => (
            <span className="small-pill" key={scorecardId}>
              CSQR {scorecardId}
            </span>
          ))}
        </div>
      ) : null}
      {card.worktreePaths.length > 0 ? (
        <div className="artifact-list" aria-label={`Worktrees for ${card.id}`}>
          {card.worktreePaths.map((worktreePath) => (
            <span className="small-pill truncate-pill" key={worktreePath} title={worktreePath}>
              {formatWorktreePath(worktreePath)}
            </span>
          ))}
        </div>
      ) : null}
      {card.healthFlags.length > 0 ? (
        <div className={`issue-health health-${healthSeverity ?? 'medium'}`}>
          {card.healthFlags.map((flag, index) => (
            <div key={`${card.id}-${flag.kind}-${index}-${flag.message}`}>
              <strong>{HEALTH_FLAG_LABELS[flag.kind]}:</strong> {flag.message}
            </div>
          ))}
        </div>
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

function formatWorktreePath(path: string): string {
  const segments = path.split('/').filter(Boolean);
  return segments.at(-1) ?? path;
}

function normalizeClassName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
}
