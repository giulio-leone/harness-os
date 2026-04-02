# Skills Index

Use this index to quickly select the right skill file.

## Decision & Interaction
- `interaction-loop/SKILL.md` — 5-option iterative question flow, rating/next action/satisfaction checkpoints.
- `breaking-change-paths/SKILL.md` — non-breaking vs breaking packaging, migration, unchanged quality gates.

## Planning & Delivery
- `harness-lifecycle/SKILL.md` — two-phase harness (initializer + incremental sessions), cross-session memory, and canonical queue materialization.
- `session-lifecycle/SKILL.md` — task-scoped operational protocol for reconciliation, claims, checkpoints, handoff, and milestone-gated queue promotion.
- `planning-tracking/SKILL.md` — plan structure, milestone/issue flow, effort sizing, and canonical `milestones[]` export for HarnessOS.
- `completion-gate/SKILL.md` — mandatory quality gate and double clean-pass rule.
- `github-sync/SKILL.md` — mirror plan states to GitHub artifacts, default label set.
- `session-logging/SKILL.md` — mandatory session reporting format with template.
- `rollback-rca/SKILL.md` — failure handling, rollback, root-cause escalation.
- `git-workflow/SKILL.md` — branch naming, commit messages, PR conventions, merge strategy.

## Code Quality
- `code-review/SKILL.md` — structured review checklist (correctness, security, performance, maintainability).
- `error-handling-patterns/SKILL.md` — retry, circuit breaker, graceful degradation, structured errors.
- `dependency-management/SKILL.md` — audit, update policy, license verification, supply chain security.

## Testing
- `testing-policy/SKILL.md` — unit/integration/E2E/non-regression baseline and enforcement.
- `e2e-testing/SKILL.md` — focused E2E execution checklist and anti-flakiness rules.

## Performance
- `performance-audit/SKILL.md` — Core Web Vitals, bundle size, memory profiling, network efficiency.

## Debugging
- `systematic-debugging/SKILL.md` — evidence-based debugging via structured logging, `debug-data.log` analysis, and MCP tool integration.

## Context & Orchestration
- `context-management/SKILL.md` — rules for context window hygiene, avoiding bloat, preserving signal-to-noise.
- `programmatic-tool-calling/SKILL.md` — multi-step tool workflows via code orchestration.

## Policy Maintenance
- `policy-coherence-audit/SKILL.md` — detect and fix contradictions across AGENTS policies.

## Suggested invocation order (quick)
0. `harness-lifecycle` (initializer or incremental session boot)
1. `session-lifecycle` (claim, reconcile, checkpoint, handoff)
2. `interaction-loop` (select path)
3. `planning-tracking`
4. `git-workflow` (branch + commit conventions)
5. `breaking-change-paths` (if relevant)
6. `code-review` (during/after implementation)
7. `testing-policy` + `e2e-testing` (if relevant)
8. `error-handling-patterns` (for resilience)
9. `systematic-debugging` (if bug/unexpected behavior)
10. `performance-audit` (before release)
11. `dependency-management` (before adding deps or releasing)
12. `completion-gate`
13. `session-logging` + `github-sync` (includes harness handoff)
14. `rollback-rca` (only if blocked/failing repeatedly)
15. `context-management` (long sessions)
16. `programmatic-tool-calling` (complex tool workflows)
17. `policy-coherence-audit` (when editing policy)

## Quick lookup by runtime goal

| Goal | Start with | Then usually pair with |
| --- | --- | --- |
| Boot a new HarnessOS session | `harness-lifecycle` | `session-lifecycle`, `interaction-loop` |
| Plan and sync delivery | `planning-tracking` | `github-sync`, `session-logging`, `completion-gate` |
| Evaluate a risky migration | `breaking-change-paths` | `rollback-rca`, `completion-gate`, `git-workflow` |
| Debug a failing runtime path | `systematic-debugging` | `error-handling-patterns`, `context-management` |
| Reduce noisy multi-step tool traffic | `programmatic-tool-calling` | `context-management`, `session-logging` |
| Validate release readiness | `testing-policy` | `e2e-testing`, `dependency-management`, `performance-audit`, `completion-gate` |

## Profile-to-skills mapping

All workload profiles include the core runtime skills. Use this table to find the profile-specific additions quickly:

| Workload profile | Additional skills on top of the core runtime set |
| --- | --- |
| `coding` | `breaking-change-paths`, `code-review`, `dependency-management`, `e2e-testing`, `error-handling-patterns`, `git-workflow`, `github-sync`, `mobile-mcp-optimization`, `performance-audit`, `systematic-debugging`, `testing-policy` |
| `research` | `systematic-debugging` |
| `ops` | `dependency-management`, `e2e-testing`, `error-handling-patterns`, `performance-audit`, `systematic-debugging` |
| `sales` | `github-sync` |
| `support` | `error-handling-patterns`, `systematic-debugging` |
| `assistant` | all bundled skills |

## Programmatic discoverability

- `harness_inspector(action: "capabilities")` is the canonical machine-readable index for tools, skills, workload profiles, and mem0 state.
- `.github/skills/bundle-manifest.json` is the packaged build-time artifact that ties skill metadata, workload profiles, version, and checksums together.
- `docs/workload-profiles.md` maps profiles to concrete workspace templates.
- `docs/mcp-tools.md` and `docs/cli-reference.md` are the human-facing entrypoints for MCP actions and installable commands.
