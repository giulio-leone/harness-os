import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import {
  openHarnessDatabase,
  runStatement,
  selectOne,
} from '../db/store.js';

export interface HarnessArtifactRegistryInput {
  readonly dbPath: string;
  readonly projectId: string;
  readonly campaignId?: string;
  readonly issueId?: string;
  readonly kind: string;
  readonly path: string;
  readonly metadata?: Record<string, unknown>;
  readonly createdAt?: string;
}

export interface HarnessArtifactRegistryResult {
  readonly artifactId: string;
  readonly kind: string;
  readonly path: string;
}

export function saveHarnessArtifact(
  input: HarnessArtifactRegistryInput,
): HarnessArtifactRegistryResult {
  const database = openHarnessDatabase({ dbPath: input.dbPath });

  try {
    return insertHarnessArtifact(database.connection, input);
  } finally {
    database.close();
  }
}

export function insertHarnessArtifact(
  connection: DatabaseSync,
  input: Omit<HarnessArtifactRegistryInput, 'dbPath'>,
): HarnessArtifactRegistryResult {
  const project = selectOne<{ workspace_id: string }>(
    connection,
    'SELECT workspace_id FROM projects WHERE id = ?',
    [input.projectId],
  );

  if (project === null) {
    throw new Error(`Project ${input.projectId} not found.`);
  }

  const artifactId = randomUUID();
  const createdAt = input.createdAt ?? new Date().toISOString();

  runStatement(
    connection,
    `INSERT INTO artifacts (
       id, workspace_id, project_id, campaign_id, issue_id, kind, path,
       metadata_json, created_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      artifactId,
      project.workspace_id,
      input.projectId,
      input.campaignId ?? null,
      input.issueId ?? null,
      normalizeNonEmpty('kind', input.kind),
      normalizeNonEmpty('path', input.path),
      JSON.stringify(input.metadata ?? {}),
      createdAt,
    ],
  );

  return {
    artifactId,
    kind: input.kind,
    path: input.path,
  };
}

function normalizeNonEmpty(label: string, value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`artifact ${label} must not be empty.`);
  }
  return normalized;
}
