import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  constants as fsConstants,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import { accessSync } from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
} from 'node:path';

import type { OrchestrationWorktree } from '../contracts/orchestration-contracts.js';
import type { SessionArtifactReference } from '../contracts/session-contracts.js';
import type { SymphonyWorkflowDocument } from '../contracts/symphony-workflow-contracts.js';
import {
  symphonyWorktreeContractVersion,
  symphonyWorktreeOperationResultSchema,
  type SymphonyWorktreeCleanupMode,
  type SymphonyWorktreeCommandResult,
  type SymphonyWorktreeCreateMode,
  type SymphonyWorktreeErrorCode,
  type SymphonyWorktreeHookName,
  type SymphonyWorktreeIssueContext,
  type SymphonyWorktreeOperation,
  type SymphonyWorktreeOperationError,
  type SymphonyWorktreeOperationResult,
} from '../contracts/symphony-worktree-contracts.js';
import {
  createWorktreeCleanupPlan,
  isPathContained,
  sanitizeWorktreeIdentifier,
  validateWorktreeCandidate,
  type WorktreeCleanupCommand,
  type WorktreeCleanupOutcome,
} from './worktree-manager.js';

export interface SymphonyWorktreeCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Record<string, string | undefined>;
  readonly timeoutMs: number;
  readonly maxOutputBytes?: number;
}

export type SymphonyWorktreeCommandExecutor = (
  command: SymphonyWorktreeCommand,
) => Promise<SymphonyWorktreeCommandResult>;

