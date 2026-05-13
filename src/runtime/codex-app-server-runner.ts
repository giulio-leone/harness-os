import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { z } from 'zod';

import {
  symphonyCodexRunnerCommandSchema,
  symphonyCodexRunnerConfigSchema,
  symphonyCodexRunnerContractVersion,
  symphonyCodexRunnerLaunchResultSchema,
  symphonyCodexRunnerTurnResultSchema,
  type SymphonyCodexRunnerCommand,
  type SymphonyCodexRunnerConversationRef,
  type SymphonyCodexRunnerError,
  type SymphonyCodexRunnerErrorCode,
  type SymphonyCodexRunnerLaunchResult,
  type SymphonyCodexRunnerPhase,
  type SymphonyCodexRunnerTurnRef,
  type SymphonyCodexRunnerTurnResult,
} from '../contracts/symphony-codex-runner-contracts.js';
import type { SymphonyWorkflowDocument } from '../contracts/symphony-workflow-contracts.js';

const nonEmptyString = z.string().min(1);
const transportCloseTimeoutMs = 250;

const initializeResponseSchema = z
  .object({
    status: z.enum(['initialized', 'ready']),
    runnerId: nonEmptyString.optional(),
    sessionId: nonEmptyString.optional(),
    threadId: nonEmptyString.optional(),
  })
  .strict();

const threadCreateResponseSchema = z
  .object({
    threadId: nonEmptyString,
  })
  .strict();

