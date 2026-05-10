import { openReadonlyHarnessDatabase, selectAll } from '../db/store.js';

export interface InspectOrchestrationInput {
  dbPath: string;
  projectId: string;
  campaignId?: string;
  issueId?: string;
  eventLimit?: number;
}

export interface OrchestrationIssueSummary {
  id: string;
  projectId: string;
  campaignId: string | null;
  task: string;
  priority: string;
  status: string;
  size: string;
  nextBestAction: string | null;
  blockedReason: string | null;
  createdAt: string;
  deadlineAt: string | null;
}

export interface OrchestrationLeaseSummary {
  id: string;
  issueId: string | null;
  agentId: string;
  status: string;
  acquiredAt: string;
  expiresAt: string;
  lastHeartbeatAt: string | null;
  releasedAt: string | null;
  expired: boolean;
}

export interface OrchestrationArtifactReferences {
  worktreeId?: string;
  worktreePath?: string;
  subagentId?: string;
  evidencePacketId?: string;
}

export interface OrchestrationArtifactSummary {
  id: string;
  kind: string;
  path: string;
  issueId: string | null;
  campaignId: string | null;
  createdAt: string;
  metadata: unknown;
  references: OrchestrationArtifactReferences;
}

export interface OrchestrationArtifactGroup {
  kind: string;
  count: number;
  artifacts: OrchestrationArtifactSummary[];
}

export interface OrchestrationEventSummary {
  id: string;
  issueId: string | null;
  runId: string;
  kind: string;
  payload: unknown;
  createdAt: string;
}

export type OrchestrationHealthFlag =
  | {
      kind: 'duplicate_active_worktree_artifact_path';
      severity: 'high';
      path: string;
      artifactIds: string[];
      message: string;
    }
  | {
      kind: 'done_issue_missing_evidence';
      severity: 'medium';
      issueId: string;
      message: string;
    }
  | {
      kind: 'expired_active_lease';
      severity: 'high';
      leaseId: string;
      issueId: string | null;
      expiresAt: string;
      message: string;
    };

export interface OrchestrationInspectorSummary {
  summaryVersion: 1;
  generatedAt: string;
  scope: {
    projectId: string;
    campaignId: string | null;
    issueId: string | null;
  };
  issues: {
    total: number;
    statusCounts: Record<string, number>;
    items: OrchestrationIssueSummary[];
  };
  leases: {
    activeCount: number;
    active: OrchestrationLeaseSummary[];
  };
  artifacts: {
    total: number;
    byKind: OrchestrationArtifactGroup[];
    references: {
      worktreeIds: string[];
      worktreePaths: string[];
      subagentIds: string[];
      evidencePacketIds: string[];
    };
  };
  events: {
    recentCount: number;
    recent: OrchestrationEventSummary[];
  };
  health: {
    status: 'healthy' | 'warning';
    flags: OrchestrationHealthFlag[];
  };
}

