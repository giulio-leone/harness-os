import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  memoryKindSchema,
  memorySearchResultSchema,
  publicMemoryRecordSchema,
} from '../contracts/memory-contracts.js';
import { taskStatusSchema } from '../contracts/task-domain.js';
import { harnessHostCapabilitiesSchema } from '../contracts/policy-contracts.js';
import { csqrLiteScorecardSchema } from '../contracts/csqr-lite-contracts.js';

export const SESSION_LIFECYCLE_CLI_CONTRACT_VERSION = '6.0.0' as const;

export const sessionArtifactReferenceSchema = z
  .object({
    id: z.string().min(1).optional(),
    kind: z.string().min(1),
    path: z.string().min(1),
  })
  .strict();

export const sessionCsqrLiteScorecardArtifactSchema = z
  .object({
    path: z.string().min(1),
    scorecard: csqrLiteScorecardSchema,
  })
  .strict();

export const sessionMemoryContextSchema = z
  .object({
    enabled: z.boolean(),
    available: z.boolean(),
    query: z.string(),
    details: z.string().optional(),
    recalledMemories: z.array(memorySearchResultSchema),
  })
  .strict();

export const sessionContextSchema = z
  .object({
    sessionId: z.string().min(1),
    dbPath: z.string().min(1).optional(),
    workspaceId: z.string().min(1),
    projectId: z.string().min(1),
    campaignId: z.string().min(1).optional(),
    agentId: z.string().min(1),
    host: z.string().min(1),
    hostCapabilities: harnessHostCapabilitiesSchema,
    runId: z.string().min(1),
    leaseId: z.string().min(1),
    leaseExpiresAt: z.string().datetime({ offset: true }),
    issueId: z.string().min(1),
    issueTask: z.string().min(1),
    claimMode: z.enum(['claim', 'resume', 'recovery']),
    artifacts: z.array(sessionArtifactReferenceSchema).min(1),
    scope: z
      .object({
        workspace: z.string().min(1),
        project: z.string().min(1),
        campaign: z.string().min(1).optional(),
        task: z.string().min(1).optional(),
        run: z.string().min(1).optional(),
      })
      .strict(),
    currentTaskStatus: taskStatusSchema,
    currentCheckpointId: z.string().uuid(),
    mem0: sessionMemoryContextSchema,
  })
  .strict();

const beginSessionIdSchema = z
  .string()
  .min(1)
  .optional()
  .transform((value) => value ?? `RUN-${randomUUID()}`);

export const incrementalSessionInputSchema = z
  .object({
    sessionId: beginSessionIdSchema,
    dbPath: z.string().min(1).optional(),
    workspaceId: z.string().min(1),
    projectId: z.string().min(1),
    artifacts: z.array(sessionArtifactReferenceSchema).min(1),
    mem0Enabled: z.boolean(),
    campaignId: z.string().min(1).optional(),
    preferredIssueId: z.string().min(1).optional(),
    agentId: z.string().min(1).optional(),
    host: z.string().min(1),
    hostCapabilities: harnessHostCapabilitiesSchema,
    leaseTtlSeconds: z.number().int().positive().optional(),
    checkpointFreshnessSeconds: z.number().int().positive().optional(),
    memoryQuery: z.string().min(1).optional(),
    memorySearchLimit: z.number().int().positive().max(25).optional(),
  })
  .strict();

export const recoverySessionInputSchema = incrementalSessionInputSchema
  .extend({
    recoverySummary: z.string().min(1),
    recoveryNextStep: z.string().min(1).optional(),
  })
  .strict();

