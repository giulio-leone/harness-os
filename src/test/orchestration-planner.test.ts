import assert from 'node:assert/strict';
import test from 'node:test';

import {
  planOrchestrationMilestones,
  toHarnessPlanIssuesPayload,
  type OrchestrationPlannerInput,
} from '../runtime/orchestration-planner.js';

function basePlan(): OrchestrationPlannerInput {
  return {
    milestones: [
      {
        id: 'm-implementation',
        key: 'implementation',
        description: 'Implement the feature',
      },
    ],
    slices: [
      {
        id: 'slice-api',
        milestoneId: 'm-implementation',
        task: 'Build the API surface',
        priority: 'high',
        size: 'M',
      },
    ],
  };
}

test('converts orchestration slices into plan_issues milestone payloads', () => {
  assert.deepEqual(toHarnessPlanIssuesPayload(basePlan()), {
    milestones: [
      {
        milestone_key: 'implementation',
        description: 'Implement the feature',
        issues: [
          {
            task: 'Build the API surface',
            priority: 'high',
            size: 'M',
          },
        ],
      },
    ],
  });
});

test('maps same-milestone slice dependencies to depends_on_indices', () => {
  const milestones = planOrchestrationMilestones({
    milestones: [
      {
        id: 'm1',
        description: 'Milestone one',
      },
    ],
    slices: [
      {
        id: 'render',
        milestoneId: 'm1',
        task: 'Render UI',
        priority: 'medium',
        size: 'S',
        dependsOnSliceIds: ['model'],
      },
      {
        id: 'model',
        milestoneId: 'm1',
        task: 'Create model',
        priority: 'high',
        size: 'M',
      },
      {
        id: 'test',
        milestoneId: 'm1',
        task: 'Test flow',
        priority: 'medium',
        size: 'S',
        dependsOnSliceIds: ['model', 'render'],
      },
    ],
  });

  assert.deepEqual(milestones[0]?.issues.map((issue) => issue.task), [
    'Create model',
    'Render UI',
    'Test flow',
  ]);
  assert.deepEqual(milestones[0]?.issues[1]?.depends_on_indices, [0]);
  assert.deepEqual(milestones[0]?.issues[2]?.depends_on_indices, [0, 1]);
});

test('maps cross-milestone slice dependencies to milestone dependencies', () => {
  const milestones = planOrchestrationMilestones({
    milestones: [
      {
        id: 'm2',
        key: 'consumer',
        description: 'Consumer milestone',
      },
      {
        id: 'm1',
        key: 'foundation',
        description: 'Foundation milestone',
      },
    ],
    slices: [
      {
        id: 'use-contract',
        milestoneId: 'm2',
        task: 'Use contract',
        priority: 'medium',
        size: 'S',
        dependsOnSliceIds: ['define-contract'],
      },
      {
        id: 'define-contract',
        milestoneId: 'm1',
        task: 'Define contract',
        priority: 'high',
        size: 'S',
      },
    ],
  });

  assert.deepEqual(milestones.map((milestone) => milestone.milestone_key), [
    'foundation',
    'consumer',
  ]);
  assert.deepEqual(milestones[1]?.depends_on_milestone_keys, ['foundation']);
  assert.equal(milestones[1]?.issues[0]?.depends_on_indices, undefined);
});

test('rejects unknown dependency ids', () => {
  assert.throws(
    () =>
      planOrchestrationMilestones({
        milestones: [
          {
            id: 'm1',
            description: 'Milestone one',
          },
        ],
        slices: [
          {
            id: 'slice-a',
            milestoneId: 'm1',
            task: 'Task A',
            priority: 'high',
            size: 'S',
            dependsOnSliceIds: ['missing-slice'],
          },
        ],
      }),
    /unknown dependency "missing-slice"/i,
  );

  assert.throws(
    () =>
      planOrchestrationMilestones({
        milestones: [
          {
            id: 'm1',
            description: 'Milestone one',
            dependsOnMilestoneIds: ['missing-milestone'],
          },
        ],
        slices: [
          {
            id: 'slice-a',
            milestoneId: 'm1',
            task: 'Task A',
            priority: 'high',
            size: 'S',
          },
        ],
      }),
    /unknown dependency "missing-milestone"/i,
  );
});

test('rejects duplicate milestone keys before emitting plan payloads', () => {
  assert.throws(
    () =>
      planOrchestrationMilestones({
        milestones: [
          {
            id: 'm-api',
            key: 'foundation',
            description: 'API foundation',
          },
          {
            id: 'm-ui',
            key: 'foundation',
            description: 'UI foundation',
          },
        ],
        slices: [
          {
            id: 'slice-api',
            milestoneId: 'm-api',
            task: 'Build API',
            priority: 'high',
            size: 'S',
          },
          {
            id: 'slice-ui',
            milestoneId: 'm-ui',
            task: 'Build UI',
            priority: 'medium',
            size: 'S',
          },
        ],
      }),
    /Duplicate milestone key "foundation"/,
  );
});