interface IssueRow {
  id: string;
  project_id: string;
  campaign_id: string | null;
  task: string;
  priority: string;
  status: string;
  size: string;
  next_best_action: string | null;
  blocked_reason: string | null;
  created_at: string;
  deadline_at: string | null;
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

interface ArtifactRow {
  id: string;
  kind: string;
  path: string;
  metadata_json: string;
  issue_id: string | null;
  campaign_id: string | null;
  created_at: string;
}

interface EventRow {
  id: string;
  issue_id: string | null;
  run_id: string;
  kind: string;
  payload: string;
  created_at: string;
}

interface CheckpointEvidenceRow {
  issue_id: string | null;
  artifact_ids_json: string;
}

export function inspectOrchestration(
  input: InspectOrchestrationInput,
): OrchestrationInspectorSummary {
  const database = openReadonlyHarnessDatabase({ dbPath: input.dbPath });
  const generatedAt = new Date().toISOString();
  const campaignFilter = input.campaignId ?? null;
  const issueFilter = input.issueId ?? null;

  try {
    const issues = selectAll<IssueRow>(
      database.connection,
      `SELECT id, project_id, campaign_id, task, priority, status, size,
              next_best_action, blocked_reason, created_at, deadline_at
       FROM issues
       WHERE project_id = ?
         AND (? IS NULL OR campaign_id = ?)
         AND (? IS NULL OR id = ?)
       ORDER BY created_at ASC, id ASC`,
      [input.projectId, campaignFilter, campaignFilter, issueFilter, issueFilter],
    );
    const activeLeases = selectAll<LeaseRow>(
      database.connection,
      `SELECT id, issue_id, agent_id, status, acquired_at, expires_at,
              last_heartbeat_at, released_at
       FROM leases
       WHERE project_id = ?
         AND (? IS NULL OR campaign_id = ?)
         AND (? IS NULL OR issue_id = ?)
         AND status = 'active'
         AND released_at IS NULL
       ORDER BY acquired_at DESC, id ASC`,
      [input.projectId, campaignFilter, campaignFilter, issueFilter, issueFilter],
    );
    const artifactRows = selectAll<ArtifactRow>(
      database.connection,
      `SELECT id, kind, path, metadata_json, issue_id, campaign_id, created_at
       FROM artifacts
       WHERE project_id = ?
         AND (? IS NULL OR campaign_id = ?)
         AND (? IS NULL OR issue_id = ?)
       ORDER BY created_at DESC, id ASC`,
      [input.projectId, campaignFilter, campaignFilter, issueFilter, issueFilter],
    );
    const checkpointRows = selectAll<CheckpointEvidenceRow>(
      database.connection,
      `SELECT c.issue_id, c.artifact_ids_json
       FROM checkpoints c
       JOIN issues i ON i.id = c.issue_id
       WHERE i.project_id = ?
         AND (? IS NULL OR i.campaign_id = ?)
         AND (? IS NULL OR c.issue_id = ?)
       ORDER BY c.created_at DESC`,
      [input.projectId, campaignFilter, campaignFilter, issueFilter, issueFilter],
    );
    const eventRows = selectAll<EventRow>(
      database.connection,
      `SELECT e.id, e.issue_id, e.run_id, e.kind, e.payload, e.created_at
       FROM events e
       JOIN runs r ON r.id = e.run_id
       LEFT JOIN issues i ON i.id = e.issue_id
       WHERE r.project_id = ?
         AND (? IS NULL OR COALESCE(i.campaign_id, r.campaign_id) = ?)
         AND (? IS NULL OR e.issue_id = ?)
       ORDER BY e.created_at DESC
       LIMIT ?`,
      [
        input.projectId,
        campaignFilter,
        campaignFilter,
        issueFilter,
        issueFilter,
        input.eventLimit ?? 25,
      ],
    );

    const artifacts = artifactRows.map(mapArtifactRow);
    const leases = activeLeases.map((lease) => mapLeaseRow(lease, generatedAt));
    const flags = buildHealthFlags(issues, leases, artifacts, checkpointRows);

    return {
      summaryVersion: 1,
      generatedAt,
      scope: {
        projectId: input.projectId,
        campaignId: campaignFilter,
        issueId: issueFilter,
      },
      issues: {
        total: issues.length,
        statusCounts: buildIssueStatusCounts(issues),
        items: issues.map(mapIssueRow),
      },
      leases: {
        activeCount: leases.length,
        active: leases,
      },
      artifacts: {
        total: artifacts.length,
        byKind: groupArtifactsByKind(artifacts),
        references: collectArtifactReferences(artifacts),
      },
      events: {
        recentCount: eventRows.length,
        recent: eventRows.map(mapEventRow),
      },
      health: {
        status: flags.length > 0 ? 'warning' : 'healthy',
        flags,
      },
    };
  } finally {
    database.close();
  }
}

function mapIssueRow(row: IssueRow): OrchestrationIssueSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    campaignId: row.campaign_id,
    task: row.task,
    priority: row.priority,
    status: row.status,
    size: row.size,
    nextBestAction: row.next_best_action,
    blockedReason: row.blocked_reason,
    createdAt: row.created_at,
    deadlineAt: row.deadline_at,
  };
}

