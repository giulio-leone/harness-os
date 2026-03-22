import type { DatabaseSync } from 'node:sqlite';

import { selectAll, selectOne } from '../db/store.js';

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
