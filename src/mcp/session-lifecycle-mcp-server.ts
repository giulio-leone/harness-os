import { randomUUID } from 'node:crypto';

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
  AgenticToolError,
  buildMeta,
  resolveDbPath,
  resolveProjectId,
  resolveCampaignId,
  SessionTokenStore,
} from '../runtime/harness-agentic-helpers.js';
import type { SessionContext } from '../contracts/session-contracts.js';
import {
  incrementalSessionInputSchema,
  inspectIssueInputSchema,
  inspectOverviewInputSchema,
  queuePromotionInputSchema,
  recoverySessionInputSchema,
  sessionCheckpointInputSchema,
  sessionCloseInputSchema,
} from '../runtime/session-lifecycle-cli.schemas.js';
import {
  openHarnessDatabase,
  selectAll,
  selectOne,
} from '../db/store.js';
import {
  type JsonRpcErrorPayload,
  type JsonRpcId,
  type JsonRpcMessage,
  JsonRpcError,
  StdioJsonRpcTransport,
} from 'mcp-hot-reload';

// ─── Types ──────────────────────────────────────────────────────────

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


// ─── Server ─────────────────────────────────────────────────────────

const HARNESS_INSTRUCTIONS = `You are connected to the agent-harness lifecycle server — an Agentic OS for autonomous task execution.

ORIENTATION (call first in any new session):
- harness_get_context → see current workspace, project, campaign, and queue status
- harness_next_action → get a directive on exactly what tool to call next

SETUP (one-time, when no workspace/project exists):
1. harness_init_workspace → creates the SQLite database and workspace
2. harness_create_campaign → registers a project and campaign
3. harness_plan_issues → populates the task queue with issues

EXECUTION LOOP (repeated):
4. promote_queue → unlocks pending tasks whose dependencies are done
5. begin_incremental_session → claims the next ready task, returns sessionToken + context
6. [Do the work described in the issued task]
7. checkpoint_session → save progress (accepts sessionToken)
8. advance_session → closes the current task and IMMEDIATELY claims the next one (accepts sessionToken). Prefer this over step 8 + 4 + 5 for efficiency.
9. close_session → if you must close without advancing, use this instead (accepts sessionToken).

RECOVERY:
- harness_rollback_issue → hard-reset a failed/stuck issue to pending
- begin_recovery_session → claim a needs_recovery issue with a fresh lease

RULES:
- dbPath is optional: set HARNESS_DB_PATH env var to avoid passing it every call.
- Tools accept human-readable names (projectName, campaignName) instead of UUIDs.
- Always pass the short \`sessionToken\` returned by begin_* to checkpoint/close tools, instead of the heavy \`context\` object.
- Every response includes _meta.nextTools and _meta.hint telling you what to do next.`;

