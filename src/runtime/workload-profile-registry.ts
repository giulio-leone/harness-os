import { createHash } from 'node:crypto';

import type {
  BundledWorkloadProfile,
  WorkloadProfileDefinition,
  WorkloadProfileId,
} from '../contracts/workload-profiles.js';

const CORE_RUNTIME_SKILLS = [
  'completion-gate',
  'context-management',
  'harness-interactive-setup',
  'harness-lifecycle',
  'interaction-loop',
  'planning-tracking',
  'policy-coherence-audit',
  'programmatic-tool-calling',
  'prompt-contract-bindings',
  'rollback-rca',
  'session-lifecycle',
  'session-logging',
] as const;

const CODING_PROFILE_SKILLS = [
  ...CORE_RUNTIME_SKILLS,
  'breaking-change-paths',
  'code-review',
  'dependency-management',
  'e2e-testing',
  'error-handling-patterns',
  'git-workflow',
  'github-sync',
  'mobile-mcp-optimization',
  'performance-audit',
  'systematic-debugging',
  'testing-policy',
] as const;

const RESEARCH_PROFILE_SKILLS = [
  ...CORE_RUNTIME_SKILLS,
  'systematic-debugging',
] as const;

const OPS_PROFILE_SKILLS = [
  ...CORE_RUNTIME_SKILLS,
  'dependency-management',
  'e2e-testing',
  'error-handling-patterns',
  'performance-audit',
  'systematic-debugging',
] as const;

const SALES_PROFILE_SKILLS = [
  ...CORE_RUNTIME_SKILLS,
  'github-sync',
] as const;

const SUPPORT_PROFILE_SKILLS = [
  ...CORE_RUNTIME_SKILLS,
  'error-handling-patterns',
  'systematic-debugging',
] as const;

const WORKLOAD_PROFILE_BLUEPRINTS: Array<
  Omit<WorkloadProfileDefinition, 'skillIds'> & {
    skillIds?: readonly string[];
  }
> = [
  {
    id: 'coding',
    name: 'Coding',
    description: 'Software delivery, code review, testing, and release execution.',
    guidance:
      'Optimize for implementation quality, deterministic validation, and release-safe engineering workflows.',
    skillIds: CODING_PROFILE_SKILLS,
  },
  {
    id: 'research',
    name: 'Research',
    description: 'Discovery, synthesis, analysis, and evidence-driven investigation.',
    guidance:
      'Optimize for structured exploration, traceable findings, and compact handoffs instead of code-first execution.',
    skillIds: RESEARCH_PROFILE_SKILLS,
  },
  {
    id: 'ops',
    name: 'Ops',
    description: 'Infrastructure, deployment, incident response, and service operations.',
    guidance:
      'Optimize for operational safety, rollback readiness, observability, and recovery discipline.',
    skillIds: OPS_PROFILE_SKILLS,
  },
  {
    id: 'sales',
    name: 'Sales',
    description: 'Pipeline execution, deal support, enablement, and customer-facing follow-through.',
    guidance:
      'Optimize for structured plans, decision clarity, and lightweight operational handoffs across external stakeholders.',
    skillIds: SALES_PROFILE_SKILLS,
  },
  {
    id: 'support',
    name: 'Support',
    description: 'Case triage, escalation handling, investigation, and customer resolution workflows.',
    guidance:
      'Optimize for reproducible investigation, escalation discipline, and clear next-action ownership.',
    skillIds: SUPPORT_PROFILE_SKILLS,
  },
  {
    id: 'assistant',
    name: 'Assistant',
    description: 'General cross-domain execution with the full bundled skill surface.',
    guidance:
      'Use this when a host must stay multi-domain and needs the complete bundled skill set without specialization.',
  },
];

export function getWorkloadProfileMetadata(): Array<
  Pick<WorkloadProfileDefinition, 'id' | 'name' | 'description'>
> {
  return WORKLOAD_PROFILE_BLUEPRINTS.map(({ id, name, description }) => ({
    id,
    name,
    description,
  }));
}

export function buildBundledWorkloadProfiles(input: {
  bundleVersion: string;
  availableSkillIds: string[];
}): BundledWorkloadProfile[] {
  const availableSkillIds = [...new Set(input.availableSkillIds)].sort((left, right) =>
    left.localeCompare(right),
  );
  const availableSkillIdSet = new Set(availableSkillIds);

  return WORKLOAD_PROFILE_BLUEPRINTS.map((blueprint) => {
    const skillIds = normalizeSkillIds(
      blueprint.skillIds === undefined ? availableSkillIds : [...blueprint.skillIds],
    );

    for (const skillId of skillIds) {
      if (!availableSkillIdSet.has(skillId)) {
        throw new Error(
          `Workload profile "${blueprint.id}" references unknown bundled skill "${skillId}".`,
        );
      }
    }

    const profileWithoutChecksum = {
      id: blueprint.id,
      name: blueprint.name,
      description: blueprint.description,
      guidance: blueprint.guidance,
      version: input.bundleVersion,
      skillIds,
    } satisfies Omit<BundledWorkloadProfile, 'checksum'>;

    return {
      ...profileWithoutChecksum,
      checksum: sha256(stableStringify(profileWithoutChecksum)),
    } satisfies BundledWorkloadProfile;
  }).sort((left, right) => left.id.localeCompare(right.id));
}

export function isWorkloadProfileId(value: string): value is WorkloadProfileId {
  return WORKLOAD_PROFILE_BLUEPRINTS.some((profile) => profile.id === value);
}

function normalizeSkillIds(skillIds: string[]): string[] {
  return [...new Set(skillIds)].sort((left, right) => left.localeCompare(right));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, nestedValue) => {
    if (Array.isArray(nestedValue) || nestedValue === null || typeof nestedValue !== 'object') {
      return nestedValue;
    }

    return Object.fromEntries(
      Object.entries(nestedValue).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey)),
    );
  });
}
