import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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

  assert.match(readme, /docs\/workload-profiles\.md/);
  assert.match(guide, /examples\/consumer-workspace-template/);
  assert.match(guide, /examples\/research-workspace-template/);
  assert.match(guide, /examples\/ops-workspace-template/);
  assert.match(guide, /examples\/support-workspace-template/);
});
