import { z } from 'zod';

export const csqrLiteContractVersion = '1.0.0' as const;
export const csqrLiteDefaultTargetScore = 8 as const;
export const csqrLiteWeightedAveragePrecision = 4 as const;

const nonEmptyString = z.string().min(1);
const identifierString = nonEmptyString.regex(/^[A-Za-z0-9._:-]+$/);
const scoreValue = z.number().int().min(1).max(10);
const criterionWeight = z.number().min(0.1).max(5);

export const csqrLiteDimensionValues = [
  'correctness',
  'security',
  'quality',
  'runtime_evidence',
] as const;

export const csqrLiteScorecardScopeValues = ['run', 'assignment'] as const;

export const csqrLiteDimensionSchema = z.enum(csqrLiteDimensionValues);
export const csqrLiteScorecardScopeSchema = z.enum(
  csqrLiteScorecardScopeValues,
);

export const csqrLiteCriterionSchema = z
  .object({
    id: identifierString,
    dimension: csqrLiteDimensionSchema,
    name: nonEmptyString,
    description: nonEmptyString,
    weight: criterionWeight,
  })
  .strict();

export const csqrLiteCriterionScoreSchema = z
  .object({
    criterionId: identifierString,
    score: scoreValue,
    notes: nonEmptyString,
    evidenceArtifactIds: z.array(identifierString).min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    validateUniqueStrings(value.evidenceArtifactIds, 'evidenceArtifactIds', ctx);
  });

export const csqrLiteScorecardSchema = z
  .object({
    contractVersion: z.literal(csqrLiteContractVersion),
    id: identifierString,
    scope: csqrLiteScorecardScopeSchema,
    runId: identifierString.optional(),
    assignmentId: identifierString.optional(),
    summary: nonEmptyString,
    criteria: z.array(csqrLiteCriterionSchema).min(4).max(15),
    scores: z.array(csqrLiteCriterionScoreSchema).min(4).max(15),
    weightedAverage: z.number().min(1).max(10),
    targetScore: z
      .number()
      .min(1)
      .max(10)
      .default(csqrLiteDefaultTargetScore),
    createdAt: z.string().datetime({ offset: true }).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    validateScopeIdentity(value, ctx);
    validateUniqueIds(value.criteria, 'criteria', ctx);
    validateDimensionCoverage(value.criteria, ctx);
    validateScoreCoverage(value.criteria, value.scores, ctx);

    try {
      const expectedAverage = calculateCsqrLiteWeightedAverage({
        criteria: value.criteria,
        scores: value.scores,
      });

      if (value.weightedAverage !== expectedAverage) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `weightedAverage must equal ${expectedAverage} for the provided CSQR-lite criteria and scores.`,
          path: ['weightedAverage'],
        });
      }
    } catch {
      return;
    }
  });

export type CsqrLiteDimension = z.infer<typeof csqrLiteDimensionSchema>;
export type CsqrLiteScorecardScope = z.infer<
  typeof csqrLiteScorecardScopeSchema
>;
export type CsqrLiteCriterion = z.infer<typeof csqrLiteCriterionSchema>;
export type CsqrLiteCriterionScore = z.infer<
  typeof csqrLiteCriterionScoreSchema
>;
export type CsqrLiteCriterionScoreInput = z.input<
  typeof csqrLiteCriterionScoreSchema
>;
export type CsqrLiteScorecard = z.infer<typeof csqrLiteScorecardSchema>;
export type CsqrLiteScorecardInput = z.input<typeof csqrLiteScorecardSchema>;

interface WeightedAverageCriterion {
  readonly id: string;
  readonly weight: number;
}

interface WeightedAverageScore {
  readonly criterionId: string;
  readonly score: number;
}

export function calculateCsqrLiteWeightedAverage(input: {
  criteria: ReadonlyArray<WeightedAverageCriterion>;
  scores: ReadonlyArray<WeightedAverageScore>;
}): number {
  const scoreByCriterionId = indexScores(input.scores);
  let weightedSum = 0;
  let weightSum = 0;

  for (const criterion of input.criteria) {
    const score = scoreByCriterionId.get(criterion.id);
    if (score === undefined) {
      throw new Error(
        `Missing CSQR-lite score for criterion "${criterion.id}".`,
      );
    }

    weightedSum += score.score * criterion.weight;
    weightSum += criterion.weight;
  }

  if (weightSum <= 0) {
    throw new Error('CSQR-lite criteria must have a positive weight sum.');
  }

  return roundCsqrLiteScore(weightedSum / weightSum);
}