const codexErrorPayloadSchema = z
  .object({
    code: z.string().optional(),
    category: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();

const turnResponseSchema = z
  .object({
    status: z.enum(['completed', 'succeeded', 'failed', 'cancelled', 'input_required']),
    turnId: nonEmptyString.optional(),
    sessionId: nonEmptyString.optional(),
    output: z.string().optional(),
    message: z.string().optional(),
    error: codexErrorPayloadSchema.optional(),
  })
  .strict();

export interface CodexAppServerTransportRequest {
  readonly method: 'initialize' | 'thread.create' | 'turn.start';
  readonly phase: SymphonyCodexRunnerPhase;
  readonly params: Record<string, unknown>;
}

export interface CodexAppServerTransport {
  request(input: CodexAppServerTransportRequest): Promise<unknown>;
  close?(): Promise<void> | void;
}

export interface CodexAppServerProcessAdapter {
  launch(command: SymphonyCodexRunnerCommand): Promise<CodexAppServerTransport>;
}

export interface LaunchCodexAppServerRunnerInput {
  readonly workflow?: SymphonyWorkflowDocument;
  readonly cwd?: string;
  readonly command?: string | SymphonyCodexRunnerCommand;
  readonly env?: Record<string, string | undefined>;
  readonly processAdapter: CodexAppServerProcessAdapter;
  readonly readTimeoutMs?: number;
  readonly turnTimeoutMs?: number;
  readonly now?: () => Date;
  readonly idFactory?: (kind: 'runner' | 'thread' | 'turn') => string;
}

export interface StartCodexAppServerTurnInput {
  readonly prompt: string;
  readonly turnId?: string;
  readonly issueId?: string;
  readonly metadata?: Record<string, string>;
}

export interface CodexAppServerRunner {
  readonly command: SymphonyCodexRunnerCommand;
  readonly conversation: SymphonyCodexRunnerConversationRef;
  startTurn(input: StartCodexAppServerTurnInput): Promise<SymphonyCodexRunnerTurnResult>;
  close(): Promise<void>;
}

export interface CodexAppServerRunnerLaunch {
  readonly result: SymphonyCodexRunnerLaunchResult;
  readonly runner?: CodexAppServerRunner;
}

export type ScriptedCodexAppServerStep =
  | {
      readonly kind: 'response';
      readonly method: CodexAppServerTransportRequest['method'];
      readonly response: unknown;
      readonly delayMs?: number;
    }
  | {
      readonly kind: 'error';
      readonly method?: CodexAppServerTransportRequest['method'];
      readonly code: SymphonyCodexRunnerErrorCode;
      readonly message: string;
      readonly codexCategory?: string;
      readonly delayMs?: number;
    }
  | {
      readonly kind: 'close';
      readonly method?: CodexAppServerTransportRequest['method'];
      readonly message?: string;
      readonly delayMs?: number;
    }
  | {
      readonly kind: 'exit';
      readonly method?: CodexAppServerTransportRequest['method'];
      readonly message?: string;
      readonly delayMs?: number;
    }
  | {
      readonly kind: 'hang';
      readonly method?: CodexAppServerTransportRequest['method'];
    };

export interface ScriptedCodexAppServerProcessAdapter
  extends CodexAppServerProcessAdapter {
  readonly launchedCommands: readonly SymphonyCodexRunnerCommand[];
  readonly requests: readonly CodexAppServerTransportRequest[];
}

export interface CreateScriptedCodexAppServerProcessAdapterOptions {
  readonly launchError?: {
    readonly code: SymphonyCodexRunnerErrorCode;
    readonly message: string;
    readonly codexCategory?: string;
  };
}

export class CodexAppServerRunnerError extends Error {
  constructor(
    readonly code: SymphonyCodexRunnerErrorCode,
    readonly phase: SymphonyCodexRunnerPhase,
    message: string,
    readonly issues: readonly string[] = [],
    readonly codexCategory?: string,
    readonly details: Record<string, string> = {},
  ) {
    super(message);
  }
}

export function buildSymphonyCodexAppServerCommand(input: {
  readonly command: string;
  readonly cwd: string;
  readonly env?: Record<string, string | undefined>;
}): SymphonyCodexRunnerCommand {
  const trimmedCommand = input.command.trim();
  if (trimmedCommand.length === 0) {
    throw new CodexAppServerRunnerError(
      'protocol_error',
      'launch',
      'Codex app-server command must not be empty.',
    );
  }

  return symphonyCodexRunnerCommandSchema.parse({
    command: process.platform === 'win32' ? 'cmd.exe' : 'bash',
    args:
      process.platform === 'win32'
        ? ['/d', '/s', '/c', trimmedCommand]
        : ['-lc', trimmedCommand],
    cwd: input.cwd,
    env: normalizeEnv(input.env ?? {}),
  });
}

export function deriveSymphonyCodexSessionId(input: {
  readonly threadId: string;
  readonly turnId: string;
}): string {
  return `${input.threadId}-${input.turnId}`;
}

export function createScriptedCodexAppServerProcessAdapter(
  steps: readonly ScriptedCodexAppServerStep[],
  options: CreateScriptedCodexAppServerProcessAdapterOptions = {},
): ScriptedCodexAppServerProcessAdapter {
  const launchedCommands: SymphonyCodexRunnerCommand[] = [];
  const requests: CodexAppServerTransportRequest[] = [];

  return {
    launchedCommands,
    requests,
    async launch(command) {
      launchedCommands.push(command);
      if (options.launchError !== undefined) {
        throw new CodexAppServerRunnerError(
          options.launchError.code,
          'launch',
          options.launchError.message,
          [],
          options.launchError.codexCategory,
        );
      }

      return new ScriptedCodexAppServerTransport([...steps], requests);
    },
  };
}

export async function launchCodexAppServerRunner(
  input: LaunchCodexAppServerRunnerInput,
): Promise<CodexAppServerRunnerLaunch> {
  const now = input.now ?? (() => new Date());
  const startedAt = now();
  const idFactory = input.idFactory ?? defaultIdFactory;
  const command = resolveRunnerCommand(input);
  const config = resolveRunnerConfig(input);
  let transport: CodexAppServerTransport | undefined;

  try {
    await assertValidWorkspaceCwd(command.cwd);
    transport = await launchProcessWithStartupTimeout({
      processAdapter: input.processAdapter,
      command,
      timeoutMs: config.readTimeoutMs,
    });
    const initializeResponse = await requestWithTimeout({
      transport,
      request: {
        method: 'initialize',
        phase: 'launch',
        params: {
          cwd: command.cwd,
          command: command.command,
          args: command.args,
        },
      },
      timeoutMs: config.readTimeoutMs,
      timeoutCode: 'startup_timeout',
      timeoutMessage: `Codex app-server did not initialize within ${config.readTimeoutMs}ms.`,
    });
    const initialized = parseInitializeResponse(initializeResponse);
    const runnerId = initialized.runnerId ?? initialized.sessionId ?? idFactory('runner');
    const threadId =
      initialized.threadId ??
      (await createInitialThread({
        transport,
        readTimeoutMs: config.readTimeoutMs,
        runnerId,
      }));
    const conversation = { runnerId, threadId };
    const result = buildLaunchResult({
      status: 'succeeded',
      command,
      startedAt,
      completedAt: now(),
      conversation,
    });

    return {
      result,
      runner: new CodexAppServerRunnerImpl({
        command,
        conversation,
        transport,
        turnTimeoutMs: config.turnTimeoutMs,
        now,
        idFactory,
      }),
    };
  } catch (error) {
    let runnerError = toRunnerError(error, 'launch');
    if (transport !== undefined) {
      runnerError = await closeTransportAfterFailure(transport, runnerError);
    }
    const result = buildLaunchResult({
      status: 'failed',
      command,
      startedAt,
      completedAt: now(),
      error: toSerializableError(runnerError),
    });

    return { result };
  }
}

class CodexAppServerRunnerImpl implements CodexAppServerRunner {
  readonly command: SymphonyCodexRunnerCommand;
  readonly conversation: SymphonyCodexRunnerConversationRef;

  private readonly transport: CodexAppServerTransport;
  private readonly turnTimeoutMs: number;
  private readonly now: () => Date;
  private readonly idFactory: (kind: 'runner' | 'thread' | 'turn') => string;
  private closed = false;

  constructor(input: {
    readonly command: SymphonyCodexRunnerCommand;
    readonly conversation: SymphonyCodexRunnerConversationRef;
    readonly transport: CodexAppServerTransport;
    readonly turnTimeoutMs: number;
    readonly now: () => Date;
    readonly idFactory: (kind: 'runner' | 'thread' | 'turn') => string;
  }) {
    this.command = input.command;
    this.conversation = input.conversation;
    this.transport = input.transport;
    this.turnTimeoutMs = input.turnTimeoutMs;
    this.now = input.now;
    this.idFactory = input.idFactory;
  }

  async startTurn(
    input: StartCodexAppServerTurnInput,
  ): Promise<SymphonyCodexRunnerTurnResult> {
    const startedAt = this.now();
    const requestedTurnId = input.turnId ?? this.idFactory('turn');
    const requestedTurn = buildTurnRef({
      conversation: this.conversation,
      turnId: requestedTurnId,
    });

    try {
      if (this.closed) {
        throw new CodexAppServerRunnerError(
          'transport_closed',
          'turn',
          'Codex app-server transport is already closed.',
        );
      }

      const response = await requestWithTimeout({
        transport: this.transport,
        request: {
          method: 'turn.start',
          phase: 'turn',
          params: {
            runnerId: this.conversation.runnerId,
            threadId: this.conversation.threadId,
            turnId: requestedTurnId,
            prompt: input.prompt,
            issueId: input.issueId,
            metadata: input.metadata ?? {},
          },
        },
        timeoutMs: this.turnTimeoutMs,
        timeoutCode: 'turn_timeout',
        timeoutMessage: `Codex turn ${requestedTurnId} exceeded ${this.turnTimeoutMs}ms.`,
      });

      return this.normalizeTurnResponse({
        response,
        startedAt,
        requestedTurn,
      });
    } catch (error) {
      let runnerError = toRunnerError(error, 'turn');
      const shouldCloseTransport =
        runnerError.code === 'process_exited' ||
        runnerError.code === 'turn_timeout' ||
        (runnerError.code === 'transport_closed' && !this.closed);
      if (shouldCloseTransport) {
        this.closed = true;
        runnerError = await closeTransportAfterFailure(this.transport, runnerError);
      }

      return buildTurnResult({
        status: 'failed',
        conversation: this.conversation,
        startedAt,
        completedAt: this.now(),
        turn: requestedTurn,
        error: toSerializableError(runnerError),
      });
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    const closeResult = await closeTransportBounded(
      this.transport,
      transportCloseTimeoutMs,
    );
    this.closed = true;
    if (closeResult.status === 'failed' || closeResult.status === 'timeout') {
      throw new CodexAppServerRunnerError(
        'transport_closed',
        'shutdown',
        closeResult.message,
        [],
        undefined,
        {
          closeStatus: closeResult.status,
          closeError: closeResult.message,
        },
      );
    }
  }

  private normalizeTurnResponse(input: {
    readonly response: unknown;
    readonly startedAt: Date;
    readonly requestedTurn: SymphonyCodexRunnerTurnRef;
  }): SymphonyCodexRunnerTurnResult {
    const parsed = turnResponseSchema.safeParse(input.response);
    if (!parsed.success) {
      throw new CodexAppServerRunnerError(
        'malformed_response',
        'turn',
        'Codex app-server returned an invalid turn response.',
        parsed.error.issues.map((issue) => formatZodIssue(issue)),
      );
    }

    const response = parsed.data;
    const responseTurnId = response.turnId ?? input.requestedTurn.turnId;
    const turn = buildTurnRef({
      conversation: this.conversation,
      turnId: responseTurnId,
    });

    if (
      response.sessionId !== undefined &&
      response.sessionId !== turn.sessionId
    ) {
      throw new CodexAppServerRunnerError(
        'protocol_error',
        'turn',
        `Codex app-server returned session id ${response.sessionId} for ${turn.sessionId}.`,
        [],
        undefined,
        {
          expectedSessionId: turn.sessionId,
          returnedSessionId: response.sessionId,
        },
      );
    }

    if (response.status === 'completed' || response.status === 'succeeded') {
      return buildTurnResult({
        status: 'succeeded',
        conversation: this.conversation,
        startedAt: input.startedAt,
        completedAt: this.now(),
        turn,
        output: response.output ?? '',
      });
    }

    return buildTurnResult({
      status: 'failed',
      conversation: this.conversation,
      startedAt: input.startedAt,
      completedAt: this.now(),
      turn,
      error: buildTurnFailureError(response),
    });
  }
}

class ScriptedCodexAppServerTransport implements CodexAppServerTransport {
  private closed = false;

  constructor(
    private readonly steps: ScriptedCodexAppServerStep[],
    private readonly requests: CodexAppServerTransportRequest[],
  ) {}

  async request(input: CodexAppServerTransportRequest): Promise<unknown> {
    if (this.closed) {
      throw new CodexAppServerRunnerError(
        'transport_closed',
        input.phase,
        'Codex app-server transport is closed.',
      );
    }

    this.requests.push(input);
    const step = this.steps.shift();
    if (step === undefined) {
      throw new CodexAppServerRunnerError(
        'protocol_error',
        input.phase,
        `No scripted Codex app-server response for ${input.method}.`,
      );
    }

    if (step.method !== undefined && step.method !== input.method) {
      throw new CodexAppServerRunnerError(
        'protocol_error',
        input.phase,
        `Expected scripted method ${step.method}, received ${input.method}.`,
      );
    }

    if ('delayMs' in step && step.delayMs !== undefined) {
      await delay(step.delayMs);
    }

    switch (step.kind) {
      case 'response':
        return step.response;
      case 'error':
        throw new CodexAppServerRunnerError(
          step.code,
          input.phase,
          step.message,
          [],
          step.codexCategory,
        );
      case 'close':
        this.closed = true;
        throw new CodexAppServerRunnerError(
          'transport_closed',
          input.phase,
          step.message ?? 'Codex app-server transport closed.',
        );
      case 'exit':
        this.closed = true;
        throw new CodexAppServerRunnerError(
          'process_exited',
          input.phase,
          step.message ?? 'Codex app-server process exited.',
        );
      case 'hang':
        return new Promise(() => undefined);
    }
  }

  close(): void {
    this.closed = true;
  }
}

async function createInitialThread(input: {
  readonly transport: CodexAppServerTransport;
  readonly readTimeoutMs: number;
  readonly runnerId: string;
}): Promise<string> {
  const response = await requestWithTimeout({
    transport: input.transport,
    request: {
      method: 'thread.create',
      phase: 'thread',
      params: {
        runnerId: input.runnerId,
      },
    },
    timeoutMs: input.readTimeoutMs,
    timeoutCode: 'read_timeout',
    timeoutMessage: `Codex app-server did not create a thread within ${input.readTimeoutMs}ms.`,
  });
  const parsed = threadCreateResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw new CodexAppServerRunnerError(
      'malformed_response',
      'thread',
      'Codex app-server returned an invalid thread creation response.',
      parsed.error.issues.map((issue) => formatZodIssue(issue)),
    );
  }

  return parsed.data.threadId;
}

function resolveRunnerCommand(
  input: LaunchCodexAppServerRunnerInput,
): SymphonyCodexRunnerCommand {
  if (typeof input.command === 'object') {
    return symphonyCodexRunnerCommandSchema.parse({
      ...input.command,
      env: input.command.env,
    });
  }

  const cwd =
    input.cwd ??
    input.workflow?.source.directory ??
    process.cwd();
  const command = input.command ?? input.workflow?.config.codex.command ?? 'codex app-server';

  return buildSymphonyCodexAppServerCommand({
    command,
    cwd,
    env: input.env,
  });
}

function resolveRunnerConfig(input: LaunchCodexAppServerRunnerInput): {
  readonly readTimeoutMs: number;
  readonly turnTimeoutMs: number;
} {
  const parsed = symphonyCodexRunnerConfigSchema.parse({
    command:
      typeof input.command === 'string'
        ? input.command
        : input.workflow?.config.codex.command,
    readTimeoutMs: input.readTimeoutMs ?? input.workflow?.config.codex.readTimeoutMs,
    turnTimeoutMs: input.turnTimeoutMs ?? input.workflow?.config.codex.turnTimeoutMs,
  });

  return {
    readTimeoutMs: parsed.readTimeoutMs,
    turnTimeoutMs: parsed.turnTimeoutMs,
  };
}

async function assertValidWorkspaceCwd(cwd: string): Promise<void> {
  if (!isAbsolute(cwd)) {
    throw new CodexAppServerRunnerError(
      'invalid_workspace_cwd',
      'launch',
      `Codex workspace cwd must be absolute: ${cwd}`,
    );
  }

  try {
    const stats = await stat(cwd);
    if (!stats.isDirectory()) {
      throw new CodexAppServerRunnerError(
        'invalid_workspace_cwd',
        'launch',
        `Codex workspace cwd is not a directory: ${cwd}`,
      );
    }
  } catch (error) {
    if (error instanceof CodexAppServerRunnerError) {
      throw error;
    }
    throw new CodexAppServerRunnerError(
      'invalid_workspace_cwd',
      'launch',
      `Codex workspace cwd is unavailable: ${cwd}`,
    );
  }
}

async function launchProcessWithStartupTimeout(input: {
  readonly processAdapter: CodexAppServerProcessAdapter;
  readonly command: SymphonyCodexRunnerCommand;
  readonly timeoutMs: number;
}): Promise<CodexAppServerTransport> {
  const launchPromise = input.processAdapter.launch(input.command);
  try {
    return await withTimeout(
      launchPromise,
      input.timeoutMs,
      new CodexAppServerRunnerError(
        'startup_timeout',
        'launch',
        `Codex app-server did not launch within ${input.timeoutMs}ms.`,
      ),
    );
  } catch (error) {
    const runnerError = toRunnerError(error, 'launch');
    if (runnerError.code !== 'startup_timeout') {
      throw runnerError;
    }

    throw await enrichStartupTimeoutWithLateCleanup(
      launchPromise,
      runnerError,
    );
  }
}

async function requestWithTimeout(input: {
  readonly transport: CodexAppServerTransport;
  readonly request: CodexAppServerTransportRequest;
  readonly timeoutMs: number;
  readonly timeoutCode: Extract<
    SymphonyCodexRunnerErrorCode,
    'startup_timeout' | 'read_timeout' | 'turn_timeout'
  >;
  readonly timeoutMessage: string;
}): Promise<unknown> {
  return withTimeout(
    input.transport.request(input.request),
    input.timeoutMs,
    new CodexAppServerRunnerError(
      input.timeoutCode,
      input.request.phase,
      input.timeoutMessage,
    ),
  );
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutError: CodexAppServerRunnerError,
): Promise<T> {
  let settled = false;

  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(timeoutError);
      }
    }, timeoutMs);

    promise.then(
      (value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve(value);
        }
      },
      (error: unknown) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(error);
        }
      },
    );
  });
}

