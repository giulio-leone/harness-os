import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { runStatement, selectAll, selectOne } from './store.js';

export interface IssueRecord {
  id: string;
  projectId: string;
  campaignId?: string;
  milestoneId?: string;
  task: string;
  priority: string;
  status: string;
  size: string;
  dependsOn: string[];
  nextBestAction?: string;
}

export interface LeaseRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  campaignId?: string;
  issueId?: string;
  agentId: string;
  status: string;
  acquiredAt: string;
  expiresAt: string;
  releasedAt?: string;
}

export interface ClaimLeaseInput {
  workspaceId: string;
  projectId: string;
  campaignId?: string;
  preferredIssueId?: string;
  agentId: string;
  leaseTtlSeconds: number;
  now?: string;
}

export interface ReconcileProjectInput {
  projectId: string;
  campaignId?: string;
  checkpointFreshnessSeconds: number;
  now?: string;
}

export interface PromoteQueueInput {
  projectId: string;
  campaignId?: string;
}

export interface ClaimedLeaseResult {
  issue: IssueRecord;
  lease: LeaseRecord;
  resumed: boolean;
}

export interface ReconciliationBlocker {
  issueId: string;
  leaseId?: string;
  reason: 'lease_expired' | 'checkpoint_stale' | 'needs_recovery';
  summary: string;
  nextStep: string;
}

interface RawIssueRow {
  id: string;
  project_id: string;
  campaign_id: string | null;
  milestone_id: string | null;
  task: string;
  priority: string;
  status: string;
  size: string;
  depends_on: string;
  next_best_action: string | null;
}

interface RawLeaseRow {
  id: string;
  workspace_id: string;
  project_id: string;
  campaign_id: string | null;
  issue_id: string | null;
  agent_id: string;
  status: string;
  acquired_at: string;
  expires_at: string;
  released_at: string | null;
}

interface RawLeaseCheckpointRow extends RawLeaseRow {
  last_checkpoint_at: string | null;
}

export function reconcileProjectState(
  connection: DatabaseSync,
  input: ReconcileProjectInput,
): ReconciliationBlocker[] {
  const now = input.now ?? new Date().toISOString();
  const blockers = new Map<string, ReconciliationBlocker>();
  const freshnessThreshold = new Date(
    Date.parse(now) - input.checkpointFreshnessSeconds * 1000,
  ).toISOString();
  const activeLeases = selectAll<RawLeaseCheckpointRow>(
    connection,
    `SELECT
       l.id,
       l.workspace_id,
       l.project_id,
       l.campaign_id,
       l.issue_id,
       l.agent_id,
       l.status,
       l.acquired_at,
       l.expires_at,
       l.released_at,
       MAX(c.created_at) AS last_checkpoint_at
     FROM leases l
     LEFT JOIN checkpoints c ON c.issue_id = l.issue_id
     WHERE l.project_id = ?
       AND (? IS NULL OR l.campaign_id = ?)
       AND l.status = 'active'
       AND l.released_at IS NULL
     GROUP BY
       l.id,
       l.workspace_id,
       l.project_id,
       l.campaign_id,
       l.issue_id,
       l.agent_id,
       l.status,
       l.acquired_at,
       l.expires_at,
       l.released_at`,
    [input.projectId, input.campaignId ?? null, input.campaignId ?? null],
  );

  for (const leaseRow of activeLeases) {
    const issueId = normalizeNullable(leaseRow.issue_id);

    if (issueId === undefined) {
      continue;
    }

    if (leaseRow.expires_at <= now) {
      markLeaseNeedsRecovery(connection, leaseRow.id);
      updateIssueStatus(connection, issueId, 'needs_recovery');
      upsertBlocker(blockers, {
        issueId,
        leaseId: leaseRow.id,
        reason: 'lease_expired',
        summary: `Lease ${leaseRow.id} expired before the task was cleanly resumed.`,
        nextStep: 'Reconcile the stale lease, inspect the latest evidence, and reopen the task explicitly.',
      });
      continue;
    }

    if (
      leaseRow.last_checkpoint_at === null ||
      leaseRow.last_checkpoint_at <= freshnessThreshold
    ) {
      markLeaseNeedsRecovery(connection, leaseRow.id);
      updateIssueStatus(connection, issueId, 'needs_recovery');
      upsertBlocker(blockers, {
        issueId,
        leaseId: leaseRow.id,
        reason: 'checkpoint_stale',
        summary:
          leaseRow.last_checkpoint_at === null
            ? `Lease ${leaseRow.id} has no checkpoint evidence and must be recovered explicitly.`
            : `Lease ${leaseRow.id} is newer than its last checkpoint evidence and the checkpoint is stale.`,
        nextStep: 'Refresh the evidence trail before allowing new claims on this task.',
      });
    }
  }

  const flaggedIssues = selectAll<{ id: string }>(
    connection,
    `SELECT id
     FROM issues
     WHERE project_id = ?
       AND (? IS NULL OR campaign_id = ?)
       AND status = 'needs_recovery'`,
    [input.projectId, input.campaignId ?? null, input.campaignId ?? null],
  );

  for (const issue of flaggedIssues) {
    upsertBlocker(blockers, {
      issueId: issue.id,
      reason: 'needs_recovery',
      summary: `Issue ${issue.id} is already flagged as needs_recovery and blocks new claims.`,
      nextStep: 'Resolve or explicitly recover the flagged task before selecting new work.',
    });
  }

  return [...blockers.values()];
}

