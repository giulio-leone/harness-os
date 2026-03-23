import { z } from 'zod';
import {
  issuePrioritySchema,
  legacyPlanIssueStatusSchema,
  legacyPlanMilestoneStatusSchema,
  milestoneStatusSchema,
  normalizeLegacyMilestoneStatus,
  normalizeLegacyTaskStatus,
  taskStatusSchema,
  tShirtSizeSchema,
} from './task-domain.js';

export const IssuePrioritySchema = issuePrioritySchema;
export const IssueStatusSchema = taskStatusSchema;
export const MilestoneStatusSchema = milestoneStatusSchema;
export const TShirtSizeSchema = tShirtSizeSchema;

export const LegacyIssueStatusSchema = legacyPlanIssueStatusSchema;
export const LegacyMilestoneStatusSchema = legacyPlanMilestoneStatusSchema;

export const IssueSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    id: z.string(),
    task: z.string(),
    priority: IssuePrioritySchema,
    status: IssueStatusSchema,
    size: TShirtSizeSchema,
    depends_on: z.array(z.string()),
    children: z.record(z.string(), IssueSchema).default({}),
  })
);

export const MilestoneSchema = z.object({
  id: z.string(),
  description: z.string(),
  priority: IssuePrioritySchema,
  status: MilestoneStatusSchema,
  depends_on: z.array(z.string()),
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

export const LegacyIssueSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    id: z.string(),
    task: z.string(),
    priority: IssuePrioritySchema,
    status: LegacyIssueStatusSchema,
    size: TShirtSizeSchema,
    depends_on: z.array(z.string()),
    children: z.record(z.string(), LegacyIssueSchema).default({}),
  }),
);

export const LegacyMilestoneSchema = z.object({
  id: z.string(),
  description: z.string(),
  priority: IssuePrioritySchema,
  status: LegacyMilestoneStatusSchema,
  depends_on: z.array(z.string()),
  issues: z.record(z.string(), LegacyIssueSchema),
});

export const LegacyPlanSchema = z.object({
  prd: z.string(),
  context: z.string(),
  runtime: z.object({
    globalSkillsPath: z.string(),
    syncManifestPath: z.string(),
    mem0Mode: z.enum(['local_self_hosted', 'hosted', 'hybrid']).optional(),
  }),
  milestones: z.record(z.string(), LegacyMilestoneSchema),
});

export type Plan = z.infer<typeof PlanSchema>;
export type Milestone = z.infer<typeof MilestoneSchema>;
export type Issue = z.infer<typeof IssueSchema>;
export type LegacyPlan = z.infer<typeof LegacyPlanSchema>;

export function normalizeLegacyPlan(plan: LegacyPlan | Plan): Plan {
  const parsed = LegacyPlanSchema.safeParse(plan);

  if (!parsed.success) {
    return PlanSchema.parse(plan);
  }

  return {
    ...parsed.data,
    milestones: Object.fromEntries(
      Object.entries(parsed.data.milestones).map(([milestoneId, milestone]) => [
        milestoneId,
        {
          ...milestone,
          status: normalizeLegacyMilestoneStatus(milestone.status),
          issues: normalizeLegacyIssues(milestone.issues),
        },
      ]),
    ),
  };
}

function normalizeLegacyIssues(issues: Record<string, z.infer<typeof LegacyIssueSchema>>): Record<string, Issue> {
  return Object.fromEntries(
    Object.entries(issues).map(([issueId, issue]) => [
      issueId,
      {
        ...issue,
        status: normalizeLegacyTaskStatus(issue.status),
        children: normalizeLegacyIssues(issue.children),
      },
    ]),
  );
}