export class SessionLifecycleMcpServer {
  private readonly transport: StdioJsonRpcTransport;
  private readonly tools: Map<string, ToolDefinition>;
  private readonly tokenStore = new SessionTokenStore();

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
        name: 'agent-harness',
        version: '0.2.0',
      },
      instructions: HARNESS_INSTRUCTIONS,
    };
  }

  // ─── Tool Definitions ───────────────────────────────────────────

  private buildTools(): ToolDefinition[] {
    return [
      // ── Orientation Tools ───────────────────────────────────────
      {
        name: 'harness_get_context',
        description:
          'Get the current workspace, project, campaign, and queue status. Call this FIRST when starting a new session to orient yourself. Returns everything you need to know about the current state.',
        inputSchema: {
          type: 'object',
          properties: {
            dbPath: { type: 'string', description: 'Optional if HARNESS_DB_PATH is set.' },
          },
        },
        handler: async (args) => {
          const parsed = z.object({ dbPath: z.string().optional() }).parse(args ?? {});
          return getHarnessContext(parsed.dbPath);
        },
      },
      {
        name: 'harness_next_action',
        description:
          'Evaluates the current DB state and returns a directive: exactly which tool to call next and why. Use this when you are unsure what to do. Returns { action, tool, reason, suggestedPayload }.',
        inputSchema: {
          type: 'object',
          properties: {
            dbPath: { type: 'string', description: 'Optional if HARNESS_DB_PATH is set.' },
            projectId: { type: 'string' },
            projectName: { type: 'string', description: 'Human-readable project name (alternative to projectId).' },
          },
        },
        handler: async (args) => {
          const parsed = z.object({
            dbPath: z.string().optional(),
            projectId: z.string().optional(),
            projectName: z.string().optional(),
          }).parse(args ?? {});
          return getNextAction(parsed);
        },
      },

      // ── Setup Tools ─────────────────────────────────────────────
      {
        name: 'harness_init_workspace',
        description:
          'Create a brand-new workspace with its SQLite database. Call this FIRST when no workspace exists yet. Returns the workspaceId you need for harness_create_campaign.',
        inputSchema: {
          type: 'object',
          properties: {
            dbPath: { type: 'string', description: 'Path for the SQLite DB. Optional if HARNESS_DB_PATH is set.' },
            workspaceName: { type: 'string' },
          },
          required: ['workspaceName'],
        },
        handler: async (args) => initHarnessWorkspace(
          harnessInitWorkspaceInputSchema.parse(args),
        ),
      },
      {
        name: 'harness_create_campaign',
        description:
          'Register a project and campaign inside an existing workspace. Idempotent: re-calling with the same names returns existing IDs. workspaceId is auto-resolved if only one workspace exists. Returns projectId and campaignId needed by harness_plan_issues.',
        inputSchema: {
          type: 'object',
          properties: {
            dbPath: { type: 'string', description: 'Optional if HARNESS_DB_PATH is set.' },
            workspaceId: { type: 'string', description: 'Optional: auto-resolved if only one workspace exists.' },
            projectName: { type: 'string' },
            campaignName: { type: 'string' },
            objective: { type: 'string' },
          },
          required: ['projectName', 'campaignName', 'objective'],
        },
        handler: async (args) =>
          createHarnessCampaign(harnessCreateCampaignInputSchema.parse(args)),
      },
      {
        name: 'harness_plan_issues',
        description:
          'Inject a batch of tasks into the execution queue as "pending" issues. Use depends_on_indices to chain tasks sequentially (e.g., [0] means "depends on the first task"). Accepts projectName/campaignName instead of UUIDs. After this, call promote_queue then begin_incremental_session to start working.',
        inputSchema: {
          type: 'object',
          properties: {
            dbPath: { type: 'string', description: 'Optional if HARNESS_DB_PATH is set.' },
            projectId: { type: 'string', description: 'Project UUID (or use projectName instead).' },
            projectName: { type: 'string', description: 'Human-readable project name (resolved to projectId).' },
            campaignId: { type: 'string', description: 'Campaign UUID (or use campaignName instead).' },
            campaignName: { type: 'string', description: 'Human-readable campaign name (resolved to campaignId).' },
            milestoneDescription: { type: 'string' },
            issues: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  task: { type: 'string' },
                  priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
                  size: { type: 'string' },
                  depends_on_indices: {
                    type: 'array',
                    items: { type: 'number' },
                    description: 'Indices of the issues array this task depends on. E.g. [0] means it depends on the first task in the array.',
                  },
                },
                required: ['task', 'priority', 'size'],
              },
            },
          },
          required: ['milestoneDescription', 'issues'],
        },
        handler: async (args) =>
          planHarnessIssues(harnessPlanIssuesInputSchema.parse(args)),
      },
      {
        name: 'harness_rollback_issue',
        description:
          'Emergency reset: moves a failed/stuck issue back to "pending" and releases its lease. Use when an issue is unrecoverable in its current state. Does NOT revert file-system changes — only resets the DB state.',
        inputSchema: {
          type: 'object',
          properties: {
            dbPath: { type: 'string', description: 'Optional if HARNESS_DB_PATH is set.' },
            issueId: { type: 'string' },
          },
          required: ['issueId'],
        },
        handler: async (args) =>
          rollbackHarnessIssue(harnessRollbackIssueInputSchema.parse(args)),
      },

      // ── Lifecycle Tools ─────────────────────────────────────────
      {
        name: 'begin_incremental_session',
        description:
          'Pick up the next available task from the queue. Returns the full session context (issueId, leaseId, task description, mem0 memories) you need to do the work and later call checkpoint_session or close_session. Accepts projectName instead of projectId.',
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: { type: 'string' },
            dbPath: { type: 'string', description: 'Optional if HARNESS_DB_PATH is set.' },
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
            'workspaceId',
            'projectId',
            'progressPath',
            'featureListPath',
            'planPath',
            'syncManifestPath',
            'mem0Enabled',
          ],
        },
        handler: async (args) => {
          const input = incrementalSessionInputSchema.parse(args);
          const dbPath = resolveDbPath(input.dbPath);
          const result = (await this.adapter.execute({
            action: 'begin_incremental',
            input: { ...input, dbPath },
          })) as { context: SessionContext };
          const sessionToken = this.tokenStore.store(
            result.context as unknown as Record<string, unknown>,
            input as Record<string, unknown>
          );
          return {
            ...result,
            sessionToken,
            ...buildMeta(
              ['checkpoint_session', 'close_session', 'advance_session'],
              'Session started. Do the work described in the task, then call checkpoint_session to save progress, close_session when done, or advance_session to close and immediately start the next task.',
            ),
          };
        },
      },
      {
        name: 'begin_recovery_session',
        description:
          'Resolve a needs_recovery task by superseding stale leases and claiming a fresh recovery lease. Use when harness_next_action tells you a task needs recovery.',
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: { type: 'string' },
            dbPath: { type: 'string', description: 'Optional if HARNESS_DB_PATH is set.' },
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
            'workspaceId',
            'projectId',
            'progressPath',
            'featureListPath',
            'planPath',
            'syncManifestPath',
            'mem0Enabled',
            'recoverySummary',
          ],
        },
        handler: async (args) => {
          const input = recoverySessionInputSchema.parse(args);
          const dbPath = resolveDbPath(input.dbPath);
          const result = (await this.adapter.execute({
            action: 'begin_recovery',
            input: { ...input, dbPath },
          })) as { context: SessionContext };
          const sessionToken = this.tokenStore.store(
            result.context as unknown as Record<string, unknown>,
            input as Record<string, unknown>
          );
          return {
            ...result,
            sessionToken,
            ...buildMeta(
              ['checkpoint_session', 'close_session', 'advance_session'],
              'Recovery session started. Do the recovery work, then call checkpoint_session, close_session, or advance_session.',
            ),
          };
        },
      },
      {
        name: 'checkpoint_session',
        description:
          'Save your progress on the current task. Call this after every meaningful step so that if you crash, recovery can resume from here. Pass the sessionToken returned by begin_* instead of the full context.',
        inputSchema: {
          type: 'object',
          properties: {
            sessionToken: { type: 'string' },
            input: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                summary: { type: 'string' },
                taskStatus: {
                  type: 'string',
                  enum: ['pending', 'ready', 'in_progress', 'blocked', 'needs_recovery', 'done', 'failed'],
                },
                nextStep: { type: 'string' },
                artifactIds: { type: 'array', items: { type: 'string' } },
                persistToMem0: { type: 'boolean' },
                memoryKind: {
                  type: 'string',
                  enum: ['decision', 'preference', 'summary', 'artifact_context', 'note'],
                },
                memoryContent: { type: 'string' },
                metadata: { type: 'object' },
              },
              required: ['title', 'summary', 'taskStatus', 'nextStep'],
            },
          },
          required: ['sessionToken', 'input'],
        },
        handler: async (args) => {
          const parsed = z
            .object({
              sessionToken: z.string(),
              input: sessionCheckpointInputSchema,
            })
            .strict()
            .parse(args);
          
          const session = this.tokenStore.resolve(parsed.sessionToken);
          const context = session.context as unknown as SessionContext;
          const dbPath = resolveDbPath(context.dbPath);
          const result = (await this.adapter.execute({
            action: 'checkpoint',
            context: { ...context, dbPath },
            input: parsed.input,
          })) as { result: { checkpoint: { id: string } } };

          this.tokenStore.updateContext(parsed.sessionToken, {
            currentCheckpointId: result.result.checkpoint.id,
            currentTaskStatus: parsed.input.taskStatus,
          });

          return {
            ...result,
            ...buildMeta(
              ['checkpoint_session', 'close_session', 'advance_session'],
              'Progress saved. Continue working and checkpoint again, or call close_session/advance_session when the task is complete.',
            ),
          };
        },
      },
      {
        name: 'close_session',
        description:
          'Mark the current task as done (or failed) and release the lease. Automatically promotes dependent tasks. If closing with "done", you should probably use "advance_session" instead to immediately pick up the next task.',
        inputSchema: {
          type: 'object',
          properties: {
            sessionToken: { type: 'string' },
            input: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                summary: { type: 'string' },
                taskStatus: {
                  type: 'string',
                  enum: ['pending', 'ready', 'in_progress', 'blocked', 'needs_recovery', 'done', 'failed'],
                },
                nextStep: { type: 'string' },
                artifactIds: { type: 'array', items: { type: 'string' } },
                persistToMem0: { type: 'boolean' },
                memoryKind: {
                  type: 'string',
                  enum: ['decision', 'preference', 'summary', 'artifact_context', 'note'],
                },
                memoryContent: { type: 'string' },
                metadata: { type: 'object' },
                releaseLease: { type: 'boolean' },
              },
              required: ['title', 'summary', 'taskStatus', 'nextStep'],
            },
          },
          required: ['sessionToken', 'input'],
        },
        handler: async (args) => {
          const parsed = z
            .object({
              sessionToken: z.string(),
              input: sessionCloseInputSchema,
            })
            .strict()
            .parse(args);
          const session = this.tokenStore.resolve(parsed.sessionToken);
          const context = session.context as unknown as SessionContext;
          const dbPath = resolveDbPath(context.dbPath);
          
          const result = (await this.adapter.execute({
            action: 'close',
            context: { ...context, dbPath },
            input: parsed.input,
          })) as Record<string, unknown>;

          this.tokenStore.remove(parsed.sessionToken);

          const promotedIds = (result['promotedIssueIds'] as string[] | undefined) ?? [];
          const hint =
            promotedIds.length > 0
              ? `Session closed. ${promotedIds.length} dependent task(s) promoted to ready. Call begin_incremental_session to pick up the next one.`
              : 'Session closed. No more ready tasks. Call inspect_overview or harness_next_action to check queue status.';

          return {
            ...result,
            ...buildMeta(
              promotedIds.length > 0
                ? ['begin_incremental_session']
                : ['harness_next_action', 'inspect_overview'],
              hint,
            ),
          };
        },
      },
      {
        name: 'advance_session',
        description:
          'Close the current session and IMMEDIATELY begin the next one. This combines close_session, promote_queue, and begin_incremental_session into a single atomic action. Use this to move to the next task faster. Returns the new sessionToken and context.',
        inputSchema: {
          type: 'object',
          properties: {
            sessionToken: { type: 'string' },
            closeInput: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                summary: { type: 'string' },
                taskStatus: {
                  type: 'string',
                  enum: ['pending', 'ready', 'in_progress', 'blocked', 'needs_recovery', 'done', 'failed'],
                },
                nextStep: { type: 'string' },
                artifactIds: { type: 'array', items: { type: 'string' } },
                persistToMem0: { type: 'boolean' },
                memoryKind: {
                  type: 'string',
                  enum: ['decision', 'preference', 'summary', 'artifact_context', 'note'],
                },
                memoryContent: { type: 'string' },
                metadata: { type: 'object' },
                releaseLease: { type: 'boolean' },
              },
              required: ['title', 'summary', 'taskStatus', 'nextStep'],
            },
          },
          required: ['sessionToken', 'closeInput'],
        },
        handler: async (args) => {
          const parsed = z
            .object({
              sessionToken: z.string(),
              closeInput: sessionCloseInputSchema,
            })
            .strict()
            .parse(args);

          const session = this.tokenStore.resolve(parsed.sessionToken);
          const context = session.context as unknown as SessionContext;
          const dbPath = resolveDbPath(context.dbPath);

          // 1. Close current session
          const closeResult = (await this.adapter.execute({
            action: 'close',
            context: { ...context, dbPath },
            input: parsed.closeInput,
          })) as Record<string, unknown>;

          // 2. Begin new session explicitly reusing the original inputs from begin_*
          const nextBeginInput = buildNextIncrementalInput(
            session.beginInput,
            dbPath,
          );
          let beginResult: { context: SessionContext };
          try {
            beginResult = (await this.adapter.execute({
              action: 'begin_incremental',
              input: nextBeginInput,
            })) as { context: SessionContext };
          } catch (error) {
            this.tokenStore.remove(parsed.sessionToken);

            if (
              error instanceof Error &&
              error.message.startsWith('No ready issues are available for project ')
            ) {
              const promotedIds =
                (closeResult['promotedIssueIds'] as string[] | undefined) ?? [];
              const hint =
                promotedIds.length > 0
                  ? `Session closed. ${promotedIds.length} dependent task(s) were promoted, but none were claimable yet. Call begin_incremental_session to retry or inspect_overview to check queue state.`
                  : 'Session closed. No more ready tasks were available to advance into. Call inspect_overview or harness_next_action to decide the next step.';

              return {
                ...closeResult,
                advanced: false,
                ...buildMeta(
                  promotedIds.length > 0
                    ? ['begin_incremental_session', 'inspect_overview']
                    : ['inspect_overview', 'harness_next_action'],
                  hint,
                ),
              };
            }

            throw new AgenticToolError(
              `Current session was closed, but advance_session could not start the next task: ${getErrorMessage(error)}`,
              'The current task is already closed. Call inspect_overview or harness_next_action to inspect queue state before starting another session.',
              'inspect_overview',
            );
          }

          this.tokenStore.remove(parsed.sessionToken);

          const newToken = this.tokenStore.store(
            beginResult.context as unknown as Record<string, unknown>,
            session.beginInput
          );

          return {
            ...beginResult,
            sessionToken: newToken,
            ...buildMeta(
              ['checkpoint_session', 'close_session', 'advance_session'],
              'Advanced to next session! Do the work described in the task, then call checkpoint_session or advance_session.',
            ),
          };
        },
      },

      // ── Inspection Tools ────────────────────────────────────────
      {
        name: 'inspect_overview',
        description:
          'Get a dashboard of all tasks: what is ready, what is in_progress, what needs recovery. Use this to understand the current state before deciding what to do. Accepts projectName instead of projectId.',
        inputSchema: {
          type: 'object',
          properties: {
            dbPath: { type: 'string', description: 'Optional if HARNESS_DB_PATH is set.' },
            projectId: { type: 'string', description: 'Project UUID (or use projectName instead).' },
            projectName: { type: 'string', description: 'Human-readable project name (resolved to projectId).' },
            campaignId: { type: 'string' },
            runLimit: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
        handler: async (args) => {
          const parsed = z.object({
            dbPath: z.string().optional(),
            projectId: z.string().optional(),
            projectName: z.string().optional(),
            campaignId: z.string().optional(),
            runLimit: z.number().int().positive().max(100).optional(),
          }).parse(args);
          const dbPath = resolveDbPath(parsed.dbPath);
          const db = openHarnessDatabase({ dbPath });
          try {
            const projectId = resolveProjectId(db.connection, {
              projectId: parsed.projectId,
              projectName: parsed.projectName,
            });
            const result = await this.adapter.execute({
              action: 'inspect_overview',
              input: { dbPath, projectId, campaignId: parsed.campaignId, runLimit: parsed.runLimit },
            }) as Record<string, unknown>;
            const counts = result['counts'] as Record<string, number> | undefined;
            const readyCount = counts?.['readyIssues'] ?? 0;
            const recoveryCount = counts?.['recoveryIssues'] ?? 0;

            let hint = '';
            if (recoveryCount > 0) {
              hint = `${recoveryCount} issue(s) need recovery. Call begin_recovery_session.`;
            } else if (readyCount > 0) {
              hint = `${readyCount} ready task(s). Call begin_incremental_session to start working.`;
            } else {
              hint = 'No ready tasks. Call promote_queue to check for promotable pending tasks.';
            }

            return {
              ...result,
              ...buildMeta(
                recoveryCount > 0
                  ? ['begin_recovery_session']
                  : readyCount > 0
                    ? ['begin_incremental_session']
                    : ['promote_queue'],
                hint,
              ),
            };
          } finally {
            db.close();
          }
        },
      },
      {
        name: 'inspect_issue',
        description:
          'Read issue-level lifecycle evidence including leases, checkpoints, memory links, and events. Use to debug a specific task.',
        inputSchema: {
          type: 'object',
          properties: {
            dbPath: { type: 'string', description: 'Optional if HARNESS_DB_PATH is set.' },
            issueId: { type: 'string' },
            includeEvents: { type: 'boolean' },
            eventLimit: { type: 'integer', minimum: 1, maximum: 100 },
          },
          required: ['issueId'],
        },
        handler: async (args) => {
          const input = inspectIssueInputSchema.parse(args);
          const dbPath = resolveDbPath(input.dbPath);
          const result = await this.adapter.execute({
            action: 'inspect_issue',
            input: { ...input, dbPath },
          }) as Record<string, unknown>;
          const issue = result['issue'] as Record<string, unknown> | undefined;
          const status = issue?.['status'] as string | undefined;

          let hint = 'Issue details loaded.';
          let nextTools = ['inspect_overview'];
          if (status === 'needs_recovery') {
            hint = 'This issue needs recovery. Call begin_recovery_session with this issueId.';
            nextTools = ['begin_recovery_session'];
          } else if (status === 'failed') {
            hint = 'This issue has failed. Call harness_rollback_issue to reset it to pending.';
            nextTools = ['harness_rollback_issue'];
          }

          return {
            ...result,
            ...buildMeta(nextTools, hint),
          };
        },
      },
      {
        name: 'promote_queue',
        description:
          'Scan all "pending" tasks and promote any whose dependencies are now satisfied to "ready" status. Call this after closing a task to unlock downstream work. Accepts projectName instead of projectId.',
        inputSchema: {
          type: 'object',
          properties: {
            dbPath: { type: 'string', description: 'Optional if HARNESS_DB_PATH is set.' },
            projectId: { type: 'string', description: 'Project UUID (or use projectName instead).' },
            projectName: { type: 'string', description: 'Human-readable project name (resolved to projectId).' },
            campaignId: { type: 'string' },
          },
        },
        handler: async (args) => {
          const parsed = z.object({
            dbPath: z.string().optional(),
            projectId: z.string().optional(),
            projectName: z.string().optional(),
            campaignId: z.string().optional(),
          }).parse(args);
          const dbPath = resolveDbPath(parsed.dbPath);
          const db = openHarnessDatabase({ dbPath });
          try {
            const projectId = resolveProjectId(db.connection, {
              projectId: parsed.projectId,
              projectName: parsed.projectName,
            });
            const result = await this.adapter.execute({
              action: 'promote_queue',
              input: { dbPath, projectId, campaignId: parsed.campaignId },
            }) as Record<string, unknown>;
            const promotedIds = (result['promotedIssueIds'] as string[] | undefined) ?? [];

            return {
              ...result,
              ...buildMeta(
                promotedIds.length > 0
                  ? ['begin_incremental_session']
                  : ['harness_next_action'],
                promotedIds.length > 0
                  ? `${promotedIds.length} task(s) promoted to ready. Call begin_incremental_session to start working.`
                  : 'No tasks were promoted. All dependencies may still be pending. Call harness_next_action for guidance.',
              ),
            };
          } finally {
            db.close();
          }
        },
      },
    ];
  }

  // ─── Tool Call Dispatcher ───────────────────────────────────────

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
      if (error instanceof AgenticToolError) {
        return toToolResult(error.toJSON(), true);
      }

      if (error instanceof z.ZodError) {
        return toToolResult(
          {
            error: `Invalid arguments for ${parsed.name}`,
            issues: error.issues,
            recovery: 'Check the tool description for the correct input schema and retry.',
          },
          true,
        );
      }

      return toToolResult({
        error: getErrorMessage(error),
        recovery: 'Inspect the error message. If the issue persists, call harness_get_context to re-orient.',
        suggestedTool: 'harness_get_context',
      }, true);
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