export function selectNextRecoveryIssue(
  connection: DatabaseSync,
  projectId: string,
  campaignId?: string,
): IssueRecord {
  const rows = selectAll<RawIssueRow>(
    connection,
    `SELECT
       id,
       project_id,
       campaign_id,
       milestone_id,
       task,
       priority,
       status,
       size,
       depends_on,
       next_best_action
     FROM issues
     WHERE project_id = ?
       AND (? IS NULL OR campaign_id = ?)
       AND status = 'needs_recovery'
     ORDER BY
       CASE priority
         WHEN 'critical' THEN 0
         WHEN 'high' THEN 1
         WHEN 'medium' THEN 2
         ELSE 3
       END,
       id ASC`,
    [projectId, campaignId ?? null, campaignId ?? null],
  );

  const issue = rows.map(mapIssueRow)[0];

  if (issue === undefined) {
    throw new Error(`No needs_recovery issues are available for project ${projectId}`);
  }

  return issue;
}

export function loadRecoveryIssue(
  connection: DatabaseSync,
  issueId: string,
  projectId?: string,
  campaignId?: string,
): IssueRecord {
  const issue = loadIssue(connection, issueId);

  if (projectId !== undefined && issue.projectId !== projectId) {
    throw new Error(
      `Issue ${issue.id} belongs to project ${issue.projectId}, not ${projectId}`,
    );
  }

  if (campaignId !== undefined && issue.campaignId !== campaignId) {
    throw new Error(
      `Issue ${issue.id} belongs to campaign ${issue.campaignId ?? 'none'}, not ${campaignId}`,
    );
  }

  if (issue.status !== 'needs_recovery') {
    throw new Error(
      `Issue ${issue.id} is not recoverable from status ${issue.status}; expected needs_recovery`,
    );
  }

  return issue;
}

export function findRecoverableLeasesForIssue(
  connection: DatabaseSync,
  issueId: string,
): LeaseRecord[] {
  const rows = selectAll<RawLeaseRow>(
    connection,
    `SELECT
       id,
       workspace_id,
       project_id,
       campaign_id,
       issue_id,
       agent_id,
       status,
       acquired_at,
       expires_at,
       released_at
     FROM leases
     WHERE issue_id = ?
       AND status IN ('active', 'needs_recovery')
       AND released_at IS NULL
     ORDER BY acquired_at ASC`,
    [issueId],
  );

  return rows.map(mapLeaseRow);
}

export function claimSpecificIssueLease(
  connection: DatabaseSync,
  input: {
    workspaceId: string;
    projectId: string;
    campaignId?: string;
    issueId: string;
    agentId: string;
    leaseTtlSeconds: number;
    now?: string;
  },
): LeaseRecord {
  const issue = loadIssue(connection, input.issueId);
  const acquiredAt = input.now ?? new Date().toISOString();
  const expiresAt = new Date(
    Date.parse(acquiredAt) + input.leaseTtlSeconds * 1000,
  ).toISOString();
  const leaseId = randomUUID();

  insertActiveLease(connection, {
    leaseId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    campaignId: input.campaignId ?? issue.campaignId,
    issueId: input.issueId,
    agentId: input.agentId,
    acquiredAt,
    expiresAt,
  });

  return {
    id: leaseId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    campaignId: input.campaignId ?? issue.campaignId,
    issueId: input.issueId,
    agentId: input.agentId,
    status: 'active',
    acquiredAt,
    expiresAt,
  };
}

