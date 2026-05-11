# MCP Tool Reference

HarnessOS exposes six MCP tools. The canonical discovery entrypoint is always:

```json
{ "action": "capabilities" }
```

called through `harness_inspector`.

## Recommended call order

1. `harness_inspector(action: "capabilities")` — discover tools, workload profiles, bundled skills, and mem0 state
2. `harness_inspector(action: "get_context")` — understand workspace/project/queue scope
3. `harness_orchestrator(...)` — create scope or inject planned work
4. `harness_symphony(action: "dispatch_ready")` — fan out ready work across isolated worktrees and compatible subagents
5. `harness_session(action: "begin" | "begin_recovery")` — claim one worker task when not using fan-out
6. `harness_session(action: "checkpoint")` — persist progress
7. `harness_session(action: "close" | "advance")` — complete the task
8. `harness_artifacts(...)` / `harness_admin(...)` — persist evidence or do maintenance

## Tool summary

| Tool | Use it for | Main actions |
| --- | --- | --- |
| `harness_inspector` | read-only discovery and operational visibility | `capabilities`, `get_context`, `next_action`, `export`, `audit`, `health_snapshot` |
| `harness_orchestrator` | creating scope, injecting plans, promoting or resetting work | `init_workspace`, `create_campaign`, `plan_issues`, `promote_queue`, `rollback_issue` |
| `harness_symphony` | fully agentic orchestration planning, fan-out dispatch, and state inspection | `compile_plan`, `dispatch_ready`, `inspect_state` |
| `harness_session` | claim/recovery, checkpoints, close/advance, heartbeats | `begin`, `begin_recovery`, `checkpoint`, `close`, `advance`, `heartbeat` |
| `harness_artifacts` | register or list durable task evidence | `save`, `list` |
| `harness_admin` | maintenance, cleanup, drain/archive, memory snapshots | `reconcile`, `drain`, `archive`, `cleanup`, `mem0_snapshot`, `mem0_rollup` |

## Symphony capability discovery

`harness_inspector(action: "capabilities")` returns a top-level `orchestration` block so hosts can detect fully agentic Symphony support without hardcoding tool names or action lists. The block declares:

- `mode: "symphony"` and `tool: "harness_symphony"`
- `actions.compilePlan`, `actions.dispatchReady`, and `actions.inspectState`
- `defaultModelProfile: "gpt-5-high"` and `defaultMaxConcurrentAgents: 4`
- `requiredDispatchFields` for `dispatch_ready`
- `hostResponsibilities` for creating/running/cleaning isolated worktrees and collecting gate evidence
- `worktreeIsolation` conflict guards, `evidence.acceptedArtifactKinds`, and `evidence.runtimeMetadataArtifactKinds`

The same response includes `suggestedBootstrap` entries for `harness_symphony(action: "inspect_state")` and `harness_symphony(action: "dispatch_ready")`, including the dispatch fields an MCP host must supply.

## `harness_inspector`

Start here when the runtime state is unclear.

| Action | Use when |
| --- | --- |
| `capabilities` | first call in a new host/session; discover the runtime surface |
| `get_context` | you need workspace/project/queue context before acting |
| `next_action` | you want the runtime to recommend the next safe tool call for a specific `host` + `hostCapabilities` routing context |
| `export` | you need a machine-readable operational snapshot |
| `audit` | you need the evidence trail for one issue |
| `health_snapshot` | you need a point-in-time health summary |

Example:

```json
{
  "action": "capabilities"
}
```

Host-aware recommendation example:

```json
{
  "action": "next_action",
  "projectName": "HarnessOS",
  "host": "copilot-local",
  "hostCapabilities": {
    "workloadClasses": ["default", "typescript"],
    "capabilities": ["node", "sqlite"]
  }
}
```

## `harness_orchestrator`

Use this tool to shape or repair queue state.

| Action | Use when |
| --- | --- |
| `init_workspace` | the runtime has no canonical workspace yet |
| `create_campaign` | you need a project/campaign scope |
| `plan_issues` | you need to inject a canonical `milestones[]` batch |
| `promote_queue` | you want to promote newly unblocked work |
| `rollback_issue` | you need an emergency reset for one stuck/failed issue |

Example:

```json
{
  "action": "plan_issues",
  "projectName": "HarnessOS",
  "campaignName": "Runtime hardening",
  "milestones": [
    {
      "milestone_key": "runtime-foundations",
      "description": "Example milestone",
      "issues": [
        {
          "task": "Add capability introspection",
          "priority": "high",
          "size": "M"
        }
      ]
    }
  ]
}
```

