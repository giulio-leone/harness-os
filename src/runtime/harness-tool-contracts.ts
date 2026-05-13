import { z } from 'zod';

import {
  harnessHostCapabilitiesSchema,
  harnessPolicySchema,
} from '../contracts/policy-contracts.js';
import {
  orchestrationDashboardIssueFiltersInputSchema,
} from '../contracts/orchestration-dashboard-contracts.js';
import {
  orchestrationSupervisorRunInputSchema,
  orchestrationSupervisorTickInputSchema,
  orchestrationSubagentSchema,
  orchestrationWorktreeCleanupPolicySchema,
} from '../contracts/orchestration-contracts.js';
import {
  symphonyAssignmentRunnerInputSchema,
} from '../contracts/orchestration-assignment-runner-contracts.js';
import {
  issuePrioritySchema,
  tShirtSizeSchema,
} from '../contracts/task-domain.js';
import { harnessWorkflowMetadataSchema } from '../contracts/workflow-contracts.js';
import {
  harnessCreateCampaignInputSchema,
  harnessInitWorkspaceInputSchema,
  harnessPlanIssuesInputSchema,
  harnessRollbackIssueInputSchema,
} from './harness-planning-tools.js';
import {
  incrementalSessionInputSchema,
  inspectAuditInputSchema,
  inspectExportInputSchema,
  inspectHealthSnapshotInputSchema,
  queuePromotionInputSchema,
  recoverySessionInputSchema,
  SESSION_LIFECYCLE_CLI_CONTRACT_VERSION,
  sessionCheckpointInputSchema,
  sessionCloseInputSchema,
} from './session-lifecycle-cli.schemas.js';

export interface HarnessToolActionContract {
  action: string;
  purpose: string;
  recommendedWhen: string[];
  requiredFields?: string[];
  example: Record<string, unknown>;
}

export interface HarnessToolContract {
  name: string;
  description: string;
  role: string;
  summary: string;
  recommendedFirstCall?: boolean;
  inputSchema: z.ZodTypeAny;
  actions: HarnessToolActionContract[];
}

const nonEmptyString = z.string().min(1);
const optionalString = nonEmptyString.optional();
const positiveInt = z.number().int().positive();
const boundedInt100 = positiveInt.max(100);

export const inspectorActionValues = [
  'capabilities',
  'get_context',
  'next_action',
  'export',
  'audit',
  'health_snapshot',
] as const;
export const orchestratorActionValues = [
  'init_workspace',
  'create_campaign',
  'plan_issues',
  'promote_queue',
  'rollback_issue',
] as const;
export const symphonyActionValues = [
  'compile_plan',
  'dispatch_ready',
  'inspect_state',
  'dashboard_view',
  'run_assignment',
  'supervisor_tick',
  'supervisor_run',
] as const;
export const sessionActionValues = [
  'begin',
  'begin_recovery',
  'checkpoint',
  'close',
  'advance',
  'heartbeat',
] as const;
export const artifactsActionValues = ['save', 'list'] as const;
export const adminActionValues = [
  'reconcile',
  'drain',
  'archive',
  'cleanup',
  'mem0_snapshot',
  'mem0_rollup',
] as const;

export const inspectorActionSchema = z.enum(inspectorActionValues);
export const orchestratorActionSchema = z.enum(orchestratorActionValues);
export const symphonyActionSchema = z.enum(symphonyActionValues);
export const sessionActionSchema = z.enum(sessionActionValues);
export const artifactsActionSchema = z.enum(artifactsActionValues);
export const adminActionSchema = z.enum(adminActionValues);

const projectScopeFields = {
  dbPath: optionalString,
  workspaceId: optionalString,
  projectId: optionalString,
  projectName: optionalString,
} as const;

const campaignScopeFields = {
  ...projectScopeFields,
  campaignId: optionalString,
} as const;

const harnessInspectorCapabilitiesInputSchema = z
  .object({
    action: z.literal('capabilities'),
  })
  .strict();

const harnessInspectorContextInputSchema = z
  .object({
    action: z.literal('get_context'),
    ...campaignScopeFields,
  })
  .strict();

const harnessInspectorNextActionInputSchema = z
  .object({
    action: z.literal('next_action'),
    ...projectScopeFields,
    host: nonEmptyString,
    hostCapabilities: harnessHostCapabilitiesSchema,
  })
  .strict();

const harnessInspectorExportInputSchema = z
  .object({
    action: z.literal('export'),
    ...campaignScopeFields,
    runLimit: boundedInt100.optional(),
    eventLimit: boundedInt100.optional(),
  })
  .strict();

const harnessInspectorAuditInputSchema = z
  .object({
    action: z.literal('audit'),
    dbPath: optionalString,
    issueId: nonEmptyString,
    eventLimit: boundedInt100.optional(),
  })
  .strict();

const harnessInspectorHealthSnapshotInputSchema = z
  .object({
    action: z.literal('health_snapshot'),
    ...campaignScopeFields,
  })
  .strict();

export const harnessInspectorInputSchema = z.discriminatedUnion('action', [
  harnessInspectorCapabilitiesInputSchema,
  harnessInspectorContextInputSchema,
  harnessInspectorNextActionInputSchema,
  harnessInspectorExportInputSchema,
  harnessInspectorAuditInputSchema,
  harnessInspectorHealthSnapshotInputSchema,
]);

const harnessPromoteQueueInputSchema = z
  .object({
    action: z.literal('promote_queue'),
    dbPath: optionalString,
    projectId: optionalString,
    projectName: optionalString,
    campaignId: optionalString,
  })
  .strict();

export const harnessOrchestratorInputSchema = z.discriminatedUnion('action', [
  harnessInitWorkspaceInputSchema.extend({
    action: z.literal('init_workspace'),
  }),
  harnessCreateCampaignInputSchema.extend({
    action: z.literal('create_campaign'),
  }),
  harnessPlanIssuesInputSchema.extend({
    action: z.literal('plan_issues'),
  }),
  harnessPromoteQueueInputSchema,
  harnessRollbackIssueInputSchema.extend({
    action: z.literal('rollback_issue'),
  }),
]);

const orchestrationScopeFields = {
  ...projectScopeFields,
  campaignId: optionalString,
  campaignName: optionalString,
} as const;

const orchestrationWorkflowMetadataFields = {
  deadlineAt: harnessWorkflowMetadataSchema.shape.deadlineAt,
  recipients: harnessWorkflowMetadataSchema.shape.recipients,
  approvals: harnessWorkflowMetadataSchema.shape.approvals,
  externalRefs: harnessWorkflowMetadataSchema.shape.externalRefs,
} as const;

const harnessSymphonyMilestoneInputSchema = z
  .object({
    id: nonEmptyString,
    key: optionalString,
    description: nonEmptyString,
    dependsOnMilestoneIds: z.array(nonEmptyString).optional(),
    dependsOnMilestoneKeys: z.array(nonEmptyString).optional(),
    dependsOnExistingMilestoneIds: z.array(nonEmptyString).optional(),
    ...orchestrationWorkflowMetadataFields,
  })
  .strict();

