import { execFile } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  symphonyWorktreeOperationResultSchema,
  type SymphonyWorktreeCommandResult,
} from '../contracts/symphony-worktree-contracts.js';
import {
  buildSymphonyWorktreeSessionArtifacts,
  cleanupSymphonyPhysicalWorktree,
  createSymphonyPhysicalWorktree,
  runSymphonyPhysicalWorktreeHook,
  type SymphonyWorktreeCommand,
} from '../runtime/symphony-worktree-adapter.js';
import { loadSymphonyWorkflowFromText } from '../runtime/symphony-workflow.js';
import { buildWorktreeAllocation } from '../runtime/worktree-manager.js';

const execFileAsync = promisify(execFile);
const fixedDate = new Date('2026-01-02T03:04:05.000Z');

test('createSymphonyPhysicalWorktree creates and cleans a real git worktree with durable artifacts', async (t) => {
  const fixture = await createGitFixture(t);
  const worktree = buildWorktreeAllocation({
    issueId: 'M10-I2 Physical Worktree',
    repoRoot: fixture.repoRoot,
    worktreeRoot: fixture.worktreeRoot,
    baseRef: 'HEAD',
    branchPrefix: 'agent',
  });
  const workflow = loadSymphonyWorkflowFromText({
    workflowPath: join(fixture.repoRoot, 'WORKFLOW.md'),
    content: `---\nworkspace:\n  root: ${JSON.stringify(fixture.worktreeRoot)}\n---\nImplement {{ issue.identifier }}.`,
    now: () => fixedDate,
  });

  const created = await createSymphonyPhysicalWorktree({
    workflow,
    worktree,
    issue: {
      id: 'issue-77',
      identifier: 'M10-I2',
      title: 'Add physical worktree adapter',
    },
    runId: 'run-001',
    attempt: 2,
    now: () => fixedDate,
  });

  assert.equal(created.status, 'succeeded');
  assert.equal(created.createMode, 'built_in_then_after_create');
  assert.equal(
    symphonyWorktreeOperationResultSchema.safeParse(created).success,
    true,
  );
  assert.equal((await stat(worktree.path)).isDirectory(), true);
  assert.equal(await gitOutput(worktree.path, ['branch', '--show-current']), worktree.branch);
  assert.ok(
    created.artifacts.every(
      (artifact) => artifact.path.startsWith(worktree.root) && !artifact.path.startsWith(worktree.path),
    ),
  );
  assert.deepEqual(
    buildSymphonyWorktreeSessionArtifacts(created).map((artifact) => artifact.kind),
    [
      'physical_worktree_manifest',
      'physical_worktree_command_log',
    ],
  );

  const cleaned = await cleanupSymphonyPhysicalWorktree({
    workflow,
    worktree,
    issue: created.issue,
    outcome: 'success',
    runId: 'run-001',
    attempt: 2,
    now: () => fixedDate,
  });

  assert.equal(cleaned.status, 'succeeded');
  assert.equal(cleaned.cleanupMode, 'hook_then_builtin');
  assert.equal(
    cleaned.artifacts.some(
      (artifact) => artifact.kind === 'physical_worktree_cleanup_plan',
    ),
    true,
  );
  assert.equal(await pathExists(worktree.path), false);
  assert.equal(await localBranchExists(fixture.repoRoot, worktree.branch), false);
});

test('physical worktree adapter runs workflow hooks with explicit ISSUE environment', async (t) => {
  const fixture = await createGitFixture(t);
  const hookLogPath = join(fixture.worktreeRoot, 'hook-env.log');
  const worktree = buildWorktreeAllocation({
    issueId: 'M10-I2 Hooked Worktree',
    repoRoot: fixture.repoRoot,
    worktreeRoot: fixture.worktreeRoot,
    baseRef: 'HEAD',
    branchPrefix: 'agent',
  });
  const workflow = loadSymphonyWorkflowFromText({
    workflowPath: join(fixture.repoRoot, 'WORKFLOW.md'),
    content: `---\nworkspace:\n  root: ${JSON.stringify(fixture.worktreeRoot)}\nhooks:\n  after_create: |\n    printf 'create:%s|%s|%s\\n' "$ISSUE_IDENTIFIER" "$ISSUE_TITLE" "$ISSUE_BRANCH" >> ${shellQuote(hookLogPath)}\n  before_remove: |\n    printf 'cleanup:%s|%s\\n' "$ISSUE_WORKTREE" "$RUN_ID" >> ${shellQuote(hookLogPath)}\n---\nImplement {{ issue.identifier }}.`,
    now: () => fixedDate,
  });

  const created = await createSymphonyPhysicalWorktree({
    workflow,
    worktree,
    issue: {
      id: 'issue-78',
      identifier: 'HAR-78',
      title: 'Hooked workspace',
    },
    runId: 'run-hook',
    attempt: 1,
    now: () => fixedDate,
  });
  assert.equal(created.status, 'succeeded');

  const cleaned = await cleanupSymphonyPhysicalWorktree({
    workflow,
    worktree,
    issue: created.issue,
    outcome: 'completion',
    runId: 'run-hook',
    attempt: 1,
    now: () => fixedDate,
  });
  assert.equal(cleaned.status, 'succeeded');

  assert.equal(
    await readFile(hookLogPath, 'utf8'),
    `create:HAR-78|Hooked workspace|${worktree.branch}\ncleanup:${worktree.path}|run-hook\n`,
  );
});

