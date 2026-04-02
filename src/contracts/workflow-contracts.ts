import { z } from 'zod';

const nonEmptyString = z.string().min(1);

export const workflowApprovalStateValues = [
  'pending',
  'approved',
  'rejected',
  'waived',
] as const;

export const workflowApprovalStateSchema = z.enum(workflowApprovalStateValues);

export const harnessWorkflowRecipientSchema = z
  .object({
    id: nonEmptyString,
    kind: nonEmptyString,
    label: nonEmptyString.optional(),
    address: nonEmptyString.optional(),
    role: nonEmptyString.optional(),
  })
  .strict();

export const harnessWorkflowApprovalSchema = z
  .object({
    id: nonEmptyString,
    label: nonEmptyString,
    recipientIds: z.array(nonEmptyString).min(1).optional(),
    state: workflowApprovalStateSchema.optional(),
    required: z.boolean().optional(),
    note: nonEmptyString.optional(),
  })
  .strict();

export const harnessWorkflowExternalRefSchema = z
  .object({
    id: nonEmptyString,
    kind: nonEmptyString,
    value: nonEmptyString,
    label: nonEmptyString.optional(),
    url: z.string().url().optional(),
  })
  .strict();

export const harnessWorkflowMetadataSchema = z
  .object({
    deadlineAt: z.string().datetime({ offset: true }).optional(),
    recipients: z.array(harnessWorkflowRecipientSchema).min(1).optional(),
    approvals: z.array(harnessWorkflowApprovalSchema).min(1).optional(),
    externalRefs: z.array(harnessWorkflowExternalRefSchema).min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    validateUniqueIds(value.recipients, 'recipients', ctx);
    validateUniqueIds(value.approvals, 'approvals', ctx);
    validateUniqueIds(value.externalRefs, 'externalRefs', ctx);

    if (value.recipients === undefined || value.approvals === undefined) {
      return;
    }

    const recipientIds = new Set(value.recipients.map((recipient) => recipient.id));

    value.approvals.forEach((approval, approvalIndex) => {
      approval.recipientIds?.forEach((recipientId, recipientIndex) => {
        if (recipientIds.has(recipientId)) {
          return;
        }

        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown recipientId "${recipientId}" referenced by approval "${approval.id}".`,
          path: ['approvals', approvalIndex, 'recipientIds', recipientIndex],
        });
      });
    });
  });

export type WorkflowApprovalState = z.infer<typeof workflowApprovalStateSchema>;
export type HarnessWorkflowRecipient = z.infer<
  typeof harnessWorkflowRecipientSchema
>;
export type HarnessWorkflowApproval = z.infer<
  typeof harnessWorkflowApprovalSchema
>;
export type HarnessWorkflowExternalRef = z.infer<
  typeof harnessWorkflowExternalRefSchema
>;
export type HarnessWorkflowMetadata = z.infer<
  typeof harnessWorkflowMetadataSchema
>;

function validateUniqueIds(
  entries:
    | ReadonlyArray<{ id: string }>
    | undefined,
  path: 'recipients' | 'approvals' | 'externalRefs',
  ctx: z.core.$RefinementCtx,
): void {
  if (entries === undefined) {
    return;
  }

  const seen = new Set<string>();

  entries.forEach((entry, index) => {
    if (!seen.has(entry.id)) {
      seen.add(entry.id);
      return;
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Duplicate ${path} id "${entry.id}".`,
      path: [path, index, 'id'],
    });
  });
}