export interface SymphonyPhysicalWorktreeInput {
  readonly workflow: SymphonyWorkflowDocument;
  readonly worktree: OrchestrationWorktree;
  readonly issue: SymphonyWorktreeIssueContext;
  readonly runId?: string;
  readonly attempt?: number;
  readonly artifactRoot?: string;
  readonly env?: Record<string, string | undefined>;
  readonly executor?: SymphonyWorktreeCommandExecutor;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface CreateSymphonyPhysicalWorktreeInput
  extends SymphonyPhysicalWorktreeInput {
  readonly createMode?: SymphonyWorktreeCreateMode;
}

export interface CleanupSymphonyPhysicalWorktreeInput
  extends SymphonyPhysicalWorktreeInput {
  readonly outcome?: WorktreeCleanupOutcome;
  readonly cleanupMode?: SymphonyWorktreeCleanupMode;
}

export interface RunSymphonyPhysicalWorktreeHookInput
  extends SymphonyPhysicalWorktreeInput {
  readonly hookName: SymphonyWorktreeHookName;
}

interface OperationContext {
  readonly operation: SymphonyWorktreeOperation;
  readonly workflow: SymphonyWorkflowDocument;
  readonly worktree: OrchestrationWorktree;
  readonly issue: SymphonyWorktreeIssueContext;
  readonly runId?: string;
  readonly attempt?: number;
  readonly artifactRoot: string;
  readonly commandLogPath: string;
  readonly manifestPath: string;
  readonly cleanupPlanPath: string;
  readonly env: Record<string, string>;
  readonly executor: SymphonyWorktreeCommandExecutor;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly now: () => Date;
  readonly startedAt: string;
  readonly commands: SymphonyWorktreeCommandResult[];
}

class SymphonyWorktreeAdapterError extends Error {
  constructor(
    readonly code: SymphonyWorktreeErrorCode,
    message: string,
    readonly issues: readonly string[] = [],
    readonly command?: SymphonyWorktreeCommandResult,
  ) {
    super(message);
  }
}

const defaultMaxOutputBytes = 64 * 1024;
const timeoutKillGraceMs = 250;

export async function executeSymphonyWorktreeCommand(
  input: SymphonyWorktreeCommand,
): Promise<SymphonyWorktreeCommandResult> {
  const startedAt = Date.now();
  const maxOutputBytes = input.maxOutputBytes ?? defaultMaxOutputBytes;
  const child = spawn(input.command, [...input.args], {
    cwd: input.cwd,
    env: normalizeEnv(input.env ?? {}),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let spawnError: Error | undefined;
  const timeout = setTimeout(() => {
    timedOut = true;
    terminateChildProcess(child, 'SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        terminateChildProcess(child, 'SIGKILL');
      }
    }, timeoutKillGraceMs).unref();
  }, input.timeoutMs);

  timeout.unref();
  child.stdout.on('data', (chunk: Buffer) => {
    stdout = appendOutput(stdout, chunk, maxOutputBytes);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = appendOutput(stderr, chunk, maxOutputBytes);
  });

  return new Promise((resolveResult) => {
    child.on('error', (error) => {
      spawnError = error;
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      resolveResult({
        command: input.command,
        args: [...input.args],
        cwd: input.cwd,
        exitCode: code,
        ...(signal !== null ? { signal } : {}),
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr:
          spawnError === undefined
            ? stderr
            : appendOutput(stderr, Buffer.from(spawnError.message), maxOutputBytes),
      });
    });
  });
}

export async function createSymphonyPhysicalWorktree(
  input: CreateSymphonyPhysicalWorktreeInput,
): Promise<SymphonyWorktreeOperationResult> {
  const context = await createOperationContext('create', input);
  const createMode = input.createMode ?? 'built_in_then_after_create';
  let status: SymphonyWorktreeOperationResult['status'] = 'succeeded';
  let error: SymphonyWorktreeOperationError | undefined;

  try {
    await assertWorktreeCandidate(context.worktree);
    await assertPhysicalRoots(context);

    if (createMode === 'after_create_hook') {
      await runConfiguredHook(context, 'afterCreate', true);
    } else {
      await runBuiltInCreate(context);
      await runConfiguredHook(context, 'afterCreate', false);
    }

    await verifyExpectedGitWorktree(context);
  } catch (operationError) {
    status = 'failed';
    error = toOperationError(operationError, 'worktree_create_failed');
  }

  return finalizeOperation(context, {
    status,
    createMode,
    ...(error !== undefined ? { error } : {}),
  });
}

export async function cleanupSymphonyPhysicalWorktree(
  input: CleanupSymphonyPhysicalWorktreeInput,
): Promise<SymphonyWorktreeOperationResult> {
  const context = await createOperationContext('cleanup', input);
  const cleanupMode = input.cleanupMode ?? 'hook_then_builtin';
  const cleanupPlan = createWorktreeCleanupPlan(
    context.worktree,
    input.outcome ?? 'completion',
  );
  let status: SymphonyWorktreeOperationResult['status'] =
    cleanupPlan.commands.length === 0 ? 'skipped' : 'succeeded';
  let error: SymphonyWorktreeOperationError | undefined;

  try {
    await assertWorktreeCandidate(context.worktree);
    await assertPhysicalRoots(context);
    await writeCleanupPlanArtifact(context, cleanupPlan.commands);

    if (cleanupPlan.commands.length === 0) {
      return finalizeOperation(context, {
        status,
        cleanupMode,
        cleanupCommands: normalizeCleanupCommands(cleanupPlan.commands),
        reason: `Cleanup policy ${cleanupPlan.cleanupPolicy} does not remove the worktree for outcome ${input.outcome ?? 'completion'}.`,
      });
    }

    if (cleanupMode === 'hook_managed') {
      await runConfiguredHook(context, 'beforeRemove', true);
      await runCommand(context, 'git', ['worktree', 'prune'], context.worktree.repoRoot);
      await verifyCleanupComplete(context, true);
    } else {
      if (cleanupMode === 'hook_then_builtin') {
        await runConfiguredHook(context, 'beforeRemove', false);
      }
      await runBuiltInCleanup(context, cleanupPlan.commands);
      await verifyCleanupComplete(context, true);
    }
  } catch (operationError) {
    status = 'failed';
    error = toOperationError(operationError, 'worktree_cleanup_failed');
  }

  return finalizeOperation(context, {
    status,
    cleanupMode,
    cleanupCommands: normalizeCleanupCommands(cleanupPlan.commands),
    ...(error !== undefined ? { error } : {}),
  });
}

export async function runSymphonyPhysicalWorktreeHook(
  input: RunSymphonyPhysicalWorktreeHookInput,
): Promise<SymphonyWorktreeOperationResult> {
  const context = await createOperationContext('hook', input);
  let status: SymphonyWorktreeOperationResult['status'] = 'succeeded';
  let error: SymphonyWorktreeOperationError | undefined;

  try {
    await assertWorktreeCandidate(context.worktree);
    await assertPhysicalRoots(context);
    await runConfiguredHook(context, input.hookName, true);
  } catch (operationError) {
    status = 'failed';
    error = toOperationError(operationError, 'hook_failed');
  }

  return finalizeOperation(context, {
    status,
    hookName: input.hookName,
    ...(error !== undefined ? { error } : {}),
  });
}

export function buildSymphonyWorktreeSessionArtifacts(
  result: SymphonyWorktreeOperationResult,
): SessionArtifactReference[] {
  return result.artifacts.map((artifact) => ({
    kind: artifact.kind,
    path: artifact.path,
  }));
}

async function createOperationContext(
  operation: SymphonyWorktreeOperation,
  input: SymphonyPhysicalWorktreeInput,
): Promise<OperationContext> {
  const now = input.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const artifactRoot = resolveArtifactRoot(input);

  assertArtifactRootPlacement(input.worktree, artifactRoot);
  await mkdir(input.worktree.containment.expectedParentPath, { recursive: true });
  await mkdir(input.worktree.root, { recursive: true });
  await assertArtifactRootPhysicalParent(input.worktree, artifactRoot);

  return {
    operation,
    workflow: input.workflow,
    worktree: input.worktree,
    issue: input.issue,
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
    artifactRoot,
    commandLogPath: join(artifactRoot, `${operation}-commands.json`),
    manifestPath: join(artifactRoot, `${operation}-manifest.json`),
    cleanupPlanPath: join(artifactRoot, `${operation}-cleanup-plan.json`),
    env: buildCommandEnvironment(input),
    executor: input.executor ?? executeSymphonyWorktreeCommand,
    timeoutMs: input.timeoutMs ?? input.workflow.config.hooks.timeoutMs,
    maxOutputBytes: input.maxOutputBytes ?? defaultMaxOutputBytes,
    now,
    startedAt,
    commands: [],
  };
}

async function assertWorktreeCandidate(
  worktree: OrchestrationWorktree,
): Promise<void> {
  const validation = validateWorktreeCandidate(worktree);

  if (!validation.ok) {
    throw new SymphonyWorktreeAdapterError(
      'invalid_worktree_candidate',
      'Invalid physical Symphony worktree candidate.',
      validation.issues.map((issue) => {
        const path = issue.path.map((segment) => String(segment)).join('.');
        return `${path || '<root>'}: ${issue.message}`;
      }),
    );
  }
}

async function assertPhysicalRoots(context: OperationContext): Promise<void> {
  await assertDirectoryExists(context.worktree.repoRoot, 'repoRoot');
  await mkdir(context.worktree.containment.expectedParentPath, { recursive: true });
  await mkdir(context.worktree.root, { recursive: true });

  const expectedParentRealPath = await realpath(
    context.worktree.containment.expectedParentPath,
  );
  const rootRealPath = await realpath(context.worktree.root);

  if (!isPathContained(expectedParentRealPath, rootRealPath)) {
    throw new SymphonyWorktreeAdapterError(
      'workspace_root_unavailable',
      'Physical worktree root resolves outside its expected parent path.',
      [
        `expectedParentPath=${expectedParentRealPath}`,
        `root=${rootRealPath}`,
      ],
    );
  }

  const requestedPath = resolvePathInsideRealRoot(
    context.worktree.root,
    rootRealPath,
    context.worktree.path,
  );

  if (!isPathContained(rootRealPath, requestedPath)) {
    throw new SymphonyWorktreeAdapterError(
      'path_containment_failed',
      'Physical worktree path resolves outside the configured workspace root.',
      [`root=${rootRealPath}`, `path=${requestedPath}`],
    );
  }

  const artifactRootPath = resolvePathInsideRealRoot(
    context.worktree.root,
    rootRealPath,
    context.artifactRoot,
  );

  if (!isPathContained(rootRealPath, artifactRootPath)) {
    throw new SymphonyWorktreeAdapterError(
      'path_containment_failed',
      'Physical worktree artifact root must stay inside the configured workspace root.',
      [`root=${rootRealPath}`, `artifactRoot=${artifactRootPath}`],
    );
  }
  await assertArtifactRootPhysicalParent(context.worktree, context.artifactRoot);

  if (isPathContained(context.worktree.path, context.artifactRoot)) {
    throw new SymphonyWorktreeAdapterError(
      'path_containment_failed',
      'Physical worktree artifact root must not be nested inside the removable worktree path.',
      [`worktreePath=${context.worktree.path}`, `artifactRoot=${context.artifactRoot}`],
    );
  }
}

async function runBuiltInCreate(context: OperationContext): Promise<void> {
  if (await pathExists(context.worktree.path)) {
    await verifyExpectedGitWorktree(context);
    return;
  }

  await runCommand(context, 'git', ['worktree', 'prune'], context.worktree.repoRoot);

  const existingBranch = await branchExists(context, context.worktree.branch);
  if (existingBranch) {
    await runCommand(
      context,
      'git',
      ['worktree', 'add', context.worktree.path, context.worktree.branch],
      context.worktree.repoRoot,
    );
    return;
  }

  await runCommand(
    context,
    'git',
    [
      'worktree',
      'add',
      '-b',
      context.worktree.branch,
      context.worktree.path,
      context.worktree.baseRef,
    ],
    context.worktree.repoRoot,
  );
}

async function runBuiltInCleanup(
  context: OperationContext,
  commands: readonly WorktreeCleanupCommand[],
): Promise<void> {
  for (const command of commands) {
    if (command.type === 'remove_worktree' && !(await pathExists(context.worktree.path))) {
      context.commands.push(buildSkippedCommand(command, 'worktree path does not exist'));
      continue;
    }

    if (
      command.type === 'delete_branch' &&
      !(await branchExists(context, context.worktree.branch))
    ) {
      context.commands.push(buildSkippedCommand(command, 'worktree branch does not exist'));
      continue;
    }

    const [binary, ...args] = command.argv;
    if (binary === undefined) {
      throw new SymphonyWorktreeAdapterError(
        'worktree_cleanup_failed',
        `Cleanup command ${command.type} is empty.`,
      );
    }
    await runCommand(context, binary, args, command.cwd);
  }
}

async function runConfiguredHook(
  context: OperationContext,
  hookName: SymphonyWorktreeHookName,
  required: boolean,
): Promise<void> {
  const script = context.workflow.config.hooks[hookName];
  if (script === undefined) {
    if (required) {
      throw new SymphonyWorktreeAdapterError(
        'hook_not_configured',
        `Symphony workflow hook "${hookName}" is not configured.`,
      );
    }
    return;
  }

  await runCommand(
    context,
    'bash',
    ['-euo', 'pipefail', '-c', script],
    context.worktree.repoRoot,
  );
}

async function verifyExpectedGitWorktree(
  context: OperationContext,
): Promise<void> {
  if (!(await pathExists(context.worktree.path))) {
    throw new SymphonyWorktreeAdapterError(
      'git_state_mismatch',
      'Expected physical worktree path does not exist after creation.',
      [`path=${context.worktree.path}`],
    );
  }

  const rootRealPath = await realpath(context.worktree.root);
  const worktreeRealPath = await realpath(context.worktree.path);
  if (!isPathContained(rootRealPath, worktreeRealPath)) {
    throw new SymphonyWorktreeAdapterError(
      'path_containment_failed',
      'Created worktree resolves outside the configured workspace root.',
      [`root=${rootRealPath}`, `worktree=${worktreeRealPath}`],
    );
  }

  const topLevel = (
    await runCommand(context, 'git', ['rev-parse', '--show-toplevel'], context.worktree.path)
  ).stdout.trim();
  const topLevelRealPath = await realpath(topLevel);
  if (topLevelRealPath !== worktreeRealPath) {
    throw new SymphonyWorktreeAdapterError(
      'git_state_mismatch',
      'Created path is not the expected git worktree root.',
      [`expected=${worktreeRealPath}`, `actual=${topLevelRealPath}`],
    );
  }

  const currentBranch = (
    await runCommand(context, 'git', ['branch', '--show-current'], context.worktree.path)
  ).stdout.trim();
  if (currentBranch !== context.worktree.branch) {
    throw new SymphonyWorktreeAdapterError(
      'git_state_mismatch',
      'Created git worktree is not checked out on the expected branch.',
      [`expected=${context.worktree.branch}`, `actual=${currentBranch}`],
    );
  }
}

async function verifyCleanupComplete(
  context: OperationContext,
  requireBranchDeleted: boolean,
): Promise<void> {
  if (await pathExists(context.worktree.path)) {
    throw new SymphonyWorktreeAdapterError(
      'worktree_cleanup_failed',
      'Physical worktree path still exists after cleanup.',
      [`path=${context.worktree.path}`],
    );
  }

  if (requireBranchDeleted && (await branchExists(context, context.worktree.branch))) {
    throw new SymphonyWorktreeAdapterError(
      'worktree_cleanup_failed',
      'Physical worktree branch still exists after cleanup.',
      [`branch=${context.worktree.branch}`],
    );
  }
}

async function branchExists(
  context: OperationContext,
  branch: string,
): Promise<boolean> {
  const result = await executeCommand(context, 'git', [
    'rev-parse',
    '--verify',
    `refs/heads/${branch}`,
  ], context.worktree.repoRoot);
  context.commands.push(result);
  return result.exitCode === 0 && !result.timedOut;
}

async function runCommand(
  context: OperationContext,
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<SymphonyWorktreeCommandResult> {
  const result = await executeCommand(context, command, args, cwd);
  context.commands.push(result);

  if (result.timedOut) {
    throw new SymphonyWorktreeAdapterError(
      'command_timeout',
      `Command timed out after ${context.timeoutMs}ms: ${formatCommand(command, args)}`,
      [],
      result,
    );
  }

  if (result.exitCode !== 0) {
    throw new SymphonyWorktreeAdapterError(
      command === 'bash' ? 'hook_failed' : 'command_failed',
      `Command failed with exit code ${String(result.exitCode)}: ${formatCommand(command, args)}`,
      [],
      result,
    );
  }

  return result;
}

async function executeCommand(
  context: OperationContext,
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<SymphonyWorktreeCommandResult> {
  return context.executor({
    command,
    args,
    cwd,
    env: context.env,
    timeoutMs: context.timeoutMs,
    maxOutputBytes: context.maxOutputBytes,
  });
}

async function finalizeOperation(
  context: OperationContext,
  input: {
    readonly status: SymphonyWorktreeOperationResult['status'];
    readonly createMode?: SymphonyWorktreeCreateMode;
    readonly cleanupMode?: SymphonyWorktreeCleanupMode;
    readonly hookName?: SymphonyWorktreeHookName;
    readonly cleanupCommands?: SymphonyWorktreeOperationResult['cleanupCommands'];
    readonly reason?: string;
    readonly error?: SymphonyWorktreeOperationError;
  },
): Promise<SymphonyWorktreeOperationResult> {
  try {
    await writeCommandLogArtifact(context);
    const commandLogArtifact = await buildArtifact(
      'physical_worktree_command_log',
      context.commandLogPath,
    );
    const cleanupPlanArtifact = await buildOptionalArtifact(
      'physical_worktree_cleanup_plan',
      context.cleanupPlanPath,
    );
    const resultWithoutManifest = symphonyWorktreeOperationResultSchema.parse({
      contractVersion: symphonyWorktreeContractVersion,
      operation: context.operation,
      status: input.status,
      worktree: context.worktree,
      issue: context.issue,
      ...(input.createMode !== undefined ? { createMode: input.createMode } : {}),
      ...(input.cleanupMode !== undefined ? { cleanupMode: input.cleanupMode } : {}),
      ...(input.hookName !== undefined ? { hookName: input.hookName } : {}),
      startedAt: context.startedAt,
      completedAt: context.now().toISOString(),
      artifacts:
        cleanupPlanArtifact === undefined
          ? [commandLogArtifact]
          : [commandLogArtifact, cleanupPlanArtifact],
      commands: context.commands,
      cleanupCommands: input.cleanupCommands ?? [],
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
      metadata: buildOperationMetadata(context),
    });

    await writeJson(context.manifestPath, resultWithoutManifest);
    const manifestArtifact = await buildArtifact(
      'physical_worktree_manifest',
      context.manifestPath,
    );

    return symphonyWorktreeOperationResultSchema.parse({
      ...resultWithoutManifest,
      artifacts: [manifestArtifact, ...resultWithoutManifest.artifacts],
    });
  } catch (error) {
    if (input.error !== undefined && input.error.code === 'artifact_write_failed') {
      throw error;
    }

    throw new SymphonyWorktreeAdapterError(
      'artifact_write_failed',
      `Failed to write physical worktree evidence artifacts: ${getErrorMessage(error)}`,
    );
  }
}

async function writeCommandLogArtifact(context: OperationContext): Promise<void> {
  await writeJson(context.commandLogPath, {
    contractVersion: symphonyWorktreeContractVersion,
    operation: context.operation,
    commands: context.commands,
  });
}

async function writeCleanupPlanArtifact(
  context: OperationContext,
  commands: readonly WorktreeCleanupCommand[],
): Promise<void> {
  await writeJson(context.cleanupPlanPath, {
    contractVersion: symphonyWorktreeContractVersion,
    worktreeId: context.worktree.id,
    cleanupPolicy: context.worktree.cleanupPolicy,
    commands: commands.map((command) => ({
      type: command.type,
      cwd: command.cwd,
      argv: [...command.argv],
    })),
  });
}

async function buildArtifact(
  kind: 'physical_worktree_manifest' | 'physical_worktree_command_log' | 'physical_worktree_cleanup_plan',
  path: string,
) {
  return {
    kind,
    path,
    sha256: await sha256File(path),
  };
}

async function buildOptionalArtifact(
  kind: 'physical_worktree_cleanup_plan',
  path: string,
) {
  if (!(await pathExists(path))) {
    return undefined;
  }
  return buildArtifact(kind, path);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function buildOperationMetadata(
  context: OperationContext,
): Record<string, string> {
  return {
    source: 'symphony_physical_worktree_adapter',
    workflowPath: context.workflow.source.path,
    workflowHash: context.workflow.source.hash,
    ...(context.runId !== undefined ? { runId: context.runId } : {}),
    ...(context.attempt !== undefined ? { attempt: String(context.attempt) } : {}),
  };
}

function resolveArtifactRoot(input: SymphonyPhysicalWorktreeInput): string {
  const root =
    input.artifactRoot !== undefined
      ? input.artifactRoot
      : join(
          input.worktree.root,
          '.harness',
          'orchestration',
          'worktrees',
          input.worktree.id,
          sanitizeWorktreeIdentifier(input.runId ?? 'manual-run'),
          `attempt-${String(input.attempt ?? 1).padStart(2, '0')}`,
        );

  return normalize(
    isAbsolute(root) ? root : resolve(input.worktree.root, root),
  );
}

function assertArtifactRootPlacement(
  worktree: OrchestrationWorktree,
  artifactRoot: string,
): void {
  if (!isPathContained(worktree.root, artifactRoot)) {
    throw new SymphonyWorktreeAdapterError(
      'path_containment_failed',
      'Physical worktree artifact root must stay inside the configured workspace root.',
      [`root=${worktree.root}`, `artifactRoot=${artifactRoot}`],
    );
  }

  if (isPathContained(worktree.path, artifactRoot)) {
    throw new SymphonyWorktreeAdapterError(
      'path_containment_failed',
      'Physical worktree artifact root must not be nested inside the removable worktree path.',
      [`worktreePath=${worktree.path}`, `artifactRoot=${artifactRoot}`],
    );
  }
}

async function assertArtifactRootPhysicalParent(
  worktree: OrchestrationWorktree,
  artifactRoot: string,
): Promise<void> {
  const rootRealPath = await realpath(worktree.root);
  const nearestExistingParent = await findNearestExistingParent(artifactRoot);
  const nearestExistingParentRealPath = await realpath(nearestExistingParent);

  if (!isPathContained(rootRealPath, nearestExistingParentRealPath)) {
    throw new SymphonyWorktreeAdapterError(
      'path_containment_failed',
      'Physical worktree artifact root resolves through a parent outside the configured workspace root.',
      [
        `root=${rootRealPath}`,
        `artifactRoot=${artifactRoot}`,
        `nearestExistingParent=${nearestExistingParentRealPath}`,
      ],
    );
  }
}

async function findNearestExistingParent(path: string): Promise<string> {
  let current = path;

  while (!(await pathExists(current))) {
    const parent = dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }

  return current;
}

function buildCommandEnvironment(
  input: SymphonyPhysicalWorktreeInput,
): Record<string, string> {
  return normalizeEnv({
    ...selectSafeHostEnv(process.env),
    ...(input.env ?? {}),
    ISSUE_ID: input.issue.id,
    ISSUE_IDENTIFIER: input.issue.identifier ?? input.issue.id,
    ISSUE_TITLE: input.issue.title ?? input.issue.identifier ?? input.issue.id,
    ISSUE_URL: input.issue.url,
    ISSUE_STATE: input.issue.state,
    ISSUE_BRANCH: input.worktree.branch,
    ISSUE_WORKTREE: input.worktree.path,
    ISSUE_WORKTREE_PATH: input.worktree.path,
    WORKSPACE_ROOT: input.worktree.root,
    WORKTREE_ROOT: input.worktree.root,
    REPO_ROOT: input.worktree.repoRoot,
    BASE_REF: input.worktree.baseRef,
    WORKFLOW_PATH: input.workflow.source.path,
    WORKFLOW_DIR: input.workflow.source.directory,
    RUN_ID: input.runId,
    ATTEMPT: input.attempt !== undefined ? String(input.attempt) : undefined,
  });
}

function selectSafeHostEnv(
  env: NodeJS.ProcessEnv,
): Record<string, string | undefined> {
  return {
    PATH: env['PATH'],
    HOME: env['HOME'],
    TMPDIR: env['TMPDIR'],
    TEMP: env['TEMP'],
    TMP: env['TMP'],
    USERPROFILE: env['USERPROFILE'],
    SystemRoot: env['SystemRoot'],
    ComSpec: env['ComSpec'],
  };
}

function normalizeEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function resolvePathInsideRealRoot(
  configuredRoot: string,
  realRoot: string,
  childPath: string,
): string {
  const relativeChild = relative(normalize(configuredRoot), normalize(childPath));
  return resolve(realRoot, relativeChild);
}

async function assertDirectoryExists(path: string, label: string): Promise<void> {
  try {
    const stats = await stat(path);
    if (!stats.isDirectory()) {
      throw new SymphonyWorktreeAdapterError(
        label === 'repoRoot' ? 'repo_root_unavailable' : 'workspace_root_unavailable',
        `${label} is not a directory: ${path}`,
      );
    }
  } catch (error) {
    if (error instanceof SymphonyWorktreeAdapterError) {
      throw error;
    }

    throw new SymphonyWorktreeAdapterError(
      label === 'repoRoot' ? 'repo_root_unavailable' : 'workspace_root_unavailable',
      `${label} is not available: ${path}`,
      [getErrorMessage(error)],
    );
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    accessSync(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function buildSkippedCommand(
  command: { cwd: string; argv: readonly string[] },
  skippedReason: string,
): SymphonyWorktreeCommandResult {
  const [binary, ...args] = command.argv;
  return {
    command: binary ?? '<empty>',
    args,
    cwd: command.cwd,
    exitCode: 0,
    timedOut: false,
    durationMs: 0,
    stdout: '',
    stderr: '',
    skippedReason,
  };
}

function normalizeCleanupCommands(
  commands: readonly WorktreeCleanupCommand[],
): SymphonyWorktreeOperationResult['cleanupCommands'] {
  return commands.map((command) => ({
    type: command.type,
    cwd: command.cwd,
    argv: [...command.argv],
  }));
}

function toOperationError(
  error: unknown,
  fallbackCode: SymphonyWorktreeErrorCode,
): SymphonyWorktreeOperationError {
  if (error instanceof SymphonyWorktreeAdapterError) {
    return {
      code: error.code,
      message: error.message,
      issues: [...error.issues],
      ...(error.command !== undefined ? { command: error.command } : {}),
    };
  }

  return {
    code: fallbackCode,
    message: getErrorMessage(error),
    issues: [],
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatCommand(command: string, args: readonly string[]): string {
  return [command, ...args].join(' ');
}

function appendOutput(
  current: string,
  chunk: Buffer,
  maxBytes = defaultMaxOutputBytes,
): string {
  return truncateOutput(`${current}${chunk.toString('utf8')}`, maxBytes);
}

function terminateChildProcess(
  child: ChildProcess,
  signal: NodeJS.Signals,
): void {
  if (child.pid === undefined) {
    return;
  }

  try {
    if (process.platform !== 'win32') {
      process.kill(-child.pid, signal);
      return;
    }
    child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Process already exited between timeout scheduling and termination.
    }
  }
}

function truncateOutput(value: string | Buffer, maxBytes = defaultMaxOutputBytes): string {
  const raw = Buffer.isBuffer(value) ? value.toString('utf8') : value;
  if (Buffer.byteLength(raw, 'utf8') <= maxBytes) {
    return raw;
  }

  return `${raw.slice(0, maxBytes)}\n[truncated to ${maxBytes} bytes]`;
}
