export interface CheckpointRecord {
  id: string;
  runId: string;
  title: string;
  summary: string;
  createdAt: string;
}

export function createCheckpointRecord(input: CheckpointRecord): CheckpointRecord {
  return { ...input };
}
