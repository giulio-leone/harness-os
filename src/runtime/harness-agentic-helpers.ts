import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import {
  closeActiveSession,
  insertActiveSession,
  loadActiveSession,
  updateActiveSessionContext,
} from '../db/active-session-store.js';
import {
  openHarnessDatabase,
  runInTransaction,
  selectAll,
  selectOne,
} from '../db/store.js';

interface IdRow {
  id: string;
  name?: string;
  workspace_id?: string;
}

export class SessionTokenStore {
  private readonly sessions = new Map<
    string,
    {
      dbPath: string;
      context: Record<string, unknown>;
      beginInput: Record<string, unknown>;
    }
  >();

  store(
    context: Record<string, unknown>,
    beginInput: Record<string, unknown>,
  ): string {
    const dbPath = resolveSessionDbPath(context, beginInput);
    const token = `ST-${randomUUID().slice(0, 12)}`;
    const now = new Date().toISOString();
    const database = openHarnessDatabase({ dbPath });

    try {
      runInTransaction(database.connection, () => {
        insertActiveSession(database.connection, {
          token,
          runId: extractStringField(context, 'runId'),
          workspaceId: extractStringField(context, 'workspaceId'),
          projectId: extractStringField(context, 'projectId'),
          campaignId: extractOptionalStringField(context, 'campaignId'),
          issueId: extractStringField(context, 'issueId'),
          leaseId: extractStringField(context, 'leaseId'),
          contextJson: JSON.stringify(context),
          beginInputJson: JSON.stringify(beginInput),
          createdAt: now,
        });
      });
    } finally {
      database.close();
    }

    this.sessions.set(token, { dbPath, context, beginInput });
    return token;
  }

  resolve(
    token: string,
    dbPathInput?: string,
  ): { context: Record<string, unknown>; beginInput: Record<string, unknown> } {
    const cached = this.sessions.get(token);

    if (cached) {
      return {
        context: cached.context,
        beginInput: cached.beginInput,
      };
    }

    const dbPath = resolveDbPath(dbPathInput);
    const database = openHarnessDatabase({ dbPath });

    try {
      const record = loadActiveSession(database.connection, token);

      if (record === null) {
        throw new AgenticToolError(
          `Session token "${token}" not found or expired.`,
          'The token may have expired because the MCP server restarted. Retry the call with dbPath set (or HARNESS_DB_PATH exported), or start a new session with harness_session(action: "begin").',
          'harness_session',
        );
      }

      const session = {
        dbPath,
        context: JSON.parse(record.contextJson) as Record<string, unknown>,
        beginInput: JSON.parse(record.beginInputJson) as Record<string, unknown>,
      };

      this.sessions.set(token, session);
      return {
        context: session.context,
        beginInput: session.beginInput,
      };
    } finally {
      database.close();
    }
  }

  updateContext(
    token: string,
    patch: Record<string, unknown>,
    dbPathInput?: string,
  ): void {
    const cached = this.resolveWithDbPath(token, dbPathInput);
    const nextContext = {
      ...cached.context,
      ...patch,
    };
    const updatedAt = new Date().toISOString();
    const database = openHarnessDatabase({ dbPath: cached.dbPath });

    try {
      runInTransaction(database.connection, () => {
        updateActiveSessionContext(
          database.connection,
          token,
          JSON.stringify(nextContext),
          updatedAt,
        );
      });
    } finally {
      database.close();
    }

    this.sessions.set(token, {
      ...cached,
      context: nextContext,
    });
  }

  remove(token: string, dbPathInput?: string): void {
    const cached = this.resolveWithDbPath(token, dbPathInput);
    const closedAt = new Date().toISOString();
    const database = openHarnessDatabase({ dbPath: cached.dbPath });

    try {
      runInTransaction(database.connection, () => {
        closeActiveSession(database.connection, token, closedAt);
      });
    } finally {
      database.close();
    }

    this.sessions.delete(token);
  }

