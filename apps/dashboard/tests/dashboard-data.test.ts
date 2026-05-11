import assert from 'node:assert/strict';
import test from 'node:test';

import type { InspectOrchestrationInput } from 'harness-os/orchestration';

import { getDashboardViewModel } from '../lib/dashboard-data';
import { demoDashboardViewModel } from '../lib/demo-view-model';

test('dashboard data loader returns the validated demo model when no database path is configured', () => {
  const viewModel = getDashboardViewModel({});

  assert.equal(viewModel.scope.projectId, 'harness-os');
  assert.equal(viewModel.overview.totalIssues, 7);
  assert.deepEqual(viewModel, demoDashboardViewModel);
});

test('dashboard data loader forwards environment scope to the orchestration view-model loader', () => {
  let receivedInput: InspectOrchestrationInput | null = null;

  const viewModel = getDashboardViewModel(
    {
      HARNESS_DASHBOARD_DB_PATH: '/tmp/harness.sqlite',
      HARNESS_DASHBOARD_PROJECT_ID: 'project-harness',
      HARNESS_DASHBOARD_CAMPAIGN_ID: 'campaign-dashboard',
      HARNESS_DASHBOARD_ISSUE_ID: 'M7-I2',
      HARNESS_DASHBOARD_EVENT_LIMIT: '25',
    },
    (input) => {
      receivedInput = input;
      return demoDashboardViewModel;
    },
  );

  assert.equal(viewModel.contractVersion, '1.0.0');
  assert.deepEqual(receivedInput, {
    dbPath: '/tmp/harness.sqlite',
    projectId: 'project-harness',
    campaignId: 'campaign-dashboard',
    issueId: 'M7-I2',
    eventLimit: 25,
  });
});

test('dashboard data loader rejects incomplete or invalid live database configuration', () => {
  assert.throws(
    () => getDashboardViewModel({ HARNESS_DASHBOARD_DB_PATH: '/tmp/harness.sqlite' }),
    /HARNESS_DASHBOARD_PROJECT_ID is required/,
  );

  assert.throws(
    () =>
      getDashboardViewModel({
        HARNESS_DASHBOARD_DB_PATH: '/tmp/harness.sqlite',
        HARNESS_DASHBOARD_PROJECT_ID: 'project-harness',
        HARNESS_DASHBOARD_EVENT_LIMIT: '0',
      }),
    /HARNESS_DASHBOARD_EVENT_LIMIT must be greater than zero/,
  );

  assert.throws(
    () =>
      getDashboardViewModel({
        HARNESS_DASHBOARD_DB_PATH: '/tmp/harness.sqlite',
        HARNESS_DASHBOARD_PROJECT_ID: 'project-harness',
        HARNESS_DASHBOARD_EVENT_LIMIT: 'twenty',
      }),
    /HARNESS_DASHBOARD_EVENT_LIMIT must be a positive integer/,
  );
});
