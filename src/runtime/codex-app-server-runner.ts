import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { z } from 'zod';

import {
  symphonyCodexRunnerCommandSchema,
  symphonyCodexRunnerConfigSchema,
  symphonyCodexRunnerContractVersion,
  symphonyCodexRunnerContinuationSchema,
  symphonyCodexRunnerEventRecordSchema,
  symphonyCodexRunnerLaunchResultSchema,
  symphonyCodexRunnerPendingRequestSchema,
  symphonyCodexRunnerRateLimitSnapshotSchema,
  symphonyCodexRunnerSessionSnapshotSchema,
  symphonyCodexRunnerTelemetryRecordSchema,
  symphonyCodexRunnerTokenUsageSchema,
  symphonyCodexRunnerTurnExecutionEnvelopeSchema,
  symphonyCodexRunnerTurnResultSchema,
  type SymphonyCodexRunnerCommand,
  type SymphonyCodexRunnerContinuation,
  type SymphonyCodexRunnerContinuationReason,
  type SymphonyCodexRunnerConversationRef,
  type SymphonyCodexRunnerError,
  type SymphonyCodexRunnerErrorCode,
  type SymphonyCodexRunnerEventKind,
  type SymphonyCodexRunnerEventRecord,
  type SymphonyCodexRunnerLaunchResult,
  type SymphonyCodexRunnerPendingRequest,
  type SymphonyCodexRunnerPendingRequestKind,
  type SymphonyCodexRunnerRateLimitSnapshot,
  type SymphonyCodexRunnerSessionSnapshot,
  type SymphonyCodexRunnerTelemetryRecord,
  type SymphonyCodexRunnerTokenUsage,
  type SymphonyCodexRunnerPhase,
  type SymphonyCodexRunnerTurnRef,
  type SymphonyCodexRunnerTurnExecutionEnvelope,
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
    retryAfterMs: z.number().int().min(0).optional(),
    httpStatusCode: z.number().int().min(100).max(599).optional(),
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
    usage: z.unknown().optional(),
    tokenUsage: z.unknown().optional(),
    rateLimit: z.unknown().optional(),
    rateLimits: z.array(z.unknown()).optional(),
    retryAfterMs: z.number().int().min(0).optional(),
    attempt: z.number().int().positive().optional(),
  })
  .strict();

export interface CodexAppServerTransportRequest {
  readonly method: 'initialize' | 'thread.create' | 'turn.start';
  readonly phase: SymphonyCodexRunnerPhase;
  readonly params: Record<string, unknown>;
}

export interface CodexAppServerTransport {
  request(input: CodexAppServerTransportRequest): Promise<unknown>;
  requestWithEvents?(
    input: CodexAppServerTransportRequest,
    observer: CodexAppServerTurnEventObserver,
  ): Promise<unknown>;
  close?(): Promise<void> | void;
}

export interface CodexAppServerTurnEventObserver {
  onEvent(event: CodexAppServerTurnEvent): void;
}

export interface CodexAppServerTurnEvent {
  readonly kind: string;
  readonly message?: string;
  readonly turnId?: string;
  readonly sessionId?: string;
  readonly usage?: unknown;
  readonly tokenUsage?: unknown;
  readonly rateLimit?: unknown;
  readonly rateLimits?: readonly unknown[];
  readonly requestId?: string;
  readonly itemId?: string;
  readonly approvalKind?: 'command_approval' | 'file_change_approval';
  readonly reason?: string;
  readonly questions?: readonly string[];
  readonly availableDecisions?: readonly string[];
  readonly retryAfterMs?: number;
  readonly attempt?: number;
  readonly delayMs?: number;
  readonly metadata?: Record<string, string>;
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
  readonly stallTimeoutMs?: number;
  readonly continuationDelayMs?: number;
  readonly now?: () => Date;
  readonly idFactory?: (kind: 'runner' | 'thread' | 'turn') => string;
}

export interface StartCodexAppServerTurnInput {
  readonly prompt: string;
  readonly turnId?: string;
  readonly issueId?: string;
  readonly attempt?: number;
  readonly continuation?: {
    readonly enabled: boolean;
    readonly prompt?: string;
    readonly delayMs?: number;
    readonly attempt?: number;
  };
  readonly metadata?: Record<string, string>;
}

