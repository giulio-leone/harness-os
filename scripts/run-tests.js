import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const testDir = 'dist/test';
const files = readdirSync(testDir)
  .filter(f => f.endsWith('.test.js'))
  .map(f => join(testDir, f));

console.log(`Running tests: ${files.join(', ')}`);

const result = spawnSync('node', [
  '--disable-warning=ExperimentalWarning',
  '--test',
  ...files
], { stdio: 'inherit' });

process.exit(result.status ?? 1);
