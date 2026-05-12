import { z } from 'zod';

export const symphonyWorkflowContractVersion = '1.0.0';

export const symphonyWorkflowErrorCodeValues = [
  'missing_workflow_file',
  'workflow_parse_error',
  'workflow_front_matter_not_a_map',
  'workflow_config_error',
  'template_parse_error',
  'template_render_error',
] as const;

export const symphonyWorkflowReloadStatusValues = [
  'loaded',
  'reloaded',
  'unchanged',
  'failed',
] as const;

const nonEmptyString = z.string().min(1);
const positiveInteger = z.number().int().positive();
const nonEmptyStringArray = z.array(nonEmptyString).min(1);

export const symphonyWorkflowErrorCodeSchema = z.enum(
  symphonyWorkflowErrorCodeValues,
);
export const symphonyWorkflowReloadStatusSchema = z.enum(
  symphonyWorkflowReloadStatusValues,
);

export const symphonyWorkflowTrackerConfigSchema = z
  .object({
    kind: nonEmptyString.optional(),
    endpoint: nonEmptyString.optional(),
    apiKey: nonEmptyString.optional(),
    projectSlug: nonEmptyString.optional(),
    activeStates: nonEmptyStringArray.default(['Todo', 'In Progress']),
    terminalStates: nonEmptyStringArray.default([
      'Closed',
      'Cancelled',
      'Canceled',
      'Duplicate',
      'Done',
    ]),
  })
  .strict();

export const symphonyWorkflowPollingConfigSchema = z
  .object({
    intervalMs: positiveInteger.default(30_000),
  })
  .strict();

export const symphonyWorkflowWorkspaceConfigSchema = z
  .object({
    root: nonEmptyString,
  })
  .strict();

export const symphonyWorkflowHooksConfigSchema = z
  .object({
    afterCreate: nonEmptyString.optional(),
    beforeRun: nonEmptyString.optional(),
    afterRun: nonEmptyString.optional(),
    beforeRemove: nonEmptyString.optional(),
    timeoutMs: positiveInteger.default(60_000),
  })
  .strict();

export const symphonyWorkflowAgentConfigSchema = z
  .object({
    maxConcurrentAgents: positiveInteger.default(10),
    maxTurns: positiveInteger.default(20),
    maxRetryBackoffMs: positiveInteger.default(300_000),
    maxConcurrentAgentsByState: z.record(z.string(), positiveInteger).default({}),
  })
  .strict();

export const symphonyWorkflowCodexConfigSchema = z
  .object({
    command: nonEmptyString.default('codex app-server'),
    approvalPolicy: z.unknown().optional(),
    threadSandbox: z.unknown().optional(),
    turnSandboxPolicy: z.unknown().optional(),
    turnTimeoutMs: positiveInteger.default(3_600_000),
    readTimeoutMs: positiveInteger.default(5_000),
    stallTimeoutMs: z.number().int().default(300_000),
  })
  .strict();

export const symphonyWorkflowConfigSchema = z
  .object({
    tracker: symphonyWorkflowTrackerConfigSchema.default({
      activeStates: ['Todo', 'In Progress'],
      terminalStates: ['Closed', 'Cancelled', 'Canceled', 'Duplicate', 'Done'],
    }),
    polling: symphonyWorkflowPollingConfigSchema.default({
      intervalMs: 30_000,
    }),
    workspace: symphonyWorkflowWorkspaceConfigSchema,
    hooks: symphonyWorkflowHooksConfigSchema.default({
      timeoutMs: 60_000,
    }),
    agent: symphonyWorkflowAgentConfigSchema.default({
      maxConcurrentAgents: 10,
      maxTurns: 20,
      maxRetryBackoffMs: 300_000,
      maxConcurrentAgentsByState: {},
    }),
    codex: symphonyWorkflowCodexConfigSchema.default({
      command: 'codex app-server',
      turnTimeoutMs: 3_600_000,
      readTimeoutMs: 5_000,
      stallTimeoutMs: 300_000,
    }),
  })
  .strict();

export const symphonyWorkflowSourceSchema = z
  .object({
    path: nonEmptyString,
    directory: nonEmptyString,
    hash: nonEmptyString,
    loadedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const symphonyWorkflowDocumentSchema = z
  .object({
    contractVersion: z.literal(symphonyWorkflowContractVersion),
    source: symphonyWorkflowSourceSchema,
    rawConfig: z.record(z.string(), z.unknown()),
    config: symphonyWorkflowConfigSchema,
    promptTemplate: z.string(),
  })
  .strict();

export const symphonyWorkflowReloadResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('loaded'),
      workflow: symphonyWorkflowDocumentSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('reloaded'),
      workflow: symphonyWorkflowDocumentSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('unchanged'),
      workflow: symphonyWorkflowDocumentSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('failed'),
      workflow: symphonyWorkflowDocumentSchema.optional(),
      error: z
        .object({
          code: symphonyWorkflowErrorCodeSchema,
          message: nonEmptyString,
          issues: z.array(nonEmptyString).default([]),
        })
        .strict(),
    })
    .strict(),
]);

export type SymphonyWorkflowErrorCode = z.infer<
  typeof symphonyWorkflowErrorCodeSchema
>;
export type SymphonyWorkflowConfig = z.infer<
  typeof symphonyWorkflowConfigSchema
>;
export type SymphonyWorkflowDocument = z.infer<
  typeof symphonyWorkflowDocumentSchema
>;
export type SymphonyWorkflowReloadResult = z.infer<
  typeof symphonyWorkflowReloadResultSchema
>;