async function enrichStartupTimeoutWithLateCleanup(
  launchPromise: Promise<CodexAppServerTransport>,
  error: CodexAppServerRunnerError,
): Promise<CodexAppServerRunnerError> {
  const cleanupDetails = await captureLateLaunchCleanup(
    launchPromise,
    transportCloseTimeoutMs,
  );

  return new CodexAppServerRunnerError(
    error.code,
    error.phase,
    error.message,
    error.issues,
    error.codexCategory,
    {
      ...error.details,
      ...cleanupDetails,
    },
  );
}

async function captureLateLaunchCleanup(
  launchPromise: Promise<CodexAppServerTransport>,
  timeoutMs: number,
): Promise<Record<string, string>> {
  const lateLaunch = await settleLateLaunch(launchPromise, timeoutMs);

  if (lateLaunch.status === 'pending') {
    void launchPromise.then(
      (transport) => {
        void closeTransportBounded(transport, transportCloseTimeoutMs);
      },
      () => undefined,
    );
    return {
      lateLaunchStatus: 'still_pending',
    };
  }

  if (lateLaunch.status === 'rejected') {
    return {
      lateLaunchStatus: 'rejected',
      lateLaunchError: lateLaunch.message,
    };
  }

  const closeResult = await closeTransportBounded(
    lateLaunch.transport,
    transportCloseTimeoutMs,
  );
  return {
    lateLaunchStatus: 'resolved',
    closeStatus: closeResult.status,
    ...('message' in closeResult ? { closeError: closeResult.message } : {}),
  };
}

