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

You can still sync bundled skills to extra workspaces such as `~/.gemini`, `~/.cursor`, or `~/.copilot`:

```bash
harness-setup
harness-sync
```

If you are upgrading from the legacy flat host config, rerun `harness-setup` once to rewrite `~/.agent-harness/config.json` to the versioned sync schema before running `harness-sync`. The sync flow now writes `skills/bundle-manifest.json` to every host and explicitly replaces outdated or drifted bundled skill assets.

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

## 6. Run the Scheduler Injector

Once tasks are queued and promoted to `ready`, run the scheduler injector:

```bash
harness-scheduler-inject
```

## Next Steps

Review the [Architecture](architecture.md) documentation to understand how HarnessOS orchestrates canonical state, leases, and multi-host integration.
