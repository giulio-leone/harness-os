import { z } from 'zod';
import {
  issuePrioritySchema,
  milestoneStatusSchema,
  taskStatusSchema,
  tShirtSizeSchema,
} from './task-domain.js';
import { harnessWorkflowMetadataSchema } from './workflow-contracts.js';

export const IssuePrioritySchema = issuePrioritySchema;
export const IssueStatusSchema = taskStatusSchema;
export const MilestoneStatusSchema = milestoneStatusSchema;
export const TShirtSizeSchema = tShirtSizeSchema;

export const IssueSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    id: z.string(),
    task: z.string(),
    priority: IssuePrioritySchema,
    status: IssueStatusSchema,
    size: TShirtSizeSchema,
    depends_on: z.array(z.string()),
    deadlineAt: harnessWorkflowMetadataSchema.shape.deadlineAt,
    recipients: harnessWorkflowMetadataSchema.shape.recipients,
    approvals: harnessWorkflowMetadataSchema.shape.approvals,
    externalRefs: harnessWorkflowMetadataSchema.shape.externalRefs,
    children: z.record(z.string(), IssueSchema).default({}),
  })
);

export const MilestoneSchema = z.object({
  id: z.string(),
  description: z.string(),
  priority: IssuePrioritySchema,
  status: MilestoneStatusSchema,
  depends_on: z.array(z.string()),
  deadlineAt: harnessWorkflowMetadataSchema.shape.deadlineAt,
  recipients: harnessWorkflowMetadataSchema.shape.recipients,
  approvals: harnessWorkflowMetadataSchema.shape.approvals,
  externalRefs: harnessWorkflowMetadataSchema.shape.externalRefs,
  issues: z.record(z.string(), IssueSchema),
});

export const PlanSchema = z.object({
  prd: z.string(),
  context: z.string(),
  runtime: z.object({
    globalSkillsPath: z.string(),
    syncManifestPath: z.string(),
    mem0Mode: z.enum(['local_self_hosted', 'hosted', 'hybrid']).optional(),
  }),
  milestones: z.record(z.string(), MilestoneSchema),
});

export type Plan = z.infer<typeof PlanSchema>;
export type Milestone = z.infer<typeof MilestoneSchema>;
export type Issue = z.infer<typeof IssueSchema>;
