# Getting Started

Welcome to **HarnessOS** — the operating system for autonomous AI agents. This guide will walk you through setting up the runtime and executing your first agentic task flow.

## Prerequisites

- Node.js 22 or higher
- Git
- SQLite (built into the core process)
- *Optional:* A local instance of Ollama running `qwen3-embedding:latest` if using `mem0-mcp` for semantic extraction.

## 1. Local Setup

```bash
npm install -g harness-os mem0-mcp
```

## 2. Register Your Hosts

HarnessOS can register its lifecycle MCP server directly into Codex, Copilot CLI, and antigravity:

```bash
harness-install-mcp --host codex --host copilot --host antigravity

# Or bind hosts to the workload profile they actually run
harness-install-mcp --host copilot --workload-profile research
harness-install-mcp --host codex --workload-profile ops
harness-install-mcp --host antigravity --workload-profile assistant
```

This creates the canonical runtime paths under `~/.agent-harness/` and updates the host MCP configs in place. Use `--dry-run` first if you want to inspect the changes before writing.

### 2.1 Recommended path — MCP installation

- Use `harness-install-mcp` when you want the lifecycle server registered directly into Codex, Copilot CLI, or antigravity.
- Use `harness_inspector(action: "capabilities")` immediately after install when you want a machine-readable view of available tools, workload profiles, bundled skills, and mem0 status.
- Use [mcp-tools.md](mcp-tools.md) when you need the authoritative action reference for the six Harness MCP tools.
- Use [cli-reference.md](cli-reference.md) when you need the full command-level reference for the installable CLIs.

You can still sync bundled skills to extra workspaces such as `~/.gemini`, `~/.cursor`, or `~/.copilot`:

```bash
harness-setup
harness-sync
```

If you are upgrading from the legacy flat host config, rerun `harness-setup` once to rewrite `~/.agent-harness/config.json` to the versioned sync schema before running `harness-sync`. The sync flow now writes `skills/bundle-manifest.json` to every host and explicitly replaces outdated or drifted bundled skill assets.

### 2.2 Manual host setup and sync

- Use `harness-setup` when you need the interactive host/workspace manager.
- Use `harness-sync` after changing workload profile selection or when you need to replace drifted bundled skills in a registered host.
- The package version remains on the public `2.x` line; workload profile versions, schema versions, and session-lifecycle contract versions are documented separately per surface.

## 3. Bootstrapping a Workspace

If you want to develop HarnessOS itself locally:

```bash
git clone https://github.com/giulio-leone/harness-os.git
cd harness-os
npm install
npm run build
```

## 4. Bootstrapping a Reference Workspace

HarnessOS ships concrete reference workspaces for the main non-coding flows plus the full-surface assistant path:

| Profile | Template | Suggested copy target |
| --- | --- | --- |
| `assistant` | `examples/consumer-workspace-template/` | `../my-assistant-workspace` |
| `research` | `examples/research-workspace-template/` | `../my-research-workspace` |
| `ops` | `examples/ops-workspace-template/` | `../my-ops-workspace` |
| `support` | `examples/support-workspace-template/` | `../my-support-workspace` |

Example:

```bash
cp -r examples/support-workspace-template/ ../my-support-workspace
cd ../my-support-workspace

export HARNESS_CORE=$(pwd)/../agent-harness-core
bash init.sh
python3 .harness/seed-live-catalog.py --reset
```

Each template includes a reference mission catalog, workload-specific handoff assets, and example workflow metadata (`deadlineAt`, `recipients`, `approvals`, `externalRefs`) so the first queue already looks like a real operational flow instead of a coding-only scaffold.

For a profile-by-profile guide, see [workload-profiles.md](workload-profiles.md).
For the matching bundled skill index, see [../.github/skills/README.md](../.github/skills/README.md).

## 5. Planning and Queuing Issues

Use the session-lifecycle CLI to inject tasks and manage the queue:

```bash
cd ../agent-harness-core

# Promote due queue items that have met dependency constraints
npm run session:lifecycle < examples/session-lifecycle/promote-queue.json

# Export the current project queue and observability state
npm run session:lifecycle < examples/session-lifecycle/inspect-export.json
```

When you ask the MCP inspector for `next_action`, the recommendation now includes a structured `context` block that identifies the exact blocker, dependency, lease, or policy escalation behind the answer:

```json
{
  "action": "call_tool",
  "tool": "harness_inspector",
  "reason": "Task \"Wait for the dependency\" (issue-blocked, priority: high) is waiting on issue issue-dependency.",
  "suggestedPayload": {
    "action": "audit",
    "issueId": "issue-blocked"
  },
  "context": {
    "stage": "blocked_issue",
    "priority": 4,
    "issue": {
      "id": "issue-blocked",
      "status": "pending",
      "blockedReason": "issue_dependency:issue-dependency"
    },
    "blocker": {
      "kind": "issue_dependency",
      "refId": "issue-dependency",
      "refType": "issue"
    },
    "blockingIssue": {
      "id": "issue-dependency",
      "status": "in_progress"
    }
  }
}
```

