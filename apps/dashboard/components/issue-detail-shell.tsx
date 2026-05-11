import React from 'react';
import Link from 'next/link';

import type { DashboardIssueDetail } from '../lib/dashboard-issue-detail';

interface IssueDetailShellProps {
  detail: DashboardIssueDetail;
  dataSource?: 'live' | 'demo';
  claimIssueAction?: React.ComponentProps<'form'>['action'];
}

const CLAIMABLE_STATUSES = new Set(['ready']);

export function IssueDetailShell({
  claimIssueAction,
  dataSource = 'live',
  detail,
}: IssueDetailShellProps) {
  const claimDisabled =
    dataSource !== 'live' ||
    claimIssueAction === undefined ||
    !CLAIMABLE_STATUSES.has(detail.card.status);
  const primaryLease =
    detail.leases.find((lease) => lease.status === 'active') ??
    detail.leases[0];

  return (
    <main className="dashboard-root" data-testid="issue-detail-dashboard">
      <div className="dashboard-frame">
        <section className="detail-hero panel" aria-labelledby="issue-detail-title">
          <div>
            <Link className="back-link" href="/">
              Back to board
            </Link>
            <p className="eyebrow">Issue detail</p>
            <h1 className="detail-title" id="issue-detail-title">
              {detail.card.task}
            </h1>
            <div className="issue-meta">
              <span className="small-pill">{detail.card.id}</span>
              <span className="small-pill">{detail.card.status}</span>
              <span className={`priority-pill ${normalizeClassName(detail.card.priority)}`}>
                {detail.card.priority}
              </span>
              <span className="small-pill">size {detail.card.size}</span>
            </div>
          </div>
          <ClaimPanel
            action={claimIssueAction}
            disabled={claimDisabled}
            issueId={detail.card.id}
            reason={getClaimDisabledReason(dataSource, detail.card.status, claimIssueAction)}
          />
        </section>

        <section className="detail-grid">
          <StatusPanel detail={detail} />
          <AgentPanel leases={detail.leases} primaryLease={primaryLease} />
          <CheckpointPanel detail={detail} />
          <EvidenceDetailPanel detail={detail} />
          <TimelineDetailPanel detail={detail} />
        </section>
      </div>
    </main>
  );
}

export function DashboardIssueNotFound({
  issueId,
  message,
}: {
  issueId: string;
  message: string;
}) {
  return (
    <main className="dashboard-root setup-root" data-testid="issue-detail-not-found">
      <section className="hero-panel setup-panel" aria-labelledby="issue-not-found-title">
        <p className="eyebrow">Issue detail</p>
        <h1 className="hero-title" id="issue-not-found-title">
          Issue not found.
        </h1>
        <p className="hero-copy">{message}</p>
        <p className="panel-copy">Requested issue: <code>{issueId}</code></p>
        <Link className="back-link" href="/">
          Back to board
        </Link>
      </section>
    </main>
  );
}

function ClaimPanel({
  action,
  disabled,
  issueId,
  reason,
}: {
  action?: React.ComponentProps<'form'>['action'];
  disabled: boolean;
  issueId: string;
  reason: string | null;
}) {
  return (
    <form action={action} className="claim-panel" data-testid="claim-issue-form">
      <input name="issueId" type="hidden" value={issueId} />
      <button className="primary-button" disabled={disabled} type="submit">
        Claim issue
      </button>
      {reason ? <p className="form-note">{reason}</p> : null}
    </form>
  );
}

