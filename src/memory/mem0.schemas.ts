import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { z } from 'zod';

export const memoryKindSchema = z.enum([
  'decision',
  'preference',
  'summary',
  'artifact_context',
  'note',
]);

export type MemoryKind = z.infer<typeof memoryKindSchema>;

export const memoryScopeSchema = z
  .object({
    workspace: z.string().min(1),
    project: z.string().min(1),
    campaign: z.string().min(1).optional(),
    task: z.string().min(1).optional(),
    run: z.string().min(1).optional(),
  })
  .strict();

export type MemoryScope = z.infer<typeof memoryScopeSchema>;

export const memoryProvenanceSchema = z
  .object({
    checkpointId: z.string().min(1),
    artifactIds: z.array(z.string().min(1)).default([]),
    note: z.string().min(1).optional(),
  })
  .strict();

export type MemoryProvenance = z.infer<typeof memoryProvenanceSchema>;

export const memoryMetadataSchema = z.record(z.string(), z.string()).default({});

export type MemoryMetadata = z.infer<typeof memoryMetadataSchema>;

export const memoryStoreInputSchema = z
  .object({
    kind: memoryKindSchema,
    content: z.string().min(1),
    scope: memoryScopeSchema,
    provenance: memoryProvenanceSchema,
    metadata: memoryMetadataSchema,
  })
  .strict();

export type MemoryStoreInput = z.infer<typeof memoryStoreInputSchema>;

export const memoryRecallInputSchema = z
  .object({
    memoryId: z.string().uuid(),
    scope: memoryScopeSchema,
  })
  .strict();

export type MemoryRecallInput = z.infer<typeof memoryRecallInputSchema>;

export const memorySearchInputSchema = z
  .object({
    query: z.string().min(1),
    scope: memoryScopeSchema,
    kind: memoryKindSchema.optional(),
    limit: z.number().int().min(1).max(25).default(5),
  })
  .strict();

export type MemorySearchInput = z.infer<typeof memorySearchInputSchema>;

export const mem0ConfigSchema = z
  .object({
    storePath: z.string().min(1),
    ollamaBaseUrl: z.string().url(),
    embedModel: z.string().min(1),
  })
  .strict();

export type Mem0Config = z.infer<typeof mem0ConfigSchema>;

export const storedMemoryRecordSchema = memoryStoreInputSchema.extend({
  id: z.string().uuid(),
  embedding: z.array(z.number()),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

export type StoredMemoryRecord = z.infer<typeof storedMemoryRecordSchema>;

export type PublicMemoryRecord = Omit<StoredMemoryRecord, 'embedding'>;

export interface MemorySearchResult {
  memory: PublicMemoryRecord;
  score: number;
}

export interface HealthCheckResult {
  ok: boolean;
  storePath: string;
  ollamaBaseUrl: string;
  embedModel: string;
  modelAvailable: boolean;
  recordCount: number;
  details?: string;
}

export function loadMem0ConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Mem0Config {
  return mem0ConfigSchema.parse({
    storePath: expandHomePath(env.MEM0_STORE_PATH ?? '~/.copilot/mem0'),
    ollamaBaseUrl: env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434',
    embedModel: env.MEM0_EMBED_MODEL ?? 'qwen3-embedding:latest',
  });
}

export function toPublicMemoryRecord(
  record: StoredMemoryRecord,
): PublicMemoryRecord {
  const { embedding: _embedding, ...publicRecord } = record;

  return publicRecord;
}

function expandHomePath(input: string): string {
  if (input === '~') {
    return homedir();
  }

  if (input.startsWith('~/')) {
    return resolve(homedir(), input.slice(2));
  }

  return input;
}
