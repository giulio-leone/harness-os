#!/usr/bin/env bash
set -euo pipefail

echo "=== agent-harness-core init ==="
[ -f package.json ] && echo "[ok] package.json"
[ -f tsconfig.json ] && echo "[ok] tsconfig.json"
[ -f src/contracts/plan.schema.ts ] && echo "[ok] plan.schema.ts"
[ -f src/contracts/session-contracts.ts ] && echo "[ok] session-contracts.ts"
[ -f src/memory/mem0-adapter.interface.ts ] && echo "[ok] mem0-adapter.interface.ts"
[ -f src/policy/skill-policy-registry.ts ] && echo "[ok] skill-policy-registry.ts"
[ -f src/db/sqlite.schema.sql ] && echo "[ok] sqlite.schema.sql"
[ -f src/db/store.ts ] && echo "[ok] store.ts"
[ -f src/db/checkpoint-writer.ts ] && echo "[ok] checkpoint-writer.ts"
echo "=== scaffold ready ==="
