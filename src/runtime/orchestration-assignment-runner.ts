import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  csqrLiteScorecardSchema,
  type CsqrLiteScorecard,
} from '../contracts/csqr-lite-contracts.js';
import type { SessionContext } from '../contracts/session-contracts.js';
import {
  symphonyAssignmentRunnerContractVersion,
  symphonyAssignmentRunnerInputSchema,
  symphonyAssignmentRunnerResultSchema,
  isPathInside,
  type SymphonyAssignmentRunnerEvidenceArtifact,
  type SymphonyAssignmentRunnerEvidenceArtifactKind,
  type SymphonyAssignmentRunnerInput,
  type SymphonyAssignmentRunnerResult,
} from '../contracts/orchestration-assignment-runner-contracts.js';
import type { SymphonyWorktreeCommandResult } from '../contracts/symphony-worktree-contracts.js';
import {
  cleanupSymphonyPhysicalWorktree,
  createSymphonyPhysicalWorktree,
  executeSymphonyWorktreeCommand,
  type SymphonyWorktreeCommandExecutor,
} from './symphony-worktree-adapter.js';
import { loadSymphonyWorkflow } from './symphony-workflow.js';
import { saveHarnessArtifact } from './harness-artifact-registry.js';
import { SessionOrchestrator } from './session-orchestrator.js';

export interface SymphonyAssignmentRunnerDependencies {
  readonly executor?: SymphonyWorktreeCommandExecutor;
  readonly orchestrator?: Pick<SessionOrchestrator, 'close'>;
  readonly prepareWorkspace?: (
    input: SymphonyAssignmentRunnerInput,
    evidenceRoot: string,
  ) => Promise<void>;
  readonly cleanupWorkspace?: (
    input: SymphonyAssignmentRunnerInput,
    evidenceRoot: string,
    succeeded: boolean,
  ) => Promise<string | undefined>;
  readonly now?: () => Date;
}

interface ExpectedEvidencePaths {
  readonly diagnosticLog: string;
  readonly testReport: string;
  readonly e2eReport: string;
  readonly screenshot: string;
  readonly csqrLiteScorecard: string;
}

interface RunnerFailure {
  readonly message: string;
  readonly commandResult?: SymphonyWorktreeCommandResult;
}

