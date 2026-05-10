import type { DatabaseSync } from 'node:sqlite';

import { runStatement, selectOne } from './store.js';

export interface ActiveSessionRecord {
  token: string;
  runId: string;
  workspaceId: string;
  projectId: string;
  campaignId?: string;
  issueId: string;
  leaseId: string;
  status: 'active' | 'closed';
  contextJson: string;
  beginInputJson: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

interface RawActiveSessionRow {
  token: string;
  run_id: string;
  workspace_id: string;
  project_id: string;
  campaign_id: string | null;
  issue_id: string;
  lease_id: string;
  status: 'active' | 'closed';
  context_json: string;
  begin_input_json: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface InsertActiveSessionInput {
  token: string;
  runId: string;
  workspaceId: string;
  projectId: string;
  campaignId?: string;
  issueId: string;
  leaseId: string;
  contextJson: string;
  beginInputJson: string;
  createdAt: string;
}

export function insertActiveSession(
  connection: DatabaseSync,
  input: InsertActiveSessionInput,
): ActiveSessionRecord {
  runStatement(
    connection,
    `INSERT INTO active_sessions (
       token,
       run_id,
       workspace_id,
       project_id,
       campaign_id,
       issue_id,
       lease_id,
       status,
       context_json,
       begin_input_json,
       created_at,
       updated_at,
       closed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, NULL)
      ON CONFLICT(run_id) DO UPDATE SET
        token = excluded.token,
        workspace_id = excluded.workspace_id,
        project_id = excluded.project_id,
        campaign_id = excluded.campaign_id,
        issue_id = excluded.issue_id,
        lease_id = excluded.lease_id,
        status = 'active',
        context_json = excluded.context_json,
        begin_input_json = excluded.begin_input_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        closed_at = NULL`,
    [
      input.token,
      input.runId,
      input.workspaceId,
      input.projectId,
      input.campaignId ?? null,
      input.issueId,
      input.leaseId,
      input.contextJson,
      input.beginInputJson,
      input.createdAt,
      input.createdAt,
    ],
  );

  return {
    token: input.token,
    runId: input.runId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    campaignId: input.campaignId,
    issueId: input.issueId,
    leaseId: input.leaseId,
    status: 'active',
    contextJson: input.contextJson,
    beginInputJson: input.beginInputJson,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export function loadActiveSession(
  connection: DatabaseSync,
  token: string,
): ActiveSessionRecord | null {
  const row = selectOne<RawActiveSessionRow>(
    connection,
    `SELECT
       token,
       run_id,
       workspace_id,
       project_id,
       campaign_id,
       issue_id,
       lease_id,
       status,
       context_json,
       begin_input_json,
       created_at,
       updated_at,
       closed_at
     FROM active_sessions
     WHERE token = ?
       AND status = 'active'
       AND closed_at IS NULL
     LIMIT 1`,
    [token],
  );

  return row === null ? null : mapActiveSessionRow(row);
}

export function loadActiveSessionByRunId(
  connection: DatabaseSync,
  runId: string,
): ActiveSessionRecord | null {
  const row = selectOne<RawActiveSessionRow>(
    connection,
    `SELECT
       token,
       run_id,
       workspace_id,
       project_id,
       campaign_id,
       issue_id,
       lease_id,
       status,
       context_json,
       begin_input_json,
       created_at,
       updated_at,
       closed_at
     FROM active_sessions
     WHERE run_id = ?
       AND status = 'active'
       AND closed_at IS NULL
     LIMIT 1`,
    [runId],
  );

  return row === null ? null : mapActiveSessionRow(row);
}

export function updateActiveSessionContext(
  connection: DatabaseSync,
  token: string,
  contextJson: string,
  updatedAt: string,
): void {
  runStatement(
    connection,
    `UPDATE active_sessions
     SET context_json = ?, updated_at = ?
     WHERE token = ?
       AND status = 'active'
       AND closed_at IS NULL`,
    [contextJson, updatedAt, token],
  );
}

export function closeActiveSession(
  connection: DatabaseSync,
  token: string,
  closedAt: string,
): void {
  runStatement(
    connection,
    `UPDATE active_sessions
     SET status = 'closed',
         updated_at = ?,
         closed_at = ?
     WHERE token = ?
       AND status = 'active'
       AND closed_at IS NULL`,
    [closedAt, closedAt, token],
  );
}

function mapActiveSessionRow(row: RawActiveSessionRow): ActiveSessionRecord {
  return {
    token: row.token,
    runId: row.run_id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    campaignId: row.campaign_id ?? undefined,
    issueId: row.issue_id,
    leaseId: row.lease_id,
    status: row.status,
    contextJson: row.context_json,
    beginInputJson: row.begin_input_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at ?? undefined,
  };
}
