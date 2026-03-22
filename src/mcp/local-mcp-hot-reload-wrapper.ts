import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, statSync, watch, type FSWatcher } from 'node:fs';

import {
  JsonRpcError,
  JsonRpcStreamTransport,
  StdioJsonRpcTransport,
  type JsonRpcEnvelope,
  type JsonRpcErrorPayload,
  type JsonRpcId,
  type JsonRpcMessage,
  isJsonRpcErrorResponse,
  isJsonRpcMessage,
  isJsonRpcSuccessResponse,
} from './jsonrpc-stdio.js';

export interface LocalMcpHotReloadWrapperOptions {
  childCommand: string;
  childArgs: string[];
  watchPaths: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  name?: string;
  reloadDebounceMs?: number;
  requestTimeoutMs?: number;
}

interface PendingChildRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
  timeout: NodeJS.Timeout;
}

interface ChildSession {
  process: ChildProcessWithoutNullStreams;
  transport: JsonRpcStreamTransport;
  pendingRequests: Map<JsonRpcId, PendingChildRequest>;
  exited: boolean;
  initializeResult: unknown;
  stopping: boolean;
}

const DEFAULT_RELOAD_DEBOUNCE_MS = 150;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class LocalMcpHotReloadWrapper {
  private readonly outerTransport: StdioJsonRpcTransport;
  private readonly watchers: FSWatcher[] = [];
  private readonly reloadDebounceMs: number;
  private readonly requestTimeoutMs: number;
  private currentSession: ChildSession | null = null;
  private nextChildRequestId = 1;
  private clientInitializeParams: unknown;
  private clientInitialized = false;
  private clientInitializedParams: unknown = {};
  private reloadPending = false;
  private lastChangeAt = 0;
  private lastReloadReason: string | null = null;
  private disposing = false;
  private lifecycleAttached = false;

  constructor(private readonly options: LocalMcpHotReloadWrapperOptions) {
    this.reloadDebounceMs =
      options.reloadDebounceMs ?? DEFAULT_RELOAD_DEBOUNCE_MS;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.outerTransport = new StdioJsonRpcTransport((message) =>
      this.handleClientMessage(message),
    );
  }

  start(): void {
    this.assertWatchPaths();
    this.attachProcessLifecycle();
    this.setupWatchers();
    this.outerTransport.start();
  }

  requestRestart(reason = 'manual'): void {
    this.markReloadPending(reason);
  }

  private attachProcessLifecycle(): void {
    if (this.lifecycleAttached) {
      return;
    }

    const shutdown = (signal: string): void => {
      void this.dispose().finally(() => {
        process.exit(signal === 'SIGTERM' ? 0 : 130);
      });
    };

    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('beforeExit', () => {
      void this.dispose();
    });

    this.lifecycleAttached = true;
  }

  private async handleClientMessage(message: JsonRpcMessage): Promise<void> {
    const id = 'id' in message ? (message.id ?? null) : undefined;

    try {
      switch (message.method) {
        case 'initialize':
          this.requireRequestId(id, message.method);
          this.clientInitializeParams = message.params ?? {};
          this.outerTransport.sendResult(id, await this.initializeOrReloadChild());
          return;
        case 'notifications/initialized':
          this.clientInitialized = true;
          this.clientInitializedParams = message.params ?? {};
          await this.notifyChildInitialized();
          return;
        case '$/cancelRequest':
        case '$/setTrace':
          return;
        case 'ping':
          if (id !== undefined) {
            this.outerTransport.sendResult(id, {});
          }
          return;
        case 'shutdown':
          this.requireRequestId(id, message.method);
          await this.disposeCurrentSession();
          this.outerTransport.sendResult(id, {});
          return;
        case 'exit':
          await this.dispose();
          process.exit(0);
        default:
          if (id === undefined) {
            await this.forwardNotification(message);
            return;
          }

          this.outerTransport.sendResult(
            id,
            await this.forwardRequest(message.method, message.params),
          );
      }
    } catch (error) {
      if (id === undefined) {
        this.log(getErrorMessage(error));
        return;
      }

      this.outerTransport.sendError(id, toJsonRpcErrorPayload(error));
    }
  }

  private async initializeOrReloadChild(): Promise<unknown> {
    const session = await this.ensureActiveChild();
    return session.initializeResult;
  }

  private async forwardRequest(method: string, params?: unknown): Promise<unknown> {
    const session = await this.ensureActiveChild();
    return await this.sendChildRequest(session, method, params);
  }

  private async forwardNotification(message: JsonRpcMessage): Promise<void> {
    if (this.clientInitializeParams === undefined) {
      return;
    }

    const session = await this.ensureActiveChild();
    session.transport.sendNotification(message.method, message.params);
  }

  private async ensureActiveChild(): Promise<ChildSession> {
    if (this.clientInitializeParams === undefined) {
      throw new JsonRpcError(
        -32002,
        'Wrapper cannot start a child MCP server before initialize',
      );
    }

    await this.waitForReloadDebounce();

    if (this.currentSession === null) {
      this.currentSession = await this.createChildSession();
      this.reloadPending = false;
      this.lastReloadReason = null;
      this.lastChangeAt = 0;
      return this.currentSession;
    }

    if (!this.reloadPending) {
      return this.currentSession;
    }

    this.log(
      `Reloading child after change${this.lastReloadReason === null ? '' : ` (${this.lastReloadReason})`}`,
    );

    const previousSession = this.currentSession;
    const replacement = await this.createChildSession();

    this.currentSession = replacement;
    this.reloadPending = false;
    this.lastReloadReason = null;
    this.lastChangeAt = 0;

    await this.closeChildSession(previousSession, 'hot reload completed');

    return replacement;
  }

  private async createChildSession(): Promise<ChildSession> {
    const childProcess = spawn(this.options.childCommand, this.options.childArgs, {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (
      childProcess.stdin === null ||
      childProcess.stdout === null ||
      childProcess.stderr === null
    ) {
      throw new Error('Expected spawned child MCP server to expose piped stdio');
    }

    let session: ChildSession;

    const transport = new JsonRpcStreamTransport(
      (envelope) => this.handleChildEnvelope(session, envelope),
      {
        input: childProcess.stdout,
        output: childProcess.stdin,
      },
    );

    session = {
      process: childProcess as ChildProcessWithoutNullStreams,
      transport,
      pendingRequests: new Map(),
      exited: false,
      initializeResult: null,
      stopping: false,
    };

    session.transport.start();
    this.attachChildLifecycle(session);
    this.attachChildStderr(session);

    try {
      session.initializeResult = await this.sendChildRequest(
        session,
        'initialize',
        this.clientInitializeParams ?? {},
      );

      if (this.clientInitialized) {
        session.transport.sendNotification(
          'notifications/initialized',
          this.clientInitializedParams,
        );
      }
    } catch (error) {
      await this.closeChildSession(session, 'child initialize failed');
      throw error;
    }

    return session;
  }

  private attachChildLifecycle(session: ChildSession): void {
    session.process.once('error', (error: Error) => {
      const payload = new JsonRpcError(
        -32000,
        `Child MCP server failed to spawn: ${error.message}`,
      );

      this.rejectPendingRequests(session, payload);

      if (this.currentSession === session) {
        this.currentSession = null;
      }
    });

    session.process.once('exit', (code, signal) => {
      session.exited = true;

      this.rejectPendingRequests(
        session,
        new JsonRpcError(
          -32000,
          `Child MCP server exited${code !== null ? ` with code ${code}` : ''}${signal === null ? '' : ` via ${signal}`}`,
          { code, signal },
        ),
      );

      if (this.currentSession === session) {
        this.currentSession = null;
      }

      if (!session.stopping && !this.disposing) {
        this.markReloadPending(
          `child exited${code !== null ? ` (code ${code})` : ''}${signal === null ? '' : ` (${signal})`}`,
        );
      }
    });
  }

  private attachChildStderr(session: ChildSession): void {
    session.process.stderr.on('data', (chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
      const trimmed = text.trimEnd();

      if (trimmed.length === 0) {
        return;
      }

      process.stderr.write(`[hot-reload:${this.getName()} child] ${trimmed}\n`);
    });
  }

  private async handleChildEnvelope(
    session: ChildSession,
    envelope: JsonRpcEnvelope,
  ): Promise<void> {
    if (isJsonRpcSuccessResponse(envelope) || isJsonRpcErrorResponse(envelope)) {
      const pending = session.pendingRequests.get(envelope.id);

      if (pending === undefined) {
        this.log(`Received unexpected child response for id ${String(envelope.id)}`);
        return;
      }

      session.pendingRequests.delete(envelope.id);
      clearTimeout(pending.timeout);

      if (isJsonRpcSuccessResponse(envelope)) {
        pending.resolve(envelope.result);
      } else {
        pending.reject(
          new JsonRpcError(
            envelope.error.code,
            envelope.error.message,
            envelope.error.data,
          ),
        );
      }

      return;
    }

    if (!isJsonRpcMessage(envelope)) {
      return;
    }

    const requestId = 'id' in envelope ? envelope.id : undefined;

    if (requestId !== undefined) {
      session.transport.sendError(requestId ?? null, {
        code: -32601,
        message: `Wrapper does not support server-initiated request: ${envelope.method}`,
      });
      return;
    }

    switch (envelope.method) {
      case 'notifications/tools/list_changed':
      case 'notifications/resources/list_changed':
      case 'notifications/prompts/list_changed':
        this.outerTransport.sendNotification(envelope.method, envelope.params);
        return;
      default:
        return;
    }
  }

  private async sendChildRequest(
    session: ChildSession,
    method: string,
    params?: unknown,
  ): Promise<unknown> {
    const id = this.nextChildRequestId++;

    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        session.pendingRequests.delete(id);
        reject(
          new JsonRpcError(
            -32001,
            `Timed out waiting for child response to ${method}`,
          ),
        );
      }, this.requestTimeoutMs);

      session.pendingRequests.set(id, {
        method,
        resolve,
        reject,
        timeout,
      });

      session.transport.sendRequest(id, method, params);
    });
  }

  private async notifyChildInitialized(): Promise<void> {
    if (this.currentSession === null) {
      return;
    }

    this.currentSession.transport.sendNotification(
      'notifications/initialized',
      this.clientInitializedParams,
    );
  }

  private rejectPendingRequests(session: ChildSession, error: unknown): void {
    for (const pending of session.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }

    session.pendingRequests.clear();
  }

  private setupWatchers(): void {
    for (const watchPath of this.options.watchPaths) {
      const stats = statSync(watchPath);
      const watcher = this.createWatcherForPath(watchPath, stats.isDirectory());
      this.watchers.push(watcher);
    }
  }

  private createWatcherForPath(path: string, recursive: boolean): FSWatcher {
    try {
      return watch(
        path,
        recursive ? { recursive: true } : undefined,
        (eventType, filename) => {
          this.markReloadPending(
            `${eventType}${filename === null ? '' : `:${filename}`}`,
          );
        },
      );
    } catch (error) {
      if (!recursive) {
        throw error;
      }

      return watch(path, (eventType, filename) => {
        this.markReloadPending(
          `${eventType}${filename === null ? '' : `:${filename}`}`,
        );
      });
    }
  }

  private markReloadPending(reason: string): void {
    this.reloadPending = true;
    this.lastChangeAt = Date.now();
    this.lastReloadReason = reason;
  }

  private async waitForReloadDebounce(): Promise<void> {
    if (!this.reloadPending || this.lastChangeAt === 0) {
      return;
    }

    const remaining = this.reloadDebounceMs - (Date.now() - this.lastChangeAt);

    if (remaining > 0) {
      await delay(remaining);
    }
  }

  private assertWatchPaths(): void {
    for (const watchPath of this.options.watchPaths) {
      if (!existsSync(watchPath)) {
        throw new Error(`Watch path does not exist: ${watchPath}`);
      }
    }
  }

  private requireRequestId(
    id: JsonRpcId | undefined,
    method: string,
  ): asserts id is JsonRpcId {
    if (id === undefined) {
      throw new JsonRpcError(
        -32600,
        `Method ${method} must be called as a request with an id`,
      );
    }
  }

  private async disposeCurrentSession(): Promise<void> {
    const currentSession = this.currentSession;

    if (currentSession === null) {
      return;
    }

    this.currentSession = null;
    await this.closeChildSession(currentSession, 'wrapper shutdown');
  }

  private async closeChildSession(
    session: ChildSession,
    reason: string,
  ): Promise<void> {
    if (session.stopping) {
      return;
    }

    session.stopping = true;
    this.rejectPendingRequests(
      session,
      new JsonRpcError(-32000, `Child MCP session closed: ${reason}`),
    );

    if (!session.exited) {
      const exitPromise = once(session.process, 'exit');
      session.process.kill('SIGTERM');

      const exited = await waitForExit(exitPromise, 1_000);

      if (!exited && !session.exited) {
        session.process.kill('SIGKILL');
        await waitForExit(exitPromise, 1_000);
      }
    }

    session.transport.stop();
  }

  private async dispose(): Promise<void> {
    if (this.disposing) {
      return;
    }

    this.disposing = true;

    for (const watcher of this.watchers.splice(0)) {
      watcher.close();
    }

    this.outerTransport.stop();
    await this.disposeCurrentSession();
  }

  private getName(): string {
    return this.options.name ?? 'local-mcp-wrapper';
  }

  private log(message: string): void {
    process.stderr.write(`[hot-reload:${this.getName()}] ${message}\n`);
  }
}

function toJsonRpcErrorPayload(error: unknown): JsonRpcErrorPayload {
  if (error instanceof JsonRpcError) {
    return {
      code: error.code,
      message: error.message,
      data: error.data,
    };
  }

  return {
    code: -32603,
    message: getErrorMessage(error),
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForExit(
  exitPromise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  const timeout = delay(timeoutMs).then(() => false);
  const exited = exitPromise.then(() => true);

  return await Promise.race([exited, timeout]);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