// ─── New Tool Implementations ───────────────────────────────────────

interface StatusCountRow {
  status: string;
  cnt: number;
}

interface WorkspaceInfoRow {
  id: string;
  name: string;
}

interface ProjectInfoRow {
  id: string;
  name: string;
  key: string;
  status: string;
}

interface CampaignInfoRow {
  id: string;
  name: string;
  objective: string;
  status: string;
}

interface RecoveryIssueRow {
  id: string;
  task: string;
  priority: string;
}

interface ReadyIssueRow {
  id: string;
  task: string;
  priority: string;
}

interface ExpiredLeaseRow {
  id: string;
  issue_id: string;
  expires_at: string;
}

function getHarnessContext(dbPathInput?: string): Record<string, unknown> {
  const dbPath = resolveDbPath(dbPathInput);
  const database = openHarnessDatabase({ dbPath });

  try {
    const workspaces = selectAll<WorkspaceInfoRow>(
      database.connection,
      `SELECT id, name FROM workspaces ORDER BY created_at DESC`,
    );

    if (workspaces.length === 0) {
      return {
        workspace: null,
        projects: [],
        campaigns: [],
        queue: {},
        ...buildMeta(
          ['harness_init_workspace'],
          'No workspace found. Call harness_init_workspace to create one.',
        ),
      };
    }

    const workspace = workspaces[0];
    const projects = selectAll<ProjectInfoRow>(
      database.connection,
      `SELECT id, name, key, status FROM projects WHERE workspace_id = ? ORDER BY created_at DESC`,
      [workspace.id],
    );

    if (projects.length === 0) {
      return {
        workspace: { id: workspace.id, name: workspace.name },
        projects: [],
        campaigns: [],
        queue: {},
        ...buildMeta(
          ['harness_create_campaign'],
          `Workspace "${workspace.name}" exists but has no projects. Call harness_create_campaign to create one.`,
        ),
      };
    }

    const project = projects[0];
    const campaigns = selectAll<CampaignInfoRow>(
      database.connection,
      `SELECT id, name, objective, status FROM campaigns WHERE project_id = ? ORDER BY created_at DESC`,
      [project.id],
    );

    const statusCounts = selectAll<StatusCountRow>(
      database.connection,
      `SELECT status, COUNT(*) as cnt FROM issues WHERE project_id = ? GROUP BY status`,
      [project.id],
    );

    const queue: Record<string, number> = {};
    for (const row of statusCounts) {
      queue[row.status] = Number(row.cnt);
    }

    const readyCount = queue['ready'] ?? 0;
    const recoveryCount = queue['needs_recovery'] ?? 0;
    const inProgressCount = queue['in_progress'] ?? 0;

    let hint: string;
    let nextTools: string[];

    if (recoveryCount > 0) {
      hint = `${recoveryCount} issue(s) need recovery. Call begin_recovery_session.`;
      nextTools = ['begin_recovery_session'];
    } else if (inProgressCount > 0) {
      hint = `${inProgressCount} issue(s) in progress. Call begin_incremental_session to resume.`;
      nextTools = ['begin_incremental_session'];
    } else if (readyCount > 0) {
      hint = `${readyCount} ready task(s). Call begin_incremental_session to start working.`;
      nextTools = ['begin_incremental_session'];
    } else {
      hint = 'No ready tasks. Call promote_queue or harness_plan_issues to add work.';
      nextTools = ['promote_queue', 'harness_plan_issues'];
    }

    return {
      workspace: { id: workspace.id, name: workspace.name },
      project: { id: project.id, name: project.name, key: project.key },
      activeCampaign: campaigns.length > 0
        ? { id: campaigns[0].id, name: campaigns[0].name, objective: campaigns[0].objective }
        : null,
      queue,
      ...buildMeta(nextTools, hint),
    };
  } finally {
    database.close();
  }
}

