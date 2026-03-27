import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadDefaultMem0Adapter } from '../runtime/default-mem0-loader.js';

test('loadDefaultMem0Adapter loads adapter from explicit module path override', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'default-mem0-loader-'));
  const modulePath = join(tempDir, 'mem0-stub.mjs');
  const previousModulePath = process.env['AGENT_HARNESS_MEM0_MODULE_PATH'];
  const previousDisableDefault = process.env['AGENT_HARNESS_DISABLE_DEFAULT_MEM0'];

  try {
    writeFileSync(
      modulePath,
      `export const SqliteMem0Adapter = {
        fromEnv() {
          return {
            metadata: {
              adapterId: 'stub-mem0',
              contractVersion: '1.0',
              capabilities: {
                supportsRecall: true,
                supportsUpdate: true,
                supportsDelete: true,
                supportsWorkspaceList: false,
                supportsProjectList: false
              }
            },
            async healthCheck() {
              return {
                ok: true,
                storePath: ':memory:',
                ollamaBaseUrl: 'memory://local',
                embedModel: 'stub',
                modelAvailable: true,
                recordCount: 0
              };
            },
            async storeMemory(input) {
              return {
                id: 'mem-stub',
                ...input,
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z'
              };
            },
            async searchMemory() {
              return [];
            }
          };
        }
      };`,
      'utf8',
    );

    delete process.env['AGENT_HARNESS_DISABLE_DEFAULT_MEM0'];
    process.env['AGENT_HARNESS_MEM0_MODULE_PATH'] = modulePath;

    const adapter = await loadDefaultMem0Adapter();

    assert.ok(adapter, 'expected a mem0 adapter to be loaded');
    assert.equal(adapter?.metadata.adapterId, 'stub-mem0');
  } finally {
    if (previousModulePath === undefined) {
      delete process.env['AGENT_HARNESS_MEM0_MODULE_PATH'];
    } else {
      process.env['AGENT_HARNESS_MEM0_MODULE_PATH'] = previousModulePath;
    }

    if (previousDisableDefault === undefined) {
      delete process.env['AGENT_HARNESS_DISABLE_DEFAULT_MEM0'];
    } else {
      process.env['AGENT_HARNESS_DISABLE_DEFAULT_MEM0'] = previousDisableDefault;
    }

    rmSync(tempDir, { recursive: true, force: true });
  }
});