test('runSymphonyPhysicalWorktreeHook returns typed timeout evidence without shell fallbacks', async (t) => {
  const fixture = await createGitFixture(t);
  const worktree = buildWorktreeAllocation({
    issueId: 'M10-I2 Timeout Hook',
    repoRoot: fixture.repoRoot,
    worktreeRoot: fixture.worktreeRoot,
    baseRef: 'HEAD',
    branchPrefix: 'agent',
  });
  const workflow = loadSymphonyWorkflowFromText({
    workflowPath: join(fixture.repoRoot, 'WORKFLOW.md'),
    content: `---\nworkspace:\n  root: ${JSON.stringify(fixture.worktreeRoot)}\nhooks:\n  before_run: sleep 10\n  timeout_ms: 25\n---\nPrompt`,
    now: () => fixedDate,
  });

  const result = await runSymphonyPhysicalWorktreeHook({
    workflow,
    worktree,
    issue: {
      id: 'issue-timeout',
      identifier: 'HAR-TIMEOUT',
    },
    hookName: 'beforeRun',
    executor: async (command: SymphonyWorktreeCommand): Promise<SymphonyWorktreeCommandResult> => ({
      command: command.command,
      args: [...command.args],
      cwd: command.cwd,
      exitCode: null,
      signal: 'SIGTERM',
      timedOut: true,
      durationMs: command.timeoutMs,
      stdout: '',
      stderr: 'simulated timeout',
    }),
    now: () => fixedDate,
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'command_timeout');
  assert.equal(result.error?.command?.timedOut, true);
  assert.equal(result.commands[0]?.command, 'bash');
  assert.equal(result.commands[0]?.args[0], '-euo');
  assert.equal(result.commands[0]?.args[1], 'pipefail');
  assert.equal(
    result.artifacts.some(
      (artifact) => artifact.kind === 'physical_worktree_manifest',
    ),
    true,
  );
});

test('default hook executor hard-kills hooks that ignore SIGTERM timeout', async (t) => {
  const fixture = await createGitFixture(t);
  const worktree = buildWorktreeAllocation({
    issueId: 'M10-I2 Hard Timeout',
    repoRoot: fixture.repoRoot,
    worktreeRoot: fixture.worktreeRoot,
    baseRef: 'HEAD',
    branchPrefix: 'agent',
  });
  const workflow = loadSymphonyWorkflowFromText({
    workflowPath: join(fixture.repoRoot, 'WORKFLOW.md'),
    content: `---\nworkspace:\n  root: ${JSON.stringify(fixture.worktreeRoot)}\nhooks:\n  before_run: trap '' TERM; while true; do :; done\n  timeout_ms: 25\n---\nPrompt`,
    now: () => fixedDate,
  });
  const startedAt = Date.now();

  const result = await runSymphonyPhysicalWorktreeHook({
    workflow,
    worktree,
    issue: {
      id: 'issue-hard-timeout',
    },
    hookName: 'beforeRun',
    now: () => fixedDate,
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'command_timeout');
  assert.equal(result.commands[0]?.timedOut, true);
  assert.ok(Date.now() - startedAt < 2_000);
});

test('physical worktree adapter rejects artifact roots that escape through symlinks', async (t) => {
  const fixture = await createGitFixture(t);
  const outsideRoot = join(fixture.root, 'outside-artifacts');
  const symlinkPath = join(fixture.worktreeRoot, 'artifact-link');
  await mkdir(outsideRoot, { recursive: true });
  await mkdir(fixture.worktreeRoot, { recursive: true });
  await symlink(outsideRoot, symlinkPath);
  const worktree = buildWorktreeAllocation({
    issueId: 'M10-I2 Symlink Artifact Root',
    repoRoot: fixture.repoRoot,
    worktreeRoot: fixture.worktreeRoot,
    baseRef: 'HEAD',
    branchPrefix: 'agent',
  });
  const workflow = loadSymphonyWorkflowFromText({
    workflowPath: join(fixture.repoRoot, 'WORKFLOW.md'),
    content: `---\nworkspace:\n  root: ${JSON.stringify(fixture.worktreeRoot)}\n---\nPrompt`,
    now: () => fixedDate,
  });

  await assert.rejects(
    () =>
      runSymphonyPhysicalWorktreeHook({
        workflow,
        worktree,
        issue: {
          id: 'issue-symlink-root',
        },
        hookName: 'beforeRun',
        artifactRoot: join(symlinkPath, 'attempt-01'),
        now: () => fixedDate,
      }),
    /artifact root resolves through a parent outside the configured workspace root/,
  );
  assert.equal(await pathExists(join(outsideRoot, 'attempt-01')), false);
});

test('workflow hooks use pipefail so failed pipelines fail the operation', async (t) => {
  const fixture = await createGitFixture(t);
  const worktree = buildWorktreeAllocation({
    issueId: 'M10-I2 Pipefail Hook',
    repoRoot: fixture.repoRoot,
    worktreeRoot: fixture.worktreeRoot,
    baseRef: 'HEAD',
    branchPrefix: 'agent',
  });
  const workflow = loadSymphonyWorkflowFromText({
    workflowPath: join(fixture.repoRoot, 'WORKFLOW.md'),
    content: `---\nworkspace:\n  root: ${JSON.stringify(fixture.worktreeRoot)}\nhooks:\n  after_create: false | true\n---\nPrompt`,
    now: () => fixedDate,
  });

  const result = await createSymphonyPhysicalWorktree({
    workflow,
    worktree,
    issue: {
      id: 'issue-pipefail',
    },
    now: () => fixedDate,
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'hook_failed');
  assert.equal(result.error?.command?.exitCode, 1);
});

test('physical worktree adapter rejects artifact roots inside removable worktree paths', async (t) => {
  const fixture = await createGitFixture(t);
  const worktree = buildWorktreeAllocation({
    issueId: 'M10-I2 Bad Artifact Root',
    repoRoot: fixture.repoRoot,
    worktreeRoot: fixture.worktreeRoot,
    baseRef: 'HEAD',
    branchPrefix: 'agent',
  });
  const workflow = loadSymphonyWorkflowFromText({
    workflowPath: join(fixture.repoRoot, 'WORKFLOW.md'),
    content: `---\nworkspace:\n  root: ${JSON.stringify(fixture.worktreeRoot)}\n---\nPrompt`,
    now: () => fixedDate,
  });

  await assert.rejects(
    () =>
      createSymphonyPhysicalWorktree({
        workflow,
        worktree,
        issue: {
          id: 'issue-bad-root',
        },
        artifactRoot: join(worktree.path, '.harness'),
        now: () => fixedDate,
      }),
    /artifact root must not be nested inside the removable worktree path/,
  );
  assert.equal(await pathExists(worktree.path), false);
});

async function createGitFixture(t: test.TestContext): Promise<{
  root: string;
  repoRoot: string;
  worktreeRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'harness-symphony-worktree-'));
  const repoRoot = join(root, 'repo');
  const worktreeRoot = join(root, 'worktrees');
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await execFileAsync('git', ['init', '-b', 'main', repoRoot]);
  await git(repoRoot, ['config', 'user.email', 'agent@example.test']);
  await git(repoRoot, ['config', 'user.name', 'Harness Agent']);
  await writeFile(join(repoRoot, 'README.md'), 'HarnessOS physical worktree fixture.\n');
  await git(repoRoot, ['add', 'README.md']);
  await git(repoRoot, ['commit', '-m', 'initial fixture']);

  return { root, repoRoot, worktreeRoot };
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync('git', [...args], { cwd });
}

async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], { cwd });
  return stdout.trim();
}

async function localBranchExists(repoRoot: string, branch: string): Promise<boolean> {
  try {
    await git(repoRoot, ['rev-parse', '--verify', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
