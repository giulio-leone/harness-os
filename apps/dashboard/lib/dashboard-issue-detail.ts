import {
  loadOrchestrationDashboardViewModel,
  type OrchestrationDashboardIssueCard,
  type OrchestrationDashboardTimelineItem,
  type OrchestrationDashboardViewModel,
} from 'harness-os/orchestration';
import { openReadonlyHarnessDatabase, selectAll } from 'harness-os/dashboard-server';

import {
  getDashboardPageState,
  normalizeDashboardString,
  readDashboardEnvironment,
  type DashboardEnvironment,
  type DashboardPageState,
  type DashboardViewModelLoader,
} from './dashboard-data';

export interface DashboardIssueArtifact {
  id: string;
  kind: string;
  path: string;
  issueId: string | null;
  campaignId: string | null;
  metadata: unknown;
  createdAt: string;
}

export interface DashboardIssueCheckpoint {
  id: string;
  runId: string;
  issueId: string | null;
  title: string;
  summary: string;
  taskStatus: string;
  nextStep: string;
  artifactIds: string[];
  createdAt: string;
}

export interface DashboardIssueLease {
  id: string;
  issueId: string | null;
  agentId: string;
  status: string;
  acquiredAt: string;
  expiresAt: string;
  lastHeartbeatAt: string | null;
  releasedAt: string | null;
}

export interface DashboardIssueDetail {
  card: OrchestrationDashboardIssueCard;
  artifacts: DashboardIssueArtifact[];
  checkpoints: DashboardIssueCheckpoint[];
  leases: DashboardIssueLease[];
  timeline: OrchestrationDashboardTimelineItem[];
}

export type DashboardIssueDetailPageState =
  | {
      kind: 'ready';
      mode: 'live' | 'demo';
      viewModel: OrchestrationDashboardViewModel;
      detail: DashboardIssueDetail;
    }
  | Extract<DashboardPageState, { kind: 'not_configured' }>
  | {
      kind: 'not_found';
      issueId: string;
      message: string;
    };

interface ArtifactRow {
  id: string;
  kind: string;
  path: string;
  issue_id: string | null;
  campaign_id: string | null;
  metadata_json: string;
  created_at: string;
}

interface CheckpointRow {
  id: string;
  run_id: string;
  issue_id: string | null;
  title: string;
  summary: string;
  task_status: string;
  next_step: string;
  artifact_ids_json: string;
  created_at: string;
}

interface LeaseRow {
  id: string;
  issue_id: string | null;
  agent_id: string;
  status: string;
  acquired_at: string;
  expires_at: string;
  last_heartbeat_at: string | null;
  released_at: string | null;
}

export function getDashboardIssueDetailPageState(
  issueId: string,
  env: DashboardEnvironment = readDashboardEnvironment(),
  loader: DashboardViewModelLoader = loadOrchestrationDashboardViewModel,
): DashboardIssueDetailPageState {
  const normalizedIssueId = requireIssueId(issueId);
  const scopedState = getDashboardPageState(
    {
      ...env,
      HARNESS_DASHBOARD_ISSUE_ID: normalizedIssueId,
    },
    loader,
  );

  if (scopedState.kind === 'not_configured') {
    return scopedState;
  }

  const card = findIssueCard(scopedState.viewModel, normalizedIssueId);

  if (card === undefined) {
    return {
      kind: 'not_found',
      issueId: normalizedIssueId,
      message: `Issue "${normalizedIssueId}" was not found in the configured dashboard scope.`,
    };
  }

  return {
    kind: 'ready',
    mode: scopedState.mode,
    viewModel: scopedState.viewModel,
    detail:
      scopedState.mode === 'live'
        ? loadLiveIssueDetail(card, scopedState.viewModel, env)
        : buildDemoIssueDetail(card, scopedState.viewModel),
  };
}

function findIssueCard(
  viewModel: OrchestrationDashboardViewModel,
  issueId: string,
): OrchestrationDashboardIssueCard | undefined {
  for (const lane of viewModel.issueLanes) {
    const card = lane.cards.find((candidate) => candidate.id === issueId);

    if (card !== undefined) {
      return card;
    }
  }

  return undefined;
}

