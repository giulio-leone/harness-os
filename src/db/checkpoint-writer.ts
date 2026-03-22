import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import type { TaskStatus } from '../contracts/session-contracts.js';
import { runStatement } from './store.js';

export interface CheckpointRecord {
  id: string;
  runId: string;
  issueId?: string;
  title: string;
  summary: string;
  taskStatus: TaskStatus;
  nextStep: string;
  artifactIds: string[];
  createdAt: string;
  payloadEventId: string;
}

export interface CheckpointWriteInput {
  runId: string;
  issueId?: string;
  title: string;
  summary: string;
  taskStatus: TaskStatus;
  nextStep: string;
  artifactIds?: string[];
  createdAt?: string;
}

export interface RunEventRecord {
  id: string;
  runId: string;
  issueId?: string;
  kind: string;
  payload: string;
  createdAt: string;
}

export interface AppendRunEventInput {
  runId: string;
  issueId?: string;
  kind: string;
  payload: Record<string, unknown>;
  createdAt?: string;
}

export interface MemoryLinkRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  campaignId?: string;
  issueId?: string;
  memoryKind: string;
  memoryRef: string;
  summary: string;
  createdAt: string;
}

export interface MemoryLinkInput {
  workspaceId: string;
  projectId: string;
  campaignId?: string;
  issueId?: string;
  memoryKind: string;
  memoryRef: string;
  summary: string;
  createdAt?: string;
}

export function createCheckpointRecord(input: CheckpointRecord): CheckpointRecord {
  return { ...input };
}

export function writeCheckpoint(
  connection: DatabaseSync,
  input: CheckpointWriteInput,
): CheckpointRecord {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const artifactIds = input.artifactIds ?? [];
  const id = randomUUID();

  runStatement(
    connection,
    `INSERT INTO checkpoints (id, run_id, issue_id, title, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, input.runId, input.issueId ?? null, input.title, input.summary, createdAt],
  );

  const event = appendRunEvent(connection, {
    runId: input.runId,
    issueId: input.issueId,
    kind: 'checkpoint_payload',
    payload: {
      checkpointId: id,
      taskStatus: input.taskStatus,
      nextStep: input.nextStep,
      artifactIds,
    },
    createdAt,
  });

  return createCheckpointRecord({
    id,
    runId: input.runId,
    issueId: input.issueId,
    title: input.title,
    summary: input.summary,
    taskStatus: input.taskStatus,
    nextStep: input.nextStep,
    artifactIds,
    createdAt,
    payloadEventId: event.id,
  });
}

export function appendRunEvent(
  connection: DatabaseSync,
  input: AppendRunEventInput,
): RunEventRecord {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const id = randomUUID();
  const payload = JSON.stringify(input.payload);

  runStatement(
    connection,
    `INSERT INTO events (id, run_id, issue_id, kind, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, input.runId, input.issueId ?? null, input.kind, payload, createdAt],
  );

  return {
    id,
    runId: input.runId,
    issueId: input.issueId,
    kind: input.kind,
    payload,
    createdAt,
  };
}

export function linkMemoryRecord(
  connection: DatabaseSync,
  input: MemoryLinkInput,
): MemoryLinkRecord {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const id = randomUUID();

  runStatement(
    connection,
    `INSERT INTO memory_links (
       id,
       workspace_id,
       project_id,
       campaign_id,
       issue_id,
       memory_kind,
       memory_ref,
       summary,
       created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.workspaceId,
      input.projectId,
      input.campaignId ?? null,
      input.issueId ?? null,
      input.memoryKind,
      input.memoryRef,
      input.summary,
      createdAt,
    ],
  );

  return {
    id,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    campaignId: input.campaignId,
    issueId: input.issueId,
    memoryKind: input.memoryKind,
    memoryRef: input.memoryRef,
    summary: input.summary,
    createdAt,
  };
}
