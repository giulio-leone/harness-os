<div align="center">
  <img src="assets/banner.svg" alt="HarnessOS Banner" width="100%" />

  # HarnessOS

  <p><strong>The operating system for autonomous AI agents.</strong></p>
  <p><em>"Harness is all you need"</em></p>

  [![Version](https://img.shields.io/npm/v/harness-os?style=for-the-badge&color=6366F1)](https://www.npmjs.com/package/harness-os)
  [![License](https://img.shields.io/badge/License-BUSL--1.1-8B5CF6?style=for-the-badge)](LICENSE)
  [![TypeScript](https://img.shields.io/badge/TypeScript-Ready-3178C6?style=for-the-badge&logo=typescript&logoColor=white)]()
  [![Website](https://img.shields.io/badge/Website-giulioleone.com-06B6D4?style=for-the-badge&logo=googlechrome&logoColor=white)](https://www.giulioleone.com)
  [![LinkedIn](https://img.shields.io/badge/LinkedIn-Giulio%20Leone-0A66C2?style=for-the-badge&logo=linkedin&logoColor=white)](https://www.linkedin.com/in/giulioleone-ai/)

  <p align="center">
    <a href="#-what-is-a-harness">What is a Harness?</a> •
    <a href="#-key-features">Key Features</a> •
    <a href="#-getting-started">Getting Started</a> •
    <a href="#-architecture">Architecture</a> •
    <a href="#%EF%B8%8F-developer">Developer</a>
  </p>
</div>

---

## 🧬 What is a Harness?

In AI, an LLM can *think*. A tool can *act*. But neither can **persist, recover, coordinate, or remember** on its own.

A **Harness** is the missing execution layer. It is the infrastructure that wraps around AI agents to give them:

- **Persistence** — Every task, every checkpoint, every event is written to a canonical SQLite store. If the agent dies, the work survives.
- **Lifecycle** — Tasks follow a strict state machine (`pending → ready → in_progress → done/failed`). Leases prevent two agents from claiming the same work. Stale leases are automatically recovered.
- **Memory** — Optional semantic memory powered by `mem0` allows agents to recall context across sessions, threads, and even projects — without polluting the canonical state.
- **Coordination** — Dependency chains between tasks are resolved automatically. When task A completes, its dependents are promoted to `ready`. No human intervention needed.
- **Portability** — The harness is agent-agnostic and IDE-agnostic. It works with Copilot, Gemini, Cursor, Windsurf, or any custom runtime. Set it up once, use it everywhere.

### Why does this matter?

Without a harness, every AI agent is a **stateless function call**. It forgets everything between sessions. It can't coordinate with other agents. It can't recover from crashes. It can't prove what it did or why.

**HarnessOS turns disposable AI into a persistent, self-healing, auditable system.**

Think of it this way:
- An LLM is a CPU.
- Tools are peripherals.
- **HarnessOS is the operating system that makes them work together reliably.**

---

## 🚀 Overview

**HarnessOS** provides the foundational execution framework for advanced autonomous agents. It focuses strictly on robust lifecycle management, leaving LLM inference and tool implementation to the consumer.

### What it handles:
- **Zod Plan Contracts** — Strongly typed schema validation for robust planning.
- **Session Contracts** — Standardized agent execution lifecycles.
- **Skill-Policy Registry** — Dynamic management of agent capabilities and operational rules.
- **Canonical SQLite Store** — Robust, ACID-compliant state layer for leases, checkpoints, events, and task states.
- **Session Orchestration** — High-level inspection, queue promotion, and task lifecycle management.

---

## ⚡ Key Features

### 🗄️ Canonical SQLite State
SQLite acts as the absolute source of truth for:
- **Leases** — Task-scoped locks to prevent concurrent race conditions.
- **Checkpoints** — Snapshot history of agent progress.
- **Events** — Immutable transaction logs.
- **Task State** — Workflow queues and resolutions.

### 🧠 Optional Memory Derivation
- Integrating `mem0-mcp` provides advanced semantic memory and context extraction.
- **Lazy Loading** — Derived memory is loaded *only* when needed to conserve resources.
- **Failsafe Operations** — If `mem0-mcp` is unavailable, the harness gracefully degrades without corrupting the canonical SQLite tasks.

### ⏱️ Reusable Scheduler Injector
A cron-aware, idempotent injector for scheduled work (`src/bin/scheduler-inject.ts`), supporting full 5-field cron expressions to safely trigger work without duplications.

---

## 💻 Getting Started

### 1️⃣ Installation & Multi-Host Setup

```bash
npm install -g harness-os mem0-mcp
```

HarnessOS targets **Node.js 22+** and ships with installable CLIs for runtime setup, scheduling, and MCP registration.

Register the lifecycle MCP server for Codex, Copilot CLI, and antigravity in one pass:

```bash
# Creates ~/.agent-harness/{harness.sqlite,mem0} if missing and configures the hosts
harness-install-mcp --host codex --host copilot --host antigravity

# Optional: inspect first without writing anything
harness-install-mcp --dry-run
```

You can still register extra host workspaces for skill sync:

```bash
harness-setup
harness-sync
```

### 2️⃣ Environment Variables

| Variable | Default Value | Description |
|----------|---------------|-------------|
| `HARNESS_DB_PATH` | `~/.agent-harness/harness.sqlite` | Path to the canonical HarnessOS SQLite store |
| `MEM0_STORE_PATH` | `~/.agent-harness/mem0` | Path to Mem0 semantic storage |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | URL to the Ollama embedding API |
| `MEM0_EMBED_MODEL` | `qwen3-embedding:latest` | The model used for extracting memory |
| `AGENT_HARNESS_MEM0_MODULE_PATH` | auto-resolved | Optional explicit module path for `mem0-mcp` |
| `AGENT_HARNESS_DISABLE_DEFAULT_MEM0`| N/A | Set to `1` to disable lazy loaded mem0 entirely |

### 3️⃣ Running Commands

```bash
# Run the cron-aware scheduler injector
harness-scheduler-inject

# Run the standard CLI session lifecycle
harness-session-lifecycle

# Start the MCP (Model Context Protocol) Server for lifecycle orchestration
harness-session-lifecycle-mcp
```

*(For detailed examples and JSON payload usage, see the `examples/session-lifecycle/` directory.)*

---

## 🧩 Architecture

For an in-depth look at how HarnessOS works, refer to the [Architecture Documentation](docs/architecture.md).

The typical execution flow:
1. `beginIncrementalSession()` — Claims a pending task.
2. `beginRecoverySession()` — Resolves and overrides a stuck or failed task.
3. `checkpoint()` — Writes immediate progress to SQLite.
4. `close()` — Releases the lease and promotes task resolution.

---

## 🤝 Contributing

We welcome contributions to make HarnessOS even better! Please read our [Contributing Guidelines](CONTRIBUTING.md) to get started with setting up the project and submitting pull requests.

---

## 👨‍💻 Developer & Creator

<div align="center">
  <h3><strong>Giulio Leone</strong></h3>
  <p>AI Architect & Software Engineer</p>

  [![LinkedIn](https://img.shields.io/badge/Connect%20on-LinkedIn-0A66C2?style=for-the-badge&logo=linkedin&logoColor=white)](https://www.linkedin.com/in/giulioleone-ai/)
  [![Website](https://img.shields.io/badge/Visit-giulioleone.com-06B6D4?style=for-the-badge&logo=googlechrome&logoColor=white)](https://www.giulioleone.com)
  
  <p><em>Built with passion to push the boundaries of automated intelligence, self-repairing agentic systems, and highly reliable execution state machines. Have questions, ideas, or feedback? I'd love to connect!</em></p>
</div>

---

## 📄 License

This project is licensed under the **Business Source License 1.1 (BSL)**.

You may use this software for **non-commercial** and **non-production** purposes (e.g., development, testing, research, and personal projects) **free of charge**.

> ⚠️ Commercial and production use is strictly prohibited without prior written authorization.

*On March 22, 2030, this license automatically converts to the **Apache License, Version 2.0**.*
