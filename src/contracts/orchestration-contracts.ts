import { isAbsolute, normalize, relative } from 'node:path';

import { z } from 'zod';

import { evaluateCsqrLiteCompletionGate } from './csqr-lite-completion-gate.js';
import { csqrLiteScorecardSchema } from './csqr-lite-contracts.js';
import { orchestrationDashboardIssueFiltersInputSchema } from './orchestration-dashboard-contracts.js';
import {
  harnessDispatchPolicySchema,
  harnessHostCapabilitiesSchema,
} from './policy-contracts.js';

const orchestrationContractVersion = '1.0.0';
const nonEmptyString = z.string().min(1);
const identifierString = nonEmptyString.regex(/^[A-Za-z0-9._:-]+$/);
const positiveInteger = z.number().int().positive();
const nonEmptyStringArray = z.array(nonEmptyString).min(1);
const sha256String = z.string().regex(/^[a-f0-9]{64}$/i);

export const orchestrationModelProfileValues = [
  'gpt-5-high',
  'gpt-5-standard',
  'gpt-5-fast',
  'custom',
] as const;

export const orchestrationWorktreeCleanupPolicyValues = [
  'retain',
  'delete_on_success',
  'delete_on_failure',
  'delete_on_completion',
] as const;

export const orchestrationEvidenceArtifactKindValues = [
  'audit_snapshot',
  'build_log',
  'ci_status',
  'codebase_ref',
  'coverage_report',
  'csqr_lite_scorecard',
  'diagnostic_log',
  'diff',
  'e2e_report',
  'review_feedback',
  'screenshot',
  'state_export',
  'test_report',
  'trace',
  'typecheck_report',
  'video',
] as const;

export const orchestrationEvidenceArtifactScopeValues = [
  'assignment',
  'run',
] as const;

export const orchestrationGateStatusValues = [
  'pending',
  'running',
  'passed',
  'failed',
  'error',
  'skipped',
] as const;

export const orchestrationDispatchStrategyValues = [
  'fanout',
  'sequential',
  'matrix',
] as const;

export const orchestrationRunStatusValues = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'partial',
] as const;

export const orchestrationModelProfileSchema = z.enum(
  orchestrationModelProfileValues,
);
export const orchestrationWorktreeCleanupPolicySchema = z.enum(
  orchestrationWorktreeCleanupPolicyValues,
);
export const orchestrationEvidenceArtifactKindSchema = z.enum(
  orchestrationEvidenceArtifactKindValues,
);
export const orchestrationEvidenceArtifactScopeSchema = z.enum(
  orchestrationEvidenceArtifactScopeValues,
);
export const orchestrationGateStatusSchema = z.enum(
  orchestrationGateStatusValues,
);
export const orchestrationDispatchStrategySchema = z.enum(
  orchestrationDispatchStrategyValues,
);
export const orchestrationRunStatusSchema = z.enum(
  orchestrationRunStatusValues,
);

export const orchestrationSupervisorTickModeValues = [
  'dry_run',
  'execute',
] as const;

export const orchestrationSupervisorStopReasonValues = [
  'not_started',
  'tick_limit_reached',
  'idle',
  'blocked',
  'error',
  'external_stop',
] as const;

export const orchestrationSupervisorDecisionKindValues = [
  'inspect_dashboard',
  'promote_queue',
  'dispatch_ready',
  'run_assignment',
  'await_evidence',
  'idle',
  'blocked',
  'error',
] as const;

export const orchestrationAssignmentRunnerWorkspaceModeValues = [
  'existing_worktree',
  'create_physical_worktree',
] as const;

export const orchestrationAssignmentRunnerEvidenceArtifactKindValues = [
  'test_report',
  'e2e_report',
  'screenshot',
] as const;

export const orchestrationSupervisorTickModeSchema = z.enum(
  orchestrationSupervisorTickModeValues,
);
export const orchestrationSupervisorStopReasonSchema = z.enum(
  orchestrationSupervisorStopReasonValues,
);
export const orchestrationSupervisorDecisionKindSchema = z.enum(
  orchestrationSupervisorDecisionKindValues,
);
export const orchestrationAssignmentRunnerWorkspaceModeSchema = z.enum(
  orchestrationAssignmentRunnerWorkspaceModeValues,
);
export const orchestrationAssignmentRunnerEvidenceArtifactKindSchema = z.enum(
  orchestrationAssignmentRunnerEvidenceArtifactKindValues,
);

export const orchestrationSubagentSchema = z
  .object({
    id: identifierString,
    role: nonEmptyString,
    host: nonEmptyString,
    modelProfile: orchestrationModelProfileSchema,
    model: nonEmptyString.optional(),
    capabilities: nonEmptyStringArray,
    maxConcurrency: positiveInteger.default(1),
    dispatch: harnessDispatchPolicySchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    validateUniqueStrings(value.capabilities, 'capabilities', ctx);

    if (value.modelProfile === 'custom' && value.model === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'custom modelProfile requires a concrete model name.',
        path: ['model'],
      });
    }
  });

export const orchestrationWorktreeContainmentSchema = z
  .object({
    expectedParentPath: absolutePathSchema(),
    requirePathWithinRoot: z.boolean().default(true),
  })
  .strict();

