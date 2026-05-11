import { randomUUID } from 'node:crypto';

import {
  openHarnessDatabase,
  runInTransaction,
  runStatement,
  selectOne,
  type IssuePriority,
  type TShirtSize,
} from 'harness-os/dashboard-server';

import {
  normalizeDashboardString,
  readDashboardEnvironment,
  type DashboardEnvironment,
} from './dashboard-data';

export interface CreateDashboardIssueInput {
  dbPath: string;
  projectId: string;
  campaignId?: string;
  task: string;
  priority: IssuePriority;
  size: TShirtSize;
  nextBestAction?: string;
}

export interface CreateDashboardIssueOptions {
  idFactory?: () => string;
  now?: () => string;
}

export interface CreateDashboardIssueResult {
  issueId: string;
  projectId: string;
  campaignId: string | null;
  status: 'ready';
}

const ISSUE_PRIORITIES = new Set<IssuePriority>([
  'critical',
  'high',
  'medium',
  'low',
]);
const ISSUE_SIZES = new Set<TShirtSize>(['S', 'M', 'L', 'XL']);
const MIN_TASK_LENGTH = 4;
const MAX_TASK_LENGTH = 280;
const MAX_NEXT_ACTION_LENGTH = 360;

export function createDashboardIssueFromFormData(
  formData: FormData,
  env: DashboardEnvironment = readDashboardEnvironment(),
  options: CreateDashboardIssueOptions = {},
): CreateDashboardIssueResult {
  return createDashboardIssue(
    {
      dbPath: requireEnv(env.HARNESS_DASHBOARD_DB_PATH, 'HARNESS_DASHBOARD_DB_PATH'),
      projectId: requireEnv(
        env.HARNESS_DASHBOARD_PROJECT_ID,
        'HARNESS_DASHBOARD_PROJECT_ID',
      ),
      campaignId: normalizeDashboardString(env.HARNESS_DASHBOARD_CAMPAIGN_ID),
      task: readFormString(formData, 'task'),
      priority: parsePriority(readFormString(formData, 'priority')),
      size: parseSize(readFormString(formData, 'size')),
      nextBestAction: normalizeDashboardString(readOptionalFormString(formData, 'nextBestAction')),
    },
    options,
  );
}

export function createDashboardIssue(
  input: CreateDashboardIssueInput,
  options: CreateDashboardIssueOptions = {},
): CreateDashboardIssueResult {
  const draft = normalizeCreateIssueInput(input);
  const issueId = options.idFactory?.() ?? `I-${randomUUID()}`;
  const createdAt = options.now?.() ?? new Date().toISOString();
  const database = openHarnessDatabase({ dbPath: draft.dbPath });

  try {
    return runInTransaction(database.connection, () => {
      const project = selectOne<{ id: string }>(
        database.connection,
        'SELECT id FROM projects WHERE id = ? LIMIT 1',
        [draft.projectId],
      );

      if (project === null) {
        throw new Error(`Unknown HarnessOS project "${draft.projectId}".`);
      }

      if (draft.campaignId !== undefined) {
        const campaign = selectOne<{ id: string }>(
          database.connection,
          'SELECT id FROM campaigns WHERE id = ? AND project_id = ? LIMIT 1',
          [draft.campaignId, draft.projectId],
        );

        if (campaign === null) {
          throw new Error(
            `Unknown campaign "${draft.campaignId}" for project "${draft.projectId}".`,
          );
        }
      }

      runStatement(
        database.connection,
        `INSERT INTO issues (
           id,
           project_id,
           campaign_id,
           milestone_id,
           task,
           priority,
           status,
           size,
           depends_on,
           deadline_at,
           recipients_json,
           approvals_json,
           external_refs_json,
           policy_json,
           next_best_action,
           blocked_reason,
           created_at
         )
         VALUES (?, ?, ?, NULL, ?, ?, 'ready', ?, '[]', NULL, '[]', '[]', ?, '{}', ?, NULL, ?)`,
        [
          issueId,
          draft.projectId,
          draft.campaignId ?? null,
          draft.task,
          draft.priority,
          draft.size,
          JSON.stringify([
            {
              id: 'dashboard-create-ticket',
              kind: 'dashboard',
              value: 'create-ticket',
              label: 'Created from HarnessOS dashboard',
            },
          ]),
          draft.nextBestAction ?? null,
          createdAt,
        ],
      );

      return {
        issueId,
        projectId: draft.projectId,
        campaignId: draft.campaignId ?? null,
        status: 'ready',
      };
    });
  } finally {
    database.close();
  }
}

function normalizeCreateIssueInput(input: CreateDashboardIssueInput): CreateDashboardIssueInput {
  const dbPath = requireInput(input.dbPath, 'dbPath');
  const projectId = requireInput(input.projectId, 'projectId');
  const campaignId = normalizeDashboardString(input.campaignId);
  const task = requireInput(input.task, 'task');
  const nextBestAction = normalizeDashboardString(input.nextBestAction);

  if (task.length < MIN_TASK_LENGTH || task.length > MAX_TASK_LENGTH) {
    throw new Error(
      `task must be between ${MIN_TASK_LENGTH} and ${MAX_TASK_LENGTH} characters.`,
    );
  }

  if (!ISSUE_PRIORITIES.has(input.priority)) {
    throw new Error(`priority must be one of: ${[...ISSUE_PRIORITIES].join(', ')}.`);
  }

  if (!ISSUE_SIZES.has(input.size)) {
    throw new Error(`size must be one of: ${[...ISSUE_SIZES].join(', ')}.`);
  }

  if (nextBestAction !== undefined && nextBestAction.length > MAX_NEXT_ACTION_LENGTH) {
    throw new Error(`nextBestAction must be at most ${MAX_NEXT_ACTION_LENGTH} characters.`);
  }

  return {
    ...input,
    dbPath,
    projectId,
    campaignId,
    task,
    nextBestAction,
  };
}

function requireEnv(value: string | undefined, name: string): string {
  const normalized = normalizeDashboardString(value);

  if (normalized === undefined) {
    throw new Error(`${name} is required to create dashboard tickets.`);
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

function readOptionalFormString(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);

  if (value === null) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new Error(`${name} must be a string.`);
  }

  return value;
}

function parsePriority(value: string): IssuePriority {
  const normalized = value.trim();

  if (!ISSUE_PRIORITIES.has(normalized as IssuePriority)) {
    throw new Error(`priority must be one of: ${[...ISSUE_PRIORITIES].join(', ')}.`);
  }

  return normalized as IssuePriority;
}

function parseSize(value: string): TShirtSize {
  const normalized = value.trim();

  if (!ISSUE_SIZES.has(normalized as TShirtSize)) {
    throw new Error(`size must be one of: ${[...ISSUE_SIZES].join(', ')}.`);
  }

  return normalized as TShirtSize;
}
