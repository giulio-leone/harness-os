import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OrchestrationConflictError,
  buildWorktreeAllocation,
  createDefaultGpt5HighSubagents,
  dispatchReadyOrchestrationIssues,
  assertReferenceOrchestrationEvidencePacket,
  referenceOrchestrationE2eEvidenceMatrix,
  inspectOrchestration,
  orchestrationPlanSchema,
  planOrchestrationMilestones,
} from '../index.js';
import * as orchestration from '../orchestration.js';

test('package root exports the stable orchestration API surface', () => {
  assert.equal(typeof buildWorktreeAllocation, 'function');
  assert.equal(typeof createDefaultGpt5HighSubagents, 'function');
  assert.equal(typeof dispatchReadyOrchestrationIssues, 'function');
  assert.equal(typeof assertReferenceOrchestrationEvidencePacket, 'function');
  assert.equal(referenceOrchestrationE2eEvidenceMatrix.contractVersion, '1.0.0');
  assert.equal(typeof inspectOrchestration, 'function');
  assert.equal(typeof planOrchestrationMilestones, 'function');
  assert.equal(typeof orchestrationPlanSchema.safeParse, 'function');
  assert.equal(typeof OrchestrationConflictError, 'function');
});

test('orchestration subpath re-exports the same stable runtime values', () => {
  assert.equal(orchestration.buildWorktreeAllocation, buildWorktreeAllocation);
  assert.equal(
    orchestration.createDefaultGpt5HighSubagents,
    createDefaultGpt5HighSubagents,
  );
  assert.equal(
    orchestration.dispatchReadyOrchestrationIssues,
    dispatchReadyOrchestrationIssues,
  );
  assert.equal(
    orchestration.assertReferenceOrchestrationEvidencePacket,
    assertReferenceOrchestrationEvidencePacket,
  );
  assert.equal(
    orchestration.referenceOrchestrationE2eEvidenceMatrix,
    referenceOrchestrationE2eEvidenceMatrix,
  );
  assert.equal(orchestration.inspectOrchestration, inspectOrchestration);
  assert.equal(
    orchestration.planOrchestrationMilestones,
    planOrchestrationMilestones,
  );
  assert.equal(orchestration.orchestrationPlanSchema, orchestrationPlanSchema);
  assert.equal(orchestration.OrchestrationConflictError, OrchestrationConflictError);
});
