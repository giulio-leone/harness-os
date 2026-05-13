import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('published CLI entrypoints keep a node shebang', () => {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const distRoot = join(currentDir, '..');
  const expectedBins = [
    'agent-harness-install-mcp.js',
    'agent-harness-setup.js',
    'agent-harness-sync.js',
    'agent-runner.js',
    'scheduler-inject.js',
    'session-lifecycle.js',
    'session-lifecycle-mcp.js',
    'supervisor.js',
  ];

  for (const entry of expectedBins) {
    const contents = readFileSync(join(distRoot, 'bin', entry), 'utf8');
    assert.match(
      contents,
      /^#!\/usr\/bin\/env node\n/,
      `${entry} must start with a node shebang`,
    );
  }
});