Operational policy is now split cleanly from workflow metadata at the queue boundary: `create_campaign` accepts an optional `policy` object with `owner`, `serviceLevel`, `escalationRules`, and `dispatch`, while `plan_issues` and scheduler jobs accept first-class work-item fields like `deadlineAt`, `recipients`, `approvals`, and `externalRefs`. Campaign policy acts as the default, issue policy acts as the override, and inspector surfaces expose the effective merged policy plus the canonical issue deadline that dispatch uses.

If you need a concise “which tool do I call next?” guide instead of raw examples, start with:

1. [mcp-tools.md](mcp-tools.md) for the MCP surface
2. [cli-reference.md](cli-reference.md) for installable commands
3. [workload-profiles.md](workload-profiles.md) for workload-specific setup

## 6. Fully Agentic Symphony Flow

Use the Symphony flow when a project already has a campaign scope and you want ready issues to run without human runtime checkpoints. The runtime assigns work; the host executes it. `runOrchestrationSupervisorTick()` provides the deterministic single-tick runtime, while `runOrchestrationSupervisor()`, `harness-supervisor`, and `harness_symphony(action: "supervisor_run")` provide bounded autonomous polling with max tick limits, stop conditions, and backoff. Dry-runs inspect and plan without mutation; execute mode requires canonical `workspaceId`, `projectId`, and host execution inputs before promotion or dispatch.

The stabilized MCP sequence is:

1. Discover support with `harness_inspector(action: "capabilities")` and read `orchestration.requiredDispatchFields`.
2. Create or reuse a workspace/campaign with `harness_orchestrator(action: "init_workspace")` and `harness_orchestrator(action: "create_campaign")`.
3. Convert tracker-style milestones and slices with `harness_symphony(action: "compile_plan")`.
4. Send the returned `planIssuesPayload.milestones` to `harness_orchestrator(action: "plan_issues")`.
5. Fan out ready work with `harness-supervisor` or `harness_symphony(action: "supervisor_run")` for bounded autonomous polling, or directly with `harness_symphony(action: "dispatch_ready")` when a host wants to manage inspect/promote/dispatch steps itself. Use `repoRoot`, `worktreeRoot`, `baseRef`, `host`, `hostCapabilities`, and up to four compatible `gpt-5-high` subagents.
6. In the host runtime, create the physical git worktrees, launch the assigned subagents, run the deterministic gates, capture screenshots/E2E reports, and save evidence with `harness_artifacts(action: "save")`.
7. Inspect health with `harness_symphony(action: "inspect_state")` or retrieve the UI/agent read model with `harness_symphony(action: "dashboard_view")` before closing the worker sessions.

Reference payloads for that sequence live under [`../examples/orchestration-symphony/`](../examples/orchestration-symphony/). Each JSON file uses this shape:

```json
{
  "tool": "harness_symphony",
  "input": {
    "action": "dispatch_ready"
  }
}
```

Pass the `input` object to the named MCP `tool`. Replace placeholder workspace and campaign ids with the values returned by `init_workspace` and `create_campaign`, use the supervisor examples for no-human inspect/promote/dispatch control, then replace placeholder issue ids in the direct dispatch and assignment evidence examples with the ids returned by `plan_issues` or by `harness_inspector(action: "export")`.

<!-- GENERATED:GETTING-STARTED-EXAMPLES:START -->
Generated from the canonical public contract model:

| File | CLI action | Purpose |
| --- | --- | --- |
| [`begin-incremental.json`](../examples/session-lifecycle/begin-incremental.json) | `begin_incremental` | Claim or resume the next ready issue from the standard CLI. |
| [`begin-recovery.json`](../examples/session-lifecycle/begin-recovery.json) | `begin_recovery` | Recover a stale task by superseding the old lease with a recovery session. |
| [`checkpoint.json`](../examples/session-lifecycle/checkpoint.json) | `checkpoint` | Persist incremental progress and optional artifacts during an active session. |
| [`close.json`](../examples/session-lifecycle/close.json) | `close` | Close the current task after the final validation gate. |
| [`inspect-export.json`](../examples/session-lifecycle/inspect-export.json) | `inspect_export` | Export machine-readable queue, lease, run, policy, checkpoint, and recent-event state for a project. |
| [`inspect-audit.json`](../examples/session-lifecycle/inspect-audit.json) | `inspect_audit` | Inspect the structured audit trail for one specific issue. |
| [`inspect-health-snapshot.json`](../examples/session-lifecycle/inspect-health-snapshot.json) | `inspect_health_snapshot` | Capture a machine-readable operational health snapshot for a project. |
| [`promote-queue.json`](../examples/session-lifecycle/promote-queue.json) | `promote_queue` | Promote pending work whose dependencies are now satisfied. |

Every session-lifecycle payload must declare `"contractVersion": "6.0.0"`.

Run any example with `npm run session:lifecycle < examples/session-lifecycle/<file>`.
<!-- GENERATED:GETTING-STARTED-EXAMPLES:END -->

## 7. Run the Scheduler Injector

Once tasks are queued and promoted to `ready`, run the scheduler injector:

```bash
harness-scheduler-inject
```

## Next Steps

Review the [Architecture](architecture.md) documentation to understand how HarnessOS orchestrates canonical state, leases, and multi-host integration.