export function roundCsqrLiteScore(value: number): number {
  return Number(value.toFixed(csqrLiteWeightedAveragePrecision));
}

function validateScopeIdentity(
  value: {
    scope: CsqrLiteScorecardScope;
    runId?: string;
    assignmentId?: string;
  },
  ctx: z.core.$RefinementCtx,
): void {
  if (value.scope === 'run') {
    if (value.runId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'run-scoped CSQR-lite scorecards require runId.',
        path: ['runId'],
      });
    }

    if (value.assignmentId !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'run-scoped CSQR-lite scorecards must not include assignmentId.',
        path: ['assignmentId'],
      });
    }
    return;
  }

  if (value.assignmentId === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'assignment-scoped CSQR-lite scorecards require assignmentId.',
      path: ['assignmentId'],
    });
  }

  if (value.runId !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'assignment-scoped CSQR-lite scorecards must not include runId.',
      path: ['runId'],
    });
  }
}

function validateDimensionCoverage(
  criteria: ReadonlyArray<CsqrLiteCriterion>,
  ctx: z.core.$RefinementCtx,
): void {
  const coveredDimensions = new Set(criteria.map((criterion) => criterion.dimension));

  csqrLiteDimensionValues.forEach((dimension) => {
    if (coveredDimensions.has(dimension)) {
      return;
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `CSQR-lite scorecards require at least one criterion for dimension "${dimension}".`,
      path: ['criteria'],
    });
  });
}

function validateScoreCoverage(
  criteria: ReadonlyArray<CsqrLiteCriterion>,
  scores: ReadonlyArray<CsqrLiteCriterionScore>,
  ctx: z.core.$RefinementCtx,
): void {
  const criterionIds = new Set(criteria.map((criterion) => criterion.id));
  const scoreCriterionIds = new Set<string>();

  scores.forEach((score, index) => {
    if (scoreCriterionIds.has(score.criterionId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate scores criterionId "${score.criterionId}".`,
        path: ['scores', index, 'criterionId'],
      });
    }
    scoreCriterionIds.add(score.criterionId);

    if (!criterionIds.has(score.criterionId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unknown CSQR-lite criterionId "${score.criterionId}".`,
        path: ['scores', index, 'criterionId'],
      });
    }
  });

  criteria.forEach((criterion, index) => {
    if (scoreCriterionIds.has(criterion.id)) {
      return;
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Missing CSQR-lite score for criterion "${criterion.id}".`,
      path: ['criteria', index, 'id'],
    });
  });
}

function indexScores(
  scores: ReadonlyArray<WeightedAverageScore>,
): Map<string, WeightedAverageScore> {
  const scoreByCriterionId = new Map<string, WeightedAverageScore>();

  for (const score of scores) {
    if (scoreByCriterionId.has(score.criterionId)) {
      throw new Error(
        `Duplicate CSQR-lite score for criterion "${score.criterionId}".`,
      );
    }

    scoreByCriterionId.set(score.criterionId, score);
  }

  return scoreByCriterionId;
}

function validateUniqueIds(
  entries: ReadonlyArray<{ id: string }>,
  path: string,
  ctx: z.core.$RefinementCtx,
): void {
  const seen = new Set<string>();

  entries.forEach((entry, index) => {
    if (!seen.has(entry.id)) {
      seen.add(entry.id);
      return;
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Duplicate ${path} id "${entry.id}".`,
      path: [path, index, 'id'],
    });
  });
}

function validateUniqueStrings(
  entries: ReadonlyArray<string>,
  path: string,
  ctx: z.core.$RefinementCtx,
): void {
  const seen = new Set<string>();

  entries.forEach((entry, index) => {
    if (!seen.has(entry)) {
      seen.add(entry);
      return;
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Duplicate ${path} "${entry}".`,
      path: [path, index],
    });
  });
}
