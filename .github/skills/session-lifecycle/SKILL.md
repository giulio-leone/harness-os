---
name: session-lifecycle
description: "Operational session protocol for task-scoped leases, reconciliation, checkpoints, inspection, queue promotion, and handoff across long-running work."
version: "2.0.1"
---

# Session Lifecycle

## Purpose
Enforce the operational protocol for long-running work when a single task or lease is claimed, resumed, checkpointed, inspected, promoted, and handed off.

## Use when
- Starting or resuming any task-scoped session
- Claiming work from a canonical SQLite queue
- Recovering stale `in_progress` work
- Inspecting queue, issue, lease, checkpoint, or memory-link state without mutation
- Promoting newly eligible dependent issues to `ready`
- Closing, releasing, or handing off a task

## Canonical Contract
1. SQLite is the operational source of truth. mem0 is optional support memory only.
2. A "session" is the scope of a claimed issue or lease, not the wall-clock lifespan of the agent process.
3. `session-lifecycle` selects and claims the next issue from SQLite. Project or domain skills execute the assigned work.
4. `task_status` is separate from lease metadata. The canonical vocabulary is `pending`, `ready`, `in_progress`, `blocked`, `needs_recovery`, `done`, and `failed`.
5. Reconciliation is mandatory before claiming new work. A task is stale if its lease is expired or its last checkpoint is too old.
6. New claims are blocked while unresolved recovery or incoherent stale state exists.
7. Checkpoints are mandatory on claim, on every `task_status` transition, and before release or close.
8. Each checkpoint must include `task_status`, a short summary, evidence or artifact references, and `next_step`.
9. mem0 is read on begin or recovery and written only on significant checkpoints or close, with canonical scope tags and links back to SQLite evidence.
10. Queue promotion belongs to the lifecycle layer: eligible dependent issues may be promoted automatically on `close(done)` or explicitly through `promote_queue`, and promotion must respect both issue-level and milestone-level dependency gates.
11. New queue work must be imported through the canonical batch-first `harness_orchestrator(action: "plan_issues")` contract using `milestones[]`; do not rely on the removed legacy single-milestone payload.

## Runtime Surface
The verified runtime in `agent-harness-core` exposes:
- `begin_incremental`
- `begin_recovery`
- `checkpoint`
- `close`
- `inspect_overview`
- `inspect_issue`
- `promote_queue`

Host-facing surfaces:
- `SessionLifecycleAdapter` for in-process integration
- `src/bin/session-lifecycle.ts` for JSON-driven CLI execution
- `src/bin/session-lifecycle-mcp.ts` for MCP-hosted lifecycle tools

Example fixtures live under `examples/session-lifecycle/`.

## Procedure
1. Read the global `AGENTS.MD` contract and any explicit local `AGENTS.md` overrides.
2. Run reconciliation before selecting work: inspect `in_progress` issues, lease expiry, and checkpoint freshness.
3. Resolve or escalate stale work first. Do not claim new work while recovery remains open.
4. Select the next ready issue from SQLite and claim or resume its lease.
5. Write the initial checkpoint immediately after claim.
6. Load mem0 context if available and relevant for begin or recovery.
7. Hand execution to the relevant project or domain skill for the assigned issue only.
8. Write a checkpoint on every `task_status` change.
9. On `close(done)`, allow lifecycle-driven queue promotion to advance newly eligible dependent issues and newly eligible dependent milestones.
10. Use `inspect_overview` or `inspect_issue` for read-only state inspection; do not mutate canonical state from ad-hoc scripts when inspection is enough.
11. Before release, close, or handoff, write the final checkpoint and persist any allowed mem0 summary.

## Implementation Hooks
- `SessionOrchestrator.beginIncrementalSession()` claims or resumes the lease, writes the initial SQLite checkpoint, and loads mem0 context at task scope.
- The same begin path runs reconciliation first: expired leases or stale checkpoints are promoted to `needs_recovery`, recorded as canonical SQLite evidence, and block fresh claims until recovery is resolved.
- `SessionOrchestrator.beginRecoverySession()` is the explicit resolution path: it closes the stale lease set, opens a fresh recovery lease, writes the recovery claim checkpoint, and then resumes execution under the new lease.
- `SessionOrchestrator.checkpoint()` writes the canonical checkpoint to SQLite, records the structured payload in `events`, and only writes mem0 when the checkpoint is significant or explicitly requested.
- `SessionOrchestrator.close()` writes the final checkpoint, links the derived mem0 record back to SQLite through `memory_links`, releases the lease, and promotes newly eligible dependent issues when appropriate.
- `SessionOrchestrator.promoteQueue()` is the explicit queue-advancement path for promoting eligible pending issues without hand-written project logic.

## Done Criteria
- A single issue or lease was handled under one explicit lifecycle.
- Reconciliation completed before any new claim.
- Checkpoints exist for claim, status transitions, and close or release.
- mem0 writes, if any, remain derived, scoped, and linked back to SQLite evidence.
- Queue advancement happened through the lifecycle layer, not through project-specific direct database mutation.

## Anti-patterns
- Treating the wall-clock life of the process as the session boundary
- Letting project skills pick work independently from SQLite
- Writing canonical issue state directly from domain skills
- Claiming new work while `needs_recovery` or stale state is unresolved
- Writing mem0 entries that are not linked to canonical evidence
- Re-implementing queue promotion in a project wrapper when the lifecycle already exposes `promote_queue`
- Planning queue work with the removed top-level `milestoneDescription` or `issues` payload instead of canonical `milestones[]`

## Related Skills
- `harness-lifecycle` — umbrella model for long-running work
- `prompt-contract-bindings` — keeps prompt-specific schema/workflow local while lifecycle behavior stays global
- `planning-tracking` — provides the work units and dependency structure
- `session-logging` — records the session journal and handoff details
- `interaction-loop` — governs decision checkpoints with the user

## Version Notes
- `2.0.1` — `harness_session(action: "begin")` and `begin_recovery` now auto-generate `sessionId` when omitted, so MCP callers no longer fail on missing run IDs.
- `2.0.0` — made queue planning batch-first only, documented milestone-gated promotion, and removed the legacy single-milestone import payload from the skill contract.
- `1.1.0` — promoted `agent-harness-core` to the repo-native source of truth, documented `inspect_overview`, `inspect_issue`, explicit `promote_queue`, and automatic queue promotion on `close(done)`.
