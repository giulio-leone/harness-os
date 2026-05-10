import { z } from 'zod';

import {
  orchestrationSubagentSchema,
  type OrchestrationAssignment,
  type OrchestrationSubagent,
} from '../contracts/orchestration-contracts.js';
import type {
  HarnessDispatchPolicy,
  HarnessHostCapabilities,
} from '../contracts/policy-contracts.js';
import {
  evaluateHarnessDispatchPolicy,
  normalizeHarnessHostCapabilities,
} from './policy-engine.js';

export const subagentRegistryInputSchema = z
  .object({
    subagents: z.array(orchestrationSubagentSchema).min(1),
  })
  .strict();

export type SubagentRegistryInput = z.infer<typeof subagentRegistryInputSchema>;

export const subagentRegistryErrorCodeValues = [
  'DUPLICATE_SUBAGENT_ID',
  'DUPLICATE_SUBAGENT_CAPABILITY',
  'DISPATCH_POLICY_CONFLICT',
  'NO_COMPATIBLE_SUBAGENT',
] as const;

export type SubagentRegistryErrorCode =
  (typeof subagentRegistryErrorCodeValues)[number];

export class SubagentRegistryError extends Error {
  readonly code: SubagentRegistryErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: SubagentRegistryErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'SubagentRegistryError';
    this.code = code;
    this.details = details;
  }
}

export interface SubagentRegistry {
  readonly subagents: readonly OrchestrationSubagent[];
  readonly byId: ReadonlyMap<string, OrchestrationSubagent>;
  readonly byCapability: ReadonlyMap<string, readonly OrchestrationSubagent[]>;
}

export interface SubagentResolutionRequest {
  readonly requiredCapabilityIds?: readonly string[];
  readonly host?: string;
  readonly dispatch?: HarnessDispatchPolicy;
  readonly hostCapabilities?: HarnessHostCapabilities;
}

export interface SubagentCompatibilityCheck {
  readonly compatible: boolean;
  readonly subagentId: string;
  readonly missingWorkloadClasses: readonly string[];
  readonly missingHostCapabilities: readonly string[];
  readonly dispatchConflict: boolean;
}

const DEFAULT_GPT5_HIGH_SUBAGENTS: readonly OrchestrationSubagent[] = [
  {
    id: 'agent-worktree',
    role: 'worktree',
    host: 'copilot',
    modelProfile: 'gpt-5-high',
    capabilities: [
      'git.branch',
      'git.merge',
      'worktree.cleanup',
      'worktree.create',
    ],
    maxConcurrency: 1,
  },
  {
    id: 'agent-registry',
    role: 'registry',
    host: 'copilot',
    modelProfile: 'gpt-5-high',
    capabilities: [
      'capability.matching',
      'subagent.registry',
      'subagent.routing',
    ],
    maxConcurrency: 1,
  },
  {
    id: 'agent-planner',
    role: 'planner',
    host: 'copilot',
    modelProfile: 'gpt-5-high',
    capabilities: [
      'assignment.create',
      'dispatch.plan',
      'planning',
    ],
    maxConcurrency: 1,
  },
  {
    id: 'agent-inspector-dispatcher',
    role: 'inspector/dispatcher',
    host: 'copilot',
    modelProfile: 'gpt-5-high',
    capabilities: [
      'dispatch.execute',
      'evidence.review',
      'inspection',
    ],
    maxConcurrency: 1,
  },
];

export function createDefaultGpt5HighSubagents(): OrchestrationSubagent[] {
  return normalizeSubagents(DEFAULT_GPT5_HIGH_SUBAGENTS);
}

export function createDefaultGpt5HighSubagentRegistry(): SubagentRegistry {
  return createSubagentRegistry({
    subagents: createDefaultGpt5HighSubagents(),
  });
}

