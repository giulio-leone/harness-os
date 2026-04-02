---
name: prompt-contract-bindings
description: "Bind project-specific prompts to local schema and workflow artifacts while keeping the harness core generic and globally reusable."
version: "1.0.0"
---

# Prompt Contract Bindings

## Purpose
Capture the reusable pattern for operationalizing a domain prompt without polluting the generic harness core with project-specific entities, tables, or state machines.

## Use when
- A project has an important prompt that must become resumable, inspectable, and operational over many sessions
- The harness core should stay generic while the project keeps local domain schema or workflow details
- A team needs a repeatable bridge from `prompt fixture -> schema overlay -> workflow contract -> campaigns/issues -> validation`

## Canonical Pattern
1. Reusable runtime behavior lives in the harness core and its global skills.
2. Prompt-specific fixtures stay local to the project or workspace.
3. Domain schema overlays stay local to the project or workspace.
4. Prompt-to-workflow bindings stay local to the project or workspace.
5. Mission workflow contracts stay local to the project or workspace.
6. The harness core remains responsible only for generic state such as projects, campaigns, issues, runs, leases, checkpoints, events, artifacts, and memory links.
7. mem0 remains derived support memory only; it never replaces the canonical domain database or lifecycle state.

## Recommended File Layout
- `.harness/fixtures/<domain>.prompt.original.txt`
- `.harness/schemas/<domain>.domain.schema.json`
- `.harness/prompt-workflow-bindings.json`
- `.harness/mission-workflows/<domain>.workflow.json`
- `harness-project.json` entries pointing at the local prompt, schema, and workflow artifacts
- `init.sh`, `AGENTS.MD`, and `progress.md` updated so future sessions can see and validate the contract immediately

## Procedure
1. Save the exact prompt fixture locally.
2. Identify which parts of the prompt are globally reusable behavior vs local domain rules.
3. Keep the reusable behavior in the harness repo or global runtime skills.
4. Create a local domain schema overlay for prompt-required entities.
5. Create a prompt-workflow binding manifest that maps the prompt to schema, campaigns, smoke suites, and operating rules.
6. Create a local mission workflow contract that maps prompt rules to issue stages, checkpoints, and state transitions.
7. Wire the new local artifacts into `harness-project.json`, `init.sh`, and local `AGENTS.MD`.
8. Validate the artifacts on disk and run at least one bootstrap or preview path that proves the bindings do not break the existing lifecycle flow.

## Reference Workspace Examples

The repository now ships multiple reference bindings you can inspect before inventing your own:

| Workspace | Binding style |
| --- | --- |
| `examples/consumer-workspace-template` | generic assistant-style scaffold |
| `examples/research-workspace-template` | discovery/synthesis/review/publish workflow |
| `examples/ops-workspace-template` | incident triage/mitigation/execution/follow-through workflow |
| `examples/support-workspace-template` | intake/escalation/resolution/knowledge-base workflow |

Use these as concrete examples of how `.harness/prompt-workflow-bindings.json`, `.harness/schemas/domain-schema.json`, and `.harness/mission-workflows/workflow.json` fit together.

## Binding Validation Loop

After wiring the artifacts, validate them in this order:

1. `bash init.sh`
2. `python3 .harness/seed-live-catalog.py --reset`
3. a preview path such as `bash .harness/run-live-dry-run.sh`
4. a capability or queue inspection path that proves the workflow remains discoverable

## Validation Gate
A prompt contract is only operationalized when:
- the prompt fixture exists on disk
- the schema overlay exists on disk
- the binding manifest exists on disk
- the workflow contract exists on disk
- `harness-project.json` references the new artifacts
- `init.sh` or equivalent bootstrap detects them successfully
- at least one read-only or preview lifecycle path still succeeds

## Anti-patterns
- Adding domain-specific tables directly to `agent-harness-core/src/db/sqlite.schema.sql`
- Publishing a project-specific prompt as a global skill
- Treating mem0 as canonical domain storage
- Creating a binding manifest without wiring it into project bootstrap and guidance
- Claiming the prompt is global when only the pattern is global and the domain payload is still local

## Related Skills
- `session-lifecycle` — executes the generic queue/lease/checkpoint protocol used by the local workflow
- `harness-lifecycle` — governs initializer and incremental sessions around the local contract
- `planning-tracking` — breaks the operationalization work into explicit slices

## Related References
- `docs/workload-profiles.md` — explains which host specialization should carry the binding

## Version Notes
- `1.0.0` — initial repo-native skill extracted from verified prompt-to-schema/workflow operationalization in `combined-auto-runtime` while keeping the harness core generic.
