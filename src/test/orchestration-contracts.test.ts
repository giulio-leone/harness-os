import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import {
  orchestrationEvidencePacketSchema,
  orchestrationPlanSchema,
  orchestrationRunResultSchema,
  orchestrationSubagentSchema,
  type OrchestrationEvidencePacket,
  type OrchestrationPlan,
  type OrchestrationRunResult,
} from '../index.js';

const timestamp = '2026-05-10T20:00:00.000Z';
const repoRoot = '/tmp/harness-os';
const worktreeRoot = '/tmp/harness-os-worktrees';

test('orchestrationPlanSchema accepts four gpt-5-high subagents with isolated worktrees', () => {
  const parsed = orchestrationPlanSchema.parse(createValidPlan());

  assert.equal(parsed.contractVersion, '1.0.0');
  assert.equal(parsed.dispatch.maxConcurrentAgents, 4);
  assert.equal(parsed.subagents.length, 4);
  assert.ok(
    parsed.subagents.every(
      (subagent) => subagent.modelProfile === 'gpt-5-high',
    ),
  );
});

test('orchestrationPlanSchema rejects unknown subagent assignments', () => {
  const plan = createValidPlan();
  plan.dispatch.assignments[0] = {
    ...plan.dispatch.assignments[0],
    subagentId: 'missing-agent',
  };

  assert.throws(
    () => orchestrationPlanSchema.parse(plan),
    /missing-agent/,
  );
});

test('orchestrationPlanSchema rejects capability requirements missing from the selected subagent', () => {
  const plan = createValidPlan();
  plan.dispatch.assignments[0] = {
    ...plan.dispatch.assignments[0],
    requiredCapabilityIds: ['nonexistent-capability'],
  };

  assert.throws(
    () => orchestrationPlanSchema.parse(plan),
    /nonexistent-capability/,
  );
});

test('orchestrationPlanSchema rejects worktree paths outside declared containment', () => {
  const plan = createValidPlan();
  plan.worktrees[0] = {
    ...plan.worktrees[0],
    path: '/tmp/outside-worktree',
  };

  assert.throws(
    () => orchestrationPlanSchema.parse(plan),
    /path must be contained by root/,
  );
});

test('orchestrationPlanSchema rejects traversal segments in worktree paths', () => {
  const plan = createValidPlan();
  plan.worktrees[0] = {
    ...plan.worktrees[0],
    path: '/tmp/harness-os-worktrees/../escape',
  };

  assert.throws(
    () => orchestrationPlanSchema.parse(plan),
    /traversal segments/,
  );
});

test('orchestrationPlanSchema rejects duplicate worktree paths', () => {
  const plan = createValidPlan();
  plan.worktrees[1] = {
    ...plan.worktrees[1],
    path: plan.worktrees[0].path,
  };

  assert.throws(
    () => orchestrationPlanSchema.parse(plan),
    /Duplicate worktrees path/,
  );
});

test('orchestrationEvidencePacketSchema requires gate evidence to reference known artifacts', () => {
  const packet = createValidEvidencePacket();
  packet.gates[0] = {
    ...packet.gates[0],
    requiredEvidenceArtifactIds: ['missing-report'],
    providedEvidenceArtifactIds: ['typecheck-report'],
  };

  assert.throws(
    () => orchestrationEvidencePacketSchema.parse(packet),
    /missing-report/,
  );
});

test('orchestrationEvidencePacketSchema rejects duplicate artifact ids', () => {
  const packet = createValidEvidencePacket();
  packet.artifacts.push({ ...packet.artifacts[0] });

  assert.throws(
    () => orchestrationEvidencePacketSchema.parse(packet),
    /Duplicate artifacts id/,
  );
});

test('orchestrationEvidencePacketSchema rejects passed gates without all required evidence', () => {
  const packet = createValidEvidencePacket();
  packet.gates[0] = {
    ...packet.gates[0],
    requiredEvidenceArtifactIds: ['typecheck-report', 'e2e-report'],
    providedEvidenceArtifactIds: ['typecheck-report'],
  };

  assert.throws(
    () => orchestrationEvidencePacketSchema.parse(packet),
    /e2e-report/,
  );
});