function settleLateLaunch(
  launchPromise: Promise<CodexAppServerTransport>,
  timeoutMs: number,
): Promise<
  | { readonly status: 'resolved'; readonly transport: CodexAppServerTransport }
  | { readonly status: 'rejected'; readonly message: string }
  | { readonly status: 'pending' }
> {
  let settled = false;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ status: 'pending' });
      }
    }, timeoutMs);

    launchPromise.then(
      (transport) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve({ status: 'resolved', transport });
        }
      },
      (error: unknown) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve({
            status: 'rejected',
            message: describeError(error),
          });
        }
      },
    );
  });
}

async function closeTransportAfterFailure(
  transport: CodexAppServerTransport,
  error: CodexAppServerRunnerError,
): Promise<CodexAppServerRunnerError> {
  const closeResult = await closeTransportBounded(
    transport,
    transportCloseTimeoutMs,
  );
  if (closeResult.status === 'closed' || closeResult.status === 'not_configured') {
    return error;
  }

  return new CodexAppServerRunnerError(
    error.code,
    error.phase,
    error.message,
    error.issues,
    error.codexCategory,
    {
      ...error.details,
      closeStatus: closeResult.status,
      closeError: closeResult.message,
    },
  );
}

function closeTransportBounded(
  transport: CodexAppServerTransport,
  timeoutMs: number,
): Promise<
  | { readonly status: 'closed' }
  | { readonly status: 'not_configured' }
  | { readonly status: 'failed'; readonly message: string }
  | { readonly status: 'timeout'; readonly message: string }
