import { z } from 'zod';

export const memoryKindValues = [
  'decision',
  'preference',
  'summary',
  'artifact_context',
  'note',
] as const;

export const memoryKindSchema = z.enum(memoryKindValues);
export const memoryScopeSchema = z
  .object({
    workspace: z.string().min(1),
    project: z.string().min(1),
    campaign: z.string().min(1).optional(),
    task: z.string().min(1).optional(),
    run: z.string().min(1).optional(),
  })
  .strict();
export const memoryProvenanceSchema = z
  .object({
    checkpointId: z.string().min(1),
    artifactIds: z.array(z.string().min(1)).default([]),
    note: z.string().min(1).optional(),
  })
  .strict();
export const publicMemoryRecordSchema = z
  .object({
    id: z.string().min(1),
    kind: memoryKindSchema,
    content: z.string().min(1),
    scope: memoryScopeSchema,
    provenance: memoryProvenanceSchema,
    metadata: z.record(z.string(), z.string()).optional(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export const memorySearchResultSchema = z
  .object({
    memory: publicMemoryRecordSchema,
    score: z.number(),
  })
  .strict();

export type MemoryKind = z.infer<typeof memoryKindSchema>;
export type MemoryScope = z.infer<typeof memoryScopeSchema>;
export type MemoryProvenance = z.infer<typeof memoryProvenanceSchema>;
export type PublicMemoryRecord = z.infer<typeof publicMemoryRecordSchema>;
export type MemorySearchResult = z.infer<typeof memorySearchResultSchema>;

export interface HealthCheckResult {
  ok: boolean;
  details?: string;
  storePath?: string;
  ollamaBaseUrl?: string;
  embedModel?: string;
  modelAvailable?: boolean;
  recordCount?: number;
}

export interface MemoryStoreInput {
  kind: MemoryKind;
  content: string;
  scope: MemoryScope;
  provenance: MemoryProvenance;
  metadata?: Record<string, string>;
}

export interface MemoryRecallInput {
  memoryId: string;
  scope: MemoryScope;
}

export interface MemorySearchInput {
  query: string;
  scope: MemoryScope;
  limit: number;
}

export interface Mem0Adapter {
  healthCheck(): Promise<HealthCheckResult>;
  storeMemory(input: MemoryStoreInput): Promise<PublicMemoryRecord>;
  searchMemory(input: MemorySearchInput): Promise<MemorySearchResult[]>;
  recallMemory?(
    input: MemoryRecallInput,
  ): Promise<PublicMemoryRecord | null>;
  updateMemory?(input: unknown): Promise<PublicMemoryRecord>;
  deleteMemory?(input: unknown): Promise<void>;
  listWorkspaces?(): Promise<string[]>;
  listProjects?(): Promise<string[]>;
}
