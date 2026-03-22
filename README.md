# agent-harness-core

Reusable long-running agent harness core.

This repository starts with Slice A (Contracts & State):
- Zod plan contract
- session contracts
- mem0 adapter interface
- skill-policy registry
- SQLite schema and state-layer placeholders

## Runnable `mem0-mcp` scaffold

This repository now hosts a first runnable `mem0-mcp` server scaffold under `src/bin/mem0-mcp.ts`.

The initial tool surface is intentionally small:
- `health`
- `memory_store`
- `memory_recall`
- `memory_search`

`memory_store` is already aligned with the harness contract:
- canonical scope object with `workspace`, `project`, and optional `campaign`, `task`, `run`
- required provenance back to SQLite via `checkpointId`
- optional `artifactIds` and provenance note

The first persistence layer is local and explicit:
- JSONL store under `MEM0_STORE_PATH`
- Ollama embeddings for semantic search
- no independent canonical state: SQLite remains authoritative

### Environment

- `MEM0_STORE_PATH` (default: `~/.copilot/mem0`)
- `OLLAMA_BASE_URL` (default: `http://127.0.0.1:11434`)
- `MEM0_EMBED_MODEL` (default: `qwen3-embedding:latest`)

### Commands

- `npm run mem0:mcp:dev`
- `npm run build && npm run mem0:mcp`

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

Example usage:
- `npm run build && npm run session:lifecycle < examples/session-lifecycle/inspect-overview.json`
- `npm run build && npm run session:lifecycle:mcp`

The intended boundary stays unchanged:
- SQLite is canonical for task, lease, checkpoint, and event state
- mem0 remains derived support memory only
- project skills should not write canonical state directly
