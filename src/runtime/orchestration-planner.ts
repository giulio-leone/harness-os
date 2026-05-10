import { z } from 'zod';

import type { HarnessPolicy } from '../contracts/policy-contracts.js';
import type {
  IssuePriority,
  TShirtSize,
} from '../contracts/task-domain.js';
import type {
  HarnessWorkflowExternalRef,
  HarnessWorkflowMetadata,
} from '../contracts/workflow-contracts.js';
import { harnessPlanMilestoneBatchItemSchema } from './harness-planning-tools.js';

export type HarnessPlanMilestonePayload = z.infer<
  typeof harnessPlanMilestoneBatchItemSchema
>;

export type OrchestrationEvidenceRequirement = HarnessWorkflowExternalRef;

type WorkflowMetadataInput = Pick<
  HarnessWorkflowMetadata,
  'deadlineAt' | 'recipients' | 'approvals' | 'externalRefs'
>;

export interface OrchestrationMilestoneInput extends WorkflowMetadataInput {
  id: string;
  key?: string;
  description: string;
  dependsOnMilestoneIds?: string[];
  dependsOnMilestoneKeys?: string[];
  dependsOnExistingMilestoneIds?: string[];
}

export interface OrchestrationSliceInput extends WorkflowMetadataInput {
  id: string;
  milestoneId: string;
  task: string;
  priority: IssuePriority;
  size: TShirtSize;
  dependsOnSliceIds?: string[];
  evidenceRequirements?: OrchestrationEvidenceRequirement[];
  policy?: HarnessPolicy;
}

export interface OrchestrationPlannerInput {
  milestones: OrchestrationMilestoneInput[];
  slices: OrchestrationSliceInput[];
}

export interface HarnessPlanIssuesMilestonesPayload {
  milestones: HarnessPlanMilestonePayload[];
}

export function toHarnessPlanIssuesPayload(
  input: OrchestrationPlannerInput,
): HarnessPlanIssuesMilestonesPayload {
  return {
    milestones: planOrchestrationMilestones(input),
  };
}

export function planOrchestrationMilestones(
  input: OrchestrationPlannerInput,
): HarnessPlanMilestonePayload[] {
  const milestoneById = indexById(input.milestones, 'milestone');
  const milestoneIdByKey = indexMilestoneKeys(input.milestones);
  const sliceById = indexById(input.slices, 'slice');
  const slicesByMilestoneId = groupSlicesByMilestone(input.slices, milestoneById);
  const milestoneDependencies = buildMilestoneDependencies({
    milestones: input.milestones,
    milestoneById,
    milestoneIdByKey,
    slices: input.slices,
    sliceById,
  });

  const orderedMilestones = topologicalSort(
    input.milestones,
    (milestone) => milestone.id,
    (milestone) => [...(milestoneDependencies.get(milestone.id) ?? [])],
    'milestone',
  );

  const output = orderedMilestones.map((milestone) => {
    const milestoneSlices = slicesByMilestoneId.get(milestone.id) ?? [];
    const orderedSlices = orderSlicesWithinMilestone(milestoneSlices, sliceById);
    const issueIndexBySliceId = new Map(
      orderedSlices.map((slice, index) => [slice.id, index]),
    );
    const dependsOnMilestoneKeys = uniqueSorted(
      [...(milestoneDependencies.get(milestone.id) ?? [])].map((dependencyId) =>
        milestoneKey(milestoneById.get(dependencyId)!),
      ),
    );

    const payload: HarnessPlanMilestonePayload = {
      milestone_key: milestoneKey(milestone),
      description: milestone.description,
      issues: orderedSlices.map((slice) =>
        buildIssuePayload(slice, issueIndexBySliceId, sliceById),
      ),
    };

    assignIfNonEmpty(payload, 'depends_on_milestone_ids', uniqueSorted(milestone.dependsOnExistingMilestoneIds));
    assignIfNonEmpty(payload, 'depends_on_milestone_keys', dependsOnMilestoneKeys);
    assignWorkflowMetadata(payload, milestone);

    return harnessPlanMilestoneBatchItemSchema.parse(payload);
  });

  if (output.some((milestone) => milestone.issues.length === 0)) {
    throw new Error('Every orchestration milestone must contain at least one slice.');
  }

  return output;
}

