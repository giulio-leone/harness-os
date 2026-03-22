#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS_DIR="$ROOT_DIR/.harness"
RUNTIME_DIR="$HARNESS_DIR/runtime"
GENERATED_DIR="$RUNTIME_DIR/generated"
LIVE_DB="$RUNTIME_DIR/live-catalog.sqlite"
MODE="${1:---preview}"
PREVIEW_SUMMARY="$RUNTIME_DIR/live-claim-preview-summary.json"
BEGIN_OUTPUT="$RUNTIME_DIR/live-claim.begin-output.json"
OVERVIEW_OUTPUT="$RUNTIME_DIR/live-claim.overview-output.json"
ISSUE_OUTPUT="$RUNTIME_DIR/live-claim.issue-output.json"

source "$HARNESS_DIR/workspace-common.sh"
require_harness_core
ensure_runtime_dirs
ensure_seeded_catalog_db "$LIVE_DB"
python3 "$HARNESS_DIR/render-live-inputs.py" --action live-claim --db-path "$LIVE_DB" > "$GENERATED_DIR/live-claim.metadata.json"

BEGIN_INPUT="$GENERATED_DIR/live-claim.begin.json"
OVERVIEW_INPUT="$GENERATED_DIR/live-claim.inspect-overview.json"
ISSUE_INPUT="$GENERATED_DIR/live-claim.inspect-issue.json"

if [ "$MODE" = "--preview" ]; then
  run_session_lifecycle "$OVERVIEW_INPUT" > "$RUNTIME_DIR/live-claim.preview-overview.json"
  run_session_lifecycle "$ISSUE_INPUT" > "$RUNTIME_DIR/live-claim.preview-issue.json"

  export LIVE_DB ISSUE_INPUT PREVIEW_SUMMARY RUNTIME_DIR
  python3 - <<'PY2'
import json
import os
import sqlite3
from pathlib import Path

runtime = Path(os.environ['RUNTIME_DIR'])
overview = json.loads((runtime / 'live-claim.preview-overview.json').read_text(encoding='utf-8'))
issue = json.loads((runtime / 'live-claim.preview-issue.json').read_text(encoding='utf-8'))
issue_input = json.loads(Path(os.environ['ISSUE_INPUT']).read_text(encoding='utf-8'))
issue_id = issue_input['input']['issueId']
db = Path(os.environ['LIVE_DB'])
with sqlite3.connect(db) as conn:
    status = conn.execute('SELECT status FROM issues WHERE id = ?', (issue_id,)).fetchone()[0]
summary = {
    'mode': 'preview',
    'targetIssueId': issue_id,
    'targetIssueStatus': status,
    'readyIssueCount': overview['result']['counts']['readyIssues'],
    'activeLeaseCount': overview['result']['counts']['activeLeases'],
    'recentRuns': overview['result']['counts']['recentRuns'],
    'issueCheckpointCount': len(issue['result']['checkpoints']),
    'issueLeaseCount': len(issue['result']['leases']),
    'mem0WillBeEnabledOnExecute': True,
    'executeCommand': 'bash .harness/run-live-claim.sh --execute'
}
Path(os.environ['PREVIEW_SUMMARY']).write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8')
print(json.dumps(summary, indent=2))
PY2
elif [ "$MODE" = "--execute" ]; then
  run_session_lifecycle "$BEGIN_INPUT" > "$BEGIN_OUTPUT"
  run_session_lifecycle "$ISSUE_INPUT" > "$ISSUE_OUTPUT"
  run_session_lifecycle "$OVERVIEW_INPUT" > "$OVERVIEW_OUTPUT"
  printf 'live claim executed; see %s\n' "$BEGIN_OUTPUT"
else
  printf 'usage: bash .harness/run-live-claim.sh [--preview|--execute]\n' >&2
  exit 1
fi
