# Workload Profiles

HarnessOS ships six bundled workload profiles:

| Profile | Purpose | Guidance |
| --- | --- | --- |
| `coding` | Software delivery, code review, testing, and release execution | Optimize for implementation quality, deterministic validation, and release-safe engineering workflows. |
| `research` | Discovery, synthesis, analysis, and evidence-driven investigation | Optimize for structured exploration, traceable findings, and compact handoffs instead of code-first execution. |
| `ops` | Infrastructure, deployment, incident response, and service operations | Optimize for operational safety, rollback readiness, observability, and recovery discipline. |
| `sales` | Pipeline execution, deal support, enablement, and external follow-through | Optimize for structured plans, decision clarity, and lightweight operational handoffs across stakeholders. |
| `support` | Case triage, escalation handling, investigation, and customer resolution workflows | Optimize for reproducible investigation, escalation discipline, and clear next-action ownership. |
| `assistant` | General cross-domain execution with the full bundled skill surface | Use this when a host must stay multi-domain and should not be specialized to one narrower flow. |

## Profile selection matrix

| If you need to... | Choose | Why |
| --- | --- | --- |
| implement code, validate releases, and ship changes | `coding` | it keeps code review, testing, dependency, and release skills on the host |
| explore, synthesize, and produce evidence-backed findings | `research` | it keeps the runtime lean while retaining structured investigation support |
| triage incidents, plan mitigations, and protect rollback paths | `ops` | it adds operational safety, observability, and recovery-oriented skills |
| manage pipeline and external stakeholder follow-through | `sales` | it keeps planning and GitHub/project synchronization lightweight |
| resolve customer cases with explicit escalation ownership | `support` | it focuses on reproducible investigation and next-action clarity |
| keep one host fully multi-domain | `assistant` | it ships the complete bundled skill surface instead of a specialized subset |

## Skill membership at a glance

All profiles ship the core runtime skills (`completion-gate`, `context-management`, `harness-interactive-setup`, `harness-lifecycle`, `interaction-loop`, `planning-tracking`, `policy-coherence-audit`, `programmatic-tool-calling`, `prompt-contract-bindings`, `rollback-rca`, `session-lifecycle`, `session-logging`). Profile-specific additions are:

| Profile | Extra bundled skills |
| --- | --- |
| `coding` | `breaking-change-paths`, `code-review`, `dependency-management`, `e2e-testing`, `error-handling-patterns`, `git-workflow`, `github-sync`, `mobile-mcp-optimization`, `performance-audit`, `systematic-debugging`, `testing-policy` |
| `research` | `systematic-debugging` |
| `ops` | `dependency-management`, `e2e-testing`, `error-handling-patterns`, `performance-audit`, `systematic-debugging` |
| `sales` | `github-sync` |
| `support` | `error-handling-patterns`, `systematic-debugging` |
| `assistant` | all bundled skills |

For the browsable skill index, see [../.github/skills/README.md](../.github/skills/README.md).

## Reference workspace pairing

The repository includes concrete reference workspaces for the main non-coding flows plus the general `assistant` path:

| Profile | Reference workspace | What it demonstrates |
| --- | --- | --- |
| `assistant` | [`examples/consumer-workspace-template/`](../examples/consumer-workspace-template/) | generic cross-domain queue scaffolding with prompt, schema, workflow, and live-catalog placeholders |
| `research` | [`examples/research-workspace-template/`](../examples/research-workspace-template/) | discovery, synthesis, peer review, and publish handoff with workflow metadata |
| `ops` | [`examples/ops-workspace-template/`](../examples/ops-workspace-template/) | incident triage, mitigation planning, execution, rollback readiness, and post-incident follow-through |
| `support` | [`examples/support-workspace-template/`](../examples/support-workspace-template/) | case intake, escalation approval, customer-safe resolution, and knowledge-base follow-up |

The research, ops, and support templates ship example issue metadata through `deadlineAt`, `recipients`, `approvals`, and `externalRefs`, and their seed scripts persist that metadata into the canonical SQLite issue columns.

## Quick starts

### Assistant

```bash
harness-install-mcp --host copilot --workload-profile assistant
cp -r examples/consumer-workspace-template/ ../my-assistant-workspace
cd ../my-assistant-workspace
export HARNESS_CORE=$(pwd)/../agent-harness-core
bash init.sh
```

### Coding

```bash
harness-install-mcp --host codex --workload-profile coding
```

Use this when the host is primarily for implementation, review, testing, and release work. Pair it with your own coding workspace or repository checkout.

### Research

```bash
harness-install-mcp --host copilot --workload-profile research
cp -r examples/research-workspace-template/ ../my-research-workspace
cd ../my-research-workspace
export HARNESS_CORE=$(pwd)/../agent-harness-core
bash init.sh
python3 .harness/seed-live-catalog.py --reset
```

### Ops

```bash
harness-install-mcp --host codex --workload-profile ops
cp -r examples/ops-workspace-template/ ../my-ops-workspace
cd ../my-ops-workspace
export HARNESS_CORE=$(pwd)/../agent-harness-core
bash init.sh
python3 .harness/seed-live-catalog.py --reset
```

### Support

```bash
harness-install-mcp --host copilot --workload-profile support
cp -r examples/support-workspace-template/ ../my-support-workspace
cd ../my-support-workspace
export HARNESS_CORE=$(pwd)/../agent-harness-core
bash init.sh
python3 .harness/seed-live-catalog.py --reset
```

### Sales

```bash
harness-install-mcp --host copilot --workload-profile sales
```

Use this when the host is primarily coordinating planning, follow-through, and external stakeholder handoffs rather than code or incident response.

## Verifying the selected profile

After installing MCP on a host, call `harness_inspector(action: "capabilities")`. The returned capability catalog includes:

- the bundled MCP tools and their actions
- the active `workloadProfiles` list
- skill metadata with `workloadProfileIds`
- the `orchestration` block for Symphony discovery, including `harness_symphony` actions, `gpt-5-high` defaults, four-agent fan-out, dispatch requirements, worktree isolation semantics, accepted evidence artifact kinds, and runtime metadata artifact kinds
- mem0 availability and bootstrap guidance

That makes `capabilities` the fastest machine-readable way to confirm both tool discoverability and workload-profile selection.

## Choosing between `assistant` and a specialized profile

- Choose `assistant` when one host must retain the full bundled skill surface and switch between domains freely.
- Choose `research`, `ops`, or `support` when you want the host install to stay narrower and the workspace itself already matches one of those flows.
- Choose `coding` or `sales` when you need those skill bundles, even though this repository currently publishes concrete reference workspaces only for `assistant`, `research`, `ops`, and `support`.
