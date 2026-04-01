import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { SessionLifecycleAdapter } from '../runtime/session-lifecycle-adapter.js';
import { loadDefaultMem0Adapter } from '../runtime/default-mem0-loader.js';
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
  resolveWorkspaceId,
  resolveDbPath,
  resolveProjectId,
  resolveCampaignId,
  SessionTokenStore,
} from '../runtime/harness-agentic-helpers.js';
import { getHarnessCapabilityCatalog } from '../runtime/harness-capability-catalog.js';
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
  runInTransaction,
} from '../db/store.js';
import {
  type JsonRpcErrorPayload,
  type JsonRpcId,
  type JsonRpcMessage,
  JsonRpcError,
  StdioJsonRpcTransport,
} from './jsonrpc-stdio.js';

const __mcpFilename = fileURLToPath(import.meta.url);
const __mcpDirname = dirname(__mcpFilename);
const PACKAGE_VERSION: string = (() => {
  try {
    const pkgPath = resolve(__mcpDirname, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

// ─── Types ──────────────────────────────────────────────────────────

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: unknown) => Promise<unknown>;
}

type Mem0AdapterLoader = typeof loadDefaultMem0Adapter;

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
  sessionId: {
    type: 'string',
    description: 'Optional caller-provided run identifier. Auto-generated when omitted.',
  },
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

This server exposes 5 tools, each covering a specific domain. Use the "action" parameter to select the operation.

TOOLS:
1. harness_inspector  — Read-only observation. Actions: capabilities, get_context, next_action, overview, issue, health.
2. harness_orchestrator — Setup & queue management. Actions: init_workspace, create_campaign, plan_issues, promote_queue, rollback_issue.
3. harness_session — Execution lifecycle. Actions: begin, begin_recovery, checkpoint, close, advance, heartbeat.
4. harness_artifacts — Persistent state registry. Actions: save, list.
5. harness_admin — Maintenance & administration. Actions: reconcile, drain, archive, cleanup, mem0_snapshot, mem0_rollup.

ORIENTATION (call first in any new session):
- harness_inspector(action: "capabilities") → discover tool map, bundled skills, mem0 availability
- harness_inspector(action: "get_context") → see workspace, project, campaign, queue status
- harness_inspector(action: "next_action") → get directive on exactly what to call next
- harness_inspector(action: "health") → operational metrics (queue depth, stale leases, checkpoint freshness)

SETUP (one-time, when no workspace/project exists):
1. harness_orchestrator(action: "init_workspace")
2. harness_orchestrator(action: "create_campaign")
3. harness_orchestrator(action: "plan_issues")

EXECUTION LOOP (repeated):
4. harness_orchestrator(action: "promote_queue")
5. harness_session(action: "begin") → claims next ready task, returns sessionToken
6. [Do the work described in the issued task]
7. harness_session(action: "checkpoint") → save progress (pass sessionToken)
8. harness_session(action: "heartbeat") → renew lease for long-running tasks (pass sessionToken)
9. harness_session(action: "advance") → close current + claim next task atomically (preferred)
10. harness_session(action: "close") → close without advancing (alternative to step 9)

RECOVERY:
- harness_orchestrator(action: "rollback_issue") → reset stuck issue to pending
- harness_session(action: "begin_recovery") → claim a needs_recovery issue

MAINTENANCE:
- harness_admin(action: "reconcile") → force reconciliation of stale leases
- harness_admin(action: "drain") → pause new claims for a campaign
- harness_admin(action: "archive") → archive a completed campaign
- harness_admin(action: "cleanup") → delete old sessions, leases, events past retention
- harness_admin(action: "mem0_snapshot") → persist project/milestone summary to mem0
- harness_admin(action: "mem0_rollup") → compact task-level memories into summary

RULES:
- dbPath is optional: set HARNESS_DB_PATH env var to avoid passing it every call.
- Tools accept human-readable names (projectName, campaignName) instead of UUIDs, but ambiguous scope must be resolved explicitly with workspaceId or projectId.
- Always pass the short \`sessionToken\` returned by begin to checkpoint/close/advance/heartbeat, NOT the heavy context.
- Every response includes _meta.nextTools and _meta.hint telling you what to do next.`;

export class SessionLifecycleMcpServer {
  private readonly transport: StdioJsonRpcTransport;
  private readonly tools: Map<string, ToolDefinition>;
  private readonly tokenStore = new SessionTokenStore();

  constructor(
    private readonly adapter: SessionLifecycleAdapter,
    transport?: StdioJsonRpcTransport,
    private readonly mem0AdapterLoader: Mem0AdapterLoader = loadDefaultMem0Adapter,
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
        version: PACKAGE_VERSION,
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
          'Read-only observation of the Harness state. Actions: capabilities (discover tools, bundled skills, mem0 status — call FIRST), get_context (workspace/project/queue status), next_action (NBA engine — tells you exactly what tool to call next), overview (task dashboard by project), issue (deep-dive into a specific issue), health (operational metrics — queue depth, stale leases, checkpoint freshness).',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['capabilities', 'get_context', 'next_action', 'overview', 'issue', 'health'],
              description: 'The inspection action to perform.',
            },
            dbPath: { type: 'string', description: 'Optional if HARNESS_DB_PATH is set.' },
            workspaceId: { type: 'string', description: 'Workspace UUID used to disambiguate project resolution.' },
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
            action: z.enum(['capabilities', 'get_context', 'next_action', 'overview', 'issue', 'health']),
            dbPath: z.string().optional(),
            workspaceId: z.string().optional(),
            projectId: z.string().optional(),
            projectName: z.string().optional(),
            campaignId: z.string().optional(),
            issueId: z.string().optional(),
            includeEvents: z.boolean().optional(),
            eventLimit: z.number().int().positive().max(100).optional(),
            runLimit: z.number().int().positive().max(100).optional(),
          }).parse(args);

          switch (parsed.action) {
            case 'capabilities': {
              return {
                ...getHarnessCapabilityCatalog(),
                mem0: await inspectMem0Status(this.mem0AdapterLoader),
                ...buildMeta(
                  ['harness_inspector', 'harness_session', 'harness_orchestrator'],
                  'Capability catalog loaded. Use harness_inspector(action: "next_action") for queue guidance or choose a tool/action directly from the catalog.',
                ),
              };
            }

            case 'get_context':
              return getHarnessContext({
                dbPath: parsed.dbPath,
                workspaceId: parsed.workspaceId,
                projectId: parsed.projectId,
                projectName: parsed.projectName,
                campaignId: parsed.campaignId,
              });

            case 'next_action':
              return getNextAction({
                dbPath: parsed.dbPath,
                workspaceId: parsed.workspaceId,
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
                  workspaceId: parsed.workspaceId,
                });
                const result = await this.adapter.execute({
                  action: 'inspect_overview',
                  input: { dbPath, projectId, campaignId: parsed.campaignId, runLimit: parsed.runLimit },
                }) as { result: Record<string, unknown> };
                const counts = result.result['counts'] as Record<string, number> | undefined;
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
              }) as { result: Record<string, unknown> };
              const issue = result.result['issue'] as Record<string, unknown> | undefined;
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

            case 'health': {
              const dbPath = resolveDbPath(parsed.dbPath);
              const db = openHarnessDatabase({ dbPath });
              try {
                const projectId = resolveProjectId(db.connection, {
                  projectId: parsed.projectId,
                  projectName: parsed.projectName,
                  workspaceId: parsed.workspaceId,
                });
                const inspector = new (await import('../runtime/session-lifecycle-inspector.js')).SessionLifecycleInspector();
                const health = inspector.inspectHealth({
                  dbPath,
                  projectId,
                  campaignId: parsed.campaignId,
                });

                const staleCount = (health['leases'] as Record<string, unknown>)?.['stale'] as number ?? 0;
                let hint = 'Health metrics loaded.';
                if (staleCount > 0) {
                  hint = `${staleCount} stale lease(s) detected. Run harness_admin(action: "reconcile") or harness_orchestrator(action: "promote_queue").`;
                }

                return {
                  ...health,
                  ...buildMeta(['harness_admin', 'harness_orchestrator'], hint),
                };
              } finally {
                db.close();
              }
            }
          }
        },
      },

      // ── 2. harness_orchestrator ───────────────────────────────────
      {
        name: 'harness_orchestrator',
        description:
          'Setup, configuration, and queue management. Actions: init_workspace (create DB and workspace), create_campaign (register project + campaign — idempotent), plan_issues (inject a canonical milestone batch into the queue), promote_queue (unlock tasks whose issue and milestone deps are done), rollback_issue (emergency reset of stuck issue to pending).',
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
            milestones: {
              type: 'array',
              description: 'For "plan_issues": canonical array of milestones. Use this shape even for a single milestone import.',
              items: {
                type: 'object',
                properties: {
                  milestone_key: { type: 'string', description: 'Stable local key used by depends_on_milestone_keys within this batch.' },
                  description: { type: 'string', description: 'Milestone description.' },
                  depends_on_milestone_ids: {
                    type: 'array',
                    description: 'Existing milestone IDs that must complete before this milestone can unlock.',
                    items: { type: 'string' },
                  },
                  depends_on_milestone_keys: {
                    type: 'array',
                    description: 'Local milestone keys in the same batch that must complete before this milestone can unlock.',
                    items: { type: 'string' },
                  },
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
                          description: 'Indices of earlier issues in the same milestone this task depends on.',
                        },
                      },
                      required: ['task', 'priority', 'size'],
                    },
                  },
                },
                required: ['milestone_key', 'description', 'issues'],
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
                }) as { result: { promotedIssueIds?: string[] } };
                const promotedIds = result.result.promotedIssueIds ?? [];

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
          'Execution lifecycle for worker agents. Actions: begin (claim next ready task — returns sessionToken), begin_recovery (claim a needs_recovery task), checkpoint (save progress — pass sessionToken), close (mark task done/failed — pass sessionToken), advance (atomic close + begin next — pass sessionToken, preferred over close + begin), heartbeat (renew lease TTL for long-running tasks — pass sessionToken).',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['begin', 'begin_recovery', 'checkpoint', 'close', 'advance', 'heartbeat'],
              description: 'The session lifecycle action to perform.',
            },
            // begin / begin_recovery
            ...beginSessionProperties,
            recoverySummary: { type: 'string', description: 'For "begin_recovery": summary of the recovery context.' },
            recoveryNextStep: { type: 'string', description: 'For "begin_recovery": next step after recovery.' },
            // checkpoint / close / advance
            dbPath: { type: 'string', description: 'Optional for checkpoint/close/advance when resolving a persisted sessionToken after restart.' },
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
            action: z.enum(['begin', 'begin_recovery', 'checkpoint', 'close', 'advance', 'heartbeat']),
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
                { ...input, dbPath } as Record<string, unknown>,
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
                { ...input, dbPath } as Record<string, unknown>,
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
                  dbPath: z.string().optional(),
                  sessionToken: z.string(),
                  input: sessionCheckpointInputSchema,
                })
                .passthrough()
                .parse(args);

               const session = this.tokenStore.resolve(
                 cpParsed.sessionToken,
                 cpParsed.dbPath,
               );
               const context = session.context as unknown as SessionContext;
               const dbPath = resolveDbPath(context.dbPath ?? cpParsed.dbPath);
               const result = (await this.adapter.execute({
                 action: 'checkpoint',
                 context: { ...context, dbPath },
                input: cpParsed.input,
              })) as { result: { checkpoint: { id: string } } };

               this.tokenStore.updateContext(cpParsed.sessionToken, {
                 currentCheckpointId: result.result.checkpoint.id,
                 currentTaskStatus: cpParsed.input.taskStatus,
               }, dbPath);

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
                  dbPath: z.string().optional(),
                  sessionToken: z.string(),
                  closeInput: sessionCloseInputSchema,
                })
                .passthrough()
                .parse(args);

               const session = this.tokenStore.resolve(
                 clParsed.sessionToken,
                 clParsed.dbPath,
               );
               const context = session.context as unknown as SessionContext;
               const dbPath = resolveDbPath(context.dbPath ?? clParsed.dbPath);

               const executed = (await this.adapter.execute({
                 action: 'close',
                 context: { ...context, dbPath },
                 input: clParsed.closeInput,
               })) as { result: Record<string, unknown> };

               this.tokenStore.remove(clParsed.sessionToken, dbPath);

               const promotedIds =
                 (executed.result['promotedIssueIds'] as string[] | undefined) ?? [];
               const hint =
                 promotedIds.length > 0
                   ? `Session closed. ${promotedIds.length} dependent task(s) promoted. Call harness_session(action: "begin") to pick up next.`
                   : 'Session closed. No more ready tasks. Call harness_inspector(action: "next_action") to check queue status.';

               return {
                 ...executed,
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
                  dbPath: z.string().optional(),
                  sessionToken: z.string(),
                  closeInput: sessionCloseInputSchema,
                })
                .passthrough()
                .parse(args);

               const session = this.tokenStore.resolve(
                 advParsed.sessionToken,
                 advParsed.dbPath,
               );
               const context = session.context as unknown as SessionContext;
               const dbPath = resolveDbPath(context.dbPath ?? advParsed.dbPath);
               const nextBeginInput = buildNextIncrementalInput(session.beginInput, dbPath);
               const advanced = await this.adapter.advanceSession(
                 { ...context, dbPath },
                 advParsed.closeInput,
                 { ...nextBeginInput, dbPath },
               );

               this.tokenStore.remove(advParsed.sessionToken, dbPath);

               if (!advanced.advanced || advanced.nextContext === undefined) {
                 const promotedIds = advanced.closeResult.promotedIssueIds ?? [];
                 const hint =
                   promotedIds.length > 0
                     ? `Session closed. ${promotedIds.length} task(s) promoted, but none claimable yet. Call harness_session(action: "begin") to retry.`
                     : 'Session closed. No ready tasks to advance into. Call harness_inspector(action: "next_action") for guidance.';

                 return {
                   advanced: false,
                   result: advanced.closeResult,
                   stopReason: advanced.stopReason,
                   ...buildMeta(
                     promotedIds.length > 0
                       ? ['harness_session']
                       : ['harness_inspector'],
                     hint,
                   ),
                 };
               }

               const newToken = this.tokenStore.store(
                 advanced.nextContext as unknown as Record<string, unknown>,
                 nextBeginInput as Record<string, unknown>,
               );

               return {
                 advanced: true,
                 context: advanced.nextContext,
                 closeResult: advanced.closeResult,
                 sessionToken: newToken,
                 ...buildMeta(
                   ['harness_session'],
                   'Advanced to next session! Do the work, then call harness_session(action: "checkpoint") or harness_session(action: "advance").',
                 ),
               };
             }

            case 'heartbeat': {
              const hbParsed = z
                .object({
                  dbPath: z.string().optional(),
                  sessionToken: z.string(),
                  leaseTtlSeconds: z.number().int().positive().optional(),
                })
                .passthrough()
                .parse(args);

              const session = this.tokenStore.resolve(
                hbParsed.sessionToken,
                hbParsed.dbPath,
              );
              const context = session.context as unknown as SessionContext;
              const dbPath = resolveDbPath(context.dbPath ?? hbParsed.dbPath);
              const db = openHarnessDatabase({ dbPath });
              try {
                const { renewLease } = await import('../db/lease-manager.js');
                const extensionSeconds = hbParsed.leaseTtlSeconds ?? 3600;
                const result = renewLease(
                  db.connection,
                  context.leaseId,
                  extensionSeconds,
                );
                return {
                  leaseId: context.leaseId,
                  ...result,
                  ...buildMeta(
                    ['harness_session'],
                    `Lease renewed for ${extensionSeconds}s. Continue working.`,
                  ),
                };
              } finally {
                db.close();
              }
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

      // ── 5. harness_admin ──────────────────────────────────────────
      {
        name: 'harness_admin',
        description:
          'Maintenance and administration. Actions: reconcile (force reconciliation of stale leases), drain (pause new claims for a campaign), archive (close all done issues and release leases for a campaign), cleanup (delete expired sessions, old events, and released leases older than retention days), mem0_snapshot (persist a project/milestone summary to mem0), mem0_rollup (compact detailed task memories into a higher-level summary).',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['reconcile', 'drain', 'archive', 'cleanup', 'mem0_snapshot', 'mem0_rollup'],
              description: 'The admin action to perform.',
            },
            dbPath: { type: 'string', description: 'Optional if HARNESS_DB_PATH is set.' },
            projectId: { type: 'string', description: 'Project UUID (or use projectName).' },
            projectName: { type: 'string', description: 'Human-readable project name.' },
            workspaceId: { type: 'string' },
            campaignId: { type: 'string', description: 'Campaign UUID (or use campaignName).' },
            campaignName: { type: 'string', description: 'Campaign name.' },
            retentionDays: { type: 'integer', minimum: 1, description: 'For "cleanup": retention period in days (default 30).' },
            checkpointFreshnessSeconds: { type: 'integer', minimum: 1, description: 'For "reconcile": freshness threshold (default 3600).' },
            dryRun: { type: 'boolean', description: 'Preview what would happen without making changes.' },
            // mem0_snapshot / mem0_rollup
            content: { type: 'string', description: 'For "mem0_snapshot": the summary content to persist.' },
            memoryKind: { type: 'string', enum: ['decision', 'preference', 'summary', 'artifact_context', 'note'], description: 'For mem0 actions: memory kind.' },
            milestoneId: { type: 'string', description: 'For "mem0_rollup": milestone to roll up.' },
          },
          required: ['action'],
        },
        handler: async (args) => {
          const parsed = z.object({
            action: z.enum(['reconcile', 'drain', 'archive', 'cleanup', 'mem0_snapshot', 'mem0_rollup']),
            dbPath: z.string().optional(),
            projectId: z.string().optional(),
            projectName: z.string().optional(),
            workspaceId: z.string().optional(),
            campaignId: z.string().optional(),
            campaignName: z.string().optional(),
            retentionDays: z.number().int().positive().optional(),
            checkpointFreshnessSeconds: z.number().int().positive().optional(),
            dryRun: z.boolean().optional(),
            content: z.string().optional(),
            memoryKind: z.enum(['decision', 'preference', 'summary', 'artifact_context', 'note']).optional(),
            milestoneId: z.string().optional(),
          }).parse(args);

          const dbPath = resolveDbPath(parsed.dbPath);
          const db = openHarnessDatabase({ dbPath });
          try {
            const projectId = resolveProjectId(db.connection, {
              projectId: parsed.projectId,
              projectName: parsed.projectName,
              workspaceId: parsed.workspaceId,
            });
            const campaignId = parsed.campaignId
              ? parsed.campaignId
              : parsed.campaignName
                ? resolveCampaignId(db.connection, projectId, { campaignName: parsed.campaignName })
                : undefined;

            switch (parsed.action) {
              case 'reconcile': {
                const { reconcileProjectState } = await import('../db/lease-manager.js');
                const blockers = reconcileProjectState(db.connection, {
                  projectId,
                  campaignId,
                  checkpointFreshnessSeconds: parsed.checkpointFreshnessSeconds ?? 3600,
                });
                return {
                  reconciled: true,
                  blockers: blockers.map((b) => ({
                    issueId: b.issueId,
                    leaseId: b.leaseId,
                    reason: b.reason,
                    summary: b.summary,
                  })),
                  ...buildMeta(
                    blockers.length > 0
                      ? ['harness_session', 'harness_inspector']
                      : ['harness_inspector'],
                    blockers.length > 0
                      ? `Reconciliation found ${blockers.length} blocker(s). Use harness_session(action: "begin_recovery") to address them.`
                      : 'Reconciliation complete — no blockers found.',
                  ),
                };
              }

              case 'drain': {
                if (!campaignId) {
                  throw new AgenticToolError(
                    'campaignId or campaignName is required for drain.',
                    'Specify which campaign to drain.',
                    'harness_admin',
                  );
                }
                const dryRun = parsed.dryRun ?? false;
                const readyIssues = selectAll<{ id: string; task: string }>(
                  db.connection,
                  `SELECT id, task FROM issues WHERE project_id = ? AND campaign_id = ? AND status IN ('pending', 'ready')`,
                  [projectId, campaignId],
                );
                if (!dryRun) {
                  runStatement(
                    db.connection,
                    `UPDATE issues SET status = 'blocked' WHERE project_id = ? AND campaign_id = ? AND status IN ('pending', 'ready')`,
                    [projectId, campaignId],
                  );
                  runStatement(
                    db.connection,
                    `UPDATE campaigns SET status = 'paused' WHERE id = ?`,
                    [campaignId],
                  );
                }
                return {
                  drained: !dryRun,
                  dryRun,
                  affectedIssues: readyIssues.length,
                  issues: readyIssues.map((i) => ({ id: i.id, task: i.task })),
                  ...buildMeta(
                    ['harness_admin', 'harness_inspector'],
                    dryRun
                      ? `Dry run: ${readyIssues.length} issue(s) would be blocked.`
                      : `Campaign drained: ${readyIssues.length} issue(s) blocked, campaign paused.`,
                  ),
                };
              }

              case 'archive': {
                if (!campaignId) {
                  throw new AgenticToolError(
                    'campaignId or campaignName is required for archive.',
                    'Specify which campaign to archive.',
                    'harness_admin',
                  );
                }
                const dryRun = parsed.dryRun ?? false;
                const doneIssues = selectAll<{ id: string }>(
                  db.connection,
                  `SELECT id FROM issues WHERE project_id = ? AND campaign_id = ? AND status IN ('done', 'failed')`,
                  [projectId, campaignId],
                );
                const activeLeases = selectAll<{ id: string }>(
                  db.connection,
                  `SELECT id FROM leases WHERE project_id = ? AND campaign_id = ? AND status = 'active' AND released_at IS NULL`,
                  [projectId, campaignId],
                );
                if (!dryRun) {
                  runInTransaction(db.connection, () => {
                    for (const lease of activeLeases) {
                      runStatement(
                        db.connection,
                        `UPDATE leases SET status = 'released', released_at = ? WHERE id = ?`,
                        [new Date().toISOString(), lease.id],
                      );
                    }
                    runStatement(
                      db.connection,
                      `UPDATE campaigns SET status = 'archived' WHERE id = ?`,
                      [campaignId],
                    );
                  });
                }
                return {
                  archived: !dryRun,
                  dryRun,
                  doneIssues: doneIssues.length,
                  releasedLeases: activeLeases.length,
                  ...buildMeta(
                    ['harness_inspector'],
                    dryRun
                      ? `Dry run: would archive campaign with ${doneIssues.length} completed issue(s) and release ${activeLeases.length} lease(s).`
                      : `Campaign archived: ${activeLeases.length} lease(s) released.`,
                  ),
                };
              }

              case 'cleanup': {
                const retentionDays = parsed.retentionDays ?? 30;
                const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
                const dryRun = parsed.dryRun ?? false;

                const expiredSessions = selectAll<{ token: string }>(
                  db.connection,
                  `SELECT token FROM active_sessions WHERE project_id = ? AND status = 'closed' AND closed_at < ?`,
                  [projectId, cutoff],
                );
                const oldLeases = selectAll<{ id: string }>(
                  db.connection,
                  `SELECT id FROM leases WHERE project_id = ? AND status IN ('released', 'recovered') AND released_at < ?`,
                  [projectId, cutoff],
                );
                const oldEvents = selectAll<{ id: string }>(
                  db.connection,
                  `SELECT e.id FROM events e JOIN issues i ON e.issue_id = i.id WHERE i.project_id = ? AND e.created_at < ?`,
                  [projectId, cutoff],
                );

                if (!dryRun) {
                  runInTransaction(db.connection, () => {
                    for (const s of expiredSessions) {
                      runStatement(db.connection, `DELETE FROM active_sessions WHERE token = ?`, [s.token]);
                    }
                    for (const l of oldLeases) {
                      runStatement(db.connection, `DELETE FROM leases WHERE id = ?`, [l.id]);
                    }
                    for (const e of oldEvents) {
                      runStatement(db.connection, `DELETE FROM events WHERE id = ?`, [e.id]);
                    }
                  });
                }

                return {
                  cleaned: !dryRun,
                  dryRun,
                  retentionDays,
                  deletedSessions: expiredSessions.length,
                  deletedLeases: oldLeases.length,
                  deletedEvents: oldEvents.length,
                  ...buildMeta(
                    ['harness_inspector'],
                    dryRun
                      ? `Dry run: would delete ${expiredSessions.length} session(s), ${oldLeases.length} lease(s), ${oldEvents.length} event(s) older than ${retentionDays}d.`
                      : `Cleanup done: removed ${expiredSessions.length} session(s), ${oldLeases.length} lease(s), ${oldEvents.length} event(s).`,
                  ),
                };
              }

              case 'mem0_snapshot': {
                if (!parsed.content) {
                  throw new AgenticToolError(
                    'content is required for mem0_snapshot.',
                    'Provide the summary content to persist.',
                    'harness_admin',
                  );
                }
                const mem0 = await this.mem0AdapterLoader();
                if (!mem0) {
                  return {
                    stored: false,
                    reason: 'mem0 adapter not available',
                    ...buildMeta(['harness_admin'], 'mem0 is not configured. Set up mem0-mcp to enable memory persistence.'),
                  };
                }
                const workspace = selectOne<{ id: string }>(
                  db.connection,
                  `SELECT w.id FROM workspaces w JOIN projects p ON p.workspace_id = w.id WHERE p.id = ? LIMIT 1`,
                  [projectId],
                );
                const snapshotId = `snap-${randomUUID()}`;
                const record = await mem0.storeMemory({
                  kind: parsed.memoryKind ?? 'summary',
                  content: parsed.content,
                  scope: {
                    workspace: workspace?.id ?? 'unknown',
                    project: projectId,
                    campaign: campaignId ?? undefined,
                  },
                  provenance: {
                    checkpointId: snapshotId,
                    artifactIds: [],
                    note: 'project-level snapshot via harness_admin',
                  },
                  metadata: buildHarnessAdminMemoryMetadata({
                    action: 'mem0_snapshot',
                    projectId,
                    campaignId,
                  }),
                });
                runStatement(
                  db.connection,
                  `INSERT INTO memory_links (id, workspace_id, project_id, campaign_id, issue_id, memory_kind, memory_ref, summary, created_at)
                   VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
                  [randomUUID(), workspace?.id ?? '', projectId, campaignId ?? null, parsed.memoryKind ?? 'summary', record.id, parsed.content.slice(0, 200), new Date().toISOString()],
                );
                return {
                  stored: true,
                  memoryId: record.id,
                  snapshotId,
                  ...buildMeta(['harness_admin', 'harness_inspector'], 'Project snapshot persisted to mem0.'),
                };
              }

              case 'mem0_rollup': {
                const mem0 = await this.mem0AdapterLoader();
                if (!mem0) {
                  return {
                    rolledUp: false,
                    reason: 'mem0 adapter not available',
                    ...buildMeta(['harness_admin'], 'mem0 is not configured.'),
                  };
                }
                const workspace = selectOne<{ id: string }>(
                  db.connection,
                  `SELECT w.id FROM workspaces w JOIN projects p ON p.workspace_id = w.id WHERE p.id = ? LIMIT 1`,
                  [projectId],
                );
                const whereClauses = ['ml.project_id = ?'];
                const queryParams: string[] = [projectId];

                if (campaignId) {
                  whereClauses.push('ml.campaign_id = ?');
                  queryParams.push(campaignId);
                }

                if (parsed.milestoneId) {
                  whereClauses.push('i.milestone_id = ?');
                  queryParams.push(parsed.milestoneId);
                }

                const detailedLinks = selectAll<{ memory_ref: string; summary: string; memory_kind: string }>(
                  db.connection,
                  `SELECT ml.memory_ref, ml.summary, ml.memory_kind
                   FROM memory_links ml
                   LEFT JOIN issues i ON i.id = ml.issue_id
                   WHERE ${whereClauses.join(' AND ')}
                   ORDER BY ml.created_at ASC`,
                  queryParams,
                );
                if (detailedLinks.length === 0) {
                  return {
                    rolledUp: false,
                    reason: 'No memory links found to roll up.',
                    ...buildMeta(['harness_inspector'], 'Nothing to roll up — no memory links in scope.'),
                  };
                }
                const rollupContent = detailedLinks
                  .map((l, i) => `[${i + 1}] (${l.memory_kind}) ${l.summary}`)
                  .join('\n');
                const rollupId = `rollup-${randomUUID()}`;
                const record = await mem0.storeMemory({
                  kind: 'summary',
                  content: `Rollup of ${detailedLinks.length} memories:\n${rollupContent}`,
                  scope: {
                    workspace: workspace?.id ?? 'unknown',
                    project: projectId,
                    campaign: campaignId ?? undefined,
                  },
                  provenance: {
                    checkpointId: rollupId,
                    note: `Rolled up ${detailedLinks.length} task-level memories`,
                    artifactIds: detailedLinks.map((l) => l.memory_ref),
                  },
                  metadata: buildHarnessAdminMemoryMetadata({
                    action: 'mem0_rollup',
                    projectId,
                    campaignId,
                    milestoneId: parsed.milestoneId,
                    sourceCount: `${detailedLinks.length}`,
                  }),
                });
                runStatement(
                  db.connection,
                  `INSERT INTO memory_links (id, workspace_id, project_id, campaign_id, issue_id, memory_kind, memory_ref, summary, created_at)
                   VALUES (?, ?, ?, ?, NULL, 'summary', ?, ?, ?)`,
                  [randomUUID(), workspace?.id ?? '', projectId, campaignId ?? null, record.id, `Rollup of ${detailedLinks.length} memories`, new Date().toISOString()],
                );
                return {
                  rolledUp: true,
                  memoryId: record.id,
                  rollupId,
                  sourceCount: detailedLinks.length,
                  ...buildMeta(['harness_inspector'], `Rolled up ${detailedLinks.length} memories into a single summary.`),
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
  workspace_id: string;
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

function getHarnessContext(input: {
  dbPath?: string;
  workspaceId?: string;
  projectId?: string;
  projectName?: string;
  campaignId?: string;
}): Record<string, unknown> {
  const dbPath = resolveDbPath(input.dbPath);
  const database = openHarnessDatabase({ dbPath });

  try {
    const workspaces = selectAll<WorkspaceInfoRow>(
      database.connection,
      `SELECT id, name FROM workspaces ORDER BY created_at DESC`,
    );

    if (workspaces.length === 0) {
      return {
        workspace: null,
        action: 'setup_required',
        projects: [],
        campaigns: [],
        queue: {},
        ...buildMeta(
          ['harness_orchestrator'],
          'No workspace found. Call harness_orchestrator(action: "init_workspace") to create one.',
        ),
      };
    }

    if (!input.projectId && !input.projectName && !input.workspaceId && workspaces.length > 1) {
      return {
        action: 'clarify_scope',
        workspace: null,
        workspaces: workspaces.map((workspace) => ({
          id: workspace.id,
          name: workspace.name,
        })),
        projects: [],
        campaigns: [],
        queue: {},
        ...buildMeta(
          ['harness_inspector'],
          'Multiple workspaces found. Pass workspaceId to get_context to inspect a specific scope.',
        ),
      };
    }

    const resolvedProject =
      input.projectId || input.projectName
        ? resolveProjectSummary(database.connection, {
            projectId: input.projectId,
            projectName: input.projectName,
            workspaceId: input.workspaceId,
          })
        : null;
    const workspace =
      resolvedProject !== null
        ? loadWorkspaceSummary(database.connection, resolvedProject.workspace_id)
        : loadWorkspaceSummary(
            database.connection,
            resolveWorkspaceId(database.connection, {
              workspaceId: input.workspaceId,
            }),
          );
    const projects = selectAll<ProjectInfoRow>(
      database.connection,
      `SELECT id, name, key, status, workspace_id
       FROM projects
       WHERE workspace_id = ?
       ORDER BY created_at DESC`,
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

    if (resolvedProject === null && projects.length > 1) {
      return {
        action: 'clarify_scope',
        workspace: { id: workspace.id, name: workspace.name },
        projects: projects.map((project) => ({
          id: project.id,
          name: project.name,
          key: project.key,
          status: project.status,
        })),
        campaigns: [],
        queue: {},
        ...buildMeta(
          ['harness_inspector'],
          'Multiple projects found. Pass projectId or projectName to get_context to inspect one project deterministically.',
        ),
      };
    }

    const project = resolvedProject ?? projects[0];
    const campaigns = selectAll<CampaignInfoRow>(
      database.connection,
      `SELECT id, name, objective, status FROM campaigns WHERE project_id = ? ORDER BY created_at DESC`,
      [project.id],
    );
    const activeCampaign =
      input.campaignId !== undefined
        ? campaigns.find((campaign) => campaign.id === input.campaignId) ?? null
        : campaigns.length === 1
          ? campaigns[0]
          : null;

    if (input.campaignId !== undefined && activeCampaign === null) {
      throw new AgenticToolError(
        `Campaign ${input.campaignId} does not exist in project ${project.id}.`,
        `Pass a valid campaignId. Available campaigns: ${campaigns.map((campaign) => `"${campaign.name}" (${campaign.id})`).join(', ')}.`,
        'harness_inspector',
      );
    }

    const statusCounts = selectAll<StatusCountRow>(
      database.connection,
      `SELECT status, COUNT(*) as cnt
       FROM issues
       WHERE project_id = ?
         AND (? IS NULL OR campaign_id = ?)
       GROUP BY status`,
      [project.id, activeCampaign?.id ?? null, activeCampaign?.id ?? null],
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
      campaigns: campaigns.map((campaign) => ({
        id: campaign.id,
        name: campaign.name,
        objective: campaign.objective,
        status: campaign.status,
      })),
      activeCampaign: activeCampaign
        ? {
            id: activeCampaign.id,
            name: activeCampaign.name,
            objective: activeCampaign.objective,
          }
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
  workspaceId?: string;
  projectId?: string;
  projectName?: string;
}): Record<string, unknown> {
  const dbPath = resolveDbPath(input.dbPath);
  const database = openHarnessDatabase({ dbPath });

  try {
    const workspaceId =
      input.workspaceId !== undefined
        ? resolveWorkspaceId(database.connection, {
            workspaceId: input.workspaceId,
          })
        : undefined;

    let projectId = input.projectId;
    if (!projectId && !input.projectName) {
      const activeProjects = selectAll<ProjectInfoRow>(
        database.connection,
        `SELECT id, name, key, status, workspace_id
         FROM projects
         WHERE status = 'active'
           AND (? IS NULL OR workspace_id = ?)
         ORDER BY created_at DESC`,
        [workspaceId ?? null, workspaceId ?? null],
      );

      if (activeProjects.length === 0) {
        return {
          action: 'setup_required',
          tool: 'harness_orchestrator',
          reason: 'No active projects found. Create a project and campaign first.',
          ...buildMeta(['harness_orchestrator'], 'No projects exist. Call harness_orchestrator(action: "create_campaign") to get started.'),
        };
      }

      if (activeProjects.length > 1) {
        return {
          action: 'clarify_scope',
          reason: 'Multiple active projects found. Pass projectId or projectName before calling next_action.',
          projects: activeProjects.map((project) => ({
            id: project.id,
            name: project.name,
            key: project.key,
            status: project.status,
          })),
          ...buildMeta(
            ['harness_inspector'],
            'Multiple active projects found. Pass projectId or projectName to next_action.',
          ),
        };
      }

      projectId = activeProjects[0].id;
    } else if (!projectId && input.projectName) {
      try {
        projectId = resolveProjectId(database.connection, {
          projectName: input.projectName,
          workspaceId,
        });
      } catch (error) {
        if (
          error instanceof AgenticToolError &&
          /ambiguous/i.test(error.message)
        ) {
          const projects = selectAll<ProjectInfoRow>(
            database.connection,
            `SELECT id, name, key, status, workspace_id
             FROM projects
             WHERE name = ?
               AND status = 'active'
               AND (? IS NULL OR workspace_id = ?)
             ORDER BY created_at DESC`,
            [input.projectName, workspaceId ?? null, workspaceId ?? null],
          );

          return {
            action: 'clarify_scope',
            reason: error.message,
            message: 'Pass projectId explicitly to disambiguate next_action.',
            projects: projects.map((project) => ({
              id: project.id,
              name: project.name,
              key: project.key,
              status: project.status,
            })),
            ...buildMeta(
              ['harness_inspector'],
              'Multiple matching projects found. Pass projectId to next_action.',
            ),
          };
        }

        throw error;
      }
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

function resolveProjectSummary(
  connection: ReturnType<typeof openHarnessDatabase>['connection'],
  input: {
    projectId?: string;
    projectName?: string;
    workspaceId?: string;
  },
): ProjectInfoRow {
  const projectId = resolveProjectId(connection, input);
  const project = selectOne<ProjectInfoRow>(
    connection,
    `SELECT id, name, key, status, workspace_id
     FROM projects
     WHERE id = ?
     LIMIT 1`,
    [projectId],
  );

  if (project === null) {
    throw new AgenticToolError(
      `Project ${projectId} does not exist.`,
      'Pass a valid projectId or projectName.',
      'harness_inspector',
    );
  }

  return project;
}

function loadWorkspaceSummary(
  connection: ReturnType<typeof openHarnessDatabase>['connection'],
  workspaceId: string,
): WorkspaceInfoRow {
  const workspace = selectOne<WorkspaceInfoRow>(
    connection,
    `SELECT id, name
     FROM workspaces
     WHERE id = ?
     LIMIT 1`,
    [workspaceId],
  );

  if (workspace === null) {
    throw new AgenticToolError(
      `Workspace ${workspaceId} does not exist.`,
      'Pass a valid workspaceId or call harness_orchestrator(action: "init_workspace") first.',
      'harness_orchestrator',
    );
  }

  return workspace;
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

async function inspectMem0Status(
  mem0AdapterLoader: Mem0AdapterLoader,
): Promise<Record<string, unknown>> {
  try {
    const mem0 = await mem0AdapterLoader();

    if (mem0 === null) {
      return {
        configured: false,
        available: false,
        reason: 'mem0 adapter not configured',
      };
    }

    try {
      const health = await mem0.healthCheck();
      return {
        configured: true,
        available: health.ok,
        adapterId: mem0.metadata.adapterId,
        contractVersion: mem0.metadata.contractVersion,
        capabilities: mem0.metadata.capabilities,
        health,
      };
    } catch (error) {
      return {
        configured: true,
        available: false,
        adapterId: mem0.metadata.adapterId,
        contractVersion: mem0.metadata.contractVersion,
        capabilities: mem0.metadata.capabilities,
        reason: getErrorMessage(error),
      };
    }
  } catch (error) {
    return {
      configured: false,
      available: false,
      reason: getErrorMessage(error),
    };
  }
}

function buildHarnessAdminMemoryMetadata(input: {
  action: 'mem0_snapshot' | 'mem0_rollup';
  projectId: string;
  campaignId?: string;
  milestoneId?: string;
  sourceCount?: string;
}): Record<string, string> {
  const entries = Object.entries({
    source: 'harness_admin',
    action: input.action,
    project_id: input.projectId,
    campaign_id: input.campaignId,
    milestone_id: input.milestoneId,
    source_count: input.sourceCount,
  }).filter((entry): entry is [string, string] => {
    const value = entry[1];
    return typeof value === 'string' && value.length > 0;
  });

  return Object.fromEntries(entries);
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
