import type { AdapterMetadata, Mem0Adapter } from '../contracts/memory-contracts.js';

const DEFAULT_MEM0_MODULE_NAME = 'mem0-mcp';

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

interface DefaultMem0Module {
  SqliteMem0Adapter?: {
    fromEnv(): Mem0Adapter;
  };
}