export async function runSymphonyAssignment(
  rawInput: unknown,
  dependencies: SymphonyAssignmentRunnerDependencies = {},
): Promise<SymphonyAssignmentRunnerResult> {
  const input = symphonyAssignmentRunnerInputSchema.parse(rawInput);
  const now = dependencies.now ?? (() => new Date());
  const startedAt = now();
  const evidenceRoot = resolveEvidenceRoot(input);
  const evidencePaths = buildExpectedEvidencePaths(evidenceRoot);
  const orchestrator = dependencies.orchestrator ?? new SessionOrchestrator();
  const evidenceArtifacts: SymphonyAssignmentRunnerEvidenceArtifact[] = [];
  let commandResult: SymphonyWorktreeCommandResult | undefined;
  let failure: RunnerFailure | undefined;
  let cleanupEligible = false;

  try {
    await assertPersistentEvidenceRoot(input, evidenceRoot);
    await mkdir(evidenceRoot, { recursive: true });
    cleanupEligible = true;
    await (dependencies.prepareWorkspace ?? preparePhysicalWorkspace)(
      input,
      evidenceRoot,
    );
    commandResult = await executeAssignmentCommand(
      input,
      evidenceRoot,
      evidencePaths,
      dependencies.executor,
    );
    await writeDiagnosticLog(evidencePaths.diagnosticLog, {
      contractVersion: symphonyAssignmentRunnerContractVersion,
      assignmentId: input.assignment.id,
      issueId: input.issue.id,
      runId: input.session.runId,
      commandResult,
    });

    evidenceArtifacts.push(
      await registerRunnerArtifact(input, {
        kind: 'diagnostic_log',
        path: evidencePaths.diagnosticLog,
        createdAt: now().toISOString(),
      }),
    );

    if (commandResult.timedOut) {
      failure = {
        message: `Assignment command timed out after ${input.runner.timeoutMs}ms.`,
        commandResult,
      };
    } else if (commandResult.exitCode !== 0) {
      failure = {
        message: `Assignment command failed with exit code ${String(commandResult.exitCode)}.`,
        commandResult,
      };
    } else {
      const reportFailure = await collectRequiredEvidenceArtifacts({
        input,
        evidencePaths,
        evidenceArtifacts,
        createdAt: now().toISOString(),
      });
      if (reportFailure !== undefined) {
        failure = { message: reportFailure, commandResult };
      }
    }
  } catch (error) {
    failure = {
      message: getErrorMessage(error),
      ...(commandResult !== undefined ? { commandResult } : {}),
    };
    if (await pathExists(evidenceRoot)) {
      await writeAndRegisterDiagnosticLog({
        input,
        evidencePaths,
        evidenceArtifacts,
        createdAt: now().toISOString(),
        payload: {
          contractVersion: symphonyAssignmentRunnerContractVersion,
          assignmentId: input.assignment.id,
          issueId: input.issue.id,
          runId: input.session.runId,
          error: failure.message,
          ...(commandResult !== undefined ? { commandResult } : {}),
        },
      });
    }
  } finally {
    if (input.runner.cleanupWorktree && cleanupEligible) {
      try {
        const cleanupFailureMessage = await (
          dependencies.cleanupWorkspace ?? cleanupPhysicalWorkspace
        )(input, evidenceRoot, failure === undefined);
        if (cleanupFailureMessage !== undefined) {
          failure = mergeCleanupFailure(
            failure,
            cleanupFailureMessage,
            commandResult,
          );
          await writeAndRegisterDiagnosticLog({
            input,
            evidencePaths,
            evidenceArtifacts,
            createdAt: now().toISOString(),
            payload: {
              contractVersion: symphonyAssignmentRunnerContractVersion,
              assignmentId: input.assignment.id,
              issueId: input.issue.id,
              runId: input.session.runId,
              error: failure.message,
              cleanupError: cleanupFailureMessage,
              ...(commandResult !== undefined ? { commandResult } : {}),
            },
          });
        }
      } catch (cleanupError) {
        const cleanupFailureMessage = `Assignment cleanup failed: ${getErrorMessage(cleanupError)}`;
        failure = mergeCleanupFailure(
          failure,
          cleanupFailureMessage,
          commandResult,
        );
        if (await pathExists(evidenceRoot)) {
          await writeAndRegisterDiagnosticLog({
            input,
            evidencePaths,
            evidenceArtifacts,
            createdAt: now().toISOString(),
            payload: {
              contractVersion: symphonyAssignmentRunnerContractVersion,
              assignmentId: input.assignment.id,
              issueId: input.issue.id,
              runId: input.session.runId,
              error: failure.message,
              cleanupError: cleanupFailureMessage,
              ...(commandResult !== undefined ? { commandResult } : {}),
            },
          });
        }
      }
    }
  }

  const closeResult = await closeAssignmentSession({
    input,
    orchestrator,
    failure,
    evidenceArtifacts,
    evidencePaths,
    completedAt: now().toISOString(),
  });
  const completedAt = now();

  return symphonyAssignmentRunnerResultSchema.parse({
    contractVersion: symphonyAssignmentRunnerContractVersion,
    assignmentId: input.assignment.id,
    issueId: input.issue.id,
    runId: input.session.runId,
    status: failure === undefined ? 'succeeded' : 'failed',
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    ...(commandResult !== undefined ? { commandResult } : {}),
    evidenceArtifacts,
    evidenceArtifactIds: evidenceArtifacts.map((artifact) => artifact.id),
    csqrLiteScorecardArtifactIds:
      closeResult.csqrLiteScorecardArtifactIds ?? [],
    checkpointId: closeResult.checkpoint.id,
    summary:
      failure === undefined
        ? `Assignment ${input.assignment.id} completed through the agent runner.`
        : `Assignment ${input.assignment.id} failed through the agent runner: ${failure.message}`,
    ...(failure !== undefined ? { error: failure.message } : {}),
    durationMs: commandResult?.durationMs ?? 0,
  });
}

