import { isAbsolute, normalize, relative } from 'node:path';

import { z } from 'zod';

import { harnessDispatchPolicySchema } from './policy-contracts.js';

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
