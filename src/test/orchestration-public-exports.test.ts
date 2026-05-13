import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyOrchestrationDashboardIssueFilters,
  OrchestrationConflictError,
  assertCsqrLiteCompletionGate,
  buildOrchestrationDashboardViewModel,
  buildCsqrLiteScorecard,
  buildWorktreeAllocation,
  createDefaultGpt5HighSubagents,
  csqrLiteDefaultCriteria,
  csqrLiteScorecardSchema,
  dispatchReadyOrchestrationIssues,
  evaluateCsqrLiteCompletionGate,
  loadOrchestrationDashboardViewModel,
  normalizeOrchestrationDashboardIssueFilters,
  buildSymphonyCodexAppServerCommand,
  cleanupSymphonyPhysicalWorktree,
  createScriptedCodexAppServerProcessAdapter,
  createSymphonyPhysicalWorktree,
  createSymphonyWorkflowReloader,
  deriveSymphonyCodexSessionId,
  loadSymphonyWorkflowFromText,
  launchCodexAppServerRunner,
  renderSymphonyWorkflowPrompt,
  runSymphonyAssignment,
  symphonyCodexRunnerLaunchResultSchema,
  symphonyCodexRunnerTurnExecutionEnvelopeSchema,
  symphonyCodexRunnerTurnResultSchema,
  symphonyWorktreeOperationResultSchema,
  symphonyAssignmentRunnerInputSchema,
  runOrchestrationSupervisorTick,
  assertReferenceOrchestrationEvidencePacket,
  orchestrationDashboardViewModelSchema,
  referenceOrchestrationE2eEvidenceMatrix,
  inspectOrchestration,
  orchestrationPlanSchema,
  orchestrationSupervisorDecisionSchema,
  orchestrationSupervisorRunSummarySchema,
  orchestrationSupervisorTickInputSchema,
  orchestrationSupervisorTickResultSchema,
  symphonyWorkflowConfigSchema,
  symphonyWorkflowDocumentSchema,
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
  assert.equal(typeof buildCsqrLiteScorecard, 'function');
  assert.equal(typeof evaluateCsqrLiteCompletionGate, 'function');
  assert.equal(typeof assertCsqrLiteCompletionGate, 'function');
  assert.equal(typeof buildOrchestrationDashboardViewModel, 'function');
  assert.equal(typeof loadOrchestrationDashboardViewModel, 'function');
  assert.equal(typeof applyOrchestrationDashboardIssueFilters, 'function');
  assert.equal(typeof normalizeOrchestrationDashboardIssueFilters, 'function');
  assert.equal(typeof buildSymphonyCodexAppServerCommand, 'function');
  assert.equal(typeof createScriptedCodexAppServerProcessAdapter, 'function');
  assert.equal(typeof deriveSymphonyCodexSessionId, 'function');
  assert.equal(typeof launchCodexAppServerRunner, 'function');
  assert.equal(typeof createSymphonyPhysicalWorktree, 'function');
  assert.equal(typeof cleanupSymphonyPhysicalWorktree, 'function');
  assert.equal(typeof createSymphonyWorkflowReloader, 'function');
  assert.equal(typeof loadSymphonyWorkflowFromText, 'function');
  assert.equal(typeof renderSymphonyWorkflowPrompt, 'function');
  assert.equal(typeof runSymphonyAssignment, 'function');
  assert.equal(typeof runOrchestrationSupervisorTick, 'function');
  assert.equal(typeof orchestrationDashboardViewModelSchema.safeParse, 'function');
  assert.equal(typeof orchestrationSupervisorTickInputSchema.safeParse, 'function');
  assert.equal(typeof orchestrationSupervisorDecisionSchema.safeParse, 'function');
  assert.equal(typeof orchestrationSupervisorTickResultSchema.safeParse, 'function');
  assert.equal(typeof orchestrationSupervisorRunSummarySchema.safeParse, 'function');
  assert.equal(typeof symphonyWorkflowConfigSchema.safeParse, 'function');
  assert.equal(typeof symphonyWorkflowDocumentSchema.safeParse, 'function');
  assert.equal(typeof symphonyCodexRunnerLaunchResultSchema.safeParse, 'function');
  assert.equal(typeof symphonyCodexRunnerTurnResultSchema.safeParse, 'function');
  assert.equal(
    typeof symphonyCodexRunnerTurnExecutionEnvelopeSchema.safeParse,
    'function',
  );
  assert.equal(typeof symphonyWorktreeOperationResultSchema.safeParse, 'function');
  assert.equal(typeof symphonyAssignmentRunnerInputSchema.safeParse, 'function');
  assert.equal(typeof csqrLiteScorecardSchema.safeParse, 'function');
  assert.equal(csqrLiteDefaultCriteria.length, 4);
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
  assert.equal(orchestration.buildCsqrLiteScorecard, buildCsqrLiteScorecard);
  assert.equal(
    orchestration.evaluateCsqrLiteCompletionGate,
    evaluateCsqrLiteCompletionGate,
  );
  assert.equal(
    orchestration.assertCsqrLiteCompletionGate,
    assertCsqrLiteCompletionGate,
  );
  assert.equal(
    orchestration.buildOrchestrationDashboardViewModel,
    buildOrchestrationDashboardViewModel,
  );
  assert.equal(
    orchestration.loadOrchestrationDashboardViewModel,
    loadOrchestrationDashboardViewModel,
  );
  assert.equal(
    orchestration.applyOrchestrationDashboardIssueFilters,
    applyOrchestrationDashboardIssueFilters,
  );
  assert.equal(
    orchestration.normalizeOrchestrationDashboardIssueFilters,
    normalizeOrchestrationDashboardIssueFilters,
  );
  assert.equal(
    orchestration.buildSymphonyCodexAppServerCommand,
    buildSymphonyCodexAppServerCommand,
  );
  assert.equal(
    orchestration.createScriptedCodexAppServerProcessAdapter,
    createScriptedCodexAppServerProcessAdapter,
  );
  assert.equal(
    orchestration.deriveSymphonyCodexSessionId,
    deriveSymphonyCodexSessionId,
  );
  assert.equal(
    orchestration.launchCodexAppServerRunner,
    launchCodexAppServerRunner,
  );
  assert.equal(
    orchestration.createSymphonyPhysicalWorktree,
    createSymphonyPhysicalWorktree,
  );
  assert.equal(
    orchestration.cleanupSymphonyPhysicalWorktree,
    cleanupSymphonyPhysicalWorktree,
  );
  assert.equal(
    orchestration.createSymphonyWorkflowReloader,
    createSymphonyWorkflowReloader,
  );
  assert.equal(
    orchestration.loadSymphonyWorkflowFromText,
    loadSymphonyWorkflowFromText,
  );
  assert.equal(
    orchestration.renderSymphonyWorkflowPrompt,
    renderSymphonyWorkflowPrompt,
  );
  assert.equal(orchestration.runSymphonyAssignment, runSymphonyAssignment);
  assert.equal(
    orchestration.runOrchestrationSupervisorTick,
    runOrchestrationSupervisorTick,
  );
  assert.equal(
    orchestration.orchestrationDashboardViewModelSchema,
    orchestrationDashboardViewModelSchema,
  );
  assert.equal(
    orchestration.orchestrationSupervisorTickInputSchema,
    orchestrationSupervisorTickInputSchema,
  );
  assert.equal(
    orchestration.orchestrationSupervisorDecisionSchema,
    orchestrationSupervisorDecisionSchema,
  );
  assert.equal(
    orchestration.orchestrationSupervisorTickResultSchema,
    orchestrationSupervisorTickResultSchema,
  );
  assert.equal(
    orchestration.orchestrationSupervisorRunSummarySchema,
    orchestrationSupervisorRunSummarySchema,
  );
  assert.equal(orchestration.symphonyWorkflowConfigSchema, symphonyWorkflowConfigSchema);
  assert.equal(orchestration.symphonyWorkflowDocumentSchema, symphonyWorkflowDocumentSchema);
  assert.equal(
    orchestration.symphonyCodexRunnerLaunchResultSchema,
    symphonyCodexRunnerLaunchResultSchema,
  );
  assert.equal(
    orchestration.symphonyCodexRunnerTurnResultSchema,
    symphonyCodexRunnerTurnResultSchema,
  );
  assert.equal(
    orchestration.symphonyCodexRunnerTurnExecutionEnvelopeSchema,
    symphonyCodexRunnerTurnExecutionEnvelopeSchema,
  );
  assert.equal(
    orchestration.symphonyWorktreeOperationResultSchema,
    symphonyWorktreeOperationResultSchema,
  );
  assert.equal(
    orchestration.symphonyAssignmentRunnerInputSchema,
    symphonyAssignmentRunnerInputSchema,
  );
  assert.equal(orchestration.csqrLiteScorecardSchema, csqrLiteScorecardSchema);
  assert.equal(orchestration.csqrLiteDefaultCriteria, csqrLiteDefaultCriteria);
});
