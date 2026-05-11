import 'server-only';

import { createDashboardIssueAction } from './actions';
import { DashboardSetup, DashboardShell } from '../components/dashboard-shell';
import { getDashboardPageState } from '../lib/dashboard-data.server';
import {
  applyDashboardIssueFilters,
  parseDashboardIssueFilters,
  type DashboardSearchParams,
} from '../lib/dashboard-issue-filters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<DashboardSearchParams>;
}) {
  const filters = parseDashboardIssueFilters(await searchParams);
  const state = getDashboardPageState();

  if (state.kind === 'not_configured') {
    return <DashboardSetup state={state} />;
  }

  return (
    <DashboardShell
      createIssueAction={state.mode === 'live' ? createDashboardIssueAction : undefined}
      dataSource={state.mode}
      filters={filters}
      unfilteredIssueCount={state.viewModel.overview.totalIssues}
      viewModel={applyDashboardIssueFilters(state.viewModel, filters)}
    />
  );
}
