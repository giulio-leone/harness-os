import React from 'react';
import Link from 'next/link';
import {
  csqrLiteDefaultTargetScore,
  csqrLiteScorecardSchema,
  type CsqrLiteScorecard,
} from 'harness-os/orchestration';

import type { DashboardIssueDetail } from '../lib/dashboard-issue-detail';

interface IssueDetailShellProps {
  detail: DashboardIssueDetail;
  dataSource?: 'live' | 'demo';
  claimIssueAction?: React.ComponentProps<'form'>['action'];
}

const CLAIMABLE_STATUSES = new Set(['ready']);

type IssueArtifact = DashboardIssueDetail['artifacts'][number];
type IssueCheckpoint = DashboardIssueDetail['checkpoints'][number];

interface EvidenceGroup {
  kind: string;
  artifacts: IssueArtifact[];
}

interface ProofReviewModel {
  evidenceGroups: EvidenceGroup[];
  checkpointMap: Map<string, IssueCheckpoint[]>;
  csqrScorecards: CsqrScorecardProof[];
  metadataWarningCount: number;
  provenanceCoveredArtifactCount: number;
  latestCheckpoint: IssueCheckpoint | null;
}

type CsqrScorecardProof =
  | {
      kind: 'valid';
      artifact: IssueArtifact;
      scorecard: CsqrLiteScorecard;
      threshold: number;
      passed: boolean;
    }
  | {
      kind: 'invalid';
      artifact: IssueArtifact;
      error: string;
    };

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
  const proofReview = buildProofReviewModel(detail);

  return (
    <main className="dashboard-root" data-testid="issue-detail-dashboard">
      <div className="dashboard-frame">
        <section className="detail-hero" aria-labelledby="issue-detail-title">
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
              <span className={`status-pill ${normalizeClassName(detail.card.status)}`}>
                {detail.card.status}
              </span>
              <span className={`priority-pill ${normalizeClassName(detail.card.priority)}`}>
                {detail.card.priority}
              </span>
              <span className="small-pill">size {detail.card.size}</span>
            </div>
          </div>
        </section>

        <section className="detail-layout">
          <div className="detail-primary">
            <CheckpointPanel detail={detail} />
            <EvidenceDetailPanel detail={detail} proofReview={proofReview} />
            <TimelineDetailPanel detail={detail} />
          </div>
          <aside className="detail-inspector" aria-label="Issue proof inspector">
            <ClaimPanel
              action={claimIssueAction}
              disabled={claimDisabled}
              issueId={detail.card.id}
              reason={getClaimDisabledReason(dataSource, detail.card.status, claimIssueAction)}
            />
            <StatusPanel detail={detail} />
            <AgentPanel leases={detail.leases} primaryLease={primaryLease} />
            <ProofReviewPanel detail={detail} proofReview={proofReview} />
          </aside>
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
    <form action={action} className="panel claim-panel" data-testid="claim-issue-form">
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
              <p className="timeline-meta">
                {checkpoint.id} · {formatDate(checkpoint.createdAt)}
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

function ProofReviewPanel({
  detail,
  proofReview,
}: {
  detail: DashboardIssueDetail;
  proofReview: ProofReviewModel;
}) {
  const validScorecards = proofReview.csqrScorecards.filter((scorecard) => scorecard.kind === 'valid');
  const invalidScorecards = proofReview.csqrScorecards.length - validScorecards.length;

  return (
    <section className="panel proof-review-panel" data-testid="issue-proof-review-panel" aria-labelledby="proof-review-title">
      <p className="eyebrow">Proof review</p>
      <h2 className="panel-title" id="proof-review-title">
        Automated proof clarity
      </h2>
      <p className="automated-proof-note" data-testid="automated-proof-note">
        Automated proof only - no human review is required for completion.
      </p>
      <div className="proof-review-grid" aria-label="Proof review summary">
        <ProofReviewMetric label="Artifacts" value={detail.artifacts.length} />
        <ProofReviewMetric label="Provenance" value={`${proofReview.provenanceCoveredArtifactCount}/${detail.artifacts.length}`} />
        <ProofReviewMetric label="CSQR valid" value={validScorecards.length} />
        <ProofReviewMetric label="CSQR invalid" value={invalidScorecards} />
        <ProofReviewMetric label="Metadata warnings" value={proofReview.metadataWarningCount} />
        <ProofReviewMetric label="Checkpoints" value={detail.checkpoints.length} />
      </div>
      {proofReview.latestCheckpoint ? (
        <p className="panel-copy">
          Latest checkpoint: <strong>{proofReview.latestCheckpoint.title}</strong> -{' '}
          {formatDate(proofReview.latestCheckpoint.createdAt)}
        </p>
      ) : (
        <p className="panel-copy">No checkpoint has recorded proof yet.</p>
      )}
    </section>
  );
}

function ProofReviewMetric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="proof-review-metric">
      <span className="label">{label}</span>
      <span className="metric-value">{value}</span>
    </div>
  );
}