> {
  if (transport.close === undefined) {
    return Promise.resolve({ status: 'not_configured' });
  }

  let settled = false;
  const closePromise = Promise.resolve().then(() => transport.close?.());

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({
          status: 'timeout',
          message: `Codex app-server transport did not close within ${timeoutMs}ms.`,
        });
      }
    }, timeoutMs);

    closePromise.then(
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve({ status: 'closed' });
        }
      },
      (error: unknown) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve({
            status: 'failed',
            message: describeError(error),
          });
        }
      },
    );
  });
}

function parseInitializeResponse(response: unknown): z.infer<
  typeof initializeResponseSchema
> {
  const parsed = initializeResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw new CodexAppServerRunnerError(
      'malformed_response',
      'launch',
      'Codex app-server returned an invalid initialize response.',
      parsed.error.issues.map((issue) => formatZodIssue(issue)),
    );
  }

  return parsed.data;
}

function buildLaunchResult(input:
  | {
      readonly status: 'succeeded';
      readonly command: SymphonyCodexRunnerCommand;
      readonly startedAt: Date;
      readonly completedAt: Date;
      readonly conversation: SymphonyCodexRunnerConversationRef;
    }
  | {
      readonly status: 'failed';
      readonly command: SymphonyCodexRunnerCommand;
      readonly startedAt: Date;
      readonly completedAt: Date;
      readonly error: SymphonyCodexRunnerError;
    }): SymphonyCodexRunnerLaunchResult {
  const duration = calculateDurationMs(input.startedAt, input.completedAt);
  const base = {
    contractVersion: symphonyCodexRunnerContractVersion,
    status: input.status,
    command: input.command,
    startedAt: input.startedAt.toISOString(),
    completedAt: input.completedAt.toISOString(),
    durationMs: duration,
    metadata: {},
  };

  return symphonyCodexRunnerLaunchResultSchema.parse(
    input.status === 'succeeded'
      ? {
          ...base,
          conversation: input.conversation,
        }
      : {
          ...base,
          error: input.error,
        },
  );
}

