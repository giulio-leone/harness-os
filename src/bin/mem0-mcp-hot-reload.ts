import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LocalMcpHotReloadWrapper } from '../mcp/local-mcp-hot-reload-wrapper.js';

async function main(): Promise<void> {
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  const tsxBinary = join(
    repoRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
  );

  if (!existsSync(tsxBinary)) {
    throw new Error(
      `tsx binary not found at ${tsxBinary}. Run npm install in agent-harness-core before starting the hot-reload wrapper.`,
    );
  }

  const wrapper = new LocalMcpHotReloadWrapper({
    name: 'mem0-mcp',
    childCommand: tsxBinary,
    childArgs: [join(repoRoot, 'src', 'bin', 'mem0-mcp.ts')],
    cwd: repoRoot,
    env: process.env,
    watchPaths: [
      join(repoRoot, 'src'),
      join(repoRoot, 'package.json'),
      join(repoRoot, 'tsconfig.json'),
    ],
  });

  wrapper.start();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
