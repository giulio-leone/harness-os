import { randomUUID } from 'node:crypto';

import {
  openHarnessDatabase,
  selectOne,
  SessionOrchestrator,
  type HarnessHostCapabilities,
  type SessionContext,
} from 'harness-os/dashboard-server';

import {
  normalizeDashboardString,
  readDashboardEnvironment,
  type DashboardEnvironment,
} from './dashboard-data';

export interface ClaimDashboardIssueInput {
  dbPath: string;
  projectId: string;
  issueId: string;
  campaignId?: string;
  agentId?: string;
  host?: string;
  hostCapabilities?: HarnessHostCapabilities;
  leaseTtlSeconds?: number;
}

export interface ClaimDashboardIssueOptions {
  sessionIdFactory?: () => string;
  orchestrator?: Pick<SessionOrchestrator, 'beginIncrementalSession'>;
}

export interface ClaimDashboardIssueResult {
  issueId: string;
  runId: string;
  leaseId: string;
  agentId: string;
  claimMode: SessionContext['claimMode'];
}

interface NormalizedClaimDashboardIssueInput {
  dbPath: string;
  projectId: string;
  issueId: string;
  campaignId?: string;
  agentId?: string;
  host?: string;
  hostCapabilities: HarnessHostCapabilities;
  leaseTtlSeconds?: number;
}

interface DashboardClaimScope {
  workspaceId: string;
}

const DEFAULT_DASHBOARD_HOST = 'dashboard';
const DEFAULT_DASHBOARD_AGENT_ID = 'dashboard-agent';
const DEFAULT_WORKLOAD_CLASSES = ['default', 'typescript'] as const;
const DEFAULT_HOST_CAPABILITIES = ['node', 'sqlite', 'dashboard'] as const;

export async function claimDashboardIssueFromFormData(
  formData: FormData,
  env: DashboardEnvironment = readDashboardEnvironment(),
  options: ClaimDashboardIssueOptions = {},
): Promise<ClaimDashboardIssueResult> {
  const issueId = readFormString(formData, 'issueId');

  return claimDashboardIssue(
    {
      dbPath: requireEnv(env.HARNESS_DASHBOARD_DB_PATH, 'HARNESS_DASHBOARD_DB_PATH'),
      projectId: requireEnv(
        env.HARNESS_DASHBOARD_PROJECT_ID,
        'HARNESS_DASHBOARD_PROJECT_ID',
      ),
      campaignId: normalizeDashboardString(env.HARNESS_DASHBOARD_CAMPAIGN_ID),
      issueId,
      agentId: normalizeDashboardString(env.HARNESS_DASHBOARD_CLAIM_AGENT_ID),
      host: normalizeDashboardString(env.HARNESS_DASHBOARD_CLAIM_HOST),
      hostCapabilities: parseHostCapabilities(env),
      leaseTtlSeconds: parseLeaseTtlSeconds(env.HARNESS_DASHBOARD_LEASE_TTL_SECONDS),
    },
    options,
  );
}

export async function claimDashboardIssue(
  input: ClaimDashboardIssueInput,
  options: ClaimDashboardIssueOptions = {},
): Promise<ClaimDashboardIssueResult> {
  const draft = normalizeClaimInput(input);
  const scope = resolveDashboardClaimScope(draft);
  const sessionId = options.sessionIdFactory?.() ?? `RUN-dashboard-${randomUUID()}`;
  const agentId = draft.agentId ?? DEFAULT_DASHBOARD_AGENT_ID;
  const host = draft.host ?? DEFAULT_DASHBOARD_HOST;
  const orchestrator = options.orchestrator ?? new SessionOrchestrator();

  const context = await orchestrator.beginIncrementalSession({
    sessionId,
    dbPath: draft.dbPath,
    workspaceId: scope.workspaceId,
    projectId: draft.projectId,
    campaignId: draft.campaignId,
    preferredIssueId: draft.issueId,
    agentId,
    host,
    hostCapabilities: draft.hostCapabilities,
    leaseTtlSeconds: draft.leaseTtlSeconds,
    artifacts: [
      {
        kind: 'dashboard_claim',
        path: `harness-dashboard://claims/${encodeURIComponent(sessionId)}/${encodeURIComponent(
          draft.issueId,
        )}`,
      },
    ],
    mem0Enabled: false,
  });

  return {
    issueId: context.issueId,
    runId: context.runId,
    leaseId: context.leaseId,
    agentId: context.agentId,
    claimMode: context.claimMode,
  };
}

