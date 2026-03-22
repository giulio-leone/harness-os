import type { MemoryKind, MemoryScope, MemorySearchResult } from '../memory/mem0.schemas.js';

export interface InitializerSessionInput {
  sessionId: string;
  cwd: string;
  syncManifestPath: string;
  sourceRepositories: string[];
}

export interface InitializerSessionOutput {
  progressPath: string;
  featureListPath: string;
  initScriptPath: string;
  smokeTestPassed: boolean;
  notes: string[];
}

export interface IncrementalSessionInput {
  sessionId: string;
  dbPath: string;
  workspaceId: string;
  projectId: string;
  progressPath: string;
  featureListPath: string;
  planPath: string;
  syncManifestPath: string;
  mem0Enabled: boolean;
  campaignId?: string;
  preferredIssueId?: string;
  agentId?: string;
  host?: string;
  leaseTtlSeconds?: number;
  checkpointFreshnessSeconds?: number;
  memoryQuery?: string;
  memorySearchLimit?: number;
}

export interface RecoverySessionInput extends IncrementalSessionInput {
  recoverySummary: string;
  recoveryNextStep?: string;
}

export interface QueuePromotionInput {
  dbPath: string;
  projectId: string;
  campaignId?: string;
}

export interface QueuePromotionResult {
  promotedIssueIds: string[];
}

export interface IncrementalSessionOutput {
  selectedIssueId: string;
  runId?: string;
  leaseId?: string;
  taskStatus?: TaskStatus;
  recalledMemoryCount?: number;
  smokeTestPassed: boolean;
  cleanHandoff: boolean;
  updatedArtifacts: string[];
}

export type TaskStatus =
  | 'pending'
  | 'ready'
  | 'in_progress'
  | 'blocked'
  | 'needs_recovery'
  | 'done'
  | 'failed';

export interface SessionMemoryContext {
  enabled: boolean;
  available: boolean;
  query: string;
  details?: string;
  recalledMemories: MemorySearchResult[];
}

export interface SessionContext {
  sessionId: string;
  dbPath: string;
  workspaceId: string;
  projectId: string;
  campaignId?: string;
  agentId: string;
  host: string;
  runId: string;
  leaseId: string;
  leaseExpiresAt: string;
  issueId: string;
  issueTask: string;
  claimMode: 'claim' | 'resume' | 'recovery';
  scope: MemoryScope;
  currentTaskStatus: TaskStatus;
  currentCheckpointId: string;
  mem0: SessionMemoryContext;
}

export interface SessionCheckpointInput {
  title: string;
  summary: string;
  taskStatus: TaskStatus;
  nextStep: string;
  artifactIds?: string[];
  persistToMem0?: boolean;
  memoryKind?: MemoryKind;
  memoryContent?: string;
  metadata?: Record<string, string>;
}

export interface SessionCloseInput extends SessionCheckpointInput {
  releaseLease?: boolean;
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return (
    status === 'blocked' ||
    status === 'needs_recovery' ||
    status === 'done' ||
    status === 'failed'
  );
}