test('orchestrationEvidencePacketSchema rejects failed gates without diagnostics', () => {
  const packet = createValidEvidencePacket();
  packet.gates[0] = {
    ...packet.gates[0],
    status: 'failed',
    providedEvidenceArtifactIds: [],
    summary: undefined,
  };

  assert.throws(
    () => orchestrationEvidencePacketSchema.parse(packet),
    /failed and error gates require/,
  );
});

test('orchestrationRunResultSchema requires successful runs to have all gates and assignments passed', () => {
  const result = createValidRunResult();
  result.evidencePacket.gates[1] = {
    ...result.evidencePacket.gates[1],
    status: 'failed',
    summary: 'E2E evidence is incomplete.',
  };

  assert.throws(
    () => orchestrationRunResultSchema.parse(result),
    /require every evidence gate to pass/,
  );
});

test('orchestrationRunResultSchema requires successful runs to cover every planned assignment', () => {
  const result = createValidRunResult();
  result.assignmentResults.pop();

  assert.throws(
    () => orchestrationRunResultSchema.parse(result),
    /require a result for assignment/,
  );
});

test('orchestrationRunResultSchema rejects assignment result attribution drift', () => {
  const result = createValidRunResult();
  result.assignmentResults[0] = {
    ...result.assignmentResults[0],
    subagentId: 'agent-worktrees',
    worktreeId: 'worktree-2',
  };

  assert.throws(
    () => orchestrationRunResultSchema.parse(result),
    /must use planned subagentId/,
  );
});

test('orchestrationRunResultSchema requires assignment results to include required evidence', () => {
  const result = createValidRunResult();
  result.assignmentResults[0] = {
    ...result.assignmentResults[0],
    evidenceArtifactIds: [],
  };

  assert.throws(
    () => orchestrationRunResultSchema.parse(result),
    /missing required evidence artifact/,
  );
});

test('orchestrationRunResultSchema rejects assignment-scoped evidence from the wrong worktree', () => {
  const result = createValidRunResult();
  const assignmentEvidence = {
    id: 'assignment-specific-report',
    kind: 'test_report',
    scope: 'assignment',
    path: '.harness/runtime/M1-I1/assignment-specific.json',
    producedBySubagentId: 'agent-worktrees',
    worktreeId: 'worktree-2',
    createdAt: timestamp,
  } as const;
  result.evidencePacket.artifacts.push(assignmentEvidence);
  result.assignmentResults[0] = {
    ...result.assignmentResults[0],
    evidenceArtifactIds: [
      ...result.assignmentResults[0].evidenceArtifactIds,
      assignmentEvidence.id,
    ],
  };
  result.plan.dispatch.assignments[0] = {
    ...result.plan.dispatch.assignments[0],
    requiredEvidenceArtifactIds: [
      ...result.plan.dispatch.assignments[0].requiredEvidenceArtifactIds!,
      assignmentEvidence.id,
    ],
  };

  assert.throws(
    () => orchestrationRunResultSchema.parse(result),
    /must be produced by planned subagentId/,
  );
});

test('orchestrationRunResultSchema rejects extra assignment-scoped evidence from the wrong worker', () => {
  const result = createValidRunResult();
  const extraEvidence = {
    id: 'extra-assignment-report',
    kind: 'diagnostic_log',
    scope: 'assignment',
    path: '.harness/runtime/M1-I1/extra-assignment.log',
    producedBySubagentId: 'agent-dispatch',
    worktreeId: 'worktree-4',
    createdAt: timestamp,
  } as const;
  result.evidencePacket.artifacts.push(extraEvidence);
  result.assignmentResults[0] = {
    ...result.assignmentResults[0],
    evidenceArtifactIds: [
      ...result.assignmentResults[0].evidenceArtifactIds,
      extraEvidence.id,
    ],
  };

  assert.throws(
    () => orchestrationRunResultSchema.parse(result),
    /must be produced by planned subagentId/,
  );
});

test('orchestrationSubagentSchema remains strict at the public boundary', () => {
  assert.throws(
    () =>
      orchestrationSubagentSchema.parse({
        id: 'agent-contracts',
        role: 'contract-author',
        host: 'copilot-cli',
        modelProfile: 'gpt-5-high',
        capabilities: ['contracts'],
        unexpected: true,
      }),
    /unrecognized key/i,
  );
});

