---
name: harness-lifecycle
description: Two-phase agent harness lifecycle — initializer session for scaffolding and incremental sessions for feature-by-feature execution with cross-session memory.
---
<!-- workflow-instructions-version: 1.0.11 -->

# Harness Lifecycle

An **Agent Harness** is the infrastructure layer ("OS") that wraps around the AI model to govern long-running, multi-session tasks. This skill implements the two-phase harness pattern.

## Core Analogy

| Component | Role |
|-----------|------|
| Model | CPU — raw processing power |
| Context Window | RAM — limited, volatile working memory |
| **Harness** | **OS** — curates context, handles boot sequence, provides standard drivers |
| Agent | Application — specific user logic running on the OS |

## Phase 1 — Initializer Session

Run this phase **once**, at the very first context window of a new task or project.

### Steps

1. **Scan the environment** — `pwd`, read project config, understand the tech stack.
2. **Create or read `progress.md`** — the cross-session memory file (see template below).
3. **Generate `feature_list.json`** — expand the user's prompt into granular, testable features, all marked `"passes": false`.
4. **Create `init.sh`** — a script that boots the dev environment (installs deps, starts servers, etc.).
5. **Make an initial git commit** — `chore: harness init — scaffolding, progress, feature list`.
6. **Run a smoke test** — verify the environment is healthy end-to-end before handing off.

### Initializer Output Checklist

```
[ ] progress.md exists and contains session 0 entry
[ ] feature_list.json exists with all features marked passes: false
[ ] init.sh exists and runs successfully
[ ] Initial git commit made
[ ] Smoke test passed
```

## Phase 2 — Incremental Session

Run this phase on **every subsequent context window**.

### Steps

1. **Get bearings** — read `progress.md`, run `git log --oneline -20`.
2. **Boot environment** — run `init.sh` or equivalent.
3. **Smoke test** — run a quick e2e test to detect if the app is broken. If broken, fix first before adding features.
4. **Pick one feature** — select the highest-priority incomplete feature from `feature_list.json`.
5. **Implement** — work on that single feature only.
6. **Test** — run unit + e2e tests on the feature. A feature is only done if tests pass.
7. **Commit** — `git commit` with a descriptive message referencing the feature.
8. **Update progress** — append a session entry to `progress.md`.
9. **Update feature list** — mark the feature as `"passes": true` in `feature_list.json`.
10. **Clean state check** — the codebase must be in a mergeable state (no half-implemented features, no broken tests).

### Incremental Session Checklist

```
[ ] Read progress.md and git log
[ ] Environment booted via init.sh
[ ] Smoke test passed (or breakage fixed first)
[ ] Single feature selected
[ ] Feature implemented
[ ] Tests pass for the feature
[ ] Git commit with descriptive message
[ ] progress.md updated with Done / Next / Blockers
[ ] feature_list.json updated (passes: true)
[ ] Codebase in clean, mergeable state
```

## Cross-Session Memory: `progress.md`

This file is the harness's persistent memory across context windows. Every session reads it first and writes to it last.

### Template

```markdown
# Progress

## Project Overview
<!-- One-paragraph description of what we're building -->

## Current Status
<!-- Quick summary: what works, what's next, any blockers -->

---

## Session 0 — YYYY-MM-DD (Initializer)

### Done
- Scaffolded project structure
- Created feature_list.json with N features
- Created init.sh

### Next
- Begin implementing Feature #1: [description]

### Blockers
- None

---

## Session 1 — YYYY-MM-DD

### Done
- Implemented Feature #1: [description]
- All tests passing

### Next
- Feature #2: [description]

### Blockers
- None
```

## Feature List: `feature_list.json`

Granular, testable requirements. The agent may only change the `passes` field — never remove or edit feature descriptions.

### Template

```json
{
  "features": [
    {
      "id": 1,
      "category": "functional",
      "description": "User can create a new item and see it in the list",
      "priority": "high",
      "steps": [
        "Navigate to the main page",
        "Click the 'New' button",
        "Fill in the form",
        "Submit and verify the item appears in the list"
      ],
      "passes": false
    },
    {
      "id": 2,
      "category": "functional",
      "description": "User can delete an existing item",
      "priority": "high",
      "steps": [
        "Navigate to the list",
        "Click delete on an item",
        "Confirm deletion",
        "Verify item is removed"
      ],
      "passes": false
    }
  ]
}
```

> **Rule**: Use JSON for feature lists, not Markdown. Models are less likely to inappropriately edit or overwrite JSON files compared to Markdown.

## Init Script: `init.sh`

A single script that any session can run to bootstrap the dev environment.

### Template

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "=== Harness Init ==="

# Install dependencies
if [ -f "package.json" ]; then
  npm install
fi

# Start dev server in background
if [ -f "package.json" ]; then
  npm run dev &
  DEV_PID=$!
  echo "Dev server started (PID: $DEV_PID)"
  sleep 3
fi

echo "=== Environment Ready ==="
```

## Harness Principles

1. **One feature at a time** — never implement multiple features in a single session. Complete, test, commit, then move on.
2. **Clean handoff** — every session must leave a mergeable codebase. No half-finished work.
3. **Test before marking done** — a feature is `passes: true` only if a real test execution confirms it.
4. **Progress is the source of truth** — `progress.md` is the first thing to read and the last thing to update.
5. **Build to delete** — keep the harness lightweight. New models will replace your logic. Be ready to rip out code.
6. **Start simple** — provide robust atomic tools, let the model make the plan. Add guardrails, retries, and verifications.

## Integration with Other Skills

| Skill | Harness Role |
|-------|-------------|
| `planning-tracking` | Generates the initial feature list (Phase 1) |
| `session-logging` | Writes the session entries in `progress.md` |
| `completion-gate` | Validates each feature before `passes: true` |
| `git-workflow` | Commit conventions for incremental progress |
| `testing-policy` | Defines what "tests pass" means |
| `context-management` | Compaction strategy within long sessions |
| `rollback-rca` | Recovery when smoke test fails |

## References

- [Phil Schmid — The importance of Agent Harness in 2026](https://www.philschmid.de/agent-harness-2026)
- [Anthropic — Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [Parallel.ai — What is an agent harness?](https://parallel.ai/articles/what-is-an-agent-harness)