async function executeAssignmentCommand(
  input: SymphonyAssignmentRunnerInput,
  evidenceRoot: string,
  evidencePaths: ExpectedEvidencePaths,
  executor: SymphonyWorktreeCommandExecutor | undefined,
): Promise<SymphonyWorktreeCommandResult> {
  const execute = executor ?? executeSymphonyWorktreeCommand;
  return execute({
    command: input.runner.command,
    args: input.runner.args,
    cwd: input.worktree.path,
    env: {
      ...process.env,
      ...input.runner.env,
      HARNESS_ASSIGNMENT_ID: input.assignment.id,
      HARNESS_ISSUE_ID: input.issue.id,
      HARNESS_RUN_ID: input.session.runId,
      HARNESS_WORKTREE_ID: input.worktree.id,
      HARNESS_SUBAGENT_ID: input.subagent.id,
      HARNESS_EVIDENCE_ROOT: evidenceRoot,
      HARNESS_TEST_REPORT_PATH: evidencePaths.testReport,
      HARNESS_E2E_REPORT_PATH: evidencePaths.e2eReport,
      HARNESS_SCREENSHOT_PATH: evidencePaths.screenshot,
      HARNESS_CSQR_SCORECARD_PATH: evidencePaths.csqrLiteScorecard,
    },
    timeoutMs: input.runner.timeoutMs,
    maxOutputBytes: input.runner.maxOutputBytes,
  });
}

async function collectRequiredEvidenceArtifacts(input: {
  readonly input: SymphonyAssignmentRunnerInput;
  readonly evidencePaths: ExpectedEvidencePaths;
  readonly evidenceArtifacts: SymphonyAssignmentRunnerEvidenceArtifact[];
  readonly createdAt: string;
}): Promise<string | undefined> {
  for (const kind of input.input.runner.requiredEvidenceArtifactKinds) {
    const path = evidencePathForKind(input.evidencePaths, kind);
    const exists = await pathExists(path);
    if (!exists) {
      return `Required ${kind} artifact was not produced at ${path}.`;
    }
    if (kind !== 'screenshot') {
      await assertJsonObject(path, `${kind} artifact`);
    }
    input.evidenceArtifacts.push(
      await registerRunnerArtifact(input.input, {
        kind,
        path,
        createdAt: input.createdAt,
      }),
    );
  }

  if (!input.input.runner.includeCsqrLiteScorecard) {
    return 'CSQR-lite scorecard emission is disabled; done assignment closes require CSQR-lite evidence.';
  }

  if (!(await pathExists(input.evidencePaths.csqrLiteScorecard))) {
    return `Required csqr_lite_scorecard artifact was not produced at ${input.evidencePaths.csqrLiteScorecard}.`;
  }

  await readCsqrLiteScorecard(input.evidencePaths.csqrLiteScorecard, input.input.session.runId);
  return undefined;
}

async function closeAssignmentSession(input: {
  readonly input: SymphonyAssignmentRunnerInput;
  readonly orchestrator: Pick<SessionOrchestrator, 'close'>;
  readonly failure?: RunnerFailure;
  readonly evidenceArtifacts: readonly SymphonyAssignmentRunnerEvidenceArtifact[];
  readonly evidencePaths: ExpectedEvidencePaths;
  readonly completedAt: string;
}) {
  const context: SessionContext = input.input.session;
  const artifactIds = input.evidenceArtifacts.map((artifact) => artifact.id);

  if (input.failure !== undefined) {
    return input.orchestrator.close(context, {
      title: 'assignment-runner-failed',
      summary: input.failure.message,
      taskStatus: 'failed',
      nextStep: 'Inspect assignment runner diagnostics and retry through recovery.',
      artifactIds,
      persistToMem0: false,
      memoryContent: input.failure.message,
    });
  }

  const scorecard = await readCsqrLiteScorecard(
    input.evidencePaths.csqrLiteScorecard,
    context.runId,
  );
  return input.orchestrator.close(context, {
    title: 'assignment-runner-done',
    summary: `Assignment ${input.input.assignment.id} completed with command-produced evidence and CSQR-lite scorecard ${scorecard.id}.`,
    taskStatus: 'done',
    nextStep: 'Promote dependent work or inspect final evidence.',
    artifactIds,
    csqrLiteScorecards: [
      {
        path: input.evidencePaths.csqrLiteScorecard,
        scorecard,
      },
    ],
    persistToMem0: false,
    memoryContent: `Assignment ${input.input.assignment.id} completed.`,
  });
}

