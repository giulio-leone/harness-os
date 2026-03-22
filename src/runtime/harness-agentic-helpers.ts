import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { selectAll, selectOne } from '../db/store.js';

// ─── Session Token Store ────────────────────────────────────────────

/**
 * In-memory store that maps short session tokens to full SessionContext objects.
 * Eliminates the need for LLMs to pass back ~500-token context objects on every
 * checkpoint/close call. The token is ephemeral (lives for the lifetime of the
 * MCP server process), which is fine since MCP servers are tied to a single agent session.
 */
export class SessionTokenStore {
  private readonly sessions = new Map<
    string,
    { context: Record<string, unknown>; beginInput: Record<string, unknown> }
  >();

  /** Store a context with its original parameters and return a short token. */
  store(context: Record<string, unknown>, beginInput: Record<string, unknown>): string {
    const token = `ST-${randomUUID().slice(0, 12)}`;
    this.sessions.set(token, { context, beginInput });
    return token;
  }

  /** Retrieve session data by token. Throws AgenticToolError if not found. */
  resolve(token: string): { context: Record<string, unknown>; beginInput: Record<string, unknown> } {
    const session = this.sessions.get(token);
    if (!session) {
      throw new AgenticToolError(
        `Session token "${token}" not found or expired.`,
        'The token may have expired because the MCP server restarted. Call begin_incremental_session to start a new session.',
        'begin_incremental_session',
      );
    }
    return session;
  }

  /** Update stored context (e.g., after checkpoint updates checkpointId/taskStatus). */
  updateContext(token: string, patch: Record<string, unknown>): void {
    const session = this.resolve(token);
    this.sessions.set(token, {
      ...session,
      context: { ...session.context, ...patch },
    });
  }

  /** Remove a session token (e.g., after close). */
  remove(token: string): void {
    this.sessions.delete(token);
  }
}

// ─── dbPath resolution ───────────────────────────────────────────────

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

// ─── Name-to-ID resolution ──────────────────────────────────────────

interface IdRow {
  id: string;
}

export function resolveProjectId(
  connection: DatabaseSync,
  input: { projectId?: string; projectName?: string },
): string {
  if (input.projectId) return input.projectId;

  if (!input.projectName) {
    throw new AgenticToolError(
      'Either projectId or projectName is required.',
      'Pass projectId (UUID) or projectName (human-readable name) to identify the project.',
    );
  }

  const row = selectOne<IdRow>(
    connection,
    `SELECT id FROM projects WHERE name = ? LIMIT 1`,
    [input.projectName],
  );

  if (row === null) {
    const allProjects = selectAll<{ id: string; name: string }>(
      connection,
      `SELECT id, name FROM projects ORDER BY name`,
    );

    throw new AgenticToolError(
      `No project found with name "${input.projectName}".`,
      allProjects.length > 0
        ? `Available projects: ${allProjects.map((p) => `"${p.name}" (${p.id})`).join(', ')}. Use one of these names or IDs.`
        : 'No projects exist yet. Call harness_create_campaign first to create a project.',
      'harness_create_campaign',
    );
  }

  return row.id;
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

  const row = selectOne<IdRow>(
    connection,
    `SELECT id FROM campaigns WHERE project_id = ? AND name = ? LIMIT 1`,
    [projectId, input.campaignName],
  );

  if (row === null) {
    const allCampaigns = selectAll<{ id: string; name: string }>(
      connection,
      `SELECT id, name FROM campaigns WHERE project_id = ? ORDER BY name`,
      [projectId],
    );

    throw new AgenticToolError(
      `No campaign found with name "${input.campaignName}" in project ${projectId}.`,
      allCampaigns.length > 0
        ? `Available campaigns: ${allCampaigns.map((c) => `"${c.name}" (${c.id})`).join(', ')}. Use one of these names or IDs.`
        : 'No campaigns exist for this project. Call harness_create_campaign first.',
      'harness_create_campaign',
    );
  }

  return row.id;
}

// ─── _meta orchestration hints ──────────────────────────────────────

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

// ─── Instructional errors ───────────────────────────────────────────

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