function mapLeaseRow(
  row: LeaseRow,
  generatedAt: string,
): OrchestrationLeaseSummary {
  return {
    id: row.id,
    issueId: row.issue_id,
    agentId: row.agent_id,
    status: row.status,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    releasedAt: row.released_at,
    expired: row.expires_at <= generatedAt,
  };
}

function mapArtifactRow(row: ArtifactRow): OrchestrationArtifactSummary {
  const metadata = parseJson(row.metadata_json);
  const references = extractArtifactReferences(row, metadata);

  return {
    id: row.id,
    kind: row.kind,
    path: row.path,
    issueId: row.issue_id,
    campaignId: row.campaign_id,
    createdAt: row.created_at,
    metadata,
    references,
  };
}

function mapEventRow(row: EventRow): OrchestrationEventSummary {
  return {
    id: row.id,
    issueId: row.issue_id,
    runId: row.run_id,
    kind: row.kind,
    payload: parseJson(row.payload),
    createdAt: row.created_at,
  };
}

function buildIssueStatusCounts(rows: IssueRow[]): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const row of rows) {
    counts[row.status] = (counts[row.status] ?? 0) + 1;
  }

  return counts;
}

function groupArtifactsByKind(
  artifacts: OrchestrationArtifactSummary[],
): OrchestrationArtifactGroup[] {
  const groups = new Map<string, OrchestrationArtifactSummary[]>();

  for (const artifact of artifacts) {
    const group = groups.get(artifact.kind) ?? [];
    group.push(artifact);
    groups.set(artifact.kind, group);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, groupedArtifacts]) => ({
      kind,
      count: groupedArtifacts.length,
      artifacts: groupedArtifacts,
    }));
}

function collectArtifactReferences(
  artifacts: OrchestrationArtifactSummary[],
): OrchestrationInspectorSummary['artifacts']['references'] {
  const worktreeIds = new Set<string>();
  const worktreePaths = new Set<string>();
  const subagentIds = new Set<string>();
  const evidencePacketIds = new Set<string>();

  for (const artifact of artifacts) {
    addIfPresent(worktreeIds, artifact.references.worktreeId);
    addIfPresent(worktreePaths, artifact.references.worktreePath);
    addIfPresent(subagentIds, artifact.references.subagentId);
    addIfPresent(evidencePacketIds, artifact.references.evidencePacketId);
  }

  return {
    worktreeIds: sortedSet(worktreeIds),
    worktreePaths: sortedSet(worktreePaths),
    subagentIds: sortedSet(subagentIds),
    evidencePacketIds: sortedSet(evidencePacketIds),
  };
}

function buildHealthFlags(
  issues: IssueRow[],
  leases: OrchestrationLeaseSummary[],
  artifacts: OrchestrationArtifactSummary[],
  checkpointRows: CheckpointEvidenceRow[],
): OrchestrationHealthFlag[] {
  const flags: OrchestrationHealthFlag[] = [];

  for (const lease of leases.filter((candidate) => candidate.expired)) {
    flags.push({
      kind: 'expired_active_lease',
      severity: 'high',
      leaseId: lease.id,
      issueId: lease.issueId,
      expiresAt: lease.expiresAt,
      message: `Active lease ${lease.id} expired at ${lease.expiresAt}.`,
    });
  }

  for (const duplicate of findDuplicateActiveWorktreePaths(artifacts)) {
    flags.push({
      kind: 'duplicate_active_worktree_artifact_path',
      severity: 'high',
      path: duplicate.path,
      artifactIds: duplicate.artifactIds,
      message: `Multiple active worktree artifacts reference ${duplicate.path}.`,
    });
  }

  const evidenceIssueIds = collectEvidenceIssueIds(artifacts, checkpointRows);
  for (const issue of issues) {
    if (issue.status === 'done' && !evidenceIssueIds.has(issue.id)) {
      flags.push({
        kind: 'done_issue_missing_evidence',
        severity: 'medium',
        issueId: issue.id,
        message: `Done issue ${issue.id} has no registered evidence artifacts or checkpoint artifact references.`,
      });
    }
  }

  return flags;
}

