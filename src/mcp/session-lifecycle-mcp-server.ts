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
  runStatement,
} from '../db/store.js';
import {
  type JsonRpcErrorPayload,
  type JsonRpcId,
  type JsonRpcMessage,
  JsonRpcError,
  StdioJsonRpcTransport,
} from './jsonrpc-stdio.js';

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
  .passthrough();

// ─── Checkpoint / Close shared input schema (JSON Schema) ────────

const checkpointInputJsonSchema = {
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
} as const;

const closeInputJsonSchema = {
  ...checkpointInputJsonSchema,
  properties: {
    ...checkpointInputJsonSchema.properties,
    releaseLease: { type: 'boolean' },
  },
} as const;

// ─── Begin session shared properties (JSON Schema) ───────────────

const beginSessionProperties = {
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
} as const;

const beginSessionRequired = [
  'sessionId',
  'workspaceId',
  'projectId',
  'progressPath',
  'featureListPath',
  'planPath',
  'syncManifestPath',
  'mem0Enabled',
] as const;

// ─── Server ─────────────────────────────────────────────────────────

/** Strip the 'action' key from args before forwarding to .strict() Zod schemas. */
function stripAction(args: unknown): unknown {
  if (args && typeof args === 'object' && 'action' in args) {
    const { action: _, ...rest } = args as Record<string, unknown>;
    return rest;
  }
  return args;
}

