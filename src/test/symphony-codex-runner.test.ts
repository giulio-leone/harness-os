import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildSymphonyCodexAppServerCommand,
  createScriptedCodexAppServerProcessAdapter,
  deriveSymphonyCodexSessionId,
  launchCodexAppServerRunner,
  loadSymphonyWorkflowFromText,
  symphonyCodexRunnerLaunchResultSchema,
  symphonyCodexRunnerTurnResultSchema,
  type CodexAppServerProcessAdapter,
  type CodexAppServerRunner,
  type CodexAppServerRunnerLaunch,
  type CodexAppServerTransportRequest,
  type SymphonyWorkflowDocument,
} from '../index.js';

const instantNow = () => new Date('2026-05-12T12:00:00.000Z');

test('buildSymphonyCodexAppServerCommand preserves WORKFLOW command as shell input', () => {
  const command = buildSymphonyCodexAppServerCommand({
    command: ' codex app-server --json ',
    cwd: '/workspace/repo',
    env: {
      CODEX_HOME: '/workspace/.codex',
      OMITTED: undefined,
    },
  });

  assert.equal(command.cwd, '/workspace/repo');
  assert.equal(command.args.at(-1), 'codex app-server --json');
  assert.deepEqual(command.env, {
    CODEX_HOME: '/workspace/.codex',
  });
});

test('launchCodexAppServerRunner initializes a fake app-server and creates a thread', async (t) => {
  const cwd = createTempCwd(t);
  const workflow = createWorkflow(cwd);
  const adapter = createScriptedCodexAppServerProcessAdapter([
    {
      kind: 'response',
      method: 'initialize',
      response: { status: 'initialized', runnerId: 'runner-001' },
    },
    {
      kind: 'response',
      method: 'thread.create',
      response: { threadId: 'thread-001' },
    },
  ]);

  const launch = await launchCodexAppServerRunner({
    workflow,
    processAdapter: adapter,
    now: instantNow,
  });

  assert.equal(launch.result.status, 'succeeded');
  assert.deepEqual(launch.result.conversation, {
    runnerId: 'runner-001',
    threadId: 'thread-001',
  });
  assert.ok(symphonyCodexRunnerLaunchResultSchema.safeParse(launch.result).success);
  assert.equal(adapter.launchedCommands.length, 1);
  assert.equal(adapter.launchedCommands[0]?.cwd, cwd);
  assert.equal(adapter.launchedCommands[0]?.args.at(-1), 'codex app-server --json');
  assert.deepEqual(
    adapter.requests.map((request) => request.method),
    ['initialize', 'thread.create'],
  );
});

test('Codex runner turns derive Symphony session identity from thread and turn ids', async (t) => {
  const cwd = createTempCwd(t);
  const adapter = createScriptedCodexAppServerProcessAdapter([
    {
      kind: 'response',
      method: 'initialize',
      response: {
        status: 'ready',
        runnerId: 'runner-identity',
        threadId: 'thread-stable',
      },
    },
    {
      kind: 'response',
      method: 'turn.start',
      response: {
        status: 'completed',
        turnId: 'turn-001',
        sessionId: 'thread-stable-turn-001',
        output: 'Implemented the first slice.',
      },
    },
    {
      kind: 'response',
      method: 'turn.start',
      response: {
        status: 'succeeded',
        turnId: 'turn-002',
        output: 'Continued on the same thread.',
      },
    },
  ]);
  const runner = requireRunner(
    await launchCodexAppServerRunner({
      cwd,
      processAdapter: adapter,
      now: instantNow,
      idFactory: deterministicIds,
    }),
  );

  const firstTurn = await runner.startTurn({
    prompt: 'Implement slice one.',
    turnId: 'turn-001',
    issueId: 'M10-I3',
  });
  const secondTurn = await runner.startTurn({
    prompt: 'Continue the implementation.',
    turnId: 'turn-002',
  });

  assert.equal(firstTurn.status, 'succeeded');
  assert.equal(secondTurn.status, 'succeeded');
  assert.equal(firstTurn.conversation.threadId, 'thread-stable');
  assert.equal(secondTurn.conversation.threadId, 'thread-stable');
  assert.equal(firstTurn.turn?.sessionId, 'thread-stable-turn-001');
  assert.equal(secondTurn.turn?.sessionId, 'thread-stable-turn-002');
  assert.notEqual(firstTurn.turn?.sessionId, secondTurn.turn?.sessionId);
  assert.equal(
    deriveSymphonyCodexSessionId({
      threadId: 'thread-stable',
      turnId: 'turn-001',
    }),
    firstTurn.turn?.sessionId,
  );
  assert.ok(symphonyCodexRunnerTurnResultSchema.safeParse(firstTurn).success);
  assert.deepEqual(
    adapter.requests.map((request) => request.method),
    ['initialize', 'turn.start', 'turn.start'],
  );
  assert.deepEqual(adapter.requests[1]?.params, {
    runnerId: 'runner-identity',
    threadId: 'thread-stable',
    turnId: 'turn-001',
    prompt: 'Implement slice one.',
    issueId: 'M10-I3',
    metadata: {},
  });
});

