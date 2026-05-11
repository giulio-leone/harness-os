import {
  orchestrationEvidencePacketSchema,
  orchestrationRunResultSchema,
  type OrchestrationAssignment,
  type OrchestrationAssignmentResult,
  type OrchestrationEvidenceArtifact,
  type OrchestrationEvidenceArtifactKind,
  type OrchestrationEvidencePacket,
  type OrchestrationPlan,
  type OrchestrationRunResult,
  type OrchestrationWorktree,
} from '../contracts/orchestration-contracts.js';

const referenceRunEvidenceKinds = [
  'typecheck_report',
  'state_export',
] as const satisfies readonly OrchestrationEvidenceArtifactKind[];

const referenceAssignmentEvidenceKinds = [
  'test_report',
  'e2e_report',
  'screenshot',
] as const satisfies readonly OrchestrationEvidenceArtifactKind[];

type ReferenceRunEvidenceKind = (typeof referenceRunEvidenceKinds)[number];
type ReferenceAssignmentEvidenceKind =
  (typeof referenceAssignmentEvidenceKinds)[number];

export const referenceOrchestrationE2eEvidenceMatrix = {
  contractVersion: '1.0.0',
  runScope: referenceRunEvidenceKinds,
  assignmentScope: referenceAssignmentEvidenceKinds,
  gates: [
    {
      id: 'reference-static-gate',
      name: 'Reference static and state evidence',
      requiredArtifactKinds: referenceRunEvidenceKinds,
    },
    {
      id: 'reference-assignment-e2e-gate',
      name: 'Reference assignment E2E evidence',
      requiredArtifactKinds: referenceAssignmentEvidenceKinds,
    },
  ],
} as const;

export interface BuildReferenceOrchestrationEvidencePacketInput {
  plan: OrchestrationPlan;
  createdAt: string;
  artifactRoot?: string;
  packetId?: string;
  summary?: string;
  commitSha?: string;
  metadata?: Record<string, string>;
}

export interface BuildReferenceOrchestrationRunResultInput
  extends BuildReferenceOrchestrationEvidencePacketInput {
  runId: string;
  startedAt: string;
  completedAt: string;
  runSummary?: string;
}

export interface AssertReferenceOrchestrationEvidencePacketInput {
  plan: OrchestrationPlan;
  packet: OrchestrationEvidencePacket;
}

export function buildReferenceOrchestrationEvidencePacket(
  input: BuildReferenceOrchestrationEvidencePacketInput,
): OrchestrationEvidencePacket {
  const artifactRoot = input.artifactRoot ?? '.harness/evidence/reference';
  const worktreeById = indexWorktrees(input.plan);
  const runArtifactIds = referenceRunEvidenceKinds.map((kind) =>
    buildRunArtifactId(kind),
  );
  const assignmentArtifacts = input.plan.dispatch.assignments.flatMap((assignment) =>
    buildAssignmentArtifacts({
      assignment,
      artifactRoot,
      createdAt: input.createdAt,
    }),
  );
  const runArtifacts = referenceRunEvidenceKinds.map((kind) =>
    buildRunArtifact({
      kind,
      artifactRoot,
      createdAt: input.createdAt,
    }),
  );
  const packet = orchestrationEvidencePacketSchema.parse({
    id: input.packetId ?? 'reference-orchestration-e2e-packet',
    summary:
      input.summary ??
      'Reference deterministic E2E evidence packet for agentic orchestration.',
    artifacts: [...runArtifacts, ...assignmentArtifacts],
    gates: [
      {
        id: 'reference-static-gate',
        name: 'Reference static and state evidence',
        status: 'passed',
        requiredEvidenceArtifactIds: runArtifactIds,
        providedEvidenceArtifactIds: runArtifactIds,
        command: 'npm run typecheck && harness_inspector export',
        exitCode: 0,
        completedAt: input.createdAt,
      },
      ...input.plan.dispatch.assignments.map((assignment) => {
        const artifactIds = getReferenceAssignmentEvidenceArtifactIds(
          assignment.id,
        );
        return {
          id: `${assignment.id}-reference-e2e-gate`,
          name: `Reference E2E evidence for ${assignment.id}`,
          status: 'passed',
          requiredEvidenceArtifactIds: artifactIds,
          providedEvidenceArtifactIds: artifactIds,
          command: 'npm test -- orchestration-e2e-evidence',
          exitCode: 0,
          completedAt: input.createdAt,
        };
      }),
    ],
    codebaseRefs: input.plan.dispatch.assignments.map((assignment) => {
      const worktree = requireWorktree(worktreeById, assignment.worktreeId);
      return {
        id: `${assignment.id}-codebase-ref`,
        repoRoot: worktree.repoRoot,
        branch: worktree.branch,
        baseRef: worktree.baseRef,
        ...(input.commitSha !== undefined ? { commitSha: input.commitSha } : {}),
        worktreeId: assignment.worktreeId,
        paths: ['.'],
      };
    }),
    createdAt: input.createdAt,
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  });

  assertReferenceOrchestrationEvidencePacket({ plan: input.plan, packet });
  return packet;
}