  private resolveWithDbPath(
    token: string,
    dbPathInput?: string,
  ): {
    dbPath: string;
    context: Record<string, unknown>;
    beginInput: Record<string, unknown>;
  } {
    const cached = this.sessions.get(token);

    if (cached) {
      return cached;
    }

    const dbPath = resolveDbPath(dbPathInput);
    const resolved = this.resolve(token, dbPath);
    return {
      dbPath,
      context: resolved.context,
      beginInput: resolved.beginInput,
    };
  }
}

export function resolveDbPath(input?: string): string {
  const resolved = input ?? process.env['HARNESS_DB_PATH'];

  if (!resolved) {
    throw new AgenticToolError(
      'dbPath is required. Either pass it explicitly or set the HARNESS_DB_PATH environment variable.',
      'Set HARNESS_DB_PATH in your shell (export HARNESS_DB_PATH=/path/to/harness.db) then retry, or pass dbPath directly.',
    );
  }

  return resolved;
}

export function resolveWorkspaceId(
  connection: DatabaseSync,
  input: { workspaceId?: string; workspaceName?: string },
): string {
  if (input.workspaceId) {
    return input.workspaceId;
  }

  if (input.workspaceName) {
    const rows = selectAll<IdRow>(
      connection,
      `SELECT id, name
       FROM workspaces
       WHERE name = ?
       ORDER BY created_at DESC`,
      [input.workspaceName],
    );

    if (rows.length === 0) {
      throw new AgenticToolError(
        `No workspace found with name "${input.workspaceName}".`,
        buildWorkspaceResolutionHelp(connection),
        'harness_orchestrator',
      );
    }

    if (rows.length > 1) {
      throw new AgenticToolError(
        `Workspace name "${input.workspaceName}" is ambiguous.`,
        `Pass workspaceId explicitly. Matching workspaces: ${rows.map((row) => `"${row.name}" (${row.id})`).join(', ')}.`,
        'harness_orchestrator',
      );
    }

    return rows[0].id;
  }

  const workspaces = selectAll<IdRow>(
    connection,
    `SELECT id, name FROM workspaces ORDER BY created_at DESC`,
  );

  if (workspaces.length === 0) {
    throw new AgenticToolError(
      'No workspace found. Cannot resolve workspaceId.',
      'Call harness_init_workspace first to create a workspace.',
      'harness_init_workspace',
    );
  }

  if (workspaces.length > 1) {
    throw new AgenticToolError(
      'workspaceId is required because multiple workspaces exist.',
      `Pass workspaceId explicitly. Available workspaces: ${workspaces.map((workspace) => `"${workspace.name}" (${workspace.id})`).join(', ')}.`,
      'harness_orchestrator',
    );
  }

  return workspaces[0].id;
}

export function resolveProjectId(
  connection: DatabaseSync,
  input: { projectId?: string; projectName?: string; workspaceId?: string },
): string {
  if (input.projectId) return input.projectId;

  if (!input.projectName) {
    throw new AgenticToolError(
      'Either projectId or projectName is required.',
      'Pass projectId (UUID) or projectName (human-readable name) to identify the project.',
    );
  }

  const rows = selectAll<IdRow>(
    connection,
    `SELECT id, name, workspace_id
     FROM projects
     WHERE name = ?
       AND (? IS NULL OR workspace_id = ?)
     ORDER BY created_at DESC`,
    [
      input.projectName,
      input.workspaceId ?? null,
      input.workspaceId ?? null,
    ],
  );

  if (rows.length === 0) {
    throw new AgenticToolError(
      `No project found with name "${input.projectName}".`,
      buildProjectResolutionHelp(connection, input.workspaceId),
      'harness_create_campaign',
    );
  }

  if (rows.length > 1) {
    throw new AgenticToolError(
      `Project name "${input.projectName}" is ambiguous.`,
      `Pass projectId explicitly${input.workspaceId ? '' : ' or provide workspaceId to narrow the search'}. Matching projects: ${rows.map((row) => `"${row.name}" (${row.id})`).join(', ')}.`,
      'harness_inspector',
    );
  }

  return rows[0].id;
}

