'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { claimDashboardIssueFromFormData } from '../lib/dashboard-claim';
import { createDashboardIssueFromFormData } from '../lib/dashboard-ticket-writer';

export async function createDashboardIssueAction(formData: FormData): Promise<void> {
  createDashboardIssueFromFormData(formData);
  revalidatePath('/');
  redirect('/');
}

export async function claimDashboardIssueAction(formData: FormData): Promise<void> {
  const result = await claimDashboardIssueFromFormData(formData);
  const issuePath = `/issues/${encodeURIComponent(result.issueId)}` as `/issues/${string}`;

  revalidatePath('/');
  revalidatePath(issuePath);
  redirect(issuePath);
}
