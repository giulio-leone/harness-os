import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { WorkloadProfileId } from '../contracts/workload-profiles.js';

const requireFromHere = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const CODEX_HARNESS_SERVER_NAME = 'harness_os';
export const JSON_HARNESS_SERVER_NAME = 'agent-harness';
export const DEFAULT_HARNESS_HOME = join(homedir(), '.agent-harness');
export const DEFAULT_HARNESS_DB_PATH = join(
  DEFAULT_HARNESS_HOME,
  'harness.sqlite',
);
export const DEFAULT_MEM0_STORE_PATH = join(DEFAULT_HARNESS_HOME, 'mem0');
export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
export const DEFAULT_MEM0_EMBED_MODEL = 'qwen3-embedding:latest';
export const DEFAULT_COPILOT_MCP_CONFIG_PATH = join(
  homedir(),
  '.copilot',
  'mcp-config.json',
);
export const DEFAULT_ANTIGRAVITY_MCP_CONFIG_PATH = join(
  homedir(),
  '.gemini',
  'antigravity',
  'mcp_config.json',
);

export interface HarnessMcpServerDefinition {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface HarnessMcpServerDefinitionInput {
  nodeCommand?: string;
  serverScriptPath?: string;
  dbPath?: string;
  mem0StorePath?: string;
  mem0ModulePath?: string;
  ollamaBaseUrl?: string;
  mem0EmbedModel?: string;
  workloadProfileId?: WorkloadProfileId;
}

interface JsonMcpConfig {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

export function buildHarnessMcpServerDefinition(
  input: HarnessMcpServerDefinitionInput = {},
): HarnessMcpServerDefinition {
  const serverScriptPath = resolvePath(
    input.serverScriptPath ?? resolveDefaultMcpServerScriptPath(),
  );
  const env = buildHarnessMcpEnvironment(input);

  return {
    command: input.nodeCommand ?? process.execPath,
    args: [serverScriptPath],
    env,
  };
}

export function buildHarnessMcpEnvironment(
  input: HarnessMcpServerDefinitionInput = {},
): Record<string, string> {
  const mem0ModulePath =
    input.mem0ModulePath ?? resolveDefaultMem0ModulePath();

  const envEntries: Array<[string, string]> = [
    ['HARNESS_DB_PATH', resolvePath(input.dbPath ?? DEFAULT_HARNESS_DB_PATH)],
    [
      'MEM0_STORE_PATH',
      resolvePath(input.mem0StorePath ?? DEFAULT_MEM0_STORE_PATH),
    ],
    [
      'OLLAMA_BASE_URL',
      input.ollamaBaseUrl ?? DEFAULT_OLLAMA_BASE_URL,
    ],
    [
      'MEM0_EMBED_MODEL',
      input.mem0EmbedModel ?? DEFAULT_MEM0_EMBED_MODEL,
    ],
  ];

  if (typeof mem0ModulePath === 'string' && mem0ModulePath.length > 0) {
    envEntries.push([
      'AGENT_HARNESS_MEM0_MODULE_PATH',
      resolvePath(mem0ModulePath),
    ]);
  }

  if (input.workloadProfileId) {
    envEntries.push(['HARNESS_WORKLOAD_PROFILE', input.workloadProfileId]);
  }

  return Object.fromEntries(envEntries);
}

export function buildCodexMcpAddCommand(input: {
  definition: HarnessMcpServerDefinition;
  codexCommand?: string;
  serverName?: string;
}): string[] {
  const envArgs = Object.entries(input.definition.env)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .flatMap(([key, value]) => ['--env', `${key}=${value}`]);

  return [
    input.codexCommand ?? 'codex',
    'mcp',
    'add',
    input.serverName ?? CODEX_HARNESS_SERVER_NAME,
    ...envArgs,
    '--',
    input.definition.command,
    ...input.definition.args,
  ];
}

export function upsertCopilotHarnessServer(
  config: unknown,
  definition: HarnessMcpServerDefinition,
): JsonMcpConfig {
  return upsertJsonMcpServer(config, JSON_HARNESS_SERVER_NAME, definition);
}

export function upsertAntigravityHarnessServer(
  config: unknown,
  definition: HarnessMcpServerDefinition,
): JsonMcpConfig {
  return upsertJsonMcpServer(config, JSON_HARNESS_SERVER_NAME, definition);
}

export function readJsonFileOrDefault<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) {
    return fallback;
  }

  return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}

export function writeJsonFile(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function backupFileIfExists(
  filePath: string,
  suffix = `bak-${buildTimestampToken(new Date())}`,
): string | null {
  if (!existsSync(filePath)) {
    return null;
  }

  const backupPath = `${filePath}.${suffix}`;
  copyFileSync(filePath, backupPath);
  return backupPath;
}

export function ensureHarnessRuntimeDirectories(
  definition: HarnessMcpServerDefinition,
): void {
  const dbPath = definition.env['HARNESS_DB_PATH'];
  const mem0StorePath = definition.env['MEM0_STORE_PATH'];

  if (dbPath) {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  if (mem0StorePath) {
    mkdirSync(mem0StorePath, { recursive: true });
  }
}

export function resolveDefaultMcpServerScriptPath(): string {
  const distCandidate = resolve(__dirname, '..', 'bin', 'session-lifecycle-mcp.js');
  if (existsSync(distCandidate)) {
    return distCandidate;
  }

  return resolve(__dirname, '..', '..', 'dist', 'bin', 'session-lifecycle-mcp.js');
}

export function resolveDefaultMem0ModulePath(): string | undefined {
  try {
    return requireFromHere.resolve('mem0-mcp');
  } catch {
    return undefined;
  }
}

export function resolveGlobalMem0ModulePath(
  globalNodeModulesRoot: string,
): string | undefined {
  const candidates = [
    join(globalNodeModulesRoot, 'mem0-mcp', 'dist', 'index.js'),
    join(globalNodeModulesRoot, 'mem0-mcp', 'dist', 'index.mjs'),
    join(globalNodeModulesRoot, 'mem0-mcp', 'dist', 'index.cjs'),
  ];

  return candidates.find((candidate) => existsSync(candidate));
}

function upsertJsonMcpServer(
  config: unknown,
  serverName: string,
  definition: HarnessMcpServerDefinition,
): JsonMcpConfig {
  const normalized = normalizeJsonMcpConfig(config);
  const mcpServers = {
    ...normalized.mcpServers,
    [serverName]: {
      command: definition.command,
      args: [...definition.args],
      env: { ...definition.env },
    },
  };

  return {
    ...normalized,
    mcpServers,
  };
}

function normalizeJsonMcpConfig(config: unknown): JsonMcpConfig {
  if (!isRecord(config)) {
    return { mcpServers: {} };
  }

  const mcpServers = isRecord(config['mcpServers']) ? config['mcpServers'] : {};

  return {
    ...config,
    mcpServers,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolvePath(value: string): string {
  if (value === '~') {
    return homedir();
  }

  if (value.startsWith('~/')) {
    return resolve(homedir(), value.slice(2));
  }

  return resolve(value);
}

function buildTimestampToken(input: Date): string {
  return input.toISOString().replaceAll(':', '-');
}
