#!/usr/bin/env bash

resolve_harness_core() {
  local candidate

  if [ -n "${HARNESS_CORE:-}" ] && [ -f "$HARNESS_CORE/dist/bin/session-lifecycle.js" ]; then
    (cd "$HARNESS_CORE" && pwd)
    return 0
  fi

  for candidate in \
    "$ROOT_DIR/../agent-harness-core" \
    "$ROOT_DIR/../../agent-harness-core" \
    "$ROOT_DIR/../.." \
    "$HOME/Sviluppo/agent-harness-core"
  do
    if [ -f "$candidate/dist/bin/session-lifecycle.js" ] && [ -f "$candidate/src/db/sqlite.schema.sql" ]; then
      (cd "$candidate" && pwd)
      return 0
    fi
  done

  return 1
}

require_harness_core() {
  HARNESS_CORE="$(resolve_harness_core)" || {
    printf '[error] set HARNESS_CORE to the agent-harness-core repo root before running this script\n' >&2
    exit 1
  }
  export HARNESS_CORE
}

ensure_runtime_dirs() {
  mkdir -p \
    "$HARNESS_DIR/runtime/generated" \
    "$HARNESS_DIR/logs" \
    "$HARNESS_DIR/fixtures" \
    "$HARNESS_DIR/mem0" \
    "$HARNESS_DIR/schemas" \
    "$HARNESS_DIR/mission-workflows"
}

ensure_seeded_catalog_db() {
  local db_path="$1"
  if [ ! -f "$db_path" ]; then
    python3 "$HARNESS_DIR/seed-live-catalog.py" --reset --db-path "$db_path" >/dev/null
  fi
}

run_session_lifecycle() {
  (
    cd "$HARNESS_CORE"
    node dist/bin/session-lifecycle.js --input "$1"
  )
}
