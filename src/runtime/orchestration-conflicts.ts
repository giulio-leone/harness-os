import { posix } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { selectAll } from '../db/store.js';

export type OrchestrationConflictKind =
  | 'worktree_path_conflict'
  | 'worktree_branch_conflict'
  | 'candidate_file_conflict';

export interface OrchestrationConflictGuard {
  readonly worktreePath: string;
  readonly worktreeBranch: string;
  readonly candidateFilePaths: readonly string[];
}

export interface OrchestrationConflictLock {
  readonly source: string;
  readonly issueId?: string;
  readonly runId?: string;
  readonly artifactId?: string;
  readonly worktreePath?: string;
  readonly worktreeBranch?: string;
  readonly candidateFilePaths: readonly string[];
}

export interface SelectOrchestrationConflictLocksInput {
  readonly projectId: string;
  readonly campaignId?: string;
  readonly excludeRunId?: string;
}

export interface AssertNoOrchestrationConflictsInput
  extends SelectOrchestrationConflictLocksInput {
  readonly guard: OrchestrationConflictGuard;
}

export interface OrchestrationConflict {
  readonly kind: OrchestrationConflictKind;
  readonly message: string;
  readonly conflictingLock: OrchestrationConflictLock;
  readonly path?: string;
  readonly branch?: string;
  readonly candidateFilePath?: string;
}

interface RunArtifactRow {
  id: string;
  notes: string | null;
}

interface ArtifactLockRow {
  id: string;
  issue_id: string | null;
  kind: string;
  path: string;
  metadata_json: string;
}

interface ArtifactReference {
  readonly id?: string;
  readonly kind: string;
  readonly path: string;
  readonly metadata?: unknown;
}

const activeRunStatuses = ['reconciling', 'recovering', 'in_progress'] as const;
const worktreeBranchArtifactPrefix = 'orchestration://worktree-branch/';
const candidateFilesArtifactPrefix = 'orchestration://candidate-files/';

export class OrchestrationConflictError extends Error {
  readonly kind: OrchestrationConflictKind;
  readonly conflictingLock: OrchestrationConflictLock;

  constructor(conflict: OrchestrationConflict) {
    super(conflict.message);
    this.name = 'OrchestrationConflictError';
    this.kind = conflict.kind;
    this.conflictingLock = conflict.conflictingLock;
  }
}

export function assertNoOrchestrationConflicts(
  connection: DatabaseSync,
  input: AssertNoOrchestrationConflictsInput,
): void {
  const conflict = findOrchestrationConflict(
    input.guard,
    selectActiveOrchestrationConflictLocks(connection, input),
  );

  if (conflict !== null) {
    throw new OrchestrationConflictError(conflict);
  }
}

export function selectActiveOrchestrationConflictLocks(
  connection: DatabaseSync,
  input: SelectOrchestrationConflictLocksInput,
): OrchestrationConflictLock[] {
  return [
    ...selectRunConflictLocks(connection, input),
    ...selectArtifactConflictLocks(connection, input),
  ];
}

export function findOrchestrationConflict(
  guard: OrchestrationConflictGuard,
  locks: readonly OrchestrationConflictLock[],
): OrchestrationConflict | null {
  for (const lock of locks) {
    if (
      lock.worktreePath !== undefined &&
      sameComparisonPath(lock.worktreePath, guard.worktreePath)
    ) {
      return {
        kind: 'worktree_path_conflict',
        message: `Worktree path ${guard.worktreePath} conflicts with active ${lock.source}.`,
        conflictingLock: lock,
        path: guard.worktreePath,
      };
    }

    if (
      lock.worktreeBranch !== undefined &&
      lock.worktreeBranch === guard.worktreeBranch
    ) {
      return {
        kind: 'worktree_branch_conflict',
        message: `Worktree branch ${guard.worktreeBranch} conflicts with active ${lock.source}.`,
        conflictingLock: lock,
        branch: guard.worktreeBranch,
      };
    }

    const candidateConflict = findCandidateFileOverlap(
      guard.candidateFilePaths,
      lock.candidateFilePaths,
    );

    if (candidateConflict !== null) {
      return {
        kind: 'candidate_file_conflict',
        message: `Candidate path ${candidateConflict.left} overlaps active ${lock.source} path ${candidateConflict.right}.`,
        conflictingLock: lock,
        candidateFilePath: candidateConflict.left,
      };
    }
  }

  return null;
}