function buildTurnResult(input:
  | {
      readonly status: 'succeeded';
      readonly conversation: SymphonyCodexRunnerConversationRef;
      readonly startedAt: Date;
      readonly completedAt: Date;
      readonly turn: SymphonyCodexRunnerTurnRef;
      readonly output: string;
    }
  | {
      readonly status: 'failed';
      readonly conversation: SymphonyCodexRunnerConversationRef;
      readonly startedAt: Date;
      readonly completedAt: Date;
      readonly turn?: SymphonyCodexRunnerTurnRef;
      readonly error: SymphonyCodexRunnerError;
    }): SymphonyCodexRunnerTurnResult {
  const duration = calculateDurationMs(input.startedAt, input.completedAt);
  const base = {
    contractVersion: symphonyCodexRunnerContractVersion,
    status: input.status,
    conversation: input.conversation,
    startedAt: input.startedAt.toISOString(),
    completedAt: input.completedAt.toISOString(),
    durationMs: duration,
    metadata: {},
  };

  return symphonyCodexRunnerTurnResultSchema.parse(
    input.status === 'succeeded'
      ? {
          ...base,
          turn: input.turn,
          output: input.output,
        }
      : {
          ...base,
          turn: input.turn,
          error: input.error,
        },
  );
}

function buildTurnFailureError(
  response: z.infer<typeof turnResponseSchema>,
): SymphonyCodexRunnerError {
  const code = turnFailureCode(response.status);
  const errorPayload = response.error;
  const codexCategory = errorPayload?.category ?? errorPayload?.code;
  const message =
    errorPayload?.message ??
    response.message ??
    `Codex turn ended with ${response.status}.`;

  return {
    code,
    phase: 'turn',
    message,
    issues: [],
    ...(codexCategory !== undefined && codexCategory.length > 0
      ? { codexCategory }
      : {}),
    details: {
      codexStatus: response.status,
      ...(errorPayload?.code !== undefined ? { codexCode: errorPayload.code } : {}),
      ...(errorPayload?.category !== undefined
        ? { codexCategory: errorPayload.category }
        : {}),
    },
  };
}