function EvidenceDetailPanel({
  detail,
  proofReview,
}: {
  detail: DashboardIssueDetail;
  proofReview: ProofReviewModel;
}) {
  return (
    <section className="panel detail-wide" data-testid="issue-evidence-panel" aria-labelledby="evidence-title">
      <p className="eyebrow">Proof layer</p>
      <h2 className="panel-title" id="evidence-title">
        Evidence drilldown
      </h2>
      <div className="proof-summary" aria-label="Evidence summary">
        <span className="small-pill">{detail.artifacts.length} artifacts</span>
        <span className="small-pill">{proofReview.evidenceGroups.length} evidence groups</span>
        <span className="small-pill">{detail.checkpoints.length} checkpoints</span>
        <span className="small-pill">{proofReview.csqrScorecards.length} CSQR scorecards</span>
        <span className="small-pill">
          provenance {proofReview.provenanceCoveredArtifactCount}/{detail.artifacts.length}
        </span>
      </div>
      <CsqrScorecardPanel scorecards={proofReview.csqrScorecards} />
      <EvidenceGroupList groups={proofReview.evidenceGroups} checkpointMap={proofReview.checkpointMap} />
    </section>
  );
}

function CsqrScorecardPanel({
  scorecards,
}: {
  scorecards: CsqrScorecardProof[];
}) {
  return (
    <section className="proof-section" aria-labelledby="csqr-scorecards-title">
      <h3 className="section-title" id="csqr-scorecards-title">
        CSQR-lite scorecards
      </h3>
      {scorecards.length === 0 ? (
        <p className="panel-copy">No CSQR-lite scorecard artifacts are attached.</p>
      ) : (
        <div className="proof-card-grid">
          {scorecards.map((scorecard) => (
            <CsqrScorecardCard
              key={scorecard.artifact.id}
              scorecard={scorecard}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function CsqrScorecardCard({
  scorecard,
}: {
  scorecard: CsqrScorecardProof;
}) {
  if (scorecard.kind === 'invalid') {
    return (
      <article className="scorecard-card">
        <p className="agent-title">
          Invalid CSQR metadata
          <span className="small-pill">{scorecard.artifact.id}</span>
        </p>
        <p className="issue-blocker">{scorecard.error}</p>
        <ArtifactRawMetadata artifact={scorecard.artifact} />
      </article>
    );
  }

  const scoreByCriterionId = new Map(
    scorecard.scorecard.scores.map((score) => [score.criterionId, score]),
  );

  return (
    <article className="scorecard-card">
      <p className="agent-title">
        {scorecard.scorecard.id}
        <span className={`scorecard-outcome ${scorecard.passed ? 'passed' : 'failed'}`}>
          {scorecard.passed ? 'Passed' : 'Failed'}
        </span>
      </p>
      <p className="panel-copy">{scorecard.scorecard.summary}</p>
      <div
        aria-label={`Weighted average ${formatScore(scorecard.scorecard.weightedAverage)} out of 10`}
        aria-valuemax={10}
        aria-valuemin={0}
        aria-valuenow={scorecard.scorecard.weightedAverage}
        className="score-meter"
        role="meter"
      >
        <span className="score-meter-fill" style={{ width: `${scoreToPercent(scorecard.scorecard.weightedAverage)}%` }} />
      </div>
      <dl className="proof-meta-grid">
        <div>
          <dt>Weighted average</dt>
          <dd>{formatScore(scorecard.scorecard.weightedAverage)}</dd>
        </div>
        <div>
          <dt>Target</dt>
          <dd>{formatScore(scorecard.threshold)}</dd>
        </div>
        <div>
          <dt>Scope</dt>
          <dd>{scorecard.scorecard.scope}</dd>
        </div>
        <div>
          <dt>Source artifact</dt>
          <dd>{scorecard.artifact.id}</dd>
        </div>
      </dl>
      <div className="criterion-list">
        {scorecard.scorecard.criteria.map((criterion) => {
          const criterionScore = scoreByCriterionId.get(criterion.id);

          return (
            <article className="criterion-card" key={criterion.id}>
              <p className="timeline-title">
                {criterion.name}
                <span className="small-pill">{criterion.dimension}</span>
              </p>
              <p className="timeline-meta">
                Weight {formatScore(criterion.weight)} · Score{' '}
                {criterionScore === undefined ? 'missing' : criterionScore.score}
              </p>
              {criterionScore ? (
                <>
                  <p className="panel-copy">{criterionScore.notes}</p>
                  <div className="artifact-list" aria-label={`Evidence artifacts for ${criterion.id}`}>
                    {criterionScore.evidenceArtifactIds.map((artifactId) => (
                      <span className="small-pill" key={artifactId}>
                        {artifactId}
                      </span>
                    ))}
                  </div>
                </>
              ) : null}
            </article>
          );
        })}
      </div>
    </article>
  );
}

function EvidenceGroupList({
  checkpointMap,
  groups,
}: {
  checkpointMap: Map<string, IssueCheckpoint[]>;
  groups: EvidenceGroup[];
}) {
  if (groups.length === 0) {
    return (
      <section className="proof-section" aria-labelledby="evidence-groups-title">
        <h3 className="section-title" id="evidence-groups-title">
          Evidence artifacts
        </h3>
        <p className="panel-copy">No evidence artifacts are attached to this issue yet.</p>
      </section>
    );
  }

  return (
    <section className="proof-section" aria-labelledby="evidence-groups-title">
      <h3 className="section-title" id="evidence-groups-title">
        Evidence artifacts
      </h3>
      <div className="stack">
        {groups.map((group) => (
          <article className="evidence-group" key={group.kind}>
            <div className="evidence-group-header">
              <p className="timeline-title">{group.kind}</p>
              <span className="small-pill">{group.artifacts.length} artifact(s)</span>
            </div>
            <div className="proof-card-grid">
              {group.artifacts.map((artifact) => (
                <ArtifactProofCard
                  artifact={artifact}
                  checkpoints={checkpointMap.get(artifact.id) ?? []}
                  key={artifact.id}
                />
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function ArtifactProofCard({
  artifact,
  checkpoints,
}: {
  artifact: IssueArtifact;
  checkpoints: IssueCheckpoint[];
}) {
  return (
    <article className="evidence-card evidence-detail-card">
      <p className="agent-title">
        {artifact.id}
        <span className="small-pill">{artifact.kind}</span>
      </p>
      <p className="timeline-meta">{artifact.path}</p>
      <dl className="proof-meta-grid">
        <div>
          <dt>Issue scope</dt>
          <dd>{artifact.issueId ?? 'global'}</dd>
        </div>
        <div>
          <dt>Campaign</dt>
          <dd>{artifact.campaignId ?? 'none'}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{formatDate(artifact.createdAt)}</dd>
        </div>
      </dl>
      {artifact.metadataError ? (
        <p className="issue-blocker">Metadata warning: {artifact.metadataError}</p>
      ) : null}
      <CheckpointProvenance artifactId={artifact.id} checkpoints={checkpoints} />
      <ArtifactRawMetadata artifact={artifact} />
    </article>
  );
}

function CheckpointProvenance({
  artifactId,
  checkpoints,
}: {
  artifactId: string;
  checkpoints: IssueCheckpoint[];
}) {
  return (
    <div className="provenance-list" aria-label={`Checkpoint provenance for ${artifactId}`}>
      <p className="timeline-title">Checkpoint provenance</p>
      {checkpoints.length === 0 ? (
        <p className="panel-copy">No checkpoint references this artifact.</p>
      ) : (
        <ol className="provenance-timeline">
          {checkpoints.map((checkpoint) => (
            <li className="timeline-item provenance-step" key={checkpoint.id}>
              <p className="timeline-title">
                {checkpoint.title}
                <span className="status-pill">{checkpoint.taskStatus}</span>
              </p>
              <p className="timeline-meta">
                {checkpoint.id} · Run {checkpoint.runId} · {formatDate(checkpoint.createdAt)}
              </p>
              <p className="panel-copy">{checkpoint.summary}</p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function ArtifactRawMetadata({ artifact }: { artifact: IssueArtifact }) {
  return (
    <details className="proof-detail-summary">
      <summary>Raw metadata - collapsed by default for safe inspection</summary>
      <p className="metadata-safety-copy">
        Inspect raw JSON only when provenance or parser diagnostics require it.
      </p>
      <pre className="timeline-payload">{formatMetadata(artifact.metadata)}</pre>
    </details>
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
              <details className="proof-detail-summary timeline-event-payload">
                <summary>Raw event payload</summary>
                <pre className="timeline-payload">{JSON.stringify(event.payload, null, 2)}</pre>
              </details>
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

function groupArtifactsByKind(artifacts: IssueArtifact[]): EvidenceGroup[] {
  const groups = new Map<string, IssueArtifact[]>();

  for (const artifact of artifacts) {
    const group = groups.get(artifact.kind) ?? [];
    group.push(artifact);
    groups.set(artifact.kind, group);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, groupArtifacts]) => ({
      kind,
      artifacts: groupArtifacts,
    }));
}

function buildArtifactCheckpointMap(
  checkpoints: IssueCheckpoint[],
): Map<string, IssueCheckpoint[]> {
  const checkpointMap = new Map<string, IssueCheckpoint[]>();

  for (const checkpoint of checkpoints) {
    for (const artifactId of checkpoint.artifactIds) {
      const artifactCheckpoints = checkpointMap.get(artifactId) ?? [];
      artifactCheckpoints.push(checkpoint);
      checkpointMap.set(artifactId, artifactCheckpoints);
    }
  }

  return checkpointMap;
}

function buildProofReviewModel(detail: DashboardIssueDetail): ProofReviewModel {
  const checkpointMap = buildArtifactCheckpointMap(detail.checkpoints);
  const referencedArtifactIds = new Set(
    detail.checkpoints.flatMap((checkpoint) => checkpoint.artifactIds),
  );

  return {
    evidenceGroups: groupArtifactsByKind(detail.artifacts),
    checkpointMap,
    csqrScorecards: extractCsqrScorecards(detail.artifacts),
    metadataWarningCount: detail.artifacts.filter((artifact) => artifact.metadataError !== undefined).length,
    provenanceCoveredArtifactCount: detail.artifacts.filter((artifact) => referencedArtifactIds.has(artifact.id)).length,
    latestCheckpoint: selectLatestCheckpoint(detail.checkpoints),
  };
}

function selectLatestCheckpoint(checkpoints: IssueCheckpoint[]): IssueCheckpoint | null {
  return checkpoints.reduce<IssueCheckpoint | null>((latest, checkpoint) => {
    if (latest === null || checkpoint.createdAt > latest.createdAt) {
      return checkpoint;
    }

    return latest;
  }, null);
}

function extractCsqrScorecards(artifacts: IssueArtifact[]): CsqrScorecardProof[] {
  return artifacts
    .filter((artifact) => artifact.kind === 'csqr_lite_scorecard')
    .map(parseCsqrScorecardArtifact);
}

function parseCsqrScorecardArtifact(artifact: IssueArtifact): CsqrScorecardProof {
  if (artifact.metadataError !== undefined) {
    return {
      kind: 'invalid',
      artifact,
      error: artifact.metadataError,
    };
  }

  if (!isRecord(artifact.metadata)) {
    return {
      kind: 'invalid',
      artifact,
      error: 'CSQR-lite artifact metadata must be a JSON object.',
    };
  }

  const scorecardJson = artifact.metadata['scorecardJson'];

  if (typeof scorecardJson !== 'string') {
    return {
      kind: 'invalid',
      artifact,
      error: 'CSQR-lite artifact metadata is missing scorecardJson.',
    };
  }

  let parsedScorecard: unknown;

  try {
    parsedScorecard = JSON.parse(scorecardJson) as unknown;
  } catch (error) {
    return {
      kind: 'invalid',
      artifact,
      error: error instanceof Error ? error.message : 'scorecardJson is invalid JSON.',
    };
  }

  const scorecard = csqrLiteScorecardSchema.safeParse(parsedScorecard);

  if (!scorecard.success) {
    return {
      kind: 'invalid',
      artifact,
      error: scorecard.error.issues.map((issue) => issue.message).join('; '),
    };
  }

  const threshold = scorecard.data.targetScore ?? csqrLiteDefaultTargetScore;

  return {
    kind: 'valid',
    artifact,
    scorecard: scorecard.data,
    threshold,
    passed: scorecard.data.weightedAverage >= threshold,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatMetadata(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? 'null';
}

function formatScore(value: number): string {
  return Number.isInteger(value) ? value.toString() : value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

function scoreToPercent(value: number): number {
  return Math.max(0, Math.min(100, value * 10));
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
