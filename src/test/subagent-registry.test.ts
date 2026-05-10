import assert from 'node:assert/strict';
import test from 'node:test';

import type { OrchestrationSubagent } from '../contracts/orchestration-contracts.js';
import {
  checkSubagentCompatibility,
  createDefaultGpt5HighSubagentRegistry,
  createDefaultGpt5HighSubagents,
  createSubagentRegistry,
  resolveAssignmentSubagent,
  resolveSubagent,
  SubagentRegistryError,
} from '../runtime/subagent-registry.js';

test('default registry exposes four gpt-5-high agents for required roles', () => {
  const subagents = createDefaultGpt5HighSubagents();
  const registry = createDefaultGpt5HighSubagentRegistry();

  assert.equal(subagents.length, 4);
  assert.deepEqual(
    subagents.map((subagent) => subagent.role).sort(),
    ['inspector/dispatcher', 'planner', 'registry', 'worktree'],
  );
  assert.ok(
    subagents.every(
      (subagent) =>
        subagent.modelProfile === 'gpt-5-high' && subagent.maxConcurrency >= 1,
    ),
  );
  assert.deepEqual(
    registry.subagents.map((subagent) => subagent.id),
    [
      'agent-inspector-dispatcher',
      'agent-planner',
      'agent-registry',
      'agent-worktree',
    ],
  );
});

test('registry rejects duplicate subagent ids', () => {
  const first = createSubagent('agent-a', ['build']);
  const duplicate = createSubagent('agent-a', ['test']);

  assert.throws(
    () => createSubagentRegistry({ subagents: [first, duplicate] }),
    (error: unknown) =>
      error instanceof SubagentRegistryError &&
      error.code === 'DUPLICATE_SUBAGENT_ID',
  );
});

test('registry rejects duplicate capabilities after normalization', () => {
  const subagent = createSubagent('agent-a', ['build', ' build ']);

  assert.throws(
    () => createSubagentRegistry({ subagents: [subagent] }),
    (error: unknown) =>
      error instanceof SubagentRegistryError &&
      error.code === 'DUPLICATE_SUBAGENT_CAPABILITY',
  );
});

test('resolveSubagent matches every required capability', () => {
  const registry = createSubagentRegistry({
    subagents: [
      createSubagent('agent-a', ['build']),
      createSubagent('agent-b', ['build', 'test']),
    ],
  });

  const selected = resolveSubagent(registry, {
    requiredCapabilityIds: ['build', 'test'],
  });

  assert.equal(selected.id, 'agent-b');
});

test('resolveAssignmentSubagent routes from assignment capability requirements', () => {
  const registry = createSubagentRegistry({
    subagents: [
      createSubagent('agent-a', ['build']),
      createSubagent('agent-b', ['build', 'inspect']),
    ],
  });

  const selected = resolveAssignmentSubagent(registry, {
    requiredCapabilityIds: ['inspect'],
  });

  assert.equal(selected.id, 'agent-b');
});

test('host capability mismatch returns typed no-compatible error', () => {
  const registry = createSubagentRegistry({
    subagents: [createSubagent('agent-a', ['build'])],
  });

  assert.throws(
    () =>
      resolveSubagent(registry, {
        requiredCapabilityIds: ['build'],
        dispatch: {
          workloadClass: 'typescript',
          requiredHostCapabilities: ['node'],
        },
        hostCapabilities: {
          workloadClasses: ['python'],
          capabilities: ['sqlite'],
        },
      }),
    (error: unknown) =>
      error instanceof SubagentRegistryError &&
      error.code === 'NO_COMPATIBLE_SUBAGENT',
  );

  const compatibility = checkSubagentCompatibility(createSubagent('agent-a', ['build']), {
    dispatch: {
      workloadClass: 'typescript',
      requiredHostCapabilities: ['node'],
    },
    hostCapabilities: {
      workloadClasses: ['python'],
      capabilities: ['sqlite'],
    },
  });

  assert.equal(compatibility.compatible, false);
  assert.deepEqual(compatibility.missingWorkloadClasses, ['typescript']);
  assert.deepEqual(compatibility.missingHostCapabilities, ['node']);
});

test('selection order is deterministic by normalized subagent id', () => {
  const registry = createSubagentRegistry({
    subagents: [
      createSubagent('agent-z', ['build']),
      createSubagent('agent-a', ['build']),
      createSubagent('agent-m', ['build']),
    ],
  });

  assert.deepEqual(
    registry.subagents.map((subagent) => subagent.id),
    ['agent-a', 'agent-m', 'agent-z'],
  );
  assert.equal(
    resolveSubagent(registry, { requiredCapabilityIds: ['build'] }).id,
    'agent-a',
  );
});

test('custom model profile still requires model name via orchestration contract', () => {
  const customWithoutModel = {
    id: 'custom-agent',
    role: 'custom',
    host: 'copilot',
    modelProfile: 'custom',
    capabilities: ['build'],
    maxConcurrency: 1,
  };

  assert.throws(
    () =>
      createSubagentRegistry({
        subagents: [customWithoutModel as OrchestrationSubagent],
      }),
    /custom modelProfile requires a concrete model name/,
  );

  const registry = createSubagentRegistry({
    subagents: [
      {
        ...customWithoutModel,
        model: 'vendor-model',
      } as OrchestrationSubagent,
    ],
  });

  assert.equal(registry.subagents[0]?.model, 'vendor-model');
});

function createSubagent(
  id: string,
  capabilities: readonly string[],
): OrchestrationSubagent {
  return {
    id,
    role: 'worker',
    host: 'copilot',
    modelProfile: 'gpt-5-high',
    capabilities: [...capabilities],
    maxConcurrency: 1,
  };
}