function loadLiveIssueDetail(
  card: OrchestrationDashboardIssueCard,
  viewModel: OrchestrationDashboardViewModel,
  env: DashboardEnvironment,
): DashboardIssueDetail {
  const dbPath = requireEnvironment(env.HARNESS_DASHBOARD_DB_PATH, 'HARNESS_DASHBOARD_DB_PATH');
  const projectId = requireEnvironment(
    env.HARNESS_DASHBOARD_PROJECT_ID,
    'HARNESS_DASHBOARD_PROJECT_ID',
  );
  const campaignId = normalizeDashboardString(env.HARNESS_DASHBOARD_CAMPAIGN_ID);
  const database = openReadonlyHarnessDatabase({ dbPath });

  try {
    const checkpoints = selectAll<CheckpointRow>(
      database.connection,
      `SELECT c.id,
              c.run_id,
              c.issue_id,
              c.title,
              c.summary,
              c.task_status,
              c.next_step,
              c.artifact_ids_json,
              c.created_at
       FROM checkpoints c
       JOIN issues i ON i.id = c.issue_id
       WHERE i.project_id = ?
         AND c.issue_id = ?
         AND (? IS NULL OR i.campaign_id = ?)
       ORDER BY c.created_at DESC, c.id ASC`,
      [projectId, card.id, campaignId ?? null, campaignId ?? null],
    );
    const checkpointArtifactIds = collectCheckpointArtifactIds(checkpoints);
    const checkpointArtifactPlaceholders = checkpointArtifactIds
      .map(() => '?')
      .join(', ');
    const artifacts = selectAll<ArtifactRow>(
      database.connection,
      `SELECT id, kind, path, issue_id, campaign_id, metadata_json, created_at
       FROM artifacts
       WHERE project_id = ?
         AND (? IS NULL OR campaign_id = ?)
         AND (
           issue_id = ?
           ${
             checkpointArtifactIds.length > 0
               ? `OR (issue_id IS NULL AND id IN (${checkpointArtifactPlaceholders}))`
               : ''
           }
         )
       ORDER BY created_at DESC, id ASC`,
      [
        projectId,
        campaignId ?? null,
        campaignId ?? null,
        card.id,
        ...checkpointArtifactIds,
      ],
    );
    const leases = selectAll<LeaseRow>(
      database.connection,
      `SELECT id,
              issue_id,
              agent_id,
              status,
              acquired_at,
              expires_at,
              last_heartbeat_at,
              released_at
       FROM leases
       WHERE project_id = ?
         AND issue_id = ?
         AND (? IS NULL OR campaign_id = ?)
       ORDER BY acquired_at DESC, id ASC`,
      [projectId, card.id, campaignId ?? null, campaignId ?? null],
    );

    return {
      card,
      artifacts: dedupeArtifacts(artifacts.map(mapArtifact)),
      checkpoints: checkpoints.map(mapCheckpoint),
      leases: leases.map(mapLease),
      timeline: viewModel.recentTimeline,
    };
  } finally {
    database.close();
  }
}

function collectCheckpointArtifactIds(checkpoints: CheckpointRow[]): string[] {
  return [
    ...new Set(
      checkpoints.flatMap((checkpoint) =>
        parseStringArray(checkpoint.artifact_ids_json),
      ),
    ),
  ];
}

function dedupeArtifacts(artifacts: DashboardIssueArtifact[]): DashboardIssueArtifact[] {
  const seen = new Set<string>();
  const uniqueArtifacts: DashboardIssueArtifact[] = [];

  for (const artifact of artifacts) {
    if (seen.has(artifact.id)) {
      continue;
    }

    seen.add(artifact.id);
    uniqueArtifacts.push(artifact);
  }

  return uniqueArtifacts;
}

function buildDemoIssueDetail(
  card: OrchestrationDashboardIssueCard,
  viewModel: OrchestrationDashboardViewModel,
): DashboardIssueDetail {
  return {
    card,
    artifacts: card.artifactIds.map((artifactId) => ({
      id: artifactId,
      kind: 'demo_artifact',
      path: `demo://${artifactId}`,
      issueId: card.id,
      campaignId: card.campaignId,
      metadata: {
        source: 'demo',
      },
      createdAt: card.createdAt,
    })),
    checkpoints: [],
    leases: card.activeLeases.map((lease) => ({
      id: lease.leaseId,
      issueId: lease.issueId,
      agentId: lease.agentId,
      status: lease.status,
      acquiredAt: lease.acquiredAt,
      expiresAt: lease.expiresAt,
      lastHeartbeatAt: lease.lastHeartbeatAt,
      releasedAt: lease.releasedAt,
    })),
    timeline: viewModel.recentTimeline.filter((event) => event.issueId === card.id),
  };
}

function mapArtifact(row: ArtifactRow): DashboardIssueArtifact {
  return {
    id: row.id,
    kind: row.kind,
    path: row.path,
    issueId: row.issue_id,
    campaignId: row.campaign_id,
    metadata: JSON.parse(row.metadata_json) as unknown,
    createdAt: row.created_at,
  };
}

function mapCheckpoint(row: CheckpointRow): DashboardIssueCheckpoint {
  return {
    id: row.id,
    runId: row.run_id,
    issueId: row.issue_id,
    title: row.title,
    summary: row.summary,
    taskStatus: row.task_status,
    nextStep: row.next_step,
    artifactIds: parseStringArray(row.artifact_ids_json),
    createdAt: row.created_at,
  };
}

function parseStringArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;

  if (!Array.isArray(parsed)) {
    throw new Error('Expected checkpoint artifact_ids_json to contain an array.');
  }

  return parsed.filter((entry): entry is string => typeof entry === 'string');
}

function mapLease(row: LeaseRow): DashboardIssueLease {
  return {
    id: row.id,
    issueId: row.issue_id,
    agentId: row.agent_id,
    status: row.status,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    releasedAt: row.released_at,
  };
}

function requireIssueId(value: string): string {
  const normalized = normalizeDashboardString(value);

  if (normalized === undefined) {
    throw new Error('issueId is required.');
  }

  return normalized;
}

function requireEnvironment(value: string | undefined, name: string): string {
  const normalized = normalizeDashboardString(value);

  if (normalized === undefined) {
    throw new Error(`${name} is required for live issue details.`);
  }

  return normalized;
}