function buildIssuePayload(
  slice: OrchestrationSliceInput,
  issueIndexBySliceId: Map<string, number>,
  sliceById: Map<string, OrchestrationSliceInput>,
): HarnessPlanMilestonePayload['issues'][number] {
  const sameMilestoneDependencyIndices = uniqueSortedNumbers(
    (slice.dependsOnSliceIds ?? [])
      .map((dependencyId) => {
        const dependency = sliceById.get(dependencyId);

        if (dependency === undefined) {
          throw new Error(`Slice "${slice.id}" references unknown dependency "${dependencyId}".`);
        }

        if (dependency.milestoneId !== slice.milestoneId) {
          return undefined;
        }

        return issueIndexBySliceId.get(dependencyId);
      })
      .filter((value): value is number => value !== undefined),
  );

  const payload: HarnessPlanMilestonePayload['issues'][number] = {
    task: slice.task,
    priority: slice.priority,
    size: slice.size,
  };

  assignIfNonEmpty(payload, 'depends_on_indices', sameMilestoneDependencyIndices);
  assignWorkflowMetadata(payload, {
    ...slice,
    externalRefs: mergeExternalRefs(slice.externalRefs, slice.evidenceRequirements),
  });

  if (slice.policy !== undefined) {
    payload.policy = slice.policy;
  }

  return payload;
}

function buildMilestoneDependencies(input: {
  milestones: OrchestrationMilestoneInput[];
  milestoneById: Map<string, OrchestrationMilestoneInput>;
  milestoneIdByKey: Map<string, string>;
  slices: OrchestrationSliceInput[];
  sliceById: Map<string, OrchestrationSliceInput>;
}): Map<string, Set<string>> {
  const dependencies = new Map(
    input.milestones.map((milestone) => [milestone.id, new Set<string>()]),
  );

  for (const milestone of input.milestones) {
    const dependencySet = dependencies.get(milestone.id)!;

    for (const dependencyId of milestone.dependsOnMilestoneIds ?? []) {
      assertKnownMilestoneId(input.milestoneById, milestone.id, dependencyId);
      addMilestoneDependency(dependencySet, milestone.id, dependencyId);
    }

    for (const dependencyKey of milestone.dependsOnMilestoneKeys ?? []) {
      const dependencyId = input.milestoneIdByKey.get(dependencyKey);

      if (dependencyId === undefined) {
        throw new Error(
          `Milestone "${milestone.id}" references unknown dependency key "${dependencyKey}".`,
        );
      }

      addMilestoneDependency(dependencySet, milestone.id, dependencyId);
    }
  }

  for (const slice of input.slices) {
    const dependencySet = dependencies.get(slice.milestoneId)!;

    for (const dependencySliceId of slice.dependsOnSliceIds ?? []) {
      const dependency = input.sliceById.get(dependencySliceId);

      if (dependency === undefined) {
        throw new Error(
          `Slice "${slice.id}" references unknown dependency "${dependencySliceId}".`,
        );
      }

      if (dependency.milestoneId !== slice.milestoneId) {
        addMilestoneDependency(dependencySet, slice.milestoneId, dependency.milestoneId);
      }
    }
  }

  return dependencies;
}

function orderSlicesWithinMilestone(
  slices: OrchestrationSliceInput[],
  sliceById: Map<string, OrchestrationSliceInput>,
): OrchestrationSliceInput[] {
  return topologicalSort(
    slices,
    (slice) => slice.id,
    (slice) =>
      (slice.dependsOnSliceIds ?? []).filter((dependencyId) => {
        const dependency = sliceById.get(dependencyId);

        if (dependency === undefined) {
          throw new Error(`Slice "${slice.id}" references unknown dependency "${dependencyId}".`);
        }

        return dependency.milestoneId === slice.milestoneId;
      }),
    'slice',
  );
}

