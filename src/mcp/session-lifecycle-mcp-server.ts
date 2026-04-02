import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import type { HarnessHostCapabilities } from '../contracts/policy-contracts.js';
import type { WorkloadProfileId } from '../contracts/workload-profiles.js';
import { SessionLifecycleAdapter } from '../runtime/session-lifecycle-adapter.js';
import { loadDefaultMem0Adapter } from '../runtime/default-mem0-loader.js';
import {
  createHarnessCampaign,
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
import {
  buildIssuePolicySurface,
  evaluateIssueDispatchState,
  normalizeHarnessHostCapabilities,
  sortIssuesForDispatch,
} from '../runtime/policy-engine.js';
import { buildWorkItemMetadataSurface } from '../runtime/work-item-metadata.js';
import { isWorkloadProfileId } from '../runtime/workload-profile-registry.js';
import {
  getHarnessToolContract,
  getHarnessToolInputJsonSchema,
  harnessAdminInputSchema,
  harnessArtifactsInputSchema,
  harnessInspectorInputSchema,
  harnessOrchestratorInputSchema,
  harnessSessionInputSchema,
} from '../runtime/harness-tool-contracts.js';
import type { SessionContext } from '../contracts/session-contracts.js';
import {
  incrementalSessionInputSchema,
  SESSION_LIFECYCLE_CLI_CONTRACT_VERSION,
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

// ─── Server ─────────────────────────────────────────────────────────

const HARNESS_INSTRUCTIONS = `You are connected to the agent-harness lifecycle server — an Agentic OS for autonomous task execution.

This server exposes 5 tools, each covering a specific domain. Use the "action" parameter to select the operation.

TOOLS:
1. harness_inspector  — Read-only observation. Actions: capabilities, get_context, next_action, export, audit, health_snapshot.
2. harness_orchestrator — Setup & queue management. Actions: init_workspace, create_campaign, plan_issues, promote_queue, rollback_issue.
3. harness_session — Execution lifecycle. Actions: begin, begin_recovery, checkpoint, close, advance, heartbeat.
4. harness_artifacts — Persistent state registry. Actions: save, list.
5. harness_admin — Maintenance & administration. Actions: reconcile, drain, archive, cleanup, mem0_snapshot, mem0_rollup.

ORIENTATION (call first in any new session):
- harness_inspector(action: "capabilities") → discover tool map, bundled skills, mem0 availability
- harness_inspector(action: "get_context") → see workspace, project, campaign, queue status
- harness_inspector(action: "next_action", host, hostCapabilities) → get the next host-aware directive
- harness_inspector(action: "health_snapshot") → operational health, alerts, stale leases, and policy breach metrics

SETUP (one-time, when no workspace/project exists):
1. harness_orchestrator(action: "init_workspace")
2. harness_orchestrator(action: "create_campaign")
3. harness_orchestrator(action: "plan_issues")

EXECUTION LOOP (repeated):
4. harness_orchestrator(action: "promote_queue")
5. harness_session(action: "begin") → claims the next task dispatchable to the provided host routing context, returns sessionToken
6. [Do the work described in the issued task]
7. harness_session(action: "checkpoint") → save progress (pass sessionToken)
8. harness_session(action: "heartbeat") → renew lease for long-running tasks (pass sessionToken)
9. harness_session(action: "advance") → close current + claim next task atomically (preferred)
10. harness_session(action: "close") → close without advancing (alternative to step 9)

RECOVERY:
- harness_orchestrator(action: "rollback_issue") → reset stuck issue to pending
- harness_session(action: "begin_recovery") → claim a needs_recovery issue for the provided host routing context

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
- \`next_action\`, \`begin\`, and \`begin_recovery\` require explicit host routing context (\`host\` + \`hostCapabilities\`) so dispatch remains configurable and explainable.
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
    const inspectorContract = getHarnessToolContract('harness_inspector');
    const orchestratorContract = getHarnessToolContract('harness_orchestrator');
    const sessionContract = getHarnessToolContract('harness_session');
    const artifactsContract = getHarnessToolContract('harness_artifacts');
    const adminContract = getHarnessToolContract('harness_admin');

    return [
      // ── 1. harness_inspector ──────────────────────────────────────
      {
        name: inspectorContract.name,
        description: inspectorContract.description,
        inputSchema: getHarnessToolInputJsonSchema(inspectorContract.name),
        handler: async (args) => {
          const parsed = harnessInspectorInputSchema.parse(args);

          switch (parsed.action) {
            case 'capabilities': {
              const activeWorkloadProfileId = resolveActiveWorkloadProfile();
              return {
                ...getHarnessCapabilityCatalog({
                  workloadProfileId: activeWorkloadProfileId,
                }),
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
                host: parsed.host,
                hostCapabilities: parsed.hostCapabilities,
              });

            case 'export': {
              const dbPath = resolveDbPath(parsed.dbPath);
              const db = openHarnessDatabase({ dbPath });
              try {
                const projectId = resolveProjectId(db.connection, {
                  projectId: parsed.projectId,
                  projectName: parsed.projectName,
                  workspaceId: parsed.workspaceId,
                });
                const result = await this.adapter.execute(withCliContractVersion({
                  action: 'inspect_export',
                  input: {
                    dbPath,
                    projectId,
                    campaignId: parsed.campaignId,
                    runLimit: parsed.runLimit,
                    eventLimit: parsed.eventLimit,
                  },
                })) as { result: Record<string, unknown> };
                const queue = result.result['queue'] as Record<string, unknown> | undefined;
                const readyCount = Array.isArray(queue?.['readyIssues'])
                  ? queue['readyIssues'].length
                  : 0;
                const recoveryCount = Array.isArray(queue?.['recoveryIssues'])
                  ? queue['recoveryIssues'].length
                  : 0;

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

            case 'audit': {
              const dbPath = resolveDbPath(parsed.dbPath);
              const { action: _action, ...input } = parsed;
              const result = await this.adapter.execute(withCliContractVersion({
                action: 'inspect_audit',
                input: { ...input, dbPath },
              })) as { result: Record<string, unknown> };
              const issue = result.result['issue'] as Record<string, unknown> | undefined;
              const status = issue?.['status'] as string | undefined;

              let hint = 'Issue audit loaded.';
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

            case 'health_snapshot': {
              const dbPath = resolveDbPath(parsed.dbPath);
              const db = openHarnessDatabase({ dbPath });
              try {
                const projectId = resolveProjectId(db.connection, {
                  projectId: parsed.projectId,
                  projectName: parsed.projectName,
                  workspaceId: parsed.workspaceId,
                });
                const result = await this.adapter.execute(withCliContractVersion({
                  action: 'inspect_health_snapshot',
                  input: {
                    dbPath,
                    projectId,
                    campaignId: parsed.campaignId,
                  },
                })) as { result: Record<string, unknown> };

                const staleCount =
                  ((result.result['leases'] as Record<string, unknown> | undefined)?.['staleCount'] as number | undefined)
                  ?? 0;
                let hint = 'Health snapshot loaded.';
                if (staleCount > 0) {
                  hint = `${staleCount} stale lease(s) detected. Run harness_admin(action: "reconcile") or harness_orchestrator(action: "promote_queue").`;
                }

                return {
                  ...result,
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
        name: orchestratorContract.name,
        description: orchestratorContract.description,
        inputSchema: getHarnessToolInputJsonSchema(orchestratorContract.name),
        handler: async (args) => {
          const parsed = harnessOrchestratorInputSchema.parse(args);

          switch (parsed.action) {
            case 'init_workspace':
              return initHarnessWorkspace(parsed);

            case 'create_campaign':
              return createHarnessCampaign(parsed);

            case 'plan_issues':
              return planHarnessIssues(parsed);

            case 'promote_queue': {
              const dbPath = resolveDbPath(parsed.dbPath);
              const db = openHarnessDatabase({ dbPath });
              try {
                const projectId = resolveProjectId(db.connection, {
                  projectId: parsed.projectId,
                  projectName: parsed.projectName,
                });
                const result = await this.adapter.execute(withCliContractVersion({
                  action: 'promote_queue',
                  input: { dbPath, projectId, campaignId: parsed.campaignId },
                })) as { result: { promotedIssueIds?: string[] } };
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
              {
                const { action: _action, ...input } = parsed;
                return rollbackHarnessIssue(input);
              }
          }
        },
      },

      // ── 3. harness_session ────────────────────────────────────────
      {
        name: sessionContract.name,
        description: sessionContract.description,
        inputSchema: getHarnessToolInputJsonSchema(sessionContract.name),
        handler: async (args) => {
          const parsed = harnessSessionInputSchema.parse(args);

          switch (parsed.action) {
            case 'begin': {
              const { action: _action, ...input } = parsed;
              const dbPath = resolveDbPath(input.dbPath);
              const result = (await this.adapter.execute(withCliContractVersion({
                action: 'begin_incremental',
                input: { ...input, dbPath },
              }))) as { context: SessionContext };
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
              const { action: _action, ...input } = parsed;
              const dbPath = resolveDbPath(input.dbPath);
              const result = (await this.adapter.execute(withCliContractVersion({
                action: 'begin_recovery',
                input: { ...input, dbPath },
              }))) as { context: SessionContext };
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
              const session = this.tokenStore.resolve(
                 parsed.sessionToken,
                 parsed.dbPath,
               );
               const context = session.context as unknown as SessionContext;
               const dbPath = resolveDbPath(context.dbPath ?? parsed.dbPath);
                const result = (await this.adapter.execute(withCliContractVersion({
                   action: 'checkpoint',
                   context: { ...context, dbPath },
                  input: parsed.input,
                }))) as { result: { checkpoint: { id: string } } };

               this.tokenStore.updateContext(parsed.sessionToken, {
                  currentCheckpointId: result.result.checkpoint.id,
                  currentTaskStatus: parsed.input.taskStatus,
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
               const session = this.tokenStore.resolve(
                 parsed.sessionToken,
                 parsed.dbPath,
               );
               const context = session.context as unknown as SessionContext;
               const dbPath = resolveDbPath(context.dbPath ?? parsed.dbPath);

                const executed = (await this.adapter.execute(withCliContractVersion({
                   action: 'close',
                   context: { ...context, dbPath },
                   input: parsed.closeInput,
                 }))) as { result: Record<string, unknown> };

               this.tokenStore.remove(parsed.sessionToken, dbPath);

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
                const session = this.tokenStore.resolve(
                  parsed.sessionToken,
                  parsed.dbPath,
                );
                const context = session.context as unknown as SessionContext;
                const dbPath = resolveDbPath(context.dbPath ?? parsed.dbPath);
                const nextBeginInput = buildNextIncrementalInput(session.beginInput, dbPath);
                const advanced = await this.adapter.advanceSession(
                  { ...context, dbPath },
                  parsed.closeInput,
                  { ...nextBeginInput, dbPath },
                );

                this.tokenStore.remove(parsed.sessionToken, dbPath);

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
               const session = this.tokenStore.resolve(
                 parsed.sessionToken,
                 parsed.dbPath,
               );
               const context = session.context as unknown as SessionContext;
               const dbPath = resolveDbPath(context.dbPath ?? parsed.dbPath);
               const db = openHarnessDatabase({ dbPath });
               try {
                 const { renewLease } = await import('../db/lease-manager.js');
                 const extensionSeconds = parsed.leaseTtlSeconds ?? 3600;
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
        name: artifactsContract.name,
        description: artifactsContract.description,
        inputSchema: getHarnessToolInputJsonSchema(artifactsContract.name),
        handler: async (args) => {
          const parsed = harnessArtifactsInputSchema.parse(args);

          const dbPath = resolveDbPath(parsed.dbPath);
          const db = openHarnessDatabase({ dbPath });
          try {
            const projectId = resolveProjectId(db.connection, {
              projectId: parsed.projectId,
              projectName: parsed.projectName,
            });

            switch (parsed.action) {
              case 'save': {
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
        name: adminContract.name,
        description: adminContract.description,
        inputSchema: getHarnessToolInputJsonSchema(adminContract.name),
        handler: async (args) => {
          const parsed = harnessAdminInputSchema.parse(args);

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
                  const drainReason = `campaign_drain:${campaignId}`;
                  runStatement(
                    db.connection,
                    `UPDATE issues
                     SET status = 'blocked',
                         blocked_reason = ?
                     WHERE project_id = ?
                       AND campaign_id = ?
                       AND status IN ('pending', 'ready')`,
                    [drainReason, projectId, campaignId],
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

function resolveActiveWorkloadProfile(): WorkloadProfileId | undefined {
  const configuredProfile = process.env['HARNESS_WORKLOAD_PROFILE'];
  if (!configuredProfile || !isWorkloadProfileId(configuredProfile)) {
    return undefined;
  }

  return configuredProfile;
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
  policy_json: string | null;
}

interface RecoveryIssueRow {
  id: string;
  task: string;
  priority: string;
  status: string;
  next_best_action: string | null;
  blocked_reason: string | null;
  created_at: string;
  deadline_at: string | null;
  recipients_json: string | null;
  approvals_json: string | null;
  external_refs_json: string | null;
  policy_json: string | null;
  campaign_policy_json: string | null;
}

interface ReadyIssueRow {
  id: string;
  task: string;
  priority: string;
  status: string;
  next_best_action: string | null;
  blocked_reason: string | null;
  created_at: string;
  deadline_at: string | null;
  recipients_json: string | null;
  approvals_json: string | null;
  external_refs_json: string | null;
  policy_json: string | null;
  campaign_policy_json: string | null;
}

interface BlockedIssueRow {
  id: string;
  task: string;
  priority: string;
  status: string;
  next_best_action: string | null;
  blocked_reason: string;
  created_at: string;
  deadline_at: string | null;
  recipients_json: string | null;
  approvals_json: string | null;
  external_refs_json: string | null;
  policy_json: string | null;
  campaign_policy_json: string | null;
}

interface BlockedMilestoneRow {
  id: string;
  description: string;
  priority: string;
  status: string;
  deadline_at: string | null;
  recipients_json: string | null;
  approvals_json: string | null;
  external_refs_json: string | null;
  blocked_reason: string;
}

interface ExpiredLeaseRow {
  id: string;
  issue_id: string | null;
  agent_id: string;
  status: string;
  expires_at: string;
  last_heartbeat_at: string | null;
}

interface IssueContextRow {
  id: string;
  task: string;
  priority: string;
  status: string;
  blocked_reason: string | null;
  next_best_action: string | null;
  created_at: string;
  deadline_at: string | null;
  recipients_json: string | null;
  approvals_json: string | null;
  external_refs_json: string | null;
  policy_json: string | null;
  campaign_policy_json: string | null;
}

interface MilestoneContextRow {
  id: string;
  description: string;
  priority: string;
  status: string;
  deadline_at: string | null;
  recipients_json: string | null;
  approvals_json: string | null;
  external_refs_json: string | null;
  blocked_reason: string | null;
}

interface LeaseContextRow {
  id: string;
  issue_id: string | null;
  agent_id: string;
  status: string;
  expires_at: string;
  last_heartbeat_at: string | null;
}

type NextActionStage =
  | 'expired_lease'
  | 'needs_recovery'
  | 'ready_issue'
  | 'dispatch_mismatch'
  | 'blocked_issue'
  | 'blocked_milestone'
  | 'pending_promotion'
  | 'idle';

type NextActionBlockerRefType = 'issue' | 'milestone' | 'campaign' | 'lease' | 'unknown';

interface ParsedBlockedReason {
  code: string;
  kind: string;
  refId: string;
  refType: NextActionBlockerRefType;
  detail?: string;
  summary: string;
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
      `SELECT id, name, objective, status, policy_json
       FROM campaigns
       WHERE project_id = ?
       ORDER BY created_at DESC`,
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
        ...(buildCampaignPolicyContext(campaign) ?? {}),
      })),
      activeCampaign: activeCampaign
        ? {
            id: activeCampaign.id,
            name: activeCampaign.name,
            objective: activeCampaign.objective,
            ...(buildCampaignPolicyContext(activeCampaign) ?? {}),
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
  host: string;
  hostCapabilities: HarnessHostCapabilities;
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
    const hostCapabilities = normalizeHarnessHostCapabilities(input.hostCapabilities);

    // Priority 1: Expired leases
      const expiredLeases = selectAll<ExpiredLeaseRow>(
        database.connection,
        `SELECT id, issue_id, agent_id, status, expires_at, last_heartbeat_at FROM leases
         WHERE project_id = ? AND status = 'active' AND expires_at < ?
        ORDER BY expires_at ASC LIMIT 1`,
       [projectId!, now],
     );

    if (expiredLeases.length > 0) {
      const lease = expiredLeases[0];
      const issueContext =
        lease.issue_id === null
          ? null
          : selectIssueContext(database.connection, lease.issue_id);
      return {
        action: 'call_tool',
        tool: 'harness_session',
        reason:
          lease.issue_id === null
            ? `Lease ${lease.id} expired at ${lease.expires_at}. Recovery needed before more work can be claimed.`
            : `Lease ${lease.id} on issue ${lease.issue_id} expired at ${lease.expires_at}. Recovery needed.`,
        suggestedPayload:
          lease.issue_id === null
            ? {
                action: 'begin_recovery',
                host: input.host,
                hostCapabilities,
              }
            : {
                action: 'begin_recovery',
                preferredIssueId: lease.issue_id,
                host: input.host,
                hostCapabilities,
              },
        context: {
          stage: 'expired_lease' satisfies NextActionStage,
          priority: 1,
          projectId,
          host: mapHostRoutingContext(input.host, hostCapabilities),
          issue: issueContext === null ? undefined : mapIssueDecisionContext(issueContext),
          lease: mapLeaseDecisionContext(lease),
          blocker: {
            code: `lease_expired:${lease.id}`,
            kind: 'lease_expired',
            refId: lease.id,
            refType: 'lease' satisfies NextActionBlockerRefType,
            detail:
              lease.issue_id === null
                ? undefined
                : `Issue ${lease.issue_id} cannot be resumed until recovery claims a fresh lease.`,
            summary:
              lease.issue_id === null
                ? `lease ${lease.id} expired at ${lease.expires_at}`
                : `lease ${lease.id} expired for issue ${lease.issue_id}`,
          },
        },
        ...buildMeta(['harness_session'], 'Expired lease detected. Call harness_session(action: "begin_recovery") to recover.'),
      };
    }

    // Priority 2: needs_recovery issues
    const recoveryIssues = selectAll<RecoveryIssueRow>(
      database.connection,
      `SELECT
         i.id,
         i.task,
         i.priority,
         i.status,
         i.next_best_action,
         i.blocked_reason,
         i.created_at,
         i.deadline_at,
         i.recipients_json,
         i.approvals_json,
         i.external_refs_json,
         i.policy_json,
         c.policy_json AS campaign_policy_json
       FROM issues i
       LEFT JOIN campaigns c ON c.id = i.campaign_id
       WHERE i.project_id = ?
         AND i.status = 'needs_recovery'
       ORDER BY i.id ASC`,
      [projectId!],
    );

    if (recoveryIssues.length > 0) {
      const issue = selectDispatchableIssueForHost(recoveryIssues, hostCapabilities);

      if (issue !== undefined) {
        const leaseContext = selectLatestLeaseContextByIssue(database.connection, issue.id);
        return {
          action: 'call_tool',
          tool: 'harness_session',
          reason: `Issue "${issue.task}" (${issue.id}, priority: ${issue.priority}) needs recovery.`,
          suggestedPayload: {
            action: 'begin_recovery',
            preferredIssueId: issue.id,
            host: input.host,
            hostCapabilities,
          },
          context: {
            stage: 'needs_recovery' satisfies NextActionStage,
            priority: 2,
            projectId,
            host: mapHostRoutingContext(input.host, hostCapabilities),
            issue: mapIssueDecisionContext({
              ...issue,
              status: 'needs_recovery',
            }),
            dispatch: mapDispatchDecisionContext(issue, hostCapabilities),
            lease: leaseContext === null ? undefined : mapLeaseDecisionContext(leaseContext),
            blocker: {
              code: `issue_needs_recovery:${issue.id}`,
              kind: 'issue_needs_recovery',
              refId: issue.id,
              refType: 'issue' satisfies NextActionBlockerRefType,
              summary: `issue ${issue.id} is waiting on a recovery claim`,
            },
          },
          ...buildMeta(['harness_session'], 'Recovery issue found. Call harness_session(action: "begin_recovery").'),
        };
      }

      const topRecoveryIssue = sortIssuesForDispatch(recoveryIssues)[0];
      return {
        action: 'call_tool',
        tool: 'harness_inspector',
        reason: `Recovery issues exist, but none match host "${input.host}" and its declared routing capabilities.`,
        suggestedPayload: {
          action: 'audit',
          issueId: topRecoveryIssue?.id,
        },
        context: {
          stage: 'dispatch_mismatch' satisfies NextActionStage,
          priority: 2,
          projectId,
          host: mapHostRoutingContext(input.host, hostCapabilities),
          blocker: {
            code: `dispatch_mismatch:${input.host}:needs_recovery`,
            kind: 'dispatch_mismatch',
            refId: topRecoveryIssue?.id ?? input.host,
            refType: topRecoveryIssue !== undefined ? ('issue' satisfies NextActionBlockerRefType) : ('unknown' satisfies NextActionBlockerRefType),
            summary: `host ${input.host} cannot recover the currently queued recovery work`,
          },
          candidates: mapDispatchMismatchCandidates(recoveryIssues, hostCapabilities),
        },
        ...buildMeta(['harness_inspector'], 'No recovery issue matches this host context. Inspect the audit trail or choose a host with compatible routing capabilities.'),
      };
    }

    // Priority 3: Ready issues
    const readyIssues = selectAll<ReadyIssueRow>(
      database.connection,
      `SELECT
         i.id,
         i.task,
         i.priority,
         i.status,
         i.next_best_action,
         i.blocked_reason,
         i.created_at,
         i.deadline_at,
         i.recipients_json,
         i.approvals_json,
         i.external_refs_json,
         i.policy_json,
         c.policy_json AS campaign_policy_json
       FROM issues i
       LEFT JOIN campaigns c ON c.id = i.campaign_id
       WHERE i.project_id = ?
         AND i.status = 'ready'
       ORDER BY i.id ASC`,
      [projectId!],
    );

    if (readyIssues.length > 0) {
      const issue = selectDispatchableIssueForHost(readyIssues, hostCapabilities);

      if (issue !== undefined) {
        return {
          action: 'call_tool',
          tool: 'harness_session',
          reason: `Task "${issue.task}" (${issue.id}, priority: ${issue.priority}) is ready to be claimed.`,
          suggestedPayload: {
            action: 'begin',
            preferredIssueId: issue.id,
            host: input.host,
            hostCapabilities,
          },
          context: {
            stage: 'ready_issue' satisfies NextActionStage,
            priority: 3,
            projectId,
            host: mapHostRoutingContext(input.host, hostCapabilities),
            issue: mapIssueDecisionContext({
              ...issue,
              status: 'ready',
              blocked_reason: null,
            }),
            dispatch: mapDispatchDecisionContext(issue, hostCapabilities),
          },
          ...buildMeta(['harness_session'], 'Ready task available. Call harness_session(action: "begin").'),
        };
      }

      return {
        action: 'call_tool',
        tool: 'harness_inspector',
        reason: `Ready issues exist, but none match host "${input.host}" and its declared routing capabilities.`,
        suggestedPayload: {
          action: 'export',
          projectId,
        },
        context: {
          stage: 'dispatch_mismatch' satisfies NextActionStage,
          priority: 3,
          projectId,
          host: mapHostRoutingContext(input.host, hostCapabilities),
          blocker: {
            code: `dispatch_mismatch:${input.host}:ready`,
            kind: 'dispatch_mismatch',
            refId: input.host,
            refType: 'unknown' satisfies NextActionBlockerRefType,
            summary: `host ${input.host} cannot claim the current ready work`,
          },
          candidates: mapDispatchMismatchCandidates(readyIssues, hostCapabilities),
        },
        ...buildMeta(['harness_inspector'], 'No ready issue matches this host context. Inspect the export or choose a host with compatible routing capabilities.'),
      };
    }

    // Priority 4: Work blocked by explicit blocker reasons
    const blockedIssues = selectAll<BlockedIssueRow>(
      database.connection,
      `SELECT
         i.id,
         i.task,
         i.priority,
         i.status,
         i.next_best_action,
         i.blocked_reason,
         i.created_at,
         i.deadline_at,
         i.recipients_json,
         i.approvals_json,
         i.external_refs_json,
         i.policy_json,
         c.policy_json AS campaign_policy_json
       FROM issues i
       LEFT JOIN campaigns c ON c.id = i.campaign_id
       WHERE i.project_id = ?
         AND i.status IN ('pending', 'blocked')
         AND i.blocked_reason IS NOT NULL
       ORDER BY CASE i.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, i.id ASC
        LIMIT 1`,
      [projectId!],
    );

    if (blockedIssues.length > 0) {
      const issue = blockedIssues[0];
      const blocker = parseBlockedReason(issue.blocked_reason);
      const blockingIssue =
        blocker.refType === 'issue'
          ? selectIssueContext(database.connection, blocker.refId)
          : null;
      const blockingMilestone =
        blocker.refType === 'milestone'
          ? selectMilestoneContext(database.connection, blocker.refId)
          : null;
      return {
        action: 'call_tool',
        tool: 'harness_inspector',
        reason: `Task "${issue.task}" (${issue.id}, priority: ${issue.priority}) is ${issue.status === 'blocked' ? 'blocked' : 'waiting'} on ${blocker.summary}.`,
        suggestedPayload: { action: 'audit', issueId: issue.id },
        context: {
          stage: 'blocked_issue' satisfies NextActionStage,
          priority: 4,
          projectId,
          issue: mapIssueDecisionContext({
            ...issue,
            next_best_action: null,
          }),
          blocker,
          blockingIssue: blockingIssue === null ? undefined : mapIssueDecisionContext(blockingIssue),
          blockingMilestone:
            blockingMilestone === null
              ? undefined
              : mapMilestoneDecisionContext(blockingMilestone),
        },
        ...buildMeta(['harness_inspector'], 'Blocked task found. Inspect the issue audit trail to see the concrete blocker.'),
      };
    }

    const blockedMilestones = selectAll<BlockedMilestoneRow>(
      database.connection,
      `SELECT
         id,
         description,
         priority,
         status,
         deadline_at,
         recipients_json,
         approvals_json,
         external_refs_json,
         blocked_reason
        FROM milestones
        WHERE project_id = ?
          AND status = 'blocked'
          AND blocked_reason IS NOT NULL
       ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, id ASC
       LIMIT 1`,
      [projectId!],
    );

    if (blockedMilestones.length > 0) {
      const milestone = blockedMilestones[0];
      const blocker = parseBlockedReason(milestone.blocked_reason);
      const blockingIssue =
        blocker.refType === 'issue'
          ? selectIssueContext(database.connection, blocker.refId)
          : null;
      const blockingMilestone =
        blocker.refType === 'milestone'
          ? selectMilestoneContext(database.connection, blocker.refId)
          : null;
      return {
        action: 'call_tool',
        tool: 'harness_inspector',
        reason: `Milestone "${milestone.description}" (${milestone.id}, priority: ${milestone.priority}) is blocked by ${blocker.summary}.`,
        suggestedPayload: { action: 'export', projectId: projectId! },
        context: {
          stage: 'blocked_milestone' satisfies NextActionStage,
          priority: 5,
          projectId,
          milestone: mapMilestoneDecisionContext({
            ...milestone,
            blocked_reason: milestone.blocked_reason,
          }),
          blocker,
          blockingIssue: blockingIssue === null ? undefined : mapIssueDecisionContext(blockingIssue),
          blockingMilestone:
            blockingMilestone === null
              ? undefined
              : mapMilestoneDecisionContext(blockingMilestone),
        },
        ...buildMeta(['harness_inspector'], 'Blocked milestone found. Inspect the project export to see the concrete blocker.'),
      };
    }

    // Priority 5: Pending issues that might be promotable
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
        context: {
          stage: 'pending_promotion' satisfies NextActionStage,
          priority: 6,
          projectId,
          queue: {
            pendingIssues: pendingCount.cnt,
          },
        },
        ...buildMeta(['harness_orchestrator'], 'Pending tasks exist. Call harness_orchestrator(action: "promote_queue") to check promotability.'),
      };
    }

    // Priority 6: All done
    return {
      action: 'idle',
      reason: 'All tasks are complete or no tasks exist in the queue.',
      context: {
        stage: 'idle' satisfies NextActionStage,
        priority: 7,
        projectId,
      },
      ...buildMeta(['harness_orchestrator', 'harness_inspector'], 'Queue is empty. Add more work with harness_orchestrator(action: "plan_issues").'),
    };
  } finally {
    database.close();
  }
}

function describeBlockedReason(reason: string): string {
  return parseBlockedReason(reason).summary;
}

function parseBlockedReason(reason: string): ParsedBlockedReason {
  const [kind, firstRef, ...rest] = reason.split(':');
  const detail = rest.join(':') || undefined;

  switch (kind) {
    case 'issue_dependency':
      return {
        code: reason,
        kind,
        refId: firstRef,
        refType: 'issue',
        detail,
        summary: `issue ${firstRef}`,
      };
    case 'milestone_dependency':
      return {
        code: reason,
        kind,
        refId: firstRef,
        refType: 'milestone',
        detail,
        summary: `milestone ${firstRef}`,
      };
    case 'issue_needs_recovery':
      return {
        code: reason,
        kind,
        refId: firstRef,
        refType: 'issue',
        detail,
        summary: `recovery of issue ${firstRef}`,
      };
    case 'issue_blocked':
      return {
        code: reason,
        kind,
        refId: firstRef,
        refType: 'issue',
        detail,
        summary:
          detail === undefined
            ? `issue ${firstRef}`
            : `issue ${firstRef} (${detail})`,
      };
    case 'campaign_drain':
      return {
        code: reason,
        kind,
        refId: firstRef,
        refType: 'campaign',
        detail,
        summary: `campaign ${firstRef} drain`,
      };
    case 'lease_expired':
      return {
        code: reason,
        kind,
        refId: firstRef,
        refType: 'lease',
        detail,
        summary: `lease ${firstRef} expired`,
      };
    case 'checkpoint_stale':
      return {
        code: reason,
        kind,
        refId: firstRef,
        refType: 'lease',
        detail,
        summary: `lease ${firstRef} has stale checkpoint evidence`,
      };
    default:
      return {
        code: reason,
        kind,
        refId: firstRef,
        refType: 'unknown',
        detail,
        summary: reason,
      };
  }
}

function selectIssueContext(
  connection: ReturnType<typeof openHarnessDatabase>['connection'],
  issueId: string,
): IssueContextRow | null {
  return selectOne<IssueContextRow>(
    connection,
    `SELECT
       i.id,
       i.task,
       i.priority,
       i.status,
       i.blocked_reason,
       i.next_best_action,
       i.created_at,
       i.deadline_at,
       i.recipients_json,
       i.approvals_json,
       i.external_refs_json,
       i.policy_json,
       c.policy_json AS campaign_policy_json
     FROM issues i
     LEFT JOIN campaigns c ON c.id = i.campaign_id
     WHERE i.id = ?
     LIMIT 1`,
    [issueId],
  );
}

function selectMilestoneContext(
  connection: ReturnType<typeof openHarnessDatabase>['connection'],
  milestoneId: string,
): MilestoneContextRow | null {
  return selectOne<MilestoneContextRow>(
    connection,
     `SELECT
        id,
        description,
        priority,
        status,
        deadline_at,
        recipients_json,
        approvals_json,
        external_refs_json,
        blocked_reason
      FROM milestones
      WHERE id = ?
      LIMIT 1`,
    [milestoneId],
  );
}

function selectLatestLeaseContextByIssue(
  connection: ReturnType<typeof openHarnessDatabase>['connection'],
  issueId: string,
): LeaseContextRow | null {
  return selectOne<LeaseContextRow>(
    connection,
    `SELECT id, issue_id, agent_id, status, expires_at, last_heartbeat_at
     FROM leases
     WHERE issue_id = ?
     ORDER BY acquired_at DESC
     LIMIT 1`,
    [issueId],
  );
}

function selectDispatchableIssueForHost<
  T extends {
    id: string;
    task: string;
    priority: string;
    status: string;
    blocked_reason: string | null;
    next_best_action: string | null;
    created_at: string;
    deadline_at: string | null;
    recipients_json: string | null;
    approvals_json: string | null;
    external_refs_json: string | null;
    policy_json: string | null;
    campaign_policy_json: string | null;
  },
>(issues: readonly T[], hostCapabilities: HarnessHostCapabilities): T | undefined {
  return sortIssuesForDispatch(issues).find((issue) =>
    evaluateIssueDispatchState(issue, hostCapabilities).eligible,
  );
}

function mapHostRoutingContext(
  host: string,
  hostCapabilities: HarnessHostCapabilities,
): Record<string, unknown> {
  return {
    host,
    hostCapabilities,
  };
}

function mapDispatchDecisionContext(
  issue: {
    id: string;
    priority: string;
    status: string;
    created_at: string;
    policy_json: string | null;
    campaign_policy_json: string | null;
  },
  hostCapabilities: HarnessHostCapabilities,
): Record<string, unknown> {
  const dispatch = evaluateIssueDispatchState(issue, hostCapabilities);

  return {
    eligible: dispatch.eligible,
    ...(dispatch.requiredWorkloadClass !== undefined
      ? { requiredWorkloadClass: dispatch.requiredWorkloadClass }
      : {}),
    requiredHostCapabilities: dispatch.requiredHostCapabilities,
    ...(dispatch.missingWorkloadClass !== undefined
      ? { missingWorkloadClass: dispatch.missingWorkloadClass }
      : {}),
    ...(dispatch.missingHostCapabilities.length > 0
      ? { missingHostCapabilities: dispatch.missingHostCapabilities }
      : {}),
  };
}

function mapDispatchMismatchCandidates<
  T extends {
    id: string;
    task: string;
    priority: string;
    status: string;
    blocked_reason: string | null;
    next_best_action: string | null;
    created_at: string;
    deadline_at: string | null;
    recipients_json: string | null;
    approvals_json: string | null;
    external_refs_json: string | null;
    policy_json: string | null;
    campaign_policy_json: string | null;
  },
>(issues: readonly T[], hostCapabilities: HarnessHostCapabilities): Array<Record<string, unknown>> {
  return sortIssuesForDispatch(issues)
    .slice(0, 3)
    .map((issue) => ({
      ...mapIssueDecisionContext(issue),
      dispatch: mapDispatchDecisionContext(issue, hostCapabilities),
    }));
}

function mapIssueDecisionContext(issue: {
  id: string;
  task: string;
  priority: string;
  status: string;
  blocked_reason: string | null;
  next_best_action: string | null;
  created_at: string;
  deadline_at: string | null;
  recipients_json: string | null;
  approvals_json: string | null;
  external_refs_json: string | null;
  policy_json: string | null;
  campaign_policy_json: string | null;
}): Record<string, unknown> {
  const policySurface = buildIssuePolicySurface(issue);
  const workflowMetadata = buildWorkItemMetadataSurface(issue);

  return {
    id: issue.id,
    task: issue.task,
    priority: issue.priority,
    status: issue.status,
    blockedReason: issue.blocked_reason,
    nextBestAction: issue.next_best_action,
    ...(workflowMetadata?.deadlineAt !== undefined
      ? { deadlineAt: workflowMetadata.deadlineAt }
      : {}),
    ...(workflowMetadata?.recipients !== undefined
      ? { recipients: workflowMetadata.recipients }
      : {}),
    ...(workflowMetadata?.approvals !== undefined
      ? { approvals: workflowMetadata.approvals }
      : {}),
    ...(workflowMetadata?.externalRefs !== undefined
      ? { externalRefs: workflowMetadata.externalRefs }
      : {}),
    ...(policySurface.policy !== undefined ? { policy: policySurface.policy } : {}),
    ...(policySurface.policyState !== undefined
      ? { policyState: policySurface.policyState }
      : {}),
  };
}

function buildCampaignPolicyContext(
  campaign: Pick<CampaignInfoRow, 'policy_json'>,
): { policy: Record<string, unknown> } | null {
  const policySurface = buildIssuePolicySurface({
    id: 'campaign-policy',
    priority: 'medium',
    status: 'pending',
    policy_json: null,
    campaign_policy_json: campaign.policy_json,
    created_at: null,
  });

  return policySurface.policy === undefined
    ? null
    : {
        policy: policySurface.policy as Record<string, unknown>,
      };
}

function mapMilestoneDecisionContext(milestone: {
  id: string;
  description: string;
  priority: string;
  status: string;
  deadline_at: string | null;
  recipients_json: string | null;
  approvals_json: string | null;
  external_refs_json: string | null;
  blocked_reason: string | null;
}): Record<string, unknown> {
  const workflowMetadata = buildWorkItemMetadataSurface(milestone);

  return {
    id: milestone.id,
    description: milestone.description,
    priority: milestone.priority,
    status: milestone.status,
    blockedReason: milestone.blocked_reason,
    ...(workflowMetadata?.deadlineAt !== undefined
      ? { deadlineAt: workflowMetadata.deadlineAt }
      : {}),
    ...(workflowMetadata?.recipients !== undefined
      ? { recipients: workflowMetadata.recipients }
      : {}),
    ...(workflowMetadata?.approvals !== undefined
      ? { approvals: workflowMetadata.approvals }
      : {}),
    ...(workflowMetadata?.externalRefs !== undefined
      ? { externalRefs: workflowMetadata.externalRefs }
      : {}),
  };
}

function mapLeaseDecisionContext(lease: {
  id: string;
  issue_id: string | null;
  agent_id: string;
  status: string;
  expires_at: string;
  last_heartbeat_at: string | null;
}): Record<string, unknown> {
  return {
    id: lease.id,
    issueId: lease.issue_id,
    agentId: lease.agent_id,
    status: lease.status,
    expiresAt: lease.expires_at,
    lastHeartbeatAt: lease.last_heartbeat_at,
  };
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

function withCliContractVersion<TPayload extends Record<string, unknown>>(
  payload: TPayload,
): TPayload & { contractVersion: typeof SESSION_LIFECYCLE_CLI_CONTRACT_VERSION } {
  return {
    ...payload,
    contractVersion: SESSION_LIFECYCLE_CLI_CONTRACT_VERSION,
  };
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
    artifacts: candidate.artifacts,
    mem0Enabled: candidate.mem0Enabled,
    ...(candidate.campaignId !== undefined
      ? { campaignId: candidate.campaignId }
      : {}),
    ...(candidate.agentId !== undefined ? { agentId: candidate.agentId } : {}),
    host: candidate.host,
    hostCapabilities: candidate.hostCapabilities,
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
