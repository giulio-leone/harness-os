import 'server-only';

import { claimDashboardIssueAction } from '../../actions';
import {
  DashboardSetup,
} from '../../../components/dashboard-shell';
import {
  DashboardIssueNotFound,
  IssueDetailShell,
} from '../../../components/issue-detail-shell';
import { getDashboardIssueDetailPageState } from '../../../lib/dashboard-issue-detail';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function IssueDetailPage({
  params,
}: {
  params: Promise<{ issueId: string }>;
}) {
  const { issueId } = await params;
  const state = getDashboardIssueDetailPageState(issueId);

  if (state.kind === 'not_configured') {
    return <DashboardSetup state={state} />;
  }

  if (state.kind === 'not_found') {
    return <DashboardIssueNotFound issueId={state.issueId} message={state.message} />;
  }

  return (
    <IssueDetailShell
      claimIssueAction={state.mode === 'live' ? claimDashboardIssueAction : undefined}
      dataSource={state.mode}
      detail={state.detail}
    />
  );
}
