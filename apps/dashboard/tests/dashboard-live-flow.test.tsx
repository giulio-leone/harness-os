import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  SessionLifecycleAdapter,
  SessionLifecycleMcpServer,
  SessionOrchestrator,
} from 'harness-os';
import {
  buildCsqrLiteScorecard,
  type OrchestrationDashboardIssueCard,
  type OrchestrationDashboardViewModel,
} from 'harness-os/orchestration';
import {
  openHarnessDatabase,
  runStatement,
} from 'harness-os/dashboard-server';

import { IssueDetailShell } from '../components/issue-detail-shell';
import { getDashboardPageState } from '../lib/dashboard-data';
import { getDashboardIssueDetailPageState } from '../lib/dashboard-issue-detail';
import { claimDashboardIssue } from '../lib/dashboard-claim';
import { createDashboardIssue } from '../lib/dashboard-ticket-writer';

const FLOW_ENVIRONMENT = {
  HARNESS_DASHBOARD_PROJECT_ID: 'P-flow',
  HARNESS_DASHBOARD_CAMPAIGN_ID: 'C-flow',
};
const FLOW_HOST_ROUTING = {
  host: 'ci-linux',
  hostCapabilities: {
    workloadClasses: ['default', 'typescript'],
    capabilities: ['node', 'sqlite', 'dashboard'],
  },
};

interface ToolHandler {
  handler(args: unknown): Promise<unknown>;
}

interface StartedSession {
  sessionToken: string;
  context: {
    runId: string;
    artifacts: Array<{ id?: string }>;
  };
}

interface CheckpointResult {
  result: {
    csqrLiteScorecardArtifactIds?: string[];
  };
}

interface DashboardViewResult {
  viewModel: OrchestrationDashboardViewModel;
}

test('live dashboard flow creates text, claims the issue, and updates the detail page', async () => {
  const seeded = seedLiveFlowDatabase();

  try {
    const env = {
      ...FLOW_ENVIRONMENT,
      HARNESS_DASHBOARD_DB_PATH: seeded.dbPath,
    };
    const created = createDashboardIssue(
      {
        dbPath: seeded.dbPath,
        projectId: FLOW_ENVIRONMENT.HARNESS_DASHBOARD_PROJECT_ID,
        campaignId: FLOW_ENVIRONMENT.HARNESS_DASHBOARD_CAMPAIGN_ID,
        task: 'Implement autonomous dashboard proof bridge',
        priority: 'critical',
        size: 'M',
        nextBestAction: 'Claim through dashboard and verify evidence.',
      },
      {
        idFactory: () => 'I-flow-created',
        now: () => '2026-01-02T03:04:05.000Z',
      },
    );

    const initialState = getDashboardPageState(env);
    assert.equal(initialState.kind, 'ready');
    const initialCard = findIssueCard(
      initialState.kind === 'ready' ? initialState.viewModel : null,
      created.issueId,
    );
    assert.equal(initialCard?.status, 'ready');
    assert.equal(initialCard?.task, 'Implement autonomous dashboard proof bridge');
    assert.equal(initialCard?.nextBestAction, 'Claim through dashboard and verify evidence.');

    const symphony = requireTool(createMcpTools(), 'harness_symphony');
    const mcpView = (await symphony.handler({
      action: 'dashboard_view',
      dbPath: seeded.dbPath,
      projectId: FLOW_ENVIRONMENT.HARNESS_DASHBOARD_PROJECT_ID,
      campaignId: FLOW_ENVIRONMENT.HARNESS_DASHBOARD_CAMPAIGN_ID,
      filters: {
        q: 'autonomous dashboard proof bridge',
      },
    })) as DashboardViewResult;

    assert.deepEqual(flattenIssueIds(mcpView.viewModel), ['I-flow-created']);

    const claim = await claimDashboardIssue(
      {
        dbPath: seeded.dbPath,
        projectId: FLOW_ENVIRONMENT.HARNESS_DASHBOARD_PROJECT_ID,
        campaignId: FLOW_ENVIRONMENT.HARNESS_DASHBOARD_CAMPAIGN_ID,
        issueId: created.issueId,
        agentId: 'dashboard-agent-flow',
        host: 'dashboard-host-flow',
        leaseTtlSeconds: 1200,
      },
      {
        sessionIdFactory: () => 'RUN-dashboard-flow',
      },
    );

    assert.equal(claim.issueId, 'I-flow-created');
    assert.equal(claim.claimMode, 'claim');
    assert.equal(claim.agentId, 'dashboard-agent-flow');

    const claimedState = getDashboardPageState(env);
    assert.equal(claimedState.kind, 'ready');
    const claimedCard = findIssueCard(
      claimedState.kind === 'ready' ? claimedState.viewModel : null,
      created.issueId,
    );
    assert.equal(claimedCard?.status, 'in_progress');
    assert.equal(claimedCard?.activeLeases[0]?.agentId, 'dashboard-agent-flow');

    const detailState = getDashboardIssueDetailPageState(created.issueId, env);
    assert.equal(detailState.kind, 'ready');
    const html = renderToStaticMarkup(
      detailState.kind === 'ready' ? (
        <IssueDetailShell
          claimIssueAction="/claim-issue"
          dataSource="live"
          detail={detailState.detail}
        />
      ) : (
        <div />
      ),
    );

    assert.match(html, /class="status-pill in_progress"/);
    assert.match(html, /dashboard-agent-flow/);
    assert.match(html, /dashboard_claim/);
    assert.match(html, /Issue cannot be claimed from status in_progress/);
  } finally {
    rmSync(seeded.tempDir, { recursive: true, force: true });
  }
});

