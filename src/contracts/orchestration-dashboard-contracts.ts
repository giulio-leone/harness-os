import { z } from 'zod';

export const orchestrationDashboardContractVersion = '1.0.0';

const nonEmptyString = z.string().min(1);
const nullableString = z.string().nullable();
const nonnegativeInteger = z.number().int().nonnegative();
const statusCountRecord = z.record(z.string(), nonnegativeInteger);

export const orchestrationDashboardLaneIdValues = [
  'ready',
  'in_progress',
  'blocked',
  'needs_recovery',
  'pending',
  'done',
  'failed',
  'other',
] as const;

export const orchestrationDashboardLaneOrder = orchestrationDashboardLaneIdValues;

export const orchestrationDashboardLaneIdSchema = z.enum(
  orchestrationDashboardLaneIdValues,
);

export const orchestrationDashboardHealthFlagSchema = z.discriminatedUnion(
  'kind',
  [
    z
      .object({
        kind: z.literal('duplicate_active_worktree_artifact_path'),
        severity: z.literal('high'),
        path: nonEmptyString,
        artifactIds: z.array(nonEmptyString),
        message: nonEmptyString,
      })
      .strict(),
    z
      .object({
        kind: z.literal('done_issue_missing_evidence'),
        severity: z.literal('medium'),
        issueId: nonEmptyString,
        message: nonEmptyString,
      })
      .strict(),
    z
      .object({
        kind: z.literal('expired_active_lease'),
        severity: z.literal('high'),
        leaseId: nonEmptyString,
        issueId: nullableString,
        expiresAt: nonEmptyString,
        message: nonEmptyString,
      })
      .strict(),
  ],
);

export const orchestrationDashboardActiveAgentSchema = z
  .object({
    leaseId: nonEmptyString,
    issueId: nullableString,
    agentId: nonEmptyString,
    status: nonEmptyString,
    acquiredAt: nonEmptyString,
    expiresAt: nonEmptyString,
    lastHeartbeatAt: nullableString,
    releasedAt: nullableString,
    expired: z.boolean(),
    primaryForIssue: z.boolean(),
  })
  .strict();

export const orchestrationDashboardIssueCardSchema = z
  .object({
    id: nonEmptyString,
    campaignId: nullableString,
    task: nonEmptyString,
    priority: nonEmptyString,
    status: nonEmptyString,
    laneId: orchestrationDashboardLaneIdSchema,
    size: nonEmptyString,
    nextBestAction: nullableString,
    blockedReason: nullableString,
    createdAt: nonEmptyString,
    deadlineAt: nullableString,
    activeLeases: z.array(orchestrationDashboardActiveAgentSchema),
    primaryLeaseId: nullableString,
    artifactIds: z.array(nonEmptyString),
    artifactKinds: statusCountRecord,
    worktreePaths: z.array(nonEmptyString),
    evidencePacketIds: z.array(nonEmptyString),
    csqrLiteScorecardIds: z.array(nonEmptyString),
    healthFlags: z.array(orchestrationDashboardHealthFlagSchema),
  })
  .strict();

export const orchestrationDashboardIssueLaneSchema = z
  .object({
    id: orchestrationDashboardLaneIdSchema,
    label: nonEmptyString,
    description: nonEmptyString,
    count: nonnegativeInteger,
    cards: z.array(orchestrationDashboardIssueCardSchema),
  })
  .strict();

export const orchestrationDashboardEvidenceSummarySchema = z
  .object({
    totalArtifacts: nonnegativeInteger,
    countsByKind: statusCountRecord,
    orphanArtifactCount: nonnegativeInteger,
    worktreePathCount: nonnegativeInteger,
    evidencePacketCount: nonnegativeInteger,
    csqrLiteScorecardCount: nonnegativeInteger,
    references: z
      .object({
        worktreeIds: z.array(nonEmptyString),
        worktreePaths: z.array(nonEmptyString),
        subagentIds: z.array(nonEmptyString),
        evidencePacketIds: z.array(nonEmptyString),
        csqrLiteScorecardIds: z.array(nonEmptyString),
      })
      .strict(),
  })
  .strict();

export const orchestrationDashboardTimelineItemSchema = z
  .object({
    id: nonEmptyString,
    issueId: nullableString,
    runId: nonEmptyString,
    kind: nonEmptyString,
    payload: z.unknown(),
    createdAt: nonEmptyString,
  })
  .strict();

