import assert from 'node:assert/strict';
import test from 'node:test';

import { orchestrationWorktreeSchema } from '../contracts/orchestration-contracts.js';
import {
  buildWorktreeAllocation,
  createWorktreeCleanupPlan,
  sanitizeWorktreeIdentifier,
  validateWorktreeCandidate,
} from '../runtime/worktree-manager.js';

const repoRoot = '/workspace/harness-os';
const worktreeRoot = '/workspace/worktrees';

test('sanitizeWorktreeIdentifier creates safe deterministic path segments', () => {
  assert.equal(
    sanitizeWorktreeIdentifier(' M2 I1: Worktree/Allocator '),
    'm2-i1-worktree-allocator',
  );
  assert.equal(sanitizeWorktreeIdentifier('Issue__42...A'), 'issue__42...a');
  assert.throws(
    () => sanitizeWorktreeIdentifier('../escape'),
    /traversal segments/,
  );
  assert.throws(() => sanitizeWorktreeIdentifier(' !!! '), /safe character/);
});

test('buildWorktreeAllocation builds a schema-valid deterministic worktree', () => {
  const input = {
    issueId: 'M2 I1: Worktree/Allocator',
    repoRoot,
    worktreeRoot,
    baseRef: 'origin/main',
    branchPrefix: 'feat',
  };

  const first = buildWorktreeAllocation(input);
  const second = buildWorktreeAllocation(input);

  assert.deepEqual(first, second);
  assert.deepEqual(first, {
    id: 'm2-i1-worktree-allocator',
    repoRoot,
    root: worktreeRoot,
    path: '/workspace/worktrees/m2-i1-worktree-allocator',
    branch: 'feat/m2-i1-worktree-allocator',
    baseRef: 'origin/main',
    cleanupPolicy: 'delete_on_completion',
    containment: {
      expectedParentPath: worktreeRoot,
      requirePathWithinRoot: true,
    },
  });
  assert.equal(orchestrationWorktreeSchema.safeParse(first).success, true);
});

test('buildWorktreeAllocation rejects empty identifiers, traversal, and relative roots', () => {
  assert.throws(
    () =>
      buildWorktreeAllocation({
        issueId: '   ',
        repoRoot,
        worktreeRoot,
        baseRef: 'main',
      }),
    /identifier must not be empty/,
  );
  assert.throws(
    () =>
      buildWorktreeAllocation({
        issueId: 'M2-I1',
        repoRoot: '/workspace/../harness-os',
        worktreeRoot,
        baseRef: 'main',
      }),
    /repoRoot must not contain traversal segments/,
  );
  assert.throws(
    () =>
      buildWorktreeAllocation({
        issueId: 'M2-I1',
        repoRoot: 'workspace/harness-os',
        worktreeRoot,
        baseRef: 'main',
      }),
    /repoRoot must be absolute/,
  );
  assert.throws(
    () =>
      buildWorktreeAllocation({
        issueId: 'M2-I1',
        repoRoot,
        worktreeRoot,
        baseRef: '../main',
      }),
    /baseRef must not contain traversal segments/,
  );
});

test('validateWorktreeCandidate detects duplicate path and branch conflicts', () => {
  const first = buildWorktreeAllocation({
    issueId: 'M2-I1',
    repoRoot,
    worktreeRoot,
    baseRef: 'main',
    branchPrefix: 'feat',
  });
  const duplicatePath = {
    ...buildWorktreeAllocation({
      issueId: 'M2-I2',
      repoRoot,
      worktreeRoot,
      baseRef: 'main',
      branchPrefix: 'feat',
    }),
    path: first.path,
  };
  const duplicateBranch = {
    ...buildWorktreeAllocation({
      issueId: 'M2-I3',
      repoRoot,
      worktreeRoot,
      baseRef: 'main',
      branchPrefix: 'feat',
    }),
    branch: first.branch,
  };

  const pathResult = validateWorktreeCandidate(duplicatePath, [first]);
  const branchResult = validateWorktreeCandidate(duplicateBranch, [first]);

  assert.equal(pathResult.ok, false);
  assert.equal(branchResult.ok, false);

  if (!pathResult.ok) {
    assert.equal(pathResult.issues[0]?.code, 'duplicate_path');
  }

  if (!branchResult.ok) {
    assert.equal(branchResult.issues[0]?.code, 'duplicate_branch');
  }
});

test('validateWorktreeCandidate rejects candidates outside root containment', () => {
  const candidate = {
    ...buildWorktreeAllocation({
      issueId: 'M2-I1',
      repoRoot,
      worktreeRoot,
      baseRef: 'main',
    }),
    path: '/workspace/other/m2-i1',
  };

  const result = validateWorktreeCandidate(candidate);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(
      result.issues.map((issue) => issue.message).join('\n'),
      /path must be contained by root/,
    );
  }
});

test('createWorktreeCleanupPlan returns structured git cleanup data without executing', () => {
  const worktree = buildWorktreeAllocation({
    issueId: 'M2-I1',
    repoRoot,
    worktreeRoot,
    baseRef: 'main',
    branchPrefix: 'feat',
  });

  const plan = createWorktreeCleanupPlan(worktree);

  assert.deepEqual(plan, {
    worktreeId: 'm2-i1',
    cleanupPolicy: 'delete_on_completion',
    commands: [
      {
        type: 'remove_worktree',
        cwd: repoRoot,
        argv: [
          'git',
          'worktree',
          'remove',
          '/workspace/worktrees/m2-i1',
          '--force',
        ],
      },
      {
        type: 'delete_branch',
        cwd: repoRoot,
        argv: ['git', 'branch', '-D', '--', 'feat/m2-i1'],
      },
      {
        type: 'prune_worktrees',
        cwd: repoRoot,
        argv: ['git', 'worktree', 'prune'],
      },
    ],
  });
});