export function markLeaseRecovered(
  connection: DatabaseSync,
  leaseId: string,
  recoveredAt = new Date().toISOString(),
): void {
  runStatement(
    connection,
    `UPDATE leases
     SET status = ?, released_at = ?
     WHERE id = ?`,
    ['recovered', recoveredAt, leaseId],
  );
}

export function claimOrResumeLease(
  connection: DatabaseSync,
  input: ClaimLeaseInput,
): ClaimedLeaseResult {
  const now = input.now ?? new Date().toISOString();
  const blockingStaleLeases = findBlockingStaleLeases(connection, input.projectId, now);

  if (blockingStaleLeases.length > 0) {
    const staleIssueIds = blockingStaleLeases
      .map((lease) => lease.issueId)
      .filter((issueId): issueId is string => issueId !== undefined);

    throw new Error(
      `Cannot claim new work while stale leases remain unresolved: ${staleIssueIds.join(
        ', ',
      )}`,
    );
  }

  const resumableLease =
    input.preferredIssueId !== undefined
      ? findActiveLeaseForIssue(
          connection,
          input.preferredIssueId,
          now,
          input.agentId,
        )
      : findActiveLeaseForAgent(connection, input.projectId, input.agentId, now, input.campaignId);

  if (resumableLease !== null) {
    const issue = loadIssue(connection, resumableLease.issueId);

    return {
      issue,
      lease: resumableLease,
      resumed: true,
    };
  }

  if (input.preferredIssueId === undefined) {
    promoteEligiblePendingIssues(connection, {
      projectId: input.projectId,
      campaignId: input.campaignId,
    });
  }

  const issue =
    input.preferredIssueId !== undefined
      ? loadClaimableIssue(connection, input.preferredIssueId, input.projectId, input.campaignId)
      : selectNextReadyIssue(connection, input.projectId, input.campaignId);

  const acquiredAt = now;
  const expiresAt = new Date(
    Date.parse(acquiredAt) + input.leaseTtlSeconds * 1000,
  ).toISOString();
  const leaseId = randomUUID();

  insertActiveLease(connection, {
    leaseId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    campaignId: input.campaignId ?? issue.campaignId,
    issueId: issue.id,
    agentId: input.agentId,
    acquiredAt,
    expiresAt,
  });

  return {
    issue,
    lease: {
      id: leaseId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      campaignId: input.campaignId ?? issue.campaignId,
      issueId: issue.id,
      agentId: input.agentId,
      status: 'active',
      acquiredAt,
      expiresAt,
    },
    resumed: false,
  };
}

export function releaseLease(
  connection: DatabaseSync,
  leaseId: string,
  releasedAt = new Date().toISOString(),
): void {
  runStatement(
    connection,
    `UPDATE leases
     SET status = ?, released_at = ?
     WHERE id = ?`,
    ['released', releasedAt, leaseId],
  );
}

export function loadIssue(
  connection: DatabaseSync,
  issueId: string | undefined,
): IssueRecord {
  if (issueId === undefined) {
    throw new Error('Cannot load an issue for a lease without issue_id');
  }

  const row = selectOne<RawIssueRow>(
    connection,
    `SELECT
       id,
       project_id,
       campaign_id,
       milestone_id,
       task,
       priority,
       status,
       size,
       depends_on,
       next_best_action
     FROM issues
     WHERE id = ?
     LIMIT 1`,
    [issueId],
  );

  if (row === null) {
    throw new Error(`Issue ${issueId} does not exist`);
  }

  return mapIssueRow(row);
}

export function updateIssueStatus(
  connection: DatabaseSync,
  issueId: string,
  status: string,
): void {
  runStatement(
    connection,
    `UPDATE issues
     SET status = ?
     WHERE id = ?`,
    [status, issueId],
  );
}