function normalizeClaimInput(
  input: ClaimDashboardIssueInput,
): NormalizedClaimDashboardIssueInput {
  const dbPath = requireInput(input.dbPath, 'dbPath');
  const projectId = requireInput(input.projectId, 'projectId');
  const issueId = requireInput(input.issueId, 'issueId');
  const campaignId = normalizeDashboardString(input.campaignId);
  const agentId = normalizeDashboardString(input.agentId);
  const host = normalizeDashboardString(input.host);

  return {
    ...input,
    dbPath,
    projectId,
    issueId,
    campaignId,
    agentId,
    host,
    hostCapabilities: input.hostCapabilities ?? {
      workloadClasses: [...DEFAULT_WORKLOAD_CLASSES],
      capabilities: [...DEFAULT_HOST_CAPABILITIES],
    },
    leaseTtlSeconds: input.leaseTtlSeconds,
  };
}

function resolveDashboardClaimScope(
  input: NormalizedClaimDashboardIssueInput,
): DashboardClaimScope {
  const database = openHarnessDatabase({ dbPath: input.dbPath });

  try {
    const project = selectOne<{ workspace_id: string }>(
      database.connection,
      'SELECT workspace_id FROM projects WHERE id = ? LIMIT 1',
      [input.projectId],
    );

    if (project === null) {
      throw new Error(`Unknown HarnessOS project "${input.projectId}".`);
    }

    const issue = selectOne<{
      project_id: string;
      campaign_id: string | null;
      status: string;
    }>(
      database.connection,
      'SELECT project_id, campaign_id, status FROM issues WHERE id = ? LIMIT 1',
      [input.issueId],
    );

    if (issue === null) {
      throw new Error(`Unknown HarnessOS issue "${input.issueId}".`);
    }

    if (issue.project_id !== input.projectId) {
      throw new Error(
        `Issue ${input.issueId} belongs to project ${issue.project_id}, not ${input.projectId}.`,
      );
    }

    if (input.campaignId !== undefined && issue.campaign_id !== input.campaignId) {
      throw new Error(
        `Issue ${input.issueId} belongs to campaign ${issue.campaign_id ?? 'none'}, not ${input.campaignId}.`,
      );
    }

    if (issue.status !== 'ready') {
      throw new Error(
        `Issue ${input.issueId} cannot be claimed from status ${issue.status}; dashboard claims require ready issues.`,
      );
    }

    return {
      workspaceId: project.workspace_id,
    };
  } finally {
    database.close();
  }
}

function parseHostCapabilities(env: DashboardEnvironment): HarnessHostCapabilities {
  return {
    workloadClasses: parseCsv(
      env.HARNESS_DASHBOARD_WORKLOAD_CLASSES,
      [...DEFAULT_WORKLOAD_CLASSES],
      'HARNESS_DASHBOARD_WORKLOAD_CLASSES',
    ),
    capabilities: parseCsv(
      env.HARNESS_DASHBOARD_HOST_CAPABILITIES,
      [...DEFAULT_HOST_CAPABILITIES],
      'HARNESS_DASHBOARD_HOST_CAPABILITIES',
    ),
  };
}

function parseCsv(
  value: string | undefined,
  fallback: string[],
  name: string,
): string[] {
  const normalized = normalizeDashboardString(value);

  if (normalized === undefined) {
    return fallback;
  }

  const entries = normalized
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (entries.length === 0) {
    throw new Error(`${name} must include at least one non-empty value.`);
  }

  return [...new Set(entries)];
}

function parseLeaseTtlSeconds(value: string | undefined): number | undefined {
  const normalized = normalizeDashboardString(value);

  if (normalized === undefined) {
    return undefined;
  }

  if (!/^\d+$/.test(normalized)) {
    throw new Error('HARNESS_DASHBOARD_LEASE_TTL_SECONDS must be a positive integer.');
  }

  const parsed = Number.parseInt(normalized, 10);

  if (parsed < 1) {
    throw new Error('HARNESS_DASHBOARD_LEASE_TTL_SECONDS must be greater than zero.');
  }

  return parsed;
}

function requireEnv(value: string | undefined, name: string): string {
  const normalized = normalizeDashboardString(value);

  if (normalized === undefined) {
    throw new Error(`${name} is required to claim dashboard tickets.`);
  }

  return normalized;
}

function requireInput(value: string, name: string): string {
  const normalized = normalizeDashboardString(value);

  if (normalized === undefined) {
    throw new Error(`${name} is required.`);
  }

  return normalized;
}

function readFormString(formData: FormData, name: string): string {
  const value = formData.get(name);

  if (typeof value !== 'string') {
    throw new Error(`${name} is required.`);
  }

  return value;
}
