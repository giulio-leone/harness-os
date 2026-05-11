import assert from 'node:assert/strict';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildBundledSkillManifest,
  getBundledSkillManifestPath,
  getBundledSkillsDir,
  loadBundledSkillManifest,
  renderBundledSkillManifest,
  validateInstalledSkillBundle,
} from '../runtime/bundled-skill-manifest.js';
import { getHarnessCapabilityCatalog } from '../runtime/harness-capability-catalog.js';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

test('bundled skill manifest stays rendered from the canonical skill bundle source', () => {
  const expected = renderBundledSkillManifest(buildBundledSkillManifest(repoRoot));
  const actual = readFileSync(getBundledSkillManifestPath(repoRoot), 'utf8');

  assert.equal(actual, expected);
});

test('capability catalog skills expose bundle version and workload profile metadata', () => {
  const manifest = loadBundledSkillManifest(repoRoot);
  const catalog = getHarnessCapabilityCatalog({ packageRoot: repoRoot });
  const harnessLifecycle = catalog.skills.find((entry) => entry.id === 'harness-lifecycle');

  assert.ok(harnessLifecycle);
  assert.equal(harnessLifecycle?.bundleVersion, manifest.bundleVersion);
  assert.equal(harnessLifecycle?.version, manifest.bundleVersion);
  assert.ok(Array.isArray(catalog.workloadProfiles));
  assert.equal(catalog.workloadProfiles.length, 6);
  assert.ok(harnessLifecycle?.workloadProfileIds.includes('coding'));
  assert.ok(harnessLifecycle?.workloadProfileIds.includes('assistant'));
  assert.equal(typeof harnessLifecycle?.checksum, 'string');
});

test('capability catalog exposes Symphony orchestration discovery metadata', () => {
  const catalog = getHarnessCapabilityCatalog({ packageRoot: repoRoot });
  const symphonyTool = catalog.tools.find((entry) => entry.name === 'harness_symphony');

  assert.ok(symphonyTool, 'harness_symphony must be discoverable as an MCP tool');
  assert.deepEqual(
    symphonyTool.actions.map((entry) => entry.action),
    ['compile_plan', 'dispatch_ready', 'inspect_state', 'dashboard_view'],
  );
  assert.equal(catalog.orchestration.mode, 'symphony');
  assert.equal(catalog.orchestration.tool, 'harness_symphony');
  assert.equal(catalog.orchestration.defaultModelProfile, 'gpt-5-high');
  assert.equal(catalog.orchestration.defaultMaxConcurrentAgents, 4);
  assert.deepEqual(catalog.orchestration.actions, {
    compilePlan: 'compile_plan',
    dispatchReady: 'dispatch_ready',
    inspectState: 'inspect_state',
    dashboardView: 'dashboard_view',
  });
  assert.ok(catalog.orchestration.requiredDispatchFields.includes('repoRoot'));
  assert.equal(catalog.orchestration.worktreeIsolation.strategy, 'one_worktree_per_issue');
  assert.equal(catalog.orchestration.worktreeIsolation.mcpCreatesWorktrees, false);
  assert.ok(catalog.orchestration.evidence.acceptedArtifactKinds.includes('test_report'));
  assert.ok(catalog.orchestration.evidence.acceptedArtifactKinds.includes('screenshot'));
  assert.ok(
    catalog.orchestration.evidence.runtimeMetadataArtifactKinds.includes(
      'orchestration_worktree',
    ),
  );
  assert.ok(
    catalog.suggestedBootstrap.some(
      (step) =>
        step.tool === 'harness_symphony' &&
        step.action === 'dispatch_ready' &&
        step.requiredFields?.includes('worktreeRoot'),
    ),
  );
});

test('capability catalog can filter skills by workload profile', () => {
  const manifest = loadBundledSkillManifest(repoRoot);
  const codingCatalog = getHarnessCapabilityCatalog({
    packageRoot: repoRoot,
    workloadProfileId: 'coding',
  });
  const researchCatalog = getHarnessCapabilityCatalog({
    packageRoot: repoRoot,
    workloadProfileId: 'research',
  });
  const opsCatalog = getHarnessCapabilityCatalog({
    packageRoot: repoRoot,
    workloadProfileId: 'ops',
  });
  const salesCatalog = getHarnessCapabilityCatalog({
    packageRoot: repoRoot,
    workloadProfileId: 'sales',
  });
  const supportCatalog = getHarnessCapabilityCatalog({
    packageRoot: repoRoot,
    workloadProfileId: 'support',
  });
  const assistantCatalog = getHarnessCapabilityCatalog({
    packageRoot: repoRoot,
    workloadProfileId: 'assistant',
  });

  assert.equal(codingCatalog.activeWorkloadProfileId, 'coding');
  assert.equal(researchCatalog.activeWorkloadProfileId, 'research');
  assert.equal(opsCatalog.activeWorkloadProfileId, 'ops');
  assert.equal(salesCatalog.activeWorkloadProfileId, 'sales');
  assert.equal(supportCatalog.activeWorkloadProfileId, 'support');
  assert.equal(assistantCatalog.activeWorkloadProfileId, 'assistant');
  assert.ok(codingCatalog.skills.some((entry) => entry.id === 'code-review'));
  assert.ok(researchCatalog.skills.some((entry) => entry.id === 'systematic-debugging'));
  assert.equal(researchCatalog.skills.some((entry) => entry.id === 'code-review'), false);
  assert.ok(opsCatalog.skills.some((entry) => entry.id === 'performance-audit'));
  assert.equal(opsCatalog.skills.some((entry) => entry.id === 'git-workflow'), false);
  assert.ok(salesCatalog.skills.every((entry) => entry.workloadProfileIds.includes('sales')));
  assert.equal(salesCatalog.skills.some((entry) => entry.id === 'code-review'), false);
  assert.ok(supportCatalog.skills.some((entry) => entry.id === 'error-handling-patterns'));
  assert.equal(supportCatalog.skills.some((entry) => entry.id === 'dependency-management'), false);
  assert.equal(assistantCatalog.skills.length, manifest.skills.length);
});

test('validateInstalledSkillBundle detects drifted and unexpected host files', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'skill-bundle-validation-'));
  const hostSkillsDir = join(tempDir, 'skills');
  const manifest = loadBundledSkillManifest(repoRoot);

  try {
    cpSync(getBundledSkillsDir(repoRoot), hostSkillsDir, { recursive: true });
    writeFileSync(join(hostSkillsDir, 'harness-lifecycle', 'SKILL.md'), 'drifted\n', 'utf8');
    writeFileSync(join(hostSkillsDir, 'unexpected.txt'), 'unexpected\n', 'utf8');

    const result = validateInstalledSkillBundle(hostSkillsDir, manifest);
    assert.equal(result.manifestMismatch, false);
    assert.ok(result.driftedFiles.includes('harness-lifecycle/SKILL.md'));
    assert.ok(result.unexpectedFiles.includes('unexpected.txt'));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