export function promoteEligiblePendingIssues(
  connection: DatabaseSync,
  input: PromoteQueueInput,
): IssueRecord[] {
  const rows = selectAll<RawIssueRow>(
    connection,
    `SELECT
       id,
       project_id,
       campaign_id,
       milestone_id,
       task,
       priority,
       status,
       size,
       depends_on,
       next_best_action
     FROM issues
     WHERE project_id = ?
       AND (? IS NULL OR campaign_id = ?)
       AND status = 'pending'
     ORDER BY
       CASE priority
         WHEN 'critical' THEN 0
         WHEN 'high' THEN 1
         WHEN 'medium' THEN 2
         ELSE 3
       END,
       id ASC`,
    [input.projectId, input.campaignId ?? null, input.campaignId ?? null],
  );
  const pendingIssues = rows.map(mapIssueRow);

  if (pendingIssues.length === 0) {
    return [];
  }

  const dependencyIds = [...new Set(pendingIssues.flatMap((issue) => issue.dependsOn))];
  const dependencyStatuses = new Map<string, string>();

  if (dependencyIds.length > 0) {
    const placeholders = dependencyIds.map(() => '?').join(', ');
    const dependencyRows = selectAll<{ id: string; status: string }>(
      connection,
      `SELECT id, status
       FROM issues
       WHERE id IN (${placeholders})`,
      dependencyIds,
    );

    for (const row of dependencyRows) {
      dependencyStatuses.set(row.id, row.status);
    }
  }

  const promoted: IssueRecord[] = [];

  for (const issue of pendingIssues) {
    const readyToPromote =
      issue.dependsOn.length === 0 ||
      issue.dependsOn.every((dependencyId) => dependencyStatuses.get(dependencyId) === 'done');

    if (!readyToPromote) {
      continue;
    }

    updateIssueStatus(connection, issue.id, 'ready');
    dependencyStatuses.set(issue.id, 'ready');
    promoted.push({
      ...issue,
      status: 'ready',
    });
  }

  return promoted;
}

function findBlockingStaleLeases(
  connection: DatabaseSync,
  projectId: string,
  now: string,
): LeaseRecord[] {
  const rows = selectAll<RawLeaseRow>(
    connection,
    `SELECT
       id,
       workspace_id,
       project_id,
       campaign_id,
       issue_id,
       agent_id,
       status,
       acquired_at,
       expires_at,
       released_at
     FROM leases
     WHERE project_id = ?
       AND status = 'active'
       AND released_at IS NULL
       AND expires_at <= ?`,
    [projectId, now],
  );

  return rows.map(mapLeaseRow);
}

function markLeaseNeedsRecovery(
  connection: DatabaseSync,
  leaseId: string,
): void {
  runStatement(
    connection,
    `UPDATE leases
     SET status = ?
     WHERE id = ?`,
    ['needs_recovery', leaseId],
  );
}

function findActiveLeaseForAgent(
  connection: DatabaseSync,
  projectId: string,
  agentId: string,
  now: string,
  campaignId?: string,
): LeaseRecord | null {
  const row = selectOne<RawLeaseRow>(
    connection,
    `SELECT
       id,
       workspace_id,
       project_id,
       campaign_id,
       issue_id,
       agent_id,
       status,
       acquired_at,
       expires_at,
       released_at
     FROM leases
     WHERE project_id = ?
       AND agent_id = ?
       AND (? IS NULL OR campaign_id = ?)
       AND status = 'active'
       AND released_at IS NULL
       AND expires_at > ?
     ORDER BY acquired_at DESC
     LIMIT 1`,
    [projectId, agentId, campaignId ?? null, campaignId ?? null, now],
  );

  return row === null ? null : mapLeaseRow(row);
}

function findActiveLeaseForIssue(
  connection: DatabaseSync,
  issueId: string,
  now: string,
  agentId?: string,
): LeaseRecord | null {
  const row = selectOne<RawLeaseRow>(
    connection,
    `SELECT
       id,
       workspace_id,
       project_id,
       campaign_id,
       issue_id,
       agent_id,
       status,
       acquired_at,
       expires_at,
       released_at
      FROM leases
      WHERE issue_id = ?
        AND (? IS NULL OR agent_id = ?)
        AND status = 'active'
        AND released_at IS NULL
        AND expires_at > ?
      ORDER BY acquired_at DESC
      LIMIT 1`,
    [issueId, agentId ?? null, agentId ?? null, now],
  );

  return row === null ? null : mapLeaseRow(row);
}