test('rejects self and cyclic milestone dependencies', () => {
  assert.throws(
    () =>
      planOrchestrationMilestones({
        milestones: [
          {
            id: 'm1',
            description: 'Milestone one',
            dependsOnMilestoneIds: ['m1'],
          },
        ],
        slices: [
          {
            id: 'slice-a',
            milestoneId: 'm1',
            task: 'Task A',
            priority: 'high',
            size: 'S',
          },
        ],
      }),
    /cannot depend on itself/,
  );

  assert.throws(
    () =>
      planOrchestrationMilestones({
        milestones: [
          {
            id: 'm1',
            description: 'Milestone one',
            dependsOnMilestoneIds: ['m2'],
          },
          {
            id: 'm2',
            description: 'Milestone two',
            dependsOnMilestoneIds: ['m1'],
          },
        ],
        slices: [
          {
            id: 'slice-a',
            milestoneId: 'm1',
            task: 'Task A',
            priority: 'high',
            size: 'S',
          },
          {
            id: 'slice-b',
            milestoneId: 'm2',
            task: 'Task B',
            priority: 'medium',
            size: 'S',
          },
        ],
      }),
    /Cycle detected in milestone dependencies/,
  );
});

test('preserves policy, workflow metadata, and evidence external refs', () => {
  const milestones = planOrchestrationMilestones({
    milestones: [
      {
        id: 'm1',
        description: 'Metadata milestone',
        deadlineAt: '2026-04-03T12:00:00.000Z',
        externalRefs: [
          {
            id: 'prd',
            kind: 'document',
            value: 'docs/prd.md',
          },
        ],
      },
    ],
    slices: [
      {
        id: 'slice-a',
        milestoneId: 'm1',
        task: 'Task with metadata',
        priority: 'critical',
        size: 'L',
        deadlineAt: '2026-04-02T12:00:00.000Z',
        recipients: [
          {
            id: 'ops',
            kind: 'team',
            label: 'Ops',
          },
        ],
        approvals: [
          {
            id: 'ops-approval',
            label: 'Ops approval',
            recipientIds: ['ops'],
            state: 'pending',
          },
        ],
        externalRefs: [
          {
            id: 'ticket',
            kind: 'issue',
            value: 'M2-I3',
          },
        ],
        evidenceRequirements: [
          {
            id: 'typecheck-log',
            kind: 'evidence_requirement',
            value: 'npm run typecheck',
            label: 'Typecheck log',
          },
        ],
        policy: {
          owner: 'runtime-team',
          dispatch: {
            workloadClass: 'implementation',
            requiredHostCapabilities: ['node'],
          },
        },
      },
    ],
  });

  assert.equal(milestones[0]?.deadlineAt, '2026-04-03T12:00:00.000Z');
  assert.deepEqual(milestones[0]?.externalRefs, [
    {
      id: 'prd',
      kind: 'document',
      value: 'docs/prd.md',
    },
  ]);
  assert.deepEqual(milestones[0]?.issues[0], {
    task: 'Task with metadata',
    priority: 'critical',
    size: 'L',
    deadlineAt: '2026-04-02T12:00:00.000Z',
    recipients: [
      {
        id: 'ops',
        kind: 'team',
        label: 'Ops',
      },
    ],
    approvals: [
      {
        id: 'ops-approval',
        label: 'Ops approval',
        recipientIds: ['ops'],
        state: 'pending',
      },
    ],
    externalRefs: [
      {
        id: 'ticket',
        kind: 'issue',
        value: 'M2-I3',
      },
      {
        id: 'typecheck-log',
        kind: 'evidence_requirement',
        value: 'npm run typecheck',
        label: 'Typecheck log',
      },
    ],
    policy: {
      owner: 'runtime-team',
      dispatch: {
        workloadClass: 'implementation',
        requiredHostCapabilities: ['node'],
      },
    },
  });
});

test('produces deterministic milestone and slice ordering', () => {
  const first = planOrchestrationMilestones({
    milestones: [
      { id: 'z', description: 'Z milestone', dependsOnMilestoneIds: ['a'] },
      { id: 'a', description: 'A milestone' },
      { id: 'm', description: 'M milestone' },
    ],
    slices: [
      {
        id: 'z-child',
        milestoneId: 'z',
        task: 'Z child',
        priority: 'low',
        size: 'S',
        dependsOnSliceIds: ['z-root'],
      },
      {
        id: 'z-root',
        milestoneId: 'z',
        task: 'Z root',
        priority: 'low',
        size: 'S',
      },
      {
        id: 'm-root',
        milestoneId: 'm',
        task: 'M root',
        priority: 'medium',
        size: 'S',
      },
      {
        id: 'a-root',
        milestoneId: 'a',
        task: 'A root',
        priority: 'high',
        size: 'S',
      },
    ],
  });
  const second = planOrchestrationMilestones({
    milestones: [
      { id: 'm', description: 'M milestone' },
      { id: 'z', description: 'Z milestone', dependsOnMilestoneIds: ['a'] },
      { id: 'a', description: 'A milestone' },
    ],
    slices: [
      {
        id: 'a-root',
        milestoneId: 'a',
        task: 'A root',
        priority: 'high',
        size: 'S',
      },
      {
        id: 'm-root',
        milestoneId: 'm',
        task: 'M root',
        priority: 'medium',
        size: 'S',
      },
      {
        id: 'z-root',
        milestoneId: 'z',
        task: 'Z root',
        priority: 'low',
        size: 'S',
      },
      {
        id: 'z-child',
        milestoneId: 'z',
        task: 'Z child',
        priority: 'low',
        size: 'S',
        dependsOnSliceIds: ['z-root'],
      },
    ],
  });

  assert.deepEqual(first, second);
  assert.deepEqual(first.map((milestone) => milestone.milestone_key), [
    'a',
    'm',
    'z',
  ]);
  assert.deepEqual(first[2]?.issues.map((issue) => issue.task), [
    'Z root',
    'Z child',
  ]);
});
