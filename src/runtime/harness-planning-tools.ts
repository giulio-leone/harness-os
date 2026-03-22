import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { z } from 'zod';

import {
  openHarnessDatabase,
  runInTransaction,
  runStatement,
  selectOne,
} from '../db/store.js';

const issuePriorityOrder = ['critical', 'high', 'medium', 'low'] as const;

export const harnessInitWorkspaceInputSchema = z
  .object({
    dbPath: z.string().min(1),
    workspaceName: z.string().min(1),
  })
  .strict();

export const harnessCreateCampaignInputSchema = z
  .object({
    dbPath: z.string().min(1),
    workspaceId: z.string().min(1),
    projectName: z.string().min(1),
    campaignName: z.string().min(1),
    objective: z.string().min(1),
  })
  .strict();

export const harnessPlanIssuesInputSchema = z
  .object({
    dbPath: z.string().min(1),
    projectId: z.string().min(1),
    campaignId: z.string().min(1),
    milestoneDescription: z.string().min(1),
    issues: z
      .array(
        z
          .object({
            task: z.string().min(1),
            priority: z.enum(issuePriorityOrder),
            size: z.string().min(1),
            depends_on_indices: z.array(z.number().int().nonnegative()).optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const harnessRollbackIssueInputSchema = z
  .object({
    dbPath: z.string().min(1),
    issueId: z.string().min(1),
  })
  .strict();

export type HarnessPlanIssueInput = z.infer<
  typeof harnessPlanIssuesInputSchema
>['issues'][number];

interface ProjectRow {
  id: string;
  key: string;
}

interface CampaignRow {
  id: string;
}

interface RollbackIssueRow {
  id: string;
  status: string;
  project_id: string;
  campaign_id: string | null;
  workspace_id: string;
}

export function initHarnessWorkspace(
  rawInput: unknown,
): { workspaceId: string } {
  const input = harnessInitWorkspaceInputSchema.parse(rawInput);
  mkdirSync(dirname(input.dbPath), { recursive: true });

  const database = openHarnessDatabase({ dbPath: input.dbPath });

  try {
    return runInTransaction(database.connection, () => {
      const workspaceId = `W-${randomUUID()}`;
      const now = new Date().toISOString();

      runStatement(
        database.connection,
        `INSERT INTO workspaces (id, name, kind, created_at, updated_at)
         VALUES (?, ?, 'local', ?, ?)`,
        [workspaceId, input.workspaceName, now, now],
      );

      return { workspaceId };
    });
  } finally {
    database.close();
  }
}

export function createHarnessCampaign(
  rawInput: unknown,
): { projectId: string; projectKey: string; campaignId: string } {
  const input = harnessCreateCampaignInputSchema.parse(rawInput);
  const database = openHarnessDatabase({ dbPath: input.dbPath });

  try {
    return runInTransaction(database.connection, () => {
      const now = new Date().toISOString();
      let project = selectOne<ProjectRow>(
        database.connection,
        `SELECT id, key
           FROM projects
          WHERE workspace_id = ? AND name = ?
          LIMIT 1`,
        [input.workspaceId, input.projectName],
      );

      if (project === null) {
        project = {
          id: `P-${randomUUID()}`,
          key: buildProjectKey(input.workspaceId, input.projectName),
        };

        runStatement(
          database.connection,
          `INSERT INTO projects (id, workspace_id, key, name, domain, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'default', 'active', ?, ?)`,
          [
            project.id,
            input.workspaceId,
            project.key,
            input.projectName,
            now,
            now,
          ],
        );
      }

      let campaign = selectOne<CampaignRow>(
        database.connection,
        `SELECT id
           FROM campaigns
          WHERE project_id = ? AND name = ?
          LIMIT 1`,
        [project.id, input.campaignName],
      );

      if (campaign === null) {
        campaign = { id: `C-${randomUUID()}` };
        runStatement(
          database.connection,
          `INSERT INTO campaigns (id, project_id, name, objective, status, scope_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', '{}', ?, ?)`,
          [
            campaign.id,
            project.id,
            input.campaignName,
            input.objective,
            now,
            now,
          ],
        );
      }

      return {
        projectId: project.id,
        projectKey: project.key,
        campaignId: campaign.id,
      };
    });
  } finally {
    database.close();
  }
}

export function planHarnessIssues(
  rawInput: unknown,
): {
  milestoneId: string;
  generatedIssues: Array<{ id: string; task: string; dependsOn: string[] }>;
} {
  const input = harnessPlanIssuesInputSchema.parse(rawInput);
  validateIssueDependencies(input.issues);

  const database = openHarnessDatabase({ dbPath: input.dbPath });

  try {
    return runInTransaction(database.connection, () => {
      const milestoneId = `M-${randomUUID()}`;
      runStatement(
        database.connection,
        `INSERT INTO milestones (id, project_id, description, priority, status)
         VALUES (?, ?, ?, ?, 'in_progress')`,
        [
          milestoneId,
          input.projectId,
          input.milestoneDescription,
          resolveHighestPriority(input.issues),
        ],
      );

      const createdIssues = input.issues.map((issue) => ({
        ...issue,
        id: `I-${randomUUID()}`,
      }));

      createdIssues.forEach((issue, index) => {
        const dependsOnIds = [...new Set((issue.depends_on_indices ?? []).map((value) => {
          const dependency = createdIssues[value];

          if (dependency === undefined) {
            throw new Error(
              `Issue at index ${index} references dependency index ${value}, which does not exist.`,
            );
          }

          return dependency.id;
        }))];

        runStatement(
          database.connection,
          `INSERT INTO issues (id, project_id, campaign_id, milestone_id, task, priority, status, size, depends_on)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
          [
            issue.id,
            input.projectId,
            input.campaignId,
            milestoneId,
            issue.task,
            issue.priority,
            issue.size,
            JSON.stringify(dependsOnIds),
          ],
        );
      });

      return {
        milestoneId,
        generatedIssues: createdIssues.map((issue, index) => ({
          id: issue.id,
          task: issue.task,
          dependsOn: (issue.depends_on_indices ?? []).map(
            (dependencyIndex) => createdIssues[dependencyIndex].id,
          ),
        })),
      };
    });
  } finally {
    database.close();
  }
}

export function rollbackHarnessIssue(
  rawInput: unknown,
): {
  success: true;
  issueId: string;
  rollbackRunId: string;
  message: string;
} {
  const input = harnessRollbackIssueInputSchema.parse(rawInput);
  const database = openHarnessDatabase({ dbPath: input.dbPath });

  try {
    return runInTransaction(database.connection, () => {
      const issue = selectOne<RollbackIssueRow>(
        database.connection,
        `SELECT i.id, i.status, i.project_id, i.campaign_id, p.workspace_id
           FROM issues i
           JOIN projects p ON p.id = i.project_id
          WHERE i.id = ?
          LIMIT 1`,
        [input.issueId],
      );

      if (issue === null) {
        throw new Error(`Issue ${input.issueId} does not exist.`);
      }

      const now = new Date().toISOString();
      const rollbackRunId = `R-${randomUUID()}`;

      runStatement(
        database.connection,
        `UPDATE issues
            SET status = 'pending',
                next_best_action = NULL
          WHERE id = ?`,
        [input.issueId],
      );
      runStatement(
        database.connection,
        `UPDATE leases
            SET status = 'released',
                released_at = ?
          WHERE issue_id = ?
            AND status = 'active'`,
        [now, input.issueId],
      );
      runStatement(
        database.connection,
        `INSERT INTO runs (id, workspace_id, project_id, campaign_id, session_type, host, status, started_at, finished_at, notes)
         VALUES (?, ?, ?, ?, 'system_rollback', 'session-lifecycle-mcp', 'finished', ?, ?, ?)`,
        [
          rollbackRunId,
          issue.workspace_id,
          issue.project_id,
          issue.campaign_id,
          now,
          now,
          `Explicit rollback of issue ${input.issueId} from status ${issue.status}.`,
        ],
      );
      runStatement(
        database.connection,
        `INSERT INTO events (id, run_id, issue_id, kind, payload, created_at)
         VALUES (?, ?, ?, 'issue_rollback', ?, ?)`,
        [
          `E-${randomUUID()}`,
          rollbackRunId,
          input.issueId,
          JSON.stringify({
            previousStatus: issue.status,
            rolledBackTo: 'pending',
          }),
          now,
        ],
      );

      return {
        success: true,
        issueId: input.issueId,
        rollbackRunId,
        message: `Issue ${input.issueId} has been explicitly rolled back to 'pending'.`,
      };
    });
  } finally {
    database.close();
  }
}

function buildProjectKey(workspaceId: string, projectName: string): string {
  return `${slugify(workspaceId)}-${slugify(projectName) || 'project'}`;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function validateIssueDependencies(issues: HarnessPlanIssueInput[]): void {
  issues.forEach((issue, index) => {
    for (const dependencyIndex of issue.depends_on_indices ?? []) {
      if (dependencyIndex >= index) {
        throw new Error(
          `Issue at index ${index} can depend only on earlier issues. Received dependency index ${dependencyIndex}.`,
        );
      }
    }
  });
}

function resolveHighestPriority(issues: HarnessPlanIssueInput[]): string {
  const priority = issuePriorityOrder.find((candidate) =>
    issues.some((issue) => issue.priority === candidate),
  );

  return priority ?? 'medium';
}