async function preparePhysicalWorkspace(
  input: SymphonyAssignmentRunnerInput,
  evidenceRoot: string,
): Promise<void> {
  if (input.runner.workspaceMode !== 'create_physical_worktree') {
    await assertDirectory(input.worktree.path, 'worktree.path');
    return;
  }

  const workflow = loadSymphonyWorkflow({
    workflowPath: input.runner.workflowPath,
    cwd: input.worktree.repoRoot,
    env: process.env,
  });
  const createResult = await createSymphonyPhysicalWorktree({
    workflow,
    worktree: input.worktree,
    issue: {
      id: input.issue.id,
      title: input.issue.task,
      state: input.issue.status,
      metadata: {
        assignmentId: input.assignment.id,
        subagentId: input.subagent.id,
      },
    },
    runId: input.session.runId,
    artifactRoot: join(evidenceRoot, 'physical-worktree-create'),
    env: input.runner.env,
    timeoutMs: input.runner.timeoutMs,
    maxOutputBytes: input.runner.maxOutputBytes,
  });

  if (createResult.status !== 'succeeded') {
    throw new Error(
      createResult.error?.message ??
        `Physical worktree creation failed for ${input.worktree.path}.`,
    );
  }
}

async function cleanupPhysicalWorkspace(
  input: SymphonyAssignmentRunnerInput,
  evidenceRoot: string,
  succeeded: boolean,
): Promise<string | undefined> {
  if (input.runner.workspaceMode !== 'create_physical_worktree') {
    return undefined;
  }

  const workflow = loadSymphonyWorkflow({
    workflowPath: input.runner.workflowPath,
    cwd: input.worktree.repoRoot,
    env: process.env,
  });
  const result = await cleanupSymphonyPhysicalWorktree({
    workflow,
    worktree: input.worktree,
    issue: {
      id: input.issue.id,
      title: input.issue.task,
      state: succeeded ? 'done' : 'failed',
      metadata: {
        assignmentId: input.assignment.id,
        subagentId: input.subagent.id,
      },
    },
    runId: input.session.runId,
    outcome: succeeded ? 'success' : 'failure',
    artifactRoot: join(evidenceRoot, 'physical-worktree-cleanup'),
    env: input.runner.env,
    timeoutMs: input.runner.timeoutMs,
    maxOutputBytes: input.runner.maxOutputBytes,
  });
  if (result.status === 'failed') {
    return (
      result.error?.message ??
      `Physical worktree cleanup failed for ${input.worktree.path}.`
    );
  }
  return undefined;
}

async function writeAndRegisterDiagnosticLog(input: {
  readonly input: SymphonyAssignmentRunnerInput;
  readonly evidencePaths: ExpectedEvidencePaths;
  readonly evidenceArtifacts: SymphonyAssignmentRunnerEvidenceArtifact[];
  readonly createdAt: string;
  readonly payload: unknown;
}): Promise<void> {
  await writeDiagnosticLog(input.evidencePaths.diagnosticLog, input.payload);
  const alreadyRegistered = input.evidenceArtifacts.some(
    (artifact) =>
      artifact.kind === 'diagnostic_log' &&
      artifact.path === input.evidencePaths.diagnosticLog,
  );
  if (!alreadyRegistered) {
    input.evidenceArtifacts.push(
      await registerRunnerArtifact(input.input, {
        kind: 'diagnostic_log',
        path: input.evidencePaths.diagnosticLog,
        createdAt: input.createdAt,
      }),
    );
  }
}

function mergeCleanupFailure(
  failure: RunnerFailure | undefined,
  cleanupFailureMessage: string,
  commandResult: SymphonyWorktreeCommandResult | undefined,
): RunnerFailure {
  if (failure === undefined) {
    return {
      message: cleanupFailureMessage,
      ...(commandResult !== undefined ? { commandResult } : {}),
    };
  }
  const mergedCommandResult = failure.commandResult ?? commandResult;
  return {
    message: `${failure.message} ${cleanupFailureMessage}`,
    ...(mergedCommandResult !== undefined
      ? { commandResult: mergedCommandResult }
      : {}),
  };
}

