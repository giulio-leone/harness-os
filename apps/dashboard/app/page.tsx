import 'server-only';

import { DashboardSetup, DashboardShell } from '../components/dashboard-shell';
import { getDashboardPageState } from '../lib/dashboard-data.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default function DashboardPage() {
  const state = getDashboardPageState();

  if (state.kind === 'not_configured') {
    return <DashboardSetup state={state} />;
  }

  return <DashboardShell dataSource={state.mode} viewModel={state.viewModel} />;
}
