import { createRequire } from 'node:module';
import { delimiter, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { AdapterMetadata, Mem0Adapter } from '../contracts/memory-contracts.js';

const DEFAULT_MEM0_MODULE_NAME = 'mem0-mcp';
const DEFAULT_MEM0_MODULE_PATH_ENV = 'AGENT_HARNESS_MEM0_MODULE_PATH';
const NODE_PATH_ENV = 'NODE_PATH';
const requireFromHere = createRequire(import.meta.url);

const DEFAULT_ADAPTER_METADATA: AdapterMetadata = {
  adapterId: 'mem0-mcp-default',
  contractVersion: '1.0',
  capabilities: {
    supportsRecall: true,
    supportsUpdate: true,
    supportsDelete: true,
    supportsWorkspaceList: false,
    supportsProjectList: false,
  },
};

export async function loadDefaultMem0Adapter(): Promise<Mem0Adapter | null> {
  if (process.env['AGENT_HARNESS_DISABLE_DEFAULT_MEM0'] === '1') {
    return null;
  }

  try {
    const moduleExports = await importDefaultMem0Module();

    if (
      moduleExports.SqliteMem0Adapter === undefined ||
      typeof moduleExports.SqliteMem0Adapter.fromEnv !== 'function'
    ) {
      throw new Error(
        `${DEFAULT_MEM0_MODULE_NAME} does not expose SqliteMem0Adapter.fromEnv().`,
      );
    }

    const rawAdapter = moduleExports.SqliteMem0Adapter.fromEnv() as Mem0Adapter;

    // Ensure adapter has metadata — wrap if the external module hasn't been updated yet
    if (!rawAdapter.metadata) {
      return Object.assign(rawAdapter, { metadata: DEFAULT_ADAPTER_METADATA });
    }

    return rawAdapter;
  } catch (error) {
    if (process.env['AGENT_HARNESS_STRICT_DEFAULT_MEM0'] !== '1') {
      return null;
    }

    throw error;
  }
}

async function importDefaultMem0Module(): Promise<DefaultMem0Module> {
  const explicitModulePath = process.env[DEFAULT_MEM0_MODULE_PATH_ENV];
  if (typeof explicitModulePath === 'string' && explicitModulePath.length > 0) {
    return importModuleFromPath(explicitModulePath);
  }

  try {
    return (await import(DEFAULT_MEM0_MODULE_NAME)) as DefaultMem0Module;
  } catch (defaultError) {
    for (const searchPath of getNodePathSearchRoots()) {
      try {
        const resolved = requireFromHere.resolve(DEFAULT_MEM0_MODULE_NAME, {
          paths: [searchPath],
        });
        return importModuleFromPath(resolved);
      } catch {
        continue;
      }
    }

    throw defaultError;
  }
}

function getNodePathSearchRoots(): string[] {
  const rawNodePath = process.env[NODE_PATH_ENV];
  if (typeof rawNodePath !== 'string' || rawNodePath.length === 0) {
    return [];
  }

  return rawNodePath
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function importModuleFromPath(modulePath: string): Promise<DefaultMem0Module> {
  const resolvedPath = isAbsolute(modulePath) ? modulePath : resolve(modulePath);
  return (await import(pathToFileURL(resolvedPath).href)) as DefaultMem0Module;
}

interface DefaultMem0Module {
  SqliteMem0Adapter?: {
    fromEnv(): Mem0Adapter;
  };
}