function loadClaimableIssue(
  connection: DatabaseSync,
  issueId: string,
  projectId?: string,
  campaignId?: string,
): IssueRecord {
  const issue = loadIssue(connection, issueId);

  if (projectId !== undefined && issue.projectId !== projectId) {
    throw new Error(
      `Issue ${issue.id} belongs to project ${issue.projectId}, not ${projectId}`,
    );
  }

  if (campaignId !== undefined && issue.campaignId !== campaignId) {
    throw new Error(
      `Issue ${issue.id} belongs to campaign ${issue.campaignId ?? 'none'}, not ${campaignId}`,
    );
  }

  if (issue.status !== 'ready' && issue.status !== 'pending') {
    throw new Error(
      `Issue ${issue.id} is not claimable from status ${issue.status}; expected ready or pending`,
    );
  }

  return issue;
}

function selectNextReadyIssue(
  connection: DatabaseSync,
  projectId: string,
  campaignId?: string,
): IssueRecord {
  const rows = selectAll<RawIssueRow>(
    connection,
    `SELECT
       id,
       project_id,
       campaign_id,
       milestone_id,
       task,
       priority,
       status,
       size,
       depends_on,
       next_best_action
     FROM issues
     WHERE project_id = ?
       AND status = 'ready'
       AND (? IS NULL OR campaign_id = ?)
     ORDER BY
       CASE priority
         WHEN 'critical' THEN 0
         WHEN 'high' THEN 1
         WHEN 'medium' THEN 2
         ELSE 3
       END,
       id ASC`,
    [projectId, campaignId ?? null, campaignId ?? null],
  );

  const issue = rows.map(mapIssueRow)[0];

  if (issue === undefined) {
    throw new Error(`No ready issues are available for project ${projectId}`);
  }

  return issue;
}

function mapIssueRow(row: RawIssueRow): IssueRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    campaignId: normalizeNullable(row.campaign_id),
    milestoneId: normalizeNullable(row.milestone_id),
    task: row.task,
    priority: row.priority,
    status: row.status,
    size: row.size,
    dependsOn: parseDependsOn(row.depends_on),
    nextBestAction: normalizeNullable(row.next_best_action),
  };
}

function mapLeaseRow(row: RawLeaseRow): LeaseRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    campaignId: normalizeNullable(row.campaign_id),
    issueId: normalizeNullable(row.issue_id),
    agentId: row.agent_id,
    status: row.status,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    releasedAt: normalizeNullable(row.released_at),
  };
}

function parseDependsOn(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((value): value is string => typeof value === 'string');
  } catch {
    return [];
  }
}

function normalizeNullable(value: string | null): string | undefined {
  return value ?? undefined;
}

function upsertBlocker(
  blockers: Map<string, ReconciliationBlocker>,
  blocker: ReconciliationBlocker,
): void {
  if (!blockers.has(blocker.issueId)) {
    blockers.set(blocker.issueId, blocker);
  }
}

function insertActiveLease(
  connection: DatabaseSync,
  input: {
    leaseId: string;
    workspaceId: string;
    projectId: string;
    campaignId?: string;
    issueId: string;
    agentId: string;
    acquiredAt: string;
    expiresAt: string;
  },
): void {
  try {
    runStatement(
      connection,
      `INSERT INTO leases (
         id,
         workspace_id,
         project_id,
         campaign_id,
         issue_id,
         agent_id,
         status,
         acquired_at,
         expires_at,
         released_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)`,
      [
        input.leaseId,
        input.workspaceId,
        input.projectId,
        input.campaignId ?? null,
        input.issueId,
        input.agentId,
        input.acquiredAt,
        input.expiresAt,
      ],
    );
  } catch (error) {
    if (isActiveLeaseConstraintError(error)) {
      throw new Error(`Issue ${input.issueId} already has an active lease`);
    }

    throw error;
  }
}

function isActiveLeaseConstraintError(error: unknown): boolean {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error['code'] === 'SQLITE_CONSTRAINT_UNIQUE'
  ) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('idx_leases_unique_active_issue') ||
    message.includes('UNIQUE constraint failed: leases.issue_id')
  );
}
