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
  assert.equal(sanitizeWorktreeIdentifier('Issue__42...A'), 'issue__42.a');
  assert.equal(sanitizeWorktreeIdentifier('Release.lock'), 'release');
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
  assert.throws(
    () =>
      buildWorktreeAllocation({
        issueId: 'M2-I1',
        repoRoot,
        worktreeRoot,
        baseRef: 'release..candidate',
      }),
    /baseRef must be a safe git ref/,
  );
});

test('buildWorktreeAllocation never emits unsafe git branch refs from safeable input', () => {
  const worktree = buildWorktreeAllocation({
    issueId: 'Release..Candidate.lock',
    repoRoot,
    worktreeRoot,
    baseRef: 'main',
    branchPrefix: 'team/feat.lock',
  });

  assert.equal(worktree.id, 'release.candidate');
  assert.equal(worktree.branch, 'team/feat/release.candidate');
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

test('validateWorktreeCandidate rejects externally supplied unsafe git refs', () => {
  const worktree = buildWorktreeAllocation({
    issueId: 'M2-I1',
    repoRoot,
    worktreeRoot,
    baseRef: 'main',
  });
  const result = validateWorktreeCandidate({
    ...worktree,
    branch: 'bad..branch',
    baseRef: 'bad..base',
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(
      result.issues.map((issue) => issue.code),
      ['invalid_branch_ref', 'invalid_base_ref'],
    );
  }
  assert.throws(
    () => createWorktreeCleanupPlan({ ...worktree, branch: 'bad..branch' }),
    /worktree branch must be a safe git branch ref/,
  );
});

test('validateWorktreeCandidate rejects HEAD as branch while allowing it as baseRef', () => {
  const worktree = buildWorktreeAllocation({
    issueId: 'M2-I1',
    repoRoot,
    worktreeRoot,
    baseRef: 'HEAD',
  });
  const result = validateWorktreeCandidate({
    ...worktree,
    branch: 'HEAD',
  });

  assert.equal(worktree.baseRef, 'HEAD');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(
      result.issues.map((issue) => issue.code),
      ['invalid_branch_ref'],
    );
  }
  assert.throws(
    () => createWorktreeCleanupPlan({ ...worktree, branch: 'HEAD' }),
    /worktree branch must be a safe git branch ref/,
  );
});

test('validateWorktreeCandidate rejects whitespace-padded external refs', () => {
  const worktree = buildWorktreeAllocation({
    issueId: 'M2-I1',
    repoRoot,
    worktreeRoot,
    baseRef: 'main',
  });
  const result = validateWorktreeCandidate({
    ...worktree,
    branch: ' feat/m2-i1 ',
    baseRef: ' main ',
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(
      result.issues.map((issue) => issue.code),
      ['invalid_branch_ref', 'invalid_base_ref'],
    );
  }
  assert.throws(
    () => createWorktreeCleanupPlan({ ...worktree, branch: ' feat/m2-i1 ' }),
    /worktree branch must be a safe git branch ref/,
  );
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

test('createWorktreeCleanupPlan respects cleanup policy and outcome', () => {
  const retainedWorktree = buildWorktreeAllocation({
    issueId: 'M2-I1',
    repoRoot,
    worktreeRoot,
    baseRef: 'main',
    cleanupPolicy: 'retain',
  });
  const successOnlyWorktree = buildWorktreeAllocation({
    issueId: 'M2-I2',
    repoRoot,
    worktreeRoot,
    baseRef: 'main',
    cleanupPolicy: 'delete_on_success',
  });
  const failureOnlyWorktree = buildWorktreeAllocation({
    issueId: 'M2-I3',
    repoRoot,
    worktreeRoot,
    baseRef: 'main',
    cleanupPolicy: 'delete_on_failure',
  });

  assert.deepEqual(createWorktreeCleanupPlan(retainedWorktree).commands, []);
  assert.deepEqual(
    createWorktreeCleanupPlan(successOnlyWorktree, 'failure').commands,
    [],
  );
  assert.deepEqual(
    createWorktreeCleanupPlan(failureOnlyWorktree, 'success').commands,
    [],
  );
  assert.equal(
    createWorktreeCleanupPlan(successOnlyWorktree, 'success').commands.length,
    3,
  );
  assert.equal(
    createWorktreeCleanupPlan(failureOnlyWorktree, 'failure').commands.length,
    3,
  );
});
