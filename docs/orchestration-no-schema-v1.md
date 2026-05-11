# Symphony-style orchestration no-schema v1

HarnessOS implements a Symphony-inspired orchestration layer as an additive runtime over the existing schema-v5 lifecycle store. The v1 goal is to coordinate isolated agentic implementation attempts per issue without introducing schema v6, a second scheduler database, or a human approval checkpoint in the runtime path.

The external design reference is OpenAI Symphony's draft service model: tracker-driven work selection, bounded concurrency, isolated per-issue workspaces, retry/recovery, and proof-of-work artifacts. HarnessOS maps those concepts onto its existing queue, lease, checkpoint, event, artifact, and inspector surfaces instead of copying Symphony's Linear-specific daemon shape.

Source references:

- OpenAI Symphony README: <https://github.com/openai/symphony>
- OpenAI Symphony service spec: <https://github.com/openai/symphony/blob/main/SPEC.md>

## Contract map

| Symphony concept | HarnessOS v1 contract | Code boundary |
| --- | --- | --- |
| Issue tracker work item | Existing `issues` rows planned by `harness_orchestrator(action: "plan_issues")` | `src/db/sqlite.schema.sql`, `src/runtime/harness-planning-tools.ts` |
| Orchestrator state | Existing `runs`, `leases`, `active_sessions`, `events`, and issue status state | `src/runtime/session-orchestrator.ts`, `src/db/lease-manager.ts` |
| Per-issue workspace | Validated worktree allocation metadata, not shell-created worktrees | `src/runtime/worktree-manager.ts` |
| Agent registry | Typed subagent definitions with host, model profile, capabilities, and capacity | `src/contracts/orchestration-contracts.ts`, `src/runtime/subagent-registry.ts` |
| Dispatch loop | Ready-issue selection, subagent/worktree assignment, session claim, and bounded fan-out | `src/runtime/orchestration-dispatcher.ts` |
| Conflict avoidance | Project-wide worktree path, branch, and candidate-file locks | `src/runtime/orchestration-conflicts.ts` |
| Proof of work | Evidence packet contracts plus persisted session artifacts and checkpoint references | `src/contracts/orchestration-contracts.ts`, `src/runtime/session-orchestrator.ts` |
| Status surface | Read-only orchestration summary and health flags | `src/runtime/orchestration-inspector.ts` |

## Why no schema v6

The orchestration layer deliberately reuses schema-v5 tables:

| Existing table | Orchestration responsibility |
| --- | --- |
| `issues` | Source of ready work, dependency state, priority, candidate issue scope, and terminal status. |
| `leases` | Atomic ownership, per-agent capacity accounting, stale-lease recovery, and active-run exclusion. |
| `runs` | Session attempt identity, host attribution, status, and legacy artifact notes compatibility. |
| `checkpoints` | Claim/resume/recovery and close evidence anchors through `artifact_ids_json`. |
| `events` | Immutable lifecycle facts such as `session_artifacts_registered` and `session_artifacts_released`. |
| `artifacts` | Durable references to worktrees, branches, candidate file sets, assignments, screenshots, logs, reports, and future scorecards. |
| `active_sessions` | Public MCP/CLI session token continuity, including retry-safe begin calls for the same run id. |

No orchestration-specific table is required for v1 because the existing store already has the three invariants orchestration needs: transactional ownership (`leases`), durable evidence (`artifacts` + `checkpoints`), and auditable history (`events`).

## Layer boundaries

### 1. Planning boundary

`plan_issues` remains the only public way to create canonical queue work. Symphony-style slices are normalized by `src/runtime/orchestration-planner.ts` into the existing milestone/issue batch contract. The planner does not claim leases, create worktrees, or run agents.

### 2. Dispatch boundary

`dispatchReadyOrchestrationIssues()` is an internal runtime boundary for selecting ready work and creating one assignment per issue. It:

- promotes newly unblocked work before selection;
- reads ready issues from the canonical SQLite store;
- builds deterministic worktree metadata from `repoRoot`, `worktreeRoot`, `baseRef`, and issue id;
- selects a compatible subagent from host/capability/model profile constraints;
- enforces bounded concurrency through active lease counts plus planned assignments;
- calls `SessionOrchestrator.beginIncrementalSession()` to claim the issue atomically.

It does not execute `git worktree add`, run a coding agent process, open a PR, or mark work done. Those are host/agent responsibilities and must report evidence back through the session and artifact contracts.

### 3. Worktree boundary

`worktree-manager` validates and describes workspace isolation. It normalizes absolute repo/worktree roots, rejects unsafe git refs and traversal segments, detects duplicate paths/branches within a planned batch, and emits cleanup command plans. It intentionally does not run shell commands; callers must execute generated git commands in their host environment and register the resulting paths as artifacts.

### 4. Conflict boundary

Conflict checks run twice:

1. In the dispatcher before assignment, against active project-level locks plus assignments planned in the current dispatch.
2. Inside `SessionOrchestrator.beginIncrementalSession()` in the same SQLite transaction that claims the lease.

This second check is the authoritative guard against race conditions. It scans active run notes and active session artifacts, ignores released/inactive artifact metadata, and blocks duplicate worktree paths, duplicate worktree branches, and overlapping candidate file paths across the project.

### 5. Evidence boundary

Session artifacts are the no-schema persistence mechanism for orchestration evidence. On claim, resume, and recovery, `SessionOrchestrator` inserts each session artifact into `artifacts`, links the generated artifact ids from the claim/recovery checkpoint, and emits `session_artifacts_registered`.

