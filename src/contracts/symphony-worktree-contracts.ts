import { z } from 'zod';

import { orchestrationWorktreeSchema } from './orchestration-contracts.js';

export const symphonyWorktreeContractVersion = '1.0.0';

export const symphonyWorktreeOperationValues = [
  'create',
  'cleanup',
  'hook',
] as const;
export const symphonyWorktreeOperationStatusValues = [
  'succeeded',
  'failed',
  'skipped',
] as const;
export const symphonyWorktreeHookNameValues = [
  'afterCreate',
  'beforeRun',
  'afterRun',
  'beforeRemove',
] as const;
export const symphonyWorktreeCreateModeValues = [
  'built_in_then_after_create',
  'after_create_hook',
] as const;
export const symphonyWorktreeCleanupModeValues = [
  'built_in',
  'hook_then_builtin',
  'hook_managed',
] as const;
export const symphonyWorktreeArtifactKindValues = [
  'physical_worktree_manifest',
  'physical_worktree_command_log',
  'physical_worktree_cleanup_plan',
] as const;
export const symphonyWorktreeErrorCodeValues = [
  'invalid_worktree_candidate',
  'repo_root_unavailable',
  'workspace_root_unavailable',
  'path_containment_failed',
  'worktree_create_failed',
  'worktree_cleanup_failed',
  'hook_not_configured',
  'hook_failed',
  'command_failed',
  'command_timeout',
  'git_state_mismatch',
  'artifact_write_failed',
] as const;

const nonEmptyString = z.string().min(1);
const nonNegativeInteger = z.number().int().min(0);
const isoDateTime = z.string().datetime({ offset: true });
const sha256String = z.string().regex(/^[a-f0-9]{64}$/i);

export const symphonyWorktreeOperationSchema = z.enum(
  symphonyWorktreeOperationValues,
);
export const symphonyWorktreeOperationStatusSchema = z.enum(
  symphonyWorktreeOperationStatusValues,
);
export const symphonyWorktreeHookNameSchema = z.enum(
  symphonyWorktreeHookNameValues,
);
export const symphonyWorktreeCreateModeSchema = z.enum(
  symphonyWorktreeCreateModeValues,
);
export const symphonyWorktreeCleanupModeSchema = z.enum(
  symphonyWorktreeCleanupModeValues,
);
export const symphonyWorktreeArtifactKindSchema = z.enum(
  symphonyWorktreeArtifactKindValues,
);
export const symphonyWorktreeErrorCodeSchema = z.enum(
  symphonyWorktreeErrorCodeValues,
);

export const symphonyWorktreeCommandResultSchema = z
  .object({
    command: nonEmptyString,
    args: z.array(nonEmptyString),
    cwd: nonEmptyString,
    exitCode: z.number().int().nullable(),
    signal: nonEmptyString.optional(),
    timedOut: z.boolean().default(false),
    durationMs: nonNegativeInteger,
    stdout: z.string().default(''),
    stderr: z.string().default(''),
    skippedReason: nonEmptyString.optional(),
  })
  .strict();

export const symphonyWorktreeCleanupCommandSchema = z
  .object({
    type: z.enum(['remove_worktree', 'delete_branch', 'prune_worktrees']),
    cwd: nonEmptyString,
    argv: z.array(nonEmptyString),
  })
  .strict();

export const symphonyWorktreeArtifactSchema = z
  .object({
    kind: symphonyWorktreeArtifactKindSchema,
    path: nonEmptyString,
    sha256: sha256String.optional(),
  })
  .strict();

export const symphonyWorktreeIssueContextSchema = z
  .object({
    id: nonEmptyString,
    identifier: nonEmptyString.optional(),
    title: nonEmptyString.optional(),
    url: nonEmptyString.optional(),
    state: nonEmptyString.optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const symphonyWorktreeOperationErrorSchema = z
  .object({
    code: symphonyWorktreeErrorCodeSchema,
    message: nonEmptyString,
    issues: z.array(nonEmptyString).default([]),
    command: symphonyWorktreeCommandResultSchema.optional(),
  })
  .strict();

export const symphonyWorktreeOperationResultSchema = z
  .object({
    contractVersion: z.literal(symphonyWorktreeContractVersion),
    operation: symphonyWorktreeOperationSchema,
    status: symphonyWorktreeOperationStatusSchema,
    worktree: orchestrationWorktreeSchema,
    issue: symphonyWorktreeIssueContextSchema,
    createMode: symphonyWorktreeCreateModeSchema.optional(),
    cleanupMode: symphonyWorktreeCleanupModeSchema.optional(),
    hookName: symphonyWorktreeHookNameSchema.optional(),
    startedAt: isoDateTime,
    completedAt: isoDateTime,
    artifacts: z.array(symphonyWorktreeArtifactSchema).default([]),
    commands: z.array(symphonyWorktreeCommandResultSchema).default([]),
    cleanupCommands: z.array(symphonyWorktreeCleanupCommandSchema).default([]),
    reason: nonEmptyString.optional(),
    error: symphonyWorktreeOperationErrorSchema.optional(),
    metadata: z.record(z.string(), z.string()).default({}),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === 'failed' && value.error === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'failed operations require an error payload.',
        path: ['error'],
      });
    }

    if (value.status !== 'failed' && value.error !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'non-failed operations must not include an error payload.',
        path: ['error'],
      });
    }

    if (value.status === 'skipped' && value.reason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'skipped operations require a reason.',
        path: ['reason'],
      });
    }
  });

export type SymphonyWorktreeOperation = z.infer<
  typeof symphonyWorktreeOperationSchema
>;
export type SymphonyWorktreeOperationStatus = z.infer<
  typeof symphonyWorktreeOperationStatusSchema
>;
export type SymphonyWorktreeHookName = z.infer<
  typeof symphonyWorktreeHookNameSchema
>;
export type SymphonyWorktreeCreateMode = z.infer<
  typeof symphonyWorktreeCreateModeSchema
>;
export type SymphonyWorktreeCleanupMode = z.infer<
  typeof symphonyWorktreeCleanupModeSchema
>;
export type SymphonyWorktreeArtifactKind = z.infer<
  typeof symphonyWorktreeArtifactKindSchema
>;
export type SymphonyWorktreeErrorCode = z.infer<
  typeof symphonyWorktreeErrorCodeSchema
>;
export type SymphonyWorktreeCommandResult = z.infer<
  typeof symphonyWorktreeCommandResultSchema
>;
export type SymphonyWorktreeArtifact = z.infer<
  typeof symphonyWorktreeArtifactSchema
>;
export type SymphonyWorktreeIssueContext = z.infer<
  typeof symphonyWorktreeIssueContextSchema
>;
export type SymphonyWorktreeOperationError = z.infer<
  typeof symphonyWorktreeOperationErrorSchema
>;
export type SymphonyWorktreeOperationResult = z.infer<
  typeof symphonyWorktreeOperationResultSchema
>;
