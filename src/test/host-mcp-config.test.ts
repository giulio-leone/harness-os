import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  backupFileIfExists,
  buildCodexMcpAddCommand,
  buildHarnessMcpServerDefinition,
  readJsonFileOrDefault,
  resolveGlobalMem0ModulePath,
  upsertAntigravityHarnessServer,
  upsertCopilotHarnessServer,
  writeJsonFile,
} from '../index.js';

test('buildHarnessMcpServerDefinition builds installable stdio server definition', () => {
  const definition = buildHarnessMcpServerDefinition({
    nodeCommand: '/opt/homebrew/bin/node',
    serverScriptPath: '/pkg/dist/bin/session-lifecycle-mcp.js',
    dbPath: '/tmp/harness.sqlite',
    mem0StorePath: '/tmp/mem0',
    mem0ModulePath: '/pkg/node_modules/mem0-mcp/dist/index.js',
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    mem0EmbedModel: 'qwen3-embedding:latest',
    workloadProfileId: 'coding',
  });

  assert.deepEqual(definition, {
    command: '/opt/homebrew/bin/node',
    args: ['/pkg/dist/bin/session-lifecycle-mcp.js'],
    env: {
      HARNESS_DB_PATH: '/tmp/harness.sqlite',
      HARNESS_WORKLOAD_PROFILE: 'coding',
      MEM0_STORE_PATH: '/tmp/mem0',
      OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
      MEM0_EMBED_MODEL: 'qwen3-embedding:latest',
      AGENT_HARNESS_MEM0_MODULE_PATH: '/pkg/node_modules/mem0-mcp/dist/index.js',
    },
  });
});

test('buildCodexMcpAddCommand serializes env and stdio command', () => {
  const command = buildCodexMcpAddCommand({
    definition: {
      command: '/opt/homebrew/bin/node',
      args: ['/pkg/dist/bin/session-lifecycle-mcp.js'],
      env: {
        HARNESS_DB_PATH: '/tmp/harness.sqlite',
        MEM0_STORE_PATH: '/tmp/mem0',
      },
    },
  });

  assert.deepEqual(command, [
    'codex',
    'mcp',
    'add',
    'harness_os',
    '--env',
    'HARNESS_DB_PATH=/tmp/harness.sqlite',
    '--env',
    'MEM0_STORE_PATH=/tmp/mem0',
    '--',
    '/opt/homebrew/bin/node',
    '/pkg/dist/bin/session-lifecycle-mcp.js',
  ]);
});

test('upsertCopilotHarnessServer preserves existing MCP servers', () => {
  const updated = upsertCopilotHarnessServer(
    {
      mcpServers: {
        context7: {
          command: 'npx',
          args: ['-y', '@context7/mcp'],
        },
      },
    },
    {
      command: '/opt/homebrew/bin/node',
      args: ['/pkg/dist/bin/session-lifecycle-mcp.js'],
      env: {
        HARNESS_DB_PATH: '/tmp/harness.sqlite',
      },
    },
  );

  assert.deepEqual(updated, {
    mcpServers: {
      context7: {
        command: 'npx',
        args: ['-y', '@context7/mcp'],
      },
      'agent-harness': {
        command: '/opt/homebrew/bin/node',
        args: ['/pkg/dist/bin/session-lifecycle-mcp.js'],
        env: {
          HARNESS_DB_PATH: '/tmp/harness.sqlite',
        },
      },
    },
  });
});

test('upsertAntigravityHarnessServer preserves sibling config keys', () => {
  const updated = upsertAntigravityHarnessServer(
    {
      metadata: {
        version: 1,
      },
      mcpServers: {},
    },
    {
      command: '/opt/homebrew/bin/node',
      args: ['/pkg/dist/bin/session-lifecycle-mcp.js'],
      env: {
        HARNESS_DB_PATH: '/tmp/harness.sqlite',
      },
    },
  );

  assert.deepEqual(updated, {
    metadata: {
      version: 1,
    },
    mcpServers: {
      'agent-harness': {
        command: '/opt/homebrew/bin/node',
        args: ['/pkg/dist/bin/session-lifecycle-mcp.js'],
        env: {
          HARNESS_DB_PATH: '/tmp/harness.sqlite',
        },
      },
    },
  });
});

test('JSON config helpers read defaults, write files, and create backups', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'host-mcp-config-'));
  const configPath = join(tempDir, 'mcp-config.json');

  try {
    assert.deepEqual(
      readJsonFileOrDefault(configPath, { mcpServers: {} }),
      { mcpServers: {} },
    );

    writeJsonFile(configPath, {
      mcpServers: {
        'agent-harness': {
          command: 'node',
          args: ['server.js'],
        },
      },
    });

    const backupPath = backupFileIfExists(configPath, 'test-backup');

    assert.equal(backupPath, `${configPath}.test-backup`);
    assert.equal(existsSync(configPath), true);
    assert.equal(existsSync(backupPath!), true);
    assert.deepEqual(readJsonFileOrDefault(configPath, {}), {
      mcpServers: {
        'agent-harness': {
          command: 'node',
          args: ['server.js'],
        },
      },
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('resolveGlobalMem0ModulePath finds a globally installed mem0-mcp dist entry', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'global-mem0-root-'));
  const modulePath = join(tempDir, 'mem0-mcp', 'dist', 'index.js');

  try {
    mkdirSync(join(tempDir, 'mem0-mcp', 'dist'), { recursive: true });
    writeFileSync(modulePath, 'export {};\n', 'utf8');

    assert.equal(resolveGlobalMem0ModulePath(tempDir), modulePath);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
