import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type {
  HealthCheckResult,
  Mem0Adapter,
  MemoryRecallInput,
  MemorySearchInput,
  MemorySearchResult,
  MemoryStoreInput,
  PublicMemoryRecord,
} from '../contracts/memory-contracts.js';
import {
  SessionLifecycleAdapter,
  SessionLifecycleMcpServer,
  SessionOrchestrator,
  openHarnessDatabase,
  selectAll,
} from '../index.js';
import type {
  OrchestrationEvidenceArtifact,
  OrchestrationEvidencePacket,
  OrchestrationPlan,
} from '../contracts/orchestration-contracts.js';
import { orchestrationEvidencePacketSchema } from '../contracts/orchestration-contracts.js';
import {
  assertReferenceOrchestrationEvidencePacket,
  buildReferenceOrchestrationEvidencePacket,
  buildReferenceOrchestrationRunResult,
  getReferenceAssignmentEvidenceArtifactIds,
  referenceOrchestrationE2eEvidenceMatrix,
} from '../runtime/orchestration-reference-evidence.js';

const timestamp = '2026-05-10T20:00:00.000Z';
const repoRoot = '/tmp/harness-os';
const worktreeRoot = '/tmp/harness-os-worktrees';
const hostRoutingContext = {
  host: 'ci-linux',
  hostCapabilities: {
    workloadClasses: ['default', 'typescript'],
    capabilities: ['node', 'sqlite'],
  },
};

test('reference orchestration E2E evidence matrix builds deterministic run results', () => {
  const plan = createReferencePlan();
  const packetA = buildReferenceOrchestrationEvidencePacket({
    plan,
    createdAt: timestamp,
    commitSha: '50c7cf4',
  });
  const packetB = buildReferenceOrchestrationEvidencePacket({
    plan,
    createdAt: timestamp,
    commitSha: '50c7cf4',
  });
  const runResult = buildReferenceOrchestrationRunResult({
    plan,
    runId: 'run-reference-e2e',
    startedAt: timestamp,
    completedAt: timestamp,
    createdAt: timestamp,
    commitSha: '50c7cf4',
  });

  assert.deepEqual(packetA, packetB);
  assert.deepEqual(referenceOrchestrationE2eEvidenceMatrix.assignmentScope, [
    'test_report',
    'e2e_report',
    'screenshot',
  ]);
  assert.equal(runResult.status, 'succeeded');
  assert.equal(runResult.assignmentResults.length, plan.dispatch.assignments.length);
  assertReferenceOrchestrationEvidencePacket({ plan, packet: runResult.evidencePacket });
});

test('reference evidence assertion rejects packets missing assignment screenshots', () => {
  const plan = createReferencePlan();
  const packet = buildReferenceOrchestrationEvidencePacket({
    plan,
    createdAt: timestamp,
  });
  const screenshotIds = new Set(
    plan.dispatch.assignments.map((assignment) =>
      `${assignment.id}-screenshot`,
    ),
  );
  const packetWithoutScreenshots: OrchestrationEvidencePacket = {
    ...packet,
    artifacts: packet.artifacts.filter(
      (artifact) => !screenshotIds.has(artifact.id),
    ),
    gates: packet.gates.map((gate) => ({
      ...gate,
      requiredEvidenceArtifactIds: gate.requiredEvidenceArtifactIds.filter(
        (artifactId) => !screenshotIds.has(artifactId),
      ),
      providedEvidenceArtifactIds: gate.providedEvidenceArtifactIds.filter(
        (artifactId) => !screenshotIds.has(artifactId),
      ),
    })),
  };

  orchestrationEvidencePacketSchema.parse(packetWithoutScreenshots);
  assert.throws(
    () =>
      assertReferenceOrchestrationEvidencePacket({
        plan,
        packet: packetWithoutScreenshots,
      }),
    /missing assignment-scoped screenshot/,
  );
});

