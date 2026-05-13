import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  BundledWorkloadProfile,
  WorkloadProfileId,
} from '../contracts/workload-profiles.js';
import { orchestrationEvidenceArtifactKindValues } from '../contracts/orchestration-contracts.js';
import { symphonyCodexRunnerErrorCodeValues } from '../contracts/symphony-codex-runner-contracts.js';
import {
  defaultSkillPolicies,
  type SkillFamilyPolicy,
} from '../policy/skill-policy-registry.js';
import {
  getBundledSkillsForWorkloadProfile,
  loadBundledSkillManifest,
} from './bundled-skill-manifest.js';
import { getHarnessToolContracts } from './harness-tool-contracts.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_PACKAGE_ROOT = resolve(__dirname, '..', '..');

export interface HarnessToolActionCatalogEntry {
  action: string;
  purpose: string;
  recommendedWhen: string[];
  requiredFields?: string[];
  example: Record<string, unknown>;
}

export interface HarnessToolCatalogEntry {
  name: string;
  role: string;
  recommendedFirstCall?: boolean;
  summary: string;
  actions: HarnessToolActionCatalogEntry[];
}

export interface HarnessSkillCatalogEntry {
  id: string;
  name: string;
  description: string;
  relativePath: string;
  version: string;
  bundleVersion: string;
  workloadProfileIds: WorkloadProfileId[];
  checksum: string;
}

export interface HarnessBootstrapStep {
  step: number;
  tool: string;
  action: string;
  reason: string;
  requiredFields?: string[];
}

export interface HarnessOrchestrationCapability {
  contractVersion: '1.0.0';
  mode: 'symphony';
  tool: 'harness_symphony';
  defaultModelProfile: 'gpt-5-high';
  defaultMaxConcurrentAgents: 4;
  actions: {
    compilePlan: 'compile_plan';
    dispatchReady: 'dispatch_ready';
    inspectState: 'inspect_state';
    dashboardView: 'dashboard_view';
    runAssignment: 'run_assignment';
    supervisorTick: 'supervisor_tick';
    supervisorRun: 'supervisor_run';
  };
  assignmentRunner: {
    contractVersion: '1.0.0';
    cli: 'harness-agent-runner';
    action: 'run_assignment';
    requiredEvidenceArtifactKinds: readonly ['test_report', 'e2e_report'];
    optionalEvidenceArtifactKinds: readonly ['screenshot'];
    requiredScorecard: 'csqr_lite_scorecard';
  };
  dashboard: {
    contractVersion: '1.0.0';
    filteredViewAction: 'dashboard_view';
    supportedFilters: string[];
  };
  supervisor: {
    contractVersion: '1.0.0';
    cli: 'harness-supervisor';
    tickAction: 'supervisor_tick';
    runAction: 'supervisor_run';
    defaultMaxTicks: 1;
    defaultBackoffMs: {
      idle: 30000;
      blocked: 60000;
      error: 120000;
    };
    boundedPolling: true;
    supportsDryRun: true;
  };
  requiredDispatchFields: string[];
  hostResponsibilities: string[];
  worktreeIsolation: {
    strategy: 'one_worktree_per_issue';
    mcpCreatesWorktrees: boolean;
    physicalAdapter: string;
    cleanupAdapter: string;
    conflictGuards: string[];
  };
  codexRunner: {
    contractVersion: '1.0.0';
    launchAdapter: 'launchCodexAppServerRunner';
    fakeProcessAdapter: 'createScriptedCodexAppServerProcessAdapter';
    defaultCommand: 'codex app-server';
    commandExecution: 'bash_lc';
    timeoutFields: string[];
    deferredTimeoutFields: string[];
    eventTransport: 'requestWithEvents_optional';
    stallDetection: 'event_capable_transport_only';
    continuation: {
      mode: 'advisory_opt_in';
      defaultDelayMs: number;
    };
    telemetry: {
      tokenUsage: 'absolute_totals';
      rateLimits: 'latest_snapshot';
      pendingRequests: boolean;
      retryBackoff: boolean;
    };
    approvalPolicy: 'auto_approve_approval_events_user_input_terminal_failure';
    normalizedErrorCodes: string[];
    dispatcherWiring: 'not_enabled_by_default';
  };
  evidence: {
    acceptedArtifactKinds: string[];
    runtimeMetadataArtifactKinds: string[];
    healthFlags: string[];
  };
}