function getNextAction(input: {
  dbPath?: string;
  projectId?: string;
  projectName?: string;
}): Record<string, unknown> {
  const dbPath = resolveDbPath(input.dbPath);
  const database = openHarnessDatabase({ dbPath });

  try {
    // If no project specified, pick the first active one
    let projectId = input.projectId;
    if (!projectId && !input.projectName) {
      const firstProject = selectOne<{ id: string }>(
        database.connection,
        `SELECT id FROM projects WHERE status = 'active' ORDER BY created_at DESC LIMIT 1`,
      );
      if (firstProject === null) {
        return {
          action: 'setup_required',
          tool: 'harness_create_campaign',
          reason: 'No active projects found. Create a project and campaign first.',
          ...buildMeta(['harness_create_campaign'], 'No projects exist. Call harness_create_campaign to get started.'),
        };
      }
      projectId = firstProject.id;
    } else if (!projectId && input.projectName) {
      projectId = resolveProjectId(database.connection, { projectName: input.projectName });
    }

    const now = new Date().toISOString();

    // Priority 1: Expired leases
    const expiredLeases = selectAll<ExpiredLeaseRow>(
      database.connection,
      `SELECT id, issue_id, expires_at FROM leases
       WHERE project_id = ? AND status = 'active' AND expires_at < ?
       ORDER BY expires_at ASC LIMIT 1`,
      [projectId!, now],
    );

    if (expiredLeases.length > 0) {
      const lease = expiredLeases[0];
      return {
        action: 'call_tool',
        tool: 'begin_recovery_session',
        reason: `Lease ${lease.id} on issue ${lease.issue_id} expired at ${lease.expires_at}. Recovery needed before claiming new work.`,
        suggestedPayload: { preferredIssueId: lease.issue_id },
        ...buildMeta(['begin_recovery_session'], 'Expired lease detected. Call begin_recovery_session to recover.'),
      };
    }

    // Priority 2: needs_recovery issues
    const recoveryIssues = selectAll<RecoveryIssueRow>(
      database.connection,
      `SELECT id, task, priority FROM issues WHERE project_id = ? AND status = 'needs_recovery'
       ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
       LIMIT 1`,
      [projectId!],
    );

    if (recoveryIssues.length > 0) {
      const issue = recoveryIssues[0];
      return {
        action: 'call_tool',
        tool: 'begin_recovery_session',
        reason: `Issue "${issue.task}" (${issue.id}, priority: ${issue.priority}) needs recovery.`,
        suggestedPayload: { preferredIssueId: issue.id },
        ...buildMeta(['begin_recovery_session'], 'Recovery issue found. Call begin_recovery_session.'),
      };
    }

    // Priority 3: Ready issues
    const readyIssues = selectAll<ReadyIssueRow>(
      database.connection,
      `SELECT id, task, priority FROM issues WHERE project_id = ? AND status = 'ready'
       ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
       LIMIT 1`,
      [projectId!],
    );

    if (readyIssues.length > 0) {
      const issue = readyIssues[0];
      return {
        action: 'call_tool',
        tool: 'begin_incremental_session',
        reason: `Task "${issue.task}" (${issue.id}, priority: ${issue.priority}) is ready to be claimed.`,
        suggestedPayload: { preferredIssueId: issue.id },
        ...buildMeta(['begin_incremental_session'], 'Ready task available. Call begin_incremental_session.'),
      };
    }

    // Priority 4: Pending issues that might be promotable
    const pendingCount = selectOne<{ cnt: number }>(
      database.connection,
      `SELECT COUNT(*) as cnt FROM issues WHERE project_id = ? AND status = 'pending'`,
      [projectId!],
    );

    if (pendingCount && pendingCount.cnt > 0) {
      return {
        action: 'call_tool',
        tool: 'promote_queue',
        reason: `${pendingCount.cnt} pending task(s) exist. Promote them to check if any dependencies are satisfied.`,
        ...buildMeta(['promote_queue'], 'Pending tasks exist. Call promote_queue to check promotability.'),
      };
    }

    // Priority 5: All done
    return {
      action: 'idle',
      reason: 'All tasks are complete or no tasks exist in the queue.',
      ...buildMeta(['harness_plan_issues', 'harness_get_context'], 'Queue is empty. Add more work with harness_plan_issues or inspect with harness_get_context.'),
    };
  } finally {
    database.close();
  }
}

