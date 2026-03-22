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
import {
  AgenticToolError,
  buildMeta,
  resolveCampaignId,
  resolveDbPath,
  resolveProjectId,
} from './harness-agentic-helpers.js';

const issuePriorityOrder = ['critical', 'high', 'medium', 'low'] as const;

// ─── Input Schemas ──────────────────────────────────────────────────

export const harnessInitWorkspaceInputSchema = z
  .object({
    dbPath: z.string().min(1).optional(),
    workspaceName: z.string().min(1),
  })
  .strict();

export const harnessCreateCampaignInputSchema = z
  .object({
    dbPath: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
    projectName: z.string().min(1),
    campaignName: z.string().min(1),
    objective: z.string().min(1),
  })
  .strict();

export const harnessPlanIssuesInputSchema = z
  .object({
    dbPath: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
    projectName: z.string().min(1).optional(),
    campaignId: z.string().min(1).optional(),
    campaignName: z.string().min(1).optional(),
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
    dbPath: z.string().min(1).optional(),
    issueId: z.string().min(1),
  })
  .strict();

export type HarnessPlanIssueInput = z.infer<
  typeof harnessPlanIssuesInputSchema
>['issues'][number];

// ─── Row types ──────────────────────────────────────────────────────

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

interface WorkspaceRow {
  id: string;
}

// ─── Tool Implementations ───────────────────────────────────────────

export function initHarnessWorkspace(
  rawInput: unknown,
): Record<string, unknown> {
  const input = harnessInitWorkspaceInputSchema.parse(rawInput);
  const dbPath = resolveDbPath(input.dbPath);
  mkdirSync(dirname(dbPath), { recursive: true });

  const database = openHarnessDatabase({ dbPath });

  try {
    const result = runInTransaction(database.connection, () => {
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

    return {
      ...result,
      ...buildMeta(
        ['harness_create_campaign'],
        `Workspace "${input.workspaceName}" created. Now call harness_create_campaign with workspaceId "${result.workspaceId}" to register a project and campaign.`,
      ),
    };
  } finally {
    database.close();
  }
}

export function createHarnessCampaign(
  rawInput: unknown,
): Record<string, unknown> {
  const input = harnessCreateCampaignInputSchema.parse(rawInput);
  const dbPath = resolveDbPath(input.dbPath);
  const database = openHarnessDatabase({ dbPath });

  try {
    const result = runInTransaction(database.connection, () => {
      const now = new Date().toISOString();

      // Auto-resolve workspaceId if not provided
      let workspaceId = input.workspaceId;
      if (!workspaceId) {
        const ws = selectOne<WorkspaceRow>(
          database.connection,
          `SELECT id FROM workspaces LIMIT 1`,
        );
        if (ws === null) {
          throw new AgenticToolError(
            'No workspace found. Cannot auto-resolve workspaceId.',
            'Call harness_init_workspace first to create a workspace.',
            'harness_init_workspace',
          );
        }
        workspaceId = ws.id;
      }

      let project = selectOne<ProjectRow>(
        database.connection,
        `SELECT id, key
           FROM projects
          WHERE workspace_id = ? AND name = ?
          LIMIT 1`,
        [workspaceId, input.projectName],
      );

      if (project === null) {
        project = {
          id: `P-${randomUUID()}`,
          key: buildProjectKey(workspaceId, input.projectName),
        };

        runStatement(
          database.connection,
          `INSERT INTO projects (id, workspace_id, key, name, domain, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'default', 'active', ?, ?)`,
          [
            project.id,
            workspaceId,
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

    return {
      ...result,
      ...buildMeta(
        ['harness_plan_issues'],
        `Project "${input.projectName}" and campaign "${input.campaignName}" ready. Now call harness_plan_issues with projectId "${result.projectId}" and campaignId "${result.campaignId}" to populate the task queue.`,
        { idempotent: true },
      ),
    };
  } finally {
    database.close();
  }
}

export function planHarnessIssues(
  rawInput: unknown,
): Record<string, unknown> {
  const input = harnessPlanIssuesInputSchema.parse(rawInput);
  const dbPath = resolveDbPath(input.dbPath);
  validateIssueDependencies(input.issues);

  const database = openHarnessDatabase({ dbPath });

  try {
    const projectId = resolveProjectId(database.connection, {
      projectId: input.projectId,
      projectName: input.projectName,
    });
    const campaignId = resolveCampaignId(database.connection, projectId, {
      campaignId: input.campaignId,
      campaignName: input.campaignName,
    });

    const result = runInTransaction(database.connection, () => {
      const milestoneId = `M-${randomUUID()}`;
      runStatement(
        database.connection,
        `INSERT INTO milestones (id, project_id, description, priority, status)
         VALUES (?, ?, ?, ?, 'in_progress')`,
        [
          milestoneId,
          projectId,
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
            projectId,
            campaignId,
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
        issueCount: createdIssues.length,
        generatedIssues: createdIssues.map((issue) => ({
          id: issue.id,
          task: issue.task,
          dependsOn: (issue.depends_on_indices ?? []).map(
            (dependencyIndex) => createdIssues[dependencyIndex].id,
          ),
        })),
      };
    });

    return {
      ...result,
      ...buildMeta(
        ['promote_queue', 'begin_incremental_session'],
        `${result.issueCount} issues injected into the queue as "pending". Call promote_queue to unlock tasks with no dependencies, then begin_incremental_session to start working.`,
      ),
    };
  } finally {
    database.close();
  }
}

export function rollbackHarnessIssue(
  rawInput: unknown,
): Record<string, unknown> {
  const input = harnessRollbackIssueInputSchema.parse(rawInput);
  const dbPath = resolveDbPath(input.dbPath);
  const database = openHarnessDatabase({ dbPath });

  try {
    const result = runInTransaction(database.connection, () => {
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
        throw new AgenticToolError(
          `Issue ${input.issueId} does not exist.`,
          'Call inspect_overview to list all valid issue IDs, then retry with a correct issueId.',
          'inspect_overview',
        );
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
        issueId: input.issueId,
        previousStatus: issue.status,
        newStatus: 'pending',
        rollbackRunId,
      };
    });

    return {
      ...result,
      ...buildMeta(
        ['promote_queue', 'begin_incremental_session'],
        `Issue ${input.issueId} rolled back from "${result.previousStatus}" to "pending". Call promote_queue to re-evaluate the queue, then begin_incremental_session to retry.`,
      ),
    };
  } finally {
    database.close();
  }
}

// ─── Internals ──────────────────────────────────────────────────────

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
        throw new AgenticToolError(
          `Issue at index ${index} can depend only on earlier issues. Received dependency index ${dependencyIndex}.`,
          'Reorder your issues array so that dependencies appear before the tasks that depend on them. depends_on_indices must reference strictly lower indices.',
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
