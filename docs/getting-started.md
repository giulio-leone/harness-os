# Getting Started

Welcome to the **Agent Harness Core**. This guide will step you through running the session lifecycle tool and executing a simple agentic task flow on your local machine.

## Prerequisites

- Node.js (v20 or higher recommended)
- Git
- SQLite (built into the core process)
- *Optional:* A local instance of Ollama running `qwen3-embedding:latest` if using `mem0-mcp` for semantic extraction.

## 1. Local Setup

Clone the project and build the standard typescript files:

```bash
git clone https://github.com/giulio-leone/agent-harness-core.git
cd agent-harness-core
npm install
npm run build
```

## 2. Bootstrapping a Workspace

Start your journey by creating an initialization structure. 
A template exists under `examples/consumer-workspace-template/`. You can copy it to any fresh directory:

```bash
cp -r examples/consumer-workspace-template/ ../my-agent-workspace
cd ../my-agent-workspace

# Run the bootstrap initializations
export HARNESS_CORE=$(pwd)/../agent-harness-core
bash init.sh
```

## 3. Planning and Queuing Issues

To create an autonomous task, you must provide context and a task breakdown. With the session-lifecycle MCP tools or CLI, you inject high-level objectives that the model converts into queue items.

You can dry-run the core via CLI:

```bash
cd ../agent-harness-core

# Promote due queue items that have met dependency constraints
npm run session:lifecycle < examples/session-lifecycle/promote-queue.json

# Overview of your project queue state
npm run session:lifecycle < examples/session-lifecycle/inspect-overview.json
```

## 4. Run the Daemon

Once tasks are queued up and promoted to `ready`, start the automated scheduler daemon.

```bash
npm run scheduler:daemon
```

*Note: In production environments, rely on actual real cron distributions rather than exclusively relying on the node daemon.*

## Next Steps

Review the [Architecture](architecture.md) documentation to understand how these elements interoperate securely!