export function normalizeCandidateFilePaths(
  paths: readonly string[],
): string[] {
  const normalized = paths.map(normalizeCandidateFilePath);
  return [...new Set(normalized)].sort((left, right) => left.localeCompare(right));
}

export function normalizeCandidateFilePath(path: string): string {
  const trimmed = path.trim().replace(/\\/g, '/');

  if (trimmed.length === 0) {
    throw new Error('candidate file path must not be empty.');
  }

  if (posix.isAbsolute(trimmed)) {
    throw new Error('candidate file path must be repo-relative.');
  }

  const normalized = posix.normalize(trimmed);

  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.split('/').includes('..')
  ) {
    throw new Error('candidate file path must not contain traversal segments.');
  }

  return normalized;
}

export function encodeWorktreeBranchArtifactPath(branch: string): string {
  return `${worktreeBranchArtifactPrefix}${encodeURIComponent(branch)}`;
}

export function encodeCandidateFilesArtifactPath(
  paths: readonly string[],
): string {
  const normalized = normalizeCandidateFilePaths(paths);
  return `${candidateFilesArtifactPrefix}${normalized
    .map((path) => encodeURIComponent(path))
    .join('/')}`;
}

function selectRunConflictLocks(
  connection: DatabaseSync,
  input: SelectOrchestrationConflictLocksInput,
): OrchestrationConflictLock[] {
  const rows = selectAll<RunArtifactRow>(
    connection,
    `SELECT id, notes
     FROM runs
     WHERE project_id = ?
       AND (? IS NULL OR id <> ?)
       AND status IN (${activeRunStatuses.map(() => '?').join(', ')})
     ORDER BY started_at ASC, id ASC`,
    [
      input.projectId,
      input.excludeRunId ?? null,
      input.excludeRunId ?? null,
      ...activeRunStatuses,
    ],
  );

  return rows.flatMap((row) =>
    extractLocksFromArtifacts(parseRunArtifacts(row.notes), {
      source: `run:${row.id}`,
      runId: row.id,
    }),
  );
}

function selectArtifactConflictLocks(
  connection: DatabaseSync,
  input: SelectOrchestrationConflictLocksInput,
): OrchestrationConflictLock[] {
  const rows = selectAll<ArtifactLockRow>(
    connection,
    `SELECT a.id, a.issue_id, a.kind, a.path, a.metadata_json
     FROM artifacts a
     LEFT JOIN issues i ON i.id = a.issue_id
     WHERE a.project_id = ?
       AND (a.issue_id IS NULL OR i.status = 'in_progress')
     ORDER BY a.created_at ASC, a.id ASC`,
    [input.projectId],
  );

  return rows.flatMap((row) =>
    extractLocksFromArtifacts(
      [
        {
          id: row.id,
          kind: row.kind,
          path: row.path,
          metadata: parseJson(row.metadata_json),
        },
      ],
      {
        source: `artifact:${row.id}`,
        artifactId: row.id,
        ...(row.issue_id !== null ? { issueId: row.issue_id } : {}),
      },
    ),
  );
}

function parseRunArtifacts(notes: string | null): ArtifactReference[] {
  const parsed = parseJson(notes);

  if (!isRecord(parsed) || !Array.isArray(parsed['artifacts'])) {
    return [];
  }

  return parsed['artifacts']
    .filter(isArtifactReferenceRecord)
    .map((artifact) => ({
      kind: artifact.kind,
      path: artifact.path,
      metadata: artifact.metadata,
    }));
}

