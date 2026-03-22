import { z } from 'zod';

import type { Mem0Adapter } from '../memory/mem0-adapter.interface.js';
import {
  memoryRecallInputSchema,
  memorySearchInputSchema,
  memoryStoreInputSchema,
} from '../memory/mem0.schemas.js';
import {
  JsonRpcError,
  StdioJsonRpcTransport,
  type JsonRpcErrorPayload,
  type JsonRpcId,
  type JsonRpcMessage,
} from './jsonrpc-stdio.js';

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: unknown) => Promise<unknown>;
}

const initializeParamsSchema = z
  .object({
    protocolVersion: z.string().optional(),
  })
  .passthrough();

const toolCallParamsSchema = z
  .object({
    name: z.string().min(1),
    arguments: z.unknown().optional(),
  })
  .strict();

const emptyInputSchema = z.object({}).strict();

const scopeJsonSchema = {
  type: 'object',
  properties: {
    workspace: { type: 'string' },
    project: { type: 'string' },
    campaign: { type: 'string' },
    task: { type: 'string' },
    run: { type: 'string' },
  },
  required: ['workspace', 'project'],
  additionalProperties: false,
} as const;

const provenanceJsonSchema = {
  type: 'object',
  properties: {
    checkpointId: { type: 'string' },
    artifactIds: {
      type: 'array',
      items: { type: 'string' },
      default: [],
    },
    note: { type: 'string' },
  },
  required: ['checkpointId'],
  additionalProperties: false,
} as const;

export class Mem0McpServer {
  private readonly transport: StdioJsonRpcTransport;
  private readonly tools: Map<string, ToolDefinition>;

  constructor(
    private readonly adapter: Mem0Adapter,
    transport?: StdioJsonRpcTransport,
  ) {
    this.tools = new Map(
      this.buildTools().map((tool) => [tool.name, tool] as const),
    );
    this.transport =
      transport ?? new StdioJsonRpcTransport((message) => this.handleMessage(message));
  }

  start(): void {
    this.transport.start();
  }

  private async handleMessage(message: JsonRpcMessage): Promise<void> {
    const id = 'id' in message ? (message.id ?? null) : undefined;

    try {
      switch (message.method) {
        case 'initialize':
          this.requireRequestId(id, message.method);
          this.transport.sendResult(id, this.buildInitializeResult(message.params));
          return;
        case 'notifications/initialized':
        case '$/cancelRequest':
        case '$/setTrace':
          return;
        case 'ping':
          if (id !== undefined) {
            this.transport.sendResult(id, {});
          }
          return;
        case 'tools/list':
          this.requireRequestId(id, message.method);
          this.transport.sendResult(id, {
            tools: [...this.tools.values()].map(({ name, description, inputSchema }) => ({
              name,
              description,
              inputSchema,
            })),
          });
          return;
        case 'tools/call':
          this.requireRequestId(id, message.method);
          this.transport.sendResult(id, await this.callTool(message.params));
          return;
        case 'resources/list':
          this.requireRequestId(id, message.method);
          this.transport.sendResult(id, { resources: [] });
          return;
        case 'prompts/list':
          this.requireRequestId(id, message.method);
          this.transport.sendResult(id, { prompts: [] });
          return;
        case 'shutdown':
          this.requireRequestId(id, message.method);
          this.transport.sendResult(id, {});
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

      this.transport.sendError(id, toJsonRpcErrorPayload(error));
    }
  }

  private buildInitializeResult(params: unknown): Record<string, unknown> {
    const parsed = initializeParamsSchema.safeParse(params);
    const protocolVersion =
      parsed.success && parsed.data.protocolVersion !== undefined
        ? parsed.data.protocolVersion
        : '2024-11-05';

    return {
      protocolVersion,
      capabilities: {
        tools: {
          listChanged: false,
        },
      },
      serverInfo: {
        name: 'mem0-mcp',
        version: '0.1.0',
      },
      instructions:
        'SQLite remains canonical. memory_store requires canonical scope metadata and checkpoint provenance before a memory can be persisted.',
    };
  }

  private buildTools(): ToolDefinition[] {
    return [
      {
        name: 'health',
        description:
          'Check the mem0-mcp server state, local store path, configured embedding model, and Ollama availability.',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        handler: async (args) => {
          emptyInputSchema.parse(args ?? {});
          return await this.adapter.healthCheck();
        },
      },
      {
        name: 'memory_store',
        description:
          'Persist a scoped memory with mandatory checkpoint provenance back to SQLite.',
        inputSchema: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: ['decision', 'preference', 'summary', 'artifact_context', 'note'],
            },
            content: { type: 'string' },
            scope: scopeJsonSchema,
            provenance: provenanceJsonSchema,
            metadata: {
              type: 'object',
              additionalProperties: { type: 'string' },
              default: {},
            },
          },
          required: ['kind', 'content', 'scope', 'provenance'],
          additionalProperties: false,
        },
        handler: async (args) => {
          const input = memoryStoreInputSchema.parse(args);
          const memory = await this.adapter.storeMemory(input);

          return { memory };
        },
      },
      {
        name: 'memory_recall',
        description:
          'Recall a single persisted memory by ID within the provided canonical scope.',
        inputSchema: {
          type: 'object',
          properties: {
            memoryId: { type: 'string', format: 'uuid' },
            scope: scopeJsonSchema,
          },
          required: ['memoryId', 'scope'],
          additionalProperties: false,
        },
        handler: async (args) => {
          const input = memoryRecallInputSchema.parse(args);
          const memory = await this.adapter.recallMemory(input);

          return { memory };
        },
      },
      {
        name: 'memory_search',
        description:
          'Run a scoped semantic memory search using the configured Ollama embedding model.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            scope: scopeJsonSchema,
            kind: {
              type: 'string',
              enum: ['decision', 'preference', 'summary', 'artifact_context', 'note'],
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 25,
              default: 5,
            },
          },
          required: ['query', 'scope'],
          additionalProperties: false,
        },
        handler: async (args) => {
          const input = memorySearchInputSchema.parse(args);
          const results = await this.adapter.searchMemory(input);

          return { results };
        },
      },
    ];
  }

  private async callTool(params: unknown): Promise<Record<string, unknown>> {
    const parsed = toolCallParamsSchema.parse(params);
    const tool = this.tools.get(parsed.name);

    if (tool === undefined) {
      throw new JsonRpcError(-32602, `Unknown tool: ${parsed.name}`);
    }

    try {
      const payload = await tool.handler(parsed.arguments);
      return toToolResult(payload, false);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return toToolResult(
          {
            error: `Invalid arguments for ${parsed.name}`,
            issues: error.issues,
          },
          true,
        );
      }

      return toToolResult({ error: getErrorMessage(error) }, true);
    }
  }

  private requireRequestId(id: JsonRpcId | undefined, method: string): asserts id is JsonRpcId {
    if (id === undefined) {
      throw new JsonRpcError(
        -32600,
        `Method ${method} must be called as a request with an id`,
      );
    }
  }
}

function toToolResult(payload: unknown, isError: boolean): Record<string, unknown> {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
    isError,
  };
}

function toJsonRpcErrorPayload(error: unknown): JsonRpcErrorPayload {
  if (error instanceof JsonRpcError) {
    return {
      code: error.code,
      message: error.message,
      data: error.data,
    };
  }

  if (error instanceof z.ZodError) {
    return {
      code: -32602,
      message: 'Invalid params',
      data: error.issues,
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
