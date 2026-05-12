# CLI Reference

HarnessOS ships seven installable commands. They all live under the public `2.x` package line, while schema/contract versions are documented separately inside the runtime and examples.

## Command summary

| Command | Purpose | Typical first use |
| --- | --- | --- |
| `harness-install-mcp` | register the lifecycle MCP server into Codex, Copilot CLI, or antigravity | first-time host installation |
| `harness-setup` | interactive host/workspace registration and workload-profile selection | manual host management |
| `harness-sync` | copy the bundled skill set into registered hosts and prune drift | after changing workload profile or bundled skills |
| `harness-scheduler-inject` | run the cron-aware scheduler injector | background/scheduled runtime execution |
| `harness-session-lifecycle` | drive the session-lifecycle contract from JSON payloads on stdin | CLI integration and automation |
| `harness-session-lifecycle-mcp` | run the session-lifecycle MCP server over stdio | editor/agent integration |
| `harness-supervisor` | run one supervisor tick or a bounded autonomous polling run from structured JSON | fully agentic no-human orchestration loops |

## `harness-install-mcp`

Recommended installation path for Codex, Copilot CLI, and antigravity.

Common options:

| Flag | Purpose |
| --- | --- |
| `--host <codex|copilot|antigravity>` | install for one host; repeatable |
| `--workload-profile <id>` | set the host workload profile (`coding`, `research`, `ops`, `sales`, `support`, `assistant`) |
| `--db-path <path>` | override `HARNESS_DB_PATH` |
| `--mem0-store-path <path>` | override `MEM0_STORE_PATH` |
| `--mem0-module-path <path>` | override `AGENT_HARNESS_MEM0_MODULE_PATH` |
| `--ollama-base-url <url>` | override `OLLAMA_BASE_URL` |
| `--mem0-embed-model <name>` | override `MEM0_EMBED_MODEL` |
| `--dry-run` | preview changes without writing |

Examples:

```bash
harness-install-mcp --host copilot --workload-profile assistant
harness-install-mcp --host codex --host copilot --dry-run
```

## `harness-setup`

Interactive host/workspace manager. Use it when you want to add/remove hosts or change workload profile selection without editing config files directly.

Interactive options:

1. add a new workspace/host
2. change workload profile for a host
3. remove a host
4. exit and save

Use this when you manage `~/.gemini`, `~/.cursor`, `~/.copilot`, or similar workspaces and want `harness-sync` to treat them as registered targets.

## `harness-sync`

Copies the bundled skill set into every registered host and prunes drift in the same pass.

Use it:

- after changing a host workload profile in `harness-setup`
- after updating bundled skills in the repository
- after a version upgrade when you want the host copy to match the packaged manifest

## `harness-scheduler-inject`

Runs the cron-aware scheduler injector. Use it when scheduled work should be materialized into the canonical queue.

```bash
harness-scheduler-inject
```

## `harness-session-lifecycle`

Runs the public session-lifecycle contract from JSON payloads on stdin.

Examples:

```bash
harness-session-lifecycle < examples/session-lifecycle/begin-incremental.json
harness-session-lifecycle < examples/session-lifecycle/inspect-export.json
```

Use the files under [`examples/session-lifecycle/`](../examples/session-lifecycle/) as the authoritative payload examples.

## `harness-session-lifecycle-mcp`

Runs the MCP server over stdio for tool-based agent hosts.

```bash
harness-session-lifecycle-mcp
```

Use `harness-install-mcp` when you want this wired into a supported host automatically instead of launching it manually.

## `harness-supervisor`

Runs the autonomous Symphony supervisor from JSON on stdin or `--input <path>`. The payload is intentionally small:

```json
{
  "action": "run",
  "input": {
    "contractVersion": "1.0.0",
    "runId": "supervisor-run-1",
    "dbPath": ".harness/harness.sqlite",
    "projectId": "project-1",
    "mode": "dry_run",
    "stopCondition": {
      "maxTicks": 4,
      "stopWhenIdle": true,
      "stopWhenBlocked": true
    }
  }
}
```

Use `action: "tick"` with a `tickId` for one deterministic tick, or `action: "run"` with a `runId` and `stopCondition.maxTicks` for bounded polling. `execute` mode also requires canonical `workspaceId`, `projectId`, and `dispatch` host/worktree routing inputs.

Execute-mode supervisor payloads are the CLI form of the no-human runtime path. The supervisor owns inspection, queue promotion, and dispatch; the host still owns physical worktree creation, subagent launch, gate commands, screenshot capture, artifact file creation, and cleanup.

```json
{
  "action": "run",
  "input": {
    "contractVersion": "1.0.0",
    "runId": "supervisor-run-1",
    "dbPath": ".harness/harness.sqlite",
    "workspaceId": "workspace-1",
    "projectId": "project-1",
    "mode": "execute",
    "requiredEvidenceArtifactKinds": [
      "typecheck_report",
      "state_export",
      "csqr_lite_scorecard",
      "test_report",
      "e2e_report",
      "screenshot"
    ],
    "stopCondition": {
      "maxTicks": 2,
      "stopWhenIdle": true,
      "stopWhenBlocked": true
    },
    "dispatch": {
      "repoRoot": "/repo/harness-os",
      "worktreeRoot": "/repo/worktrees",
      "baseRef": "main",
      "host": "copilot",
      "hostCapabilities": {
        "workloadClasses": ["default", "typescript"],
        "capabilities": ["node", "sqlite"]
      },
      "maxConcurrentAgents": 4
    }
  }
}
```

## Related references

- Use [mcp-tools.md](mcp-tools.md) for the action-level reference of the six MCP tools.
- Use [workload-profiles.md](workload-profiles.md) when you need to choose the right host specialization before install/sync.
- Use [../.github/skills/README.md](../.github/skills/README.md) when you need the bundled skill index that sits on top of these commands.