const harnessSymphonySliceInputSchema = z
  .object({
    id: nonEmptyString,
    milestoneId: nonEmptyString,
    task: nonEmptyString,
    priority: issuePrioritySchema,
    size: tShirtSizeSchema,
    dependsOnSliceIds: z.array(nonEmptyString).optional(),
    evidenceRequirements: harnessWorkflowMetadataSchema.shape.externalRefs,
    policy: harnessPolicySchema.optional(),
    ...orchestrationWorkflowMetadataFields,
  })
  .strict();

const harnessSymphonyCompilePlanInputSchema = z
  .object({
    action: z.literal('compile_plan'),
    milestones: z.array(harnessSymphonyMilestoneInputSchema).min(1),
    slices: z.array(harnessSymphonySliceInputSchema).min(1),
  })
  .strict();

const harnessSymphonyArtifactReferenceInputSchema = z
  .object({
    kind: nonEmptyString,
    path: nonEmptyString,
  })
  .strict();

const harnessSymphonyIssueRequirementInputSchema = z
  .object({
    issueId: nonEmptyString,
    requiredCapabilityIds: z.array(nonEmptyString).optional(),
    candidateFilePaths: z.array(nonEmptyString).max(500).optional(),
  })
  .strict();

const harnessSymphonyDispatchInputSchema = z
  .object({
    action: z.literal('dispatch_ready'),
    ...orchestrationScopeFields,
    repoRoot: nonEmptyString,
    worktreeRoot: nonEmptyString,
    baseRef: nonEmptyString,
    host: nonEmptyString,
    hostCapabilities: harnessHostCapabilitiesSchema,
    dispatchId: optionalString,
    objective: optionalString,
    branchPrefix: optionalString,
    cleanupPolicy: orchestrationWorktreeCleanupPolicySchema.optional(),
    maxAssignments: positiveInt.optional(),
    maxConcurrentAgents: positiveInt.optional(),
    promoteBeforeDispatch: z.boolean().optional(),
    leaseTtlSeconds: positiveInt.optional(),
    checkpointFreshnessSeconds: positiveInt.optional(),
    mem0Enabled: z.boolean().optional(),
    memorySearchLimit: positiveInt.optional(),
    artifacts: z.array(harnessSymphonyArtifactReferenceInputSchema).optional(),
    subagents: z.array(orchestrationSubagentSchema).min(1).optional(),
    issueIds: z.array(nonEmptyString).min(1).max(500).optional(),
    issueRequirements: z.array(harnessSymphonyIssueRequirementInputSchema).optional(),
  })
  .strict();

const harnessSymphonyInspectInputSchema = z
  .object({
    action: z.literal('inspect_state'),
    ...orchestrationScopeFields,
    issueId: optionalString,
    eventLimit: boundedInt100.optional(),
  })
  .strict();

const harnessSymphonyDashboardViewInputSchema = z
  .object({
    action: z.literal('dashboard_view'),
    ...orchestrationScopeFields,
    issueId: optionalString,
    eventLimit: boundedInt100.optional(),
    filters: orchestrationDashboardIssueFiltersInputSchema.optional(),
  })
  .strict();

const harnessSymphonyRunAssignmentInputSchema = z
  .object({
    action: z.literal('run_assignment'),
    dbPath: optionalString,
    input: symphonyAssignmentRunnerInputSchema,
  })
  .strict();

const harnessSymphonySupervisorTickInputSchema =
  orchestrationSupervisorTickInputSchema.safeExtend({
    action: z.literal('supervisor_tick'),
  });

const harnessSymphonySupervisorRunInputSchema =
  orchestrationSupervisorRunInputSchema.safeExtend({
    action: z.literal('supervisor_run'),
  });

export const harnessSymphonyInputSchema = z.discriminatedUnion('action', [
  harnessSymphonyCompilePlanInputSchema,
  harnessSymphonyDispatchInputSchema,
  harnessSymphonyInspectInputSchema,
  harnessSymphonyDashboardViewInputSchema,
  harnessSymphonyRunAssignmentInputSchema,
  harnessSymphonySupervisorTickInputSchema,
  harnessSymphonySupervisorRunInputSchema,
]);

const sessionTokenSchema = z.string().min(1);

const harnessSessionCheckpointInputSchema = z
  .object({
    action: z.literal('checkpoint'),
    dbPath: optionalString,
    sessionToken: sessionTokenSchema,
    input: sessionCheckpointInputSchema,
  })
  .strict();

const harnessSessionCloseInputSchema = z
  .object({
    action: z.literal('close'),
    dbPath: optionalString,
    sessionToken: sessionTokenSchema,
    closeInput: sessionCloseInputSchema,
  })
  .strict();

const harnessSessionAdvanceInputSchema = z
  .object({
    action: z.literal('advance'),
    dbPath: optionalString,
    sessionToken: sessionTokenSchema,
    closeInput: sessionCloseInputSchema,
  })
  .strict();

const harnessSessionHeartbeatInputSchema = z
  .object({
    action: z.literal('heartbeat'),
    dbPath: optionalString,
    sessionToken: sessionTokenSchema,
    leaseTtlSeconds: positiveInt.optional(),
  })
  .strict();

export const harnessSessionInputSchema = z.discriminatedUnion('action', [
  incrementalSessionInputSchema.extend({
    action: z.literal('begin'),
  }),
  recoverySessionInputSchema.extend({
    action: z.literal('begin_recovery'),
  }),
  harnessSessionCheckpointInputSchema,
  harnessSessionCloseInputSchema,
  harnessSessionAdvanceInputSchema,
  harnessSessionHeartbeatInputSchema,
]);

const artifactScopeFields = {
  dbPath: optionalString,
  projectId: optionalString,
  projectName: optionalString,
  campaignId: optionalString,
  issueId: optionalString,
} as const;