export function buildReferenceOrchestrationRunResult(
  input: BuildReferenceOrchestrationRunResultInput,
): OrchestrationRunResult {
  const evidencePacket = buildReferenceOrchestrationEvidencePacket(input);

  return orchestrationRunResultSchema.parse({
    runId: input.runId,
    status: 'succeeded',
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    plan: input.plan,
    assignmentResults: input.plan.dispatch.assignments.map((assignment) =>
      buildAssignmentResult(assignment),
    ),
    evidencePacket,
    summary:
      input.runSummary ??
      'Reference deterministic E2E evidence matrix passed.',
  });
}

export function assertReferenceOrchestrationEvidencePacket(
  input: AssertReferenceOrchestrationEvidencePacketInput,
): OrchestrationEvidencePacket {
  const packet = orchestrationEvidencePacketSchema.parse(input.packet);
  const passedGateEvidenceIds = new Set(
    packet.gates
      .filter((gate) => gate.status === 'passed')
      .flatMap((gate) => gate.providedEvidenceArtifactIds),
  );

  for (const kind of referenceRunEvidenceKinds) {
    const artifact = findRunArtifact(packet, kind);

    if (artifact === undefined) {
      throw new Error(
        `Reference evidence packet "${packet.id}" is missing run-scoped ${kind}.`,
      );
    }

    if (!passedGateEvidenceIds.has(artifact.id)) {
      throw new Error(
        `Reference run evidence artifact "${artifact.id}" is not covered by a passed evidence gate.`,
      );
    }
  }

  for (const assignment of input.plan.dispatch.assignments) {
    assertCodebaseRefForAssignment(packet, assignment);

    for (const kind of referenceAssignmentEvidenceKinds) {
      const artifact = findAssignmentArtifact(packet, assignment, kind);
      if (artifact === undefined) {
        throw new Error(
          `Reference evidence packet "${packet.id}" is missing assignment-scoped ${kind} for assignment "${assignment.id}".`,
        );
      }

      if (!passedGateEvidenceIds.has(artifact.id)) {
        throw new Error(
          `Reference assignment artifact "${artifact.id}" is not covered by a passed evidence gate.`,
        );
      }
    }
  }

  return packet;
}

export function getReferenceRunEvidenceArtifactIds(): string[] {
  return referenceRunEvidenceKinds.map((kind) => buildRunArtifactId(kind));
}

export function getReferenceAssignmentEvidenceArtifactIds(
  assignmentId: string,
): string[] {
  return referenceAssignmentEvidenceKinds.map((kind) =>
    buildAssignmentArtifactId(assignmentId, kind),
  );
}

function buildRunArtifact(input: {
  kind: ReferenceRunEvidenceKind;
  artifactRoot: string;
  createdAt: string;
}): OrchestrationEvidenceArtifact {
  const suffix = artifactKindSuffix(input.kind);
  return {
    id: buildRunArtifactId(input.kind),
    kind: input.kind,
    scope: 'run',
    path: joinArtifactPath('run', `${suffix}.${artifactExtension(input.kind)}`, input.artifactRoot),
    createdAt: input.createdAt,
    metadata: {
      matrixScope: 'run',
      evidenceKind: input.kind,
    },
  };
}

function buildAssignmentArtifacts(input: {
  assignment: OrchestrationAssignment;
  artifactRoot: string;
  createdAt: string;
}): OrchestrationEvidenceArtifact[] {
  return referenceAssignmentEvidenceKinds.map((kind) => ({
    id: buildAssignmentArtifactId(input.assignment.id, kind),
    kind,
    scope: 'assignment',
    path: joinArtifactPath(
      input.assignment.id,
      `${artifactKindSuffix(kind)}.${artifactExtension(kind)}`,
      input.artifactRoot,
    ),
    ...(kind === 'screenshot' ? { mimeType: 'image/png' } : {}),
    producedBySubagentId: input.assignment.subagentId,
    worktreeId: input.assignment.worktreeId,
    createdAt: input.createdAt,
    metadata: {
      matrixScope: 'assignment',
      assignmentId: input.assignment.id,
      evidenceKind: kind,
    },
  }));
}