function createValidPlan(): OrchestrationPlan {
  const roles = [
    ['agent-contracts', 'contract-author', 'contracts'],
    ['agent-worktrees', 'worktree-author', 'worktrees'],
    ['agent-evidence', 'evidence-author', 'evidence'],
    ['agent-dispatch', 'dispatcher-author', 'dispatch'],
  ] as const;

  return {
    contractVersion: '1.0.0',
    objective:
      'Run Symphony-style autonomous implementation slices without human gates.',
    subagents: roles.map(([id, role, capability]) => ({
      id,
      role,
      host: 'copilot-cli',
      modelProfile: 'gpt-5-high',
      capabilities: [capability, 'typescript'],
      maxConcurrency: 1,
    })),
    worktrees: roles.map(([id], index) => ({
      id: `worktree-${index + 1}`,
      repoRoot,
      root: worktreeRoot,
      path: join(worktreeRoot, id),
      branch: `feat/M2-I${index + 1}-symphony-slice`,
      baseRef: 'main',
      cleanupPolicy: 'delete_on_completion',
      containment: {
        expectedParentPath: '/tmp',
        requirePathWithinRoot: true,
      },
    })),
    dispatch: {
      strategy: 'fanout',
      maxConcurrentAgents: 4,
      assignments: roles.map(([id, , capability], index) => ({
        id: `assignment-${index + 1}`,
        issueId: `M2-I${index + 1}`,
        subagentId: id,
        worktreeId: `worktree-${index + 1}`,
        requiredCapabilityIds: [capability],
        requiredEvidenceArtifactIds: ['typecheck-report', 'e2e-report'],
      })),
    },
  };
}

function createValidEvidencePacket(): OrchestrationEvidencePacket {
  return {
    id: 'packet-M1-I1',
    summary: 'Automated evidence packet for the orchestration contract run.',
    artifacts: [
      {
        id: 'typecheck-report',
        kind: 'typecheck_report',
        scope: 'run',
        path: '.harness/runtime/M1-I1/typecheck.log',
        producedBySubagentId: 'agent-contracts',
        worktreeId: 'worktree-1',
        createdAt: timestamp,
      },
      {
        id: 'e2e-report',
        kind: 'e2e_report',
        scope: 'run',
        path: '.harness/runtime/M1-I1/e2e.json',
        producedBySubagentId: 'agent-evidence',
        worktreeId: 'worktree-3',
        createdAt: timestamp,
      },
      {
        id: 'screenshot-summary',
        kind: 'screenshot',
        scope: 'run',
        path: '.harness/runtime/M1-I1/orchestration-status.png',
        mimeType: 'image/png',
        producedBySubagentId: 'agent-evidence',
        worktreeId: 'worktree-3',
        createdAt: timestamp,
      },
    ],
    gates: [
      {
        id: 'typecheck-gate',
        name: 'TypeScript typecheck',
        status: 'passed',
        requiredEvidenceArtifactIds: ['typecheck-report'],
        providedEvidenceArtifactIds: ['typecheck-report'],
        command: 'npm run typecheck',
        exitCode: 0,
        completedAt: timestamp,
      },
      {
        id: 'e2e-gate',
        name: 'E2E evidence matrix',
        status: 'passed',
        requiredEvidenceArtifactIds: ['e2e-report', 'screenshot-summary'],
        providedEvidenceArtifactIds: ['e2e-report', 'screenshot-summary'],
        command: 'npm test',
        exitCode: 0,
        completedAt: timestamp,
      },
    ],
    codebaseRefs: [
      {
        id: 'codebase-ref',
        repoRoot,
        branch: 'feat/M1-I1-symphony-contracts',
        baseRef: 'main',
        commitSha: '50c7cf4',
        worktreeId: 'worktree-1',
        paths: ['src/contracts/orchestration-contracts.ts'],
      },
    ],
    createdAt: timestamp,
  };
}

function createValidRunResult(): OrchestrationRunResult {
  const plan = createValidPlan();
  return {
    runId: 'run-M1-I1',
    status: 'succeeded',
    startedAt: timestamp,
    completedAt: timestamp,
    plan,
    assignmentResults: plan.dispatch.assignments.map((assignment) => ({
      assignmentId: assignment.id,
      subagentId: assignment.subagentId,
      worktreeId: assignment.worktreeId,
      status: 'succeeded',
      evidenceArtifactIds: ['typecheck-report', 'e2e-report'],
    })),
    evidencePacket: createValidEvidencePacket(),
    summary: 'All automated evidence gates passed.',
  };
}
