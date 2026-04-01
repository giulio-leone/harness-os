#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  backupFileIfExists,
  buildCodexMcpAddCommand,
  buildHarnessMcpServerDefinition,
  CODEX_HARNESS_SERVER_NAME,
  DEFAULT_ANTIGRAVITY_MCP_CONFIG_PATH,
  DEFAULT_COPILOT_MCP_CONFIG_PATH,
  ensureHarnessRuntimeDirectories,
  readJsonFileOrDefault,
  resolveGlobalMem0ModulePath,
  upsertAntigravityHarnessServer,
  upsertCopilotHarnessServer,
  writeJsonFile,
  type HarnessMcpServerDefinition,
  type HarnessMcpServerDefinitionInput,
} from '../runtime/host-mcp-config.js';

type SupportedHost = 'codex' | 'copilot' | 'antigravity';

interface CliOptions extends HarnessMcpServerDefinitionInput {
  hosts: SupportedHost[];
  dryRun: boolean;
}

function main(): void {
  const options = hydrateDefaultInstallerOptions(parseArgs(process.argv.slice(2)));
  const definition = buildHarnessMcpServerDefinition(options);

  if (!options.dryRun) {
    ensureHarnessRuntimeDirectories(definition);
  }

  const messages = options.hosts.map((host) =>
    installHost(host, definition, options.dryRun),
  );

  for (const message of messages) {
    console.log(message);
  }
}

function installHost(
  host: SupportedHost,
  definition: HarnessMcpServerDefinition,
  dryRun: boolean,
): string {
  switch (host) {
    case 'codex':
      return installCodex(definition, dryRun);
    case 'copilot':
      return installJsonConfigHost({
        host,
        configPath: DEFAULT_COPILOT_MCP_CONFIG_PATH,
        definition,
        dryRun,
        updater: upsertCopilotHarnessServer,
      });
    case 'antigravity':
      return installJsonConfigHost({
        host,
        configPath: DEFAULT_ANTIGRAVITY_MCP_CONFIG_PATH,
        definition,
        dryRun,
        updater: upsertAntigravityHarnessServer,
      });
    default:
      return assertNever(host);
  }
}

function installCodex(
  definition: HarnessMcpServerDefinition,
  dryRun: boolean,
): string {
  const command = buildCodexMcpAddCommand({ definition });
  const [binary, ...args] = command;

  if (dryRun) {
    return `[dry-run] codex => ${command.join(' ')}`;
  }

  spawnSync('codex', ['mcp', 'remove', CODEX_HARNESS_SERVER_NAME], {
    encoding: 'utf8',
    stdio: 'pipe',
  });

  const result = spawnSync(binary, args, {
    encoding: 'utf8',
    stdio: 'pipe',
  });

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || 'codex mcp add failed');
  }

  return `codex => registered ${CODEX_HARNESS_SERVER_NAME}`;
}

function installJsonConfigHost(input: {
  host: Exclude<SupportedHost, 'codex'>;
  configPath: string;
  definition: HarnessMcpServerDefinition;
  dryRun: boolean;
  updater: (config: unknown, definition: HarnessMcpServerDefinition) => Record<string, unknown>;
}): string {
  const currentConfig = readJsonFileOrDefault<Record<string, unknown>>(
    input.configPath,
    { mcpServers: {} },
  );
  const nextConfig = input.updater(currentConfig, input.definition);

  if (input.dryRun) {
    return `[dry-run] ${input.host} => would update ${input.configPath}`;
  }

  const backupPath = backupFileIfExists(input.configPath);
  writeJsonFile(input.configPath, nextConfig);

  if (backupPath) {
    return `${input.host} => updated ${input.configPath} (backup: ${backupPath})`;
  }

  return `${input.host} => created ${input.configPath}`;
}

function parseArgs(argv: string[]): CliOptions {
  const hosts: SupportedHost[] = [];
  const options: HarnessMcpServerDefinitionInput = {};
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    switch (token) {
      case '--host':
        hosts.push(parseHost(readRequiredValue(argv, index, token)));
        index += 1;
        break;
      case '--db-path':
        options.dbPath = readRequiredValue(argv, index, token);
        index += 1;
        break;
      case '--mem0-store-path':
        options.mem0StorePath = readRequiredValue(argv, index, token);
        index += 1;
        break;
      case '--mem0-module-path':
        options.mem0ModulePath = readRequiredValue(argv, index, token);
        index += 1;
        break;
      case '--ollama-base-url':
        options.ollamaBaseUrl = readRequiredValue(argv, index, token);
        index += 1;
        break;
      case '--mem0-embed-model':
        options.mem0EmbedModel = readRequiredValue(argv, index, token);
        index += 1;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  return {
    ...options,
    hosts: dedupeHosts(hosts.length > 0 ? hosts : ['codex', 'copilot', 'antigravity']),
    dryRun,
  };
}

function hydrateDefaultInstallerOptions(options: CliOptions): CliOptions {
  if (options.mem0ModulePath) {
    return options;
  }

  const detectedMem0ModulePath = detectGlobalMem0ModulePath();

  if (!detectedMem0ModulePath) {
    return options;
  }

  return {
    ...options,
    mem0ModulePath: detectedMem0ModulePath,
  };
}

function readRequiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parseHost(value: string): SupportedHost {
  if (value === 'codex' || value === 'copilot' || value === 'antigravity') {
    return value;
  }

  throw new Error(`Unsupported host "${value}". Use codex, copilot, or antigravity.`);
}

function dedupeHosts(hosts: SupportedHost[]): SupportedHost[] {
  return [...new Set(hosts)];
}

function printHelp(): void {
  console.log(`Usage: harness-install-mcp [options]

Options:
  --host <codex|copilot|antigravity>  Install for a specific host (repeatable)
  --db-path <path>                    Override HARNESS_DB_PATH
  --mem0-store-path <path>            Override MEM0_STORE_PATH
  --mem0-module-path <path>           Override AGENT_HARNESS_MEM0_MODULE_PATH
  --ollama-base-url <url>             Override OLLAMA_BASE_URL
  --mem0-embed-model <name>           Override MEM0_EMBED_MODEL
  --dry-run                           Print planned changes without applying them
`);
}

function detectGlobalMem0ModulePath(): string | undefined {
  const npmRootResult = spawnSync('npm', ['root', '-g'], {
    encoding: 'utf8',
    stdio: 'pipe',
  });

  if (npmRootResult.status !== 0) {
    return undefined;
  }

  const globalRoot = npmRootResult.stdout.trim();

  if (!globalRoot || !existsSync(globalRoot)) {
    return undefined;
  }

  const resolved = resolveGlobalMem0ModulePath(globalRoot);

  if (resolved) {
    return resolved;
  }

  const fallbackCandidate = join(globalRoot, 'mem0-mcp', 'dist', 'index.js');
  return existsSync(fallbackCandidate) ? fallbackCandidate : undefined;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled host: ${String(value)}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