test('launchCodexAppServerRunner normalizes startup, read, and cwd failures', async (t) => {
  const launchHang = await launchCodexAppServerRunner({
    cwd: createTempCwd(t),
    processAdapter: {
      launch: () => new Promise<never>(() => undefined),
    },
    readTimeoutMs: 5,
    now: instantNow,
  });
  assert.equal(launchHang.result.status, 'failed');
  assert.equal(launchHang.result.error?.code, 'startup_timeout');

  let lateLaunchCloseCalls = 0;
  const lateLaunch = await launchCodexAppServerRunner({
    cwd: createTempCwd(t),
    processAdapter: {
      launch: () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              async request() {
                return {
                  status: 'ready',
                  runnerId: 'runner-late',
                  threadId: 'thread-late',
                };
              },
              close() {
                lateLaunchCloseCalls += 1;
              },
            });
          }, 25);
        }),
    },
    readTimeoutMs: 5,
    now: instantNow,
  });
  assert.equal(lateLaunch.result.status, 'failed');
  assert.equal(lateLaunch.result.error?.code, 'startup_timeout');
  assert.equal(lateLaunch.result.error?.details.lateLaunchStatus, 'resolved');
  assert.equal(lateLaunch.result.error?.details.closeStatus, 'closed');
  assert.equal(lateLaunchCloseCalls, 1);

  let lateLaunchHangingCloseCalled = false;
  const lateLaunchHangingClose = await launchCodexAppServerRunner({
    cwd: createTempCwd(t),
    processAdapter: {
      launch: () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              async request() {
                return {
                  status: 'ready',
                  runnerId: 'runner-late-close',
                  threadId: 'thread-late-close',
                };
              },
              close() {
                lateLaunchHangingCloseCalled = true;
                return new Promise<never>(() => undefined);
              },
            });
          }, 25);
        }),
    },
    readTimeoutMs: 5,
    now: instantNow,
  });
  assert.equal(lateLaunchHangingClose.result.status, 'failed');
  assert.equal(lateLaunchHangingClose.result.error?.code, 'startup_timeout');
  assert.equal(
    lateLaunchHangingClose.result.error?.details.lateLaunchStatus,
    'resolved',
  );
  assert.equal(lateLaunchHangingClose.result.error?.details.closeStatus, 'timeout');
  assert.equal(lateLaunchHangingCloseCalled, true);

  let hangingCloseCalled = false;
  const startupTimeoutWithHangingClose = await launchCodexAppServerRunner({
    cwd: createTempCwd(t),
    processAdapter: {
      async launch() {
        return {
          request: () => new Promise<never>(() => undefined),
          close() {
            hangingCloseCalled = true;
            return new Promise<never>(() => undefined);
          },
        };
      },
    },
    readTimeoutMs: 5,
    now: instantNow,
  });
  assert.equal(startupTimeoutWithHangingClose.result.status, 'failed');
  assert.equal(startupTimeoutWithHangingClose.result.error?.code, 'startup_timeout');
  assert.equal(
    startupTimeoutWithHangingClose.result.error?.details.closeStatus,
    'timeout',
  );
  assert.equal(hangingCloseCalled, true);

  const startupTimeout = await launchCodexAppServerRunner({
    cwd: createTempCwd(t),
    processAdapter: createScriptedCodexAppServerProcessAdapter([
      { kind: 'hang', method: 'initialize' },
    ]),
    readTimeoutMs: 5,
    now: instantNow,
  });
  assert.equal(startupTimeout.result.status, 'failed');
  assert.equal(startupTimeout.result.error?.code, 'startup_timeout');

  const threadReadTimeout = await launchCodexAppServerRunner({
    cwd: createTempCwd(t),
    processAdapter: createScriptedCodexAppServerProcessAdapter([
      {
        kind: 'response',
        method: 'initialize',
        response: { status: 'initialized', runnerId: 'runner-timeout' },
      },
      { kind: 'hang', method: 'thread.create' },
    ]),
    readTimeoutMs: 5,
    now: instantNow,
  });
  assert.equal(threadReadTimeout.result.status, 'failed');
  assert.equal(threadReadTimeout.result.error?.code, 'read_timeout');

  const invalidCwdAdapter = createScriptedCodexAppServerProcessAdapter([]);
  const invalidCwd = await launchCodexAppServerRunner({
    cwd: 'relative/path',
    processAdapter: invalidCwdAdapter,
    now: instantNow,
  });
  assert.equal(invalidCwd.result.status, 'failed');
  assert.equal(invalidCwd.result.error?.code, 'invalid_workspace_cwd');
  assert.equal(invalidCwdAdapter.launchedCommands.length, 0);
});

