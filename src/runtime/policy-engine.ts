import type {
  HarnessDispatchPolicy,
  HarnessHostCapabilities,
  HarnessPolicy,
  HarnessPolicyEscalationAction,
  HarnessPolicyEscalationRule,
  HarnessPolicyEscalationTrigger,
} from '../contracts/policy-contracts.js';
import { harnessPolicySchema } from '../contracts/policy-contracts.js';
import {
  issuePriorityValues,
  type IssuePriority,
} from '../contracts/task-domain.js';
import { buildWorkItemMetadataSurface } from './work-item-metadata.js';

const priorityRank = new Map<IssuePriority, number>(
  issuePriorityValues.map((priority, index) => [priority, index]),
);

const responseTrackedStatuses = new Set(['pending', 'ready']);
const resolveSatisfiedStatuses = new Set(['done', 'failed']);

export interface PolicyCarrierRow {
  id: string;
  priority: string;
  status: string;
  created_at?: string | null;
  deadline_at?: string | null;
  policy_json?: string | null;
  campaign_policy_json?: string | null;
}

export interface IssuePolicyBreach {
  trigger: HarnessPolicyEscalationTrigger;
  breachedAt: string;
  minutesOverdue: number;
  action: HarnessPolicyEscalationAction | 'none';
  priority?: IssuePriority;
  note?: string;
}

export interface IssuePolicyState {
  effectivePriority: IssuePriority;
  escalated: boolean;
  breaches: IssuePolicyBreach[];
}

export interface IssuePolicySurface {
  policy?: HarnessPolicy;
  policyState?: IssuePolicyState;
}

export interface IssueDispatchState {
  eligible: boolean;
  requiredWorkloadClass?: string;
  requiredHostCapabilities: string[];
  missingWorkloadClass?: string;
  missingHostCapabilities: string[];
}

export function serializeHarnessPolicy(policy?: HarnessPolicy): string {
  return JSON.stringify(policy ?? {});
}

export function parseHarnessPolicy(
  rawPolicy: string | null | undefined,
): HarnessPolicy | undefined {
  if (
    rawPolicy === undefined ||
    rawPolicy === null ||
    rawPolicy === '' ||
    rawPolicy === '{}'
  ) {
    return undefined;
  }

  const parsed = JSON.parse(rawPolicy) as unknown;
  const policy = harnessPolicySchema.parse(parsed);

  return Object.keys(policy).length === 0 ? undefined : policy;
}

export function resolveEffectiveHarnessPolicy(input: {
  campaignPolicy?: HarnessPolicy;
  issuePolicy?: HarnessPolicy;
}): HarnessPolicy | undefined {
  const serviceLevel = {
    responseWithinMinutes:
      input.issuePolicy?.serviceLevel?.responseWithinMinutes ??
      input.campaignPolicy?.serviceLevel?.responseWithinMinutes,
    resolveWithinMinutes:
      input.issuePolicy?.serviceLevel?.resolveWithinMinutes ??
      input.campaignPolicy?.serviceLevel?.resolveWithinMinutes,
  };

  const escalationRules = [
    ...(input.campaignPolicy?.escalationRules ?? []),
    ...(input.issuePolicy?.escalationRules ?? []),
  ];
  const requiredHostCapabilities = uniqueStrings([
    ...(input.campaignPolicy?.dispatch?.requiredHostCapabilities ?? []),
    ...(input.issuePolicy?.dispatch?.requiredHostCapabilities ?? []),
  ]);
  const dispatch = mergeDispatchPolicy({
    campaignDispatch: input.campaignPolicy?.dispatch,
    issueDispatch: input.issuePolicy?.dispatch,
    requiredHostCapabilities,
  });

  const merged: HarnessPolicy = {
    ...(input.campaignPolicy?.owner !== undefined ||
    input.issuePolicy?.owner !== undefined
      ? { owner: input.issuePolicy?.owner ?? input.campaignPolicy?.owner }
      : {}),
    ...(serviceLevel.responseWithinMinutes !== undefined ||
    serviceLevel.resolveWithinMinutes !== undefined
      ? { serviceLevel }
      : {}),
    ...(escalationRules.length > 0 ? { escalationRules } : {}),
    ...(dispatch !== undefined ? { dispatch } : {}),
  };

  return Object.keys(merged).length === 0 ? undefined : merged;
}

