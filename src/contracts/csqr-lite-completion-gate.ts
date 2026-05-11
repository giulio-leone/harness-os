import {
  csqrLiteDefaultTargetScore,
  csqrLiteScorecardSchema,
  type CsqrLiteScorecard,
  type CsqrLiteScorecardScope,
} from './csqr-lite-contracts.js';

export type CsqrLiteCompletionGateScope = CsqrLiteScorecardScope | 'any';
export type CsqrLiteCompletionGateStatus = 'passed' | 'failed' | 'missing';

export interface CsqrLiteCompletionGateScorecardInput {
  scorecard: unknown;
  artifactId?: string;
  path?: string;
  source?: string;
}

export interface CsqrLiteCompletionGateScorecardEvaluation {
  id: string;
  scope: CsqrLiteScorecardScope;
  weightedAverage: number;
  targetScore: number;
  threshold: number;
  status: 'passed' | 'failed';
  artifactId?: string;
  path?: string;
  source?: string;
}

export interface CsqrLiteCompletionGateResult {
  status: CsqrLiteCompletionGateStatus;
  requiredScope: CsqrLiteCompletionGateScope;
  minimumTargetScore: number;
  evaluatedScorecards: CsqrLiteCompletionGateScorecardEvaluation[];
  failingScorecards: CsqrLiteCompletionGateScorecardEvaluation[];
  message: string;
}

export interface EvaluateCsqrLiteCompletionGateInput {
  scorecards: readonly CsqrLiteCompletionGateScorecardInput[];
  requiredScope?: CsqrLiteCompletionGateScope;
  minimumTargetScore?: number;
}

export function evaluateCsqrLiteCompletionGate(
  input: EvaluateCsqrLiteCompletionGateInput,
): CsqrLiteCompletionGateResult {
  const requiredScope = input.requiredScope ?? 'run';
  const minimumTargetScore = normalizeMinimumTargetScore(
    input.minimumTargetScore ?? csqrLiteDefaultTargetScore,
  );
  const evaluatedScorecards = input.scorecards
    .map((candidate) =>
      evaluateScorecard({
        ...candidate,
        scorecard: csqrLiteScorecardSchema.parse(candidate.scorecard),
        minimumTargetScore,
      }),
    )
    .filter((scorecard) =>
      requiredScope === 'any' ? true : scorecard.scope === requiredScope,
    );
  const failingScorecards = evaluatedScorecards.filter(
    (scorecard) => scorecard.status === 'failed',
  );

  if (evaluatedScorecards.length === 0) {
    return {
      status: 'missing',
      requiredScope,
      minimumTargetScore,
      evaluatedScorecards: [],
      failingScorecards: [],
      message: `CSQR-lite completion gate requires at least one ${requiredScope}-scoped scorecard.`,
    };
  }

  if (failingScorecards.length > 0) {
    return {
      status: 'failed',
      requiredScope,
      minimumTargetScore,
      evaluatedScorecards,
      failingScorecards,
      message: `CSQR-lite completion gate failed: ${formatFailingScorecards(failingScorecards)}.`,
    };
  }

  return {
    status: 'passed',
    requiredScope,
    minimumTargetScore,
    evaluatedScorecards,
    failingScorecards: [],
    message: `CSQR-lite completion gate passed for ${evaluatedScorecards.length} ${requiredScope}-scoped scorecard(s).`,
  };
}

export function assertCsqrLiteCompletionGate(
  input: EvaluateCsqrLiteCompletionGateInput,
): CsqrLiteCompletionGateResult {
  const result = evaluateCsqrLiteCompletionGate(input);

  if (result.status !== 'passed') {
    throw new Error(result.message);
  }

  return result;
}

function evaluateScorecard(input: {
  scorecard: CsqrLiteScorecard;
  minimumTargetScore: number;
  artifactId?: string;
  path?: string;
  source?: string;
}): CsqrLiteCompletionGateScorecardEvaluation {
  const threshold = Math.max(input.minimumTargetScore, input.scorecard.targetScore);
  return {
    id: input.scorecard.id,
    scope: input.scorecard.scope,
    weightedAverage: input.scorecard.weightedAverage,
    targetScore: input.scorecard.targetScore,
    threshold,
    status:
      input.scorecard.weightedAverage >= threshold ? 'passed' : 'failed',
    ...(input.artifactId !== undefined ? { artifactId: input.artifactId } : {}),
    ...(input.path !== undefined ? { path: input.path } : {}),
    ...(input.source !== undefined ? { source: input.source } : {}),
  };
}

function normalizeMinimumTargetScore(value: number): number {
  if (!Number.isFinite(value) || value < 1 || value > 10) {
    throw new Error('CSQR-lite completion gate minimumTargetScore must be between 1 and 10.');
  }

  return value;
}

function formatFailingScorecards(
  scorecards: readonly CsqrLiteCompletionGateScorecardEvaluation[],
): string {
  return scorecards
    .map(
      (scorecard) =>
        `"${scorecard.id}" scored ${scorecard.weightedAverage} below threshold ${scorecard.threshold}`,
    )
    .join('; ');
}
