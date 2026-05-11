'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { createDashboardIssueFromFormData } from '../lib/dashboard-ticket-writer';

export async function createDashboardIssueAction(formData: FormData): Promise<void> {
  createDashboardIssueFromFormData(formData);
  revalidatePath('/');
  redirect('/');
}
