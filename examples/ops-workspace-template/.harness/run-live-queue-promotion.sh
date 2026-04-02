#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS_DIR="$ROOT_DIR/.harness"
RUNTIME_DIR="$HARNESS_DIR/runtime"
GENERATED_DIR="$RUNTIME_DIR/generated"
LIVE_DB="$RUNTIME_DIR/live-catalog.sqlite"
MODE="${1:---preview}"

source "$HARNESS_DIR/workspace-common.sh"
require_harness_core
ensure_runtime_dirs
ensure_seeded_catalog_db "$LIVE_DB"
python3 "$HARNESS_DIR/render-live-inputs.py" --action queue-promotion --db-path "$LIVE_DB" > "$GENERATED_DIR/live-queue-promotion.metadata.json"

PROMOTION_INPUT="$GENERATED_DIR/live-queue-promotion.json"
OVERVIEW_INPUT="$GENERATED_DIR/live-queue-promotion.inspect-overview.json"

if [ "$MODE" = "--preview" ]; then
  run_session_lifecycle "$OVERVIEW_INPUT" > "$RUNTIME_DIR/live-queue-promotion-preview-overview.json"

  export LIVE_DB OVERVIEW_INPUT RUNTIME_DIR
  python3 - <<'PY2'
import json
import os
import sqlite3
from pathlib import Path

runtime = Path(os.environ['RUNTIME_DIR'])
overview = json.loads((runtime / 'live-queue-promotion-preview-overview.json').read_text(encoding='utf-8'))
overview_input = json.loads(Path(os.environ['OVERVIEW_INPUT']).read_text(encoding='utf-8'))
project_id = overview_input['input']['projectId']
db = Path(os.environ['LIVE_DB'])
with sqlite3.connect(db) as conn:
    pending_count = conn.execute("SELECT COUNT(*) FROM issues WHERE project_id = ? AND status = 'pending'", (project_id,)).fetchone()[0]
summary = {
    'mode': 'preview',
    'readyIssueCount': overview['result']['counts']['readyIssues'],
    'activeLeaseCount': overview['result']['counts']['activeLeases'],
    'recoveryIssueCount': overview['result']['counts']['recoveryIssues'],
    'pendingIssueCount': pending_count,
    'executeCommand': 'bash .harness/run-live-queue-promotion.sh --execute',
    'note': 'Promotion becomes useful after upstream dependencies close as done.'
}
(runtime / 'live-queue-promotion-preview.json').write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8')
print(json.dumps(summary, indent=2))
PY2
elif [ "$MODE" = "--execute" ]; then
  run_session_lifecycle "$PROMOTION_INPUT" > "$RUNTIME_DIR/live-queue-promotion-result.json"
  run_session_lifecycle "$OVERVIEW_INPUT" > "$RUNTIME_DIR/live-queue-promotion-overview.json"
  printf 'live queue promotion executed; see %s\n' "$RUNTIME_DIR/live-queue-promotion-result.json"
else
  printf 'usage: bash .harness/run-live-queue-promotion.sh [--preview|--execute]\n' >&2
  exit 1
fi
