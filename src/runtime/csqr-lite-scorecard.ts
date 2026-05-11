import {
  calculateCsqrLiteWeightedAverage,
  csqrLiteScorecardSchema,
  type CsqrLiteCriterion,
  type CsqrLiteCriterionScoreInput,
  type CsqrLiteScorecard,
  type CsqrLiteScorecardScope,
} from '../contracts/csqr-lite-contracts.js';

export const csqrLiteDefaultCriteria = [
  {
    id: 'correctness',
    dimension: 'correctness',
    name: 'Correctness',
    description:
      'The implementation satisfies the planned behavior, preserves compatibility, and has no known functional regressions.',
    weight: 2,
  },
  {
    id: 'security',
    dimension: 'security',
    name: 'Security',
    description:
      'The change avoids secrets, unsafe input handling, authorization regressions, and known vulnerable dependency patterns.',
    weight: 1.5,
  },
  {
    id: 'quality',
    dimension: 'quality',
    name: 'Quality',
    description:
      'The code remains maintainable, type-safe, cohesive, performant enough for its path, and free of unnecessary technical debt.',
    weight: 1,
  },
  {
    id: 'runtime-evidence',
    dimension: 'runtime_evidence',
    name: 'Runtime evidence',
    description:
      'The run is backed by deterministic test, build, E2E, screenshot, state-export, or CI artifacts that can be replayed from HarnessOS evidence.',
    weight: 1.5,
  },
] as const satisfies readonly CsqrLiteCriterion[];

export interface BuildCsqrLiteScorecardInput {
  id: string;
  scope: CsqrLiteScorecardScope;
  runId?: string;
  assignmentId?: string;
  summary?: string;
  criteria?: readonly CsqrLiteCriterion[];
  scores: readonly CsqrLiteCriterionScoreInput[];
  targetScore?: number;
  createdAt?: string;
  metadata?: Record<string, string>;
}

export function buildCsqrLiteScorecard(
  input: BuildCsqrLiteScorecardInput,
): CsqrLiteScorecard {
  const criteria = [...(input.criteria ?? csqrLiteDefaultCriteria)];
  const scores = input.scores.map((score) => ({ ...score }));
  const weightedAverage = calculateCsqrLiteWeightedAverage({
    criteria,
    scores,
  });

  return csqrLiteScorecardSchema.parse({
    contractVersion: '1.0.0',
    id: input.id,
    scope: input.scope,
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    ...(input.assignmentId !== undefined ? { assignmentId: input.assignmentId } : {}),
    summary:
      input.summary ??
      'CSQR-lite scorecard for automated orchestration completion evidence.',
    criteria,
    scores,
    weightedAverage,
    ...(input.targetScore !== undefined ? { targetScore: input.targetScore } : {}),
    ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  });
}