export interface HarnessCapabilityCatalog {
  tools: HarnessToolCatalogEntry[];
  skills: HarnessSkillCatalogEntry[];
  workloadProfiles: BundledWorkloadProfile[];
  orchestration: HarnessOrchestrationCapability;
  activeWorkloadProfileId?: WorkloadProfileId;
  skillPolicies: SkillFamilyPolicy[];
  suggestedBootstrap: HarnessBootstrapStep[];
}

const TOOL_CATALOG: HarnessToolCatalogEntry[] = getHarnessToolContracts().map(
  ({ name, role, recommendedFirstCall, summary, actions }) => ({
    name,
    role,
    recommendedFirstCall,
    summary,
    actions,
  }),
);

const ORCHESTRATION_CAPABILITY: HarnessOrchestrationCapability = {
  contractVersion: '1.0.0',
  mode: 'symphony',
  tool: 'harness_symphony',
  defaultModelProfile: 'gpt-5-high',
  defaultMaxConcurrentAgents: 4,
  actions: {
    compilePlan: 'compile_plan',
    dispatchReady: 'dispatch_ready',
    inspectState: 'inspect_state',
    dashboardView: 'dashboard_view',
    runAssignment: 'run_assignment',
    supervisorTick: 'supervisor_tick',
    supervisorRun: 'supervisor_run',
  },
  assignmentRunner: {
    contractVersion: '1.0.0',
    cli: 'harness-agent-runner',
    action: 'run_assignment',
    requiredEvidenceArtifactKinds: ['test_report', 'e2e_report'],
    optionalEvidenceArtifactKinds: ['screenshot'],
    requiredScorecard: 'csqr_lite_scorecard',
  },
  dashboard: {
    contractVersion: '1.0.0',
    filteredViewAction: 'dashboard_view',
    supportedFilters: [
      'q',
      'lane',
      'status',
      'priority',
      'evidenceKind',
      'csqr',
      'hasCsqr',
      'signal',
    ],
  },
  supervisor: {
    contractVersion: '1.0.0',
    cli: 'harness-supervisor',
    tickAction: 'supervisor_tick',
    runAction: 'supervisor_run',
    defaultMaxTicks: 1,
    defaultBackoffMs: {
      idle: 30_000,
      blocked: 60_000,
      error: 120_000,
    },
    boundedPolling: true,
    supportsDryRun: true,
  },
  requiredDispatchFields: [
    'projectId or projectName',
    'repoRoot',
    'worktreeRoot',
    'baseRef',
    'host',
    'hostCapabilities',
  ],
  hostResponsibilities: [
    'create_git_worktrees_with_physical_adapter',
    'execute_assignment_runner_commands',
    'produce_test_e2e_and_csqr_evidence',
    'cleanup_worktrees_with_physical_adapter',
  ],
  worktreeIsolation: {
    strategy: 'one_worktree_per_issue',
    mcpCreatesWorktrees: false,
    physicalAdapter: 'createSymphonyPhysicalWorktree',
    cleanupAdapter: 'cleanupSymphonyPhysicalWorktree',
    conflictGuards: [
      'active_worktree_path',
      'active_worktree_branch',
      'candidate_file_overlap',
    ],
  },
  codexRunner: {
    contractVersion: '1.0.0',
    launchAdapter: 'launchCodexAppServerRunner',
    fakeProcessAdapter: 'createScriptedCodexAppServerProcessAdapter',
    defaultCommand: 'codex app-server',
    commandExecution: 'bash_lc',
    timeoutFields: ['readTimeoutMs', 'turnTimeoutMs', 'stallTimeoutMs'],
    deferredTimeoutFields: [],
    eventTransport: 'requestWithEvents_optional',
    stallDetection: 'event_capable_transport_only',
    continuation: {
      mode: 'advisory_opt_in',
      defaultDelayMs: 1_000,
    },
    telemetry: {
      tokenUsage: 'absolute_totals',
      rateLimits: 'latest_snapshot',
      pendingRequests: true,
      retryBackoff: true,
    },
    approvalPolicy: 'auto_approve_approval_events_user_input_terminal_failure',
    normalizedErrorCodes: [...symphonyCodexRunnerErrorCodeValues],
    dispatcherWiring: 'not_enabled_by_default',
  },
  evidence: {
    acceptedArtifactKinds: [...orchestrationEvidenceArtifactKindValues],
    runtimeMetadataArtifactKinds: [
      'orchestration_assignment',
      'orchestration_worktree',
      'orchestration_worktree_branch',
      'orchestration_candidate_files',
      'physical_worktree_manifest',
      'physical_worktree_command_log',
      'physical_worktree_cleanup_plan',
    ],
    healthFlags: [
      'duplicate_active_worktree_artifact_path',
      'done_issue_missing_evidence',
      'expired_active_lease',
    ],
  },
};