function buildAssignmentResult(
  assignment: OrchestrationAssignment,
): OrchestrationAssignmentResult {
  return {
    assignmentId: assignment.id,
    subagentId: assignment.subagentId,
    worktreeId: assignment.worktreeId,
    status: 'succeeded',
    evidenceArtifactIds: getReferenceAssignmentEvidenceArtifactIds(assignment.id),
  };
}

function assertCodebaseRefForAssignment(
  packet: OrchestrationEvidencePacket,
  assignment: OrchestrationAssignment,
): void {
  const hasRef = packet.codebaseRefs.some(
    (ref) =>
      ref.worktreeId === undefined || ref.worktreeId === assignment.worktreeId,
  );

  if (!hasRef) {
    throw new Error(
      `Reference evidence packet "${packet.id}" is missing codebase ref coverage for assignment "${assignment.id}".`,
    );
  }
}

function findAssignmentArtifact(
  packet: OrchestrationEvidencePacket,
  assignment: OrchestrationAssignment,
  kind: ReferenceAssignmentEvidenceKind,
): OrchestrationEvidenceArtifact | undefined {
  const expectedArtifactId = buildAssignmentArtifactId(assignment.id, kind);
  const artifact = packet.artifacts.find(
    (candidate) => candidate.id === expectedArtifactId,
  );

  if (
    artifact === undefined ||
    artifact.kind !== kind ||
    artifact.metadata?.['assignmentId'] !== assignment.id ||
    !(
      artifact.scope === 'assignment' &&
      artifact.producedBySubagentId === assignment.subagentId &&
      artifact.worktreeId === assignment.worktreeId
    )
  ) {
    return undefined;
  }

  return artifact;
}

function findRunArtifact(
  packet: OrchestrationEvidencePacket,
  kind: ReferenceRunEvidenceKind,
): OrchestrationEvidenceArtifact | undefined {
  const expectedArtifactId = buildRunArtifactId(kind);
  const artifact = packet.artifacts.find(
    (candidate) => candidate.id === expectedArtifactId,
  );

  if (
    artifact === undefined ||
    artifact.kind !== kind ||
    artifact.scope !== 'run'
  ) {
    return undefined;
  }

  return artifact;
}

function buildRunArtifactId(kind: ReferenceRunEvidenceKind): string {
  return `run-${artifactKindSuffix(kind)}`;
}

function buildAssignmentArtifactId(
  assignmentId: string,
  kind: ReferenceAssignmentEvidenceKind,
): string {
  return `${assignmentId}-${artifactKindSuffix(kind)}`;
}

function artifactKindSuffix(
  kind: ReferenceRunEvidenceKind | ReferenceAssignmentEvidenceKind,
): string {
  switch (kind) {
    case 'typecheck_report':
      return 'typecheck-report';
    case 'state_export':
      return 'state-export';
    case 'test_report':
      return 'test-report';
    case 'e2e_report':
      return 'e2e-report';
    case 'screenshot':
      return 'screenshot';
  }
}

function artifactExtension(
  kind: ReferenceRunEvidenceKind | ReferenceAssignmentEvidenceKind,
): string {
  switch (kind) {
    case 'typecheck_report':
      return 'log';
    case 'screenshot':
      return 'png';
    case 'state_export':
    case 'test_report':
    case 'e2e_report':
      return 'json';
  }
}

function joinArtifactPath(
  firstSegment: string,
  secondSegment: string,
  artifactRoot: string,
): string {
  const root = trimArtifactRoot(artifactRoot);
  const childPath = [firstSegment, secondSegment]
    .map((segment) => segment.replace(/^\/+|\/+$/gu, ''))
    .filter((segment) => segment.length > 0)
    .join('/');

  if (root === '/') {
    return `/${childPath}`;
  }

  return root.length > 0 ? `${root}/${childPath}` : childPath;
}

function trimArtifactRoot(artifactRoot: string): string {
  const trimmed = artifactRoot.replace(/\/+$/u, '');
  return trimmed.length === 0 && artifactRoot.startsWith('/') ? '/' : trimmed;
}

function indexWorktrees(plan: OrchestrationPlan): Map<string, OrchestrationWorktree> {
  return new Map(plan.worktrees.map((worktree) => [worktree.id, worktree]));
}

function requireWorktree(
  worktreeById: ReadonlyMap<string, OrchestrationWorktree>,
  worktreeId: string,
): OrchestrationWorktree {
  const worktree = worktreeById.get(worktreeId);
  if (worktree === undefined) {
    throw new Error(`Reference evidence plan is missing worktree "${worktreeId}".`);
  }
  return worktree;
}