## `harness_symphony`

Use this tool for fully agentic Symphony-style orchestration after the project/campaign scope exists.

| Action | Use when |
| --- | --- |
| `compile_plan` | you need to compile orchestration milestones/slices into a canonical `plan_issues` payload |
| `dispatch_ready` | ready issues should be assigned to isolated worktrees and compatible subagents |
| `inspect_state` | you need orchestration leases, artifacts, evidence references, recent events, and health flags |

Discovery prerequisite: call `harness_inspector(action: "capabilities")` and read the returned `orchestration.requiredDispatchFields` before invoking `dispatch_ready`. The MCP server records deterministic worktree assignments and runtime metadata artifacts; the host remains responsible for creating the physical git worktrees, launching compatible subagents, running quality gates, attaching accepted evidence artifacts, and cleaning up worktrees.

Reference evidence matrix: fully agentic hosts should attach at least run-scoped `typecheck_report` and `state_export` artifacts plus assignment-scoped `test_report`, `e2e_report`, and `screenshot` artifacts for every dispatched assignment. HarnessOS includes deterministic reference packet assertions for this matrix, while command execution and screenshot capture stay host-owned.

Reference example set: [`../examples/orchestration-symphony/`](../examples/orchestration-symphony/) contains parse-tested MCP payloads for capability discovery, workspace/campaign setup, `compile_plan`, compiled `plan_issues`, four-agent `dispatch_ready`, evidence artifact registration, and post-dispatch inspection. Each file wraps the actual MCP input as `{ "tool": "<name>", "input": { ... } }`; send only `input` to the named tool.

Dispatch example:

```json
{
  "action": "dispatch_ready",
  "projectName": "HarnessOS",
  "repoRoot": "/repo/harness-os",
  "worktreeRoot": "/repo/worktrees",
  "baseRef": "main",
  "host": "copilot",
  "hostCapabilities": {
    "workloadClasses": ["default", "typescript"],
    "capabilities": ["node", "sqlite"]
  },
  "maxConcurrentAgents": 4,
  "maxAssignments": 4
}
```

Evidence save example:

```json
{
  "action": "save",
  "projectName": "HarnessOS",
  "campaignId": "C-REPLACE-WITH-CREATE-CAMPAIGN-OUTPUT",
  "kind": "screenshot",
  "path": ".harness/evidence/symphony-reference/assignment-dispatch/screenshot.png",
  "metadata": {
    "evidencePacketId": "reference-orchestration-e2e-packet",
    "evidenceArtifactId": "assignment-dispatch-screenshot",
    "assignmentId": "assignment-dispatch",
    "scope": "assignment"
  }
}
```

## `harness_session`

Use this tool for the live execution lifecycle.

| Action | Use when |
| --- | --- |
| `begin` | claim or resume the next ready issue |
| `begin_recovery` | explicitly take over a `needs_recovery` issue |
| `checkpoint` | save progress, status, artifacts, or mem0 summaries |
| `close` | mark the issue done/failed and release the lease |
| `advance` | close the current issue and atomically claim the next ready one |
| `heartbeat` | extend lease freshness during long-running work |

Example:

```json
{
  "action": "begin",
  "projectName": "HarnessOS"
}
```

## `harness_artifacts`

Use this tool when the task produced durable evidence worth registering.

| Action | Use when |
| --- | --- |
| `save` | register a file path as canonical task evidence |
| `list` | find artifacts already attached to a project/campaign/issue |

## `harness_admin`

Use this tool for maintenance, not for normal task execution.

| Action | Use when |
| --- | --- |
| `reconcile` | stale leases/checkpoints may need forced reconciliation |
| `drain` | pause new claims for a campaign |
| `archive` | close out completed campaign state |
| `cleanup` | remove expired historical rows according to retention |
| `mem0_snapshot` | persist a project or campaign memory summary |
| `mem0_rollup` | compact detailed task memories into a higher-level summary |

## Which reference should I read next?

- Use [cli-reference.md](cli-reference.md) if you need the installable CLI commands instead of the MCP surface.
- Use [workload-profiles.md](workload-profiles.md) if you need to pick the right host profile before calling tools.
- Use [../.github/skills/README.md](../.github/skills/README.md) if you need the bundled prompt/skill layer that sits on top of the MCP runtime.