const BOOTSTRAP_STEPS: HarnessBootstrapStep[] = [
  {
    step: 1,
    tool: 'harness_inspector',
    action: 'capabilities',
    reason: 'Discover tools, skills, and mem0 availability before planning the loop.',
  },
  {
    step: 2,
    tool: 'harness_inspector',
    action: 'get_context',
    reason: 'Resolve workspace/project scope and current queue state.',
  },
  {
    step: 3,
    tool: 'harness_inspector',
    action: 'next_action',
    reason: 'Let the runtime suggest the next deterministic tool call.',
  },
  {
    step: 4,
    tool: 'harness_symphony',
    action: 'inspect_state',
    reason: 'Discover existing orchestration leases, worktree artifacts, evidence references, and health flags for the resolved project.',
    requiredFields: ['projectId or projectName'],
  },
  {
    step: 5,
    tool: 'harness_symphony',
    action: 'dashboard_view',
    reason: 'Load the stable filtered dashboard view model for agent navigation, operator UI rendering, and evidence review.',
    requiredFields: ['projectId or projectName'],
  },
  {
    step: 6,
    tool: 'harness_symphony',
    action: 'supervisor_run',
    reason: 'Run bounded autonomous polling when the host can provide supervisor inputs, stop conditions, and dispatch/worktree routing fields.',
    requiredFields: [
      'contractVersion',
      'runId',
      'dbPath',
      'projectId or projectName',
    ],
  },
  {
    step: 7,
    tool: 'harness_symphony',
    action: 'dispatch_ready',
    reason: 'Fan out ready issues only after the host knows the repository root, worktree root, base ref, and host routing capabilities.',
    requiredFields: ORCHESTRATION_CAPABILITY.requiredDispatchFields,
  },
];

export function getHarnessCapabilityCatalog(
  options: {
    packageRoot?: string;
    workloadProfileId?: WorkloadProfileId;
  } = {},
): HarnessCapabilityCatalog {
  const packageRoot = options.packageRoot ?? DEFAULT_PACKAGE_ROOT;
  const manifest = loadBundledSkillManifest(packageRoot);

  return {
    tools: TOOL_CATALOG,
    skills: loadBundledSkillCatalog(manifest, options.workloadProfileId),
    workloadProfiles: manifest.workloadProfiles,
    orchestration: ORCHESTRATION_CAPABILITY,
    activeWorkloadProfileId: options.workloadProfileId,
    skillPolicies: defaultSkillPolicies,
    suggestedBootstrap: BOOTSTRAP_STEPS,
  };
}

function loadBundledSkillCatalog(
  manifest: ReturnType<typeof loadBundledSkillManifest>,
  workloadProfileId?: WorkloadProfileId,
): HarnessSkillCatalogEntry[] {
  return getBundledSkillsForWorkloadProfile(manifest, workloadProfileId)
    .map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      relativePath: skill.relativePath,
      version: skill.version,
      bundleVersion: manifest.bundleVersion,
      workloadProfileIds: skill.workloadProfileIds,
      checksum: skill.checksum,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}