test('reference evidence assertion requires assignment-scoped screenshots', () => {
  const plan = createReferencePlan();
  const packet = buildReferenceOrchestrationEvidencePacket({
    plan,
    createdAt: timestamp,
  });
  const screenshotId = getReferenceAssignmentEvidenceArtifactIds(
    plan.dispatch.assignments[0]!.id,
  ).find((artifactId) => artifactId.endsWith('-screenshot'))!;
  const packetWithRunScopedScreenshot: OrchestrationEvidencePacket = {
    ...packet,
    artifacts: packet.artifacts.map((artifact) =>
      artifact.id === screenshotId ? toRunScopedArtifact(artifact) : artifact,
    ),
  };

  orchestrationEvidencePacketSchema.parse(packetWithRunScopedScreenshot);
  assert.throws(
    () =>
      assertReferenceOrchestrationEvidencePacket({
        plan,
        packet: packetWithRunScopedScreenshot,
      }),
    /missing assignment-scoped screenshot/,
  );
});

test('reference evidence assertion requires deterministic assignment artifact ids', () => {
  const plan = createReferencePlan();
  const packet = buildReferenceOrchestrationEvidencePacket({
    plan,
    createdAt: timestamp,
  });
  const expectedArtifactId = getReferenceAssignmentEvidenceArtifactIds(
    plan.dispatch.assignments[0]!.id,
  ).find((artifactId) => artifactId.endsWith('-test-report'))!;
  const replacementArtifactId = `${expectedArtifactId}-non-reference`;
  const packetWithNonReferenceId: OrchestrationEvidencePacket = {
    ...packet,
    artifacts: packet.artifacts.map((artifact) =>
      artifact.id === expectedArtifactId
        ? { ...artifact, id: replacementArtifactId }
        : artifact,
    ),
    gates: packet.gates.map((gate) => ({
      ...gate,
      requiredEvidenceArtifactIds: gate.requiredEvidenceArtifactIds.map(
        (artifactId) =>
          artifactId === expectedArtifactId ? replacementArtifactId : artifactId,
      ),
      providedEvidenceArtifactIds: gate.providedEvidenceArtifactIds.map(
        (artifactId) =>
          artifactId === expectedArtifactId ? replacementArtifactId : artifactId,
      ),
    })),
  };

  orchestrationEvidencePacketSchema.parse(packetWithNonReferenceId);
  assert.throws(
    () =>
      assertReferenceOrchestrationEvidencePacket({
        plan,
        packet: packetWithNonReferenceId,
      }),
    /missing assignment-scoped test_report/,
  );
});

test('reference evidence assertion validates run artifact kind and scope', () => {
  const plan = createReferencePlan();
  const packet = buildReferenceOrchestrationEvidencePacket({
    plan,
    createdAt: timestamp,
  });
  const packetWithWrongRunArtifactKind: OrchestrationEvidencePacket = {
    ...packet,
    artifacts: packet.artifacts.map((artifact) =>
      artifact.id === 'run-typecheck-report'
        ? { ...artifact, kind: 'test_report' }
        : artifact,
    ),
  };

  orchestrationEvidencePacketSchema.parse(packetWithWrongRunArtifactKind);
  assert.throws(
    () =>
      assertReferenceOrchestrationEvidencePacket({
        plan,
        packet: packetWithWrongRunArtifactKind,
      }),
    /missing run-scoped typecheck_report/,
  );
});

test('reference evidence packet preserves absolute artifact roots', () => {
  const plan = createReferencePlan();
  const packet = buildReferenceOrchestrationEvidencePacket({
    plan,
    createdAt: timestamp,
    artifactRoot: '/var/harness/evidence',
  });

  assert.ok(
    packet.artifacts.every((artifact) =>
      artifact.path?.startsWith('/var/harness/evidence/'),
    ),
  );

  const rootPacket = buildReferenceOrchestrationEvidencePacket({
    plan,
    createdAt: timestamp,
    artifactRoot: '/',
  });
  assert.ok(
    rootPacket.artifacts.every((artifact) => artifact.path?.startsWith('/')),
  );
  assert.equal(rootPacket.artifacts[0]?.path, '/run/typecheck-report.log');
});

