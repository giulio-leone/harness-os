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
import { syncMilestoneStatuses } from '../db/lease-manager.js';
import {
  AgenticToolError,
  buildMeta,
  resolveCampaignId,
  resolveDbPath,
  resolveProjectId,
  resolveWorkspaceId,
} from './harness-agentic-helpers.js';

const issuePriorityOrder = ['critical', 'high', 'medium', 'low'] as const;

// ─── Input Schemas ──────────────────────────────────────────────────

const planningScopeSchema = z
  .object({
    dbPath: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
    projectName: z.string().min(1).optional(),
    campaignId: z.string().min(1).optional(),
    campaignName: z.string().min(1).optional(),
  })
  .strict();

const harnessPlanIssueDefinitionSchema = z
  .object({
    task: z.string().min(1),
    priority: z.enum(issuePriorityOrder),
    size: z.string().min(1),
    depends_on_indices: z.array(z.number().int().nonnegative()).optional(),
  })
  .strict();

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

export const harnessPlanMilestoneBatchItemSchema = z
  .object({
    milestone_key: z.string().min(1),
    description: z.string().min(1),
    depends_on_milestone_ids: z.array(z.string().min(1)).optional(),
    depends_on_milestone_keys: z.array(z.string().min(1)).optional(),
    issues: z.array(harnessPlanIssueDefinitionSchema).min(1),
  })
  .strict();

export const harnessPlanBatchInputSchema = planningScopeSchema
  .extend({
    milestones: z.array(harnessPlanMilestoneBatchItemSchema).min(1),
  })
  .strict();

export const harnessPlanIssuesInputSchema = harnessPlanBatchInputSchema;

export const harnessRollbackIssueInputSchema = z
  .object({
    dbPath: z.string().min(1).optional(),
    issueId: z.string().min(1),
  })
  .strict();

export type HarnessPlanIssueInput = z.infer<
  typeof harnessPlanIssueDefinitionSchema
>;
type HarnessPlanningScopeInput = z.infer<typeof planningScopeSchema>;
type HarnessPlanBatchMilestoneInput = z.infer<
  typeof harnessPlanMilestoneBatchItemSchema