export const orchestrationWorktreeSchema = z
  .object({
    id: identifierString,
    repoRoot: absolutePathSchema(),
    root: absolutePathSchema(),
    path: absolutePathSchema(),
    branch: safeRefSchema(),
    baseRef: safeRefSchema(),
    cleanupPolicy: orchestrationWorktreeCleanupPolicySchema,
    containment: orchestrationWorktreeContainmentSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!isPathWithin(value.containment.expectedParentPath, value.root)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'root must be contained by expectedParentPath.',
        path: ['root'],
      });
    }

    if (
      value.containment.requirePathWithinRoot &&
      !isPathWithin(value.root, value.path)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'path must be contained by root when containment is required.',
        path: ['path'],
      });
    }
  });

export const orchestrationEvidenceArtifactSchema = z
  .object({
    id: identifierString,
    kind: orchestrationEvidenceArtifactKindSchema,
    scope: orchestrationEvidenceArtifactScopeSchema.default('assignment'),
    path: safeArtifactPathSchema().optional(),
    uri: z.string().url().optional(),
    sha256: sha256String.optional(),
    mimeType: nonEmptyString.optional(),
    producedBySubagentId: identifierString.optional(),
    worktreeId: identifierString.optional(),
    createdAt: z.string().datetime({ offset: true }).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.path === undefined && value.uri === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'evidence artifacts require either path or uri.',
        path: ['path'],
      });
    }

    if (value.scope !== 'assignment') {
      return;
    }

    if (value.producedBySubagentId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'assignment-scoped evidence requires producedBySubagentId.',
        path: ['producedBySubagentId'],
      });
    }

    if (value.worktreeId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'assignment-scoped evidence requires worktreeId.',
        path: ['worktreeId'],
      });
    }
  });

export const orchestrationEvidenceGateSchema = z
  .object({
    id: identifierString,
    name: nonEmptyString,
    status: orchestrationGateStatusSchema,
    requiredEvidenceArtifactIds: z.array(identifierString).min(1),
    providedEvidenceArtifactIds: z.array(identifierString).default([]),
    startedAt: z.string().datetime({ offset: true }).optional(),
    completedAt: z.string().datetime({ offset: true }).optional(),
    command: nonEmptyString.optional(),
    exitCode: z.number().int().optional(),
    summary: nonEmptyString.optional(),
    reason: nonEmptyString.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    validateUniqueStrings(
      value.requiredEvidenceArtifactIds,
      'requiredEvidenceArtifactIds',
      ctx,
    );
    validateUniqueStrings(
      value.providedEvidenceArtifactIds,
      'providedEvidenceArtifactIds',
      ctx,
    );

    if (value.status === 'passed') {
      const provided = new Set(value.providedEvidenceArtifactIds);
      value.requiredEvidenceArtifactIds.forEach((artifactId, index) => {
        if (provided.has(artifactId)) {
          return;
        }

        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `passed gate is missing required evidence artifact "${artifactId}".`,
          path: ['requiredEvidenceArtifactIds', index],
        });
      });
    }

    if (
      (value.status === 'failed' || value.status === 'error') &&
      value.summary === undefined &&
      value.providedEvidenceArtifactIds.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'failed and error gates require a summary or diagnostic artifact.',
        path: ['summary'],
      });
    }

    if (value.status === 'skipped' && value.reason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'skipped gates require a reason.',
        path: ['reason'],
      });
    }
  });

export const orchestrationCodebaseRefSchema = z
  .object({
    id: identifierString,
    repoRoot: absolutePathSchema(),
    remoteUrl: z.string().url().optional(),
    branch: safeRefSchema(),
    baseRef: safeRefSchema(),
    commitSha: z.string().regex(/^[a-f0-9]{7,64}$/i).optional(),
    worktreeId: identifierString.optional(),
    paths: z.array(safeArtifactPathSchema()).min(1).optional(),
  })
  .strict();

export const orchestrationEvidencePacketSchema = z
  .object({
    id: identifierString,
    summary: nonEmptyString,
    artifacts: z.array(orchestrationEvidenceArtifactSchema).min(1),
    gates: z.array(orchestrationEvidenceGateSchema).min(1),
    codebaseRefs: z.array(orchestrationCodebaseRefSchema).min(1),
    createdAt: z.string().datetime({ offset: true }).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    validateUniqueIds(value.artifacts, 'artifacts', ctx);
    validateUniqueIds(value.gates, 'gates', ctx);
    validateUniqueIds(value.codebaseRefs, 'codebaseRefs', ctx);

    const artifactIds = new Set(value.artifacts.map((artifact) => artifact.id));
    value.gates.forEach((gate, gateIndex) => {
      gate.requiredEvidenceArtifactIds.forEach((artifactId, evidenceIndex) => {
        if (artifactIds.has(artifactId)) {
          return;
        }

        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown required evidence artifact "${artifactId}".`,
          path: ['gates', gateIndex, 'requiredEvidenceArtifactIds', evidenceIndex],
        });
      });

      gate.providedEvidenceArtifactIds.forEach((artifactId, evidenceIndex) => {
        if (artifactIds.has(artifactId)) {
          return;
        }

        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown provided evidence artifact "${artifactId}".`,
          path: ['gates', gateIndex, 'providedEvidenceArtifactIds', evidenceIndex],
        });
      });
    });
  });

