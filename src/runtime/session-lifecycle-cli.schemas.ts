import { z } from 'zod';

import { storedMemoryRecordSchema } from 'mem0-mcp';

export const taskStatusSchema = z.enum([
  'pending',
  'ready',
  'in_progress',
  'blocked',
  'needs_recovery',
  'done',
  'failed',
]);

export const publicMemoryRecordSchema = storedMemoryRecordSchema.omit({
  embedding: true,
});

export const memorySearchResultSchema = z
  .object({
    memory: publicMemoryRecordSchema,
    score: z.number(),
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
    runId: z.string().min(1),
    leaseId: z.string().min(1),
    leaseExpiresAt: z.string().datetime({ offset: true }),
    issueId: z.string().min(1),
    issueTask: z.string().min(1),
    claimMode: z.enum(['claim', 'resume', 'recovery']),
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

export const incrementalSessionInputSchema = z
  .object({
    sessionId: z.string().min(1),
    dbPath: z.string().min(1).optional(),
    workspaceId: z.string().min(1),
    projectId: z.string().min(1),
    progressPath: z.string().min(1),
    featureListPath: z.string().min(1),
    planPath: z.string().min(1),
    syncManifestPath: z.string().min(1),
    mem0Enabled: z.boolean(),
    campaignId: z.string().min(1).optional(),
    preferredIssueId: z.string().min(1).optional(),
    agentId: z.string().min(1).optional(),
    host: z.string().min(1).optional(),
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

export const sessionCheckpointInputSchema = z
  .object({
    title: z.string().min(1),
    summary: z.string().min(1),
    taskStatus: taskStatusSchema,
    nextStep: z.string().min(1),
    artifactIds: z.array(z.string().min(1)).optional(),
    persistToMem0: z.boolean().optional(),
    memoryKind: z
      .enum(['decision', 'preference', 'summary', 'artifact_context', 'note'])
      .optional(),
    memoryContent: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const sessionCloseInputSchema = sessionCheckpointInputSchema
  .extend({
    releaseLease: z.boolean().optional(),
  })
  .strict();

export const inspectOverviewInputSchema = z
  .object({
    dbPath: z.string().min(1).optional(),
    projectId: z.string().min(1),
    campaignId: z.string().min(1).optional(),
    runLimit: z.number().int().positive().max(100).optional(),
  })
  .strict();

export const inspectIssueInputSchema = z
  .object({
    dbPath: z.string().min(1).optional(),
    issueId: z.string().min(1),
    includeEvents: z.boolean().optional(),
    eventLimit: z.number().int().positive().max(100).optional(),
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
      action: z.literal('begin_incremental'),
      input: incrementalSessionInputSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('begin_recovery'),
      input: recoverySessionInputSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('checkpoint'),
      context: sessionContextSchema,
      input: sessionCheckpointInputSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('close'),
      context: sessionContextSchema,
      input: sessionCloseInputSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('inspect_overview'),
      input: inspectOverviewInputSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('inspect_issue'),
      input: inspectIssueInputSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('promote_queue'),
      input: queuePromotionInputSchema,
    })
    .strict(),
]);

export type SessionLifecycleCommand = z.infer<
  typeof sessionLifecycleCommandSchema
>;