const sessionCheckpointInputBaseSchema = z
  .object({
    title: z.string().min(1),
    summary: z.string().min(1),
    taskStatus: taskStatusSchema,
    nextStep: z.string().min(1),
    blockedReason: z.string().min(1).optional(),
    artifactIds: z.array(z.string().min(1)).optional(),
    csqrLiteScorecards: z
      .array(sessionCsqrLiteScorecardArtifactSchema)
      .min(1)
      .optional(),
    persistToMem0: z.boolean().optional(),
    memoryKind: memoryKindSchema.optional(),
    memoryContent: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict();

function withBlockedReasonValidation<
  TSchema extends z.ZodType<{
    taskStatus: z.infer<typeof taskStatusSchema>;
    blockedReason?: string;
  }>
>(schema: TSchema): TSchema {
  return schema.superRefine((input, ctx) => {
    if (input.blockedReason !== undefined && input.taskStatus !== 'blocked') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['blockedReason'],
        message: 'blockedReason can only be provided when taskStatus is blocked.',
      });
    }
  }) as TSchema;
}

export const sessionCheckpointInputSchema = withBlockedReasonValidation(
  sessionCheckpointInputBaseSchema,
);

export const sessionCloseInputSchema = withBlockedReasonValidation(
  sessionCheckpointInputBaseSchema
    .extend({
      releaseLease: z.boolean().optional(),
    })
    .strict(),
);

export const inspectExportInputSchema = z
  .object({
    dbPath: z.string().min(1).optional(),
    projectId: z.string().min(1),
    campaignId: z.string().min(1).optional(),
    runLimit: z.number().int().positive().max(100).optional(),
    eventLimit: z.number().int().positive().max(100).optional(),
  })
  .strict();

export const inspectAuditInputSchema = z
  .object({
    dbPath: z.string().min(1).optional(),
    issueId: z.string().min(1),
    eventLimit: z.number().int().positive().max(100).optional(),
  })
  .strict();

export const inspectHealthSnapshotInputSchema = z
  .object({
    dbPath: z.string().min(1).optional(),
    projectId: z.string().min(1),
    campaignId: z.string().min(1).optional(),
  })
  .strict();

export const queuePromotionInputSchema = z
  .object({
    dbPath: z.string().min(1).optional(),
    projectId: z.string().min(1),
    campaignId: z.string().min(1).optional(),
  })
  .strict();

export const sessionLifecycleCommandSchema = z.discriminatedUnion('action', [
  z
    .object({
      contractVersion: z.literal(SESSION_LIFECYCLE_CLI_CONTRACT_VERSION),
      action: z.literal('begin_incremental'),
      input: incrementalSessionInputSchema,
    })
    .strict(),
  z
    .object({
      contractVersion: z.literal(SESSION_LIFECYCLE_CLI_CONTRACT_VERSION),
      action: z.literal('begin_recovery'),
      input: recoverySessionInputSchema,
    })
    .strict(),
  z
    .object({
      contractVersion: z.literal(SESSION_LIFECYCLE_CLI_CONTRACT_VERSION),
      action: z.literal('checkpoint'),
      context: sessionContextSchema,
      input: sessionCheckpointInputSchema,
    })
    .strict(),
  z
    .object({
      contractVersion: z.literal(SESSION_LIFECYCLE_CLI_CONTRACT_VERSION),
      action: z.literal('close'),
      context: sessionContextSchema,
      input: sessionCloseInputSchema,
    })
    .strict(),
  z
    .object({
      contractVersion: z.literal(SESSION_LIFECYCLE_CLI_CONTRACT_VERSION),
      action: z.literal('inspect_export'),
      input: inspectExportInputSchema,
    })
    .strict(),
  z
    .object({
      contractVersion: z.literal(SESSION_LIFECYCLE_CLI_CONTRACT_VERSION),
      action: z.literal('inspect_audit'),
      input: inspectAuditInputSchema,
    })
    .strict(),
  z
    .object({
      contractVersion: z.literal(SESSION_LIFECYCLE_CLI_CONTRACT_VERSION),
      action: z.literal('inspect_health_snapshot'),
      input: inspectHealthSnapshotInputSchema,
    })
    .strict(),
  z
    .object({
      contractVersion: z.literal(SESSION_LIFECYCLE_CLI_CONTRACT_VERSION),
      action: z.literal('promote_queue'),
      input: queuePromotionInputSchema,
    })
    .strict(),
]);

export type SessionLifecycleCommand = z.infer<
  typeof sessionLifecycleCommandSchema
>;