const HARNESS_INSTRUCTIONS = `You are connected to the agent-harness lifecycle server — an Agentic OS for autonomous task execution.

This server exposes 4 tools, each covering a specific domain. Use the "action" parameter to select the operation.

TOOLS:
1. harness_inspector  — Read-only observation. Actions: get_context, next_action, overview, issue.
2. harness_orchestrator — Setup & queue management. Actions: init_workspace, create_campaign, plan_issues, promote_queue, rollback_issue.
3. harness_session — Execution lifecycle. Actions: begin, begin_recovery, checkpoint, close, advance.
4. harness_artifacts — Persistent state registry. Actions: save, list.

ORIENTATION (call first in any new session):
- harness_inspector(action: "get_context") → see workspace, project, campaign, queue status
- harness_inspector(action: "next_action") → get directive on exactly what to call next

SETUP (one-time, when no workspace/project exists):
1. harness_orchestrator(action: "init_workspace")
2. harness_orchestrator(action: "create_campaign")
3. harness_orchestrator(action: "plan_issues")

EXECUTION LOOP (repeated):
4. harness_orchestrator(action: "promote_queue")
5. harness_session(action: "begin") → claims next ready task, returns sessionToken
6. [Do the work described in the issued task]
7. harness_session(action: "checkpoint") → save progress (pass sessionToken)
8. harness_session(action: "advance") → close current + claim next task atomically (preferred)
9. harness_session(action: "close") → close without advancing (alternative to step 8)

RECOVERY:
- harness_orchestrator(action: "rollback_issue") → reset stuck issue to pending
- harness_session(action: "begin_recovery") → claim a needs_recovery issue

RULES:
- dbPath is optional: set HARNESS_DB_PATH env var to avoid passing it every call.
- Tools accept human-readable names (projectName, campaignName) instead of UUIDs.
- Always pass the short \`sessionToken\` returned by begin to checkpoint/close/advance, NOT the heavy context.
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
        version: '0.3.0',
      },
      instructions: HARNESS_INSTRUCTIONS,
    };
  }

  // ─── Tool Definitions ───────────────────────────────────────────

  private buildTools(): ToolDefinition[] {
    return [
      // ── 1. harness_inspector ──────────────────────────────────────
      {
        name: 'harness_inspector',
        description:
          'Read-only observation of the Harness state. Actions: get_context (workspace/project/queue status — call FIRST), next_action (NBA engine — tells you exactly what tool to call next), overview (task dashboard by project), issue (deep-dive into a specific issue).',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['get_context', 'next_action', 'overview', 'issue'],
              description: 'The inspection action to perform.',
            },
            dbPath: { type: 'string', description: 'Optional if HARNESS_DB_PATH is set.' },
            projectId: { type: 'string', description: 'Project UUID (or use projectName instead).' },
            projectName: { type: 'string', description: 'Human-readable project name (alternative to projectId).' },
            campaignId: { type: 'string' },
            issueId: { type: 'string', description: 'Required for action "issue".' },
            includeEvents: { type: 'boolean', description: 'For action "issue": include lifecycle events.' },
            eventLimit: { type: 'integer', minimum: 1, maximum: 100, description: 'For action "issue": max events.' },
            runLimit: { type: 'integer', minimum: 1, maximum: 100, description: 'For action "overview": max runs.' },
          },
          required: ['action'],
        },
        handler: async (args) => {
          const parsed = z.object({
            action: z.enum(['get_context', 'next_action', 'overview', 'issue']),
            dbPath: z.string().optional(),
            projectId: z.string().optional(),
            projectName: z.string().optional(),
            campaignId: z.string().optional(),
            issueId: z.string().optional(),
            includeEvents: z.boolean().optional(),
            eventLimit: z.number().int().positive().max(100).optional(),
            runLimit: z.number().int().positive().max(100).optional(),
          }).parse(args);

          switch (parsed.action) {
            case 'get_context':
              return getHarnessContext(parsed.dbPath);

            case 'next_action':
              return getNextAction({
                dbPath: parsed.dbPath,
                projectId: parsed.projectId,
                projectName: parsed.projectName,
              });

            case 'overview': {
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
                  hint = `${recoveryCount} issue(s) need recovery. Call harness_session(action: "begin_recovery").`;
                } else if (readyCount > 0) {
                  hint = `${readyCount} ready task(s). Call harness_session(action: "begin") to start working.`;
                } else {
                  hint = 'No ready tasks. Call harness_orchestrator(action: "promote_queue") to check for promotable pending tasks.';
                }

                return {
                  ...result,
                  ...buildMeta(['harness_session', 'harness_orchestrator'], hint),
                };
              } finally {
                db.close();
              }
            }

            case 'issue': {
              if (!parsed.issueId) {
                throw new AgenticToolError(
                  'issueId is required for action "issue".',
                  'Provide the issueId parameter when using action "issue".',
                  'harness_inspector',
                );
              }
              const input = inspectIssueInputSchema.parse({
                dbPath: parsed.dbPath,
                issueId: parsed.issueId,
                includeEvents: parsed.includeEvents,
                eventLimit: parsed.eventLimit,
              });
              const dbPath = resolveDbPath(input.dbPath);
              const result = await this.adapter.execute({
                action: 'inspect_issue',
                input: { ...input, dbPath },
              }) as Record<string, unknown>;
              const issue = result['issue'] as Record<string, unknown> | undefined;
              const status = issue?.['status'] as string | undefined;

              let hint = 'Issue details loaded.';
              if (status === 'needs_recovery') {
                hint = 'This issue needs recovery. Call harness_session(action: "begin_recovery") with this issueId.';
              } else if (status === 'failed') {
                hint = 'This issue has failed. Call harness_orchestrator(action: "rollback_issue") to reset it.';
              }

              return {
                ...result,
                ...buildMeta(['harness_session', 'harness_orchestrator'], hint),
              };
            }
          }
        },
      },

      // ── 2. harness_orchestrator ───────────────────────────────────
      {
        name: 'harness_orchestrator',
        description:
          'Setup, configuration, and queue management. Actions: init_workspace (create DB and workspace), create_campaign (register project + campaign — idempotent), plan_issues (inject tasks into queue), promote_queue (unlock tasks whose deps are done), rollback_issue (emergency reset of stuck issue to pending).',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['init_workspace', 'create_campaign', 'plan_issues', 'promote_queue', 'rollback_issue'],
              description: 'The orchestrator action to perform.',
            },
            // init_workspace
            workspaceName: { type: 'string', description: 'For action "init_workspace": name of the workspace.' },
            // create_campaign
            workspaceId: { type: 'string', description: 'For "create_campaign": optional, auto-resolved if only one workspace exists.' },
            projectName: { type: 'string', description: 'For "create_campaign"/"plan_issues": human-readable project name.' },
            campaignName: { type: 'string', description: 'For "create_campaign"/"plan_issues": campaign name.' },
            objective: { type: 'string', description: 'For "create_campaign": campaign objective.' },
            // plan_issues
            projectId: { type: 'string', description: 'Project UUID (or use projectName instead).' },
            campaignId: { type: 'string', description: 'Campaign UUID (or use campaignName instead).' },
            milestoneDescription: { type: 'string', description: 'For "plan_issues": milestone description.' },
            issues: {
              type: 'array',
              description: 'For "plan_issues": array of task objects.',
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
            // rollback_issue
            issueId: { type: 'string', description: 'For "rollback_issue": the issue to reset.' },
            // shared
            dbPath: { type: 'string', description: 'Optional if HARNESS_DB_PATH is set.' },
          },
          required: ['action'],
        },
        handler: async (args) => {
          const parsed = z.object({
            action: z.enum(['init_workspace', 'create_campaign', 'plan_issues', 'promote_queue', 'rollback_issue']),
          }).passthrough().parse(args);

          switch (parsed.action) {
            case 'init_workspace': {
              const stripped = stripAction(args);
              return initHarnessWorkspace(
                harnessInitWorkspaceInputSchema.parse(stripped),
              );
            }

            case 'create_campaign':
              return createHarnessCampaign(
                harnessCreateCampaignInputSchema.parse(stripAction(args)),
              );

            case 'plan_issues':
              return planHarnessIssues(
                harnessPlanIssuesInputSchema.parse(stripAction(args)),
              );

            case 'promote_queue': {
              const pArgs = z.object({
                dbPath: z.string().optional(),
                projectId: z.string().optional(),
                projectName: z.string().optional(),
                action: z.string().optional(),
                campaignId: z.string().optional(),
              }).parse(args);
              const dbPath = resolveDbPath(pArgs.dbPath);
              const db = openHarnessDatabase({ dbPath });
              try {
                const projectId = resolveProjectId(db.connection, {
                  projectId: pArgs.projectId,
                  projectName: pArgs.projectName,
                });
                const result = await this.adapter.execute({
                  action: 'promote_queue',
                  input: { dbPath, projectId, campaignId: pArgs.campaignId },
                }) as Record<string, unknown>;
                const promotedIds = (result['promotedIssueIds'] as string[] | undefined) ?? [];

                return {
                  ...result,
                  ...buildMeta(
                    promotedIds.length > 0
                      ? ['harness_session']
                      : ['harness_inspector'],
                    promotedIds.length > 0
                      ? `${promotedIds.length} task(s) promoted to ready. Call harness_session(action: "begin") to start working.`
                      : 'No tasks were promoted. Call harness_inspector(action: "next_action") for guidance.',
                  ),
                };
              } finally {
                db.close();
              }
            }

            case 'rollback_issue':
              return rollbackHarnessIssue(
                harnessRollbackIssueInputSchema.parse(stripAction(args)),
              );
          }
        },
      },

      // ── 3. harness_session ────────────────────────────────────────
      {
        name: 'harness_session',
        description:
          'Execution lifecycle for worker agents. Actions: begin (claim next ready task — returns sessionToken), begin_recovery (claim a needs_recovery task), checkpoint (save progress — pass sessionToken), close (mark task done/failed — pass sessionToken), advance (atomic close + begin next — pass sessionToken, preferred over close + begin).',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['begin', 'begin_recovery', 'checkpoint', 'close', 'advance'],
              description: 'The session lifecycle action to perform.',
            },
            // begin / begin_recovery
            ...beginSessionProperties,
            recoverySummary: { type: 'string', description: 'For "begin_recovery": summary of the recovery context.' },
            recoveryNextStep: { type: 'string', description: 'For "begin_recovery": next step after recovery.' },
            // checkpoint / close / advance
            sessionToken: { type: 'string', description: 'For checkpoint/close/advance: the token returned by begin.' },
            input: {
              ...checkpointInputJsonSchema,
              description: 'For checkpoint: progress data to save.',
            },
            closeInput: {
              ...closeInputJsonSchema,
              description: 'For close/advance: closing data including task status.',
            },
          },
          required: ['action'],
        },
        handler: async (args) => {
          const parsed = z.object({
            action: z.enum(['begin', 'begin_recovery', 'checkpoint', 'close', 'advance']),
          }).passthrough().parse(args);

          switch (parsed.action) {
            case 'begin': {
              const input = incrementalSessionInputSchema.parse(stripAction(args));
              const dbPath = resolveDbPath(input.dbPath);
              const result = (await this.adapter.execute({
                action: 'begin_incremental',
                input: { ...input, dbPath },
              })) as { context: SessionContext };
              const sessionToken = this.tokenStore.store(
                result.context as unknown as Record<string, unknown>,
                input as Record<string, unknown>,
              );
              return {
                ...result,
                sessionToken,
                ...buildMeta(
                  ['harness_session'],
                  'Session started. Do the work, then call harness_session(action: "checkpoint") to save progress, or harness_session(action: "advance") to close and claim next task.',
                ),
              };
            }

            case 'begin_recovery': {
              const input = recoverySessionInputSchema.parse(stripAction(args));
              const dbPath = resolveDbPath(input.dbPath);
              const result = (await this.adapter.execute({
                action: 'begin_recovery',
                input: { ...input, dbPath },
              })) as { context: SessionContext };
              const sessionToken = this.tokenStore.store(
                result.context as unknown as Record<string, unknown>,
                input as Record<string, unknown>,
              );
              return {
                ...result,
                sessionToken,
                ...buildMeta(
                  ['harness_session'],
                  'Recovery session started. Do the recovery work, then call harness_session(action: "checkpoint") or harness_session(action: "advance").',
                ),
              };
            }

            case 'checkpoint': {
              const cpParsed = z
                .object({
                  sessionToken: z.string(),
                  input: sessionCheckpointInputSchema,
                })
                .passthrough()
                .parse(args);

              const session = this.tokenStore.resolve(cpParsed.sessionToken);
              const context = session.context as unknown as SessionContext;
              const dbPath = resolveDbPath(context.dbPath);
              const result = (await this.adapter.execute({
                action: 'checkpoint',
                context: { ...context, dbPath },
                input: cpParsed.input,
              })) as { result: { checkpoint: { id: string } } };

              this.tokenStore.updateContext(cpParsed.sessionToken, {
                currentCheckpointId: result.result.checkpoint.id,
                currentTaskStatus: cpParsed.input.taskStatus,
              });

              return {
                ...result,
                ...buildMeta(
                  ['harness_session'],
                  'Progress saved. Continue working and checkpoint again, or call harness_session(action: "advance") when the task is complete.',
                ),
              };
            }

            case 'close': {
              const clParsed = z
                .object({
                  sessionToken: z.string(),
                  closeInput: sessionCloseInputSchema,
                })
                .passthrough()
                .parse(args);

              const session = this.tokenStore.resolve(clParsed.sessionToken);
              const context = session.context as unknown as SessionContext;
              const dbPath = resolveDbPath(context.dbPath);

              const result = (await this.adapter.execute({
                action: 'close',
                context: { ...context, dbPath },
                input: clParsed.closeInput,
              })) as Record<string, unknown>;

              this.tokenStore.remove(clParsed.sessionToken);

              const promotedIds = (result['promotedIssueIds'] as string[] | undefined) ?? [];
              const hint =
                promotedIds.length > 0
                  ? `Session closed. ${promotedIds.length} dependent task(s) promoted. Call harness_session(action: "begin") to pick up next.`
                  : 'Session closed. No more ready tasks. Call harness_inspector(action: "next_action") to check queue status.';

              return {
                ...result,
                ...buildMeta(
                  promotedIds.length > 0
                    ? ['harness_session']
                    : ['harness_inspector'],
                  hint,
                ),
              };
            }

            case 'advance': {
              const advParsed = z
                .object({
                  sessionToken: z.string(),
                  closeInput: sessionCloseInputSchema,
                })
                .passthrough()
                .parse(args);

              const session = this.tokenStore.resolve(advParsed.sessionToken);
              const context = session.context as unknown as SessionContext;
              const dbPath = resolveDbPath(context.dbPath);

              // 1. Close current session
              const closeResult = (await this.adapter.execute({
                action: 'close',
                context: { ...context, dbPath },
                input: advParsed.closeInput,
              })) as Record<string, unknown>;

              // 2. Begin new session reusing original inputs
              const nextBeginInput = buildNextIncrementalInput(session.beginInput, dbPath);
              let beginResult: { context: SessionContext };
              try {
                beginResult = (await this.adapter.execute({
                  action: 'begin_incremental',
                  input: nextBeginInput,
                })) as { context: SessionContext };
              } catch (error) {
                this.tokenStore.remove(advParsed.sessionToken);

                if (
                  error instanceof Error &&
                  error.message.startsWith('No ready issues are available for project ')
                ) {
                  const promotedIds =
                    (closeResult['promotedIssueIds'] as string[] | undefined) ?? [];
                  const hint =
                    promotedIds.length > 0
                      ? `Session closed. ${promotedIds.length} task(s) promoted, but none claimable yet. Call harness_session(action: "begin") to retry.`
                      : 'Session closed. No ready tasks to advance into. Call harness_inspector(action: "next_action") for guidance.';

                  return {
                    ...closeResult,
                    advanced: false,
                    ...buildMeta(
                      promotedIds.length > 0
                        ? ['harness_session']
                        : ['harness_inspector'],
                      hint,
                    ),
                  };
                }

                throw new AgenticToolError(
                  `Current session closed, but advance could not start the next task: ${getErrorMessage(error)}`,
                  'The current task is already closed. Call harness_inspector(action: "overview") to inspect queue state.',
                  'harness_inspector',
                );
              }

              this.tokenStore.remove(advParsed.sessionToken);

              const newToken = this.tokenStore.store(
                beginResult.context as unknown as Record<string, unknown>,
                session.beginInput,
              );

              return {
                ...beginResult,
                sessionToken: newToken,
                ...buildMeta(
                  ['harness_session'],
                  'Advanced to next session! Do the work, then call harness_session(action: "checkpoint") or harness_session(action: "advance").',
                ),
              };
            }
          }
        },
      },

      // ── 4. harness_artifacts ──────────────────────────────────────
      {
        name: 'harness_artifacts',
        description:
          'Persistent state registry for files like browser cookies, screenshots, or design documents. Actions: save (register a file path to the Harness DB), list (find artifacts by project/issue/kind).',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['save', 'list'],
              description: 'The artifact action to perform.',
            },
            dbPath: { type: 'string', description: 'Optional if HARNESS_DB_PATH is set.' },
            projectId: { type: 'string', description: 'Project UUID (or use projectName).' },
            projectName: { type: 'string', description: 'Human-readable project name.' },
            campaignId: { type: 'string' },
            issueId: { type: 'string' },
            // save-specific
            kind: { type: 'string', description: 'For "save": artifact kind (e.g. "browser_state", "screenshot", "auth_cookies").' },
            path: { type: 'string', description: 'For "save": absolute path to the file.' },
            metadata: { type: 'object', description: 'For "save": arbitrary JSON metadata.' },
            // list-specific (kind also used for filtering)
          },
          required: ['action'],
        },
        handler: async (args) => {
          const parsed = z.object({
            action: z.enum(['save', 'list']),
            dbPath: z.string().optional(),
            projectId: z.string().optional(),
            projectName: z.string().optional(),
            campaignId: z.string().optional(),
            issueId: z.string().optional(),
            kind: z.string().optional(),
            path: z.string().optional(),
            metadata: z.record(z.string(), z.unknown()).optional(),
          }).parse(args);

          const dbPath = resolveDbPath(parsed.dbPath);
          const db = openHarnessDatabase({ dbPath });
          try {
            const projectId = resolveProjectId(db.connection, {
              projectId: parsed.projectId,
              projectName: parsed.projectName,
            });

            switch (parsed.action) {
              case 'save': {
                if (!parsed.kind) {
                  throw new AgenticToolError(
                    'kind is required for action "save".',
                    'Provide the kind parameter (e.g., "browser_state", "auth_cookies", "screenshot").',
                    'harness_artifacts',
                  );
                }
                if (!parsed.path) {
                  throw new AgenticToolError(
                    'path is required for action "save".',
                    'Provide the absolute path to the file you want to register.',
                    'harness_artifacts',
                  );
                }
                const artifactId = randomUUID();
                const now = new Date().toISOString();
                // Get workspaceId from project
                const project = selectOne<{ workspace_id: string }>(
                  db.connection,
                  'SELECT workspace_id FROM projects WHERE id = ?',
                  [projectId],
                );
                if (!project) {
                  throw new AgenticToolError(
                    `Project ${projectId} not found.`,
                    'Check the projectId or projectName.',
                    'harness_inspector',
                  );
                }
                runStatement(
                  db.connection,
                  `INSERT INTO artifacts (id, workspace_id, project_id, campaign_id, issue_id, kind, path, metadata_json, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  [
                    artifactId,
                    project.workspace_id,
                    projectId,
                    parsed.campaignId ?? null,
                    parsed.issueId ?? null,
                    parsed.kind,
                    parsed.path,
                    JSON.stringify(parsed.metadata ?? {}),
                    now,
                  ],
                );
                return {
                  artifactId,
                  kind: parsed.kind,
                  path: parsed.path,
                  ...buildMeta(
                    ['harness_artifacts', 'harness_session'],
                    `Artifact "${parsed.kind}" registered at path "${parsed.path}". You can list artifacts later with harness_artifacts(action: "list").`,
                  ),
                };
              }

              case 'list': {
                const conditions: string[] = ['project_id = ?'];
                const params: (string | null)[] = [projectId];

                if (parsed.campaignId) {
                  conditions.push('campaign_id = ?');
                  params.push(parsed.campaignId);
                }
                if (parsed.issueId) {
                  conditions.push('issue_id = ?');
                  params.push(parsed.issueId);
                }
                if (parsed.kind) {
                  conditions.push('kind = ?');
                  params.push(parsed.kind);
                }

                const artifacts = selectAll<{
                  id: string;
                  kind: string;
                  path: string;
                  metadata_json: string;
                  issue_id: string | null;
                  campaign_id: string | null;
                  created_at: string;
                }>(
                  db.connection,
                  `SELECT id, kind, path, metadata_json, issue_id, campaign_id, created_at
                   FROM artifacts WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`,
                  params,
                );

                return {
                  artifacts: artifacts.map((a) => ({
                    id: a.id,
                    kind: a.kind,
                    path: a.path,
                    metadata: JSON.parse(a.metadata_json),
                    issueId: a.issue_id,
                    campaignId: a.campaign_id,
                    createdAt: a.created_at,
                  })),
                  ...buildMeta(
                    ['harness_session', 'harness_artifacts'],
                    artifacts.length > 0
                      ? `Found ${artifacts.length} artifact(s).`
                      : 'No artifacts found for the given filters.',
                  ),
                };
              }
            }
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
        recovery: 'Inspect the error message. If the issue persists, call harness_inspector(action: "get_context") to re-orient.',
        suggestedTool: 'harness_inspector',
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