export const orchestrationAssignmentSchema = z
  .object({
    id: identifierString,
    issueId: nonEmptyString,
    subagentId: identifierString,
    worktreeId: identifierString,
    requiredCapabilityIds: z.array(nonEmptyString).min(1).optional(),
    requiredEvidenceArtifactIds: z.array(identifierString).min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    validateUniqueStrings(
      value.requiredCapabilityIds,
      'requiredCapabilityIds',
      ctx,
    );
    validateUniqueStrings(
      value.requiredEvidenceArtifactIds,
      'requiredEvidenceArtifactIds',
      ctx,
    );
  });

export const orchestrationDispatchConfigSchema = z
  .object({
    strategy: orchestrationDispatchStrategySchema,
    maxConcurrentAgents: positiveInteger.default(4),
    assignments: z.array(orchestrationAssignmentSchema).min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    validateUniqueIds(value.assignments, 'assignments', ctx);
  });

export const orchestrationPlanSchema = z
  .object({
    contractVersion: z.literal(orchestrationContractVersion),
    objective: nonEmptyString,
    subagents: z.array(orchestrationSubagentSchema).min(1),
    worktrees: z.array(orchestrationWorktreeSchema).min(1),
    dispatch: orchestrationDispatchConfigSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    validateUniqueIds(value.subagents, 'subagents', ctx);
    validateUniqueIds(value.worktrees, 'worktrees', ctx);
    validateUniqueBy(
      value.worktrees,
      'worktrees',
      (worktree) => normalize(worktree.path),
      ctx,
      'path',
    );
    validateUniqueBy(
      value.worktrees,
      'worktrees',
      (worktree) => worktree.branch,
      ctx,
      'branch',
    );

    const subagents = new Map(
      value.subagents.map((subagent) => [subagent.id, subagent]),
    );
    const worktreeIds = new Set(
      value.worktrees.map((worktree) => worktree.id),
    );

    value.dispatch.assignments.forEach((assignment, index) => {
      const subagent = subagents.get(assignment.subagentId);

      if (subagent === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown subagentId "${assignment.subagentId}".`,
          path: ['dispatch', 'assignments', index, 'subagentId'],
        });
      }

      if (!worktreeIds.has(assignment.worktreeId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown worktreeId "${assignment.worktreeId}".`,
          path: ['dispatch', 'assignments', index, 'worktreeId'],
        });
      }

      if (subagent === undefined || assignment.requiredCapabilityIds === undefined) {
        return;
      }

      const subagentCapabilities = new Set(subagent.capabilities);
      assignment.requiredCapabilityIds.forEach((capabilityId, capabilityIndex) => {
        if (subagentCapabilities.has(capabilityId)) {
          return;
        }

        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Subagent "${subagent.id}" does not provide required capability "${capabilityId}".`,
          path: [
            'dispatch',
            'assignments',
            index,
            'requiredCapabilityIds',
            capabilityIndex,
          ],
        });
      });
    });

    validateUniqueBy(
      value.dispatch.assignments,
      'assignments',
      (assignment) => assignment.worktreeId,
      ctx,
      'worktreeId',
    );
  });

export const orchestrationAssignmentResultSchema = z
  .object({
    assignmentId: identifierString,
    subagentId: identifierString,
    worktreeId: identifierString,
    status: orchestrationRunStatusSchema,
    summary: nonEmptyString.optional(),
    evidenceArtifactIds: z.array(identifierString).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    validateUniqueStrings(value.evidenceArtifactIds, 'evidenceArtifactIds', ctx);

    if (
      (value.status === 'failed' ||
        value.status === 'cancelled' ||
        value.status === 'partial') &&
      value.summary === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'non-success assignment results require a summary.',
        path: ['summary'],
      });
    }
  });

export const orchestrationRunResultSchema = z
  .object({
    runId: identifierString,
    status: orchestrationRunStatusSchema,
    startedAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }).optional(),
    plan: orchestrationPlanSchema,
    assignmentResults: z.array(orchestrationAssignmentResultSchema).min(1),
    evidencePacket: orchestrationEvidencePacketSchema,
    summary: nonEmptyString,
  })
  .strict()
  .superRefine((value, ctx) => {
    const assignmentById = new Map(
      value.plan.dispatch.assignments.map((assignment) => [
        assignment.id,
        assignment,
      ]),
    );
    const assignmentIndexById = new Map(
      value.plan.dispatch.assignments.map((assignment, index) => [
        assignment.id,
        index,
      ]),
    );
    const subagentIds = new Set(
      value.plan.subagents.map((subagent) => subagent.id),
    );
    const worktreeIds = new Set(
      value.plan.worktrees.map((worktree) => worktree.id),
    );
    const artifactIds = new Set(
      value.evidencePacket.artifacts.map((artifact) => artifact.id),
    );
    const artifactById = new Map(
      value.evidencePacket.artifacts.map((artifact) => [artifact.id, artifact]),
    );
    const artifactIndexById = new Map(
      value.evidencePacket.artifacts.map((artifact, index) => [
        artifact.id,
        index,
      ]),
    );

    validateUniqueBy(
      value.assignmentResults,
      'assignmentResults',
      (result) => result.assignmentId,
      ctx,
    );

    value.assignmentResults.forEach((result, index) => {
      const plannedAssignment = assignmentById.get(result.assignmentId);

      if (plannedAssignment === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown assignmentId "${result.assignmentId}".`,
          path: ['assignmentResults', index, 'assignmentId'],
        });
      } else {
        if (result.subagentId !== plannedAssignment.subagentId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Assignment result "${result.assignmentId}" must use planned subagentId "${plannedAssignment.subagentId}".`,
            path: ['assignmentResults', index, 'subagentId'],
          });
        }

        if (result.worktreeId !== plannedAssignment.worktreeId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Assignment result "${result.assignmentId}" must use planned worktreeId "${plannedAssignment.worktreeId}".`,
            path: ['assignmentResults', index, 'worktreeId'],
          });
        }

        if (
          value.status === 'succeeded' &&
          plannedAssignment.requiredEvidenceArtifactIds !== undefined
        ) {
          const resultEvidenceIds = new Set(result.evidenceArtifactIds);
          const plannedAssignmentIndex =
            assignmentIndexById.get(plannedAssignment.id) ?? index;
          plannedAssignment.requiredEvidenceArtifactIds.forEach(
            (artifactId, artifactIndex) => {
              if (!resultEvidenceIds.has(artifactId)) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  message: `Assignment result "${result.assignmentId}" is missing required evidence artifact "${artifactId}".`,
                  path: [
                    'plan',
                    'dispatch',
                    'assignments',
                    plannedAssignmentIndex,
                    'requiredEvidenceArtifactIds',
                    artifactIndex,
                  ],
                });
              }
            },
          );
        }
      }

      if (!subagentIds.has(result.subagentId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown subagentId "${result.subagentId}".`,
          path: ['assignmentResults', index, 'subagentId'],
        });
      }

      if (!worktreeIds.has(result.worktreeId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown worktreeId "${result.worktreeId}".`,
          path: ['assignmentResults', index, 'worktreeId'],
        });
      }

      result.evidenceArtifactIds.forEach((artifactId, artifactIndex) => {
        const artifact = artifactById.get(artifactId);

        if (artifact === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Unknown evidence artifact "${artifactId}".`,
            path: ['assignmentResults', index, 'evidenceArtifactIds', artifactIndex],
          });
          return;
        }

        if (plannedAssignment === undefined || artifact.scope === 'run') {
          return;
        }

        const evidenceArtifactIndex = artifactIndexById.get(artifactId) ?? 0;

        if (artifact.producedBySubagentId !== plannedAssignment.subagentId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Assignment evidence "${artifactId}" must be produced by planned subagentId "${plannedAssignment.subagentId}".`,
            path: [
              'evidencePacket',
              'artifacts',
              evidenceArtifactIndex,
              'producedBySubagentId',
            ],
          });
        }

        if (artifact.worktreeId !== plannedAssignment.worktreeId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Assignment evidence "${artifactId}" must belong to planned worktreeId "${plannedAssignment.worktreeId}".`,
            path: [
              'evidencePacket',
              'artifacts',
              evidenceArtifactIndex,
              'worktreeId',
            ],
          });
        }
      });
    });

    value.evidencePacket.artifacts.forEach((artifact, index) => {
      if (
        artifact.producedBySubagentId !== undefined &&
        !subagentIds.has(artifact.producedBySubagentId)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown producedBySubagentId "${artifact.producedBySubagentId}".`,
          path: ['evidencePacket', 'artifacts', index, 'producedBySubagentId'],
        });
      }

      if (artifact.worktreeId !== undefined && !worktreeIds.has(artifact.worktreeId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown worktreeId "${artifact.worktreeId}".`,
          path: ['evidencePacket', 'artifacts', index, 'worktreeId'],
        });
      }
    });

    value.evidencePacket.codebaseRefs.forEach((codebaseRef, index) => {
      if (
        codebaseRef.worktreeId !== undefined &&
        !worktreeIds.has(codebaseRef.worktreeId)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown worktreeId "${codebaseRef.worktreeId}".`,
          path: ['evidencePacket', 'codebaseRefs', index, 'worktreeId'],
        });
      }
    });

    if (value.status === 'succeeded') {
      const completedAssignmentIds = new Set(
        value.assignmentResults.map((result) => result.assignmentId),
      );

      value.plan.dispatch.assignments.forEach((assignment, index) => {
        if (completedAssignmentIds.has(assignment.id)) {
          return;
        }

        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `succeeded orchestration runs require a result for assignment "${assignment.id}".`,
          path: ['plan', 'dispatch', 'assignments', index, 'id'],
        });
      });

      value.evidencePacket.gates.forEach((gate, index) => {
        if (gate.status === 'passed') {
          return;
        }

        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'succeeded orchestration runs require every evidence gate to pass.',
          path: ['evidencePacket', 'gates', index, 'status'],
        });
      });

      value.assignmentResults.forEach((result, index) => {
        if (result.status === 'succeeded') {
          return;
        }

        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'succeeded orchestration runs require every assignment to succeed.',
          path: ['assignmentResults', index, 'status'],
        });
      });

      validateSucceededRunCsqrLiteCompletionGate(value.runId, value.evidencePacket, ctx);
    }
  });

