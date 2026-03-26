import { openHarnessDatabase, selectAll, selectOne } from '../db/store.js';

export interface InspectOverviewInput {
  dbPath: string;
  projectId: string;
  campaignId?: string;
  runLimit?: number;
}

export interface InspectIssueInput {
  dbPath: string;
  issueId: string;
  includeEvents?: boolean;
  eventLimit?: number;
}

export interface InspectHealthInput {
  dbPath: string;
  projectId: string;
  campaignId?: string;
}

interface IssueRow {
  id: string;
  task: string;
  priority: string;
  status: string;
  size: string;
  next_best_action: string | null;
}

interface LeaseRow {
  id: string;
  issue_id: string | null;
  agent_id: string;
  status: string;
  acquired_at: string;
  expires_at: string;
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
  kind: string;
  payload: string;
  created_at: string;
}

export class SessionLifecycleInspector {
  inspectOverview(input: InspectOverviewInput): Record<string, unknown> {
    const database = openHarnessDatabase({ dbPath: input.dbPath });

    try {
      const readyIssues = selectAll<IssueRow>(
        database.connection,
        `SELECT id, task, priority, status, size, next_best_action
         FROM issues
         WHERE project_id = ?
           AND (? IS NULL OR campaign_id = ?)
           AND status = 'ready'
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
      const recoveryIssues = selectAll<IssueRow>(
        database.connection,
        `SELECT id, task, priority, status, size, next_best_action
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
        [input.projectId, input.campaignId ?? null, input.campaignId ?? null],
      );
      const activeLeases = selectAll<LeaseRow>(
        database.connection,
        `SELECT id, issue_id, agent_id, status, acquired_at, expires_at, released_at
         FROM leases
         WHERE project_id = ?
           AND (? IS NULL OR campaign_id = ?)
           AND released_at IS NULL
         ORDER BY acquired_at DESC`,
        [input.projectId, input.campaignId ?? null, input.campaignId ?? null],
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
          input.campaignId ?? null,
          input.campaignId ?? null,
          input.runLimit ?? 10,
        ],
      );

      return {
        counts: {
          readyIssues: readyIssues.length,
          recoveryIssues: recoveryIssues.length,
          activeLeases: activeLeases.length,
          recentRuns: recentRuns.length,
        },
        readyIssues: readyIssues.map(mapIssueRow),
        recoveryIssues: recoveryIssues.map(mapIssueRow),
        activeLeases: activeLeases.map(mapLeaseRow),
        recentRuns: recentRuns.map(mapRunRow),
      };
    } finally {
      database.close();
    }
  }

  inspectIssue(input: InspectIssueInput): Record<string, unknown> {
    const database = openHarnessDatabase({ dbPath: input.dbPath });

    try {
      const issue = selectOne<IssueRow>(
        database.connection,
        `SELECT id, task, priority, status, size, next_best_action
         FROM issues
         WHERE id = ?
         LIMIT 1`,
        [input.issueId],
      );

      if (issue === null) {
        throw new Error(`Issue ${input.issueId} does not exist`);
      }

      const leases = selectAll<LeaseRow>(
        database.connection,
        `SELECT id, issue_id, agent_id, status, acquired_at, expires_at, released_at
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
      const events =
        input.includeEvents === false
          ? []
          : selectAll<EventRow>(
              database.connection,
              `SELECT id, kind, payload, created_at
               FROM events
               WHERE issue_id = ?
               ORDER BY created_at DESC
               LIMIT ?`,
              [input.issueId, input.eventLimit ?? 20],
            );

      return {
        issue: mapIssueRow(issue),
        leases: leases.map(mapLeaseRow),
        checkpoints: checkpoints.map(mapCheckpointRow),
        memoryLinks: memoryLinks.map(mapMemoryLinkRow),
        events: events.map(mapEventRow),
      };
    } finally {
      database.close();
    }
  }

  inspectHealth(input: InspectHealthInput): Record<string, unknown> {
    const database = openHarnessDatabase({ dbPath: input.dbPath });
    const now = new Date().toISOString();

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

      const activeLeasesResult = selectAll<{
        id: string;
        issue_id: string | null;
        agent_id: string;
        acquired_at: string;
        expires_at: string;
        last_heartbeat_at: string | null;
      }>(
        database.connection,
        `SELECT id, issue_id, agent_id, acquired_at, expires_at, last_heartbeat_at
         FROM leases
         WHERE project_id = ?
           AND (? IS NULL OR campaign_id = ?)
           AND status = 'active'
           AND released_at IS NULL`,
        [input.projectId, campaignFilter, campaignFilter],
      );

      const staleLeases = activeLeasesResult.filter(
        (l) => l.expires_at <= now,
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

      const queue: Record<string, number> = {};
      for (const row of queueCounts) {
        queue[row.status] = row.cnt;
      }
      const totalIssues = queueCounts.reduce((sum, r) => sum + r.cnt, 0);

      return {
        projectId: input.projectId,
        campaignId: input.campaignId ?? null,
        timestamp: now,
        queue: {
          ...queue,
          total: totalIssues,
        },
        leases: {
          active: activeLeasesResult.length,
          stale: staleLeases.length,
          staleLeaseIds: staleLeases.map((l) => l.id),
        },
        checkpoints: {
          lastCheckpointAt: latestCheckpoint?.created_at ?? null,
        },
        sessions: {
          active: activeSessionCount?.cnt ?? 0,
        },
      };
    } finally {
      database.close();
    }
  }
}

function mapIssueRow(row: IssueRow): Record<string, unknown> {
  return {
    id: row.id,
    task: row.task,
    priority: row.priority,
    status: row.status,
    size: row.size,
    nextBestAction: row.next_best_action ?? undefined,
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
