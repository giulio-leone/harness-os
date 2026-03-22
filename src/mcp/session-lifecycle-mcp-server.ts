import { z } from 'zod';

import { SessionLifecycleAdapter } from '../runtime/session-lifecycle-adapter.js';
import {
  createHarnessCampaign,
  harnessCreateCampaignInputSchema,
  harnessInitWorkspaceInputSchema,
  harnessPlanIssuesInputSchema,
  harnessRollbackIssueInputSchema,
  initHarnessWorkspace,
  planHarnessIssues,
  rollbackHarnessIssue,
} from '../runtime/harness-planning-tools.js';
import {
  incrementalSessionInputSchema,
  inspectIssueInputSchema,
  inspectOverviewInputSchema,
  queuePromotionInputSchema,
  recoverySessionInputSchema,
  sessionCheckpointInputSchema,
  sessionCloseInputSchema,
  sessionContextSchema,
} from '../runtime/session-lifecycle-cli.schemas.js';
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

const sessionMemoryContextJsonSchema = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean' },
    available: { type: 'boolean' },
    query: { type: 'string' },
    details: { type: 'string' },
    recalledMemories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          memory: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              kind: {
                type: 'string',
                enum: ['decision', 'preference', 'summary', 'artifact_context', 'note'],
              },
              content: { type: 'string' },
              scope: scopeJsonSchema,
              provenance: {
                type: 'object',
                properties: {
                  checkpointId: { type: 'string' },
                  artifactIds: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                  note: { type: 'string' },
                },
                required: ['checkpointId', 'artifactIds'],
                additionalProperties: false,
              },
              metadata: {
                type: 'object',
                additionalProperties: { type: 'string' },
              },
              createdAt: { type: 'string', format: 'date-time' },
              updatedAt: { type: 'string', format: 'date-time' },
            },
            required: [
              'id',
              'kind',
              'content',
              'scope',
              'provenance',
              'metadata',
              'createdAt',
              'updatedAt',
            ],
            additionalProperties: false,
          },
          score: { type: 'number' },
        },
        required: ['memory', 'score'],
        additionalProperties: false,
      },
    },
  },
  required: ['enabled', 'available', 'query', 'recalledMemories'],
  additionalProperties: false,
} as const;

const sessionContextJsonSchema = {
  type: 'object',
  properties: {
    sessionId: { type: 'string' },
    dbPath: { type: 'string' },
    workspaceId: { type: 'string' },
    projectId: { type: 'string' },
    campaignId: { type: 'string' },
    agentId: { type: 'string' },
    host: { type: 'string' },
    runId: { type: 'string' },
    leaseId: { type: 'string' },
    leaseExpiresAt: { type: 'string', format: 'date-time' },
    issueId: { type: 'string' },
    issueTask: { type: 'string' },
    claimMode: { type: 'string', enum: ['claim', 'resume', 'recovery'] },
    scope: scopeJsonSchema,
    currentTaskStatus: {
      type: 'string',
      enum: ['pending', 'ready', 'in_progress', 'blocked', 'needs_recovery', 'done', 'failed'],
    },
    currentCheckpointId: { type: 'string', format: 'uuid' },
    mem0: sessionMemoryContextJsonSchema,
  },
  required: [
    'sessionId',
    'dbPath',
    'workspaceId',
    'projectId',
    'agentId',
    'host',
    'runId',
    'leaseId',
    'leaseExpiresAt',
    'issueId',
    'issueTask',
    'claimMode',
    'scope',
    'currentTaskStatus',
    'currentCheckpointId',
    'mem0',
  ],
  additionalProperties: false,
} as const;

export class SessionLifecycleMcpServer {
  private readonly transport: StdioJsonRpcTransport;
  private readonly tools: Map<string, ToolDefinition>;