export const orchestrationAssignmentRunnerConfigSchema = z
  .object({
    command: nonEmptyString,
    args: z.array(nonEmptyString).default([]),
    env: z.record(z.string(), z.string()).default({}),
    timeoutMs: positiveInteger.default(30 * 60 * 1000),
    maxOutputBytes: positiveInteger.default(128 * 1024),
    evidenceRoot: absolutePathSchema().optional(),
    requiredEvidenceArtifactKinds: z
      .array(orchestrationAssignmentRunnerEvidenceArtifactKindSchema)
      .default(['test_report', 'e2e_report']),
    includeCsqrLiteScorecard: z.boolean().default(true),
    maxAssignmentsPerTick: positiveInteger.default(1),
    workspaceMode: orchestrationAssignmentRunnerWorkspaceModeSchema.default(
      'existing_worktree',
    ),
    workflowPath: absolutePathSchema().optional(),
    cleanupWorktree: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    validateUniqueStrings(
      value.requiredEvidenceArtifactKinds,
      'requiredEvidenceArtifactKinds',
      ctx,
    );
  });

export const orchestrationSupervisorHostExecutionSchema = z
  .object({
    repoRoot: absolutePathSchema(),
    worktreeRoot: absolutePathSchema(),
    baseRef: safeRefSchema(),
    host: nonEmptyString,
    hostCapabilities: harnessHostCapabilitiesSchema,
    branchPrefix: nonEmptyString.optional(),
    cleanupPolicy: orchestrationWorktreeCleanupPolicySchema.optional(),
    maxConcurrentAgents: positiveInteger.default(4),
    subagents: z.array(orchestrationSubagentSchema).min(1).optional(),
    assignmentRunner: orchestrationAssignmentRunnerConfigSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!isPathWithin(value.worktreeRoot, value.repoRoot)) {
      return;
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'repoRoot must not be contained by worktreeRoot.',
      path: ['repoRoot'],
    });
  });