function extractLocksFromArtifacts(
  artifacts: readonly ArtifactReference[],
  identity: Omit<OrchestrationConflictLock, 'candidateFilePaths'>,
): OrchestrationConflictLock[] {
  return artifacts.flatMap((artifact) => {
    const kind = artifact.kind.toLowerCase();
    const metadata = isRecord(artifact.metadata) ? artifact.metadata : {};
    const worktreeBranch =
      decodeWorktreeBranchArtifactPath(artifact.path) ??
      readMetadataString(metadata, ['worktreeBranch', 'worktree_branch', 'branch']);
    const candidateFilePaths = readCandidateFilePaths(artifact, metadata);
    const worktreePath =
      kind === 'orchestration_worktree' || kind.endsWith('_worktree')
        ? readMetadataString(metadata, ['worktreePath', 'worktree_path']) ??
          artifact.path
        : readMetadataString(metadata, ['worktreePath', 'worktree_path']);

    if (
      worktreePath === undefined &&
      worktreeBranch === undefined &&
      candidateFilePaths.length === 0
    ) {
      return [];
    }

    return [
      {
        ...identity,
        ...(artifact.id !== undefined ? { artifactId: artifact.id } : {}),
        ...(worktreePath !== undefined ? { worktreePath } : {}),
        ...(worktreeBranch !== undefined ? { worktreeBranch } : {}),
        candidateFilePaths,
      },
    ];
  });
}

function readCandidateFilePaths(
  artifact: ArtifactReference,
  metadata: Record<string, unknown>,
): string[] {
  const fromPath = safeNormalizeCandidateFilePaths(() =>
    decodeCandidateFilesArtifactPath(artifact.path),
  );

  if (fromPath.length > 0) {
    return fromPath;
  }

  const metadataCandidates = readMetadataStringArray(metadata, [
    'candidateFilePaths',
    'candidate_file_paths',
    'candidateFiles',
    'candidate_files',
  ]);

  return safeNormalizeCandidateFilePaths(() =>
    normalizeCandidateFilePaths(metadataCandidates),
  );
}

function decodeWorktreeBranchArtifactPath(path: string): string | undefined {
  if (!path.startsWith(worktreeBranchArtifactPrefix)) {
    return undefined;
  }

  return decodeURIComponent(path.slice(worktreeBranchArtifactPrefix.length));
}

function decodeCandidateFilesArtifactPath(path: string): string[] {
  if (!path.startsWith(candidateFilesArtifactPrefix)) {
    return [];
  }

  const encoded = path.slice(candidateFilesArtifactPrefix.length);

  if (encoded.length === 0) {
    return [];
  }

  return normalizeCandidateFilePaths(
    encoded.split('/').map((segment) => decodeURIComponent(segment)),
  );
}

function safeNormalizeCandidateFilePaths(read: () => string[]): string[] {
  try {
    return read();
  } catch {
    return [];
  }
}

function findCandidateFileOverlap(
  leftPaths: readonly string[],
  rightPaths: readonly string[],
): { left: string; right: string } | null {
  for (const left of leftPaths) {
    for (const right of rightPaths) {
      if (candidatePathsOverlap(left, right)) {
        return { left, right };
      }
    }
  }

  return null;
}

function candidatePathsOverlap(left: string, right: string): boolean {
  const normalizedLeft = normalizeComparisonPath(left);
  const normalizedRight = normalizeComparisonPath(right);
  return (
    normalizedLeft === normalizedRight ||
    isRepoPathContained(normalizedLeft, normalizedRight) ||
    isRepoPathContained(normalizedRight, normalizedLeft)
  );
}

function isRepoPathContained(parent: string, child: string): boolean {
  const relativePath = posix.relative(parent, child);
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !posix.isAbsolute(relativePath))
  );
}

function sameComparisonPath(left: string, right: string): boolean {
  return normalizeComparisonPath(left) === normalizeComparisonPath(right);
}

function normalizeComparisonPath(path: string): string {
  return posix.normalize(path.replace(/\\/g, '/')).toLowerCase();
}

function readMetadataString(
  metadata: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }

  return undefined;
}

function readMetadataStringArray(
  metadata: Record<string, unknown>,
  keys: readonly string[],
): string[] {
  for (const key of keys) {
    const value = metadata[key];

    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === 'string');
    }
  }

  return [];
}

function parseJson(json: string | null): unknown {
  if (json === null) {
    return null;
  }

  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

function isArtifactReferenceRecord(
  value: unknown,
): value is ArtifactReference & { kind: string; path: string } {
  return (
    isRecord(value) &&
    typeof value['kind'] === 'string' &&
    typeof value['path'] === 'string' &&
    value['kind'].length > 0 &&
    value['path'].length > 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
