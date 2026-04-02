import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  BundledWorkloadProfile,
  WorkloadProfileId,
} from '../contracts/workload-profiles.js';
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
}

export interface HarnessCapabilityCatalog {
  tools: HarnessToolCatalogEntry[];
  skills: HarnessSkillCatalogEntry[];
  workloadProfiles: BundledWorkloadProfile[];
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