function findDuplicateActiveWorktreePaths(
  artifacts: OrchestrationArtifactSummary[],
): Array<{ path: string; artifactIds: string[] }> {
  const worktreeArtifactsByPath = new Map<string, string[]>();

  for (const artifact of artifacts) {
    if (!isActiveWorktreeArtifact(artifact)) {
      continue;
    }

    const worktreePath = artifact.references.worktreePath ?? artifact.path;
    const artifactIds = worktreeArtifactsByPath.get(worktreePath) ?? [];
    artifactIds.push(artifact.id);
    worktreeArtifactsByPath.set(worktreePath, artifactIds);
  }

  return [...worktreeArtifactsByPath.entries()]
    .filter(([, artifactIds]) => artifactIds.length > 1)
    .map(([path, artifactIds]) => ({ path, artifactIds }));
}

function collectEvidenceIssueIds(
  artifacts: OrchestrationArtifactSummary[],
  checkpointRows: CheckpointEvidenceRow[],
): Set<string> {
  const issueIds = new Set<string>();

  for (const artifact of artifacts) {
    if (
      artifact.issueId !== null &&
      (isEvidenceArtifact(artifact) ||
        artifact.references.evidencePacketId !== undefined)
    ) {
      issueIds.add(artifact.issueId);
    }
  }

  for (const checkpoint of checkpointRows) {
    if (
      checkpoint.issue_id !== null &&
      parseStringArray(checkpoint.artifact_ids_json).length > 0
    ) {
      issueIds.add(checkpoint.issue_id);
    }
  }

  return issueIds;
}

function isActiveWorktreeArtifact(artifact: OrchestrationArtifactSummary): boolean {
  if (!isWorktreeArtifact(artifact)) {
    return false;
  }

  const status = readMetadataString(artifact.metadata, [
    'status',
    'state',
    'lifecycle',
  ])?.toLowerCase();

  return !['archived', 'closed', 'done', 'inactive', 'released'].includes(status ?? '');
}

function isWorktreeArtifact(artifact: OrchestrationArtifactSummary): boolean {
  return (
    artifact.kind.toLowerCase().includes('worktree') ||
    artifact.references.worktreeId !== undefined ||
    artifact.references.worktreePath !== undefined
  );
}

function isEvidenceArtifact(artifact: OrchestrationArtifactSummary): boolean {
  return artifact.kind.toLowerCase().includes('evidence');
}

function extractArtifactReferences(
  row: ArtifactRow,
  metadata: unknown,
): OrchestrationArtifactReferences {
  const worktreePath = readMetadataString(metadata, [
    'worktreePath',
    'worktree_path',
    'worktree',
  ]);

  return {
    worktreeId: readMetadataString(metadata, ['worktreeId', 'worktree_id']),
    worktreePath:
      worktreePath ??
      (row.kind.toLowerCase().includes('worktree') ? row.path : undefined),
    subagentId: readMetadataString(metadata, [
      'subagentId',
      'subagent_id',
      'subAgentId',
    ]),
    evidencePacketId: readMetadataString(metadata, [
      'evidencePacketId',
      'evidence_packet_id',
      'evidenceId',
      'evidence_id',
      'packetId',
      'packet_id',
    ]),
  };
}

function readMetadataString(
  metadata: unknown,
  keys: string[],
): string | undefined {
  if (!isRecord(metadata)) {
    return undefined;
  }

  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }

  return undefined;
}

function parseStringArray(json: string): string[] {
  const parsed = parseJson(json);

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.filter((value): value is string => typeof value === 'string');
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function addIfPresent(values: Set<string>, value: string | undefined): void {
  if (value !== undefined) {
    values.add(value);
  }
}

function sortedSet(values: Set<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}
