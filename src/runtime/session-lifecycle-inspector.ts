import { openHarnessDatabase, selectAll, selectOne } from '../db/store.js';
import {
  buildIssuePolicySurface,
  sortIssuesForDispatch,
} from './policy-engine.js';
import { buildWorkItemMetadataSurface } from './work-item-metadata.js';

export interface InspectExportInput {
  dbPath: string;
  projectId: string;
  campaignId?: string;
  runLimit?: number;
  eventLimit?: number;
}

export interface InspectAuditInput {
  dbPath: string;
  issueId: string;
  eventLimit?: number;
}

export interface InspectHealthSnapshotInput {
  dbPath: string;
  projectId: string;
  campaignId?: string;
}

export interface InspectOverviewInput extends InspectExportInput {}
export interface InspectIssueInput extends InspectAuditInput {}
export interface InspectHealthInput extends InspectHealthSnapshotInput {}

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
  recipients_json: string | null;
  approvals_json: string | null;
  external_refs_json: string | null;
  policy_json: string | null;
  campaign_policy_json: string | null;
}

interface MilestoneRow {
  id: string;
  description: string;
  priority: string;
  status: string;
  deadline_at: string | null;
  recipients_json: string | null;
  approvals_json: string | null;
  external_refs_json: string | null;
  blocked_reason: string | null;
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

interface RunRow {
  id: string;
  session_type: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  host: string;
}

interface CheckpointRow {
  id: string;
  run_id: string;
  title: string;
  summary: string;
  created_at: string;
}

interface MemoryLinkRow {
  id: string;
  memory_kind: string;
  memory_ref: string;
  summary: string;
  created_at: string;
}

interface EventRow {
  id: string;
  issue_id: string | null;
  run_id: string | null;
  kind: string;
  payload: string;
  created_at: string;
}

interface PolicyStateSummary {
  escalated?: boolean;
  breaches?: Array<{ trigger?: string }>;
}

const SCOPED_ISSUE_SELECT = `
  SELECT
    i.id,
    i.project_id,
    i.campaign_id,
    i.task,
    i.priority,
    i.status,
    i.size,
    i.next_best_action,
    i.blocked_reason,
    i.created_at,
    i.deadline_at,
    i.recipients_json,
    i.approvals_json,
    i.external_refs_json,
    i.policy_json,
    c.policy_json AS campaign_policy_json
  FROM issues i
  LEFT JOIN campaigns c ON c.id = i.campaign_id
`;

export class SessionLifecycleInspector {
  inspectExport(input: InspectExportInput): Record<string, unknown> {
    const database = openHarnessDatabase({ dbPath: input.dbPath });
    const generatedAt = new Date().toISOString();

    try {
      const campaignFilter = input.campaignId ?? null;

      const readyIssues = selectAll<IssueRow>(
        database.connection,
        `${SCOPED_ISSUE_SELECT}
         WHERE i.project_id = ?
           AND (? IS NULL OR i.campaign_id = ?)
           AND i.status = 'ready'
         ORDER BY i.id ASC`,
        [input.projectId, campaignFilter, campaignFilter],
      );
      const recoveryIssues = selectAll<IssueRow>(
        database.connection,
        `${SCOPED_ISSUE_SELECT}
         WHERE i.project_id = ?
           AND (? IS NULL OR i.campaign_id = ?)
           AND i.status = 'needs_recovery'
         ORDER BY i.id ASC`,
        [input.projectId, campaignFilter, campaignFilter],
      );
      const blockedIssues = selectAll<IssueRow>(
        database.connection,
        `${SCOPED_ISSUE_SELECT}
         WHERE i.project_id = ?
           AND (? IS NULL OR i.campaign_id = ?)
           AND i.status IN ('pending', 'blocked')
           AND i.blocked_reason IS NOT NULL
         ORDER BY
           CASE i.priority
             WHEN 'critical' THEN 0
             WHEN 'high' THEN 1
             WHEN 'medium' THEN 2
             ELSE 3
           END,
           i.id ASC`,
        [input.projectId, campaignFilter, campaignFilter],
      );
      const allScopedIssues = selectAll<IssueRow>(
        database.connection,
        `${SCOPED_ISSUE_SELECT}
         WHERE i.project_id = ?
           AND (? IS NULL OR i.campaign_id = ?)
         ORDER BY i.created_at ASC, i.id ASC`,
        [input.projectId, campaignFilter, campaignFilter],
      );
      const blockedMilestones = selectAll<MilestoneRow>(
        database.connection,
         `SELECT
            id,
            description,
            priority,
            status,
            deadline_at,
            recipients_json,
            approvals_json,
            external_refs_json,
            blocked_reason
          FROM milestones
          WHERE project_id = ?
            AND status = 'blocked'
           AND blocked_reason IS NOT NULL
         ORDER BY
           CASE priority
             WHEN 'critical' THEN 0
             WHEN 'high' THEN 1
             WHEN 'medium' THEN 2
             ELSE 3
           END,
           id ASC`,
        [input.projectId],
      );
      const activeLeases = selectAll<LeaseRow>(
        database.connection,
        `SELECT id, issue_id, agent_id, status, acquired_at, expires_at, last_heartbeat_at, released_at
         FROM leases
         WHERE project_id = ?
           AND (? IS NULL OR campaign_id = ?)
           AND released_at IS NULL
         ORDER BY acquired_at DESC`,
        [input.projectId, campaignFilter, campaignFilter],
      );
      const recentRuns = selectAll<RunRow>(
        database.connection,
        `SELECT id, session_type, status, started_at, finished_at, host
         FROM runs
         WHERE project_id = ?
           AND (? IS NULL OR campaign_id = ?)
         ORDER BY started_at DESC
         LIMIT ?`,
        [
          input.projectId,
          campaignFilter,
          campaignFilter,
          input.runLimit ?? 10,
        ],
      );
      const queueCounts = selectAll<{ status: string; cnt: number }>(
        database.connection,
        `SELECT status, COUNT(*) AS cnt
         FROM issues
         WHERE project_id = ?
           AND (? IS NULL OR campaign_id = ?)
         GROUP BY status`,
        [input.projectId, campaignFilter, campaignFilter],
      );
      const latestCheckpoint = selectOne<{ created_at: string }>(
        database.connection,
        `SELECT c.created_at
         FROM checkpoints c
         JOIN issues i ON c.issue_id = i.id
         WHERE i.project_id = ?
           AND (? IS NULL OR i.campaign_id = ?)
         ORDER BY c.created_at DESC
         LIMIT 1`,
        [input.projectId, campaignFilter, campaignFilter],
      );
      const recentEvents = selectAll<EventRow>(
        database.connection,
        `SELECT e.id, e.issue_id, e.run_id, e.kind, e.payload, e.created_at
         FROM events e
         JOIN issues i ON i.id = e.issue_id
         WHERE i.project_id = ?
           AND (? IS NULL OR i.campaign_id = ?)
         ORDER BY e.created_at DESC
         LIMIT ?`,
        [input.projectId, campaignFilter, campaignFilter, input.eventLimit ?? 20],
      );

      const queueStatusCounts = buildStatusCountMap(queueCounts);
      const totalIssues = queueCounts.reduce((sum, row) => sum + row.cnt, 0);
      const policySummary = buildPolicySummary(allScopedIssues);

      return {
        exportVersion: 1,
        generatedAt,
        scope: {
          projectId: input.projectId,
          campaignId: input.campaignId ?? null,
        },
        queue: {
          statusCounts: {
            ...queueStatusCounts,
            total: totalIssues,
          },
          readyIssues: sortIssuesForDispatch(readyIssues).map(mapIssueRow),
          recoveryIssues: sortIssuesForDispatch(recoveryIssues).map(mapIssueRow),
          blockedIssues: blockedIssues.map(mapIssueRow),
          blockedMilestones: blockedMilestones.map(mapMilestoneRow),
        },
        leases: {
          activeCount: activeLeases.length,
          active: activeLeases.map(mapLeaseRow),
        },
        runs: {
          recentCount: recentRuns.length,
          recent: recentRuns.map(mapRunRow),
        },
        checkpoints: {
          lastCheckpointAt: latestCheckpoint?.created_at ?? null,
        },
        policy: policySummary,
        audit: {
          recentEventCount: recentEvents.length,
          recentEvents: recentEvents.map(mapEventRow),
        },
      };
    } finally {
      database.close();
    }
  }