export function createSubagentRegistry(input: SubagentRegistryInput): SubagentRegistry {
  const parsed = subagentRegistryInputSchema.parse(input);
  const subagents = normalizeSubagents(parsed.subagents);
  const byId = new Map<string, OrchestrationSubagent>();
  const mutableCapabilityIndex = new Map<string, OrchestrationSubagent[]>();

  for (const subagent of subagents) {
    if (byId.has(subagent.id)) {
      throw new SubagentRegistryError(
        'DUPLICATE_SUBAGENT_ID',
        `Duplicate subagent id "${subagent.id}".`,
        { subagentId: subagent.id },
      );
    }

    byId.set(subagent.id, subagent);

    for (const capability of subagent.capabilities) {
      const indexed = mutableCapabilityIndex.get(capability) ?? [];
      indexed.push(subagent);
      mutableCapabilityIndex.set(capability, indexed);
    }
  }

  const byCapability = new Map<string, readonly OrchestrationSubagent[]>();
  for (const [capability, indexedSubagents] of mutableCapabilityIndex.entries()) {
    byCapability.set(capability, sortSubagents(indexedSubagents));
  }

  return {
    subagents,
    byId,
    byCapability,
  };
}

export function normalizeSubagents(
  subagents: readonly OrchestrationSubagent[],
): OrchestrationSubagent[] {
  return sortSubagents(subagents.map((subagent) => normalizeSubagent(subagent)));
}

export function resolveSubagent(
  registry: SubagentRegistry,
  request: SubagentResolutionRequest,
): OrchestrationSubagent {
  const requiredCapabilityIds = normalizeStringSet(
    request.requiredCapabilityIds ?? [],
  );
  const candidates = registry.subagents.filter((subagent) => {
    if (request.host !== undefined && subagent.host !== request.host) {
      return false;
    }

    if (!hasRequiredCapabilities(subagent, requiredCapabilityIds)) {
      return false;
    }

    return checkSubagentCompatibility(subagent, request).compatible;
  });

  if (candidates.length > 0) {
    return candidates[0]!;
  }

  throw new SubagentRegistryError(
    'NO_COMPATIBLE_SUBAGENT',
    buildNoCompatibleSubagentMessage(registry, request, requiredCapabilityIds),
    {
      requiredCapabilityIds,
      host: request.host,
      dispatch: request.dispatch,
      hostCapabilities: request.hostCapabilities,
    },
  );
}

export function resolveSubagentId(
  registry: SubagentRegistry,
  request: SubagentResolutionRequest,
): string {
  return resolveSubagent(registry, request).id;
}

export function resolveAssignmentSubagent(
  registry: SubagentRegistry,
  assignment: Pick<OrchestrationAssignment, 'requiredCapabilityIds'>,
  request: Omit<SubagentResolutionRequest, 'requiredCapabilityIds'> = {},
): OrchestrationSubagent {
  return resolveSubagent(registry, {
    ...request,
    requiredCapabilityIds: assignment.requiredCapabilityIds ?? [],
  });
}

export function checkSubagentCompatibility(
  subagent: OrchestrationSubagent,
  request: Pick<SubagentResolutionRequest, 'dispatch' | 'hostCapabilities'>,
): SubagentCompatibilityCheck {
  const dispatchConflict = hasDispatchPolicyConflict(
    subagent.dispatch,
    request.dispatch,
  );

  if (dispatchConflict) {
    return {
      compatible: false,
      subagentId: subagent.id,
      missingWorkloadClasses: [],
      missingHostCapabilities: [],
      dispatchConflict,
    };
  }

  if (request.hostCapabilities === undefined) {
    return {
      compatible: true,
      subagentId: subagent.id,
      missingWorkloadClasses: [],
      missingHostCapabilities: [],
      dispatchConflict,
    };
  }

  const hostCapabilities = normalizeHarnessHostCapabilities(request.hostCapabilities);
  const checks = [subagent.dispatch, request.dispatch]
    .filter((policy): policy is HarnessDispatchPolicy => policy !== undefined)
    .map((policy) =>
      evaluateHarnessDispatchPolicy(policy, hostCapabilities),
    );
  const missingWorkloadClasses = normalizeStringSet(
    checks.flatMap((check) =>
      check.missingWorkloadClass === undefined ? [] : [check.missingWorkloadClass],
    ),
  );
  const missingHostCapabilities = normalizeStringSet(
    checks.flatMap((check) => check.missingHostCapabilities),
  );

  return {
    compatible:
      missingWorkloadClasses.length === 0 && missingHostCapabilities.length === 0,
    subagentId: subagent.id,
    missingWorkloadClasses,
    missingHostCapabilities,
    dispatchConflict,
  };
}

