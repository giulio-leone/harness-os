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
```

This creates the canonical runtime paths under `~/.agent-harness/` and updates the host MCP configs in place. Use `--dry-run` first if you want to inspect the changes before writing.

You can still sync bundled skills to extra workspaces such as `~/.gemini`, `~/.cursor`, or `~/.copilot`:

```bash
harness-setup
harness-sync
```

## 3. Bootstrapping a Workspace

If you want to develop HarnessOS itself locally:

```bash
git clone https://github.com/giulio-leone/harness-os.git
cd harness-os
npm install
npm run build
```

## 4. Bootstrapping a Consumer Workspace

A consumer workspace template exists under `examples/consumer-workspace-template/`. Copy it to any fresh directory:

```bash
cp -r examples/consumer-workspace-template/ ../my-agent-workspace
cd ../my-agent-workspace

export HARNESS_CORE=$(pwd)/../agent-harness-core
bash init.sh
```

## 5. Planning and Queuing Issues

Use the session-lifecycle CLI to inject tasks and manage the queue:

```bash
cd ../agent-harness-core

# Promote due queue items that have met dependency constraints
npm run session:lifecycle < examples/session-lifecycle/promote-queue.json

# Overview of your project queue state
npm run session:lifecycle < examples/session-lifecycle/inspect-overview.json
```

## 6. Run the Scheduler Injector

Once tasks are queued and promoted to `ready`, run the scheduler injector:

```bash
harness-scheduler-inject
```

## Next Steps

Review the [Architecture](architecture.md) documentation to understand how HarnessOS orchestrates canonical state, leases, and multi-host integration.
