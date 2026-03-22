# Consumer Workspace Template

This template extracts the reusable bootstrap surface from a real consumer workspace without carrying over live proof artifacts, personal assets, or machine-specific paths.

## What is included

- portable bootstrap scripts
- prompt/schema/workflow placeholders
- a template live catalog with dependency-driven issues
- preview-first wrappers for dry-run, live claim, and queue promotion

## What you must customize

- `CONTEXT.MD`
- `JOBS.MD`
- `NETWORK.MD`
- `resume.md`
- `cover-letter.md`
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

- SQLite remains canonical.
- mem0 remains support-only.
- The template intentionally ships without smoke proof artifacts or runtime snapshots.
- `run-smoke-suites.js` is included as the reusable verifier, but the manifest starts empty until you add your own validated suites.
