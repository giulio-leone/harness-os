---
name: planning-tracking
description: "Execution plan with milestone/issue hierarchy, explicit dependencies, and safe parallelism."
---
# Planning & Tracking Skill

## Purpose
Create and maintain an execution plan with milestone/issue hierarchy, explicit dependencies, and safe parallelism.

## Use when
- Starting any non-trivial task
- Scope changes during execution
- Multiple files/workstreams must be coordinated

## Mandatory Schema
```typescript
interface Plan { PRD: string; context: string; milestones: Record<string, Milestone>; }
interface Milestone { id: string; description: string; priority: "critical"|"high"|"medium"|"low"; status: "todo"|"in_progress"|"review"|"done"; depends_on: string[]; issues: Record<string, Issue>; }
interface Issue { id: string; task: string; priority: "critical"|"high"|"medium"|"low"; status: "todo"|"in_progress"|"review"|"done"|"blocked"; depends_on: string[]; children: Record<string, Issue>; }
```

## Procedure
1. Build plan before implementation.
2. Assign unique IDs to milestones/issues.
3. Declare dependencies for every issue (`depends_on`).
4. Execute by dependency order, then priority (`critical` → `high` → `medium` → `low`).
5. Run independent same-priority milestones in parallel when safe.
6. Update statuses continuously and append concise progress summaries.
7. If the plan is being materialized into HarnessOS, export it through `harness_orchestrator(action: "plan_issues")` using the canonical `milestones[]` payload.
8. Trigger the `github-sync` skill after creating/updating the plan or changing status to ensure perfect alignment with GitHub milestones/issues.

## Effort Sizing

Assign a T-shirt size to every issue to set expectations:

| Size | Scope | Typical duration |
|------|-------|-----------------|
| **S** | Single file, isolated change | < 30 min |
| **M** | 2–5 files, one component | 30 min – 2 h |
| **L** | Cross-component, multiple integrations | 2 – 8 h |
| **XL** | Architectural, multi-milestone | 8 h + (split recommended) |

If an issue is **XL**, split it into children before starting.

## Incremental Execution (Harness Pattern)

When following the `harness-lifecycle` skill, each issue becomes an **incremental unit of work**:

1. **Pick one** — select the highest-priority incomplete issue.
2. **Implement** — work on that single issue only.
3. **Test** — run the relevant test suite. The issue is done only if tests pass.
4. **Commit** — `git commit` with a descriptive message referencing the issue ID.
5. **Update** — mark the issue as `done`, update `progress.md` and `feature_list.json`.
6. **Repeat** — pick the next issue.

> **Rule**: never implement multiple issues simultaneously. Complete → test → commit → update → next.

## HarnessOS Canonical Mapping

When the plan is imported into HarnessOS, the queue payload must stay batch-first:

```json
{
  "action": "plan_issues",
  "projectId": "<project-id>",
  "campaignId": "<campaign-id>",
  "milestones": [
    {
      "milestone_key": "runtime-foundations",
      "description": "Ship the runtime foundations",
      "issues": [
        {
          "task": "Add the canonical planner",
          "priority": "high",
          "size": "M"
        },
        {
          "task": "Add regression coverage",
          "priority": "high",
          "size": "S",
          "depends_on_indices": [0]
        }
      ]
    },
    {
      "milestone_key": "capability-discovery",
      "description": "Expose agent-readable discoverability",
      "depends_on_milestone_keys": ["runtime-foundations"],
      "issues": [
        {
          "task": "Publish the capability catalog",
          "priority": "medium",
          "size": "M"
        }
      ]
    }
  ]
}
```

Rules:
- Always use `milestones[]`, even for a single milestone import.
- Use `depends_on_milestone_keys` for edges within the current batch.
- Use `depends_on_milestone_ids` only when a milestone depends on already imported work.
- Do not re-encode milestone hierarchy as fake issue dependencies.

## Concrete Template

```markdown
# Plan — <project/task name>

**PRD**: <one-line goal>
**Context**: <why this is being done now>

## M1 — <milestone description> (critical)

| Issue | Task | Priority | Size | Depends on | Status |
|-------|------|----------|------|------------|--------|
| M1-I1 | Set up project scaffold | critical | S | — | todo |
| M1-I2 | Implement core module | high | M | M1-I1 | todo |
| M1-I3 | Add unit tests for core | high | M | M1-I2 | todo |

## M2 — <milestone description> (high)

| Issue | Task | Priority | Size | Depends on | Status |
|-------|------|----------|------|------------|--------|
| M2-I1 | Build API endpoints | high | L | M1-I2 | todo |
| M2-I2 | Integration tests | medium | M | M2-I1 | todo |
```

## Done Criteria
- Plan exists, is up-to-date, and reflects actual execution state.
- Dependencies are respected and parallel work is safe.
- Every issue has a T-shirt size assigned.

## Anti-patterns
- Starting implementation without a plan
- Missing dependency declarations
- Running blocked items in parallel
- XL issues that should be split into children
- Flattening milestone dependencies into artificial issue edges to satisfy the queue importer
- Using the removed top-level `milestoneDescription` or `issues` planning payload
