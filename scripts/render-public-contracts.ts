import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
} from '../src/runtime/harness-tool-contracts.ts';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

renderExampleFiles();
replaceGeneratedSection(
  join(repoRoot, 'README.md'),
  README_PUBLIC_CONTRACTS_START,
  README_PUBLIC_CONTRACTS_END,
  renderReadmePublicContractsSection(),
);
replaceGeneratedSection(
  join(repoRoot, 'README.md'),
  README_PLAN_ISSUES_START,
  README_PLAN_ISSUES_END,
  renderReadmePlanIssuesExample(),
);
replaceGeneratedSection(
  join(repoRoot, 'docs', 'getting-started.md'),
  GETTING_STARTED_EXAMPLES_START,
  GETTING_STARTED_EXAMPLES_END,
  renderGettingStartedExamplesSection(),
);

function renderExampleFiles(): void {
  const examplesDir = join(repoRoot, 'examples', 'session-lifecycle');
  mkdirSync(examplesDir, { recursive: true });

  for (const example of getSessionLifecycleCliExamples()) {
    writeFileSync(
      join(examplesDir, example.fileName),
      renderSessionLifecycleCliExample(example),
      'utf8',
    );
  }
}

function replaceGeneratedSection(
  filePath: string,
  startMarker: string,
  endMarker: string,
  rendered: string,
): void {
  const current = readFileSync(filePath, 'utf8');
  const escapedStart = escapeRegExp(startMarker);
  const escapedEnd = escapeRegExp(endMarker);
  const pattern = new RegExp(`${escapedStart}[\\s\\S]*?${escapedEnd}`);

  if (!pattern.test(current)) {
    throw new Error(`Missing generated block markers in ${filePath}`);
  }

  const next = current.replace(
    pattern,
    `${startMarker}\n${rendered}\n${endMarker}`,
  );
  writeFileSync(filePath, next, 'utf8');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