async function registerRunnerArtifact(
  input: SymphonyAssignmentRunnerInput,
  artifact: {
    readonly kind: SymphonyAssignmentRunnerEvidenceArtifact['kind'];
    readonly path: string;
    readonly createdAt: string;
  },
): Promise<SymphonyAssignmentRunnerEvidenceArtifact> {
  const metadata = buildArtifactMetadata(input, artifact.kind);
  const saved = saveHarnessArtifact({
    dbPath: input.session.dbPath,
    projectId: input.session.projectId,
    campaignId: input.session.campaignId,
    issueId: input.issue.id,
    kind: artifact.kind,
    path: artifact.path,
    metadata,
    createdAt: artifact.createdAt,
  });

  return {
    id: saved.artifactId,
    kind: artifact.kind,
    path: artifact.path,
    metadata,
  };
}

function buildArtifactMetadata(
  input: SymphonyAssignmentRunnerInput,
  kind: string,
): Record<string, string> {
  return {
    source: 'symphony_assignment_runner',
    runId: input.session.runId,
    assignmentId: input.assignment.id,
    issueId: input.issue.id,
    subagentId: input.subagent.id,
    worktreeId: input.worktree.id,
    evidenceKind: kind,
  };
}

function resolveEvidenceRoot(input: SymphonyAssignmentRunnerInput): string {
  return resolve(
    input.runner.evidenceRoot ??
      join(
        input.worktree.repoRoot,
        '.harness',
        'orchestration',
        'assignment-runs',
        sanitizeSegment(input.assignment.id),
        sanitizeSegment(input.session.runId),
      ),
  );
}

async function assertPersistentEvidenceRoot(
  input: SymphonyAssignmentRunnerInput,
  evidenceRoot: string,
): Promise<void> {
  const worktreePath = resolve(input.worktree.path);
  if (isPathInside(worktreePath, evidenceRoot)) {
    throw new Error(
      `Assignment evidence root must not be inside removable worktree path: ${evidenceRoot}`,
    );
  }
}

function buildExpectedEvidencePaths(evidenceRoot: string): ExpectedEvidencePaths {
  return {
    diagnosticLog: join(evidenceRoot, 'assignment-command-diagnostic.json'),
    testReport: join(evidenceRoot, 'test-report.json'),
    e2eReport: join(evidenceRoot, 'e2e-report.json'),
    screenshot: join(evidenceRoot, 'screenshot.png'),
    csqrLiteScorecard: join(evidenceRoot, 'csqr-lite-scorecard.json'),
  };
}

function evidencePathForKind(
  paths: ExpectedEvidencePaths,
  kind: SymphonyAssignmentRunnerEvidenceArtifactKind,
): string {
  switch (kind) {
    case 'test_report':
      return paths.testReport;
    case 'e2e_report':
      return paths.e2eReport;
    case 'screenshot':
      return paths.screenshot;
  }
}

async function assertDirectory(path: string, label: string): Promise<void> {
  let entry;
  try {
    entry = await stat(path);
  } catch {
    throw new Error(`${label} does not exist: ${path}`);
  }
  if (!entry.isDirectory()) {
    throw new Error(`${label} is not a directory: ${path}`);
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

async function assertJsonObject(path: string, label: string): Promise<void> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} must contain a JSON object.`);
  }
}

async function readCsqrLiteScorecard(
  path: string,
  runId: string,
): Promise<CsqrLiteScorecard> {
  const parsed = csqrLiteScorecardSchema.parse(
    JSON.parse(await readFile(path, 'utf8')) as unknown,
  );
  if (parsed.scope !== 'run' || parsed.runId !== runId) {
    throw new Error(
      `CSQR-lite scorecard at ${path} must be run-scoped for run ${runId}.`,
    );
  }
  return parsed;
}

async function writeDiagnosticLog(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function sanitizeSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized.length > 0 ? sanitized : 'assignment';
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
