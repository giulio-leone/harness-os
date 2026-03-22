import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Mem0Adapter } from './mem0-adapter.interface.js';
import {
  loadMem0ConfigFromEnv,
  storedMemoryRecordSchema,
  toPublicMemoryRecord,
  type HealthCheckResult,
  type Mem0Config,
  type MemoryRecallInput,
  type MemoryScope,
  type MemorySearchInput,
  type MemorySearchResult,
  type MemoryStoreInput,
  type PublicMemoryRecord,
  type StoredMemoryRecord,
} from './mem0.schemas.js';
import { OllamaEmbedder } from './ollama-embedder.js';

const STORE_FILE_NAME = 'memories.jsonl';

export class FileBackedMem0Adapter implements Mem0Adapter {
  private readonly storeFilePath: string;
  private readonly embedder: OllamaEmbedder;

  constructor(
    private readonly config: Mem0Config,
    embedder = new OllamaEmbedder(config),
  ) {
    this.storeFilePath = join(config.storePath, STORE_FILE_NAME);
    this.embedder = embedder;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): FileBackedMem0Adapter {
    return new FileBackedMem0Adapter(loadMem0ConfigFromEnv(env));
  }

  async healthCheck(): Promise<HealthCheckResult> {
    try {
      await this.ensureStoreDir();
      const records = await this.readStoredRecords();
      const ollamaHealth = await this.embedder.healthCheck();

      return {
        ok: ollamaHealth.ok,
        storePath: this.config.storePath,
        ollamaBaseUrl: this.config.ollamaBaseUrl,
        embedModel: this.config.embedModel,
        modelAvailable: ollamaHealth.modelAvailable,
        recordCount: records.length,
        details: ollamaHealth.details,
      };
    } catch (error) {
      return {
        ok: false,
        storePath: this.config.storePath,
        ollamaBaseUrl: this.config.ollamaBaseUrl,
        embedModel: this.config.embedModel,
        modelAvailable: false,
        recordCount: 0,
        details: getErrorMessage(error),
      };
    }
  }

  async storeMemory(input: MemoryStoreInput): Promise<PublicMemoryRecord> {
    await this.ensureStoreDir();

    const now = new Date().toISOString();
    const embedding = await this.embedder.embedText(buildEmbeddingSource(input));
    const record = storedMemoryRecordSchema.parse({
      id: randomUUID(),
      ...input,
      embedding,
      createdAt: now,
      updatedAt: now,
    });

    await appendFile(this.storeFilePath, `${JSON.stringify(record)}\n`, 'utf8');

    return toPublicMemoryRecord(record);
  }

  async recallMemory(
    input: MemoryRecallInput,
  ): Promise<PublicMemoryRecord | null> {
    const records = await this.readStoredRecords();
    const record = records.find(
      (candidate) =>
        candidate.id === input.memoryId && matchesScope(candidate.scope, input.scope),
    );

    return record === undefined ? null : toPublicMemoryRecord(record);
  }

  async searchMemory(input: MemorySearchInput): Promise<MemorySearchResult[]> {
    const records = await this.readStoredRecords();
    const scopedRecords = records.filter(
      (record) =>
        matchesScope(record.scope, input.scope) &&
        (input.kind === undefined || record.kind === input.kind),
    );

    if (scopedRecords.length === 0) {
      return [];
    }

    const queryEmbedding = await this.embedder.embedText(input.query);

    return scopedRecords
      .map((record) => ({
        memory: toPublicMemoryRecord(record),
        score: cosineSimilarity(queryEmbedding, record.embedding),
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, input.limit);
  }

  private async ensureStoreDir(): Promise<void> {
    await mkdir(this.config.storePath, { recursive: true });
  }

  private async readStoredRecords(): Promise<StoredMemoryRecord[]> {
    await this.ensureStoreDir();

    let content: string;

    try {
      content = await readFile(this.storeFilePath, 'utf8');
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') {
        return [];
      }

      throw error;
    }

    const lines = content
      .split('\n')
      .map((line) => line.trim())
      .filter((line): line is string => line.length > 0);

    return lines.map((line, index) => {
      try {
        return storedMemoryRecordSchema.parse(JSON.parse(line));
      } catch (error) {
        throw new Error(
          `Invalid stored memory record on line ${index + 1}: ${getErrorMessage(
            error,
          )}`,
        );
      }
    });
  }
}

function buildEmbeddingSource(input: MemoryStoreInput): string {
  const scopeBlock = Object.entries(input.scope)
    .filter(([, value]) => typeof value === 'string' && value.length > 0)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');

  const metadataBlock = Object.entries(input.metadata)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');

  const artifactBlock =
    input.provenance.artifactIds.length > 0
      ? input.provenance.artifactIds.join(', ')
      : 'none';

  return [
    `kind: ${input.kind}`,
    input.content,
    scopeBlock.length > 0 ? `scope:\n${scopeBlock}` : '',
    `checkpointId: ${input.provenance.checkpointId}`,
    `artifactIds: ${artifactBlock}`,
    input.provenance.note ? `note: ${input.provenance.note}` : '',
    metadataBlock.length > 0 ? `metadata:\n${metadataBlock}` : '',
  ]
    .filter((block) => block.length > 0)
    .join('\n\n');
}

function matchesScope(
  recordScope: MemoryScope,
  requestedScope: MemoryScope,
): boolean {
  return (
    recordScope.workspace === requestedScope.workspace &&
    recordScope.project === requestedScope.project &&
    matchesOptionalScopeField(recordScope.campaign, requestedScope.campaign) &&
    matchesOptionalScopeField(recordScope.task, requestedScope.task) &&
    matchesOptionalScopeField(recordScope.run, requestedScope.run)
  );
}

function matchesOptionalScopeField(
  recordValue: string | undefined,
  requestedValue: string | undefined,
): boolean {
  if (requestedValue === undefined) {
    return true;
  }

  return recordValue === requestedValue;
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length) {
    throw new Error(
      `Embedding dimension mismatch: query=${left.length}, record=${right.length}`,
    );
  }

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] * left[index];
    rightMagnitude += right[index] * right[index];
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