export const orchestrationSupervisorBackoffSchema = z
  .object({
    idleDelayMs: positiveInteger.default(30_000),
    blockedDelayMs: positiveInteger.default(60_000),
    errorDelayMs: positiveInteger.default(120_000),
  })
  .strict();

export const orchestrationSupervisorStopConditionSchema = z
  .object({
    maxTicks: positiveInteger.optional(),
    stopWhenIdle: z.boolean().default(false),
    stopWhenBlocked: z.boolean().default(false),
    externalStopFile: absolutePathSchema().optional(),
  })
  .strict();

const orchestrationSupervisorCommonInputFields = {
  dbPath: nonEmptyString,
  workspaceId: nonEmptyString.optional(),
  projectId: nonEmptyString.optional(),
  projectName: nonEmptyString.optional(),
  campaignId: nonEmptyString.optional(),
  campaignName: nonEmptyString.optional(),
  issueId: nonEmptyString.optional(),
  mode: orchestrationSupervisorTickModeSchema.default('dry_run'),
  objective: nonEmptyString.optional(),
  eventLimit: positiveInteger.default(25),
  dashboardFilters: orchestrationDashboardIssueFiltersInputSchema.optional(),
  dispatch: orchestrationSupervisorHostExecutionSchema.optional(),
  backoff: orchestrationSupervisorBackoffSchema.default({
    idleDelayMs: 30_000,
    blockedDelayMs: 60_000,
    errorDelayMs: 120_000,
  }),
  stopCondition: orchestrationSupervisorStopConditionSchema.default({
    stopWhenIdle: false,
    stopWhenBlocked: false,
  }),
  requiredEvidenceArtifactKinds: z
    .array(orchestrationEvidenceArtifactKindSchema)
    .default(['test_report', 'e2e_report', 'screenshot', 'csqr_lite_scorecard']),
  metadata: z.record(z.string(), z.string()).optional(),
} as const;

export const orchestrationSupervisorTickInputSchema = z
  .object({
    contractVersion: z.literal(orchestrationContractVersion),
    tickId: identifierString,
    ...orchestrationSupervisorCommonInputFields,
  })
  .strict()
  .superRefine(validateSupervisorInputScopeAndExecution);

export const orchestrationSupervisorRunInputSchema = z
  .object({
    contractVersion: z.literal(orchestrationContractVersion),
    runId: identifierString,
    tickIdPrefix: identifierString.optional(),
    ...orchestrationSupervisorCommonInputFields,
  })
  .strict()
  .superRefine(validateSupervisorInputScopeAndExecution);