// ─── Standalone functions ───────────────────────────────────────────

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
          ['harness_orchestrator'],
          'No workspace found. Call harness_orchestrator(action: "init_workspace") to create one.',
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
          ['harness_orchestrator'],
          `Workspace "${workspace.name}" exists but has no projects. Call harness_orchestrator(action: "create_campaign") to create one.`,
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
      hint = `${recoveryCount} issue(s) need recovery. Call harness_session(action: "begin_recovery").`;
      nextTools = ['harness_session'];
    } else if (inProgressCount > 0) {
      hint = `${inProgressCount} issue(s) in progress. Call harness_session(action: "begin") to resume.`;
      nextTools = ['harness_session'];
    } else if (readyCount > 0) {
      hint = `${readyCount} ready task(s). Call harness_session(action: "begin") to start working.`;
      nextTools = ['harness_session'];
    } else {
      hint = 'No ready tasks. Call harness_orchestrator(action: "promote_queue") or harness_orchestrator(action: "plan_issues") to add work.';
      nextTools = ['harness_orchestrator'];
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
          tool: 'harness_orchestrator',
          reason: 'No active projects found. Create a project and campaign first.',
          ...buildMeta(['harness_orchestrator'], 'No projects exist. Call harness_orchestrator(action: "create_campaign") to get started.'),
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
        tool: 'harness_session',
        reason: `Lease ${lease.id} on issue ${lease.issue_id} expired at ${lease.expires_at}. Recovery needed.`,
        suggestedPayload: { action: 'begin_recovery', preferredIssueId: lease.issue_id },
        ...buildMeta(['harness_session'], 'Expired lease detected. Call harness_session(action: "begin_recovery") to recover.'),
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
        tool: 'harness_session',
        reason: `Issue "${issue.task}" (${issue.id}, priority: ${issue.priority}) needs recovery.`,
        suggestedPayload: { action: 'begin_recovery', preferredIssueId: issue.id },
        ...buildMeta(['harness_session'], 'Recovery issue found. Call harness_session(action: "begin_recovery").'),
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
        tool: 'harness_session',
        reason: `Task "${issue.task}" (${issue.id}, priority: ${issue.priority}) is ready to be claimed.`,
        suggestedPayload: { action: 'begin', preferredIssueId: issue.id },
        ...buildMeta(['harness_session'], 'Ready task available. Call harness_session(action: "begin").'),
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
        tool: 'harness_orchestrator',
        reason: `${pendingCount.cnt} pending task(s) exist. Promote them to check if any dependencies are satisfied.`,
        suggestedPayload: { action: 'promote_queue' },
        ...buildMeta(['harness_orchestrator'], 'Pending tasks exist. Call harness_orchestrator(action: "promote_queue") to check promotability.'),
      };
    }

    // Priority 5: All done
    return {
      action: 'idle',
      reason: 'All tasks are complete or no tasks exist in the queue.',
      ...buildMeta(['harness_orchestrator', 'harness_inspector'], 'Queue is empty. Add more work with harness_orchestrator(action: "plan_issues").'),
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
