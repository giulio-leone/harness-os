import assert from 'node:assert/strict';
import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  JsonRpcError,
  JsonRpcStreamTransport,
  type JsonRpcEnvelope,
  type JsonRpcId,
  isJsonRpcErrorResponse,
  isJsonRpcSuccessResponse,
} from '../mcp/jsonrpc-stdio.js';

class TestJsonRpcClient {
  private readonly transport: JsonRpcStreamTransport;
  private readonly pendingRequests = new Map<
    JsonRpcId,
    {
      reject: (error: unknown) => void;
      resolve: (result: unknown) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  private nextId = 1;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.transport = new JsonRpcStreamTransport(
      (message) => this.handleMessage(message),
      {
        input: child.stdout,
        output: child.stdin,
      },
    );
    this.transport.start();
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;

    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Timed out waiting for response to ${method}`));
      }, 5_000);

      this.pendingRequests.set(id, {
        reject,
        resolve,
        timeout,
      });

      this.transport.sendRequest(id, method, params);
    });
  }

  notify(method: string, params?: unknown): void {
    this.transport.sendNotification(method, params);
  }

  async close(): Promise<void> {
    this.transport.stop();

    for (const pendingRequest of this.pendingRequests.values()) {
      clearTimeout(pendingRequest.timeout);
      pendingRequest.reject(new Error('Client closed before receiving a response'));
    }

    this.pendingRequests.clear();
  }

  private async handleMessage(message: JsonRpcEnvelope): Promise<void> {
    if (isJsonRpcSuccessResponse(message) || isJsonRpcErrorResponse(message)) {
      const pendingRequest = this.pendingRequests.get(message.id);

      if (pendingRequest === undefined) {
        return;
      }

      this.pendingRequests.delete(message.id);
      clearTimeout(pendingRequest.timeout);

      if (isJsonRpcSuccessResponse(message)) {
        pendingRequest.resolve(message.result);
      } else {
        pendingRequest.reject(
          new JsonRpcError(
            message.error.code,
            message.error.message,
            message.error.data,
          ),
        );
      }
    }
  }
}

test('local MCP wrapper reloads the child process after watched file changes', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'local-mcp-hot-reload-'));
  const versionFile = join(tempDir, 'version.txt');
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const distRoot = join(currentDir, '..');
  const wrapperPath = join(distRoot, 'bin', 'local-mcp-hot-reload-wrapper.js');
  const mockChildPath = join(
    distRoot,
    'test',
    'fixtures',
    'mock-hot-reload-child.js',
  );

  writeFileSync(versionFile, 'v1\n', 'utf8');

  const wrapper = spawn(
    process.execPath,
    [
      wrapperPath,
      '--name',
      'mock-hot-reload-child',
      '--watch',
      tempDir,
      '--reload-debounce-ms',
      '50',
      '--request-timeout-ms',
      '5000',
      '--',
      process.execPath,
      mockChildPath,
      versionFile,
    ],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  ) as ChildProcessWithoutNullStreams;

  const stderr: string[] = [];
  const client = new TestJsonRpcClient(wrapper);

  wrapper.stderr.on('data', (chunk: Buffer | string) => {
    stderr.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk);
  });

  try {
    const initializeResult = (await client.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {
        experimental: null,
        roots: null,
        sampling: null,
      },
      clientInfo: {
        name: 'copilot-cli-test',
        version: '1.0.0',
      },
    })) as Record<string, unknown>;

    assert.equal(
      (initializeResult.serverInfo as { name: string }).name,
      'mock-hot-reload-child',
    );

    client.notify('notifications/initialized', {});

    const firstToolList = (await client.request('tools/list', {})) as {
      tools: Array<{ name: string }>;
    };
    assert.deepEqual(firstToolList.tools.map((tool) => tool.name), ['get_version']);

    const firstToolCall = (await client.request('tools/call', {
      name: 'get_version',
      arguments: {},
    })) as {
      structuredContent: { version: string };
    };
    assert.equal(firstToolCall.structuredContent.version, 'v1');

    writeFileSync(versionFile, 'v2\n', 'utf8');
    await delay(250);

    const secondToolCall = (await client.request('tools/call', {
      name: 'get_version',
      arguments: {},
    })) as {
      structuredContent: { version: string };
    };
    assert.equal(secondToolCall.structuredContent.version, 'v2');
    assert.match(stderr.join(''), /Reloading child after change/);
  } finally {
    try {
      await client.request('shutdown', {});
    } catch {
      // Ignore shutdown failures during cleanup.
    }

    client.notify('exit');
    await client.close();

    if (!wrapper.killed) {
      wrapper.kill('SIGTERM');
    }

    rmSync(tempDir, { recursive: true, force: true });
  }
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