>;
type HarnessPlanBatchInput = z.infer<typeof harnessPlanBatchInputSchema>;

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
        ['harness_orchestrator'],
        `Workspace "${input.workspaceName}" created. Now call harness_orchestrator(action: "create_campaign") with workspaceId "${result.workspaceId}" to register a project and campaign.`,
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
      const workspaceId = resolveWorkspaceId(database.connection, {
        workspaceId: input.workspaceId,
      });

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
        ['harness_orchestrator'],
        `Project "${input.projectName}" and campaign "${input.campaignName}" ready. Now call harness_orchestrator(action: "plan_issues") with projectId "${result.projectId}", campaignId "${result.campaignId}", and a canonical milestones[] batch to populate the task queue.`,
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

  const database = openHarnessDatabase({ dbPath });

  try {
    const { projectId, campaignId } = resolvePlanningScope(
      database.connection,
      input,
    );

    const result = runInTransaction(database.connection, () => {
      const result = planMilestoneBatch(database.connection, {
        projectId,
        campaignId,
        input,
      });

      syncMilestoneStatuses(database.connection, { projectId, campaignId });
      return result;
    });

    return {
      ...result,
      ...buildMeta(
        ['harness_orchestrator', 'harness_session'],
        `${result.issueCount} issues across ${result.milestoneCount} milestones were injected into the queue as "pending". Call harness_orchestrator(action: "promote_queue") to unlock milestone roots whose dependencies are fully done, then harness_session(action: "begin") to start working.`,
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
        ['harness_orchestrator', 'harness_session'],
        `Issue ${input.issueId} rolled back from "${result.previousStatus}" to "pending". Call harness_orchestrator(action: "promote_queue") to re-evaluate the queue, then harness_session(action: "begin") to retry.`,
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

function resolvePlanningScope(
  connection: ReturnType<typeof openHarnessDatabase>['connection'],
  input: HarnessPlanningScopeInput,
): { projectId: string; campaignId: string } {
  const projectId = resolveProjectId(connection, {
    projectId: input.projectId,
    projectName: input.projectName,
    workspaceId: input.workspaceId,
  });
  const campaignId = resolveCampaignId(connection, projectId, {
    campaignId: input.campaignId,
    campaignName: input.campaignName,
  });

  return { projectId, campaignId };
}

function planMilestoneBatch(
  connection: ReturnType<typeof openHarnessDatabase>['connection'],
  input: {
    projectId: string;
    campaignId: string;
    input: HarnessPlanBatchInput;
  },
): {
  milestoneCount: number;
  issueCount: number;
  generatedMilestones: Array<{
    key: string;
    id: string;
    description: string;
    dependsOnMilestoneIds: string[];
    generatedIssues: Array<{ id: string; task: string; dependsOn: string[] }>;
  }>;
} {
  const orderedMilestones = orderMilestonesByDependency(input.input.milestones);
  const milestoneIdByKey = new Map<string, string>();

  for (const milestone of orderedMilestones) {
    milestoneIdByKey.set(milestone.milestone_key, `M-${randomUUID()}`);
  }

  const generatedMilestones = orderedMilestones.map((milestone) => {
    validateIssueDependencies(milestone.issues);
    const externalDependencyIds = normalizeMilestoneIds(
      milestone.depends_on_milestone_ids,
    );

    assertMilestoneDependenciesExist(
      connection,
      input.projectId,
      externalDependencyIds,
    );

    const dependsOnMilestoneIds = normalizeMilestoneIds(
      [
        ...externalDependencyIds,
        ...(milestone.depends_on_milestone_keys ?? []).map((key) => {
          const milestoneId = milestoneIdByKey.get(key);

          if (milestoneId === undefined) {
            throw new AgenticToolError(
              `Milestone ${milestone.milestone_key} references unknown dependency ${key}.`,
              'Make sure depends_on_milestone_keys references a milestone_key present in the same batch.',
            );
          }

          return milestoneId;
        }),
      ],
    );

    const created = insertMilestoneWithIssues(connection, {
      projectId: input.projectId,
      campaignId: input.campaignId,
      milestoneId: milestoneIdByKey.get(milestone.milestone_key),
      description: milestone.description,
      dependsOnMilestoneIds,
      issues: milestone.issues,
    });

    return {
      key: milestone.milestone_key,
      id: created.milestoneId,
      description: milestone.description,
      dependsOnMilestoneIds,
      generatedIssues: created.generatedIssues,
    };
  });

  return {
    milestoneCount: generatedMilestones.length,
    issueCount: generatedMilestones.reduce(
      (sum, milestone) => sum + milestone.generatedIssues.length,
      0,
    ),
    generatedMilestones,
  };
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

function insertMilestoneWithIssues(
  connection: ReturnType<typeof openHarnessDatabase>['connection'],
  input: {
    projectId: string;
    campaignId: string;
    milestoneId?: string;
    description: string;
    dependsOnMilestoneIds?: string[];
    issues: HarnessPlanIssueInput[];
  },
): {
  milestoneId: string;
  generatedIssues: Array<{ id: string; task: string; dependsOn: string[] }>;
} {
  const milestoneId = input.milestoneId ?? `M-${randomUUID()}`;
  const dependsOnMilestoneIds = normalizeMilestoneIds(input.dependsOnMilestoneIds);

  runStatement(
    connection,
    `INSERT INTO milestones (id, project_id, description, priority, status, depends_on)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
    [
      milestoneId,
      input.projectId,
      input.description,
      resolveHighestPriority(input.issues),
      JSON.stringify(dependsOnMilestoneIds),
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
      connection,
      `INSERT INTO issues (id, project_id, campaign_id, milestone_id, task, priority, status, size, depends_on, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [
        issue.id,
        input.projectId,
        input.campaignId,
        milestoneId,
        issue.task,
        issue.priority,
        issue.size,
        JSON.stringify(dependsOnIds),
        new Date().toISOString(),
      ],
    );
  });

  return {
    milestoneId,
    generatedIssues: createdIssues.map((issue) => ({
      id: issue.id,
      task: issue.task,
      dependsOn: (issue.depends_on_indices ?? []).map(
        (dependencyIndex) => createdIssues[dependencyIndex].id,
      ),
    })),
  };
}

function assertMilestoneDependenciesExist(
  connection: ReturnType<typeof openHarnessDatabase>['connection'],
  projectId: string,
  milestoneIds: string[],
): void {
  if (milestoneIds.length === 0) {
    return;
  }

  const placeholders = milestoneIds.map(() => '?').join(', ');
  const rows = selectOne<{ count: number }>(
    connection,
    `SELECT COUNT(*) AS count
     FROM milestones
     WHERE project_id = ?
       AND id IN (${placeholders})`,
    [projectId, ...milestoneIds],
  );

  if ((rows?.count ?? 0) !== milestoneIds.length) {
    throw new AgenticToolError(
      'Some depends_on_milestone_ids do not exist in the target project.',
      'Use valid milestone IDs from the same project, or import the parent milestones in the same batch.',
    );
  }
}

function orderMilestonesByDependency(
  milestones: HarnessPlanBatchMilestoneInput[],
): HarnessPlanBatchMilestoneInput[] {
  const milestonesByKey = new Map<string, HarnessPlanBatchMilestoneInput>();

  for (const milestone of milestones) {
    if (milestonesByKey.has(milestone.milestone_key)) {
      throw new AgenticToolError(
        `Duplicate milestone_key "${milestone.milestone_key}" detected.`,
        'Every milestone in a batch import must have a unique milestone_key.',
      );
    }

    milestonesByKey.set(milestone.milestone_key, milestone);
  }

  const ordered: HarnessPlanBatchMilestoneInput[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (milestoneKey: string): void => {
    if (visited.has(milestoneKey)) {
      return;
    }

    if (visiting.has(milestoneKey)) {
      throw new AgenticToolError(
        `Cycle detected in milestone dependencies at "${milestoneKey}".`,
        'Remove circular depends_on_milestone_keys references before importing the batch.',
      );
    }

    const milestone = milestonesByKey.get(milestoneKey);

    if (milestone === undefined) {
      throw new AgenticToolError(
        `Unknown milestone dependency "${milestoneKey}".`,
        'Make sure every depends_on_milestone_keys entry references a milestone_key present in the same batch.',
      );
    }

    visiting.add(milestoneKey);

    for (const dependencyKey of milestone.depends_on_milestone_keys ?? []) {
      if (dependencyKey === milestoneKey) {
        throw new AgenticToolError(
          `Milestone "${milestoneKey}" cannot depend on itself.`,
          'Remove the self-reference from depends_on_milestone_keys.',
        );
      }

      if (!milestonesByKey.has(dependencyKey)) {
        throw new AgenticToolError(
          `Milestone "${milestoneKey}" references unknown dependency "${dependencyKey}".`,
          'Make sure every depends_on_milestone_keys entry references a milestone_key present in the same batch.',
        );
      }

      visit(dependencyKey);
    }

    visiting.delete(milestoneKey);
    visited.add(milestoneKey);
    ordered.push(milestone);
  };

  for (const milestone of milestones) {
    visit(milestone.milestone_key);
  }

  return ordered;
}

function normalizeMilestoneIds(
  milestoneIds: string[] | undefined,
): string[] {
  return [...new Set(milestoneIds ?? [])];
}

function resolveHighestPriority(issues: HarnessPlanIssueInput[]): string {
  const priority = issuePriorityOrder.find((candidate) =>
    issues.some((issue) => issue.priority === candidate),
  );

  return priority ?? 'medium';
}
