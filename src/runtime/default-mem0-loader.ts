import type { Mem0Adapter } from '../contracts/memory-contracts.js';

const DEFAULT_MEM0_MODULE_NAME = 'mem0-mcp';

export async function loadDefaultMem0Adapter(): Promise<Mem0Adapter | null> {
  if (process.env['AGENT_HARNESS_DISABLE_DEFAULT_MEM0'] === '1') {
    return null;
  }

  try {
    const moduleExports = (await import(
      DEFAULT_MEM0_MODULE_NAME
    )) as DefaultMem0Module;

    if (
      moduleExports.SqliteMem0Adapter === undefined ||
      typeof moduleExports.SqliteMem0Adapter.fromEnv !== 'function'
    ) {
      throw new Error(
        `${DEFAULT_MEM0_MODULE_NAME} does not expose SqliteMem0Adapter.fromEnv().`,
      );
    }

    return moduleExports.SqliteMem0Adapter.fromEnv() as Mem0Adapter;
  } catch (error) {
    if (process.env['AGENT_HARNESS_STRICT_DEFAULT_MEM0'] !== '1') {
      return null;
    }

    throw error;
  }
}

interface DefaultMem0Module {
  SqliteMem0Adapter?: {
    fromEnv(): Mem0Adapter;
  };
}