export const orchestrationSupervisorDecisionSchema = z
  .object({
    id: identifierString,
    kind: orchestrationSupervisorDecisionKindSchema,
    summary: nonEmptyString,
    tool: nonEmptyString.optional(),
    action: nonEmptyString.optional(),
    wouldMutate: z.boolean(),
    executed: z.boolean(),
    startedAt: z.string().datetime({ offset: true }).optional(),
    completedAt: z.string().datetime({ offset: true }).optional(),
    evidenceArtifactIds: z.array(identifierString).default([]),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    validateUniqueStrings(value.evidenceArtifactIds, 'evidenceArtifactIds', ctx);

    if (isSupervisorMutatingDecision(value) && !value.wouldMutate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `supervisor decision kind "${value.kind}" is mutating and must set wouldMutate to true.`,
        path: ['wouldMutate'],
      });
    }
  });

export const orchestrationSupervisorTickResultSchema = z
  .object({
    contractVersion: z.literal(orchestrationContractVersion),
    tickId: identifierString,
    mode: orchestrationSupervisorTickModeSchema,
    startedAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }).optional(),
    stopReason: orchestrationSupervisorStopReasonSchema.optional(),
    decisions: z.array(orchestrationSupervisorDecisionSchema).min(1),
    readyIssueCount: z.number().int().nonnegative(),
    dispatchedIssueIds: z.array(nonEmptyString).default([]),
    promotedIssueIds: z.array(nonEmptyString).default([]),
    evidenceArtifactIds: z.array(identifierString).default([]),
    nextDelayMs: z.number().int().nonnegative().optional(),
    summary: nonEmptyString,
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    validateUniqueIds(value.decisions, 'decisions', ctx);
    validateUniqueStrings(value.dispatchedIssueIds, 'dispatchedIssueIds', ctx);
    validateUniqueStrings(value.promotedIssueIds, 'promotedIssueIds', ctx);
    validateUniqueStrings(value.evidenceArtifactIds, 'evidenceArtifactIds', ctx);

    const decisionEvidenceIds = new Set(
      value.decisions.flatMap((decision) => decision.evidenceArtifactIds),
    );
    value.evidenceArtifactIds.forEach((artifactId, index) => {
      if (decisionEvidenceIds.has(artifactId)) {
        return;
      }

      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `tick evidence artifact "${artifactId}" must be referenced by at least one decision.`,
        path: ['evidenceArtifactIds', index],
      });
    });

    if (value.mode === 'dry_run') {
      value.decisions.forEach((decision, index) => {
        if (!isSupervisorMutatingDecision(decision) || !decision.executed) {
          return;
        }

        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'dry-run ticks cannot execute mutating decisions.',
          path: ['decisions', index, 'executed'],
        });
      });

      if (value.dispatchedIssueIds.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'dry-run ticks cannot report dispatched issues.',
          path: ['dispatchedIssueIds'],
        });
      }

      if (value.promotedIssueIds.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'dry-run ticks cannot report promoted issues.',
          path: ['promotedIssueIds'],
        });
      }
    }

    if (value.dispatchedIssueIds.length > 0) {
      const hasDispatchDecision = value.decisions.some(
        (decision) => decision.kind === 'dispatch_ready',
      );
      if (!hasDispatchDecision) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'dispatchedIssueIds require a dispatch_ready decision.',
          path: ['dispatchedIssueIds'],
        });
      }
    }

    if (value.promotedIssueIds.length > 0) {
      const hasPromotionDecision = value.decisions.some(
        (decision) => decision.kind === 'promote_queue',
      );
      if (!hasPromotionDecision) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'promotedIssueIds require a promote_queue decision.',
          path: ['promotedIssueIds'],
        });
      }
    }
  });

export const orchestrationSupervisorRunSummarySchema = z
  .object({
    contractVersion: z.literal(orchestrationContractVersion),
    runId: identifierString,
    status: orchestrationRunStatusSchema,
    startedAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }).optional(),
    tickResults: z.array(orchestrationSupervisorTickResultSchema).min(1),
    stopReason: orchestrationSupervisorStopReasonSchema,
    evidenceArtifactIds: z.array(identifierString).default([]),
    summary: nonEmptyString,
  })
  .strict()
  .superRefine((value, ctx) => {
    validateUniqueBy(value.tickResults, 'tickResults', (tick) => tick.tickId, ctx);
    validateUniqueStrings(value.evidenceArtifactIds, 'evidenceArtifactIds', ctx);

    const tickEvidenceIds = new Set(
      value.tickResults.flatMap((tick) => tick.evidenceArtifactIds),
    );
    value.evidenceArtifactIds.forEach((artifactId, index) => {
      if (tickEvidenceIds.has(artifactId)) {
        return;
      }

      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `run evidence artifact "${artifactId}" must be referenced by at least one tick.`,
        path: ['evidenceArtifactIds', index],
      });
    });

    if (value.status === 'succeeded' && value.stopReason === 'error') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'succeeded supervisor runs cannot stop because of error.',
        path: ['stopReason'],
      });
    }
  });

export type OrchestrationModelProfile = z.infer<
  typeof orchestrationModelProfileSchema
>;
export type OrchestrationWorktreeCleanupPolicy = z.infer<
  typeof orchestrationWorktreeCleanupPolicySchema
