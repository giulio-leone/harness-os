import { z } from 'zod';

export const issuePriorityValues = ['critical', 'high', 'medium', 'low'] as const;
export const tShirtSizeValues = ['S', 'M', 'L', 'XL'] as const;
export const taskStatusValues = [
  'pending',
  'ready',
  'in_progress',
  'blocked',
  'needs_recovery',
  'done',
  'failed',
] as const;
export const milestoneStatusValues = [
  'pending',
  'ready',
  'in_progress',
  'blocked',
  'done',
  'failed',
] as const;
export const legacyPlanIssueStatusValues = [
  'todo',
  'in_progress',
  'review',
  'done',
  'blocked',
] as const;
export const legacyPlanMilestoneStatusValues = [
  'todo',
  'in_progress',
  'review',
  'done',
] as const;

export const issuePrioritySchema = z.enum(issuePriorityValues);
export const tShirtSizeSchema = z.enum(tShirtSizeValues);
export const taskStatusSchema = z.enum(taskStatusValues);
export const milestoneStatusSchema = z.enum(milestoneStatusValues);
export const legacyPlanIssueStatusSchema = z.enum(legacyPlanIssueStatusValues);
export const legacyPlanMilestoneStatusSchema = z.enum(
  legacyPlanMilestoneStatusValues,
);

export type IssuePriority = z.infer<typeof issuePrioritySchema>;
export type TShirtSize = z.infer<typeof tShirtSizeSchema>;
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type MilestoneStatus = z.infer<typeof milestoneStatusSchema>;
export type LegacyPlanIssueStatus = z.infer<typeof legacyPlanIssueStatusSchema>;
export type LegacyPlanMilestoneStatus = z.infer<
  typeof legacyPlanMilestoneStatusSchema
>;

export function normalizeLegacyTaskStatus(
  status: TaskStatus | LegacyPlanIssueStatus,
): TaskStatus {
  switch (status) {
    case 'todo':
      return 'pending';
    case 'review':
      return 'ready';
    default:
      return status;
  }
}

export function normalizeLegacyMilestoneStatus(
  status: MilestoneStatus | LegacyPlanMilestoneStatus,
): MilestoneStatus {
  switch (status) {
    case 'todo':
      return 'pending';
    case 'review':
      return 'ready';
    default:
      return status;
  }
}