export function buildIssuePolicySurface(
  row: PolicyCarrierRow,
  now = new Date().toISOString(),
): IssuePolicySurface {
  const basePriority = normalizeIssuePriority(row.priority);
  const workflowMetadata = buildWorkItemMetadataSurface(row);
  const effectivePolicy = resolveEffectiveHarnessPolicy({
    campaignPolicy: parseHarnessPolicy(row.campaign_policy_json),
    issuePolicy: parseHarnessPolicy(row.policy_json),
  });

  if (effectivePolicy === undefined) {
    return {};
  }

  const breaches = evaluateBreaches({
    createdAt: row.created_at ?? undefined,
    status: row.status,
    deadlineAt: workflowMetadata?.deadlineAt,
    policy: effectivePolicy,
    now,
  });
  const effectivePriority = breaches.reduce<IssuePriority>(
    (current, breach) => {
      if (breach.action !== 'raise_priority' || breach.priority === undefined) {
        return current;
      }

      return rankForPriority(breach.priority) < rankForPriority(current)
        ? breach.priority
        : current;
    },
    basePriority,
  );

  return {
    policy: effectivePolicy,
    policyState: {
      effectivePriority,
      escalated:
        effectivePriority !== basePriority ||
        breaches.some((breach) => breach.action !== 'none'),
      breaches,
    },
  };
}

export function normalizeHarnessHostCapabilities(
  hostCapabilities: HarnessHostCapabilities,
): HarnessHostCapabilities {
  return {
    workloadClasses: uniqueStrings(hostCapabilities.workloadClasses),
    ...(hostCapabilities.capabilities !== undefined
      ? {
          capabilities: uniqueStrings(hostCapabilities.capabilities),
        }
      : {}),
  };
}

export function evaluateIssueDispatchState(
  row: PolicyCarrierRow,
  hostCapabilities: HarnessHostCapabilities,
): IssueDispatchState {
  const effectivePolicy = resolveEffectiveHarnessPolicy({
    campaignPolicy: parseHarnessPolicy(row.campaign_policy_json),
    issuePolicy: parseHarnessPolicy(row.policy_json),
  });

  return evaluateHarnessDispatchPolicy(
    effectivePolicy?.dispatch,
    normalizeHarnessHostCapabilities(hostCapabilities),
  );
}

export function evaluateHarnessDispatchPolicy(
  dispatchPolicy: HarnessDispatchPolicy | undefined,
  hostCapabilities: HarnessHostCapabilities,
): IssueDispatchState {
  const normalizedHostCapabilities = normalizeHarnessHostCapabilities(hostCapabilities);
  const requiredHostCapabilities = dispatchPolicy?.requiredHostCapabilities ?? [];
  const requiredWorkloadClass = dispatchPolicy?.workloadClass;
  const missingWorkloadClass =
    requiredWorkloadClass !== undefined &&
    !normalizedHostCapabilities.workloadClasses.includes(requiredWorkloadClass)
      ? requiredWorkloadClass
      : undefined;
  const availableCapabilities = normalizedHostCapabilities.capabilities ?? [];
  const missingHostCapabilities = requiredHostCapabilities.filter(
    (capability) => !availableCapabilities.includes(capability),
  );

  return {
    eligible:
      missingWorkloadClass === undefined && missingHostCapabilities.length === 0,
    ...(requiredWorkloadClass !== undefined ? { requiredWorkloadClass } : {}),
    requiredHostCapabilities,
    ...(missingWorkloadClass !== undefined ? { missingWorkloadClass } : {}),
    missingHostCapabilities,
  };
}

export function sortIssuesForDispatch<T extends PolicyCarrierRow>(
  rows: readonly T[],
  now = new Date().toISOString(),
): T[] {
  const decorated = rows.map((row) => {
    const policySurface = buildIssuePolicySurface(row, now);
    const workflowMetadata = buildWorkItemMetadataSurface(row);
    const effectivePriority =
      policySurface.policyState?.effectivePriority ??
      normalizeIssuePriority(row.priority);

    return {
      row,
      policySurface,
      effectivePriorityRank: rankForPriority(effectivePriority),
      dispatchScore:
        rankForPriority(effectivePriority) - computeAgingBoost(row.created_at, now),
      deadlineAt: workflowMetadata?.deadlineAt,
      breachCount: policySurface.policyState?.breaches.length ?? 0,
      createdAt: row.created_at ?? '',
    };
  });

  decorated.sort((left, right) => {
    if (left.dispatchScore !== right.dispatchScore) {
      return left.dispatchScore - right.dispatchScore;
    }

    if (left.effectivePriorityRank !== right.effectivePriorityRank) {
      return left.effectivePriorityRank - right.effectivePriorityRank;
    }

    const deadlineComparison = compareOptionalIsoDate(
      left.deadlineAt,
      right.deadlineAt,
    );

    if (deadlineComparison !== 0) {
      return deadlineComparison;
    }

    if (left.breachCount !== right.breachCount) {
      return right.breachCount - left.breachCount;
    }

    const createdAtComparison = compareOptionalIsoDate(
      left.createdAt,
      right.createdAt,
    );

    if (createdAtComparison !== 0) {
      return createdAtComparison;
    }

    return left.row.id.localeCompare(right.row.id);
  });

  return decorated.map((entry) => entry.row);
}

