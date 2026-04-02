import type {
  HarnessWorkflowApproval,
  HarnessWorkflowExternalRef,
  HarnessWorkflowMetadata,
  HarnessWorkflowRecipient,
} from '../contracts/workflow-contracts.js';
import {
  harnessWorkflowApprovalSchema,
  harnessWorkflowExternalRefSchema,
  harnessWorkflowMetadataSchema,
  harnessWorkflowRecipientSchema,
} from '../contracts/workflow-contracts.js';

export interface WorkItemMetadataCarrierRow {
  deadline_at?: string | null;
  recipients_json?: string | null;
  approvals_json?: string | null;
  external_refs_json?: string | null;
}

const workflowRecipientListSchema = harnessWorkflowRecipientSchema.array();
const workflowApprovalListSchema = harnessWorkflowApprovalSchema.array();
const workflowExternalRefListSchema = harnessWorkflowExternalRefSchema.array();

export function serializeWorkItemRecipients(
  recipients?: readonly HarnessWorkflowRecipient[],
): string {
  return JSON.stringify(workflowRecipientListSchema.parse(recipients ?? []));
}

export function serializeWorkItemApprovals(
  approvals?: readonly HarnessWorkflowApproval[],
): string {
  return JSON.stringify(workflowApprovalListSchema.parse(approvals ?? []));
}

export function serializeWorkItemExternalRefs(
  externalRefs?: readonly HarnessWorkflowExternalRef[],
): string {
  return JSON.stringify(workflowExternalRefListSchema.parse(externalRefs ?? []));
}

export function parseWorkItemRecipients(
  rawRecipients: string | null | undefined,
): HarnessWorkflowRecipient[] | undefined {
  if (
    rawRecipients === undefined ||
    rawRecipients === null ||
    rawRecipients === '' ||
    rawRecipients === '[]'
  ) {
    return undefined;
  }

  const recipients = workflowRecipientListSchema.parse(
    JSON.parse(rawRecipients) as unknown,
  );

  return recipients.length === 0 ? undefined : recipients;
}

export function parseWorkItemApprovals(
  rawApprovals: string | null | undefined,
): HarnessWorkflowApproval[] | undefined {
  if (
    rawApprovals === undefined ||
    rawApprovals === null ||
    rawApprovals === '' ||
    rawApprovals === '[]'
  ) {
    return undefined;
  }

  const approvals = workflowApprovalListSchema.parse(
    JSON.parse(rawApprovals) as unknown,
  );

  return approvals.length === 0 ? undefined : approvals;
}

export function parseWorkItemExternalRefs(
  rawExternalRefs: string | null | undefined,
): HarnessWorkflowExternalRef[] | undefined {
  if (
    rawExternalRefs === undefined ||
    rawExternalRefs === null ||
    rawExternalRefs === '' ||
    rawExternalRefs === '[]'
  ) {
    return undefined;
  }

  const externalRefs = workflowExternalRefListSchema.parse(
    JSON.parse(rawExternalRefs) as unknown,
  );

  return externalRefs.length === 0 ? undefined : externalRefs;
}

export function buildWorkItemMetadataSurface(
  row: WorkItemMetadataCarrierRow,
): HarnessWorkflowMetadata | undefined {
  const metadata = harnessWorkflowMetadataSchema.parse({
    ...(row.deadline_at ? { deadlineAt: row.deadline_at } : {}),
    ...(row.recipients_json ? { recipients: parseWorkItemRecipients(row.recipients_json) } : {}),
    ...(row.approvals_json ? { approvals: parseWorkItemApprovals(row.approvals_json) } : {}),
    ...(row.external_refs_json
      ? { externalRefs: parseWorkItemExternalRefs(row.external_refs_json) }
      : {}),
  });

  return Object.keys(metadata).length === 0 ? undefined : metadata;
}