  inspectAudit(input: InspectAuditInput): Record<string, unknown> {
    const database = openHarnessDatabase({ dbPath: input.dbPath });
    const generatedAt = new Date().toISOString();

    try {
      const issue = selectOne<IssueRow>(
        database.connection,
        `${SCOPED_ISSUE_SELECT}
         WHERE i.id = ?
         LIMIT 1`,
        [input.issueId],
      );

      if (issue === null) {
        throw new Error(`Issue ${input.issueId} does not exist`);
      }

      const leases = selectAll<LeaseRow>(
        database.connection,
        `SELECT id, issue_id, agent_id, status, acquired_at, expires_at, last_heartbeat_at, released_at
         FROM leases
         WHERE issue_id = ?
         ORDER BY acquired_at DESC`,
        [input.issueId],
      );
      const checkpoints = selectAll<CheckpointRow>(
        database.connection,
        `SELECT id, run_id, title, summary, created_at
         FROM checkpoints
         WHERE issue_id = ?
         ORDER BY created_at DESC`,
        [input.issueId],
      );
      const memoryLinks = selectAll<MemoryLinkRow>(
        database.connection,
        `SELECT id, memory_kind, memory_ref, summary, created_at
         FROM memory_links
         WHERE issue_id = ?
         ORDER BY created_at DESC`,
        [input.issueId],
      );
      const events = selectAll<EventRow>(
        database.connection,
        `SELECT id, issue_id, run_id, kind, payload, created_at
         FROM events
         WHERE issue_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
        [input.issueId, input.eventLimit ?? 50],
      );

      const mappedLeases = leases.map(mapLeaseRow);
      const mappedCheckpoints = checkpoints.map(mapCheckpointRow);
      const mappedMemoryLinks = memoryLinks.map(mapMemoryLinkRow);
      const mappedEvents = events.map(mapEventRow);
      const timeline = buildAuditTimeline(
        leases,
        checkpoints,
        memoryLinks,
        events,
      );

      return {
        auditVersion: 1,
        generatedAt,
        scope: {
          projectId: issue.project_id,
          campaignId: issue.campaign_id ?? null,
          issueId: input.issueId,
        },
        issue: mapIssueRow(issue),
        summary: {
          leaseCount: mappedLeases.length,
          checkpointCount: mappedCheckpoints.length,
          memoryLinkCount: mappedMemoryLinks.length,
          eventCount: mappedEvents.length,
          timelineEntryCount: timeline.length,
        },
        evidence: {
          leases: mappedLeases,
          checkpoints: mappedCheckpoints,
          memoryLinks: mappedMemoryLinks,
          events: mappedEvents,
        },
        timeline,
      };
    } finally {
      database.close();
    }
  }

  inspectHealthSnapshot(input: InspectHealthSnapshotInput): Record<string, unknown> {
    const database = openHarnessDatabase({ dbPath: input.dbPath });
    const generatedAt = new Date().toISOString();

    try {
      const campaignFilter = input.campaignId ?? null;

      const queueCounts = selectAll<{ status: string; cnt: number }>(
        database.connection,
        `SELECT status, COUNT(*) AS cnt
         FROM issues
         WHERE project_id = ?
           AND (? IS NULL OR campaign_id = ?)
         GROUP BY status`,
        [input.projectId, campaignFilter, campaignFilter],
      );
      const activeLeases = selectAll<LeaseRow>(
        database.connection,
        `SELECT id, issue_id, agent_id, status, acquired_at, expires_at, last_heartbeat_at, released_at
         FROM leases
         WHERE project_id = ?
           AND (? IS NULL OR campaign_id = ?)
           AND status = 'active'
           AND released_at IS NULL`,
        [input.projectId, campaignFilter, campaignFilter],
      );
      const latestCheckpoint = selectOne<{ created_at: string }>(
        database.connection,
        `SELECT c.created_at
         FROM checkpoints c
         JOIN issues i ON c.issue_id = i.id
         WHERE i.project_id = ?
           AND (? IS NULL OR i.campaign_id = ?)
         ORDER BY c.created_at DESC
         LIMIT 1`,
        [input.projectId, campaignFilter, campaignFilter],
      );
      const activeSessionCount = selectOne<{ cnt: number }>(
        database.connection,
        `SELECT COUNT(*) AS cnt
         FROM active_sessions
         WHERE project_id = ?
           AND (? IS NULL OR campaign_id = ?)
           AND status = 'active'`,
        [input.projectId, campaignFilter, campaignFilter],
      );
      const failedRunCount = selectOne<{ cnt: number }>(
        database.connection,
        `SELECT COUNT(*) AS cnt
         FROM runs
         WHERE project_id = ?
           AND (? IS NULL OR campaign_id = ?)
           AND status = 'failed'`,
        [input.projectId, campaignFilter, campaignFilter],
      );
      const latestEvent = selectOne<{ created_at: string }>(
        database.connection,
        `SELECT e.created_at
         FROM events e
         JOIN issues i ON i.id = e.issue_id
         WHERE i.project_id = ?
           AND (? IS NULL OR i.campaign_id = ?)
         ORDER BY e.created_at DESC
         LIMIT 1`,
        [input.projectId, campaignFilter, campaignFilter],
      );
      const allScopedIssues = selectAll<IssueRow>(
        database.connection,
        `${SCOPED_ISSUE_SELECT}
         WHERE i.project_id = ?
           AND (? IS NULL OR i.campaign_id = ?)
         ORDER BY i.created_at ASC, i.id ASC`,
        [input.projectId, campaignFilter, campaignFilter],
      );

      const staleLeases = activeLeases.filter((lease) => lease.expires_at <= generatedAt);
      const queueStatusCounts = buildStatusCountMap(queueCounts);
      const totalIssues = queueCounts.reduce((sum, row) => sum + row.cnt, 0);
      const policySummary = buildPolicySummary(allScopedIssues);
      const alerts: Array<Record<string, unknown>> = [];

      if (staleLeases.length > 0) {
        alerts.push({
          kind: 'stale_leases',
          severity: 'high',
          count: staleLeases.length,
          refIds: staleLeases.map((lease) => lease.id),
        });
      }

      if (policySummary['breachedIssues'] instanceof Array && policySummary['breachedIssues'].length > 0) {
        alerts.push({
          kind: 'policy_breaches',
          severity: 'medium',
          count: policySummary['breachedIssues'].length,
          refIds: policySummary['breachedIssues']
            .map((issue) =>
              typeof issue === 'object' && issue !== null && 'id' in issue
                ? issue['id']
                : undefined,
            )
            .filter((value): value is string => typeof value === 'string'),
        });
      }

      return {
        snapshotVersion: 1,
        generatedAt,
        scope: {
          projectId: input.projectId,
          campaignId: input.campaignId ?? null,
        },
        queue: {
          statusCounts: {
            ...queueStatusCounts,
            total: totalIssues,
          },
        },
        leases: {
          activeCount: activeLeases.length,
          activeLeaseIds: activeLeases.map((lease) => lease.id),
          staleCount: staleLeases.length,
          staleLeaseIds: staleLeases.map((lease) => lease.id),
        },
        checkpoints: {
          lastCheckpointAt: latestCheckpoint?.created_at ?? null,
        },
        sessions: {
          activeCount: activeSessionCount?.cnt ?? 0,
        },
        policy: {
          trackedIssues: policySummary['trackedIssues'],
          escalatedIssueCount:
            policySummary['escalatedIssues'] instanceof Array
              ? policySummary['escalatedIssues'].length
              : 0,
          breachedIssueCount:
            policySummary['breachedIssues'] instanceof Array
              ? policySummary['breachedIssues'].length
              : 0,
          breachCounts: policySummary['breachCounts'],
        },
        audit: {
          failedRunCount: failedRunCount?.cnt ?? 0,
          lastEventAt: latestEvent?.created_at ?? null,
        },
        alerts,
      };
    } finally {
      database.close();
    }
  }

  inspectOverview(input: InspectOverviewInput): Record<string, unknown> {
    return this.inspectExport(input);
  }

  inspectIssue(input: InspectIssueInput): Record<string, unknown> {
    return this.inspectAudit(input);
  }

  inspectHealth(input: InspectHealthInput): Record<string, unknown> {
    return this.inspectHealthSnapshot(input);
  }
}

function buildStatusCountMap(
  rows: Array<{ status: string; cnt: number }>,
): Record<string, number> {
  const queue: Record<string, number> = {};
  for (const row of rows) {
    queue[row.status] = row.cnt;
  }
  return queue;
}

function buildPolicySummary(rows: IssueRow[]): Record<string, unknown> {
  const breachCounts: Record<string, number> = {
    deadline_breached: 0,
    response_sla_breached: 0,
    resolve_sla_breached: 0,
  };
  const breachedIssues: Record<string, unknown>[] = [];
  const escalatedIssues: Record<string, unknown>[] = [];
  let trackedIssues = 0;

  for (const row of rows) {
    const mapped = mapIssueRow(row);
    const policy = mapped['policy'];
    const policyState = mapped['policyState'] as PolicyStateSummary | undefined;

    if (policy === undefined && policyState === undefined) {
      continue;
    }

    trackedIssues += 1;

    if (policyState?.escalated) {
      escalatedIssues.push(mapped);
    }

    if ((policyState?.breaches?.length ?? 0) > 0) {
      breachedIssues.push(mapped);
    }

    for (const breach of policyState?.breaches ?? []) {
      if (breach.trigger && breach.trigger in breachCounts) {
        breachCounts[breach.trigger] += 1;
      }
    }
  }

  return {
    trackedIssues,
    escalatedIssues,
    breachedIssues,
    breachCounts,
  };
}

function buildAuditTimeline(
  leases: LeaseRow[],
  checkpoints: CheckpointRow[],
  memoryLinks: MemoryLinkRow[],
  events: EventRow[],
): Record<string, unknown>[] {
  const timeline = [
    ...leases.flatMap((lease) => {
      const entries: Record<string, unknown>[] = [
        {
          at: lease.acquired_at,
          entryType: 'lease_acquired',
          lease: mapLeaseRow(lease),
        },
      ];

      if (lease.last_heartbeat_at) {
        entries.push({
          at: lease.last_heartbeat_at,
          entryType: 'lease_heartbeat',
          leaseId: lease.id,
          issueId: lease.issue_id ?? undefined,
          agentId: lease.agent_id,
        });
      }

      if (lease.released_at) {
        entries.push({
          at: lease.released_at,
          entryType: 'lease_released',
          leaseId: lease.id,
          issueId: lease.issue_id ?? undefined,
          agentId: lease.agent_id,
          status: lease.status,
        });
      }

      return entries;
    }),
    ...checkpoints.map((checkpoint) => ({
      at: checkpoint.created_at,
      entryType: 'checkpoint',
      checkpoint: mapCheckpointRow(checkpoint),
    })),
    ...memoryLinks.map((memoryLink) => ({
      at: memoryLink.created_at,
      entryType: 'memory_link',
      memoryLink: mapMemoryLinkRow(memoryLink),
    })),
    ...events.map((event) => ({
      at: event.created_at,
      entryType: 'event',
      event: mapEventRow(event),
    })),
  ];

  return timeline.sort((left, right) =>
    String(right['at']).localeCompare(String(left['at'])),
  );
}

function mapIssueRow(row: IssueRow): Record<string, unknown> {
  const policySurface = buildIssuePolicySurface(row);
  const workflowMetadata = buildWorkItemMetadataSurface(row);

  return {
    id: row.id,
    task: row.task,
    priority: row.priority,
    status: row.status,
    size: row.size,
    nextBestAction: row.next_best_action ?? undefined,
    blockedReason: row.blocked_reason ?? undefined,
    ...(workflowMetadata?.deadlineAt !== undefined
      ? { deadlineAt: workflowMetadata.deadlineAt }
      : {}),
    ...(workflowMetadata?.recipients !== undefined
      ? { recipients: workflowMetadata.recipients }
      : {}),
    ...(workflowMetadata?.approvals !== undefined
      ? { approvals: workflowMetadata.approvals }
      : {}),
    ...(workflowMetadata?.externalRefs !== undefined
      ? { externalRefs: workflowMetadata.externalRefs }
      : {}),
    ...(policySurface.policy !== undefined ? { policy: policySurface.policy } : {}),
    ...(policySurface.policyState !== undefined
      ? { policyState: policySurface.policyState }
      : {}),
  };
}

function mapMilestoneRow(row: MilestoneRow): Record<string, unknown> {
  const workflowMetadata = buildWorkItemMetadataSurface(row);

  return {
    id: row.id,
    description: row.description,
    priority: row.priority,
    status: row.status,
    blockedReason: row.blocked_reason ?? undefined,
    ...(workflowMetadata?.deadlineAt !== undefined
      ? { deadlineAt: workflowMetadata.deadlineAt }
      : {}),
    ...(workflowMetadata?.recipients !== undefined
      ? { recipients: workflowMetadata.recipients }
      : {}),
    ...(workflowMetadata?.approvals !== undefined
      ? { approvals: workflowMetadata.approvals }
      : {}),
    ...(workflowMetadata?.externalRefs !== undefined
      ? { externalRefs: workflowMetadata.externalRefs }
      : {}),
  };
}

function mapLeaseRow(row: LeaseRow): Record<string, unknown> {
  return {
    id: row.id,
    issueId: row.issue_id ?? undefined,
    agentId: row.agent_id,
    status: row.status,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    lastHeartbeatAt: row.last_heartbeat_at ?? undefined,
    releasedAt: row.released_at ?? undefined,
  };
}

function mapRunRow(row: RunRow): Record<string, unknown> {
  return {
    id: row.id,
    sessionType: row.session_type,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    host: row.host,
  };
}

function mapCheckpointRow(row: CheckpointRow): Record<string, unknown> {
  return {
    id: row.id,
    runId: row.run_id,
    title: row.title,
    summary: row.summary,
    createdAt: row.created_at,
  };
}

function mapMemoryLinkRow(row: MemoryLinkRow): Record<string, unknown> {
  return {
    id: row.id,
    memoryKind: row.memory_kind,
    memoryRef: row.memory_ref,
    summary: row.summary,
    createdAt: row.created_at,
  };
}

function mapEventRow(row: EventRow): Record<string, unknown> {
  return {
    id: row.id,
    issueId: row.issue_id ?? undefined,
    runId: row.run_id ?? undefined,
    kind: row.kind,
    payload: parsePayload(row.payload),
    createdAt: row.created_at,
  };
}

function parsePayload(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}