export const orchestrationDashboardHealthSummarySchema = z
  .object({
    status: z.enum(['healthy', 'warning']),
    severityCounts: z
      .object({
        high: nonnegativeInteger,
        medium: nonnegativeInteger,
        low: nonnegativeInteger,
      })
      .strict(),
    flags: z.array(orchestrationDashboardHealthFlagSchema),
    globalFlags: z.array(orchestrationDashboardHealthFlagSchema),
  })
  .strict();

export const orchestrationDashboardOverviewSchema = z
  .object({
    totalIssues: nonnegativeInteger,
    readyCount: nonnegativeInteger,
    activeIssueCount: nonnegativeInteger,
    blockedCount: nonnegativeInteger,
    needsRecoveryCount: nonnegativeInteger,
    doneCount: nonnegativeInteger,
    failedCount: nonnegativeInteger,
    otherCount: nonnegativeInteger,
    activeLeaseCount: nonnegativeInteger,
    expiredLeaseCount: nonnegativeInteger,
    evidenceArtifactCount: nonnegativeInteger,
    healthStatus: z.enum(['healthy', 'warning']),
    statusCounts: statusCountRecord,
    laneCounts: statusCountRecord,
  })
  .strict();

export const orchestrationDashboardViewModelSchema = z
  .object({
    contractVersion: z.literal(orchestrationDashboardContractVersion),
    sourceSummaryVersion: z.literal(1),
    generatedAt: nonEmptyString,
    scope: z
      .object({
        projectId: nonEmptyString,
        campaignId: nullableString,
        issueId: nullableString,
      })
      .strict(),
    overview: orchestrationDashboardOverviewSchema,
    issueLanes: z.array(orchestrationDashboardIssueLaneSchema),
    activeAgents: z.array(orchestrationDashboardActiveAgentSchema),
    evidence: orchestrationDashboardEvidenceSummarySchema,
    recentTimeline: z.array(orchestrationDashboardTimelineItemSchema),
    health: orchestrationDashboardHealthSummarySchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const cardCount = value.issueLanes.reduce(
      (total, lane) => total + lane.cards.length,
      0,
    );
    const expectedLaneIds = orchestrationDashboardLaneOrder;

    if (cardCount !== value.overview.totalIssues) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'dashboard issue lanes must contain every issue exactly once.',
        path: ['issueLanes'],
      });
    }

    if (value.issueLanes.length !== expectedLaneIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'dashboard issue lanes must include the complete v1 lane set.',
        path: ['issueLanes'],
      });
    }

    value.issueLanes.forEach((lane, laneIndex) => {
      const expectedLaneId = expectedLaneIds[laneIndex];

      if (lane.id !== expectedLaneId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `dashboard issue lane ${laneIndex} must be "${expectedLaneId}".`,
          path: ['issueLanes', laneIndex, 'id'],
        });
      }

      if (lane.count !== lane.cards.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `dashboard issue lane "${lane.id}" count must match its cards length.`,
          path: ['issueLanes', laneIndex, 'count'],
        });
      }

      if (value.overview.laneCounts[lane.id] !== lane.count) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `overview laneCounts.${lane.id} must match lane count.`,
          path: ['overview', 'laneCounts', lane.id],
        });
      }

      lane.cards.forEach((card, cardIndex) => {
        if (card.laneId !== lane.id) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `dashboard card "${card.id}" laneId must match containing lane "${lane.id}".`,
            path: ['issueLanes', laneIndex, 'cards', cardIndex, 'laneId'],
          });
        }
      });
    });
  });

export type OrchestrationDashboardLaneId = z.infer<
  typeof orchestrationDashboardLaneIdSchema
>;
export type OrchestrationDashboardHealthFlag = z.infer<
  typeof orchestrationDashboardHealthFlagSchema
>;
export type OrchestrationDashboardActiveAgent = z.infer<
  typeof orchestrationDashboardActiveAgentSchema
>;
export type OrchestrationDashboardIssueCard = z.infer<
  typeof orchestrationDashboardIssueCardSchema
>;
export type OrchestrationDashboardIssueLane = z.infer<
  typeof orchestrationDashboardIssueLaneSchema
>;
export type OrchestrationDashboardEvidenceSummary = z.infer<
  typeof orchestrationDashboardEvidenceSummarySchema
>;
export type OrchestrationDashboardTimelineItem = z.infer<
  typeof orchestrationDashboardTimelineItemSchema
>;
export type OrchestrationDashboardHealthSummary = z.infer<
  typeof orchestrationDashboardHealthSummarySchema
>;
export type OrchestrationDashboardOverview = z.infer<
  typeof orchestrationDashboardOverviewSchema
>;
export type OrchestrationDashboardViewModel = z.infer<
  typeof orchestrationDashboardViewModelSchema
>;