Persisted orchestration artifact metadata includes:

| Key | Meaning |
| --- | --- |
| `source` | Always `session_orchestrator` for artifacts managed by the lifecycle runtime. |
| `runId` | The session attempt that registered the artifact. |
| `leaseId` | The owning lease at registration time. |
| `agentId` | The subagent or host agent holding the lease. |
| `host` | The runtime host that claimed the issue. |
| `claimMode` | `claim`, `resume`, or `recovery`. |
| `status` | `active` while the session owns it; `released` after close or supersession. |

When a later resume or retry registers the same logical artifact (`kind` + `path`) for the same issue, the previous active row is superseded and marked `released`. Persisted artifact ids are always minted per insertion, so callers can safely round-trip returned `SessionArtifactReference.id` values without colliding on retries.

On `close()`, session-managed artifacts for the run are released even when `releaseLease` is `false`, because artifact liveness tracks session ownership rather than lease-release policy. The close checkpoint remains the final task-state evidence anchor.

### 6. Inspector boundary

`inspectOrchestration()` is read-only and never initializes or mutates a database. It summarizes issue state, active leases, artifacts grouped by kind, recent events, extracted worktree/subagent/evidence references, and health flags. Branch marker artifacts are not treated as worktree path artifacts; only actual worktree path artifacts participate in duplicate active worktree health checks.

### 7. Public API boundary

The v1 orchestration modules are intentionally additive at the database/schema layer. Existing lifecycle contracts remain valid, with one compatible extension: `SessionArtifactReference.id` is optional on input and present on persisted session artifacts returned from begin/resume/recovery. The public package surface exports stable orchestration modules, and the MCP surface exposes a dedicated `harness_symphony` tool for compile/dispatch/inspect orchestration workflows.

## Fully agentic completion posture

HarnessOS does not encode a human-review state into the orchestration runtime. Completion is a task-state transition backed by automated evidence:

- codebase references identify the exact repo, branch, commit, worktree, and touched paths;
- evidence artifacts can represent test reports, typecheck/build logs, E2E reports, screenshots, videos, traces, CI status, review feedback, and future CSQR-lite scorecards;
- evidence gates require declared artifacts before a run result can be considered successful;
- checkpoints and events make the proof trail replayable from SQLite.

The runtime therefore supports a no-human-checkpoint mode while keeping quality gates explicit. It does not weaken tests, schema validation, or conflict checks; it only changes who supplies the approval signal from a human operator to deterministic evidence.

### Reference E2E evidence matrix

HarnessOS now ships a deterministic reference matrix for automated orchestration evidence. It is intentionally a reference fixture and assertion helper, not a new database table, schema version, or long-running executor.

The matrix requires run-scoped `typecheck_report` and `state_export` artifacts, plus assignment-scoped `test_report`, `e2e_report`, and `screenshot` artifacts for every planned assignment. Reference packet assertions verify that those assignment artifacts are produced by the planned subagent, belong to the planned worktree, are covered by passed gates, and have codebase reference coverage. This keeps the no-human-review path auditable while leaving actual shell commands, screenshots, and CI execution host-owned.

The copy/paste MCP handoff for this flow lives in [`../examples/orchestration-symphony/`](../examples/orchestration-symphony/). Those examples are intentionally host-facing rather than generated session-lifecycle CLI payloads: they show the stable `harness_inspector` -> `harness_orchestrator` -> `harness_symphony` -> `harness_artifacts` call chain and are validated against the public MCP input schemas in the test suite.

### CSQR-lite scoring model

CSQR-lite is the additive scorecard model for automated completion decisions. M6-I1 defines the in-memory public contract only; it does not add schema-v6 tables, mutate schema-v5 rows, persist scorecards automatically, or enforce thresholds yet.

The model has four required dimensions:

| Dimension | Meaning | Default weight |
| --- | --- | --- |
| `correctness` | Planned behavior works, compatibility is preserved, and no known functional regression remains. | `2.0` |
| `security` | No secrets, unsafe input handling, authorization regressions, or known vulnerable dependency patterns are introduced. | `1.5` |
| `quality` | Code remains maintainable, type-safe, cohesive, performant enough for its path, and free of unnecessary technical debt. | `1.0` |
| `runtime_evidence` | Deterministic test, build, E2E, screenshot, state-export, or CI artifacts prove the run. | `1.5` |

Every CSQR-lite scorecard must include 4-15 criteria, at least one criterion per dimension, exactly one 1-10 score for every criterion, and evidence artifact ids for every score. `weightedAverage` is normalized as `sum(score * weight) / sum(weight)` and rounded to four decimal places, so future M6-I3 thresholds can compare scorecards deterministically. `targetScore` defaults to `8.0` but remains informational in M6-I1; persistence as `csqr_lite_scorecard` evidence artifacts is reserved for M6-I2, and gate threshold enforcement is reserved for M6-I3.

## Current v1 limits

- The dispatcher assigns work and claims sessions; it is not yet a long-running daemon.
- Worktree metadata and cleanup plans are typed; shell execution remains a host responsibility.
- Evidence packet validation and deterministic reference E2E assertions exist; the full E2E/CI gate runner remains host-owned until later hardening milestones.
- Worktree execution remains host-owned: MCP dispatch records deterministic worktree/branch assignments and evidence metadata, but does not shell out to create or delete git worktrees.
- Dashboard and CSQR-lite scorecard persistence build on this evidence substrate rather than changing the schema.
