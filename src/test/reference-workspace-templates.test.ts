import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { HARNESS_TOOL_CONTRACTS } from '../runtime/harness-tool-contracts.js';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

const referenceTemplates = [
  {
    profileId: 'assistant',
    directory: 'examples/consumer-workspace-template',
  },
  {
    profileId: 'research',
    directory: 'examples/research-workspace-template',
  },
  {
    profileId: 'ops',
    directory: 'examples/ops-workspace-template',
  },
  {
    profileId: 'support',
    directory: 'examples/support-workspace-template',
  },
] as const;

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('reference workspace templates ship for assistant and non-coding profiles', () => {
  for (const template of referenceTemplates) {
    assert.equal(
      existsSync(resolve(repoRoot, template.directory, 'README.md')),
      true,
      `missing README for ${template.profileId}`,
    );
    assert.equal(
      existsSync(resolve(repoRoot, template.directory, '.harness', 'seed-live-catalog.py')),
      true,
      `missing seeder for ${template.profileId}`,
    );
  }
});

test('research, ops, and support live catalogs include first-class workflow metadata', () => {
  for (const directory of [
    'examples/research-workspace-template',
    'examples/ops-workspace-template',
    'examples/support-workspace-template',
  ] as const) {
    const catalog = JSON.parse(
      readFileSync(resolve(repoRoot, directory, '.harness', 'live-mission-catalog.json'), 'utf8'),
    ) as {
      issues: Array<{
        deadlineAt?: string;
        recipients?: unknown[];
        approvals?: unknown[];
        externalRefs?: unknown[];
      }>;
    };

    assert.ok(catalog.issues.length > 0, `${directory} should ship issues`);
    assert.ok(
      catalog.issues.every((issue) => typeof issue.deadlineAt === 'string'),
      `${directory} should persist deadlineAt on every issue`,
    );
    assert.ok(
      catalog.issues.some((issue) => Array.isArray(issue.recipients) && issue.recipients.length > 0),
      `${directory} should ship recipients metadata`,
    );
    assert.ok(
      catalog.issues.some((issue) => Array.isArray(issue.approvals) && issue.approvals.length > 0),
      `${directory} should ship approvals metadata`,
    );
    assert.ok(
      catalog.issues.some((issue) => Array.isArray(issue.externalRefs) && issue.externalRefs.length > 0),
      `${directory} should ship externalRefs metadata`,
    );
  }
});

test('reference workspace seeders persist workflow metadata columns', () => {
  for (const template of referenceTemplates) {
    const seeder = readFileSync(
      resolve(repoRoot, template.directory, '.harness', 'seed-live-catalog.py'),
      'utf8',
    );

    assert.match(seeder, /deadline_at/);
    assert.match(seeder, /recipients_json/);
    assert.match(seeder, /approvals_json/);
    assert.match(seeder, /external_refs_json/);
  }
});

test('workload profile docs point to the shipped reference workspaces', () => {
  const readme = readFileSync(resolve(repoRoot, 'README.md'), 'utf8');
  const guide = readFileSync(resolve(repoRoot, 'docs', 'workload-profiles.md'), 'utf8');
  const gettingStarted = readFileSync(resolve(repoRoot, 'docs', 'getting-started.md'), 'utf8');
  const skillsIndex = readFileSync(resolve(repoRoot, '.github', 'skills', 'README.md'), 'utf8');

  assert.match(readme, /docs\/workload-profiles\.md/);
  assert.match(readme, /docs\/mcp-tools\.md/);
  assert.match(readme, /docs\/cli-reference\.md/);
  assert.equal(existsSync(resolve(repoRoot, 'docs', 'mcp-tools.md')), true);
  assert.equal(existsSync(resolve(repoRoot, 'docs', 'cli-reference.md')), true);
  assert.match(guide, /examples\/consumer-workspace-template/);
  assert.match(guide, /examples\/research-workspace-template/);
  assert.match(guide, /examples\/ops-workspace-template/);
  assert.match(guide, /examples\/support-workspace-template/);
  assert.match(gettingStarted, /mcp-tools\.md/);
  assert.match(gettingStarted, /cli-reference\.md/);
  assert.match(skillsIndex, /Profile-to-skills mapping/);
  assert.match(skillsIndex, /Programmatic discoverability/);
});

test('MCP and CLI discoverability docs stay aligned with public contracts', () => {
  const mcpGuide = readFileSync(resolve(repoRoot, 'docs', 'mcp-tools.md'), 'utf8');
  const cliGuide = readFileSync(resolve(repoRoot, 'docs', 'cli-reference.md'), 'utf8');
  const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
    bin?: Record<string, string>;
  };

  assert.match(mcpGuide, /six MCP tools/);
  assert.match(mcpGuide, /hostCapabilities/);
  assert.equal(HARNESS_TOOL_CONTRACTS.length, 6);

  for (const tool of HARNESS_TOOL_CONTRACTS) {
    assert.match(mcpGuide, new RegExp(`\`${escapeForRegex(tool.name)}\``));
    for (const action of tool.actions) {
      assert.match(mcpGuide, new RegExp(`\`${escapeForRegex(action.action)}\``));
    }
  }

  const publicBins = Object.keys(packageJson.bin ?? {}).sort((left, right) => left.localeCompare(right));
  assert.equal(publicBins.length, 7);
  for (const bin of publicBins) {
    assert.match(cliGuide, new RegExp(`\`${escapeForRegex(bin)}\``));
  }
});
