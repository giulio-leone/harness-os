# Research Workspace Template

This reference workspace shows how to run HarnessOS for evidence-driven discovery, synthesis, and publication handoff on the `research` workload profile.

## What is included

- portable bootstrap scripts and preview-first wrappers under `.harness/`
- local Copilot CLI skill copies under `.github/skills/`
- a reference mission catalog for discovery -> synthesis -> handoff
- example workflow metadata using `deadlineAt`, `recipients`, `approvals`, and `externalRefs`
- research-oriented placeholder assets for a brief and source map

## Best paired workload profile

```bash
harness-install-mcp --host copilot --workload-profile research
```

Use `assistant` instead when the same host must keep the full bundled skill surface.

## What you must customize

- `CONTEXT.MD`
- `JOBS.MD`
- `NETWORK.MD`
- `research-brief.md`
- `source-map.md`
- `.harness/fixtures/template.prompt.txt`
- `.harness/prompt-workflow-bindings.json`
- `.harness/schemas/domain-schema.json`
- `.harness/mission-workflows/workflow.json`
- `.harness/live-mission-catalog.json`

## Quick start

1. Copy this directory into a new workspace.
2. Set `HARNESS_CORE=/absolute/path/to/agent-harness-core` if the copied workspace lives outside this repository.
3. Customize the context files and JSON contracts listed above.
4. Run `bash init.sh`.
5. Seed the local catalog with `python3 .harness/seed-live-catalog.py --reset`.
6. Validate the lease loop with `bash .harness/run-live-dry-run.sh`.
7. Inspect the preview-only live path with `bash .harness/run-live-claim.sh`.
8. Promote newly unlocked issues with `bash .harness/run-live-queue-promotion.sh --execute` after closing work as `done`.

## Notes

- SQLite remains canonical and mem0 remains support-only.
- The reference queue uses first-class workflow metadata so peer-review and publication deadlines stay visible at the issue boundary.
- Copilot CLI discovers local workspace skills from `.github/skills/`, so the template ships with local `session-lifecycle` and `prompt-contract-bindings` skill copies there.
- The template intentionally ships without live proof artifacts or runtime snapshots.