function normalizeSubagent(subagent: OrchestrationSubagent): OrchestrationSubagent {
  const parsed = orchestrationSubagentSchema.parse(subagent);
  const capabilities = normalizeCapabilities(parsed.id, parsed.capabilities);
  const normalized = {
    ...parsed,
    id: parsed.id.trim(),
    role: parsed.role.trim(),
    host: parsed.host.trim(),
    ...(parsed.model !== undefined ? { model: parsed.model.trim() } : {}),
    capabilities,
    ...(parsed.dispatch !== undefined
      ? { dispatch: normalizeDispatchPolicy(parsed.dispatch) }
      : {}),
  } satisfies OrchestrationSubagent;

  return orchestrationSubagentSchema.parse(normalized);
}

function normalizeCapabilities(
  subagentId: string,
  capabilities: readonly string[],
): string[] {
  const normalizedCapabilities = capabilities.map((capability) => capability.trim());
  const uniqueCapabilities = normalizeStringSet(normalizedCapabilities);

  if (uniqueCapabilities.length !== normalizedCapabilities.length) {
    throw new SubagentRegistryError(
      'DUPLICATE_SUBAGENT_CAPABILITY',
      `Subagent "${subagentId}" declares duplicate capabilities after normalization.`,
      { subagentId },
    );
  }

  return uniqueCapabilities;
}

function normalizeDispatchPolicy(
  dispatch: HarnessDispatchPolicy,
): HarnessDispatchPolicy {
  return {
    workloadClass: dispatch.workloadClass.trim(),
    ...(dispatch.requiredHostCapabilities !== undefined
      ? {
          requiredHostCapabilities: normalizeStringSet(
            dispatch.requiredHostCapabilities.map((capability) => capability.trim()),
          ),
        }
      : {}),
  };
}

function normalizeStringSet(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sortSubagents(
  subagents: readonly OrchestrationSubagent[],
): OrchestrationSubagent[] {
  return [...subagents].sort(compareSubagents);
}

function compareSubagents(
  left: OrchestrationSubagent,
  right: OrchestrationSubagent,
): number {
  return (
    left.id.localeCompare(right.id) ||
    left.role.localeCompare(right.role) ||
    left.host.localeCompare(right.host)
  );
}

function hasRequiredCapabilities(
  subagent: OrchestrationSubagent,
  requiredCapabilityIds: readonly string[],
): boolean {
  const capabilities = new Set(subagent.capabilities);
  return requiredCapabilityIds.every((capability) => capabilities.has(capability));
}

function hasDispatchPolicyConflict(
  subagentDispatch: HarnessDispatchPolicy | undefined,
  requestDispatch: HarnessDispatchPolicy | undefined,
): boolean {
  return (
    subagentDispatch !== undefined &&
    requestDispatch !== undefined &&
    subagentDispatch.workloadClass !== requestDispatch.workloadClass
  );
}

function buildNoCompatibleSubagentMessage(
  registry: SubagentRegistry,
  request: SubagentResolutionRequest,
  requiredCapabilityIds: readonly string[],
): string {
  const capabilityText =
    requiredCapabilityIds.length === 0
      ? 'no specific capabilities'
      : `capabilities ${requiredCapabilityIds.map((capability) => `"${capability}"`).join(', ')}`;
  const hostText = request.host === undefined ? '' : ` on host "${request.host}"`;
  const compatibleIds = registry.subagents
    .filter((subagent) => hasRequiredCapabilities(subagent, requiredCapabilityIds))
    .map((subagent) => subagent.id);

  return [
    `No compatible subagent found for ${capabilityText}${hostText}.`,
    compatibleIds.length === 0
      ? 'No registered subagent provides all required capabilities.'
      : `Capability-compatible subagents rejected by dispatch or host constraints: ${compatibleIds.join(', ')}.`,
  ].join(' ');
}
