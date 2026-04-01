import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  defaultSkillPolicies,
  type SkillFamilyPolicy,
} from '../policy/skill-policy-registry.js';

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
}

export interface HarnessBootstrapStep {
  step: number;
  tool: string;
  action: string;
  reason: string;
}

export interface HarnessCapabilityCatalog {
  tools: HarnessToolCatalogEntry[];
  skills: HarnessSkillCatalogEntry[];
  skillPolicies: SkillFamilyPolicy[];
  suggestedBootstrap: HarnessBootstrapStep[];
}

const TOOL_CATALOG: HarnessToolCatalogEntry[] = [
  {
    name: 'harness_inspector',
    role: 'Orientation, introspection, and next-best-action guidance',
    recommendedFirstCall: true,
    summary:
      'Use first in a new session, when queue state is unclear, or when the agent needs a machine-readable guide to the runtime.',
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
        recommendedWhen: [
          'new chat',
          'project orientation',
          'scope disambiguation',
        ],
        example: {
          action: 'get_context',
          projectName: 'Agent Harness Core',
        },
      },
      {
        action: 'next_action',
        purpose:
          'Get the next recommended tool call based on queue state, recovery needs, and claimable work.',
        recommendedWhen: [
          'queue navigation',
          'recovering from idle state',
          'agentic execution loop',
        ],
        example: {
          action: 'next_action',
          projectName: 'Agent Harness Core',
        },
      },
      {
        action: 'overview',
        purpose:
          'Inspect ready work, recovery work, active leases, and recent runs for a project or campaign.',
        recommendedWhen: [
          'operator dashboard',
          'triage',
          'multi-agent coordination',
        ],
        requiredFields: ['projectId or projectName'],
        example: {
          action: 'overview',
          projectName: 'Agent Harness Core',
          runLimit: 10,
        },
      },
      {
        action: 'issue',
        purpose:
          'Deep-dive a single issue with checkpoints, events, leases, and linked memories.',
        recommendedWhen: [
          'debugging a stuck task',
          'handoff review',
          'recovery preparation',
        ],
        requiredFields: ['issueId'],
        example: {
          action: 'issue',
          issueId: 'I-123',
          includeEvents: true,
        },
      },
      {
        action: 'health',
        purpose:
          'Inspect stale leases, checkpoint freshness, and queue health for a project or campaign.',
        recommendedWhen: [
          'operational health checks',
          'before starting long sessions',
          'lease troubleshooting',
        ],
        requiredFields: ['projectId or projectName'],
        example: {
          action: 'health',
          projectName: 'Agent Harness Core',
        },
      },
    ],
  },
  {
    name: 'harness_orchestrator',
    role: 'Workspace bootstrap, campaign setup, and queue promotion',
    summary:
      'Use to create scope, inject planned work, promote dependencies, and reset stuck issues.',
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
        },
      },
      {
        action: 'plan_issues',
        purpose: 'Create issues with priorities, sizes, and dependency ordering.',
        recommendedWhen: ['breaking down work', 'queue planning'],
        requiredFields: ['milestoneDescription', 'issues'],
        example: {
          action: 'plan_issues',
          projectName: 'Agent Harness Core',
          campaignName: 'Runtime hardening',
          milestoneDescription: 'Agentic-first runtime improvements',
          issues: [
            {
              task: 'Add capability introspection',
              priority: 'high',
              size: 'M',
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
    name: 'harness_session',
    role: 'Task execution lifecycle with leases, checkpoints, and recovery',
    summary:
      'Use for claim/resume, checkpointing, close/advance, and lease heartbeat during execution.',
    actions: [
      {
        action: 'begin',
        purpose: 'Claim or resume the next ready issue.',
        recommendedWhen: ['start working', 'resume active work'],
        requiredFields: [
          'sessionId',
          'workspaceId',
          'projectId',
          'progressPath',
          'featureListPath',
          'planPath',
          'syncManifestPath',
          'mem0Enabled',
        ],
        example: {
          action: 'begin',
          sessionId: 'run-001',
          workspaceId: 'W-123',
          projectId: 'P-123',
          progressPath: '/workspace/progress.md',
          featureListPath: '/workspace/feature_list.json',
          planPath: '/workspace/plan.md',
          syncManifestPath: '/workspace/sync.json',
          mem0Enabled: true,
        },
      },
      {
        action: 'begin_recovery',
        purpose: 'Claim a needs_recovery issue explicitly.',
        recommendedWhen: ['recovery workflow'],
        requiredFields: [
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
        example: {
          action: 'begin_recovery',
          sessionId: 'run-recovery-001',
          workspaceId: 'W-123',
          projectId: 'P-123',
          progressPath: '/workspace/progress.md',
          featureListPath: '/workspace/feature_list.json',
          planPath: '/workspace/plan.md',
          syncManifestPath: '/workspace/sync.json',
          mem0Enabled: true,
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
    role: 'Persistent artifact registry for external files and evidence',
    summary:
      'Use to persist references to screenshots, browser state, generated files, or other task evidence.',
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
    role: 'Operational maintenance, cleanup, and mem0 compaction',
    summary:
      'Use for recovery-oriented maintenance, retention cleanup, and project-level memory snapshots or rollups.',
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
];

export function getHarnessCapabilityCatalog(
  packageRoot: string = DEFAULT_PACKAGE_ROOT,
): HarnessCapabilityCatalog {
  return {
    tools: TOOL_CATALOG,
    skills: loadBundledSkillCatalog(packageRoot),
    skillPolicies: defaultSkillPolicies,
    suggestedBootstrap: BOOTSTRAP_STEPS,
  };
}

function loadBundledSkillCatalog(packageRoot: string): HarnessSkillCatalogEntry[] {
  const skillsDir = resolve(packageRoot, '.github', 'skills');
  if (!existsSync(skillsDir)) {
    return [];
  }

  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const relativePath = `.github/skills/${entry.name}/SKILL.md`;
      const absolutePath = resolve(packageRoot, relativePath);
      const raw = existsSync(absolutePath)
        ? readFileSync(absolutePath, 'utf8')
        : '';
      const frontmatter = parseSkillFrontmatter(raw);

      return {
        id: entry.name,
        name: frontmatter.name ?? entry.name,
        description:
          frontmatter.description ??
          'Bundled HarnessOS skill.',
        relativePath,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function parseSkillFrontmatter(content: string): {
  name?: string;
  description?: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return {};
  }

  const frontmatter: Record<string, string> = {};
  for (const rawLine of match[1].split(/\r?\n/)) {
    const separatorIndex = rawLine.indexOf(':');
    if (separatorIndex === -1) {
      continue;
    }

    const key = rawLine.slice(0, separatorIndex).trim();
    const value = rawLine.slice(separatorIndex + 1).trim();
    if (key.length === 0 || value.length === 0) {
      continue;
    }

    frontmatter[key] = value;
  }

  return {
    name: frontmatter['name'],
    description: frontmatter['description'],
  };
}