function StatusPanel({ detail }: { detail: DashboardIssueDetail }) {
  return (
    <section className="panel" data-testid="issue-status-panel" aria-labelledby="status-title">
      <p className="eyebrow">Current status</p>
      <h2 className="panel-title" id="status-title">
        {detail.card.status}
      </h2>
      {detail.card.nextBestAction ? (
        <p className="issue-action">
          <strong>Next action:</strong> {detail.card.nextBestAction}
        </p>
      ) : null}
      {detail.card.blockedReason ? (
        <p className="issue-blocker">
          <strong>Blocker:</strong> {detail.card.blockedReason}
        </p>
      ) : null}
      {detail.card.healthFlags.length === 0 ? (
        <p className="panel-copy">No issue-specific health flags.</p>
      ) : (
        <div className="stack health-stack">
          {detail.card.healthFlags.map((flag) => (
            <div className="health-flag" key={`${flag.kind}-${flag.message}`}>
              <p className="flag-title">{flag.kind}</p>
              <p className="flag-copy">{flag.message}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function AgentPanel({
  leases,
  primaryLease,
}: {
  leases: DashboardIssueDetail['leases'];
  primaryLease: DashboardIssueDetail['leases'][number] | undefined;
}) {
  return (
    <section className="panel" data-testid="issue-agent-panel" aria-labelledby="agent-title">
      <p className="eyebrow">Agent</p>
      <h2 className="panel-title" id="agent-title">
        Current and historical work
      </h2>
      {primaryLease === undefined ? (
        <p className="panel-copy">No agent has claimed this issue yet.</p>
      ) : (
        <div className="agent-card">
          <p className="agent-title">
            {primaryLease.agentId}
            <span className="status-pill">{primaryLease.status}</span>
          </p>
          <p className="agent-meta">
            Lease {primaryLease.id} acquired {formatDate(primaryLease.acquiredAt)}
            {primaryLease.releasedAt ? ` and released ${formatDate(primaryLease.releasedAt)}` : ''}
          </p>
        </div>
      )}
      {leases.length > 1 ? (
        <div className="artifact-list" aria-label="Lease history">
          {leases.map((lease) => (
            <span className="small-pill" key={lease.id}>
              {lease.agentId}: {lease.status}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function CheckpointPanel({ detail }: { detail: DashboardIssueDetail }) {
  return (
    <section className="panel detail-wide" data-testid="issue-checkpoints-panel" aria-labelledby="checkpoints-title">
      <p className="eyebrow">Agent notes</p>
      <h2 className="panel-title" id="checkpoints-title">
        What the agent wrote
      </h2>
      <div className="stack">
        {detail.checkpoints.length === 0 ? (
          <p className="panel-copy">No checkpoint notes have been written for this issue yet.</p>
        ) : (
          detail.checkpoints.map((checkpoint) => (
            <article className="timeline-item" key={checkpoint.id}>
              <p className="timeline-title">
                {checkpoint.title}
                <span className="status-pill">{checkpoint.taskStatus}</span>
              </p>
              <p className="timeline-meta">{checkpoint.summary}</p>
              <p className="issue-action">
                <strong>Next step:</strong> {checkpoint.nextStep}
              </p>
              {checkpoint.artifactIds.length > 0 ? (
                <div className="artifact-list" aria-label={`Checkpoint artifacts for ${checkpoint.id}`}>
                  {checkpoint.artifactIds.map((artifactId) => (
                    <span className="small-pill" key={artifactId}>
                      {artifactId}
                    </span>
                  ))}
                </div>
              ) : null}
            </article>
          ))
        )}
      </div>
    </section>
  );
}

function EvidenceDetailPanel({ detail }: { detail: DashboardIssueDetail }) {
  return (
    <section className="panel detail-wide" data-testid="issue-evidence-panel" aria-labelledby="evidence-title">
      <p className="eyebrow">Evidence</p>
      <h2 className="panel-title" id="evidence-title">
        Artifacts and proof
      </h2>
      <div className="stack">
        {detail.artifacts.length === 0 ? (
          <p className="panel-copy">No evidence artifacts are attached to this issue yet.</p>
        ) : (
          detail.artifacts.map((artifact) => (
            <article className="evidence-card evidence-detail-card" key={artifact.id}>
              <p className="agent-title">
                {artifact.kind}
                <span className="small-pill">{artifact.id}</span>
              </p>
              <p className="timeline-meta">{artifact.path}</p>
              <pre className="timeline-payload">
                {JSON.stringify(artifact.metadata, null, 2)}
              </pre>
            </article>
          ))
        )}
      </div>
    </section>
  );
}

function TimelineDetailPanel({ detail }: { detail: DashboardIssueDetail }) {
  return (
    <section className="panel detail-wide" data-testid="issue-timeline-panel" aria-labelledby="timeline-detail-title">
      <p className="eyebrow">Timeline</p>
      <h2 className="panel-title" id="timeline-detail-title">
        Issue events
      </h2>
      <div className="stack">
        {detail.timeline.length === 0 ? (
          <p className="panel-copy">No issue events have been recorded yet.</p>
        ) : (
          detail.timeline.map((event) => (
            <article className="timeline-item" key={event.id}>
              <p className="timeline-title">{event.kind}</p>
              <p className="timeline-meta">
                Run {event.runId} at {formatDate(event.createdAt)}
              </p>
              <pre className="timeline-payload">{JSON.stringify(event.payload, null, 2)}</pre>
            </article>
          ))
        )}
      </div>
    </section>
  );
}

function getClaimDisabledReason(
  dataSource: 'live' | 'demo',
  status: string,
  action?: React.ComponentProps<'form'>['action'],
): string | null {
  if (dataSource !== 'live' || action === undefined) {
    return 'Claim is available only in live DB mode.';
  }

  if (!CLAIMABLE_STATUSES.has(status)) {
    return `Issue cannot be claimed from status ${status}.`;
  }

  return null;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function normalizeClassName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
}