test('launchCodexAppServerRunner normalizes missing binary and malformed startup responses', async (t) => {
  const missingBinary = await launchCodexAppServerRunner({
    cwd: createTempCwd(t),
    processAdapter: createScriptedCodexAppServerProcessAdapter([], {
      launchError: {
        code: 'codex_not_found',
        message: 'codex executable was not found on PATH.',
      },
    }),
    now: instantNow,
  });
  assert.equal(missingBinary.result.status, 'failed');
  assert.equal(missingBinary.result.error?.code, 'codex_not_found');

  let closeCalls = 0;
  const malformedAdapter: CodexAppServerProcessAdapter = {
    async launch() {
      return {
        async request() {
          return { ok: true };
        },
        close() {
          closeCalls += 1;
        },
      };
    },
  };
  const malformed = await launchCodexAppServerRunner({
    cwd: createTempCwd(t),
    processAdapter: malformedAdapter,
    now: instantNow,
  });
  assert.equal(malformed.result.status, 'failed');
  assert.equal(malformed.result.error?.code, 'malformed_response');
  assert.ok(malformed.result.error?.issues.some((issue) => issue.includes('status')));
  assert.equal(closeCalls, 1);
});

test('Codex runner normalizes turn timeout and transport closure', async (t) => {
  let timeoutCloseCalls = 0;
  const timeoutRunner = requireRunner(
    await launchCodexAppServerRunner({
      cwd: createTempCwd(t),
      processAdapter: {
        async launch() {
          return {
            async request(request: CodexAppServerTransportRequest) {
              if (request.method === 'initialize') {
                return {
                  status: 'ready',
                  runnerId: 'runner-timeout',
                  threadId: 'thread-timeout',
                };
              }
              return new Promise(() => undefined);
            },
            close() {
              timeoutCloseCalls += 1;
            },
          };
        },
      },
      turnTimeoutMs: 5,
      now: instantNow,
    }),
  );
  const timedOutTurn = await timeoutRunner.startTurn({
    prompt: 'This turn will hang.',
    turnId: 'turn-timeout',
  });
  assert.equal(timedOutTurn.status, 'failed');
  assert.equal(timedOutTurn.error?.code, 'turn_timeout');
  assert.equal(timedOutTurn.turn?.sessionId, 'thread-timeout-turn-timeout');
  assert.equal(timeoutCloseCalls, 1);
  const afterTimeout = await timeoutRunner.startTurn({
    prompt: 'This turn should not be accepted after timeout.',
    turnId: 'turn-after-timeout',
  });
  assert.equal(afterTimeout.status, 'failed');
  assert.equal(afterTimeout.error?.code, 'transport_closed');
  assert.equal(timeoutCloseCalls, 1);

  let turnHangingCloseCalled = false;
  const turnHangingCloseRunner = requireRunner(
    await launchCodexAppServerRunner({
      cwd: createTempCwd(t),
      processAdapter: {
        async launch() {
          return {
            async request(request: CodexAppServerTransportRequest) {
              if (request.method === 'initialize') {
                return {
                  status: 'ready',
                  runnerId: 'runner-hanging-close',
                  threadId: 'thread-hanging-close',
                };
              }
              return new Promise<never>(() => undefined);
            },
            close() {
              turnHangingCloseCalled = true;
              return new Promise<never>(() => undefined);
            },
          };
        },
      },
      turnTimeoutMs: 5,
      now: instantNow,
    }),
  );
  const hangingCloseTurn = await turnHangingCloseRunner.startTurn({
    prompt: 'This timeout has a hanging close.',
    turnId: 'turn-hanging-close',
  });
  assert.equal(hangingCloseTurn.status, 'failed');
  assert.equal(hangingCloseTurn.error?.code, 'turn_timeout');
  assert.equal(hangingCloseTurn.error?.details.closeStatus, 'timeout');
  assert.equal(turnHangingCloseCalled, true);

  const closedRunner = requireRunner(
    await launchCodexAppServerRunner({
      cwd: createTempCwd(t),
      processAdapter: createScriptedCodexAppServerProcessAdapter([
        {
          kind: 'response',
          method: 'initialize',
          response: {
            status: 'ready',
            runnerId: 'runner-closed',
            threadId: 'thread-closed',
          },
        },
        {
          kind: 'close',
          method: 'turn.start',
          message: 'stdout closed before final result.',
        },
      ]),
      now: instantNow,
    }),
  );
  const closedTurn = await closedRunner.startTurn({
    prompt: 'This turn will close.',
    turnId: 'turn-closed',
  });
  assert.equal(closedTurn.status, 'failed');
  assert.equal(closedTurn.error?.code, 'transport_closed');

  const manualCloseHangingRunner = requireRunner(
    await launchCodexAppServerRunner({
      cwd: createTempCwd(t),
      processAdapter: {
        async launch() {
          return {
            async request() {
              return {
                status: 'ready',
                runnerId: 'runner-close-timeout',
                threadId: 'thread-close-timeout',
              };
            },
            close() {
              return new Promise<never>(() => undefined);
            },
          };
        },
      },
      now: instantNow,
    }),
  );
  try {
    await manualCloseHangingRunner.close();
    assert.fail('Expected hanging close to fail with a bounded shutdown error.');
  } catch (error) {
    assert.equal(getErrorCode(error), 'transport_closed');
    assert.equal(getErrorDetails(error).closeStatus, 'timeout');
  }
});

