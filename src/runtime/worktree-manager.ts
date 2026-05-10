import { isAbsolute, join, normalize, relative } from 'node:path';

import {
  orchestrationWorktreeSchema,
  type OrchestrationWorktree,
  type OrchestrationWorktreeCleanupPolicy,
} from '../contracts/orchestration-contracts.js';

export interface BuildWorktreeAllocationInput {
  readonly issueId: string;
  readonly repoRoot: string;
  readonly worktreeRoot: string;
  readonly baseRef: string;
  readonly branchPrefix?: string;
  readonly cleanupPolicy?: OrchestrationWorktreeCleanupPolicy;
}

export interface WorktreeValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly path: readonly PropertyKey[];
}

export type WorktreeValidationResult =
  | {
      readonly ok: true;
      readonly worktree: OrchestrationWorktree;
    }
  | {
      readonly ok: false;
      readonly issues: readonly WorktreeValidationIssue[];
    };

export type WorktreeCleanupCommandType =
  | 'remove_worktree'
  | 'delete_branch'
  | 'prune_worktrees';

export interface WorktreeCleanupCommand {
  readonly type: WorktreeCleanupCommandType;
  readonly cwd: string;
  readonly argv: readonly string[];
}

export interface WorktreeCleanupPlan {
  readonly worktreeId: string;
  readonly cleanupPolicy: OrchestrationWorktreeCleanupPolicy;
  readonly commands: readonly WorktreeCleanupCommand[];
}

const defaultBranchPrefix = 'worktree';
const defaultCleanupPolicy: OrchestrationWorktreeCleanupPolicy =
  'delete_on_completion';

export function sanitizeWorktreeIdentifier(identifier: string): string {
  const trimmed = identifier.trim();

  if (trimmed.length === 0) {
    throw new Error('worktree identifier must not be empty.');
  }

  if (hasPathTraversalSegment(trimmed)) {
    throw new Error('worktree identifier must not contain traversal segments.');
  }

  const sanitized = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');

  if (sanitized.length === 0) {
    throw new Error('worktree identifier must contain at least one safe character.');
  }

  return sanitized;
}

export function buildWorktreeAllocation(
  input: BuildWorktreeAllocationInput,
): OrchestrationWorktree {
  const repoRoot = normalizeAbsolutePath('repoRoot', input.repoRoot);
  const root = normalizeAbsolutePath('worktreeRoot', input.worktreeRoot);
  const id = sanitizeWorktreeIdentifier(input.issueId);
  const branchPrefix = sanitizeBranchPath(
    input.branchPrefix ?? defaultBranchPrefix,
  );
  const branch = `${branchPrefix}/${id}`;
  const baseRef = validateSafeRef('baseRef', input.baseRef);
  const candidate = {
    id,
    repoRoot,
    root,
    path: join(root, id),
    branch,
    baseRef,
    cleanupPolicy: input.cleanupPolicy ?? defaultCleanupPolicy,
    containment: {
      expectedParentPath: root,
      requirePathWithinRoot: true,
    },
  };

  const validation = validateWorktreeCandidate(candidate);

  if (!validation.ok) {
    throw new Error(formatValidationError(validation.issues));
  }

  return validation.worktree;
}

export function validateWorktreeCandidate(
  candidate: OrchestrationWorktree,
  existingCandidates: readonly OrchestrationWorktree[] = [],
): WorktreeValidationResult {
  const parsed = orchestrationWorktreeSchema.safeParse(candidate);
  const issues: WorktreeValidationIssue[] = [];

  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        code: issue.code,
        message: issue.message,
        path: issue.path,
      })),
    };
  }

  const duplicatePath = existingCandidates.find(
    (existing) => normalize(existing.path) === normalize(parsed.data.path),
  );
  const duplicateBranch = existingCandidates.find(
    (existing) => existing.branch === parsed.data.branch,
  );

  if (duplicatePath !== undefined) {
    issues.push({
      code: 'duplicate_path',
      message: `worktree path already allocated by ${duplicatePath.id}.`,
      path: ['path'],
    });
  }

  if (duplicateBranch !== undefined) {
    issues.push({
      code: 'duplicate_branch',
      message: `worktree branch already allocated by ${duplicateBranch.id}.`,
      path: ['branch'],
    });
  }

  if (issues.length > 0) {
    return {
      ok: false,
      issues,
    };
  }

  return {
    ok: true,
    worktree: parsed.data,
  };
}

export function createWorktreeCleanupPlan(
  worktree: OrchestrationWorktree,
): WorktreeCleanupPlan {
  const validation = validateWorktreeCandidate(worktree);

  if (!validation.ok) {
    throw new Error(formatValidationError(validation.issues));
  }

  return {
    worktreeId: validation.worktree.id,
    cleanupPolicy: validation.worktree.cleanupPolicy,
    commands: [
      {
        type: 'remove_worktree',
        cwd: validation.worktree.repoRoot,
        argv: [
          'git',
          'worktree',
          'remove',
          validation.worktree.path,
          '--force',
        ],
      },
      {
        type: 'delete_branch',
        cwd: validation.worktree.repoRoot,
        argv: ['git', 'branch', '-D', '--', validation.worktree.branch],
      },
      {
        type: 'prune_worktrees',
        cwd: validation.worktree.repoRoot,
        argv: ['git', 'worktree', 'prune'],
      },
    ],
  };
}

function normalizeAbsolutePath(label: string, value: string): string {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new Error(`${label} must not be empty.`);
  }

  if (!isAbsolute(trimmed)) {
    throw new Error(`${label} must be absolute.`);
  }

  if (hasPathTraversalSegment(trimmed)) {
    throw new Error(`${label} must not contain traversal segments.`);
  }

  return normalize(trimmed);
}

function sanitizeBranchPath(value: string): string {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new Error('branchPrefix must not be empty.');
  }

  if (hasPathTraversalSegment(trimmed)) {
    throw new Error('branchPrefix must not contain traversal segments.');
  }

  const segments = trimmed
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => sanitizeWorktreeIdentifier(segment));

  if (segments.length === 0) {
    throw new Error('branchPrefix must contain at least one safe segment.');
  }

  return segments.join('/');
}

function validateSafeRef(label: string, value: string): string {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new Error(`${label} must not be empty.`);
  }

  if (hasPathTraversalSegment(trimmed)) {
    throw new Error(`${label} must not contain traversal segments.`);
  }

  if (
    trimmed.startsWith('-') ||
    trimmed.startsWith('/') ||
    trimmed.endsWith('/') ||
    trimmed.includes('//') ||
    !/^[A-Za-z0-9._/-]+$/.test(trimmed)
  ) {
    throw new Error(`${label} must be a safe git ref.`);
  }

  return trimmed;
}

function formatValidationError(
  issues: readonly WorktreeValidationIssue[],
): string {
  return `invalid worktree candidate: ${issues
    .map(
      (issue) =>
        `${issue.path.map((segment) => String(segment)).join('.') || '<root>'}: ${
          issue.message
        }`,
    )
    .join('; ')}`;
}

function hasPathTraversalSegment(value: string): boolean {
  return value.split(/[\\/]+/).includes('..');
}

export function isPathContained(parent: string, child: string): boolean {
  const relativePath = relative(parent, child);
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !isAbsolute(relativePath))
  );
}