// ─── Utilities ──────────────────────────────────────────────────────

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

function buildNextIncrementalInput(
  beginInput: Record<string, unknown>,
  dbPath: string,
): z.infer<typeof incrementalSessionInputSchema> {
  const candidate = beginInput as Partial<z.infer<typeof incrementalSessionInputSchema>>;

  return incrementalSessionInputSchema.parse({
    sessionId: `ADV-${randomUUID()}`,
    dbPath,
    workspaceId: candidate.workspaceId,
    projectId: candidate.projectId,
    progressPath: candidate.progressPath,
    featureListPath: candidate.featureListPath,
    planPath: candidate.planPath,
    syncManifestPath: candidate.syncManifestPath,
    mem0Enabled: candidate.mem0Enabled,
    ...(candidate.campaignId !== undefined
      ? { campaignId: candidate.campaignId }
      : {}),
    ...(candidate.agentId !== undefined ? { agentId: candidate.agentId } : {}),
    ...(candidate.host !== undefined ? { host: candidate.host } : {}),
    ...(candidate.leaseTtlSeconds !== undefined
      ? { leaseTtlSeconds: candidate.leaseTtlSeconds }
      : {}),
    ...(candidate.checkpointFreshnessSeconds !== undefined
      ? { checkpointFreshnessSeconds: candidate.checkpointFreshnessSeconds }
      : {}),
    ...(candidate.memoryQuery !== undefined
      ? { memoryQuery: candidate.memoryQuery }
      : {}),
    ...(candidate.memorySearchLimit !== undefined
      ? { memorySearchLimit: candidate.memorySearchLimit }
      : {}),
  });
}