  constructor(
    private readonly adapter: SessionLifecycleAdapter,
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
        name: 'session-lifecycle-mcp',
        version: '0.1.0',
      },
      instructions:
        'Use the lifecycle tools to claim, reconcile, recover, checkpoint, close, and inspect work through the stabilized session-lifecycle core. SQLite remains canonical.',
    };
  }

  private buildTools(): ToolDefinition[] {
    return [
      {
        name: 'harness_init_workspace',
        description: 'Initialize a new harness workspace and database locally.',
        inputSchema: {
          type: 'object',
          properties: {
            dbPath: { type: 'string' },
            workspaceName: { type: 'string' },
          },
          required: ['dbPath', 'workspaceName'],
          additionalProperties: false,
        },
        handler: async (args) => initHarnessWorkspace(
          harnessInitWorkspaceInputSchema.parse(args),
        ),
      },
      {
        name: 'harness_create_campaign',
        description: 'Create a new project and campaign in a workspace.',
        inputSchema: {
          type: 'object',
          properties: {
            dbPath: { type: 'string' },
            workspaceId: { type: 'string' },
            projectName: { type: 'string' },
            campaignName: { type: 'string' },
            objective: { type: 'string' },
          },
          required: ['dbPath', 'workspaceId', 'projectName', 'campaignName', 'objective'],
          additionalProperties: false,
        },
        handler: async (args) =>
          createHarnessCampaign(harnessCreateCampaignInputSchema.parse(args)),
      },
      {
        name: 'harness_plan_issues',
        description: 'Bulk create a milestone and sequential issues for a campaign.',
        inputSchema: {
          type: 'object',
          properties: {
            dbPath: { type: 'string' },
            projectId: { type: 'string' },
            campaignId: { type: 'string' },
            milestoneDescription: { type: 'string' },
            issues: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  task: { type: 'string' },
                  priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
                  size: { type: 'string' },
                  depends_on_indices: { type: 'array', items: { type: 'number' }, description: 'Indices of the issues array this task depends on. E.g. [0] means it depends on the first task in the array.' },
                },
                required: ['task', 'priority', 'size'],
                additionalProperties: false,
              }
            }
          },
          required: ['dbPath', 'projectId', 'campaignId', 'milestoneDescription', 'issues'],
          additionalProperties: false,
        },
        handler: async (args) =>
          planHarnessIssues(harnessPlanIssuesInputSchema.parse(args)),
      },
      {
        name: 'harness_rollback_issue',
        description: 'Hard rollback: reset a failed or stuck issue back to pending status and expire its lease.',
        inputSchema: {
          type: 'object',
          properties: {
            dbPath: { type: 'string' },
            issueId: { type: 'string' },
          },
          required: ['dbPath', 'issueId'],
          additionalProperties: false,
        },
        handler: async (args) =>
          rollbackHarnessIssue(harnessRollbackIssueInputSchema.parse(args)),
      },
      {
        name: 'begin_incremental_session',
        description:
          'Claim or resume incremental lifecycle work after reconciliation checks.',
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: { type: 'string' },
            dbPath: { type: 'string' },
            workspaceId: { type: 'string' },
            projectId: { type: 'string' },
            progressPath: { type: 'string' },
            featureListPath: { type: 'string' },
            planPath: { type: 'string' },
            syncManifestPath: { type: 'string' },
            mem0Enabled: { type: 'boolean' },
            campaignId: { type: 'string' },
            preferredIssueId: { type: 'string' },
            agentId: { type: 'string' },
            host: { type: 'string' },
            leaseTtlSeconds: { type: 'integer', minimum: 1 },
            checkpointFreshnessSeconds: { type: 'integer', minimum: 1 },
            memoryQuery: { type: 'string' },
            memorySearchLimit: { type: 'integer', minimum: 1, maximum: 25 },
          },
          required: [
            'sessionId',
            'dbPath',
            'workspaceId',
            'projectId',
            'progressPath',
            'featureListPath',
            'planPath',
            'syncManifestPath',
            'mem0Enabled',
          ],
          additionalProperties: false,
        },
        handler: async (args) => {
          const input = incrementalSessionInputSchema.parse(args);
          return await this.adapter.execute({
            action: 'begin_incremental',
            input,
          });
        },
      },
      {
        name: 'begin_recovery_session',
        description:
          'Resolve a needs_recovery task by superseding stale leases and claiming a fresh recovery lease.',
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: { type: 'string' },
            dbPath: { type: 'string' },
            workspaceId: { type: 'string' },
            projectId: { type: 'string' },
            progressPath: { type: 'string' },
            featureListPath: { type: 'string' },
            planPath: { type: 'string' },
            syncManifestPath: { type: 'string' },
            mem0Enabled: { type: 'boolean' },
            campaignId: { type: 'string' },
            preferredIssueId: { type: 'string' },
            agentId: { type: 'string' },
            host: { type: 'string' },
            leaseTtlSeconds: { type: 'integer', minimum: 1 },
            checkpointFreshnessSeconds: { type: 'integer', minimum: 1 },
            memoryQuery: { type: 'string' },
            memorySearchLimit: { type: 'integer', minimum: 1, maximum: 25 },
            recoverySummary: { type: 'string' },
            recoveryNextStep: { type: 'string' },
          },
          required: [
            'sessionId',
            'dbPath',
            'workspaceId',
            'projectId',
            'progressPath',
            'featureListPath',
            'planPath',
            'syncManifestPath',
            'mem0Enabled',
            'recoverySummary',
          ],
          additionalProperties: false,
        },
        handler: async (args) => {
          const input = recoverySessionInputSchema.parse(args);
          return await this.adapter.execute({
            action: 'begin_recovery',
            input,
          });
        },
      },
      {
        name: 'checkpoint_session',
        description:
          'Write a canonical lifecycle checkpoint and optionally persist a derived mem0 summary.',
        inputSchema: {
          type: 'object',
          properties: {
            context: sessionContextJsonSchema,
            input: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                summary: { type: 'string' },
                taskStatus: {
                  type: 'string',
                  enum: [
                    'pending',
                    'ready',
                    'in_progress',
                    'blocked',
                    'needs_recovery',
                    'done',
                    'failed',
                  ],
                },
                nextStep: { type: 'string' },
                artifactIds: {
                  type: 'array',
                  items: { type: 'string' },
                },
                persistToMem0: { type: 'boolean' },
                memoryKind: {
                  type: 'string',
                  enum: ['decision', 'preference', 'summary', 'artifact_context', 'note'],
                },
                memoryContent: { type: 'string' },
                metadata: {
                  type: 'object',
                  additionalProperties: { type: 'string' },
                },
              },
              required: ['title', 'summary', 'taskStatus', 'nextStep'],
              additionalProperties: false,
            },
          },
          required: ['context', 'input'],
          additionalProperties: false,
        },
        handler: async (args) => {
          const parsed = z
            .object({
              context: sessionContextSchema,
              input: sessionCheckpointInputSchema,
            })
            .strict()
            .parse(args);
          return await this.adapter.execute({
            action: 'checkpoint',
            ...parsed,
          });
        },
      },
      {
        name: 'close_session',
        description:
          'Write the final checkpoint, optionally persist mem0, and close the current lease.',
        inputSchema: {
          type: 'object',
          properties: {
            context: sessionContextJsonSchema,
            input: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                summary: { type: 'string' },
                taskStatus: {
                  type: 'string',
                  enum: [
                    'pending',
                    'ready',
                    'in_progress',
                    'blocked',
                    'needs_recovery',
                    'done',
                    'failed',
                  ],
                },
                nextStep: { type: 'string' },
                artifactIds: {
                  type: 'array',
                  items: { type: 'string' },
                },
                persistToMem0: { type: 'boolean' },
                memoryKind: {
                  type: 'string',
                  enum: ['decision', 'preference', 'summary', 'artifact_context', 'note'],
                },
                memoryContent: { type: 'string' },
                metadata: {
                  type: 'object',
                  additionalProperties: { type: 'string' },
                },
                releaseLease: { type: 'boolean' },
              },
              required: ['title', 'summary', 'taskStatus', 'nextStep'],
              additionalProperties: false,
            },
          },
          required: ['context', 'input'],
          additionalProperties: false,
        },
        handler: async (args) => {
          const parsed = z
            .object({
              context: sessionContextSchema,
              input: sessionCloseInputSchema,
            })
            .strict()
            .parse(args);
          return await this.adapter.execute({
            action: 'close',
            ...parsed,
          });
        },
      },
      {
        name: 'inspect_overview',
        description:
          'Read a project-level lifecycle overview including ready work, recovery queue, leases, and recent runs.',
        inputSchema: {
          type: 'object',
          properties: {
            dbPath: { type: 'string' },
            projectId: { type: 'string' },
            campaignId: { type: 'string' },
            runLimit: { type: 'integer', minimum: 1, maximum: 100 },
          },
          required: ['dbPath', 'projectId'],
          additionalProperties: false,
        },
        handler: async (args) => {
          const input = inspectOverviewInputSchema.parse(args);
          return await this.adapter.execute({
            action: 'inspect_overview',
            input,
          });
        },
      },
      {
        name: 'inspect_issue',
        description:
          'Read issue-level lifecycle evidence including leases, checkpoints, memory links, and events.',
        inputSchema: {
          type: 'object',
          properties: {
            dbPath: { type: 'string' },
            issueId: { type: 'string' },
            includeEvents: { type: 'boolean' },
            eventLimit: { type: 'integer', minimum: 1, maximum: 100 },
          },
          required: ['dbPath', 'issueId'],
          additionalProperties: false,
        },
        handler: async (args) => {
          const input = inspectIssueInputSchema.parse(args);
          return await this.adapter.execute({
            action: 'inspect_issue',
            input,
          });
        },
      },
      {
        name: 'promote_queue',
        description:
          'Promote eligible pending issues to ready when their dependencies are satisfied.',
        inputSchema: {
          type: 'object',
          properties: {
            dbPath: { type: 'string' },
            projectId: { type: 'string' },
            campaignId: { type: 'string' },
          },
          required: ['dbPath', 'projectId'],
          additionalProperties: false,
        },
        handler: async (args) => {
          const input = queuePromotionInputSchema.parse(args);
          return await this.adapter.execute({
            action: 'promote_queue',
            input,
          });
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