const harnessArtifactsSaveInputSchema = z
  .object({
    action: z.literal('save'),
    ...artifactScopeFields,
    kind: nonEmptyString,
    path: nonEmptyString,
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const harnessArtifactsListInputSchema = z
  .object({
    action: z.literal('list'),
    ...artifactScopeFields,
    kind: optionalString,
  })
  .strict();

export const harnessArtifactsInputSchema = z.discriminatedUnion('action', [
  harnessArtifactsSaveInputSchema,
  harnessArtifactsListInputSchema,
]);

const adminScopeFields = {
  dbPath: optionalString,
  projectId: optionalString,
  projectName: optionalString,
  workspaceId: optionalString,
  campaignId: optionalString,
  campaignName: optionalString,
} as const;

const adminMemoryKindSchema = z.enum([
  'decision',
  'preference',
  'summary',
  'artifact_context',
  'note',
]);

const harnessAdminReconcileInputSchema = z
  .object({
    action: z.literal('reconcile'),
    ...adminScopeFields,
    checkpointFreshnessSeconds: positiveInt.optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();

const harnessAdminDrainInputSchema = z
  .object({
    action: z.literal('drain'),
    ...adminScopeFields,
    dryRun: z.boolean().optional(),
  })
  .strict();

const harnessAdminArchiveInputSchema = z
  .object({
    action: z.literal('archive'),
    ...adminScopeFields,
    dryRun: z.boolean().optional(),
  })
  .strict();

const harnessAdminCleanupInputSchema = z
  .object({
    action: z.literal('cleanup'),
    ...adminScopeFields,
    retentionDays: positiveInt.optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();

const harnessAdminSnapshotInputSchema = z
  .object({
    action: z.literal('mem0_snapshot'),
    ...adminScopeFields,
    content: nonEmptyString,
    memoryKind: adminMemoryKindSchema.optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();

const harnessAdminRollupInputSchema = z
  .object({
    action: z.literal('mem0_rollup'),
    ...adminScopeFields,
    milestoneId: optionalString,
    memoryKind: adminMemoryKindSchema.optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();

export const harnessAdminInputSchema = z.discriminatedUnion('action', [
  harnessAdminReconcileInputSchema,
  harnessAdminDrainInputSchema,
  harnessAdminArchiveInputSchema,
  harnessAdminCleanupInputSchema,
  harnessAdminSnapshotInputSchema,
  harnessAdminRollupInputSchema,
]);

export const HARNESS_TOOL_CONTRACTS: HarnessToolContract[] = [
  {
    name: 'harness_inspector',
    description:
      'Read-only observation of the Harness state. Actions: capabilities (discover tools, bundled skills, mem0 status — call FIRST), get_context (workspace/project/queue status), next_action (NBA engine — tells you exactly what tool to call next, with structured blocker, lease, and policy context), export (machine-readable operational export for a project/campaign), audit (deep-dive issue audit trail), health_snapshot (operational health snapshot with alerts and breach counts).',
    role: 'Orientation, introspection, and next-best-action guidance',
    recommendedFirstCall: true,
    summary:
      'Use first in a new session, when queue state is unclear, or when the agent needs a machine-readable guide to the runtime plus auditable next_action reasons, exportable operational state, and health snapshots.',
    inputSchema: harnessInspectorInputSchema,
    actions: [
      {
        action: 'capabilities',
        purpose:
          'Discover the server tool map, bundled skills, and mem0 availability in one machine-readable response.',
        recommendedWhen: [
          'first contact with the MCP server',
          'tool discoverability',
          'skill discoverability',
          'mem0 configuration checks',
        ],
        example: {
          action: 'capabilities',
        },
      },
      {
        action: 'get_context',
        purpose:
          'Resolve workspace/project scope and see queue status before choosing an execution action.',
        recommendedWhen: ['new chat', 'project orientation', 'scope disambiguation'],
        example: {
          action: 'get_context',
          projectName: 'Agent Harness Core',
        },
      },
      {
        action: 'next_action',
        purpose:
          'Get the next recommended tool call for a specific host routing context, based on queue state, recovery needs, dispatchable work, and active policy breaches, with structured context that identifies the concrete blocker, dependency, lease, escalation, or capability mismatch behind the recommendation.',
        recommendedWhen: [
          'queue navigation',
          'recovering from idle state',
          'agentic execution loop',
          'auditing recommendation reasons',
        ],
        requiredFields: ['host', 'hostCapabilities'],
        example: {
          action: 'next_action',
          projectName: 'Agent Harness Core',
          host: 'ci-linux',
          hostCapabilities: {
            workloadClasses: ['default', 'typescript'],
            capabilities: ['node', 'sqlite'],
          },
        },
      },
      {
        action: 'export',
        purpose:
          'Export machine-readable queue, lease, run, policy, checkpoint, and recent-event state for a project or campaign.',
        recommendedWhen: [
          'operator dashboard',
          'triage',
          'machine-readable exports',
          'production observability',
        ],
        requiredFields: ['projectId or projectName'],
        example: {
          action: 'export',
          projectName: 'Agent Harness Core',
          runLimit: 10,
          eventLimit: 20,
        },
      },
      {
        action: 'audit',
        purpose:
          'Inspect the structured audit trail for one issue, including lifecycle evidence, normalized timeline entries, and effective policy state.',
        recommendedWhen: [
          'debugging a stuck task',
          'handoff review',
          'recovery preparation',
          'event-trail reconstruction',
        ],
        requiredFields: ['issueId'],
        example: {
          action: 'audit',
          issueId: 'I-123',
          eventLimit: 50,
        },
      },
      {
        action: 'health_snapshot',
        purpose:
          'Inspect machine-readable operational health, including alerts, queue counts, stale leases, session activity, and aggregated policy breach metrics.',
        recommendedWhen: [
          'operational health checks',
          'before starting long sessions',
          'lease troubleshooting',
          'production snapshots',
        ],
        requiredFields: ['projectId or projectName'],
        example: {
          action: 'health_snapshot',
          projectName: 'Agent Harness Core',
        },
      },
    ],
  },
  {
    name: 'harness_orchestrator',
    description:
      'Setup, configuration, and queue management. Actions: init_workspace (create DB and workspace), create_campaign (register project + campaign — idempotent), plan_issues (inject a canonical milestone batch into the queue), promote_queue (unlock tasks whose issue and milestone deps are done), rollback_issue (emergency reset of stuck issue to pending).',
    role: 'Workspace bootstrap, campaign setup, and queue promotion',
    summary:
      'Use to create scope, inject planned work, promote dependencies, and reset stuck issues.',
    inputSchema: harnessOrchestratorInputSchema,
    actions: [
      {
        action: 'init_workspace',
        purpose: 'Create the harness database and register the workspace root.',
        recommendedWhen: ['initial setup'],
        requiredFields: ['workspaceName'],
        example: {
          action: 'init_workspace',
          workspaceName: 'default',
        },
      },
      {
        action: 'create_campaign',
        purpose: 'Register or reuse the project and campaign for a new objective.',
        recommendedWhen: ['project bootstrap', 'new milestone kickoff'],
        requiredFields: ['projectName', 'campaignName', 'objective'],
        example: {
          action: 'create_campaign',
          workspaceId: 'W-123',
          projectName: 'Agent Harness Core',
          campaignName: 'Runtime hardening',
          objective: 'Improve runtime discoverability and memory handling.',
          policy: {
            owner: 'platform-ops',
            serviceLevel: {
              responseWithinMinutes: 60,
            },
          },
        },
      },
      {
        action: 'plan_issues',
        purpose: 'Create a canonical milestone batch with issue dependencies and milestone gating.',
        recommendedWhen: ['breaking down work', 'queue planning'],
        requiredFields: ['milestones'],
        example: {
          action: 'plan_issues',
          projectName: 'Agent Harness Core',
          campaignName: 'Runtime hardening',
          milestones: [
            {
              milestone_key: 'runtime-foundations',
              description: 'Agentic-first runtime improvements',
              issues: [
                {
                  task: 'Add capability introspection',
                  priority: 'high',
                  size: 'M',
                  deadlineAt: '2026-04-10T12:00:00.000Z',
                  recipients: [
                    {
                      id: 'platform-ops',
                      kind: 'team',
                      label: 'Platform Ops',
                      role: 'approver',
                    },
                  ],
                  approvals: [
                    {
                      id: 'release-signoff',
                      label: 'Release sign-off',
                      recipientIds: ['platform-ops'],
                      state: 'pending',
                    },
                  ],
                  externalRefs: [
                    {
                      id: 'runbook-capability-rollout',
                      kind: 'runbook',
                      value: 'ops://runbooks/capability-rollout',
                      label: 'Capability rollout runbook',
                    },
                  ],
                  policy: {
                    escalationRules: [
                      {
                        trigger: 'deadline_breached',
                        action: 'raise_priority',
                        priority: 'critical',
                      },
                    ],
                  },
                },
              ],
            },
            {
              milestone_key: 'runtime-polish',
              description: 'Follow-up polish',
              depends_on_milestone_keys: ['runtime-foundations'],
              issues: [
                {
                  task: 'Tighten tool discoverability prompts',
                  priority: 'medium',
                  size: 'S',
                },
              ],
            },
          ],
        },
      },
      {
        action: 'promote_queue',
        purpose: 'Unlock ready work after dependencies complete.',
        recommendedWhen: ['before begin', 'after done issues'],
        requiredFields: ['projectId or projectName'],
        example: {
          action: 'promote_queue',
          projectName: 'Agent Harness Core',
        },
      },
      {
        action: 'rollback_issue',
        purpose: 'Reset an issue to pending when explicit rollback is required.',
        recommendedWhen: ['failed recovery', 'manual reset'],
        requiredFields: ['issueId'],
        example: {
          action: 'rollback_issue',
          issueId: 'I-123',
        },
      },
    ],
  },
  {
    name: 'harness_symphony',
    description:
      'Fully agentic Symphony-style orchestration. Actions: compile_plan (turn orchestration milestones/slices into canonical plan_issues payloads), dispatch_ready (fan out ready issues across isolated worktrees and compatible subagents), inspect_state (read raw orchestration assignments, leases, artifacts, events, and evidence health), dashboard_view (read a filtered Linear-like dashboard view model), run_assignment (execute one dispatched assignment and persist command-produced evidence), supervisor_tick (run one autonomous supervisor tick), supervisor_run (run bounded autonomous supervisor polling).',
    role: 'Agentic fan-out planning, dispatch, supervisor polling, orchestration-state inspection, and dashboard read-model access',
    summary:
      'Use for fully agentic multi-issue execution after project planning exists: compile orchestration slices, dispatch ready issues into isolated worktrees, execute dispatched assignments with test/E2E/CSQR evidence, inspect evidence-backed orchestration state, retrieve filtered dashboard views for agent navigation, and run bounded supervisor automation.',
    inputSchema: harnessSymphonyInputSchema,
    actions: [
      {
        action: 'compile_plan',
        purpose:
          'Compile Symphony-style milestones and slices into the canonical harness_orchestrator(action: "plan_issues") milestones payload without mutating runtime state.',
        recommendedWhen: [
          'tracker-driven planning',
          'converting orchestration slices',
          'preparing a deterministic plan_issues payload',
        ],
        requiredFields: ['milestones', 'slices'],
        example: {
          action: 'compile_plan',
          milestones: [
            {
              id: 'm-foundation',
              key: 'foundation',
              description: 'Build the orchestration foundation',
            },
          ],
          slices: [
            {
              id: 'slice-dispatcher',
              milestoneId: 'm-foundation',
              task: 'Implement the MCP dispatch surface',
              priority: 'high',
              size: 'M',
              evidenceRequirements: [
                {
                  id: 'dispatch-e2e',
                  kind: 'e2e_report',
                  value: 'evidence://dispatch-ready',
                  label: 'Dispatch E2E evidence',
                },
              ],
            },
          ],
        },
      },
      {
        action: 'dispatch_ready',
        purpose:
          'Claim ready issues with one compatible subagent and one isolated worktree per issue, enforcing dispatch limits, worktree conflict guardrails, and lease capacity.',
        recommendedWhen: [
          'fully agentic execution',
          'parallel ready issue fan-out',
          'worktree-isolated implementation',
        ],
        requiredFields: [
          'projectId or projectName',
          'repoRoot',
          'worktreeRoot',
          'baseRef',
          'host',
          'hostCapabilities',
        ],
        example: {
          action: 'dispatch_ready',
          projectName: 'Agent Harness Core',
          repoRoot: '/repo/harness-os',
          worktreeRoot: '/repo/worktrees',
          baseRef: 'main',
          host: 'copilot',
          hostCapabilities: {
            workloadClasses: ['default', 'typescript'],
            capabilities: ['node', 'sqlite'],
          },
          maxConcurrentAgents: 4,
          maxAssignments: 4,
          cleanupPolicy: 'delete_on_completion',
        },
      },
      {
        action: 'inspect_state',
        purpose:
          'Read the orchestration state for a project, campaign, or issue, including active leases, worktree/evidence artifacts, recent events, and health flags.',
        recommendedWhen: [
          'orchestration observability',
          'evidence review',
          'dashboard data',
          'post-dispatch inspection',
        ],
        requiredFields: ['projectId or projectName'],
        example: {
          action: 'inspect_state',
          projectName: 'Agent Harness Core',
          eventLimit: 25,
        },
      },
      {
        action: 'dashboard_view',
        purpose:
          'Read the stable orchestration dashboard view model with optional issue/evidence filters for agent navigation, UI rendering, or proof review without mutating runtime state.',
        recommendedWhen: [
          'filtered dashboard data',
          'agent navigation',
          'evidence review',
          'operator UI rendering',
        ],
        requiredFields: ['projectId or projectName'],
        example: {
          action: 'dashboard_view',
          projectName: 'Agent Harness Core',
          eventLimit: 25,
          filters: {
            status: ['ready'],
            priority: ['high'],
            signal: 'evidence',
          },
        },
      },
      {
        action: 'run_assignment',
        purpose:
          'Execute one dispatched assignment in its isolated worktree and close its session with command-produced test, E2E, and CSQR-lite evidence.',
        recommendedWhen: [
          'assignment execution',
          'proof-producing worker runs',
          'host-controlled evidence gates',
        ],
        requiredFields: ['input'],
        example: {
          action: 'run_assignment',
          input: {
            contractVersion: '1.0.0',
            assignment: {
              id: 'assignment-M10-I5',
              issueId: 'M10-I5',
              subagentId: 'subagent-implementation',
              worktreeId: 'worktree-M10-I5',
            },
            issue: {
              id: 'M10-I5',
              task: 'Add assignment execution surface',
              priority: 'high',
              status: 'ready',
            },
            subagent: {
              id: 'subagent-implementation',
              role: 'implementation',
              modelProfile: 'gpt-5-high',
              model: 'gpt-5-high',
              host: 'copilot',
              capabilities: ['node', 'sqlite'],
            },
            worktree: {
              id: 'worktree-M10-I5',
              repoRoot: '/repo/harness-os',
              root: '/repo/worktrees',
              path: '/repo/worktrees/M10-I5',
              branch: 'feat/M10-I5-assignment-runner',
              baseRef: 'main',
              cleanupPolicy: 'retain',
              containment: {
                expectedParentPath: '/repo/worktrees',
                requirePathWithinRoot: true,
              },
            },
            session: {
              sessionId: 'session-M10-I5',
              dbPath: '/repo/.harness/harness.sqlite',
              workspaceId: 'workspace-1',
              projectId: 'project-1',
              agentId: 'subagent-implementation',
              host: 'copilot',
              hostCapabilities: {
                workloadClasses: ['default', 'typescript'],
                capabilities: ['node', 'sqlite'],
              },
              runId: 'session-M10-I5',
              leaseId: 'lease-M10-I5',
              leaseExpiresAt: '2030-01-01T00:00:00.000Z',
              issueId: 'M10-I5',
              issueTask: 'Add assignment execution surface',
              claimMode: 'claim',
              artifacts: [],
              scope: {
                workspace: 'workspace-1',
                project: 'project-1',
                task: 'M10-I5',
                run: 'session-M10-I5',
              },
              currentTaskStatus: 'in_progress',
              currentCheckpointId: 'checkpoint-M10-I5',
              mem0: {
                enabled: false,
                available: false,
                query: 'M10-I5',
                recalledMemories: [],
              },
            },
            runner: {
              command: 'npm',
              args: ['run', 'verify:release'],
              requiredEvidenceArtifactKinds: ['test_report', 'e2e_report'],
            },
          },
        },
      },
      {
        action: 'supervisor_tick',
        purpose:
          'Run one autonomous supervisor tick through the MCP surface, returning the same auditable decision trace as the public runtime API.',
        recommendedWhen: [
          'supervisor automation',
          'dry-run queue audits',
          'single-step autonomous orchestration',
        ],
        requiredFields: [
          'contractVersion',
          'tickId',
          'dbPath',
          'projectId or projectName',
        ],
        example: {
          action: 'supervisor_tick',
          contractVersion: '1.0.0',
          tickId: 'supervisor-tick-1',
          dbPath: '/repo/.harness/harness.sqlite',
          projectName: 'Agent Harness Core',
          mode: 'dry_run',
          stopCondition: {
            stopWhenIdle: true,
          },
        },
      },
      {
        action: 'supervisor_run',
        purpose:
          'Run bounded autonomous supervisor polling with max tick limits, stop conditions, backoff, and structured JSON results.',
        recommendedWhen: [
          'fully autonomous polling',
          'no-human runtime operation',
          'evidence-gated dispatch loops',
        ],
        requiredFields: [
          'contractVersion',
          'runId',
          'dbPath',
          'projectId or projectName',
        ],
        example: {
          action: 'supervisor_run',
          contractVersion: '1.0.0',
          runId: 'supervisor-run-1',
          dbPath: '/repo/.harness/harness.sqlite',
          workspaceId: 'workspace-1',
          projectId: 'project-1',
          mode: 'execute',
          stopCondition: {
            maxTicks: 4,
            stopWhenIdle: true,
            stopWhenBlocked: true,
          },
          dispatch: {
            repoRoot: '/repo/harness-os',
            worktreeRoot: '/repo/worktrees',
            baseRef: 'main',
            host: 'copilot',
            hostCapabilities: {
              workloadClasses: ['default', 'typescript'],
              capabilities: ['node', 'sqlite'],
            },
            maxConcurrentAgents: 4,
          },
        },
      },
    ],
  },
  {
    name: 'harness_session',
    description:
      'Execution lifecycle for worker agents. Actions: begin (claim the next task dispatchable to the provided host routing context — returns sessionToken), begin_recovery (claim a needs_recovery task for the provided host routing context), checkpoint (save progress — pass sessionToken), close (mark task done/failed — pass sessionToken), advance (atomic close + begin next — pass sessionToken, preferred over close + begin), heartbeat (renew lease TTL for long-running tasks — pass sessionToken).',
    role: 'Task execution lifecycle with leases, checkpoints, and recovery',
    summary:
      'Use for claim/resume, checkpointing, close/advance, and lease heartbeat during execution.',
    inputSchema: harnessSessionInputSchema,
    actions: [
      {
        action: 'begin',
        purpose: 'Claim or resume the next issue dispatchable to the provided host routing context.',
        recommendedWhen: ['start working', 'resume active work'],
        requiredFields: [
          'workspaceId',
          'projectId',
          'artifacts',
          'mem0Enabled',
          'host',
          'hostCapabilities',
        ],
        example: {
          action: 'begin',
          workspaceId: 'W-123',
          projectId: 'P-123',
          artifacts: [
            {
              kind: 'session_handoff',
              path: '/workspace/progress.md',
            },
            {
              kind: 'task_catalog',
              path: '/workspace/feature_list.json',
            },
            {
              kind: 'execution_plan',
              path: '/workspace/plan.md',
            },
            {
              kind: 'sync_manifest',
              path: '/workspace/sync.json',
            },
          ],
          mem0Enabled: true,
          host: 'ci-linux',
          hostCapabilities: {
            workloadClasses: ['default', 'typescript'],
            capabilities: ['node', 'sqlite'],
          },
        },
      },
      {
        action: 'begin_recovery',
        purpose: 'Claim a needs_recovery issue explicitly for the provided host routing context.',
        recommendedWhen: ['recovery workflow'],
        requiredFields: [
          'workspaceId',
          'projectId',
          'artifacts',
          'mem0Enabled',
          'host',
          'hostCapabilities',
          'recoverySummary',
        ],
        example: {
          action: 'begin_recovery',
          workspaceId: 'W-123',
          projectId: 'P-123',
          artifacts: [
            {
              kind: 'session_handoff',
              path: '/workspace/progress.md',
            },
            {
              kind: 'task_catalog',
              path: '/workspace/feature_list.json',
            },
            {
              kind: 'execution_plan',
              path: '/workspace/plan.md',
            },
            {
              kind: 'sync_manifest',
              path: '/workspace/sync.json',
            },
          ],
          mem0Enabled: true,
          host: 'ci-linux',
          hostCapabilities: {
            workloadClasses: ['default', 'typescript'],
            capabilities: ['node', 'sqlite'],
          },
          preferredIssueId: 'I-123',
          recoverySummary: 'Recover stale lease and continue safely.',
        },
      },
      {
        action: 'checkpoint',
        purpose: 'Persist progress while keeping the lease active.',
        recommendedWhen: ['long-running tasks', 'handoff checkpoints'],
        requiredFields: ['sessionToken', 'input'],
        example: {
          action: 'checkpoint',
          sessionToken: 'ST-abc123',
          input: {
            title: 'implementation-progress',
            summary: 'Completed capability catalog wiring.',
            taskStatus: 'in_progress',
            nextStep: 'Add MCP inspector coverage.',
          },
        },
      },
      {
        action: 'close',
        purpose: 'Close the current task and optionally promote dependents.',
        recommendedWhen: ['task complete', 'task failed'],
        requiredFields: ['sessionToken', 'closeInput'],
        example: {
          action: 'close',
          sessionToken: 'ST-abc123',
          closeInput: {
            title: 'done',
            summary: 'Capability introspection shipped.',
            taskStatus: 'done',
            nextStep: 'Claim next ready task.',
          },
        },
      },
      {
        action: 'advance',
        purpose: 'Atomically close the current task and claim the next ready one.',
        recommendedWhen: ['continuous execution loops'],
        requiredFields: ['sessionToken', 'closeInput'],
        example: {
          action: 'advance',
          sessionToken: 'ST-abc123',
          closeInput: {
            title: 'done',
            summary: 'Capability introspection shipped.',
            taskStatus: 'done',
            nextStep: 'Continue with next queued task.',
          },
        },
      },
      {
        action: 'heartbeat',
        purpose: 'Extend the active lease for long-running work.',
        recommendedWhen: ['long tasks', 'waiting on external systems'],
        requiredFields: ['sessionToken'],
        example: {
          action: 'heartbeat',
          sessionToken: 'ST-abc123',
          leaseTtlSeconds: 3600,
        },
      },
    ],
  },
  {
    name: 'harness_artifacts',
    description:
      'Persistent state registry for files like browser cookies, screenshots, or design documents. Actions: save (register a file path to the Harness DB), list (find artifacts by project/issue/kind).',
    role: 'Persistent artifact registry for external files and evidence',
    summary:
      'Use to persist references to screenshots, browser state, generated files, or other task evidence.',
    inputSchema: harnessArtifactsInputSchema,
    actions: [
      {
        action: 'save',
        purpose: 'Register an artifact path against the project or issue.',
        recommendedWhen: ['checkpoint evidence', 'handoff assets'],
        requiredFields: ['projectId or projectName', 'kind', 'path'],
        example: {
          action: 'save',
          projectName: 'Agent Harness Core',
          issueId: 'I-123',
          kind: 'screenshot',
          path: '/tmp/capabilities.png',
        },
      },
      {
        action: 'list',
        purpose: 'Find stored artifacts filtered by project, campaign, issue, or kind.',
        recommendedWhen: ['recovery', 'debugging', 'handoff'],
        requiredFields: ['projectId or projectName'],
        example: {
          action: 'list',
          projectName: 'Agent Harness Core',
          issueId: 'I-123',
        },
      },
    ],
  },
  {
    name: 'harness_admin',
    description:
      'Maintenance and administration. Actions: reconcile (force reconciliation of stale leases), drain (pause new claims for a campaign), archive (close all done issues and release leases for a campaign), cleanup (delete expired sessions, old events, and released leases older than retention days), mem0_snapshot (persist a project/milestone summary to mem0), mem0_rollup (compact detailed task memories into a higher-level summary).',
    role: 'Operational maintenance, cleanup, and mem0 compaction',
    summary:
      'Use for recovery-oriented maintenance, retention cleanup, and project-level memory snapshots or rollups.',
    inputSchema: harnessAdminInputSchema,
    actions: [
      {
        action: 'reconcile',
        purpose: 'Mark stale lease/checkpoint situations as explicit recovery blockers.',
        recommendedWhen: ['before new claims after crashes', 'lease drift checks'],
        requiredFields: ['projectId or projectName'],
        example: {
          action: 'reconcile',
          projectName: 'Agent Harness Core',
          checkpointFreshnessSeconds: 3600,
        },
      },
      {
        action: 'drain',
        purpose: 'Pause a campaign and block pending/ready work.',
        recommendedWhen: ['maintenance windows', 'freeze queues'],
        requiredFields: ['projectId or projectName', 'campaignId or campaignName'],
        example: {
          action: 'drain',
          projectName: 'Agent Harness Core',
          campaignName: 'Runtime hardening',
          dryRun: true,
        },
      },
      {
        action: 'archive',
        purpose: 'Archive a finished campaign and release active leases.',
        recommendedWhen: ['campaign closeout'],
        requiredFields: ['projectId or projectName', 'campaignId or campaignName'],
        example: {
          action: 'archive',
          projectName: 'Agent Harness Core',
          campaignName: 'Runtime hardening',
        },
      },
      {
        action: 'cleanup',
        purpose: 'Delete closed sessions, old events, and released leases past the retention window.',
        recommendedWhen: ['periodic maintenance'],
        requiredFields: ['projectId or projectName'],
        example: {
          action: 'cleanup',
          projectName: 'Agent Harness Core',
          retentionDays: 30,
        },
      },
      {
        action: 'mem0_snapshot',
        purpose: 'Persist a project-level summary to mem0 using canonical Harness scope identifiers.',
        recommendedWhen: ['milestone snapshots', 'cross-session memory compression'],
        requiredFields: ['projectId or projectName', 'content'],
        example: {
          action: 'mem0_snapshot',
          projectName: 'Agent Harness Core',
          content: 'Approved direction: improve agentic-first discoverability.',
        },
      },
      {
        action: 'mem0_rollup',
        purpose: 'Roll up task-level linked memories into a single summary memory.',
        recommendedWhen: ['milestone closeout', 'context compaction'],
        requiredFields: ['projectId or projectName'],
        example: {
          action: 'mem0_rollup',
          projectName: 'Agent Harness Core',
          milestoneId: 'M-123',
        },
      },
    ],
  },
];

const HARNESS_TOOL_CONTRACT_MAP = new Map(
  HARNESS_TOOL_CONTRACTS.map((contract) => [contract.name, contract] as const),
);

export function getHarnessToolContracts(): HarnessToolContract[] {
  return HARNESS_TOOL_CONTRACTS;
}

export function getHarnessToolContract(name: string): HarnessToolContract {
  const contract = HARNESS_TOOL_CONTRACT_MAP.get(name);

  if (!contract) {
    throw new Error(`Unknown harness tool contract: ${name}`);
  }

  return contract;
}

type JsonSchemaRecord = Record<string, unknown>;

function isJsonSchemaRecord(value: unknown): value is JsonSchemaRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getJsonSchemaRecordArray(value: unknown): JsonSchemaRecord[] | null {
  if (!Array.isArray(value) || value.some((entry) => !isJsonSchemaRecord(entry))) {
    return null;
  }

  return value;
}

function getRequiredFieldNames(schema: JsonSchemaRecord): string[] {
  const { required } = schema;
  return Array.isArray(required)
    ? required.filter((field): field is string => typeof field === 'string')
    : [];
}

function dedupeJsonSchemas(schemas: JsonSchemaRecord[]): JsonSchemaRecord[] {
  const seen = new Set<string>();
  const deduped: JsonSchemaRecord[] = [];

  for (const schema of schemas) {
    const fingerprint = JSON.stringify(schema);

    if (seen.has(fingerprint)) {
      continue;
    }

    seen.add(fingerprint);
    deduped.push(schema);
  }

  return deduped;
}

function mergeJsonSchemaProperty(
  current: JsonSchemaRecord | undefined,
  next: JsonSchemaRecord,
): JsonSchemaRecord {
  if (!current) {
    return { ...next };
  }

  if (JSON.stringify(current) === JSON.stringify(next)) {
    return current;
  }

  const currentAnyOf = getJsonSchemaRecordArray(current.anyOf) ?? [current];
  const nextAnyOf = getJsonSchemaRecordArray(next.anyOf) ?? [next];
  const mergedAnyOf = dedupeJsonSchemas([...currentAnyOf, ...nextAnyOf]);

  return mergedAnyOf.length === 1 ? mergedAnyOf[0]! : { anyOf: mergedAnyOf };
}

function normalizeActionPropertySchema(
  current: JsonSchemaRecord | undefined,
  actionValues: string[],
): JsonSchemaRecord {
  const dedupedActions = [...new Set(actionValues)];

  if (dedupedActions.length === 0) {
    return current ? { ...current } : { type: 'string' };
  }

  if (!current) {
    return {
      type: 'string',
      enum: dedupedActions,
    };
  }

  const {
    const: _ignoredConst,
    enum: _ignoredEnum,
    anyOf: _ignoredAnyOf,
    oneOf: _ignoredOneOf,
    ...rest
  } = current;

  return {
    ...rest,
    type: 'string',
    enum: dedupedActions,
  };
}

function normalizeDiscriminatedObjectInputSchema(
  schema: JsonSchemaRecord,
): JsonSchemaRecord {
  if (schema.type === 'object') {
    return schema;
  }

  const objectVariants =
    getJsonSchemaRecordArray(schema.oneOf) ?? getJsonSchemaRecordArray(schema.anyOf);

  if (!objectVariants || objectVariants.some((variant) => variant.type !== 'object')) {
    return schema;
  }

  const mergedProperties: JsonSchemaRecord = {};
  let sharedRequiredFields: Set<string> | null = null;
  let allVariantsDisallowExtras = true;
  const actionValues: string[] = [];

  for (const variant of objectVariants) {
    const properties = isJsonSchemaRecord(variant.properties) ? variant.properties : {};

    for (const [propertyName, propertySchema] of Object.entries(properties)) {
      if (!isJsonSchemaRecord(propertySchema)) {
        continue;
      }

      if (propertyName === 'action' && typeof propertySchema.const === 'string') {
        actionValues.push(propertySchema.const);
      }

      mergedProperties[propertyName] = mergeJsonSchemaProperty(
        isJsonSchemaRecord(mergedProperties[propertyName])
          ? (mergedProperties[propertyName] as JsonSchemaRecord)
          : undefined,
        propertySchema,
      );
    }

    const requiredFields = new Set<string>(getRequiredFieldNames(variant));
    if (sharedRequiredFields === null) {
      sharedRequiredFields = requiredFields;
    } else {
      const nextSharedRequiredFields = new Set<string>();

      for (const field of sharedRequiredFields) {
        if (requiredFields.has(field)) {
          nextSharedRequiredFields.add(field);
        }
      }

      sharedRequiredFields = nextSharedRequiredFields;
    }

    if (variant.additionalProperties !== false) {
      allVariantsDisallowExtras = false;
    }
  }

  mergedProperties.action = normalizeActionPropertySchema(
    isJsonSchemaRecord(mergedProperties.action)
      ? (mergedProperties.action as JsonSchemaRecord)
      : undefined,
    actionValues,
  );

  const {
    oneOf: _ignoredOneOf,
    anyOf: _ignoredAnyOf,
    allOf: _ignoredAllOf,
    enum: _ignoredEnum,
    not: _ignoredNot,
    ...rootSchema
  } = schema;

  return {
    ...rootSchema,
    type: 'object',
    properties: mergedProperties,
    required: sharedRequiredFields ? [...sharedRequiredFields] : [],
    additionalProperties: allVariantsDisallowExtras
      ? false
      : schema.additionalProperties,
  };
}

export function getHarnessToolInputJsonSchema(
  name: string,
): Record<string, unknown> {
  const schema = z.toJSONSchema(getHarnessToolContract(name).inputSchema, {
    io: 'input',
    unrepresentable: 'any',
  }) as JsonSchemaRecord;

  return normalizeDiscriminatedObjectInputSchema(schema);
}

export interface SessionLifecycleCliExampleContract {
  fileName: string;
  description: string;
  command: Record<string, unknown>;
}

const sampleSessionArtifacts = [
  {
    kind: 'session_handoff',
    path: '/absolute/path/to/progress.md',
  },
  {
    kind: 'task_catalog',
    path: '/absolute/path/to/feature-list.json',
  },
  {
    kind: 'execution_plan',
    path: '/absolute/path/to/plan.md',
  },
  {
    kind: 'sync_manifest',
    path: '/absolute/path/to/SYNC_MANIFEST.yaml',
  },
] as const;

const sampleBeginInput = {
  dbPath: '/absolute/path/to/harness.sqlite',
  workspaceId: 'workspace-1',
  projectId: 'project-1',
  artifacts: sampleSessionArtifacts,
  mem0Enabled: true,
  agentId: 'copilot-cli',
  host: 'local-host',
  hostCapabilities: {
    workloadClasses: ['default', 'typescript'],
    capabilities: ['node', 'sqlite'],
  },
} as const;

const sampleSessionContext = {
  sessionId: 'session-001',
  dbPath: '/absolute/path/to/harness.sqlite',
  workspaceId: 'workspace-1',
  projectId: 'project-1',
  agentId: 'copilot-cli',
  host: 'local-host',
  hostCapabilities: {
    workloadClasses: ['default', 'typescript'],
    capabilities: ['node', 'sqlite'],
  },
  runId: 'session-001',
  leaseId: 'lease-001',
  leaseExpiresAt: '2026-03-21T00:30:00.000Z',
  issueId: 'issue-1',
  issueTask: 'Stabilize lifecycle runtime',
  claimMode: 'claim',
  artifacts: sampleSessionArtifacts,
  scope: {
    workspace: 'workspace-1',
    project: 'project-1',
    task: 'issue-1',
    run: 'session-001',
  },
  currentTaskStatus: 'in_progress',
  currentCheckpointId: '00000000-0000-0000-0000-000000000001',
  mem0: {
    enabled: true,
    available: true,
    query: 'Stabilize lifecycle runtime',
    recalledMemories: [],
  },
} as const;

export const SESSION_LIFECYCLE_CLI_EXAMPLES: SessionLifecycleCliExampleContract[] = [
  {
    fileName: 'begin-incremental.json',
    description: 'Claim or resume the next ready issue from the standard CLI.',
    command: {
      contractVersion: SESSION_LIFECYCLE_CLI_CONTRACT_VERSION,
      action: 'begin_incremental',
      input: {
        ...sampleBeginInput,
        preferredIssueId: 'issue-1',
        checkpointFreshnessSeconds: 1800,
      },
    },
  },
  {
    fileName: 'begin-recovery.json',
    description: 'Recover a stale task by superseding the old lease with a recovery session.',
    command: {
      contractVersion: SESSION_LIFECYCLE_CLI_CONTRACT_VERSION,
      action: 'begin_recovery',
      input: {
        ...sampleBeginInput,
        preferredIssueId: 'issue-needs-recovery',
        recoverySummary:
          'Recover the stale task by superseding the stale lease and reopening the task under a fresh recovery lease.',
        recoveryNextStep: 'Continue execution under the new recovery lease.',
      },
    },
  },
  {
    fileName: 'checkpoint.json',
    description: 'Persist incremental progress and optional artifacts during an active session.',
    command: {
      contractVersion: SESSION_LIFECYCLE_CLI_CONTRACT_VERSION,
      action: 'checkpoint',
      context: sampleSessionContext,
      input: {
        title: 'checkpoint',
        summary: 'Recorded incremental progress on the current task.',
        taskStatus: 'in_progress',
        nextStep: 'Continue implementation and write a final close checkpoint when finished.',
        artifactIds: ['artifact-001'],
        persistToMem0: false,
      },
    },
  },
  {
    fileName: 'close.json',
    description: 'Close the current task after the final validation gate.',
    command: {
      contractVersion: SESSION_LIFECYCLE_CLI_CONTRACT_VERSION,
      action: 'close',
      context: sampleSessionContext,
      input: {
        title: 'close',
        summary: 'Closed the task after the final validation gate.',
        taskStatus: 'done',
        nextStep: 'Pick the next ready task.',
        artifactIds: ['artifact-002'],
      },
    },
  },
  {
    fileName: 'inspect-export.json',
    description: 'Export machine-readable queue, lease, run, policy, checkpoint, and recent-event state for a project.',
    command: {
      contractVersion: SESSION_LIFECYCLE_CLI_CONTRACT_VERSION,
      action: 'inspect_export',
      input: {
        dbPath: '/absolute/path/to/harness.sqlite',
        projectId: 'project-1',
        runLimit: 10,
        eventLimit: 20,
      },
    },
  },
  {
    fileName: 'inspect-audit.json',
    description: 'Inspect the structured audit trail for one specific issue.',
    command: {
      contractVersion: SESSION_LIFECYCLE_CLI_CONTRACT_VERSION,
      action: 'inspect_audit',
      input: {
        dbPath: '/absolute/path/to/harness.sqlite',
        issueId: 'issue-1',
        eventLimit: 50,
      },
    },
  },
  {
    fileName: 'inspect-health-snapshot.json',
    description: 'Capture a machine-readable operational health snapshot for a project.',
    command: {
      contractVersion: SESSION_LIFECYCLE_CLI_CONTRACT_VERSION,
      action: 'inspect_health_snapshot',
      input: {
        dbPath: '/absolute/path/to/harness.sqlite',
        projectId: 'project-1',
      },
    },
  },
  {
    fileName: 'promote-queue.json',
    description: 'Promote pending work whose dependencies are now satisfied.',
    command: {
      contractVersion: SESSION_LIFECYCLE_CLI_CONTRACT_VERSION,
      action: 'promote_queue',
      input: {
        dbPath: '/absolute/path/to/harness.sqlite',
        projectId: 'project-1',
      },
    },
  },
];

export const README_PUBLIC_CONTRACTS_START = '<!-- GENERATED:PUBLIC-CONTRACTS:START -->';
export const README_PUBLIC_CONTRACTS_END = '<!-- GENERATED:PUBLIC-CONTRACTS:END -->';
export const README_PLAN_ISSUES_START = '<!-- GENERATED:PLAN-ISSUES-EXAMPLE:START -->';
export const README_PLAN_ISSUES_END = '<!-- GENERATED:PLAN-ISSUES-EXAMPLE:END -->';
export const GETTING_STARTED_EXAMPLES_START = '<!-- GENERATED:GETTING-STARTED-EXAMPLES:START -->';
export const GETTING_STARTED_EXAMPLES_END = '<!-- GENERATED:GETTING-STARTED-EXAMPLES:END -->';

export function getSessionLifecycleCliExamples(): SessionLifecycleCliExampleContract[] {
  return SESSION_LIFECYCLE_CLI_EXAMPLES;
}

export function renderSessionLifecycleCliExample(
  example: SessionLifecycleCliExampleContract,
): string {
  return `${JSON.stringify(example.command, null, 2)}\n`;
}

export function renderReadmePublicContractsSection(): string {
  const cliExamplesTable = renderMarkdownTable(
    ['File', 'CLI action', 'Purpose'],
    SESSION_LIFECYCLE_CLI_EXAMPLES.map((example) => [
      `[\`${example.fileName}\`](examples/session-lifecycle/${example.fileName})`,
      `\`${String(example.command['action'])}\``,
      example.description,
    ]),
  );
  const toolTable = renderMarkdownTable(
    ['Tool', 'Summary', 'Actions'],
    HARNESS_TOOL_CONTRACTS.map((contract) => [
      `\`${contract.name}\``,
      contract.summary,
      contract.actions.map((action) => `\`${action.action}\``).join(', '),
    ]),
  );

  return [
    '### Generated public contract reference',
    '',
    '#### Session lifecycle CLI payloads',
    '',
    `Every payload must declare \`"contractVersion": "${SESSION_LIFECYCLE_CLI_CONTRACT_VERSION}"\`.`,
    '',
    cliExamplesTable,
    '',
    '#### Harness MCP tools',
    toolTable,
  ].join('\n');
}

export function renderReadmePlanIssuesExample(): string {
  const planIssuesAction = getHarnessToolContract('harness_orchestrator').actions.find(
    (action) => action.action === 'plan_issues',
  );

  if (!planIssuesAction) {
    throw new Error('Missing plan_issues example in harness_orchestrator contract.');
  }

  return [
    '```json',
    JSON.stringify(planIssuesAction.example, null, 2),
    '```',
  ].join('\n');
}

export function renderGettingStartedExamplesSection(): string {
  return [
    'Generated from the canonical public contract model:',
    '',
    renderMarkdownTable(
      ['File', 'CLI action', 'Purpose'],
      SESSION_LIFECYCLE_CLI_EXAMPLES.map((example) => [
        `[\`${example.fileName}\`](../examples/session-lifecycle/${example.fileName})`,
        `\`${String(example.command['action'])}\``,
        example.description,
      ]),
    ),
    '',
    `Every session-lifecycle payload must declare \`"contractVersion": "${SESSION_LIFECYCLE_CLI_CONTRACT_VERSION}"\`.`,
    '',
    'Run any example with `npm run session:lifecycle < examples/session-lifecycle/<file>`.',
  ].join('\n');
}

function renderMarkdownTable(
  headers: string[],
  rows: string[][],
): string {
  const headerRow = `| ${headers.map(escapeMarkdownCell).join(' | ')} |`;
  const separatorRow = `| ${headers.map(() => '---').join(' | ')} |`;
  const bodyRows = rows.map(
    (row) => `| ${row.map(escapeMarkdownCell).join(' | ')} |`,
  );

  return [headerRow, separatorRow, ...bodyRows].join('\n');
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
