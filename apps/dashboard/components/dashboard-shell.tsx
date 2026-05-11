import React from 'react';

import type {
  OrchestrationDashboardActiveAgent,
  OrchestrationDashboardHealthFlag,
  OrchestrationDashboardIssueCard,
  OrchestrationDashboardIssueLane,
  OrchestrationDashboardViewModel,
} from 'harness-os/orchestration';
import type { DashboardPageState } from '../lib/dashboard-data';

interface DashboardShellProps {
  viewModel: OrchestrationDashboardViewModel;
  dataSource?: 'live' | 'demo';
  createIssueAction?: React.ComponentProps<'form'>['action'];
}

const HEALTH_FLAG_LABELS: Record<OrchestrationDashboardHealthFlag['kind'], string> = {
  duplicate_active_worktree_artifact_path: 'Duplicate worktree path',
  done_issue_missing_evidence: 'Done issue missing evidence',
  expired_active_lease: 'Expired lease',
};

export function DashboardShell({
  createIssueAction,
  dataSource = 'live',
  viewModel,
}: DashboardShellProps) {
  return (
    <main className="dashboard-root" data-testid="orchestration-dashboard">
      <div className="dashboard-frame">
        <section className="dashboard-hero" aria-labelledby="dashboard-title">
          <div className="hero-panel">
            <p className="eyebrow">HarnessOS Symphony dashboard</p>
            <h1 className="hero-title" id="dashboard-title">
              Linear-like command center for fully agentic campaigns.
            </h1>
            <p className="hero-copy">
              Track issue lanes, active leases, worktree evidence, CSQR scorecards,
              and recovery signals from the stable orchestration dashboard view model.
            </p>
            <div className="scope-grid" aria-label="Dashboard scope">
              <ScopePill label="Project" value={viewModel.scope.projectId} />
              <ScopePill label="Campaign" value={viewModel.scope.campaignId ?? 'All campaigns'} />
              <ScopePill label="Issue" value={viewModel.scope.issueId ?? 'All issues'} />
            </div>
          </div>
          <OverviewPanel dataSource={dataSource} viewModel={viewModel} />
        </section>

        <section className="content-grid">
          <div>
            <LaneBoard lanes={viewModel.issueLanes} />
          </div>
          <aside aria-label="Evidence and health summaries">
            <CreateTicketPanel action={createIssueAction} dataSource={dataSource} />
            <HealthPanel viewModel={viewModel} />
            <ActiveAgentsPanel agents={viewModel.activeAgents} />
            <EvidencePanel viewModel={viewModel} />
            <TimelinePanel viewModel={viewModel} />
          </aside>
        </section>
      </div>
    </main>
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
    <section className="panel create-ticket-panel" data-testid="create-ticket-panel" aria-labelledby="create-ticket-title">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Create ticket</p>
          <h2 className="panel-title" id="create-ticket-title">
            Add work to this campaign
          </h2>
          <p className="panel-copy">
            Creates a real ready issue in the configured HarnessOS database.
          </p>
        </div>
      </div>
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
    </section>
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
    <section className="panel" aria-labelledby="overview-title">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Live overview</p>
          <h2 className="panel-title" id="overview-title">
            Campaign pulse
          </h2>
        </div>
        <div className="header-pills">
          <span className="status-pill">{dataSource} data</span>
          <span className={`status-pill ${viewModel.health.status}`}>
            {viewModel.health.status}
          </span>
        </div>
      </div>
      <div className="metric-grid">
        {metrics.map((metric) => (
          <div className="metric-card" data-testid={`metric-${metric.id}`} key={metric.id}>
            <span className="label">{metric.label}</span>
            <span className="metric-value">{metric.value}</span>
            <p className="metric-caption">{metric.caption}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function LaneBoard({ lanes }: { lanes: OrchestrationDashboardIssueLane[] }) {
  return (
    <section className="panel" aria-labelledby="lanes-title">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Issue lanes</p>
          <h2 className="panel-title" id="lanes-title">
            Dependency-ordered execution board
          </h2>
          <p className="panel-copy">
            Lanes are rendered in the stable v1 contract order and preserve unknown
            future states in Other.
          </p>
        </div>
      </div>
      <div className="board">
        {lanes.map((lane) => (
          <LaneColumn lane={lane} key={lane.id} />
        ))}
      </div>
    </section>
  );
}

function LaneColumn({ lane }: { lane: OrchestrationDashboardIssueLane }) {
  return (
    <section className="lane" data-testid={`lane-${lane.id}`} aria-labelledby={`${lane.id}-title`}>
      <div className="lane-header">
        <div>
          <h3 className="lane-title" id={`${lane.id}-title`}>
            {lane.label}
          </h3>
          <p className="lane-description">{lane.description}</p>
        </div>
        <span className="count-pill">{lane.count}</span>
      </div>
      <div className="lane-card-stack">
        {lane.cards.length === 0 ? (
          <div className="empty-lane">No issues in this lane</div>
        ) : (
          lane.cards.map((card) => <IssueCard card={card} key={card.id} />)
        )}
      </div>
    </section>
  );
}

function IssueCard({ card }: { card: OrchestrationDashboardIssueCard }) {
  const artifactEntries = Object.entries(card.artifactKinds).sort(([left], [right]) =>
    left.localeCompare(right),
  );

  return (
    <article className="issue-card" data-testid={`issue-card-${card.id}`}>
      <div className="issue-card-header">
        <div>
          <p className="issue-id">{card.id}</p>
          <h4 className="issue-title">{card.task}</h4>
        </div>
        <span className={`priority-pill ${normalizeClassName(card.priority)}`}>
          {card.priority}
        </span>
      </div>
      <div className="issue-meta">
        <span className="small-pill">{card.status}</span>
        <span className="small-pill">size {card.size}</span>
        {card.deadlineAt ? (
          <span className="small-pill">due {formatDate(card.deadlineAt)}</span>
        ) : null}
        {card.activeLeases.length > 0 ? (
          <span className="small-pill">{card.activeLeases.length} active lease(s)</span>
        ) : null}
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
        <div className="artifact-list" aria-label={`Evidence artifacts for ${card.id}`}>
          {artifactEntries.map(([kind, count]) => (
            <span className="small-pill" key={kind}>
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
            <span className="small-pill" key={worktreePath}>
              {worktreePath}
            </span>
          ))}
        </div>
      ) : null}
      {card.healthFlags.length > 0 ? (
        <div className="issue-health">
          {card.healthFlags.map((flag) => (
            <div key={`${card.id}-${flag.kind}-${flag.message}`}>
              <strong>{HEALTH_FLAG_LABELS[flag.kind]}:</strong> {flag.message}
            </div>
          ))}
        </div>
      ) : null}
    </article>
  );
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
