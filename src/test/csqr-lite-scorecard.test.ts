import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCsqrLiteScorecard,
  calculateCsqrLiteWeightedAverage,
  csqrLiteDefaultCriteria,
  csqrLiteDimensionValues,
  csqrLiteScorecardSchema,
  roundCsqrLiteScore,
  type CsqrLiteCriterion,
  type CsqrLiteScorecard,
} from '../index.js';

const timestamp = '2026-05-10T20:00:00.000Z';

test('default CSQR-lite criteria cover the four required dimensions', () => {
  assert.deepEqual(
    csqrLiteDefaultCriteria.map((criterion) => ({
      id: criterion.id,
      dimension: criterion.dimension,
      weight: criterion.weight,
    })),
    [
      { id: 'correctness', dimension: 'correctness', weight: 2 },
      { id: 'security', dimension: 'security', weight: 1.5 },
      { id: 'quality', dimension: 'quality', weight: 1 },
      { id: 'runtime-evidence', dimension: 'runtime_evidence', weight: 1.5 },
    ],
  );
  assert.deepEqual(
    new Set(csqrLiteDefaultCriteria.map((criterion) => criterion.dimension)),
    new Set(csqrLiteDimensionValues),
  );
});

test('buildCsqrLiteScorecard computes a normalized weighted average', () => {
  const scorecard = createValidScorecard();

  assert.equal(scorecard.contractVersion, '1.0.0');
  assert.equal(scorecard.scope, 'run');
  assert.equal(scorecard.runId, 'run-reference');
  assert.equal(scorecard.targetScore, 8);
  assert.equal(scorecard.weightedAverage, 8.6667);
});

test('CSQR-lite scorecards require one score per criterion', () => {
  const scorecard = createValidScorecard();
  const incompleteScorecard: CsqrLiteScorecard = {
    ...scorecard,
    scores: scorecard.scores.slice(1),
    weightedAverage: 8,
  };

  assert.throws(
    () => csqrLiteScorecardSchema.parse(incompleteScorecard),
    /Missing CSQR-lite score/,
  );
});

test('CSQR-lite scorecards reject duplicate criterion scores', () => {
  const scorecard = createValidScorecard();
  const duplicateScorecard: CsqrLiteScorecard = {
    ...scorecard,
    scores: [
      ...scorecard.scores.slice(0, -1),
      { ...scorecard.scores[0] },
    ],
  };

  assert.throws(
    () => csqrLiteScorecardSchema.parse(duplicateScorecard),
    /Duplicate scores criterionId/,
  );
});

test('CSQR-lite scorecards reject weighted average drift', () => {
  const scorecard = createValidScorecard();

  assert.throws(
    () =>
      csqrLiteScorecardSchema.parse({
        ...scorecard,
        weightedAverage: 9.9999,
      }),
    /weightedAverage must equal 8.6667/,
  );
});

test('CSQR-lite scorecards enforce run and assignment identity by scope', () => {
  const runScorecard = createValidScorecard();
  assert.throws(
    () =>
      csqrLiteScorecardSchema.parse({
        ...runScorecard,
        assignmentId: 'assignment-unexpected',
      }),
    /must not include assignmentId/,
  );

  const assignmentScorecard = buildCsqrLiteScorecard({
    id: 'assignment-scorecard',
    scope: 'assignment',
    assignmentId: 'assignment-reference',
    createdAt: timestamp,
    scores: createDefaultScores(),
  });
  assert.equal(assignmentScorecard.assignmentId, 'assignment-reference');

  assert.throws(
    () =>
      csqrLiteScorecardSchema.parse({
        ...assignmentScorecard,
        runId: 'run-unexpected',
      }),
    /must not include runId/,
  );
});

test('CSQR-lite scoring rejects out-of-range scores and missing evidence', () => {
  const scorecard = createValidScorecard();

  assert.throws(
    () =>
      csqrLiteScorecardSchema.parse({
        ...scorecard,
        scores: [
          { ...scorecard.scores[0], score: 0 },
          ...scorecard.scores.slice(1),
        ],
      }),
    /Too small/,
  );

  assert.throws(
    () =>
      csqrLiteScorecardSchema.parse({
        ...scorecard,
        scores: [
          { ...scorecard.scores[0], evidenceArtifactIds: [] },
          ...scorecard.scores.slice(1),
        ],
      }),
    /Too small/,
  );
});

test('CSQR-lite metadata is string-only for future artifact persistence', () => {
  const scorecard = createValidScorecard();

  assert.throws(
    () =>
      csqrLiteScorecardSchema.parse({
        ...scorecard,
        metadata: {
          issueId: 'M6-I1',
          nonJsonValue: 1,
        },
      }),
    /Invalid input/,
  );
});

test('CSQR-lite weighted average rounding is stable for fractional weights', () => {
  const criteria: CsqrLiteCriterion[] = [
    criterion('correctness', 'correctness', 0.1),
    criterion('security', 'security', 0.2),
    criterion('quality', 'quality', 0.3),
    criterion('runtime-evidence', 'runtime_evidence', 0.4),
  ];
  const scores = [
    score('correctness', 8),
    score('security', 8),
    score('quality', 9),
    score('runtime-evidence', 9),
  ];

  assert.equal(calculateCsqrLiteWeightedAverage({ criteria, scores }), 8.7);
  assert.equal(roundCsqrLiteScore(8.666666666666666), 8.6667);

  const scorecard = buildCsqrLiteScorecard({
    id: 'fractional-scorecard',
    scope: 'run',
    runId: 'run-fractional',
    criteria,
    scores,
  });
  assert.equal(scorecard.weightedAverage, 8.7);
});

test('CSQR-lite scorecards survive JSON round trips', () => {
  const scorecard = createValidScorecard();
  const parsed = csqrLiteScorecardSchema.parse(JSON.parse(JSON.stringify(scorecard)));

  assert.deepEqual(parsed, scorecard);
});

function createValidScorecard(): CsqrLiteScorecard {
  return buildCsqrLiteScorecard({
    id: 'run-scorecard',
    scope: 'run',
    runId: 'run-reference',
    createdAt: timestamp,
    metadata: {
      issueId: 'M6-I1',
    },
    scores: createDefaultScores(),
  });
}

function createDefaultScores() {
  return [
    score('correctness', 10),
    score('security', 9),
    score('quality', 8),
    score('runtime-evidence', 7),
  ];
}

function criterion(
  id: string,
  dimension: CsqrLiteCriterion['dimension'],
  weight: number,
): CsqrLiteCriterion {
  return {
    id,
    dimension,
    name: id,
    description: `Reference ${id} criterion.`,
    weight,
  };
}

function score(criterionId: string, scoreValue: number) {
  return {
    criterionId,
    score: scoreValue,
    notes: `Reference ${criterionId} score.`,
    evidenceArtifactIds: [`${criterionId}-artifact`],
  };
}