>;
export type OrchestrationEvidenceArtifactKind = z.infer<
  typeof orchestrationEvidenceArtifactKindSchema
>;
export type OrchestrationEvidenceArtifactScope = z.infer<
  typeof orchestrationEvidenceArtifactScopeSchema
>;
export type OrchestrationGateStatus = z.infer<
  typeof orchestrationGateStatusSchema
>;
export type OrchestrationDispatchStrategy = z.infer<
  typeof orchestrationDispatchStrategySchema
>;
export type OrchestrationRunStatus = z.infer<
  typeof orchestrationRunStatusSchema
>;
export type OrchestrationSupervisorTickMode = z.infer<
  typeof orchestrationSupervisorTickModeSchema
>;
export type OrchestrationSupervisorStopReason = z.infer<
  typeof orchestrationSupervisorStopReasonSchema
>;
export type OrchestrationSupervisorDecisionKind = z.infer<
  typeof orchestrationSupervisorDecisionKindSchema
>;
export type OrchestrationAssignmentRunnerWorkspaceMode = z.infer<
  typeof orchestrationAssignmentRunnerWorkspaceModeSchema
>;
export type OrchestrationAssignmentRunnerEvidenceArtifactKind = z.infer<
  typeof orchestrationAssignmentRunnerEvidenceArtifactKindSchema
>;
export type OrchestrationAssignmentRunnerConfig = z.infer<
  typeof orchestrationAssignmentRunnerConfigSchema
>;
export type OrchestrationSubagent = z.infer<
  typeof orchestrationSubagentSchema
>;
export type OrchestrationWorktreeContainment = z.infer<
  typeof orchestrationWorktreeContainmentSchema
>;
export type OrchestrationWorktree = z.infer<
  typeof orchestrationWorktreeSchema
>;
export type OrchestrationEvidenceArtifact = z.infer<
  typeof orchestrationEvidenceArtifactSchema
>;
export type OrchestrationEvidenceGate = z.infer<
  typeof orchestrationEvidenceGateSchema
>;
export type OrchestrationCodebaseRef = z.infer<
  typeof orchestrationCodebaseRefSchema
>;
export type OrchestrationEvidencePacket = z.infer<
  typeof orchestrationEvidencePacketSchema
>;
export type OrchestrationAssignment = z.infer<
  typeof orchestrationAssignmentSchema
>;
export type OrchestrationDispatchConfig = z.infer<
  typeof orchestrationDispatchConfigSchema
>;
export type OrchestrationPlan = z.infer<typeof orchestrationPlanSchema>;
export type OrchestrationAssignmentResult = z.infer<
  typeof orchestrationAssignmentResultSchema
>;
export type OrchestrationRunResult = z.infer<
  typeof orchestrationRunResultSchema
>;
export type OrchestrationSupervisorHostExecution = z.infer<
  typeof orchestrationSupervisorHostExecutionSchema
>;
export type OrchestrationSupervisorBackoff = z.infer<
  typeof orchestrationSupervisorBackoffSchema
>;
export type OrchestrationSupervisorStopCondition = z.infer<
  typeof orchestrationSupervisorStopConditionSchema
>;
export type OrchestrationSupervisorTickInput = z.infer<
  typeof orchestrationSupervisorTickInputSchema
>;
export type OrchestrationSupervisorRunInput = z.infer<
  typeof orchestrationSupervisorRunInputSchema
>;
export type OrchestrationSupervisorDecision = z.infer<
  typeof orchestrationSupervisorDecisionSchema
>;
export type OrchestrationSupervisorTickResult = z.infer<
  typeof orchestrationSupervisorTickResultSchema
>;
export type OrchestrationSupervisorRunSummary = z.infer<
  typeof orchestrationSupervisorRunSummarySchema
>;