export interface CodexAppServerRunner {
  readonly command: SymphonyCodexRunnerCommand;
  readonly conversation: SymphonyCodexRunnerConversationRef;
  startTurn(input: StartCodexAppServerTurnInput): Promise<SymphonyCodexRunnerTurnResult>;
  startTurnWithTelemetry(
    input: StartCodexAppServerTurnInput,
  ): Promise<SymphonyCodexRunnerTurnExecutionEnvelope>;
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
      readonly kind: 'event';
      readonly method?: CodexAppServerTransportRequest['method'];
      readonly event: CodexAppServerTurnEvent;
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
        stallTimeoutMs: config.stallTimeoutMs,
        continuationDelayMs: config.continuationDelayMs,
        maxRetryBackoffMs: config.maxRetryBackoffMs,
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
  private readonly stallTimeoutMs: number;
  private readonly continuationDelayMs: number;
  private readonly maxRetryBackoffMs: number;
  private readonly now: () => Date;
  private readonly idFactory: (kind: 'runner' | 'thread' | 'turn') => string;
  private closed = false;
  private turnCount = 0;

  constructor(input: {
    readonly command: SymphonyCodexRunnerCommand;
    readonly conversation: SymphonyCodexRunnerConversationRef;
    readonly transport: CodexAppServerTransport;
    readonly turnTimeoutMs: number;
    readonly stallTimeoutMs: number;
    readonly continuationDelayMs: number;
    readonly maxRetryBackoffMs: number;
    readonly now: () => Date;
    readonly idFactory: (kind: 'runner' | 'thread' | 'turn') => string;
  }) {
    this.command = input.command;
    this.conversation = input.conversation;
    this.transport = input.transport;
    this.turnTimeoutMs = input.turnTimeoutMs;
    this.stallTimeoutMs = input.stallTimeoutMs;
    this.continuationDelayMs = input.continuationDelayMs;
    this.maxRetryBackoffMs = input.maxRetryBackoffMs;
    this.now = input.now;
    this.idFactory = input.idFactory;
  }

  async startTurn(
    input: StartCodexAppServerTurnInput,
  ): Promise<SymphonyCodexRunnerTurnResult> {
    return (await this.startTurnWithTelemetry(input)).result;
  }

