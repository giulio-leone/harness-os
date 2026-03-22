# AGENTS.MD — Consumer Workspace Template

> Principle: this file defines the harness/operator boundary for a new consumer workspace.
> It intentionally excludes personal assets, live proof artifacts, and machine-specific repository wiring.

---

## 1. Interaction protocol

- Keep user interaction in `ask_user`.
- Each iteration must expose exactly 5 options:
  - 1-3 structured choices
  - 4 `Freeform`
  - 5 `Autonomous Mode`

---

## 2. Canonical state boundary

- SQLite is the primary source of truth.
- mem0 or any semantic memory layer is support-only.
- Domain logic executes the issue currently leased through `session-lifecycle`.
- Every meaningful state change must create or update a checkpoint.

---

## 3. Harness work hierarchy

Use the harness hierarchy exactly like this:

- **Project** → long-lived workspace and canonical SQLite namespace
- **Mission / campaign** → medium-lived workstream
- **Daily task / issue** → one queue item claimed through `session-lifecycle`
- **Session / run + lease** → the lease-scoped execution window for exactly one issue
- **Checkpoint** → evidence captured on claim, block, status change, and close

---

## 4. Files you customize first

- `CONTEXT.MD`
- `JOBS.MD`
- `NETWORK.MD`
- `resume.md`
- `cover-letter.md`
- `.harness/fixtures/template.prompt.txt`
- `.harness/prompt-workflow-bindings.json`
- `.harness/schemas/domain-schema.json`
- `.harness/mission-workflows/workflow.json`
- `.harness/live-mission-catalog.json`

Local Copilot CLI skills for this template are published under:

- `.github/skills/session-lifecycle/SKILL.md`
- `.github/skills/prompt-contract-bindings/SKILL.md`

---

## 5. Bootstrap flow

Agents can now autonomously bootstrap workspaces and campaigns without executing raw bash scripts or SQL queries.

1. **Initialize Workspace:** Call the `harness_init_workspace` MCP tool to create the `harness.db` and inject the workspace record.
2. **Create Campaign:** Call the `harness_create_campaign` MCP tool to create the target project and campaign.
3. **Plan Issues:** Call the `harness_plan_issues` MCP tool with the generated plan and dependencies to populate the `pending` queue.
4. **Execution Loop:** Call `begin_incremental_session` via MCP to pick up the first issue in the queue.
5. (Legacy Fallback): You can still run `bash init.sh` and python scripts if a manual override is needed.

---

## 6. Engine routing

- Use the browser engine for discovery, extraction, and browser-first execution.
- Use the mobile engine only when native app interaction is the better surface.
- Keep the chosen surface aligned with the real task being executed.

---

## 7. Template boundary

- Do not store live runtime snapshots or personal artifacts in this template.
- Treat this directory as a starting point; create proof artifacts only in the copied consumer workspace.
- Keep SQLite canonical and let mem0 remain a derived recall layer.
