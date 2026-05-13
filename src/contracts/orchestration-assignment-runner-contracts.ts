import { isAbsolute, relative } from 'node:path';

import { z } from 'zod';

import {
  memoryScopeSchema,
  memorySearchResultSchema,
} from './memory-contracts.js';
import {
  orchestrationAssignmentSchema,
  orchestrationAssignmentRunnerConfigSchema,
  orchestrationAssignmentRunnerEvidenceArtifactKindSchema,
  orchestrationAssignmentRunnerEvidenceArtifactKindValues,
  orchestrationAssignmentRunnerWorkspaceModeSchema,
  orchestrationAssignmentRunnerWorkspaceModeValues,
  orchestrationEvidenceArtifactKindSchema,
  orchestrationSubagentSchema,
  orchestrationWorktreeSchema,
  type OrchestrationAssignmentRunnerConfig,
  type OrchestrationAssignmentRunnerEvidenceArtifactKind,
  type OrchestrationAssignmentRunnerWorkspaceMode,
} from './orchestration-contracts.js';
import { harnessHostCapabilitiesSchema } from './policy-contracts.js';
import { symphonyWorktreeCommandResultSchema } from './symphony-worktree-contracts.js';

export const symphonyAssignmentRunnerContractVersion = '1.0.0';

const nonEmptyString = z.string().min(1);
const nonNegativeInteger = z.number().int().min(0);
const isoDateTime = z.string().datetime({ offset: true });

export const symphonyAssignmentRunnerStatusValues = [
  'succeeded',
  'failed',
] as const;

export const symphonyAssignmentRunnerWorkspaceModeValues =
  orchestrationAssignmentRunnerWorkspaceModeValues;
export const symphonyAssignmentRunnerEvidenceArtifactKindValues =
  orchestrationAssignmentRunnerEvidenceArtifactKindValues;

export const symphonyAssignmentRunnerStatusSchema = z.enum(
  symphonyAssignmentRunnerStatusValues,
);
export const symphonyAssignmentRunnerWorkspaceModeSchema =
  orchestrationAssignmentRunnerWorkspaceModeSchema;
export const symphonyAssignmentRunnerEvidenceArtifactKindSchema =
  orchestrationAssignmentRunnerEvidenceArtifactKindSchema;

const artifactReferenceSchema = z
  .object({
    id: nonEmptyString.optional(),
    kind: nonEmptyString,
    path: nonEmptyString,
  })
  .strict();

const sessionMemoryContextSchema = z
  .object({
    enabled: z.boolean(),
    available: z.boolean(),
    query: nonEmptyString,
    details: nonEmptyString.optional(),
    recalledMemories: z.array(memorySearchResultSchema).default([]),
  })
  .strict();

export const symphonyAssignmentRunnerSessionContextSchema = z
  .object({
    sessionId: nonEmptyString,
    dbPath: nonEmptyString,
    workspaceId: nonEmptyString,
    projectId: nonEmptyString,
    campaignId: nonEmptyString.optional(),
    agentId: nonEmptyString,
    host: nonEmptyString,
    hostCapabilities: harnessHostCapabilitiesSchema,
    runId: nonEmptyString,
    leaseId: nonEmptyString,
    leaseExpiresAt: nonEmptyString,
    issueId: nonEmptyString,
    issueTask: nonEmptyString,
    claimMode: z.enum(['claim', 'resume', 'recovery']),
    artifacts: z.array(artifactReferenceSchema),
    scope: memoryScopeSchema,
    currentTaskStatus: z.enum([
      'pending',
      'ready',
      'in_progress',
      'blocked',
      'needs_recovery',
      'done',
      'failed',
    ]),
    currentCheckpointId: nonEmptyString,
    mem0: sessionMemoryContextSchema,
  })
  .strict();

export const symphonyAssignmentRunnerIssueSchema = z
  .object({
    id: nonEmptyString,
    task: nonEmptyString,
    priority: nonEmptyString.optional(),
    status: nonEmptyString.optional(),
  })
  .strict();

export const symphonyAssignmentRunnerConfigSchema =
  orchestrationAssignmentRunnerConfigSchema;