function turnFailureCode(
  status: z.infer<typeof turnResponseSchema>['status'],
): Extract<
  SymphonyCodexRunnerErrorCode,
  'turn_failed' | 'turn_cancelled' | 'turn_input_required'
> {
  switch (status) {
    case 'failed':
      return 'turn_failed';
    case 'cancelled':
      return 'turn_cancelled';
    case 'input_required':
      return 'turn_input_required';
    case 'completed':
    case 'succeeded':
      throw new CodexAppServerRunnerError(
        'protocol_error',
        'turn',
        `Successful Codex status ${status} cannot be mapped to a failure code.`,
      );
  }
}

function buildTurnRef(input: {
  readonly conversation: SymphonyCodexRunnerConversationRef;
  readonly turnId: string;
}): SymphonyCodexRunnerTurnRef {
  return {
    runnerId: input.conversation.runnerId,
    threadId: input.conversation.threadId,
    turnId: input.turnId,
    sessionId: deriveSymphonyCodexSessionId({
      threadId: input.conversation.threadId,
      turnId: input.turnId,
    }),
  };
}

function toSerializableError(error: CodexAppServerRunnerError): SymphonyCodexRunnerError {
  return {
    code: error.code,
    phase: error.phase,
    message: error.message,
    issues: [...error.issues],
    ...(error.codexCategory !== undefined ? { codexCategory: error.codexCategory } : {}),
    details: error.details,
  };
}

function toRunnerError(
  error: unknown,
  phase: SymphonyCodexRunnerPhase,
): CodexAppServerRunnerError {
  if (error instanceof CodexAppServerRunnerError) {
    return error;
  }

  if (isNodeError(error) && error.code === 'ENOENT') {
    return new CodexAppServerRunnerError(
      'codex_not_found',
      phase,
      error.message,
      [],
      undefined,
      { nodeCode: error.code },
    );
  }

  if (error instanceof Error) {
    return new CodexAppServerRunnerError('spawn_failed', phase, error.message);
  }

  return new CodexAppServerRunnerError(
    'spawn_failed',
    phase,
    'Codex app-server operation failed with a non-error value.',
  );
}

function normalizeEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function defaultIdFactory(kind: 'runner' | 'thread' | 'turn'): string {
  return `codex-${kind}-${randomUUID()}`;
}

function calculateDurationMs(startedAt: Date, completedAt: Date): number {
  return Math.max(0, completedAt.getTime() - startedAt.getTime());
}

function formatZodIssue(issue: z.ZodIssue): string {
  const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return `${path}${issue.message}`;
}

function isNodeError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && 'code' in error && typeof error.code === 'string';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
