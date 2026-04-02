import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