function validateSucceededRunCsqrLiteCompletionGate(
  runId: string,
  packet: OrchestrationEvidencePacket,
  ctx: z.core.$RefinementCtx,
): void {
  const passedGateArtifactIds = new Set(
    packet.gates
      .filter((gate) => gate.status === 'passed')
      .flatMap((gate) => gate.providedEvidenceArtifactIds),
  );
  const scorecardInputs: Array<{
    scorecard: unknown;
    artifactId: string;
    path?: string;
  }> = [];

  packet.artifacts.forEach((artifact, index) => {
    if (artifact.kind !== 'csqr_lite_scorecard' || artifact.scope !== 'run') {
      return;
    }

    if (!passedGateArtifactIds.has(artifact.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `CSQR-lite scorecard artifact "${artifact.id}" must be covered by a passed evidence gate.`,
        path: ['evidencePacket', 'artifacts', index, 'id'],
      });
    }

    const scorecardJson = artifact.metadata?.['scorecardJson'];
    if (scorecardJson === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `CSQR-lite scorecard artifact "${artifact.id}" requires metadata.scorecardJson.`,
        path: ['evidencePacket', 'artifacts', index, 'metadata'],
      });
      return;
    }

    try {
      const parsedScorecardJson = JSON.parse(scorecardJson) as unknown;
      const parsedScorecard = csqrLiteScorecardSchema.safeParse(parsedScorecardJson);

      if (
        parsedScorecard.success &&
        parsedScorecard.data.scope === 'run' &&
        parsedScorecard.data.runId !== runId
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `CSQR-lite scorecard artifact "${artifact.id}" runId must match orchestration runId "${runId}".`,
          path: ['evidencePacket', 'artifacts', index, 'metadata'],
        });
      }

      scorecardInputs.push({
        artifactId: artifact.id,
        ...(artifact.path !== undefined ? { path: artifact.path } : {}),
        scorecard: parsedScorecardJson,
      });
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `CSQR-lite scorecard artifact "${artifact.id}" has invalid metadata.scorecardJson.`,
        path: ['evidencePacket', 'artifacts', index, 'metadata'],
      });
    }
  });

  let result;
  try {
    result = evaluateCsqrLiteCompletionGate({
      requiredScope: 'run',
      scorecards: scorecardInputs,
    });
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : String(error),
      path: ['evidencePacket', 'artifacts'],
    });
    return;
  }

  if (result.status === 'passed') {
    return;
  }

  if (result.status === 'missing') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: result.message,
      path: ['evidencePacket', 'artifacts'],
    });
    return;
  }

  for (const scorecard of result.failingScorecards) {
    const artifactIndex = packet.artifacts.findIndex(
      (artifact) => artifact.id === scorecard.artifactId,
    );
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `CSQR-lite scorecard "${scorecard.id}" scored ${scorecard.weightedAverage}, below threshold ${scorecard.threshold}.`,
      path:
        artifactIndex >= 0
          ? ['evidencePacket', 'artifacts', artifactIndex, 'metadata']
          : ['evidencePacket', 'artifacts'],
    });
  }
}

function absolutePathSchema(): z.ZodString {
  return nonEmptyString
    .refine((value) => isAbsolute(value), {
      message: 'path must be absolute.',
    })
    .refine((value) => !hasPathTraversalSegment(value), {
      message: 'path must not contain traversal segments.',
    });
}

function safeArtifactPathSchema(): z.ZodString {
  return nonEmptyString.refine((value) => !hasPathTraversalSegment(value), {
    message: 'path must not contain traversal segments.',
  });
}

function safeRefSchema(): z.ZodString {
  return nonEmptyString.refine((value) => !hasPathTraversalSegment(value), {
    message: 'ref must not contain traversal segments.',
  });
}

function isPathWithin(parent: string, child: string): boolean {
  const relativePath = relative(parent, child);
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !isAbsolute(relativePath))
  );
}

function hasPathTraversalSegment(value: string): boolean {
  return value.split(/[\\/]+/).includes('..');
}

function isSupervisorMutatingDecision(value: {
  kind: string;
  action?: string;
}): boolean {
  return (
    value.kind === 'promote_queue' ||
    value.kind === 'dispatch_ready' ||
    value.kind === 'run_assignment' ||
    value.action === 'promote_queue' ||
    value.action === 'dispatch_ready' ||
    value.action === 'run_assignment'
  );
}

function validateSupervisorInputScopeAndExecution(
  value: {
    projectId?: string;
    projectName?: string;
    workspaceId?: string;
    mode: (typeof orchestrationSupervisorTickModeValues)[number];
    dispatch?: unknown;
    requiredEvidenceArtifactKinds?: ReadonlyArray<string>;
  },
  ctx: z.core.$RefinementCtx,
): void {
  if (value.projectId === undefined && value.projectName === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'supervisor inputs require projectId or projectName.',
      path: ['projectId'],
    });
  }

  if (value.mode === 'execute' && value.dispatch === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'execute supervisor inputs require dispatch host execution inputs.',
      path: ['dispatch'],
    });
  }

  if (value.mode === 'execute' && value.workspaceId === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'execute supervisor inputs require workspaceId.',
      path: ['workspaceId'],
    });
  }

  if (value.mode === 'execute' && value.projectId === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'execute supervisor inputs require projectId.',
      path: ['projectId'],
    });
  }

  validateUniqueStrings(
    value.requiredEvidenceArtifactKinds,
    'requiredEvidenceArtifactKinds',
    ctx,
  );
}

function validateUniqueIds(
  entries: ReadonlyArray<{ id: string }>,
  path: string,
  ctx: z.core.$RefinementCtx,
): void {
  validateUniqueBy(entries, path, (entry) => entry.id, ctx);
}

function validateUniqueStrings(
  entries: ReadonlyArray<string> | undefined,
  path: string,
  ctx: z.core.$RefinementCtx,
): void {
  if (entries === undefined) {
    return;
  }

  validateUniqueBy(entries, path, (entry) => entry, ctx);
}

function validateUniqueBy<T>(
  entries: ReadonlyArray<T>,
  path: string,
  getKey: (entry: T) => string,
  ctx: z.core.$RefinementCtx,
  propertyPath: string | number = 'id',
): void {
  const seen = new Set<string>();

  entries.forEach((entry, index) => {
    const key = getKey(entry);

    if (!seen.has(key)) {
      seen.add(key);
      return;
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Duplicate ${path} ${String(propertyPath)} "${key}".`,
      path: [path, index, propertyPath],
    });
  });
}
