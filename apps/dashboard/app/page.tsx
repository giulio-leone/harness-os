import 'server-only';

import { DashboardShell } from '../components/dashboard-shell';
import { getDashboardViewModel } from '../lib/dashboard-data.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default function DashboardPage() {
  const viewModel = getDashboardViewModel();

  return <DashboardShell viewModel={viewModel} />;
}
