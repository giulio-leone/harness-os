import { readFileSync } from 'node:fs';

import {
  JsonRpcError,
  StdioJsonRpcTransport,
  type JsonRpcErrorPayload,
  type JsonRpcId,
  type JsonRpcMessage,
} from '../../mcp/jsonrpc-stdio.js';

const versionFilePath = process.argv[2];

if (versionFilePath === undefined) {
  throw new Error('Expected a version file path as the first argument');
}

const version = readFileSync(versionFilePath, 'utf8').trim();
const transport = new StdioJsonRpcTransport((message) => handleMessage(message));

transport.start();

async function handleMessage(message: JsonRpcMessage): Promise<void> {
  const id = 'id' in message ? (message.id ?? null) : undefined;

  try {
    switch (message.method) {
      case 'initialize':
        requireRequestId(id, message.method);
        transport.sendResult(id, {
          protocolVersion: getProtocolVersion(message.params),
          capabilities: {
            tools: {
              listChanged: false,
            },
          },
          serverInfo: {
            name: 'mock-hot-reload-child',
            version,
          },
        });
        return;
      case 'notifications/initialized':
      case '$/cancelRequest':
      case '$/setTrace':
        return;
      case 'ping':
        if (id !== undefined) {
          transport.sendResult(id, {});
        }
        return;
      case 'tools/list':
        requireRequestId(id, message.method);
        transport.sendResult(id, {
          tools: [
            {
              name: 'get_version',
              description: 'Return the version loaded when the child process started.',
              inputSchema: {
                type: 'object',
                properties: {},
                additionalProperties: false,
              },
            },
          ],
        });
        return;
      case 'tools/call':
        requireRequestId(id, message.method);
        transport.sendResult(id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ version }),
            },
          ],
          structuredContent: {
            version,
          },
          isError: false,
        });
        return;
      case 'shutdown':
        requireRequestId(id, message.method);
        transport.sendResult(id, {});
        return;
      case 'exit':
        process.exit(0);
      default:
        throw new JsonRpcError(-32601, `Method not found: ${message.method}`);
    }
  } catch (error) {
    if (id === undefined) {
      console.error(getErrorMessage(error));
      return;
    }

    transport.sendError(id, toJsonRpcErrorPayload(error));
  }
}

function requireRequestId(
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

function getProtocolVersion(params: unknown): string {
  if (
    typeof params === 'object' &&
    params !== null &&
    'protocolVersion' in params &&
    typeof params.protocolVersion === 'string'
  ) {
    return params.protocolVersion;
  }

  return '2024-11-05';
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
