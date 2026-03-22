# agent-harness-core

Reusable long-running agent harness core.

This repository now focuses on the harness core itself:
- Zod plan contract
- session contracts
- skill-policy registry
- SQLite schema and state-layer placeholders
- session orchestration and inspection

The extracted source-of-truth repositories now live alongside this repo:

- `../mcp-hot-reload` for adaptive JSON-RPC stdio transport plus generic MCP hot reload
- `../mem0-mcp` for the dedicated `mem0` MCP server, file-backed adapter, schemas, and Ollama embeddings

`agent-harness-core` consumes those packages as local dependencies instead of keeping duplicate implementations.

### Environment

When the session lifecycle CLI/MCP surfaces are configured with `mem0`, they still honor:

- `MEM0_STORE_PATH` (default: `~/.copilot/mem0`)
- `OLLAMA_BASE_URL` (default: `http://127.0.0.1:11434`)
- `MEM0_EMBED_MODEL` (default: `qwen3-embedding:latest`)

### Commands

- `npm run build && npm run scheduler:daemon`
- `npm run build && npm run session:lifecycle`
- `npm run build && npm run session:lifecycle:mcp`

### Session lifecycle MCP planning tools

`session-lifecycle-mcp` now exposes additional harness-planning tools for local workspace bootstrapping:

- `harness_init_workspace`
- `harness_create_campaign`
- `harness_plan_issues`
- `harness_rollback_issue`

These helpers now run with transactional writes so partial lifecycle mutations are rolled back on failure.

### Scheduler injector

`src/bin/scheduler-daemon.ts` is a cron-aware, idempotent injector for scheduled harness work. It reads:

- `HARNESS_DB_PATH`
- `HARNESS_CRON_PATH`

Each run evaluates standard 5-field cron expressions, injects only due jobs, and records per-minute injections so repeated invocations do not duplicate the same scheduled task.

## Session lifecycle bridge

The repository now also includes a first runnable session bridge for the `session-lifecycle` contract:
- `src/runtime/session-orchestrator.ts`
- `src/runtime/mem0-session-bridge.ts`
- `src/runtime/session-lifecycle-adapter.ts`
- `src/bin/session-lifecycle.ts`
- `src/db/lease-manager.ts`
- `src/db/checkpoint-writer.ts`

What the first bridge does:
- claims or resumes a task-scoped lease from SQLite
- runs reconciliation before every new claim and promotes stale work to `needs_recovery`
- provides an explicit `beginRecoverySession()` path that replaces stale leases with a fresh recovery lease
- writes canonical checkpoints into SQLite plus structured checkpoint payload events
- promotes eligible `pending` issues to `ready` when dependency chains are satisfied
- reads mem0 context on begin or recovery at task scope
- writes derived mem0 summaries only on significant checkpoints or close
- links stored mem0 records back to SQLite through `memory_links`

The public runtime flow is:
1. `beginIncrementalSession()`
2. `beginRecoverySession()` when a task is explicitly resolved from `needs_recovery`
3. `checkpoint()`
4. `close()`

### Thin runtime adapter and CLI

The same lifecycle core is now exposed through:
- `SessionLifecycleAdapter` for in-process host integration
- `src/bin/session-lifecycle.ts` for JSON-driven CLI execution

The CLI accepts a JSON command on stdin (or via `--input <path>`) with one of these actions:
- `begin_incremental`
- `begin_recovery`
- `checkpoint`
- `close`
- `inspect_overview`
- `inspect_issue`
- `promote_queue`

Commands:
- `npm run session:lifecycle:dev`
- `npm run build && npm run session:lifecycle`
- `npm test`

Example fixtures live under `examples/session-lifecycle/`:
- `begin-incremental.json`
- `begin-recovery.json`
- `checkpoint.json`
- `close.json`
- `inspect-overview.json`
- `inspect-issue.json`
- `promote-queue.json`
- `consumer-workspace-template/` for a portable consumer bootstrap that can be copied outside the repo and re-pointed with `HARNESS_CORE`

Example usage:
- `npm run build && npm run session:lifecycle < examples/session-lifecycle/inspect-overview.json`
- `npm run build && npm run session:lifecycle < examples/session-lifecycle/promote-queue.json`
- `npm run build && npm run session:lifecycle:mcp`

The intended boundary stays unchanged:
- SQLite is canonical for task, lease, checkpoint, and event state
- mem0 remains derived support memory only
- project skills should not write canonical state directly

## Repo-native skill sources

This repository now also publishes repo-native skill sources under `.github/skills/`:
- `session-lifecycle` for the verified operational lease/checkpoint/inspection/promotion protocol
- `prompt-contract-bindings` for the reusable local-prompt/global-harness publication pattern

There is no dedicated skill reload mechanism in this repository. Global availability comes from validating the files on disk and syncing the approved copies into `~/.copilot/skills` according to `~/.copilot/SYNC_MANIFEST.yaml`.


### Proving global skill reuse

Run the deterministic consumer proof with explicit paths:

```bash
python3 examples/skill-reuse/prove-global-skill-reuse.py \
  --runtime-skills ~/.copilot/skills \
  --consumer-workspace /absolute/path/to/consumer-workspace \
  --output /absolute/path/to/consumer-workspace/.harness/runtime/global-skill-reuse-proof.json
```

This validates repo-native skill source parity, runtime mirror parity, the updated `SYNC_MANIFEST` routing, and a real consumer `init.sh` bootstrap without claiming any skill reload mechanism.

## Consumer workspace bootstrap template

A reusable consumer bootstrap now lives under `examples/consumer-workspace-template/`.

It packages the portable workspace shell that was previously only proven in a live consumer workspace:
- `init.sh`, `AGENTS.MD`, `harness-project.json`, `progress.md`, and `feature_list.json`
- generic prompt/schema/workflow placeholders under `.harness/`
- a template live catalog plus preview-first wrappers for dry-run, live claim, and queue promotion

It intentionally does **not** include personal assets, live runtime snapshots, or smoke proof artifacts. Copy the directory into a new workspace, set `HARNESS_CORE=/absolute/path/to/agent-harness-core` if needed, customize the template files, and then run:

```bash
bash init.sh
python3 .harness/seed-live-catalog.py --reset
bash .harness/run-live-dry-run.sh
bash .harness/run-live-claim.sh
```


## License

This project is licensed under the **Business Source License 1.1 (BSL)**.

**You may use this software for non-commercial and non-production purposes (e.g., development, testing, research, and personal projects) free of charge.**

**Commercial and production use is strictly prohibited without prior written authorization.**

On March 22, 2030 (the Change Date), this license automatically converts to the **Apache License, Version 2.0**.
