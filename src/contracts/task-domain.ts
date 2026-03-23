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

export const issuePrioritySchema = z.enum(issuePriorityValues);
export const tShirtSizeSchema = z.enum(tShirtSizeValues);
export const taskStatusSchema = z.enum(taskStatusValues);
export const milestoneStatusSchema = z.enum(milestoneStatusValues);

export type IssuePriority = z.infer<typeof issuePrioritySchema>;
export type TShirtSize = z.infer<typeof tShirtSizeSchema>;
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type MilestoneStatus = z.infer<typeof milestoneStatusSchema>;
