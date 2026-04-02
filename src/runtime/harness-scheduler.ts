import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { z } from 'zod';

import { harnessPolicySchema } from '../contracts/policy-contracts.js';
import { harnessWorkflowMetadataSchema } from '../contracts/workflow-contracts.js';
import { issuePrioritySchema } from '../contracts/task-domain.js';
import {
  openHarnessDatabase,
  runInTransaction,
  runStatement,
  selectOne,
} from '../db/store.js';
import { serializeHarnessPolicy } from './policy-engine.js';
import {
  serializeWorkItemApprovals,
  serializeWorkItemExternalRefs,
  serializeWorkItemRecipients,
} from './work-item-metadata.js';

export const harnessSchedulerJobSchema = z
  .object({
    task: z.string().min(1),
    cron: z.string().min(1),
    projectKey: z.string().min(1),
    campaignName: z.string().min(1),
    priority: issuePrioritySchema,
    size: z.string().min(1),
    deadlineAt: harnessWorkflowMetadataSchema.shape.deadlineAt,
    recipients: harnessWorkflowMetadataSchema.shape.recipients,
    approvals: harnessWorkflowMetadataSchema.shape.approvals,
    externalRefs: harnessWorkflowMetadataSchema.shape.externalRefs,
    policy: harnessPolicySchema.optional(),
  })
  .strict();

export const harnessSchedulerConfigSchema = z
  .array(harnessSchedulerJobSchema)
  .min(1);

export interface HarnessSchedulerInput {
  dbPath: string;
  configPath: string;
  now?: Date;
}

export interface HarnessSchedulerResult {
  loadedJobs: number;
  dueJobs: number;
  insertedIssues: Array<{
    task: string;
    issueId: string;
    milestoneId: string;
    jobKey: string;
    scheduledFor: string;
  }>;
  skippedJobs: Array<{
    task: string;
    reason: string;
  }>;
}

interface ProjectLookupRow {
  id: string;
}

interface CampaignLookupRow {
  id: string;
}

export function runHarnessScheduler(
  input: HarnessSchedulerInput,
): HarnessSchedulerResult {
  const jobs = harnessSchedulerConfigSchema.parse(
    JSON.parse(readFileSync(input.configPath, 'utf8')),
  );
  const now = input.now ?? new Date();
  const scheduledFor = formatScheduleWindow(now);
  const database = openHarnessDatabase({ dbPath: input.dbPath });
  const result: HarnessSchedulerResult = {
    loadedJobs: jobs.length,
    dueJobs: 0,
    insertedIssues: [],
    skippedJobs: [],
  };

  try {
    ensureSchedulerSchema(database.connection);

    for (const job of jobs) {
      if (!matchesCronExpression(job.cron, now)) {
        result.skippedJobs.push({
          task: job.task,
          reason: `Not due for ${scheduledFor}.`,
        });
        continue;
      }

      result.dueJobs += 1;

      const project = selectOne<ProjectLookupRow>(
        database.connection,
        `SELECT id
           FROM projects
          WHERE key = ?
          LIMIT 1`,
        [job.projectKey],
      );

      if (project === null) {
        result.skippedJobs.push({
          task: job.task,
          reason: `Project with key ${job.projectKey} not found.`,
        });
        continue;
      }

      const campaign = selectOne<CampaignLookupRow>(
        database.connection,
        `SELECT id
           FROM campaigns
          WHERE project_id = ? AND name = ?
          LIMIT 1`,
        [project.id, job.campaignName],
      );

      if (campaign === null) {
        result.skippedJobs.push({
          task: job.task,
          reason: `Campaign ${job.campaignName} not found for project ${job.projectKey}.`,
        });
        continue;
      }

      const jobKey = buildSchedulerJobKey(job);

      const inserted = runInTransaction(database.connection, () => {
        const reservation = database.connection
          .prepare(
            `INSERT OR IGNORE INTO scheduler_injections (job_key, scheduled_for, issue_id, created_at)
             VALUES (?, ?, '', ?)`,
          )
          .run(jobKey, scheduledFor, now.toISOString()) as { changes: number };

        if (reservation.changes === 0) {
          return null;
        }

        const milestoneId = `M-${randomUUID()}`;
        const issueId = `I-${randomUUID()}`;

        runStatement(
          database.connection,
          `INSERT INTO milestones (
             id,
             project_id,
             description,
             priority,
             status,
             deadline_at,
             recipients_json,
             approvals_json,
             external_refs_json
           )
           VALUES (?, ?, ?, ?, 'in_progress', ?, ?, ?, ?)`,
          [
            milestoneId,
            project.id,
            `Scheduled task: ${job.task}`,
            job.priority,
            job.deadlineAt ?? null,
            serializeWorkItemRecipients(job.recipients),
            serializeWorkItemApprovals(job.approvals),
            serializeWorkItemExternalRefs(job.externalRefs),
          ],
        );
        runStatement(
          database.connection,
          `INSERT INTO issues (
             id,
             project_id,
             campaign_id,
             milestone_id,
             task,
             priority,
             status,
             size,
             depends_on,
             deadline_at,
             recipients_json,
             approvals_json,
             external_refs_json,
             policy_json,
             created_at
           )
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, '[]', ?, ?, ?, ?, ?, ?)`,
          [
            issueId,
            project.id,
            campaign.id,
            milestoneId,
            job.task,
            job.priority,
            job.size,
            job.deadlineAt ?? null,
            serializeWorkItemRecipients(job.recipients),
            serializeWorkItemApprovals(job.approvals),
            serializeWorkItemExternalRefs(job.externalRefs),
            serializeHarnessPolicy(job.policy),
            new Date().toISOString(),
          ],
        );
        runStatement(
          database.connection,
          `UPDATE scheduler_injections
              SET issue_id = ?
            WHERE job_key = ? AND scheduled_for = ?`,
          [issueId, jobKey, scheduledFor],
        );

        return {
          task: job.task,
          issueId,
          milestoneId,
          jobKey,
          scheduledFor,
        };
      });

      if (inserted === null) {
        result.skippedJobs.push({
          task: job.task,
          reason: `Already injected for ${scheduledFor}.`,
        });
        continue;
      }

      result.insertedIssues.push(inserted);
    }

    return result;
  } finally {
    database.close();
  }
}

