import {
  loadOrchestrationDashboardViewModel,
  orchestrationDashboardViewModelSchema,
  type InspectOrchestrationInput,
  type OrchestrationDashboardViewModel,
} from 'harness-os/orchestration';

import { demoDashboardViewModel } from './demo-view-model';

export interface DashboardEnvironment {
  HARNESS_DASHBOARD_DB_PATH?: string;
  HARNESS_DASHBOARD_PROJECT_ID?: string;
  HARNESS_DASHBOARD_CAMPAIGN_ID?: string;
  HARNESS_DASHBOARD_ISSUE_ID?: string;
  HARNESS_DASHBOARD_EVENT_LIMIT?: string;
}

export type DashboardViewModelLoader = (
  input: InspectOrchestrationInput,
) => OrchestrationDashboardViewModel;

const DEFAULT_EVENT_LIMIT = 40;

export function getDashboardViewModel(
  env: DashboardEnvironment = readDashboardEnvironment(),
  loader: DashboardViewModelLoader = loadOrchestrationDashboardViewModel,
): OrchestrationDashboardViewModel {
  const dbPath = normalizeOptional(env.HARNESS_DASHBOARD_DB_PATH);

  if (dbPath === undefined) {
    return orchestrationDashboardViewModelSchema.parse(demoDashboardViewModel);
  }

  const input: InspectOrchestrationInput = {
    dbPath,
    projectId: requireNonEmpty(
      env.HARNESS_DASHBOARD_PROJECT_ID,
      'HARNESS_DASHBOARD_PROJECT_ID',
    ),
    campaignId: normalizeOptional(env.HARNESS_DASHBOARD_CAMPAIGN_ID),
    issueId: normalizeOptional(env.HARNESS_DASHBOARD_ISSUE_ID),
    eventLimit: parseEventLimit(env.HARNESS_DASHBOARD_EVENT_LIMIT),
  };

  return orchestrationDashboardViewModelSchema.parse(loader(input));
}

function readDashboardEnvironment(): DashboardEnvironment {
  return {
    HARNESS_DASHBOARD_DB_PATH: process.env.HARNESS_DASHBOARD_DB_PATH,
    HARNESS_DASHBOARD_PROJECT_ID: process.env.HARNESS_DASHBOARD_PROJECT_ID,
    HARNESS_DASHBOARD_CAMPAIGN_ID: process.env.HARNESS_DASHBOARD_CAMPAIGN_ID,
    HARNESS_DASHBOARD_ISSUE_ID: process.env.HARNESS_DASHBOARD_ISSUE_ID,
    HARNESS_DASHBOARD_EVENT_LIMIT: process.env.HARNESS_DASHBOARD_EVENT_LIMIT,
  };
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function requireNonEmpty(value: string | undefined, name: string): string {
  const normalized = normalizeOptional(value);

  if (normalized === undefined) {
    throw new Error(`${name} is required when HARNESS_DASHBOARD_DB_PATH is set.`);
  }

  return normalized;
}

function parseEventLimit(value: string | undefined): number {
  const normalized = normalizeOptional(value);

  if (normalized === undefined) {
    return DEFAULT_EVENT_LIMIT;
  }

  if (!/^\d+$/.test(normalized)) {
    throw new Error('HARNESS_DASHBOARD_EVENT_LIMIT must be a positive integer.');
  }

  const parsed = Number.parseInt(normalized, 10);

  if (parsed < 1) {
    throw new Error('HARNESS_DASHBOARD_EVENT_LIMIT must be greater than zero.');
  }

  return parsed;
}
