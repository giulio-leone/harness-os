<div align="center">
  <img src="assets/banner.svg" alt="Agent Harness Core Banner" width="100%" />

  # ⚙️ Agent Harness Core

  <p><strong>A reusable, robust, and highly scalable long-running agent harness core built for autonomous task execution.</strong></p>

  [![Version](https://img.shields.io/npm/v/agent-harness-core?style=for-the-badge&color=3B82F6)](https://www.npmjs.com/package/agent-harness-core)
  [![License](https://img.shields.io/badge/License-BUSL--1.1-8B5CF6?style=for-the-badge)](LICENSE)
  [![TypeScript](https://img.shields.io/badge/TypeScript-Ready-3178C6?style=for-the-badge&logo=typescript&logoColor=white)]()
  [![Developer](https://img.shields.io/badge/Developer-Giulio%20Leone-EC4899?style=for-the-badge&logo=linkedin)](https://www.linkedin.com/in/giulioleone-ai/)

  <p align="center">
    <a href="#-key-features">Key Features</a> •
    <a href="#-getting-started">Getting Started</a> •
    <a href="#-architecture">Architecture</a> •
    <a href="#%EF%B8%8F-developer">Developer</a>
  </p>
</div>

---

## 🚀 Overview

**Agent Harness Core** provides the foundational execution framework for advanced autonomous agents. It focuses strictly on robust lifecycle management, leaving LLM inference and tool implementation to the consumer.

### What it handles:
- **Zod Plan Contracts:** Strongly typed schema validation for robust planning.
- **Session Contracts:** Standardized agent execution lifecycles.
- **Skill-Policy Registry:** Dynamic management of agent capabilities and operational rules.
- **Canonical SQLite Store:** Robust, ACID-compliant state layer for leases, checkpoints, events, and task states.
- **Session Orchestration:** High-level inspection, queue promotion, and task lifecycle management.

---

## ⚡ Key Features

### 🗄️ Canonical SQLite State
SQLite acts as the absolute source of truth for:
- **Leases:** Task-scoped locks to prevent concurrent race conditions.
- **Checkpoints:** Snapshot history of agent progress.
- **Events:** Immutable transaction logs.
- **Task State:** Workflow queues and resolutions.

### 🧠 Optional Memory Derivation
- Integrating `mem0-mcp` provides advanced semantic memory and context extraction.
- **Lazy Loading:** Derived memory is loaded *only* when needed to conserve resources.
- **Failsafe Operations:** If `mem0-mcp` is unavailable, the harness gracefully degrades without corrupting the canonical SQLite tasks.

### ⏱️ Reusable Scheduler Injector
A cron-aware, idempotent injector for scheduled work (`src/bin/scheduler-daemon.ts`), supporting full 5-field cron expressions to safely trigger work without duplications.

---

## 💻 Getting Started

### 1️⃣ Installation & Multi-Host Setup

You can pull this into your own project or clone it to run the lifecycle endpoints.

```bash
git clone https://github.com/giulio-leone/agent-harness-core.git
cd agent-harness-core
npm install
npm run build
```

This harness is designed to work interactively with **any AI agent or IDE** (Copilot, Windsurf, Cursor, Gemini, etc.). You can register your environments dynamically:

```bash
# Interactively add/remove host workspaces (~/.gemini, ~/.cursor, etc.)
npx agent-harness-setup

# Synchronize the latest harness skills securely to your registered hosts
npx agent-harness-sync
```

### 2️⃣ Environment Variables

Configure your harness behavior by setting these standard variables:

| Variable | Default Value | Description |
|----------|---------------|-------------|
| `MEM0_STORE_PATH` | `~/.copilot/mem0` | Path to Mem0 semantic storage |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | URL to the Ollama embedding API |
| `MEM0_EMBED_MODEL` | `qwen3-embedding:latest` | The model used for extracting memory |
| `AGENT_HARNESS_DISABLE_DEFAULT_MEM0`| N/A | Set to `1` to disable lazy loaded mem0 entirely |

### 3️⃣ Running Commands

```bash
# Start the cron-aware scheduler
npm run build && npm run scheduler:daemon

# Run the standard CLI session lifecycle
npm run build && npm run session:lifecycle

# Start the MCP (Model Context Protocol) Server for lifecycle orchestration
npm run build && npm run session:lifecycle:mcp
```

*(For detailed examples and JSON payload usage, see the `examples/session-lifecycle/` directory.)*

---

## 🧩 Architecture

For an in-depth look at how the harness works, refer to the [Architecture Documentation](docs/architecture.md).

The typical execution flow:
1. `beginIncrementalSession()` - Claims a pending task.
2. `beginRecoverySession()` - Resolves and overrides a stuck or failed task.
3. `checkpoint()` - Writes immediate progress to SQLite.
4. `close()` - Releases the lease and promotes task resolution.

---

## 🤝 Contributing

We welcome contributions to make the Agent Harness even better! Please read our [Contributing Guidelines](CONTRIBUTING.md) to get started with setting up the project and submitting pull requests.

---

## 👨‍💻 Developer & Creator

<div align="center">
  <h3><strong>Giulio Leone</strong></h3>
  <p>AI Architect & Software Engineer</p>

  [![LinkedIn](https://img.shields.io/badge/Connect%20on-LinkedIn-0A66C2?style=for-the-badge&logo=linkedin&logoColor=white)](https://www.linkedin.com/in/giulioleone-ai/)
  
  <p><em>Built with passion to push the boundaries of automated intelligence, self-repairing agentic systems, and highly reliable execution state machines. Have questions, ideas, or feedback? I'd love to connect!</em></p>
</div>

---

## 📄 License

This project is generously licensed under the **Business Source License 1.1 (BSL)**.

You may use this software for **non-commercial** and **non-production** purposes (e.g., development, testing, research, and personal projects) **free of charge**.

> ⚠️ Commercial and production use is strictly prohibited without prior written authorization.

*On March 22, 2030, this license automatically converts to the **Apache License, Version 2.0**.*
