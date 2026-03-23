---
name: harness-schema-migration
description: "Upgrade pre-v2 agent-harness SQLite databases to the current schema after automatic runtime migration has been removed."
version: "1.0.0"
---

# Harness Schema Migration

## Purpose
Perform a one-shot upgrade of a legacy `agent-harness-core` SQLite database to schema v2 without reintroducing backward-compatibility code into the runtime.

## Use when
- `openHarnessDatabase()` rejects a database because it is legacy, unversioned, or older than schema v2
- A CLI or MCP binary refuses to start and instructs you to run `harness-schema-migration`
- You need to preserve an old queue/history database before moving to the current runtime

## Rules
1. Do not patch the runtime to support legacy schemas again.
2. Always migrate the database offline or from a backup-safe environment.
3. Keep the original DB backup until the migrated DB passes validation.
4. After migration, the runtime should see `PRAGMA user_version = 2`.

## Procedure
1. Confirm the database path.
2. Run the migration script:

```bash
python3 .github/skills/harness-schema-migration/scripts/migrate_harness_db.py --db /absolute/path/to/harness.sqlite
```

3. Re-open the DB with the current runtime and verify startup succeeds.
4. If the script reports unsupported or corrupt legacy data, stop and inspect the backup instead of re-adding compatibility branches to the runtime.

## Validation
- `PRAGMA user_version` returns `2`
- `active_sessions` exists
- `idx_leases_unique_active_issue` exists
- `checkpoints` contains `task_status`, `next_step`, and `artifact_ids_json`

## Anti-patterns
- Re-adding legacy migration logic to `src/db/store.ts`
- Running ad-hoc SQL manually when the script can do the migration deterministically
- Deleting the original DB before checking the migrated one
