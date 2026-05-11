import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  GETTING_STARTED_EXAMPLES_END,
  GETTING_STARTED_EXAMPLES_START,
  README_PLAN_ISSUES_END,
  README_PLAN_ISSUES_START,
  README_PUBLIC_CONTRACTS_END,
  README_PUBLIC_CONTRACTS_START,
  getHarnessToolContracts,
  getHarnessToolInputJsonSchema,
  getSessionLifecycleCliExamples,
  renderGettingStartedExamplesSection,
  renderReadmePlanIssuesExample,
  renderReadmePublicContractsSection,
  renderSessionLifecycleCliExample,
} from '../runtime/harness-tool-contracts.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(currentDir, '..', '..');

test('session lifecycle example files stay rendered from canonical public contracts', () => {
  for (const example of getSessionLifecycleCliExamples()) {
    const actual = readFileSync(
      join(repoRoot, 'examples', 'session-lifecycle', example.fileName),
      'utf8',
    );
    assert.equal(actual, renderSessionLifecycleCliExample(example));
  }
});

test('README generated public contract sections stay in sync with canonical model', () => {
  const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');

  assert.equal(
    extractGeneratedBlock(readme, README_PUBLIC_CONTRACTS_START, README_PUBLIC_CONTRACTS_END),
    renderReadmePublicContractsSection(),
  );
  assert.equal(
    extractGeneratedBlock(readme, README_PLAN_ISSUES_START, README_PLAN_ISSUES_END),
    renderReadmePlanIssuesExample(),
  );
});

test('getting started generated example section stays in sync with canonical model', () => {
  const gettingStarted = readFileSync(
    join(repoRoot, 'docs', 'getting-started.md'),
    'utf8',
  );

  assert.equal(
    extractGeneratedBlock(
      gettingStarted,
      GETTING_STARTED_EXAMPLES_START,
      GETTING_STARTED_EXAMPLES_END,
    ),
    renderGettingStartedExamplesSection(),
  );
});

test('orchestration MCP examples stay compatible with public tool schemas', () => {
  const contractByName = new Map(
    getHarnessToolContracts().map((contract) => [contract.name, contract]),
  );
  const examplesDir = join(repoRoot, 'examples', 'orchestration-symphony');
  const files = readdirSync(examplesDir)
    .filter((fileName) => fileName.endsWith('.json'))
    .sort();

  assert.ok(files.length > 0, 'orchestration examples should not be empty');

  for (const fileName of files) {
    const examplePath = join(examplesDir, fileName);
    const parsed = JSON.parse(readFileSync(examplePath, 'utf8')) as unknown;

    assert.ok(isRecord(parsed), `${fileName} should contain a JSON object`);
    const toolName = parsed.tool;
    if (typeof toolName !== 'string') {
      assert.fail(`${fileName} should declare tool`);
    }

    const contract = contractByName.get(toolName);
    assert.ok(contract, `${fileName} should use a known Harness MCP tool`);
    contract.inputSchema.parse(parsed.input);
  }
});

test('tool input JSON schemas stay compatible with object-root function calling clients', () => {
  for (const contract of getHarnessToolContracts()) {
    const schema = getHarnessToolInputJsonSchema(contract.name);

    assert.equal(schema.type, 'object', `${contract.name} should expose an object root`);
    assert.equal(
      schema.additionalProperties,
      false,
      `${contract.name} should remain strict at the public boundary`,
    );
    assert.equal('oneOf' in schema, false, `${contract.name} should not expose top-level oneOf`);
    assert.equal('anyOf' in schema, false, `${contract.name} should not expose top-level anyOf`);
    assert.equal('allOf' in schema, false, `${contract.name} should not expose top-level allOf`);
    assert.equal('enum' in schema, false, `${contract.name} should not expose top-level enum`);
    assert.equal('not' in schema, false, `${contract.name} should not expose top-level not`);

    const properties = schema.properties;
    assert.ok(isRecord(properties), `${contract.name} should expose properties`);

    const actionProperty = properties.action;
    assert.ok(isRecord(actionProperty), `${contract.name} should expose an action property`);
    assert.equal(actionProperty.type, 'string');
    assert.ok(Array.isArray(actionProperty.enum));
    assert.ok(actionProperty.enum.every((value) => typeof value === 'string'));
    assert.ok(actionProperty.enum.length > 0);

    const required = schema.required;
    assert.ok(Array.isArray(required), `${contract.name} should declare required fields`);
    assert.ok(required.includes('action'));
  }
});

test('harness_symphony schema exposes the dedicated orchestration action enum', () => {
  const schema = getHarnessToolInputJsonSchema('harness_symphony');
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.ok(isRecord(schema.properties));

  const actionProperty = schema.properties['action'];
  assert.ok(isRecord(actionProperty));
  assert.deepEqual(actionProperty.enum, [
    'compile_plan',
    'dispatch_ready',
    'inspect_state',
    'dashboard_view',
  ]);
});

test('harness_symphony dashboard_view accepts strict dashboard filters', () => {
  const contract = getHarnessToolContracts().find(
    (tool) => tool.name === 'harness_symphony',
  );
  assert.ok(contract);

  const parsed = contract.inputSchema.parse({
    action: 'dashboard_view',
    projectName: 'HarnessOS',
    eventLimit: 25,
    filters: {
      q: 'evidence',
      lane: ['ready'],
      status: ['ready'],
      priority: ['high'],
      evidenceKind: ['screenshot'],
      csqr: 'any',
      signal: 'evidence',
      hasCsqr: true,
    },
  });
  assert.ok(isRecord(parsed));

  assert.deepEqual(parsed.filters, {
    q: 'evidence',
    lane: ['ready'],
    status: ['ready'],
    priority: ['high'],
    evidenceKind: ['screenshot'],
    csqr: 'any',
    signal: 'evidence',
    hasCsqr: true,
  });
  assert.equal(
    contract.inputSchema.safeParse({
      action: 'dashboard_view',
      projectName: 'HarnessOS',
      filters: { signal: 'unknown' },
    }).success,
    false,
  );
});

function extractGeneratedBlock(
  content: string,
  startMarker: string,
  endMarker: string,
): string {
  const startIndex = content.indexOf(startMarker);
  const endIndex = content.indexOf(endMarker);

  assert.notEqual(startIndex, -1, `Missing start marker ${startMarker}`);
  assert.notEqual(endIndex, -1, `Missing end marker ${endMarker}`);
  assert.ok(endIndex > startIndex, `Invalid marker order for ${startMarker}`);

  return content
    .slice(startIndex + startMarker.length, endIndex)
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