export function resolveCampaignId(
  connection: DatabaseSync,
  projectId: string,
  input: { campaignId?: string; campaignName?: string },
): string {
  if (input.campaignId) return input.campaignId;

  if (!input.campaignName) {
    throw new AgenticToolError(
      'Either campaignId or campaignName is required.',
      'Pass campaignId (UUID) or campaignName (human-readable name) to identify the campaign.',
    );
  }

  const rows = selectAll<IdRow>(
    connection,
    `SELECT id, name
     FROM campaigns
     WHERE project_id = ?
       AND name = ?
     ORDER BY created_at DESC`,
    [projectId, input.campaignName],
  );

  if (rows.length === 0) {
    throw new AgenticToolError(
      `No campaign found with name "${input.campaignName}" in project ${projectId}.`,
      buildCampaignResolutionHelp(connection, projectId),
      'harness_create_campaign',
    );
  }

  if (rows.length > 1) {
    throw new AgenticToolError(
      `Campaign name "${input.campaignName}" is ambiguous in project ${projectId}.`,
      `Pass campaignId explicitly. Matching campaigns: ${rows.map((row) => `"${row.name}" (${row.id})`).join(', ')}.`,
      'harness_inspector',
    );
  }

  return rows[0].id;
}

export interface AgenticMeta {
  nextTools: string[];
  hint: string;
  idempotent?: boolean;
}

export function buildMeta(
  nextTools: string[],
  hint: string,
  extras?: { idempotent?: boolean },
): { _meta: AgenticMeta } {
  return {
    _meta: {
      nextTools,
      hint,
      ...(extras?.idempotent !== undefined ? { idempotent: extras.idempotent } : {}),
    },
  };
}

export class AgenticToolError extends Error {
  public readonly recovery: string;
  public readonly suggestedTool?: string;

  constructor(message: string, recovery: string, suggestedTool?: string) {
    super(message);
    this.name = 'AgenticToolError';
    this.recovery = recovery;
    this.suggestedTool = suggestedTool;
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.message,
      recovery: this.recovery,
      ...(this.suggestedTool ? { suggestedTool: this.suggestedTool } : {}),
    };
  }
}

function resolveSessionDbPath(
  context: Record<string, unknown>,
  beginInput: Record<string, unknown>,
): string {
  const contextPath = extractOptionalStringField(context, 'dbPath');
  const beginPath = extractOptionalStringField(beginInput, 'dbPath');
  return resolveDbPath(contextPath ?? beginPath);
}

function extractStringField(
  source: Record<string, unknown>,
  key: string,
): string {
  const value = source[key];

  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required string field "${key}" in active session payload.`);
  }

  return value;
}

function extractOptionalStringField(
  source: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function buildWorkspaceResolutionHelp(connection: DatabaseSync): string {
  const rows = selectAll<IdRow>(
    connection,
    `SELECT id, name FROM workspaces ORDER BY created_at DESC`,
  );

  return rows.length > 0
    ? `Available workspaces: ${rows.map((row) => `"${row.name}" (${row.id})`).join(', ')}.`
    : 'No workspaces exist yet. Call harness_init_workspace first.';
}

function buildProjectResolutionHelp(
  connection: DatabaseSync,
  workspaceId?: string,
): string {
  const rows = selectAll<IdRow>(
    connection,
    `SELECT id, name
     FROM projects
     WHERE (? IS NULL OR workspace_id = ?)
     ORDER BY created_at DESC`,
    [workspaceId ?? null, workspaceId ?? null],
  );

  return rows.length > 0
    ? `Available projects: ${rows.map((row) => `"${row.name}" (${row.id})`).join(', ')}.`
    : 'No projects exist yet. Call harness_create_campaign first to create a project.';
}

function buildCampaignResolutionHelp(
  connection: DatabaseSync,
  projectId: string,
): string {
  const rows = selectAll<IdRow>(
    connection,
    `SELECT id, name
     FROM campaigns
     WHERE project_id = ?
     ORDER BY created_at DESC`,
    [projectId],
  );

  return rows.length > 0
    ? `Available campaigns: ${rows.map((row) => `"${row.name}" (${row.id})`).join(', ')}.`
    : 'No campaigns exist for this project. Call harness_create_campaign first.';
}
