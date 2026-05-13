import { z } from 'zod';

export const symphonyCodexRunnerContractVersion = '1.0.0';

export const symphonyCodexRunnerErrorCodeValues = [
  'codex_not_found',
  'invalid_workspace_cwd',
  'spawn_failed',
  'startup_timeout',
  'read_timeout',
  'turn_timeout',
  'stall_timeout',
  'transport_closed',
  'process_exited',
  'protocol_error',
  'malformed_response',
  'response_error',
  'turn_failed',
  'turn_cancelled',
  'turn_input_required',
  'approval_declined',
  'rate_limit',
  'server_overloaded',
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

export const symphonyCodexRunnerEventKindValues = [
  'turn_started',
  'turn_progress',
  'approval_requested',
  'approval_auto_approved',
  'user_input_required',
  'rate_limit_updated',
  'token_usage_updated',
  'retry_scheduled',
  'backoff_scheduled',
  'turn_completed',
  'turn_failed',
  'turn_cancelled',
  'notification',
  'other_message',
] as const;

export const symphonyCodexRunnerTelemetryKindValues = [
  'token_usage',
  'rate_limit',
  'retry_backoff',
  'stall',
  'pending_request',
] as const;

export const symphonyCodexRunnerPendingRequestKindValues = [
  'command_approval',
  'file_change_approval',
  'user_input',
] as const;

export const symphonyCodexRunnerPendingRequestStatusValues = [
  'pending',
  'resolved',
  'expired',
  'failed',
] as const;

export const symphonyCodexRunnerContinuationReasonValues = [
  'clean_exit',
  'stall_timeout',
  'retryable_failure',
  'approval',
  'user_input',
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
export const symphonyCodexRunnerEventKindSchema = z.enum(
  symphonyCodexRunnerEventKindValues,
);
export const symphonyCodexRunnerTelemetryKindSchema = z.enum(
  symphonyCodexRunnerTelemetryKindValues,
);
export const symphonyCodexRunnerPendingRequestKindSchema = z.enum(
  symphonyCodexRunnerPendingRequestKindValues,
);
export const symphonyCodexRunnerPendingRequestStatusSchema = z.enum(
  symphonyCodexRunnerPendingRequestStatusValues,
);
export const symphonyCodexRunnerContinuationReasonSchema = z.enum(
  symphonyCodexRunnerContinuationReasonValues,
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
    stallTimeoutMs: nonNegativeInteger.default(300_000),
    continuationDelayMs: positiveInteger.default(1_000),
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

export const symphonyCodexRunnerTokenUsageSchema = z
  .object({
    inputTokens: nonNegativeInteger,
    outputTokens: nonNegativeInteger,
    totalTokens: nonNegativeInteger,
  })
  .strict();

export const symphonyCodexRunnerRateLimitSnapshotSchema = z
  .object({
    family: nonEmptyString,
    name: nonEmptyString.optional(),
    used: nonNegativeInteger.optional(),
    limit: nonNegativeInteger.optional(),
    remaining: nonNegativeInteger.optional(),
    resetAt: isoDateTime.optional(),
    metadata: z.record(z.string(), z.string()).default({}),
  })
  .strict();

export const symphonyCodexRunnerPendingRequestSchema = z
  .object({
    kind: symphonyCodexRunnerPendingRequestKindSchema,
    status: symphonyCodexRunnerPendingRequestStatusSchema,
    requestId: nonEmptyString.optional(),
    itemId: nonEmptyString.optional(),
    threadId: nonEmptyString,
    turnId: nonEmptyString,
    startedAt: isoDateTime,
    resolvedAt: isoDateTime.optional(),
    reason: z.string().optional(),
    questions: z.array(nonEmptyString).default([]),
    availableDecisions: z.array(nonEmptyString).default([]),
    metadata: z.record(z.string(), z.string()).default({}),
  })
  .strict();

export const symphonyCodexRunnerEventRecordSchema = z
  .object({
    contractVersion: z.literal(symphonyCodexRunnerContractVersion),
    eventId: nonEmptyString,
    kind: symphonyCodexRunnerEventKindSchema,
    observedAt: isoDateTime,
    conversation: symphonyCodexRunnerConversationRefSchema,
    turn: symphonyCodexRunnerTurnRefSchema.optional(),
    message: z.string().optional(),
    tokenUsage: symphonyCodexRunnerTokenUsageSchema.optional(),
    rateLimit: symphonyCodexRunnerRateLimitSnapshotSchema.optional(),
    pendingRequest: symphonyCodexRunnerPendingRequestSchema.optional(),
    attempt: positiveInteger.optional(),
    delayMs: nonNegativeInteger.optional(),
    retryAfterMs: nonNegativeInteger.optional(),
    metadata: z.record(z.string(), z.string()).default({}),
  })
  .strict();

export const symphonyCodexRunnerTelemetryRecordSchema = z
  .object({
    contractVersion: z.literal(symphonyCodexRunnerContractVersion),
    telemetryId: nonEmptyString,
    kind: symphonyCodexRunnerTelemetryKindSchema,
    observedAt: isoDateTime,
    conversation: symphonyCodexRunnerConversationRefSchema,
    turn: symphonyCodexRunnerTurnRefSchema.optional(),
    tokenUsage: symphonyCodexRunnerTokenUsageSchema.optional(),
    rateLimit: symphonyCodexRunnerRateLimitSnapshotSchema.optional(),
    pendingRequest: symphonyCodexRunnerPendingRequestSchema.optional(),
    reason: symphonyCodexRunnerContinuationReasonSchema.optional(),
    attempt: positiveInteger.optional(),
    delayMs: nonNegativeInteger.optional(),
    retryAfterMs: nonNegativeInteger.optional(),
    metadata: z.record(z.string(), z.string()).default({}),
  })
  .strict();

export const symphonyCodexRunnerSessionSnapshotSchema = z
  .object({
    contractVersion: z.literal(symphonyCodexRunnerContractVersion),
    conversation: symphonyCodexRunnerConversationRefSchema,
    currentTurn: symphonyCodexRunnerTurnRefSchema.optional(),
    turnCount: nonNegativeInteger,
    lastEventKind: symphonyCodexRunnerEventKindSchema.optional(),
    lastEventAt: isoDateTime.optional(),
    lastMessage: z.string().optional(),
    lastTokenUsage: symphonyCodexRunnerTokenUsageSchema.optional(),
    aggregateTokenUsage: symphonyCodexRunnerTokenUsageSchema.default({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    }),
    rateLimits: z.array(symphonyCodexRunnerRateLimitSnapshotSchema).default([]),
    pendingRequests: z.array(symphonyCodexRunnerPendingRequestSchema).default([]),
    metadata: z.record(z.string(), z.string()).default({}),
  })
  .strict();

export const symphonyCodexRunnerContinuationSchema = z
  .object({
    contractVersion: z.literal(symphonyCodexRunnerContractVersion),
    continuationOf: symphonyCodexRunnerTurnRefSchema,
    reason: symphonyCodexRunnerContinuationReasonSchema,
    attempt: positiveInteger,
    delayMs: nonNegativeInteger,
    retryAfterMs: nonNegativeInteger.optional(),
    prompt: z.string().optional(),
    metadata: z.record(z.string(), z.string()).default({}),
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

export const symphonyCodexRunnerTurnExecutionEnvelopeSchema = z
  .object({
    contractVersion: z.literal(symphonyCodexRunnerContractVersion),
    result: symphonyCodexRunnerTurnResultSchema,
    events: z.array(symphonyCodexRunnerEventRecordSchema).default([]),
    telemetry: z.array(symphonyCodexRunnerTelemetryRecordSchema).default([]),
    session: symphonyCodexRunnerSessionSnapshotSchema,
    continuation: symphonyCodexRunnerContinuationSchema.optional(),
    metadata: z.record(z.string(), z.string()).default({}),
  })
  .strict();

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
export type SymphonyCodexRunnerEventKind = z.infer<
  typeof symphonyCodexRunnerEventKindSchema
>;
export type SymphonyCodexRunnerTelemetryKind = z.infer<
  typeof symphonyCodexRunnerTelemetryKindSchema
>;
export type SymphonyCodexRunnerPendingRequestKind = z.infer<
  typeof symphonyCodexRunnerPendingRequestKindSchema
>;
export type SymphonyCodexRunnerPendingRequestStatus = z.infer<
  typeof symphonyCodexRunnerPendingRequestStatusSchema
>;
export type SymphonyCodexRunnerContinuationReason = z.infer<
  typeof symphonyCodexRunnerContinuationReasonSchema
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
export type SymphonyCodexRunnerTokenUsage = z.infer<
  typeof symphonyCodexRunnerTokenUsageSchema
>;
export type SymphonyCodexRunnerRateLimitSnapshot = z.infer<
  typeof symphonyCodexRunnerRateLimitSnapshotSchema
>;
export type SymphonyCodexRunnerPendingRequest = z.infer<
  typeof symphonyCodexRunnerPendingRequestSchema
>;
export type SymphonyCodexRunnerEventRecord = z.infer<
  typeof symphonyCodexRunnerEventRecordSchema
>;
export type SymphonyCodexRunnerTelemetryRecord = z.infer<
  typeof symphonyCodexRunnerTelemetryRecordSchema
>;
export type SymphonyCodexRunnerSessionSnapshot = z.infer<
  typeof symphonyCodexRunnerSessionSnapshotSchema
>;
export type SymphonyCodexRunnerContinuation = z.infer<
  typeof symphonyCodexRunnerContinuationSchema
>;
export type SymphonyCodexRunnerTurnExecutionEnvelope = z.infer<
  typeof symphonyCodexRunnerTurnExecutionEnvelopeSchema
>;
