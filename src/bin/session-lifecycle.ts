import { readFile } from 'node:fs/promises';

import { FileBackedMem0Adapter } from '../memory/file-mem0-adapter.js';
import {
  formatSessionLifecycleError,
  SessionLifecycleAdapter,
} from '../runtime/session-lifecycle-adapter.js';
import { SessionOrchestrator } from '../runtime/session-orchestrator.js';

async function main(): Promise<void> {
  const rawPayload = await readCommandPayload(process.argv.slice(2));
  const payload = JSON.parse(rawPayload) as unknown;
  const adapter = new SessionLifecycleAdapter(
    new SessionOrchestrator({
      mem0Adapter: FileBackedMem0Adapter.fromEnv(),
    }),
  );
  const result = await adapter.execute(payload);

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify(formatSessionLifecycleError(error), null, 2)}\n`);
  process.exit(1);
});

async function readCommandPayload(argv: string[]): Promise<string> {
  const inputFlagIndex = argv.indexOf('--input');

  if (inputFlagIndex !== -1) {
    const inputPath = argv[inputFlagIndex + 1];

    if (inputPath === undefined) {
      throw new Error('Missing value for --input');
    }

    return readFile(inputPath, 'utf8');
  }

  if (process.stdin.isTTY) {
    throw new Error('Provide a JSON payload on stdin or with --input <path>');
  }

  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf8');
}