export const symphonyAssignmentRunnerInputSchema = z
  .object({
    contractVersion: z.literal(symphonyAssignmentRunnerContractVersion),
    assignment: orchestrationAssignmentSchema,
    issue: symphonyAssignmentRunnerIssueSchema,
    subagent: orchestrationSubagentSchema,
    worktree: orchestrationWorktreeSchema,
    session: symphonyAssignmentRunnerSessionContextSchema,
    runner: symphonyAssignmentRunnerConfigSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.assignment.issueId !== value.issue.id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'assignment.issueId must match issue.id.',
        path: ['assignment', 'issueId'],
      });
    }
    if (value.assignment.subagentId !== value.subagent.id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'assignment.subagentId must match subagent.id.',
        path: ['assignment', 'subagentId'],
      });
    }
    if (value.assignment.worktreeId !== value.worktree.id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'assignment.worktreeId must match worktree.id.',
        path: ['assignment', 'worktreeId'],
      });
    }
    if (value.session.issueId !== value.issue.id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'session.issueId must match issue.id.',
        path: ['session', 'issueId'],
      });
    }
  });

export const symphonyAssignmentRunnerEvidenceArtifactSchema = z
  .object({
    id: nonEmptyString,
    kind: orchestrationEvidenceArtifactKindSchema,
    path: nonEmptyString,
    metadata: z.record(z.string(), z.string()).default({}),
  })
  .strict();

export const symphonyAssignmentRunnerResultSchema = z
  .object({
    contractVersion: z.literal(symphonyAssignmentRunnerContractVersion),
    assignmentId: nonEmptyString,
    issueId: nonEmptyString,
    runId: nonEmptyString,
    status: symphonyAssignmentRunnerStatusSchema,
    startedAt: isoDateTime,
    completedAt: isoDateTime,
    commandResult: symphonyWorktreeCommandResultSchema.optional(),
    evidenceArtifacts: z
      .array(symphonyAssignmentRunnerEvidenceArtifactSchema)
      .default([]),
    evidenceArtifactIds: z.array(nonEmptyString).default([]),
    csqrLiteScorecardArtifactIds: z.array(nonEmptyString).default([]),
    checkpointId: nonEmptyString.optional(),
    summary: nonEmptyString,
    error: nonEmptyString.optional(),
    durationMs: nonNegativeInteger,
  })
  .strict()
  .superRefine((value, ctx) => {
    validateUniqueStrings(value.evidenceArtifactIds, 'evidenceArtifactIds', ctx);
    validateUniqueStrings(
      value.csqrLiteScorecardArtifactIds,
      'csqrLiteScorecardArtifactIds',
      ctx,
    );
    validateUniqueStrings(
      value.evidenceArtifacts.map((artifact) => artifact.id),
      'evidenceArtifacts',
      ctx,
    );

    const artifactIds = new Set(
      value.evidenceArtifacts.map((artifact) => artifact.id),
    );
    value.evidenceArtifactIds.forEach((artifactId, index) => {
      if (artifactIds.has(artifactId)) {
        return;
      }
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unknown evidence artifact "${artifactId}".`,
        path: ['evidenceArtifactIds', index],
      });
    });

    if (value.status === 'failed' && value.error === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'failed assignment runner results require an error.',
        path: ['error'],
      });
    }
  });

export type SymphonyAssignmentRunnerStatus = z.infer<
  typeof symphonyAssignmentRunnerStatusSchema
>;
export type SymphonyAssignmentRunnerWorkspaceMode =
  OrchestrationAssignmentRunnerWorkspaceMode;
export type SymphonyAssignmentRunnerEvidenceArtifactKind =
  OrchestrationAssignmentRunnerEvidenceArtifactKind;
export type SymphonyAssignmentRunnerSessionContext = z.infer<
  typeof symphonyAssignmentRunnerSessionContextSchema
>;
export type SymphonyAssignmentRunnerIssue = z.infer<
  typeof symphonyAssignmentRunnerIssueSchema
>;
export type SymphonyAssignmentRunnerConfig = OrchestrationAssignmentRunnerConfig;
export type SymphonyAssignmentRunnerInput = z.infer<
  typeof symphonyAssignmentRunnerInputSchema
>;
export type SymphonyAssignmentRunnerEvidenceArtifact = z.infer<
  typeof symphonyAssignmentRunnerEvidenceArtifactSchema
>;
export type SymphonyAssignmentRunnerResult = z.infer<
  typeof symphonyAssignmentRunnerResultSchema
>;

export function isPathInside(parent: string, child: string): boolean {
  const relativePath = relative(parent, child);
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !isAbsolute(relativePath))
  );
}

function validateUniqueStrings(
  values: ReadonlyArray<string> | undefined,
  path: string,
  ctx: z.core.$RefinementCtx,
): void {
  if (values === undefined) {
    return;
  }

  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (!seen.has(value)) {
      seen.add(value);
      return;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Duplicate value "${value}".`,
      path: [path, index],
    });
  });
}
