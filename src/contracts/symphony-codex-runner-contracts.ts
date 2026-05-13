import { z } from 'zod';

export const symphonyCodexRunnerContractVersion = '1.0.0';

export const symphonyCodexRunnerErrorCodeValues = [
  'codex_not_found',
  'invalid_workspace_cwd',
  'spawn_failed',
  'startup_timeout',
  'read_timeout',
  'turn_timeout',
  'transport_closed',
  'process_exited',
  'protocol_error',
  'malformed_response',
  'response_error',
  'turn_failed',
  'turn_cancelled',
  'turn_input_required',
] as const;

export const symphonyCodexRunnerPhaseValues = [
  'launch',
  'thread',
  'turn',
  'shutdown',
] as const;

export const symphonyCodexRunnerLaunchStatusValues = [
  'succeeded',
  'failed',
] as const;

export const symphonyCodexRunnerTurnStatusValues = [
  'succeeded',
  'failed',
] as const;

const nonEmptyString = z.string().min(1);
const positiveInteger = z.number().int().positive();
const nonNegativeInteger = z.number().int().min(0);
const isoDateTime = z.string().datetime({ offset: true });

export const symphonyCodexRunnerErrorCodeSchema = z.enum(
  symphonyCodexRunnerErrorCodeValues,
);
export const symphonyCodexRunnerPhaseSchema = z.enum(
  symphonyCodexRunnerPhaseValues,
);
export const symphonyCodexRunnerLaunchStatusSchema = z.enum(
  symphonyCodexRunnerLaunchStatusValues,
);
export const symphonyCodexRunnerTurnStatusSchema = z.enum(
  symphonyCodexRunnerTurnStatusValues,
);

export const symphonyCodexRunnerCommandSchema = z
  .object({
    command: nonEmptyString,
    args: z.array(nonEmptyString).default([]),
    cwd: nonEmptyString,
    env: z.record(z.string(), z.string()).default({}),
  })
  .strict();

export const symphonyCodexRunnerConfigSchema = z
  .object({
    command: nonEmptyString.default('codex app-server'),
    readTimeoutMs: positiveInteger.default(5_000),
    turnTimeoutMs: positiveInteger.default(3_600_000),
  })
  .strict();

export const symphonyCodexRunnerErrorSchema = z
  .object({
    code: symphonyCodexRunnerErrorCodeSchema,
    phase: symphonyCodexRunnerPhaseSchema,
    message: nonEmptyString,
    issues: z.array(nonEmptyString).default([]),
    codexCategory: nonEmptyString.optional(),
    details: z.record(z.string(), z.string()).default({}),
  })
  .strict();

export const symphonyCodexRunnerConversationRefSchema = z
  .object({
    runnerId: nonEmptyString,
    threadId: nonEmptyString,
  })
  .strict();

export const symphonyCodexRunnerTurnRefSchema = z
  .object({
    runnerId: nonEmptyString,
    sessionId: nonEmptyString,
    threadId: nonEmptyString,
    turnId: nonEmptyString,
  })
  .strict();

export const symphonyCodexRunnerLaunchResultSchema = z
  .object({
    contractVersion: z.literal(symphonyCodexRunnerContractVersion),
    status: symphonyCodexRunnerLaunchStatusSchema,
    command: symphonyCodexRunnerCommandSchema,
    startedAt: isoDateTime,
    completedAt: isoDateTime,
    durationMs: nonNegativeInteger,
    conversation: symphonyCodexRunnerConversationRefSchema.optional(),
    error: symphonyCodexRunnerErrorSchema.optional(),
    metadata: z.record(z.string(), z.string()).default({}),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === 'succeeded' && value.conversation === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'successful Codex runner launches require a conversation ref.',
        path: ['conversation'],
      });
    }

    if (value.status === 'succeeded' && value.error !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'successful Codex runner launches must not include an error.',
        path: ['error'],
      });
    }

    if (value.status === 'failed' && value.error === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'failed Codex runner launches require an error payload.',
        path: ['error'],
      });
    }
  });

export const symphonyCodexRunnerTurnResultSchema = z
  .object({
    contractVersion: z.literal(symphonyCodexRunnerContractVersion),
    status: symphonyCodexRunnerTurnStatusSchema,
    conversation: symphonyCodexRunnerConversationRefSchema,
    startedAt: isoDateTime,
    completedAt: isoDateTime,
    durationMs: nonNegativeInteger,
    turn: symphonyCodexRunnerTurnRefSchema.optional(),
    output: z.string().optional(),
    error: symphonyCodexRunnerErrorSchema.optional(),
    metadata: z.record(z.string(), z.string()).default({}),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === 'succeeded' && value.turn === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'successful Codex turns require a turn ref.',
        path: ['turn'],
      });
    }

    if (value.status === 'succeeded' && value.error !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'successful Codex turns must not include an error.',
        path: ['error'],
      });
    }

    if (value.status === 'failed' && value.error === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'failed Codex turns require an error payload.',
        path: ['error'],
      });
    }
  });

export type SymphonyCodexRunnerErrorCode = z.infer<
  typeof symphonyCodexRunnerErrorCodeSchema
>;
export type SymphonyCodexRunnerPhase = z.infer<
  typeof symphonyCodexRunnerPhaseSchema
>;
export type SymphonyCodexRunnerLaunchStatus = z.infer<
  typeof symphonyCodexRunnerLaunchStatusSchema
>;
export type SymphonyCodexRunnerTurnStatus = z.infer<
  typeof symphonyCodexRunnerTurnStatusSchema
>;
export type SymphonyCodexRunnerCommand = z.infer<
  typeof symphonyCodexRunnerCommandSchema
>;
export type SymphonyCodexRunnerConfig = z.infer<
  typeof symphonyCodexRunnerConfigSchema
>;
export type SymphonyCodexRunnerError = z.infer<
  typeof symphonyCodexRunnerErrorSchema
>;
export type SymphonyCodexRunnerConversationRef = z.infer<
  typeof symphonyCodexRunnerConversationRefSchema
>;
export type SymphonyCodexRunnerTurnRef = z.infer<
  typeof symphonyCodexRunnerTurnRefSchema
>;
export type SymphonyCodexRunnerLaunchResult = z.infer<
  typeof symphonyCodexRunnerLaunchResultSchema
>;
export type SymphonyCodexRunnerTurnResult = z.infer<
  typeof symphonyCodexRunnerTurnResultSchema
>;