export function matchesCronExpression(expression: string, at: Date): boolean {
  const fields = expression.trim().split(/\s+/);

  if (fields.length !== 5) {
    throw new Error(
      `Expected a 5-field cron expression, received ${fields.length} fields: ${expression}`,
    );
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  const minuteMatches = matchesCronField(minute, at.getMinutes(), 0, 59);
  const hourMatches = matchesCronField(hour, at.getHours(), 0, 23);
  const monthMatches = matchesCronField(month, at.getMonth() + 1, 1, 12);
  const dayOfMonthMatches = matchesCronField(dayOfMonth, at.getDate(), 1, 31);
  const normalizedDayOfWeek = at.getDay();
  const dayOfWeekMatches =
    matchesCronField(dayOfWeek, normalizedDayOfWeek, 0, 7) ||
    (normalizedDayOfWeek === 0 &&
      matchesCronField(dayOfWeek, 7, 0, 7));

  const dayMatches =
    dayOfMonth === '*' && dayOfWeek === '*'
      ? true
      : dayOfMonth === '*'
        ? dayOfWeekMatches
        : dayOfWeek === '*'
          ? dayOfMonthMatches
          : dayOfMonthMatches || dayOfWeekMatches;

  return minuteMatches && hourMatches && monthMatches && dayMatches;
}

function ensureSchedulerSchema(connection: ReturnType<typeof openHarnessDatabase>['connection']): void {
  connection.exec(
    `CREATE TABLE IF NOT EXISTS scheduler_injections (
       job_key TEXT NOT NULL,
       scheduled_for TEXT NOT NULL,
       issue_id TEXT NOT NULL,
       created_at TEXT NOT NULL,
       PRIMARY KEY (job_key, scheduled_for)
     )`,
  );
}

function buildSchedulerJobKey(
  job: z.infer<typeof harnessSchedulerJobSchema>,
): string {
  return createHash('sha256')
    .update(JSON.stringify(job))
    .digest('hex');
}

function formatScheduleWindow(at: Date): string {
  return new Date(
    Date.UTC(
      at.getUTCFullYear(),
      at.getUTCMonth(),
      at.getUTCDate(),
      at.getUTCHours(),
      at.getUTCMinutes(),
      0,
      0,
    ),
  ).toISOString();
}

function matchesCronField(
  field: string,
  value: number,
  minimum: number,
  maximum: number,
): boolean {
  return field.split(',').some((segment) =>
    matchesCronSegment(segment.trim(), value, minimum, maximum),
  );
}

function matchesCronSegment(
  segment: string,
  value: number,
  minimum: number,
  maximum: number,
): boolean {
  const [rangeExpression, stepExpression] = segment.split('/');
  const step = stepExpression === undefined
    ? 1
    : parseCronInteger(stepExpression, minimum, maximum, segment);

  if (step <= 0) {
    throw new Error(`Invalid cron step in segment "${segment}".`);
  }

  const [rangeStart, rangeEnd] = parseCronRange(
    rangeExpression,
    minimum,
    maximum,
    segment,
  );

  if (value < rangeStart || value > rangeEnd) {
    return false;
  }

  return (value - rangeStart) % step === 0;
}

function parseCronRange(
  expression: string,
  minimum: number,
  maximum: number,
  originalSegment: string,
): [number, number] {
  if (expression === '*') {
    return [minimum, maximum];
  }

  if (expression.includes('-')) {
    const [rawStart, rawEnd] = expression.split('-', 2);
    const start = parseCronInteger(rawStart, minimum, maximum, originalSegment);
    const end = parseCronInteger(rawEnd, minimum, maximum, originalSegment);

    if (end < start) {
      throw new Error(`Invalid cron range "${originalSegment}".`);
    }

    return [start, end];
  }

  const start = parseCronInteger(expression, minimum, maximum, originalSegment);
  return [start, stepRangeEnd(start, maximum, originalSegment)];
}

function stepRangeEnd(
  start: number,
  maximum: number,
  originalSegment: string,
): number {
  if (!originalSegment.includes('/')) {
    return start;
  }

  return maximum;
}

function parseCronInteger(
  rawValue: string,
  minimum: number,
  maximum: number,
  originalSegment: string,
): number {
  const parsed = Number.parseInt(rawValue, 10);

  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `Invalid cron value "${rawValue}" in segment "${originalSegment}". Expected ${minimum}-${maximum}.`,
    );
  }

  return parsed;
}
