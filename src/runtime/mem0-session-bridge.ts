import type {
  Mem0Adapter,
  MemoryKind,
  MemoryScope,
  PublicMemoryRecord,
} from '../contracts/memory-contracts.js';
import type { SessionMemoryContext } from '../contracts/session-contracts.js';

export interface LoadMem0ContextInput {
  enabled: boolean;
  scope: MemoryScope;
  query: string;
  limit: number;
}

export interface StoreCheckpointMemoryInput {
  context: SessionMemoryContext;
  scope: MemoryScope;
  checkpointId: string;
  kind: MemoryKind;
  content: string;
  artifactIds: string[];
  metadata: Record<string, string>;
  note?: string;
}

export interface StoreCheckpointMemoryResult {
  memory: PublicMemoryRecord | null;
  skippedReason?: string;
}

export class Mem0SessionBridge {
  constructor(private readonly adapter: Mem0Adapter | null) {}

  async loadContext(
    input: LoadMem0ContextInput,
  ): Promise<SessionMemoryContext> {
    if (!input.enabled) {
      return {
        enabled: false,
        available: false,
        query: input.query,
        details: 'mem0 disabled for this session',
        recalledMemories: [],
      };
    }

    if (this.adapter === null) {
      return {
        enabled: true,
        available: false,
        query: input.query,
        details: 'No mem0 adapter is configured for this session orchestrator',
        recalledMemories: [],
      };
    }

    const health = await this.adapter.healthCheck();

    if (!health.ok) {
      return {
        enabled: true,
        available: false,
        query: input.query,
        details: health.details ?? 'mem0 health check failed',
        recalledMemories: [],
      };
    }

    try {
      const recalledMemories = await this.adapter.searchMemory({
        query: input.query,
        scope: input.scope,
        limit: input.limit,
      });

      return {
        enabled: true,
        available: true,
        query: input.query,
        details: health.details,
        recalledMemories,
      };
    } catch (error) {
      return {
        enabled: true,
        available: false,
        query: input.query,
        details: getErrorMessage(error),
        recalledMemories: [],
      };
    }
  }

  async storeCheckpointMemory(
    input: StoreCheckpointMemoryInput,
  ): Promise<StoreCheckpointMemoryResult> {
    if (!input.context.enabled) {
      return {
        memory: null,
        skippedReason: 'mem0 disabled for this session',
      };
    }

    if (this.adapter === null) {
      return {
        memory: null,
        skippedReason: 'No mem0 adapter is configured for this session orchestrator',
      };
    }

    if (!input.context.available) {
      return {
        memory: null,
        skippedReason: input.context.details ?? 'mem0 is unavailable for this session',
      };
    }

    try {
      const memory = await this.adapter.storeMemory({
        kind: input.kind,
        content: input.content,
        scope: input.scope,
        provenance: {
          checkpointId: input.checkpointId,
          artifactIds: input.artifactIds,
          note: input.note,
        },
        metadata: input.metadata,
      });

      return { memory };
    } catch (error) {
      return {
        memory: null,
        skippedReason: getErrorMessage(error),
      };
    }
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