test('MCP Symphony E2E flow persists reference evidence packet artifacts', async () => {
  const tempDir = createTempDir('orchestration-reference-e2e-');
  const dbPath = join(tempDir, 'harness.sqlite');

  try {
    const { internals } = createServer();
    const inspector = internals.tools.get('harness_inspector')!;
    const orchestrator = internals.tools.get('harness_orchestrator')!;
    const symphony = internals.tools.get('harness_symphony')!;
    const artifacts = internals.tools.get('harness_artifacts')!;

    const capabilities = (await inspector.handler({
      action: 'capabilities',
    })) as {
      orchestration: {
        evidence: {
          acceptedArtifactKinds: string[];
        };
      };
    };
    assert.ok(
      capabilities.orchestration.evidence.acceptedArtifactKinds.includes(
        'e2e_report',
      ),
    );
    assert.ok(
      capabilities.orchestration.evidence.acceptedArtifactKinds.includes(
        'screenshot',
      ),
    );

    const workspace = (await orchestrator.handler({
      action: 'init_workspace',
      dbPath,
      workspaceName: 'Reference Evidence Workspace',
    })) as { workspaceId: string };
    const campaign = (await orchestrator.handler({
      action: 'create_campaign',
      dbPath,
      workspaceId: workspace.workspaceId,
      projectName: 'Reference Evidence Project',
      campaignName: 'Reference Evidence Campaign',
      objective: 'Validate automated evidence packets for agentic orchestration.',
    })) as { projectId: string; campaignId: string };

    const compiled = (await symphony.handler({
      action: 'compile_plan',
      milestones: [
        {
          id: 'm-reference-evidence',
          key: 'reference-evidence',
          description: 'Reference E2E evidence matrix',
        },
      ],
      slices: [
        {
          id: 'slice-dispatch',
          milestoneId: 'm-reference-evidence',
          task: 'Dispatch ready work into isolated Symphony worktrees',
          priority: 'critical',
          size: 'M',
          evidenceRequirements: [
            {
              id: 'dispatch-e2e-report',
              kind: 'e2e_report',
              value: 'evidence://reference/dispatch-e2e-report',
              label: 'Dispatch E2E report',
            },
            {
              id: 'dispatch-screenshot',
              kind: 'screenshot',
              value: 'evidence://reference/dispatch-screenshot',
              label: 'Dispatch state screenshot',
            },
          ],
        },
        {
          id: 'slice-inspector',
          milestoneId: 'm-reference-evidence',
          task: 'Inspect persisted evidence and orchestration health',
          priority: 'high',
          size: 'M',
          evidenceRequirements: [
            {
              id: 'inspector-e2e-report',
              kind: 'e2e_report',
              value: 'evidence://reference/inspector-e2e-report',
              label: 'Inspector E2E report',
            },
            {
              id: 'inspector-screenshot',
              kind: 'screenshot',
              value: 'evidence://reference/inspector-screenshot',
              label: 'Inspector state screenshot',
            },
          ],
        },
      ],
    })) as { planIssuesPayload: { milestones: unknown[] } };

    await orchestrator.handler({
      action: 'plan_issues',
      dbPath,
      projectId: campaign.projectId,
      campaignId: campaign.campaignId,
      ...compiled.planIssuesPayload,
    });

    const issueRows = selectIssueRows(dbPath);
    assert.equal(issueRows.length, 2);

    const dispatched = (await symphony.handler({
      action: 'dispatch_ready',
      dbPath,
      projectId: campaign.projectId,
      campaignId: campaign.campaignId,
      repoRoot: join(tempDir, 'repo'),
      worktreeRoot: join(tempDir, 'worktrees'),
      baseRef: 'main',
      ...hostRoutingContext,
      dispatchId: 'dispatch-reference-e2e',
      maxAssignments: 2,
      maxConcurrentAgents: 2,
      mem0Enabled: false,
      issueRequirements: [
        {
          issueId: issueRows[0]!.id,
          requiredCapabilityIds: ['implementation'],
          candidateFilePaths: ['src/runtime/orchestration-dispatcher.ts'],
        },
        {
          issueId: issueRows[1]!.id,
          requiredCapabilityIds: ['evidence'],
          candidateFilePaths: ['src/test/orchestration-e2e-evidence.test.ts'],
        },
      ],
      subagents: [
        {
          id: 'agent-implementation',
          role: 'implementation',
          host: hostRoutingContext.host,
          modelProfile: 'gpt-5-high',
          capabilities: ['implementation', 'typescript'],
          maxConcurrency: 1,
        },
        {
          id: 'agent-evidence',
          role: 'evidence',
          host: hostRoutingContext.host,
          modelProfile: 'gpt-5-high',
          capabilities: ['evidence', 'typescript'],
          maxConcurrency: 1,
        },
      ],
    })) as {
      status: string;
      dispatches: unknown[];
      plan: OrchestrationPlan;
    };

    assert.equal(dispatched.status, 'dispatched');
    assert.equal(dispatched.dispatches.length, 2);

    const runResult = buildReferenceOrchestrationRunResult({
      plan: dispatched.plan,
      runId: 'run-reference-e2e',
      startedAt: timestamp,
      completedAt: timestamp,
      createdAt: timestamp,
      artifactRoot: '.harness/evidence/reference-e2e',
      commitSha: '50c7cf4',
    });
    assert.equal(runResult.evidencePacket.artifacts.length, 8);
    assertReferenceOrchestrationEvidencePacket({
      plan: dispatched.plan,
      packet: runResult.evidencePacket,
    });

    await saveReferenceEvidenceArtifacts({
      artifacts,
      dbPath,
      projectId: campaign.projectId,
      campaignId: campaign.campaignId,
      packet: runResult.evidencePacket,
    });

    const inspected = (await symphony.handler({
      action: 'inspect_state',
      dbPath,
      projectId: campaign.projectId,
      campaignId: campaign.campaignId,
      eventLimit: 20,
    })) as {
      summary: {
        artifacts: {
          byKind: Array<{ kind: string; count: number }>;
          references: { evidencePacketIds: string[]; worktreePaths: string[] };
        };
        health: { status: string };
      };
    };

    const artifactCounts = new Map(
      inspected.summary.artifacts.byKind.map((group) => [
        group.kind,
        group.count,
      ]),
    );
    assert.equal(inspected.summary.health.status, 'healthy');
    assert.equal(artifactCounts.get('evidence_packet'), 1);
    assert.equal(artifactCounts.get('e2e_report'), 2);
    assert.equal(artifactCounts.get('screenshot'), 2);
    assert.equal(artifactCounts.get('test_report'), 2);
    assert.deepEqual(inspected.summary.artifacts.references.evidencePacketIds, [
      runResult.evidencePacket.id,
    ]);
    assert.equal(inspected.summary.artifacts.references.worktreePaths.length, 2);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

interface ServerInternals {
  tools: Map<string, { handler: (args: unknown) => Promise<unknown> }>;
}

class NoopMem0Adapter implements Mem0Adapter {
  readonly metadata = {
    adapterId: 'noop-test',
    contractVersion: '1.0' as const,
    capabilities: {
      supportsRecall: false,
      supportsUpdate: false,
      supportsDelete: false,
      supportsWorkspaceList: false,
      supportsProjectList: false,
    },
  };

  async healthCheck(): Promise<HealthCheckResult> {
    return {
      ok: true,
      storePath: ':memory:',
      ollamaBaseUrl: 'memory://noop',
      embedModel: 'noop',
      modelAvailable: true,
      recordCount: 0,
    };
  }

  async storeMemory(input: MemoryStoreInput): Promise<PublicMemoryRecord> {
    return {
      ...input,
      id: 'noop-memory',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  async recallMemory(_input: MemoryRecallInput): Promise<PublicMemoryRecord | null> {
    return null;
  }

  async searchMemory(_input: MemorySearchInput): Promise<MemorySearchResult[]> {
    return [];
  }

  async updateMemory(): Promise<PublicMemoryRecord> {
    throw new Error('NoopMem0Adapter does not support updateMemory.');
  }

  async deleteMemory(): Promise<void> {}

  async listWorkspaces(): Promise<string[]> {
    return [];
  }

  async listProjects(): Promise<string[]> {
    return [];
  }
}

function createServer(): {
  server: SessionLifecycleMcpServer;
  internals: ServerInternals;
} {
  const mem0Adapter = new NoopMem0Adapter();
  const orchestrator = new SessionOrchestrator({
    mem0Adapter,
    defaultCheckpointFreshnessSeconds: 3600,
  });
  const adapter = new SessionLifecycleAdapter(orchestrator);
  const server = new SessionLifecycleMcpServer(
    adapter,
    undefined,
    async () => mem0Adapter,
  );
  return {
    server,
    internals: server as unknown as ServerInternals,
  };
}

function createReferencePlan(): OrchestrationPlan {
  return {
    contractVersion: '1.0.0',
    objective: 'Validate the deterministic reference E2E evidence matrix.',
    subagents: [
      {
        id: 'agent-implementation',
        role: 'implementation',
        host: 'ci-linux',
        modelProfile: 'gpt-5-high',
        capabilities: ['implementation', 'typescript'],
        maxConcurrency: 1,
      },
      {
        id: 'agent-evidence',
        role: 'evidence',
        host: 'ci-linux',
        modelProfile: 'gpt-5-high',
        capabilities: ['evidence', 'typescript'],
        maxConcurrency: 1,
      },
    ],
    worktrees: [
      {
        id: 'worktree-implementation',
        repoRoot,
        root: worktreeRoot,
        path: join(worktreeRoot, 'agent-implementation'),
        branch: 'feat/M5-I2-implementation',
        baseRef: 'main',
        cleanupPolicy: 'delete_on_completion',
        containment: {
          expectedParentPath: '/tmp',
          requirePathWithinRoot: true,
        },
      },
      {
        id: 'worktree-evidence',
        repoRoot,
        root: worktreeRoot,
        path: join(worktreeRoot, 'agent-evidence'),
        branch: 'feat/M5-I2-evidence',
        baseRef: 'main',
        cleanupPolicy: 'delete_on_completion',
        containment: {
          expectedParentPath: '/tmp',
          requirePathWithinRoot: true,
        },
      },
    ],
    dispatch: {
      strategy: 'fanout',
      maxConcurrentAgents: 2,
      assignments: [
        {
          id: 'assignment-implementation',
          issueId: 'M5-I2-A',
          subagentId: 'agent-implementation',
          worktreeId: 'worktree-implementation',
          requiredCapabilityIds: ['implementation'],
        },
        {
          id: 'assignment-evidence',
          issueId: 'M5-I2-B',
          subagentId: 'agent-evidence',
          worktreeId: 'worktree-evidence',
          requiredCapabilityIds: ['evidence'],
        },
      ],
    },
  };
}

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function selectIssueRows(dbPath: string): Array<{ id: string; task: string }> {
  const db = openHarnessDatabase({ dbPath });
  try {
    return selectAll<{ id: string; task: string }>(
      db.connection,
      'SELECT id, task FROM issues ORDER BY created_at ASC, id ASC',
    );
  } finally {
    db.close();
  }
}

async function saveReferenceEvidenceArtifacts(input: {
  artifacts: { handler: (args: unknown) => Promise<unknown> };
  dbPath: string;
  projectId: string;
  campaignId: string;
  packet: OrchestrationEvidencePacket;
}): Promise<void> {
  await input.artifacts.handler({
    action: 'save',
    dbPath: input.dbPath,
    projectId: input.projectId,
    campaignId: input.campaignId,
    kind: 'evidence_packet',
    path: '.harness/evidence/reference-e2e/packet.json',
    metadata: { evidencePacketId: input.packet.id },
  });

  for (const artifact of input.packet.artifacts) {
    await input.artifacts.handler({
      action: 'save',
      dbPath: input.dbPath,
      projectId: input.projectId,
      campaignId: input.campaignId,
      kind: artifact.kind,
      path: artifact.path ?? artifact.uri ?? `evidence://${artifact.id}`,
      metadata: {
        evidencePacketId: input.packet.id,
        evidenceArtifactId: artifact.id,
        scope: artifact.scope,
      },
    });
  }
}

function toRunScopedArtifact(
  artifact: OrchestrationEvidenceArtifact,
): OrchestrationEvidenceArtifact {
  const { producedBySubagentId: _subagentId, worktreeId: _worktreeId, ...rest } =
    artifact;
  return {
    ...rest,
    scope: 'run',
  };
}