function groupSlicesByMilestone(
  slices: OrchestrationSliceInput[],
  milestoneById: Map<string, OrchestrationMilestoneInput>,
): Map<string, OrchestrationSliceInput[]> {
  const grouped = new Map<string, OrchestrationSliceInput[]>();

  for (const slice of slices) {
    if (!milestoneById.has(slice.milestoneId)) {
      throw new Error(`Slice "${slice.id}" references unknown milestone "${slice.milestoneId}".`);
    }

    const existing = grouped.get(slice.milestoneId) ?? [];
    existing.push(slice);
    grouped.set(slice.milestoneId, existing);
  }

  return grouped;
}

function indexById<T extends { id: string }>(
  entries: T[],
  label: string,
): Map<string, T> {
  const byId = new Map<string, T>();

  for (const entry of entries) {
    if (byId.has(entry.id)) {
      throw new Error(`Duplicate ${label} id "${entry.id}".`);
    }

    byId.set(entry.id, entry);
  }

  return byId;
}

function indexMilestoneKeys(
  milestones: OrchestrationMilestoneInput[],
): Map<string, string> {
  const byKey = new Map<string, string>();

  for (const milestone of milestones) {
    const key = milestoneKey(milestone);

    if (byKey.has(key)) {
      throw new Error(`Duplicate milestone key "${key}".`);
    }

    byKey.set(key, milestone.id);
  }

  return byKey;
}

function topologicalSort<T>(
  entries: T[],
  getId: (entry: T) => string,
  getDependencyIds: (entry: T) => string[],
  label: string,
): T[] {
  const byId = new Map(entries.map((entry) => [getId(entry), entry]));
  const ordered: T[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string): void => {
    if (visited.has(id)) {
      return;
    }

    if (visiting.has(id)) {
      throw new Error(`Cycle detected in ${label} dependencies at "${id}".`);
    }

    const entry = byId.get(id);

    if (entry === undefined) {
      throw new Error(`Unknown ${label} dependency "${id}".`);
    }

    visiting.add(id);

    for (const dependencyId of uniqueSorted(getDependencyIds(entry))) {
      visit(dependencyId);
    }

    visiting.delete(id);
    visited.add(id);
    ordered.push(entry);
  };

  for (const id of uniqueSorted([...byId.keys()])) {
    visit(id);
  }

  return ordered;
}

function assertKnownMilestoneId(
  milestoneById: Map<string, OrchestrationMilestoneInput>,
  milestoneId: string,
  dependencyId: string,
): void {
  if (!milestoneById.has(dependencyId)) {
    throw new Error(
      `Milestone "${milestoneId}" references unknown dependency "${dependencyId}".`,
    );
  }
}

function addMilestoneDependency(
  dependencies: Set<string>,
  milestoneId: string,
  dependencyId: string,
): void {
  if (dependencyId === milestoneId) {
    throw new Error(`Milestone "${milestoneId}" cannot depend on itself.`);
  }

  dependencies.add(dependencyId);
}

function milestoneKey(milestone: OrchestrationMilestoneInput): string {
  return milestone.key ?? milestone.id;
}

function assignWorkflowMetadata<T extends Partial<WorkflowMetadataInput>>(
  target: T,
  source: WorkflowMetadataInput,
): void {
  if (source.deadlineAt !== undefined) {
    target.deadlineAt = source.deadlineAt;
  }

  assignIfNonEmpty(target, 'recipients', source.recipients);
  assignIfNonEmpty(target, 'approvals', source.approvals);
  assignIfNonEmpty(target, 'externalRefs', source.externalRefs);
}

function assignIfNonEmpty<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (Array.isArray(value) && value.length === 0) {
    return;
  }

  if (value !== undefined) {
    target[key] = value;
  }
}

function mergeExternalRefs(
  externalRefs: HarnessWorkflowExternalRef[] | undefined,
  evidenceRequirements: OrchestrationEvidenceRequirement[] | undefined,
): HarnessWorkflowExternalRef[] | undefined {
  const merged = [...(externalRefs ?? []), ...(evidenceRequirements ?? [])];
  return merged.length > 0 ? merged : undefined;
}

function uniqueSorted(values: string[] | undefined): string[] {
  return [...new Set(values ?? [])].sort((left, right) => left.localeCompare(right));
}

function uniqueSortedNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}