test('Codex runner maps turn failures, cancellations, and input-required states', async (t) => {
  const runner = requireRunner(
    await launchCodexAppServerRunner({
      cwd: createTempCwd(t),
      processAdapter: createScriptedCodexAppServerProcessAdapter([
        {
          kind: 'response',
          method: 'initialize',
          response: {
            status: 'ready',
            runnerId: 'runner-errors',
            threadId: 'thread-errors',
          },
        },
        {
          kind: 'response',
          method: 'turn.start',
          response: {
            status: 'failed',
            turnId: 'turn-rate-limit',
            error: {
              category: 'usageLimitExceeded',
              code: '429',
              message: 'Usage limit exceeded.',
            },
          },
        },
        {
          kind: 'response',
          method: 'turn.start',
          response: {
            status: 'cancelled',
            turnId: 'turn-cancelled',
            message: 'Turn was cancelled upstream.',
          },
        },
        {
          kind: 'response',
          method: 'turn.start',
          response: {
            status: 'input_required',
            turnId: 'turn-input',
            message: 'Approval is required.',
          },
        },
      ]),
      now: instantNow,
    }),
  );

  const failed = await runner.startTurn({
    prompt: 'Trigger rate limit.',
    turnId: 'turn-rate-limit',
  });
  const cancelled = await runner.startTurn({
    prompt: 'Trigger cancellation.',
    turnId: 'turn-cancelled',
  });
  const inputRequired = await runner.startTurn({
    prompt: 'Trigger input-required state.',
    turnId: 'turn-input',
  });

  assert.equal(failed.error?.code, 'turn_failed');
  assert.equal(failed.error?.codexCategory, 'usageLimitExceeded');
  assert.equal(failed.error?.details.codexCode, '429');
  assert.equal(cancelled.error?.code, 'turn_cancelled');
  assert.equal(inputRequired.error?.code, 'turn_input_required');
});

function createTempCwd(t: test.TestContext): string {
  const cwd = mkdtempSync(join(tmpdir(), 'symphony-codex-runner-'));
  t.after(() => {
    rmSync(cwd, { recursive: true, force: true });
  });
  return cwd;
}

function createWorkflow(cwd: string): SymphonyWorkflowDocument {
  return loadSymphonyWorkflowFromText({
    workflowPath: join(cwd, 'WORKFLOW.md'),
    now: instantNow,
    content: [
      '---',
      'workspace:',
      '  root: ./workspaces',
      'codex:',
      '  command: codex app-server --json',
      '  read_timeout_ms: 25',
      '  turn_timeout_ms: 50',
      '---',
      'Implement {{ issue.title }}.',
    ].join('\n'),
  });
}

function requireRunner(launch: CodexAppServerRunnerLaunch): CodexAppServerRunner {
  assert.equal(launch.result.status, 'succeeded');
  assert.ok(launch.runner);
  return launch.runner;
}

function deterministicIds(kind: 'runner' | 'thread' | 'turn'): string {
  return `${kind}-generated`;
}

function getErrorCode(error: unknown): string | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  return undefined;
}

function getErrorDetails(error: unknown): Record<string, string> {
  if (
    typeof error === 'object' &&
    error !== null &&
    'details' in error &&
    isStringRecord(error.details)
  ) {
    return error.details;
  }
  return {};
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}