test('MCP session checkpoint attaches CSQR-lite proof that renders on issue detail', async () => {
  const seeded = seedLiveFlowDatabase();

  try {
    const env = {
      ...FLOW_ENVIRONMENT,
      HARNESS_DASHBOARD_DB_PATH: seeded.dbPath,
    };
    const created = createDashboardIssue(
      {
        dbPath: seeded.dbPath,
        projectId: FLOW_ENVIRONMENT.HARNESS_DASHBOARD_PROJECT_ID,
        campaignId: FLOW_ENVIRONMENT.HARNESS_DASHBOARD_CAMPAIGN_ID,
        task: 'Render MCP CSQR-lite proof on detail',
        priority: 'high',
        size: 'S',
        nextBestAction: 'Attach CSQR-lite evidence through MCP.',
      },
      {
        idFactory: () => 'I-flow-mcp-csqr',
        now: () => '2026-01-02T03:04:05.000Z',
      },
    );
    const tools = createMcpTools();
    const session = requireTool(tools, 'harness_session');
    const symphony = requireTool(tools, 'harness_symphony');

    const started = (await session.handler({
      action: 'begin',
      sessionId: 'RUN-mcp-detail-flow',
      dbPath: seeded.dbPath,
      workspaceId: 'W-flow',
      projectId: FLOW_ENVIRONMENT.HARNESS_DASHBOARD_PROJECT_ID,
      campaignId: FLOW_ENVIRONMENT.HARNESS_DASHBOARD_CAMPAIGN_ID,
      preferredIssueId: created.issueId,
      agentId: 'mcp-agent-flow',
      artifacts: [
        {
          kind: 'e2e_report',
          path: '/evidence/detail-flow-e2e.json',
        },
      ],
      mem0Enabled: false,
      ...FLOW_HOST_ROUTING,
    })) as StartedSession;
    const evidenceArtifactId = started.context.artifacts[0]?.id;

    assert.ok(evidenceArtifactId);

    const scorecard = buildCsqrLiteScorecard({
      id: 'scorecard-mcp-detail-flow',
      scope: 'run',
      runId: started.context.runId,
      targetScore: 8,
      createdAt: '2026-01-02T03:04:06.000Z',
      metadata: {
        source: 'dashboard-live-flow-test',
      },
      scores: [
        {
          criterionId: 'correctness',
          score: 9,
          notes: 'MCP checkpoint state is visible in the detail page.',
          evidenceArtifactIds: [evidenceArtifactId],
        },
        {
          criterionId: 'security',
          score: 9,
          notes: 'The detail loader keeps project and campaign scope intact.',
          evidenceArtifactIds: [evidenceArtifactId],
        },
        {
          criterionId: 'quality',
          score: 9,
          notes: 'The scorecard remains typed and deterministic.',
          evidenceArtifactIds: [evidenceArtifactId],
        },
        {
          criterionId: 'runtime-evidence',
          score: 9,
          notes: 'The MCP proof path produces replayable E2E evidence.',
          evidenceArtifactIds: [evidenceArtifactId],
        },
      ],
    });
    const checkpointed = (await session.handler({
      action: 'checkpoint',
      sessionToken: started.sessionToken,
      input: {
        title: 'csqr-proof',
        summary: 'Attached MCP CSQR-lite proof for the detail page.',
        taskStatus: 'in_progress',
        nextStep: 'Review the automated proof drilldown.',
        csqrLiteScorecards: [
          {
            path: '/evidence/csqr/detail-flow.json',
            scorecard,
          },
        ],
      },
    })) as CheckpointResult;
    const scorecardArtifactId =
      checkpointed.result.csqrLiteScorecardArtifactIds?.[0];

    assert.ok(scorecardArtifactId);

    const mcpCsqrView = (await symphony.handler({
      action: 'dashboard_view',
      dbPath: seeded.dbPath,
      projectId: FLOW_ENVIRONMENT.HARNESS_DASHBOARD_PROJECT_ID,
      campaignId: FLOW_ENVIRONMENT.HARNESS_DASHBOARD_CAMPAIGN_ID,
      filters: {
        csqr: 'any',
      },
    })) as DashboardViewResult;

    assert.deepEqual(flattenIssueIds(mcpCsqrView.viewModel), [created.issueId]);

    const detailState = getDashboardIssueDetailPageState(created.issueId, env);
    assert.equal(detailState.kind, 'ready');
    const html = renderToStaticMarkup(
      detailState.kind === 'ready' ? (
        <IssueDetailShell
          claimIssueAction="/claim-issue"
          dataSource="live"
          detail={detailState.detail}
        />
      ) : (
        <div />
      ),
    );

    assert.match(html, /CSQR-lite scorecards/);
    assert.match(html, /scorecard-mcp-detail-flow/);
    assert.match(html, /Passed/);
    assert.match(html, new RegExp(scorecardArtifactId));
    assert.match(html, new RegExp(evidenceArtifactId));
    assert.match(html, /csqr-proof/);
    assert.match(html, /Checkpoint provenance/);
    assert.match(html, /role="meter"/);
  } finally {
    rmSync(seeded.tempDir, { recursive: true, force: true });
  }
});