  async startTurnWithTelemetry(
    input: StartCodexAppServerTurnInput,
  ): Promise<SymphonyCodexRunnerTurnExecutionEnvelope> {
    const startedAt = this.now();
    const requestedTurnId = input.turnId ?? this.idFactory('turn');
    const requestedTurn = buildTurnRef({
      conversation: this.conversation,
      turnId: requestedTurnId,
    });
    const turnCount = this.turnCount + 1;
    const collector = new CodexTurnTelemetryCollector({
      conversation: this.conversation,
      requestedTurn,
      turnCount,
      now: this.now,
    });

    try {
      if (this.closed) {
        throw new CodexAppServerRunnerError(
          'transport_closed',
          'turn',
          'Codex app-server transport is already closed.',
        );
      }

      this.turnCount = turnCount;
      const response = await requestTurnWithTelemetry({
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
        turnTimeoutMs: this.turnTimeoutMs,
        stallTimeoutMs: this.stallTimeoutMs,
        onEvent: (event) => {
          collector.recordRawEvent(event);
        },
        turnTimeoutMessage: `Codex turn ${requestedTurnId} exceeded ${this.turnTimeoutMs}ms.`,
        stallTimeoutMessage: `Codex turn ${requestedTurnId} was inactive for ${this.stallTimeoutMs}ms.`,
      });

      collector.recordTerminalResponse(response);
      return this.normalizeTurnResponse({
        response,
        startedAt,
        requestedTurn,
        collector,
        continuationInput: input.continuation,
        attempt: input.attempt,
      });
    } catch (error) {
      let runnerError = toRunnerError(error, 'turn');
      const shouldCloseTransport =
        runnerError.code === 'process_exited' ||
        runnerError.code === 'turn_timeout' ||
        runnerError.code === 'stall_timeout' ||
        (runnerError.code === 'transport_closed' && !this.closed);
      if (shouldCloseTransport) {
        this.closed = true;
        runnerError = await closeTransportAfterFailure(this.transport, runnerError);
      }

      const result = buildTurnResult({
        status: 'failed',
        conversation: this.conversation,
        startedAt,
        completedAt: this.now(),
        turn: requestedTurn,
        error: toSerializableError(runnerError),
      });
      const continuation = buildFailureContinuation({
        result,
        maxRetryBackoffMs: this.maxRetryBackoffMs,
        attempt: input.attempt ?? 1,
      });
      if (continuation !== undefined) {
        collector.recordRetryBackoff(continuation);
      }

      return buildTurnExecutionEnvelope({
        result,
        collector,
        continuation,
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
    readonly collector: CodexTurnTelemetryCollector;
    readonly continuationInput?: StartCodexAppServerTurnInput['continuation'];
    readonly attempt?: number;
  }): SymphonyCodexRunnerTurnExecutionEnvelope {
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
      const result = buildTurnResult({
        status: 'succeeded',
        conversation: this.conversation,
        startedAt: input.startedAt,
        completedAt: this.now(),
        turn,
        output: response.output ?? '',
      });
      const continuation = buildSuccessContinuation({
        result,
        continuationInput: input.continuationInput,
        defaultDelayMs: this.continuationDelayMs,
      });
      if (continuation !== undefined) {
        input.collector.recordRetryBackoff(continuation);
      }
      return buildTurnExecutionEnvelope({
        result,
        collector: input.collector,
        continuation,
      });
    }

    const result = buildTurnResult({
      status: 'failed',
      conversation: this.conversation,
      startedAt: input.startedAt,
      completedAt: this.now(),
      turn,
      error: buildTurnFailureError(response),
    });
    const continuation = buildFailureContinuation({
      result,
      maxRetryBackoffMs: this.maxRetryBackoffMs,
      attempt: input.attempt ?? response.attempt ?? 1,
    });
    if (continuation !== undefined) {
      input.collector.recordRetryBackoff(continuation);
    }
    return buildTurnExecutionEnvelope({
      result,
      collector: input.collector,
      continuation,
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
    const step = await this.shiftStep(input);
    if (step.kind === 'event') {
      throw new CodexAppServerRunnerError(
        'protocol_error',
        input.phase,
        `Scripted event ${step.event.kind} requires an event-capable turn request.`,
      );
    }
    return this.resolveNonEventStep(step, input);
  }

  async requestWithEvents(
    input: CodexAppServerTransportRequest,
    observer: CodexAppServerTurnEventObserver,
  ): Promise<unknown> {
    if (this.closed) {
      throw new CodexAppServerRunnerError(
        'transport_closed',
        input.phase,
        'Codex app-server transport is closed.',
      );
    }

    this.requests.push(input);
    while (true) {
      const step = await this.shiftStep(input);
      if (step.kind === 'event') {
        observer.onEvent(step.event);
        continue;
      }
      return this.resolveNonEventStep(step, input);
    }
  }

  private async shiftStep(
    input: CodexAppServerTransportRequest,
  ): Promise<ScriptedCodexAppServerStep> {
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

    return step;
  }

  private resolveNonEventStep(
    step: Exclude<ScriptedCodexAppServerStep, { readonly kind: 'event' }>,
    input: CodexAppServerTransportRequest,
  ): Promise<unknown> | unknown {
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
  readonly stallTimeoutMs: number;
  readonly continuationDelayMs: number;
  readonly maxRetryBackoffMs: number;
} {
  const parsed = symphonyCodexRunnerConfigSchema.parse({
    command:
      typeof input.command === 'string'
        ? input.command
        : input.workflow?.config.codex.command,
    readTimeoutMs: input.readTimeoutMs ?? input.workflow?.config.codex.readTimeoutMs,
    turnTimeoutMs: input.turnTimeoutMs ?? input.workflow?.config.codex.turnTimeoutMs,
    stallTimeoutMs: input.stallTimeoutMs ?? input.workflow?.config.codex.stallTimeoutMs,
    continuationDelayMs: input.continuationDelayMs,
  });

  return {
    readTimeoutMs: parsed.readTimeoutMs,
    turnTimeoutMs: parsed.turnTimeoutMs,
    stallTimeoutMs: parsed.stallTimeoutMs,
    continuationDelayMs: parsed.continuationDelayMs,
    maxRetryBackoffMs: input.workflow?.config.agent.maxRetryBackoffMs ?? 300_000,
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

function requestTurnWithTelemetry(input: {
  readonly transport: CodexAppServerTransport;
  readonly request: CodexAppServerTransportRequest;
  readonly turnTimeoutMs: number;
  readonly stallTimeoutMs: number;
  readonly onEvent: (event: CodexAppServerTurnEvent) => void;
  readonly turnTimeoutMessage: string;
  readonly stallTimeoutMessage: string;
}): Promise<unknown> {
  const requestWithEvents = input.transport.requestWithEvents;
  if (requestWithEvents === undefined) {
    return requestWithTimeout({
      transport: input.transport,
      request: input.request,
      timeoutMs: input.turnTimeoutMs,
      timeoutCode: 'turn_timeout',
      timeoutMessage: input.turnTimeoutMessage,
    });
  }

  let settled = false;
  let turnTimeout: ReturnType<typeof setTimeout> | undefined;
  let stallTimeout: ReturnType<typeof setTimeout> | undefined;

  return new Promise((resolve, reject) => {
    const clearTimers = () => {
      if (turnTimeout !== undefined) {
        clearTimeout(turnTimeout);
      }
      if (stallTimeout !== undefined) {
        clearTimeout(stallTimeout);
      }
    };
    const rejectOnce = (error: CodexAppServerRunnerError) => {
      if (!settled) {
        settled = true;
        clearTimers();
        reject(error);
      }
    };
    const resolveOnce = (value: unknown) => {
      if (!settled) {
        settled = true;
        clearTimers();
        resolve(value);
      }
    };
    const resetStallTimer = () => {
      if (input.stallTimeoutMs <= 0 || settled) {
        return;
      }
      if (stallTimeout !== undefined) {
        clearTimeout(stallTimeout);
      }
      stallTimeout = setTimeout(() => {
        rejectOnce(
          new CodexAppServerRunnerError(
            'stall_timeout',
            input.request.phase,
            input.stallTimeoutMessage,
            [],
            undefined,
            { stallTimeoutMs: String(input.stallTimeoutMs) },
          ),
        );
      }, input.stallTimeoutMs);
    };

    turnTimeout = setTimeout(() => {
      rejectOnce(
        new CodexAppServerRunnerError(
          'turn_timeout',
          input.request.phase,
          input.turnTimeoutMessage,
          [],
          undefined,
          { turnTimeoutMs: String(input.turnTimeoutMs) },
        ),
      );
    }, input.turnTimeoutMs);
    resetStallTimer();

    requestWithEvents
      .call(input.transport, input.request, {
        onEvent(event) {
          if (settled) {
            return;
          }
          input.onEvent(event);
          if (isCodexActivityEvent(event)) {
            resetStallTimer();
          }
        },
      })
      .then(resolveOnce, (error: unknown) => {
        rejectOnce(toRunnerError(error, input.request.phase));
      });
  });
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

class CodexTurnTelemetryCollector {
  readonly events: SymphonyCodexRunnerEventRecord[] = [];
  readonly telemetry: SymphonyCodexRunnerTelemetryRecord[] = [];

  private lastEventKind: SymphonyCodexRunnerEventKind | undefined;
  private lastEventAt: string | undefined;
  private lastMessage: string | undefined;
  private lastTokenUsage: SymphonyCodexRunnerTokenUsage | undefined;
  private aggregateTokenUsage: SymphonyCodexRunnerTokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  private readonly rateLimits = new Map<string, SymphonyCodexRunnerRateLimitSnapshot>();
  private readonly pendingRequests = new Map<string, SymphonyCodexRunnerPendingRequest>();
  private eventIndex = 0;
  private telemetryIndex = 0;

  constructor(
    private readonly input: {
      readonly conversation: SymphonyCodexRunnerConversationRef;
      readonly requestedTurn: SymphonyCodexRunnerTurnRef;
      readonly turnCount: number;
      readonly now: () => Date;
    },
  ) {}

  recordRawEvent(event: CodexAppServerTurnEvent): void {
    const kind = normalizeEventKind(event.kind);
    const turn = this.resolveTurn(event.turnId);
    const observedAt = this.input.now().toISOString();
    const tokenUsage = normalizeTokenUsage(event.tokenUsage ?? event.usage);
    const rateLimits = normalizeRateLimits(event.rateLimits ?? event.rateLimit);
    const message = event.message;

    this.pushEvent({
      kind,
      observedAt,
      turn,
      message,
      tokenUsage,
      rateLimit: rateLimits[0],
      attempt: event.attempt,
      delayMs: normalizeOptionalNonNegativeInteger(event.delayMs),
      retryAfterMs: normalizeOptionalNonNegativeInteger(event.retryAfterMs),
      metadata: event.metadata ?? {},
    });

    if (tokenUsage !== undefined) {
      this.recordTokenUsage(tokenUsage, observedAt, turn);
    }
    for (const rateLimit of rateLimits) {
      this.recordRateLimit(rateLimit, observedAt, turn);
    }

    if (kind === 'approval_requested') {
      const pending = this.createPendingRequest({
        event,
        observedAt,
        turn,
        kind: approvalRequestKind(event),
        status: 'pending',
      });
      this.recordPendingRequest(pending, observedAt, turn);
      const resolved = symphonyCodexRunnerPendingRequestSchema.parse({
        ...pending,
        status: 'resolved',
        resolvedAt: observedAt,
      });
      this.recordPendingRequest(resolved, observedAt, turn);
      this.pushEvent({
        kind: 'approval_auto_approved',
        observedAt,
        turn,
        message: 'Approval request auto-approved by high-trust runner policy.',
        pendingRequest: resolved,
        metadata: {
          policy: 'auto_approve',
          sourceEventKind: event.kind,
        },
      });
      return;
    }

    if (kind === 'user_input_required') {
      this.recordPendingRequest(
        this.createPendingRequest({
          event,
          observedAt,
          turn,
          kind: 'user_input',
          status: 'pending',
        }),
        observedAt,
        turn,
      );
    }
  }

  recordTerminalResponse(response: unknown): void {
    const parsed = turnResponseSchema.safeParse(response);
    if (!parsed.success) {
      return;
    }

    const turn = this.resolveTurn(parsed.data.turnId);
    const observedAt = this.input.now().toISOString();
    const tokenUsage = normalizeTokenUsage(
      parsed.data.tokenUsage ?? parsed.data.usage,
    );
    const rateLimits = normalizeRateLimits(
      parsed.data.rateLimits ?? parsed.data.rateLimit,
    );
    const terminalKind = terminalEventKind(parsed.data.status);

    this.pushEvent({
      kind: terminalKind,
      observedAt,
      turn,
      message: parsed.data.message,
      tokenUsage,
      rateLimit: rateLimits[0],
      attempt: parsed.data.attempt,
      retryAfterMs:
        parsed.data.retryAfterMs ??
        normalizeOptionalNonNegativeInteger(parsed.data.error?.retryAfterMs),
      metadata: {
        codexStatus: parsed.data.status,
      },
    });

    if (tokenUsage !== undefined) {
      this.recordTokenUsage(tokenUsage, observedAt, turn);
    }
    for (const rateLimit of rateLimits) {
      this.recordRateLimit(rateLimit, observedAt, turn);
    }
  }

  recordRetryBackoff(continuation: SymphonyCodexRunnerContinuation): void {
    const observedAt = this.input.now().toISOString();
    this.pushEvent({
      kind:
        continuation.reason === 'clean_exit'
          ? 'retry_scheduled'
          : 'backoff_scheduled',
      observedAt,
      turn: continuation.continuationOf,
      attempt: continuation.attempt,
      delayMs: continuation.delayMs,
      retryAfterMs: continuation.retryAfterMs,
      metadata: {
        reason: continuation.reason,
      },
    });
    this.pushTelemetry({
      kind: 'retry_backoff',
      observedAt,
      turn: continuation.continuationOf,
      reason: continuation.reason,
      attempt: continuation.attempt,
      delayMs: continuation.delayMs,
      retryAfterMs: continuation.retryAfterMs,
    });
  }

  buildSessionSnapshot(currentTurn?: SymphonyCodexRunnerTurnRef): SymphonyCodexRunnerSessionSnapshot {
    return symphonyCodexRunnerSessionSnapshotSchema.parse({
      contractVersion: symphonyCodexRunnerContractVersion,
      conversation: this.input.conversation,
      currentTurn,
      turnCount: this.input.turnCount,
      lastEventKind: this.lastEventKind,
      lastEventAt: this.lastEventAt,
      lastMessage: this.lastMessage,
      lastTokenUsage: this.lastTokenUsage,
      aggregateTokenUsage: this.aggregateTokenUsage,
      rateLimits: [...this.rateLimits.values()],
      pendingRequests: [...this.pendingRequests.values()],
      metadata: {},
    });
  }

  private pushEvent(input: {
    readonly kind: SymphonyCodexRunnerEventKind;
    readonly observedAt: string;
    readonly turn?: SymphonyCodexRunnerTurnRef;
    readonly message?: string;
    readonly tokenUsage?: SymphonyCodexRunnerTokenUsage;
    readonly rateLimit?: SymphonyCodexRunnerRateLimitSnapshot;
    readonly pendingRequest?: SymphonyCodexRunnerPendingRequest;
    readonly attempt?: number;
    readonly delayMs?: number;
    readonly retryAfterMs?: number;
    readonly metadata?: Record<string, string>;
  }): void {
    const record = symphonyCodexRunnerEventRecordSchema.parse({
      contractVersion: symphonyCodexRunnerContractVersion,
      eventId: `codex-event-${++this.eventIndex}`,
      kind: input.kind,
      observedAt: input.observedAt,
      conversation: this.input.conversation,
      turn: input.turn,
      message: input.message,
      tokenUsage: input.tokenUsage,
      rateLimit: input.rateLimit,
      pendingRequest: input.pendingRequest,
      attempt: input.attempt,
      delayMs: input.delayMs,
      retryAfterMs: input.retryAfterMs,
      metadata: input.metadata ?? {},
    });
    this.events.push(record);
    this.lastEventKind = record.kind;
    this.lastEventAt = record.observedAt;
    if (record.message !== undefined) {
      this.lastMessage = record.message;
    }
  }

  private pushTelemetry(input: {
    readonly kind: z.infer<typeof symphonyCodexRunnerTelemetryRecordSchema>['kind'];
    readonly observedAt: string;
    readonly turn?: SymphonyCodexRunnerTurnRef;
    readonly tokenUsage?: SymphonyCodexRunnerTokenUsage;
    readonly rateLimit?: SymphonyCodexRunnerRateLimitSnapshot;
    readonly pendingRequest?: SymphonyCodexRunnerPendingRequest;
    readonly reason?: SymphonyCodexRunnerContinuationReason;
    readonly attempt?: number;
    readonly delayMs?: number;
    readonly retryAfterMs?: number;
    readonly metadata?: Record<string, string>;
  }): void {
    this.telemetry.push(
      symphonyCodexRunnerTelemetryRecordSchema.parse({
        contractVersion: symphonyCodexRunnerContractVersion,
        telemetryId: `codex-telemetry-${++this.telemetryIndex}`,
        kind: input.kind,
        observedAt: input.observedAt,
        conversation: this.input.conversation,
        turn: input.turn,
        tokenUsage: input.tokenUsage,
        rateLimit: input.rateLimit,
        pendingRequest: input.pendingRequest,
        reason: input.reason,
        attempt: input.attempt,
        delayMs: input.delayMs,
        retryAfterMs: input.retryAfterMs,
        metadata: input.metadata ?? {},
      }),
    );
  }

  private recordTokenUsage(
    tokenUsage: SymphonyCodexRunnerTokenUsage,
    observedAt: string,
    turn?: SymphonyCodexRunnerTurnRef,
  ): void {
    this.lastTokenUsage = tokenUsage;
    this.aggregateTokenUsage = tokenUsage;
    this.pushTelemetry({
      kind: 'token_usage',
      observedAt,
      turn,
      tokenUsage,
    });
  }

  private recordRateLimit(
    rateLimit: SymphonyCodexRunnerRateLimitSnapshot,
    observedAt: string,
    turn?: SymphonyCodexRunnerTurnRef,
  ): void {
    this.rateLimits.set(rateLimitKey(rateLimit), rateLimit);
    this.pushTelemetry({
      kind: 'rate_limit',
      observedAt,
      turn,
      rateLimit,
    });
  }

  private recordPendingRequest(
    pendingRequest: SymphonyCodexRunnerPendingRequest,
    observedAt: string,
    turn?: SymphonyCodexRunnerTurnRef,
  ): void {
    this.pendingRequests.set(pendingRequestKey(pendingRequest), pendingRequest);
    this.pushTelemetry({
      kind: 'pending_request',
      observedAt,
      turn,
      pendingRequest,
      metadata: {
        status: pendingRequest.status,
      },
    });
  }

  private createPendingRequest(input: {
    readonly event: CodexAppServerTurnEvent;
    readonly observedAt: string;
    readonly turn?: SymphonyCodexRunnerTurnRef;
    readonly kind: SymphonyCodexRunnerPendingRequestKind;
    readonly status: SymphonyCodexRunnerPendingRequest['status'];
  }): SymphonyCodexRunnerPendingRequest {
    const turn = input.turn ?? this.input.requestedTurn;
    return symphonyCodexRunnerPendingRequestSchema.parse({
      kind: input.kind,
      status: input.status,
      requestId: input.event.requestId,
      itemId: input.event.itemId,
      threadId: turn.threadId,
      turnId: turn.turnId,
      startedAt: input.observedAt,
      reason: input.event.reason ?? input.event.message,
      questions: [...(input.event.questions ?? [])],
      availableDecisions: [...(input.event.availableDecisions ?? [])],
      metadata: input.event.metadata ?? {},
    });
  }

  private resolveTurn(turnId?: string): SymphonyCodexRunnerTurnRef | undefined {
    if (turnId === undefined || turnId === this.input.requestedTurn.turnId) {
      return this.input.requestedTurn;
    }
    return buildTurnRef({
      conversation: this.input.conversation,
      turnId,
    });
  }
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

function buildTurnExecutionEnvelope(input: {
  readonly result: SymphonyCodexRunnerTurnResult;
  readonly collector: CodexTurnTelemetryCollector;
  readonly continuation?: SymphonyCodexRunnerContinuation;
}): SymphonyCodexRunnerTurnExecutionEnvelope {
  return symphonyCodexRunnerTurnExecutionEnvelopeSchema.parse({
    contractVersion: symphonyCodexRunnerContractVersion,
    result: input.result,
    events: input.collector.events,
    telemetry: input.collector.telemetry,
    session: input.collector.buildSessionSnapshot(input.result.turn),
    continuation: input.continuation,
    metadata: {
      stallDetection:
        input.result.error?.code === 'stall_timeout'
          ? 'triggered'
          : 'event_capable_transport_only',
    },
  });
}

function buildSuccessContinuation(input: {
  readonly result: SymphonyCodexRunnerTurnResult;
  readonly continuationInput?: StartCodexAppServerTurnInput['continuation'];
  readonly defaultDelayMs: number;
}): SymphonyCodexRunnerContinuation | undefined {
  if (
    input.result.turn === undefined ||
    input.continuationInput === undefined ||
    !input.continuationInput.enabled
  ) {
    return undefined;
  }

  return symphonyCodexRunnerContinuationSchema.parse({
    contractVersion: symphonyCodexRunnerContractVersion,
    continuationOf: input.result.turn,
    reason: 'clean_exit',
    attempt: input.continuationInput.attempt ?? 1,
    delayMs: input.continuationInput.delayMs ?? input.defaultDelayMs,
    prompt: input.continuationInput.prompt,
    metadata: {
      mode: 'caller_requested',
      threadId: input.result.turn.threadId,
    },
  });
}

function buildFailureContinuation(input: {
  readonly result: SymphonyCodexRunnerTurnResult;
  readonly maxRetryBackoffMs: number;
  readonly attempt: number;
}): SymphonyCodexRunnerContinuation | undefined {
  if (input.result.turn === undefined || input.result.error === undefined) {
    return undefined;
  }

  const reason = continuationReasonForError(input.result.error);
  if (reason === undefined) {
    return undefined;
  }

  const retryAfterMs = normalizeOptionalNonNegativeInteger(
    input.result.error.details.retryAfterMs,
  );
  const delayMs =
    retryAfterMs ??
    calculateFailureBackoffMs(input.attempt, input.maxRetryBackoffMs);

  return symphonyCodexRunnerContinuationSchema.parse({
    contractVersion: symphonyCodexRunnerContractVersion,
    continuationOf: input.result.turn,
    reason,
    attempt: input.attempt,
    delayMs,
    retryAfterMs,
    metadata: {
      errorCode: input.result.error.code,
      ...(input.result.error.codexCategory !== undefined
        ? { codexCategory: input.result.error.codexCategory }
        : {}),
    },
  });
}

function continuationReasonForError(
  error: SymphonyCodexRunnerError,
): Exclude<SymphonyCodexRunnerContinuationReason, 'clean_exit' | 'approval' | 'user_input'> | undefined {
  if (error.code === 'stall_timeout') {
    return 'stall_timeout';
  }
  if (
    error.code === 'rate_limit' ||
    error.code === 'server_overloaded' ||
    error.details.retryAfterMs !== undefined ||
    error.codexCategory === 'usageLimitExceeded' ||
    error.codexCategory === 'rate_limit' ||
    error.codexCategory === 'server_overloaded' ||
    error.codexCategory === 'overloaded'
  ) {
    return 'retryable_failure';
  }
  return undefined;
}

function calculateFailureBackoffMs(attempt: number, maxRetryBackoffMs: number): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(10_000 * 2 ** exponent, maxRetryBackoffMs);
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
      ...(errorPayload?.httpStatusCode !== undefined
        ? { httpStatusCode: String(errorPayload.httpStatusCode) }
        : {}),
      ...(response.retryAfterMs !== undefined
        ? { retryAfterMs: String(response.retryAfterMs) }
        : {}),
      ...(errorPayload?.retryAfterMs !== undefined
        ? { retryAfterMs: String(errorPayload.retryAfterMs) }
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

function terminalEventKind(
  status: z.infer<typeof turnResponseSchema>['status'],
): SymphonyCodexRunnerEventKind {
  switch (status) {
    case 'completed':
    case 'succeeded':
      return 'turn_completed';
    case 'failed':
      return 'turn_failed';
    case 'cancelled':
      return 'turn_cancelled';
    case 'input_required':
      return 'user_input_required';
  }
}

function normalizeEventKind(kind: string): SymphonyCodexRunnerEventKind {
  switch (kind) {
    case 'turn_started':
    case 'turn.started':
    case 'turn/start':
      return 'turn_started';
    case 'turn_progress':
    case 'turn.progress':
    case 'item_started':
    case 'item.completed':
    case 'notification':
      return kind === 'notification' ? 'notification' : 'turn_progress';
    case 'approval_requested':
    case 'command_approval_requested':
    case 'file_change_approval_requested':
    case 'serverRequest/approval':
      return 'approval_requested';
    case 'approval_auto_approved':
      return 'approval_auto_approved';
    case 'user_input_required':
    case 'tool/requestUserInput':
    case 'serverRequest/userInput':
      return 'user_input_required';
    case 'rate_limit_updated':
    case 'account_rate_limits.updated':
    case 'rateLimits':
      return 'rate_limit_updated';
    case 'token_usage_updated':
    case 'usage.updated':
    case 'turn.completed.usage':
      return 'token_usage_updated';
    case 'retry_scheduled':
      return 'retry_scheduled';
    case 'backoff_scheduled':
      return 'backoff_scheduled';
    case 'turn_completed':
    case 'turn.completed':
      return 'turn_completed';
    case 'turn_failed':
    case 'turn.failed':
      return 'turn_failed';
    case 'turn_cancelled':
    case 'turn.cancelled':
      return 'turn_cancelled';
    case 'other_message':
      return 'other_message';
    default:
      return 'other_message';
  }
}

function isCodexActivityEvent(event: CodexAppServerTurnEvent): boolean {
  if (
    event.tokenUsage !== undefined ||
    event.usage !== undefined ||
    event.rateLimit !== undefined ||
    event.rateLimits !== undefined
  ) {
    return true;
  }

  switch (normalizeEventKind(event.kind)) {
    case 'turn_started':
    case 'turn_progress':
    case 'approval_requested':
    case 'approval_auto_approved':
    case 'user_input_required':
    case 'rate_limit_updated':
    case 'token_usage_updated':
      return true;
    case 'retry_scheduled':
    case 'backoff_scheduled':
    case 'turn_completed':
    case 'turn_failed':
    case 'turn_cancelled':
    case 'notification':
    case 'other_message':
      return false;
  }
}

function approvalRequestKind(
  event: CodexAppServerTurnEvent,
): SymphonyCodexRunnerPendingRequestKind {
  if (event.approvalKind !== undefined) {
    return event.approvalKind;
  }
  if (event.kind === 'file_change_approval_requested') {
    return 'file_change_approval';
  }
  return 'command_approval';
}

function normalizeTokenUsage(value: unknown): SymphonyCodexRunnerTokenUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const inputTokens = getNonNegativeInteger(value, [
    'inputTokens',
    'input_tokens',
    'input',
    'promptTokens',
    'prompt_tokens',
  ]);
  const outputTokens = getNonNegativeInteger(value, [
    'outputTokens',
    'output_tokens',
    'output',
    'completionTokens',
    'completion_tokens',
  ]);
  const explicitTotalTokens = getNonNegativeInteger(value, [
    'totalTokens',
    'total_tokens',
    'total',
  ]);

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    explicitTotalTokens === undefined
  ) {
    return undefined;
  }

  const normalizedInput = inputTokens ?? 0;
  const normalizedOutput = outputTokens ?? 0;
  return symphonyCodexRunnerTokenUsageSchema.parse({
    inputTokens: normalizedInput,
    outputTokens: normalizedOutput,
    totalTokens: explicitTotalTokens ?? normalizedInput + normalizedOutput,
  });
}

function normalizeRateLimits(value: unknown): SymphonyCodexRunnerRateLimitSnapshot[] {
  const candidates = Array.isArray(value) ? value : [value];
  return candidates.flatMap((candidate) => {
    const snapshot = normalizeRateLimitSnapshot(candidate);
    return snapshot === undefined ? [] : [snapshot];
  });
}

function normalizeRateLimitSnapshot(
  value: unknown,
): SymphonyCodexRunnerRateLimitSnapshot | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const family =
    getString(value, ['family', 'type', 'category']) ??
    getString(value, ['name', 'limitName']);
  if (family === undefined) {
    return undefined;
  }

  const resetAt = getString(value, ['resetAt', 'reset_at']);
  return symphonyCodexRunnerRateLimitSnapshotSchema.parse({
    family,
    name: getString(value, ['name', 'limitName']),
    used: getNonNegativeInteger(value, ['used', 'consumed']),
    limit: getNonNegativeInteger(value, ['limit', 'max']),
    remaining: getNonNegativeInteger(value, ['remaining', 'available']),
    resetAt: resetAt !== undefined && isIsoDate(resetAt) ? resetAt : undefined,
    metadata: {},
  });
}

function rateLimitKey(rateLimit: SymphonyCodexRunnerRateLimitSnapshot): string {
  return `${rateLimit.family}:${rateLimit.name ?? ''}`;
}

function pendingRequestKey(pendingRequest: SymphonyCodexRunnerPendingRequest): string {
  return (
    pendingRequest.requestId ??
    pendingRequest.itemId ??
    `${pendingRequest.threadId}:${pendingRequest.turnId}:${pendingRequest.kind}`
  );
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

function getString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function getNonNegativeInteger(
  record: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const normalized = normalizeOptionalNonNegativeInteger(record[key]);
    if (normalized !== undefined) {
      return normalized;
    }
  }
  return undefined;
}

function normalizeOptionalNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
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
