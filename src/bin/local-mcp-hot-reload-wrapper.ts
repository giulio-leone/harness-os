import { isAbsolute, resolve } from 'node:path';

import { LocalMcpHotReloadWrapper } from '../mcp/local-mcp-hot-reload-wrapper.js';

interface ParsedCliOptions {
  childCommand: string;
  childArgs: string[];
  watchPaths: string[];
  cwd?: string;
  name?: string;
  reloadDebounceMs?: number;
  requestTimeoutMs?: number;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const wrapper = new LocalMcpHotReloadWrapper({
    ...options,
    env: process.env,
  });

  wrapper.start();
}

function parseArgs(argv: string[]): ParsedCliOptions {
  const watchPaths: string[] = [];
  let cwd: string | undefined;
  let name: string | undefined;
  let reloadDebounceMs: number | undefined;
  let requestTimeoutMs: number | undefined;
  let separatorIndex = argv.indexOf('--');

  if (separatorIndex === -1) {
    separatorIndex = argv.length;
  }

  let index = 0;

  while (index < separatorIndex) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case '--watch':
        if (next === undefined) {
          throw new Error('Missing value for --watch');
        }
        watchPaths.push(resolveArgPath(next, cwd));
        index += 2;
        break;
      case '--cwd':
        if (next === undefined) {
          throw new Error('Missing value for --cwd');
        }
        cwd = resolveArgPath(next, undefined);
        index += 2;
        break;
      case '--name':
        if (next === undefined) {
          throw new Error('Missing value for --name');
        }
        name = next;
        index += 2;
        break;
      case '--reload-debounce-ms':
        if (next === undefined) {
          throw new Error('Missing value for --reload-debounce-ms');
        }
        reloadDebounceMs = parsePositiveInteger(
          next,
          '--reload-debounce-ms',
        );
        index += 2;
        break;
      case '--request-timeout-ms':
        if (next === undefined) {
          throw new Error('Missing value for --request-timeout-ms');
        }
        requestTimeoutMs = parsePositiveInteger(
          next,
          '--request-timeout-ms',
        );
        index += 2;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const childArgv = argv.slice(separatorIndex + 1);

  if (childArgv.length === 0) {
    throw new Error('Expected child command after --');
  }

  const childCommand = childArgv[0];
  const childArgs = childArgv.slice(1);

  return {
    childCommand,
    childArgs,
    watchPaths,
    cwd,
    name,
    reloadDebounceMs,
    requestTimeoutMs,
  };
}

function parsePositiveInteger(value: string, flagName: string): number {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer for ${flagName}, got: ${value}`);
  }

  return parsed;
}

function resolveArgPath(value: string, cwd: string | undefined): string {
  if (isAbsolute(value)) {
    return value;
  }

  return resolve(cwd ?? process.cwd(), value);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
