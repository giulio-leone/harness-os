# Getting Started

Welcome to **HarnessOS** — the operating system for autonomous AI agents. This guide will walk you through setting up the runtime and executing your first agentic task flow.

## Prerequisites

- Node.js (v20 or higher recommended)
- Git
- SQLite (built into the core process)
- *Optional:* A local instance of Ollama running `qwen3-embedding:latest` if using `mem0-mcp` for semantic extraction.

## 1. Local Setup

```bash
git clone https://github.com/giulio-leone/harness-os.git
cd harness-os
npm install
npm run build
```

## 2. Register Your Hosts

HarnessOS works with **any** AI runtime or IDE. Register the ones you use:

```bash
npx harness-setup
```

This opens an interactive menu where you can add paths like `~/.gemini`, `~/.cursor`, `~/.copilot`, or any custom directory. Your selections are saved to `~/.agent-harness/config.json`.

Then sync the harness skills to all registered hosts:

```bash
npx harness-sync
```

## 3. Bootstrapping a Workspace

A consumer workspace template exists under `examples/consumer-workspace-template/`. Copy it to any fresh directory:

```bash
cp -r examples/consumer-workspace-template/ ../my-agent-workspace
cd ../my-agent-workspace

export HARNESS_CORE=$(pwd)/../agent-harness-core
bash init.sh
```

## 4. Planning and Queuing Issues

Use the session-lifecycle CLI to inject tasks and manage the queue:

```bash
cd ../agent-harness-core

# Promote due queue items that have met dependency constraints
npm run session:lifecycle < examples/session-lifecycle/promote-queue.json

# Overview of your project queue state
npm run session:lifecycle < examples/session-lifecycle/inspect-overview.json
```

## 5. Run the Daemon

Once tasks are queued and promoted to `ready`, start the scheduler:

```bash
npm run scheduler:daemon
```

## Next Steps

Review the [Architecture](architecture.md) documentation to understand how HarnessOS orchestrates canonical state, leases, and multi-host integration.