function createMcpTools(): Map<string, ToolHandler> {
  const server = new SessionLifecycleMcpServer(
    new SessionLifecycleAdapter(
      new SessionOrchestrator({
        defaultCheckpointFreshnessSeconds: 3600,
      }),
    ),
  );

  return (server as unknown as { tools: Map<string, ToolHandler> }).tools;
}

function requireTool(tools: Map<string, ToolHandler>, name: string): ToolHandler {
  const tool = tools.get(name);

  assert.ok(tool, `${name} tool should be registered`);
  return tool;
}

function findIssueCard(
  viewModel: OrchestrationDashboardViewModel | null,
  issueId: string,
): OrchestrationDashboardIssueCard | undefined {
  return viewModel?.issueLanes
    .flatMap((lane) => lane.cards)
    .find((card) => card.id === issueId);
}

function flattenIssueIds(viewModel: OrchestrationDashboardViewModel): string[] {
  return viewModel.issueLanes.flatMap((lane) => lane.cards.map((card) => card.id));
}

function seedLiveFlowDatabase(): { dbPath: string; tempDir: string } {
  const tempDir = mkdtempSync(join(tmpdir(), 'harness-dashboard-live-flow-'));
  const dbPath = join(tempDir, 'harness.sqlite');
  const database = openHarnessDatabase({ dbPath });
  const now = '2026-01-02T03:04:05.000Z';

  try {
    runStatement(
      database.connection,
      `INSERT INTO workspaces (id, name, kind, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      ['W-flow', 'Live Flow Workspace', 'local', now, now],
    );
    runStatement(
      database.connection,
      `INSERT INTO projects (id, workspace_id, key, name, domain, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        FLOW_ENVIRONMENT.HARNESS_DASHBOARD_PROJECT_ID,
        'W-flow',
        'flow',
        'Live Dashboard Flow',
        'orchestration',
        'active',
        now,
        now,
      ],
    );
    runStatement(
      database.connection,
      `INSERT INTO campaigns (
         id,
         project_id,
         name,
         objective,
         status,
         scope_json,
         policy_json,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, '{}', '{}', ?, ?)`,
      [
        FLOW_ENVIRONMENT.HARNESS_DASHBOARD_CAMPAIGN_ID,
        FLOW_ENVIRONMENT.HARNESS_DASHBOARD_PROJECT_ID,
        'Live Dashboard Flow Campaign',
        'Verify dashboard create, claim, MCP, and CSQR-lite evidence flows.',
        'active',
        now,
        now,
      ],
    );
  } finally {
    database.close();
  }

  return { dbPath, tempDir };
}
