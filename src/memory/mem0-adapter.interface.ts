import type {
  HealthCheckResult,
  MemoryRecallInput,
  MemorySearchInput,
  MemorySearchResult,
  MemoryStoreInput,
  PublicMemoryRecord,
} from './mem0.schemas.js';

export interface Mem0Adapter {
  healthCheck(): Promise<HealthCheckResult>;
  storeMemory(input: MemoryStoreInput): Promise<PublicMemoryRecord>;
  recallMemory(input: MemoryRecallInput): Promise<PublicMemoryRecord | null>;
  searchMemory(input: MemorySearchInput): Promise<MemorySearchResult[]>;
}
