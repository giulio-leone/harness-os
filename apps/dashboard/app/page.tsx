import 'server-only';

import {
  applyOrchestrationDashboardIssueFilters,
  parseOrchestrationDashboardIssueFilters,
  type OrchestrationDashboardSearchParams,
} from 'harness-os/orchestration';
import { createDashboardIssueAction } from './actions';
import { DashboardSetup, DashboardShell } from '../components/dashboard-shell';
import { getDashboardPageState } from '../lib/dashboard-data.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<OrchestrationDashboardSearchParams>;
}) {
  const filters = parseOrchestrationDashboardIssueFilters(await searchParams);
  const state = getDashboardPageState();

  if (state.kind === 'not_configured') {
    return <DashboardSetup state={state} />;
  }

  return (
    <DashboardShell
      createIssueAction={state.mode === 'live' ? createDashboardIssueAction : undefined}
      dataSource={state.mode}
      filters={filters}
      savedViewModel={state.viewModel}
      unfilteredIssueCount={state.viewModel.overview.totalIssues}
      viewModel={applyOrchestrationDashboardIssueFilters(state.viewModel, filters)}
    />
  );
}
