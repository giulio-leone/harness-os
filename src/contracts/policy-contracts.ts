import { z } from 'zod';

import { issuePrioritySchema } from './task-domain.js';

const positiveInteger = z.number().int().positive();
const nonEmptyString = z.string().min(1);
const nonEmptyStringArray = z.array(nonEmptyString).min(1);

export const policyEscalationTriggerSchema = z.enum([
  'deadline_breached',
  'response_sla_breached',
  'resolve_sla_breached',
]);

export const policyEscalationActionSchema = z.enum([
  'raise_priority',
  'annotate',
]);

export const harnessServiceLevelSchema = z
  .object({
    responseWithinMinutes: positiveInteger.optional(),
    resolveWithinMinutes: positiveInteger.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.responseWithinMinutes !== undefined ||
      value.resolveWithinMinutes !== undefined,
    {
      message:
        'serviceLevel must define responseWithinMinutes, resolveWithinMinutes, or both.',
    },
  );

export const harnessPolicyEscalationRuleSchema = z
  .object({
    trigger: policyEscalationTriggerSchema,
    action: policyEscalationActionSchema,
    priority: issuePrioritySchema.optional(),
    note: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.action === 'raise_priority' && value.priority === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'raise_priority escalation rules require a priority target.',
        path: ['priority'],
      });
    }
  });

export const harnessDispatchPolicySchema = z
  .object({
    workloadClass: nonEmptyString,
    requiredHostCapabilities: nonEmptyStringArray.optional(),
  })
  .strict();

export const harnessHostCapabilitiesSchema = z
  .object({
    workloadClasses: nonEmptyStringArray,
    capabilities: z.array(nonEmptyString).optional(),
  })
  .strict();

export const harnessPolicySchema = z
  .object({
    owner: z.string().min(1).optional(),
    serviceLevel: harnessServiceLevelSchema.optional(),
    escalationRules: z.array(harnessPolicyEscalationRuleSchema).min(1).optional(),
    dispatch: harnessDispatchPolicySchema.optional(),
  })
  .strict();

export type HarnessDispatchPolicy = z.infer<typeof harnessDispatchPolicySchema>;
export type HarnessHostCapabilities = z.infer<typeof harnessHostCapabilitiesSchema>;
export type HarnessPolicy = z.infer<typeof harnessPolicySchema>;
export type HarnessPolicyEscalationAction = z.infer<
  typeof policyEscalationActionSchema
>;
export type HarnessPolicyEscalationRule = z.infer<
  typeof harnessPolicyEscalationRuleSchema
>;
export type HarnessPolicyEscalationTrigger = z.infer<
  typeof policyEscalationTriggerSchema
>;