function evaluateBreaches(input: {
  createdAt?: string;
  status: string;
  deadlineAt?: string;
  policy: HarnessPolicy;
  now: string;
}): IssuePolicyBreach[] {
  const rules = input.policy.escalationRules ?? [];
  const breaches: IssuePolicyBreach[] = [];

  if (input.deadlineAt !== undefined && isIsoDateBefore(input.deadlineAt, input.now)) {
    breaches.push(
      ...buildBreachEntries(
        'deadline_breached',
        input.deadlineAt,
        rules,
        input.now,
      ),
    );
  }

  if (
    input.policy.serviceLevel?.responseWithinMinutes !== undefined &&
    input.createdAt !== undefined &&
    responseTrackedStatuses.has(input.status)
  ) {
    const responseBreachAt = addMinutes(
      input.createdAt,
      input.policy.serviceLevel.responseWithinMinutes,
    );

    if (responseBreachAt !== undefined && isIsoDateBefore(responseBreachAt, input.now)) {
      breaches.push(
        ...buildBreachEntries(
          'response_sla_breached',
          responseBreachAt,
          rules,
          input.now,
        ),
      );
    }
  }

  if (
    input.policy.serviceLevel?.resolveWithinMinutes !== undefined &&
    input.createdAt !== undefined &&
    !resolveSatisfiedStatuses.has(input.status)
  ) {
    const resolveBreachAt = addMinutes(
      input.createdAt,
      input.policy.serviceLevel.resolveWithinMinutes,
    );

    if (resolveBreachAt !== undefined && isIsoDateBefore(resolveBreachAt, input.now)) {
      breaches.push(
        ...buildBreachEntries(
          'resolve_sla_breached',
          resolveBreachAt,
          rules,
          input.now,
        ),
      );
    }
  }

  return breaches;
}

function buildBreachEntries(
  trigger: HarnessPolicyEscalationTrigger,
  breachedAt: string,
  escalationRules: HarnessPolicyEscalationRule[],
  now: string,
): IssuePolicyBreach[] {
  const matchingRules = escalationRules.filter((rule) => rule.trigger === trigger);
  const minutesOverdue = diffMinutes(breachedAt, now);

  if (matchingRules.length === 0) {
    return [
      {
        trigger,
        breachedAt,
        minutesOverdue,
        action: 'none',
      },
    ];
  }

  return matchingRules.map((rule) => ({
    trigger,
    breachedAt,
    minutesOverdue,
    action: rule.action,
    priority: rule.priority,
    note: rule.note,
  }));
}

function mergeDispatchPolicy(input: {
  campaignDispatch?: HarnessDispatchPolicy;
  issueDispatch?: HarnessDispatchPolicy;
  requiredHostCapabilities: string[];
}): HarnessDispatchPolicy | undefined {
  const workloadClass =
    input.issueDispatch?.workloadClass ?? input.campaignDispatch?.workloadClass;

  if (workloadClass === undefined) {
    return undefined;
  }

  return {
    workloadClass,
    ...(input.requiredHostCapabilities.length > 0
      ? { requiredHostCapabilities: input.requiredHostCapabilities }
      : {}),
  };
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function computeAgingBoost(createdAt: string | null | undefined, now: string): number {
  if (createdAt === undefined || createdAt === null || createdAt === '') {
    return 0;
  }

  const createdAtMs = Date.parse(createdAt);
  const nowMs = Date.parse(now);

  if (!Number.isFinite(createdAtMs) || !Number.isFinite(nowMs) || nowMs <= createdAtMs) {
    return 0;
  }

  return Math.floor((nowMs - createdAtMs) / (24 * 60 * 60 * 1000));
}

function diffMinutes(from: string, to: string): number {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);

  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    return 0;
  }

  return Math.floor((toMs - fromMs) / (60 * 1000));
}

function addMinutes(dateString: string, minutes: number): string | undefined {
  const sourceMs = Date.parse(dateString);

  if (!Number.isFinite(sourceMs)) {
    return undefined;
  }

  return new Date(sourceMs + minutes * 60 * 1000).toISOString();
}

function compareOptionalIsoDate(
  left: string | null | undefined,
  right: string | null | undefined,
): number {
  if (!left && !right) {
    return 0;
  }

  if (!left) {
    return 1;
  }

  if (!right) {
    return -1;
  }

  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);

  if (!Number.isFinite(leftMs) && !Number.isFinite(rightMs)) {
    return 0;
  }

  if (!Number.isFinite(leftMs)) {
    return 1;
  }

  if (!Number.isFinite(rightMs)) {
    return -1;
  }

  return leftMs - rightMs;
}

function isIsoDateBefore(candidate: string, reference: string): boolean {
  const candidateMs = Date.parse(candidate);
  const referenceMs = Date.parse(reference);

  return (
    Number.isFinite(candidateMs) &&
    Number.isFinite(referenceMs) &&
    candidateMs < referenceMs
  );
}

function normalizeIssuePriority(priority: string): IssuePriority {
  return issuePriorityValues.includes(priority as IssuePriority)
    ? (priority as IssuePriority)
    : 'medium';
}

function rankForPriority(priority: IssuePriority): number {
  return priorityRank.get(priority) ?? priorityRank.get('medium') ?? 2;
}
