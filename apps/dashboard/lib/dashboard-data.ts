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
  HARNESS_DASHBOARD_DEMO?: string;
}

export type DashboardViewModelLoader = (
  input: InspectOrchestrationInput,
) => OrchestrationDashboardViewModel;

export type DashboardPageState =
  | {
      kind: 'ready';
      mode: 'live' | 'demo';
      viewModel: OrchestrationDashboardViewModel;
    }
  | {
      kind: 'not_configured';
      message: string;
      requiredEnvironment: string[];
    };

const DEFAULT_EVENT_LIMIT = 40;
const REQUIRED_LIVE_ENVIRONMENT = [
  'HARNESS_DASHBOARD_DB_PATH',
  'HARNESS_DASHBOARD_PROJECT_ID',
] as const;

export function getDashboardViewModel(
  env: DashboardEnvironment = readDashboardEnvironment(),
  loader: DashboardViewModelLoader = loadOrchestrationDashboardViewModel,
): OrchestrationDashboardViewModel {
  const state = getDashboardPageState(env, loader);

  if (state.kind !== 'ready') {
    throw new Error(state.message);
  }

  return state.viewModel;
}

export function getDashboardPageState(
  env: DashboardEnvironment = readDashboardEnvironment(),
  loader: DashboardViewModelLoader = loadOrchestrationDashboardViewModel,
): DashboardPageState {
  const dbPath = normalizeDashboardString(env.HARNESS_DASHBOARD_DB_PATH);
  const demoEnabled = parseDemoFlag(env.HARNESS_DASHBOARD_DEMO);

  if (dbPath === undefined) {
    if (demoEnabled) {
      return {
        kind: 'ready',
        mode: 'demo',
        viewModel: orchestrationDashboardViewModelSchema.parse(demoDashboardViewModel),
      };
    }

    return {
      kind: 'not_configured',
      message:
        'Set HARNESS_DASHBOARD_DB_PATH and HARNESS_DASHBOARD_PROJECT_ID to render live HarnessOS orchestration data, or set HARNESS_DASHBOARD_DEMO=1 for sample data.',
      requiredEnvironment: [...REQUIRED_LIVE_ENVIRONMENT],
    };
  }

  const input: InspectOrchestrationInput = {
    dbPath,
    projectId: requireNonEmpty(
      env.HARNESS_DASHBOARD_PROJECT_ID,
      'HARNESS_DASHBOARD_PROJECT_ID',
    ),
    campaignId: normalizeDashboardString(env.HARNESS_DASHBOARD_CAMPAIGN_ID),
    issueId: normalizeDashboardString(env.HARNESS_DASHBOARD_ISSUE_ID),
    eventLimit: parseEventLimit(env.HARNESS_DASHBOARD_EVENT_LIMIT),
  };

  return {
    kind: 'ready',
    mode: 'live',
    viewModel: orchestrationDashboardViewModelSchema.parse(loader(input)),
  };
}

export function readDashboardEnvironment(): DashboardEnvironment {
  return {
    HARNESS_DASHBOARD_DB_PATH: process.env.HARNESS_DASHBOARD_DB_PATH,
    HARNESS_DASHBOARD_PROJECT_ID: process.env.HARNESS_DASHBOARD_PROJECT_ID,
    HARNESS_DASHBOARD_CAMPAIGN_ID: process.env.HARNESS_DASHBOARD_CAMPAIGN_ID,
    HARNESS_DASHBOARD_ISSUE_ID: process.env.HARNESS_DASHBOARD_ISSUE_ID,
    HARNESS_DASHBOARD_EVENT_LIMIT: process.env.HARNESS_DASHBOARD_EVENT_LIMIT,
    HARNESS_DASHBOARD_DEMO: process.env.HARNESS_DASHBOARD_DEMO,
  };
}

export function normalizeDashboardString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function requireNonEmpty(value: string | undefined, name: string): string {
  const normalized = normalizeDashboardString(value);

  if (normalized === undefined) {
    throw new Error(`${name} is required when HARNESS_DASHBOARD_DB_PATH is set.`);
  }

  return normalized;
}

function parseEventLimit(value: string | undefined): number {
  const normalized = normalizeDashboardString(value);

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

function parseDemoFlag(value: string | undefined): boolean {
  const normalized = normalizeDashboardString(value)?.toLowerCase();

  if (normalized === undefined) {
    return false;
  }

  if (['1', 'true', 'yes'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no'].includes(normalized)) {
    return false;
  }

  throw new Error('HARNESS_DASHBOARD_DEMO must be one of: 1, true, yes, 0, false, no.');
}
