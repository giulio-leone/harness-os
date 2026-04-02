#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS_DIR="$ROOT_DIR/.harness"
RUNTIME_DIR="$HARNESS_DIR/runtime"
GENERATED_DIR="$RUNTIME_DIR/generated"
LIVE_DB="$RUNTIME_DIR/live-catalog.sqlite"
SANDBOX_DB="$RUNTIME_DIR/live-dry-run.sqlite"
BEGIN_OUTPUT="$RUNTIME_DIR/live-dry-run.begin-output.json"
OVERVIEW_OUTPUT="$RUNTIME_DIR/live-dry-run.overview-output.json"
ISSUE_OUTPUT="$RUNTIME_DIR/live-dry-run.issue-output.json"
SUMMARY_OUTPUT="$RUNTIME_DIR/live-dry-run.summary.json"

source "$HARNESS_DIR/workspace-common.sh"
require_harness_core
ensure_runtime_dirs
ensure_seeded_catalog_db "$LIVE_DB"
python3 "$HARNESS_DIR/seed-live-catalog.py" --reset --db-path "$SANDBOX_DB" >/dev/null
python3 "$HARNESS_DIR/render-live-inputs.py" --action dry-run --db-path "$SANDBOX_DB" > "$GENERATED_DIR/live-dry-run.metadata.json"

BEGIN_INPUT="$GENERATED_DIR/live-dry-run.begin.json"
OVERVIEW_INPUT="$GENERATED_DIR/live-dry-run.inspect-overview.json"
ISSUE_INPUT="$GENERATED_DIR/live-dry-run.inspect-issue.json"

run_session_lifecycle "$BEGIN_INPUT" > "$BEGIN_OUTPUT"
run_session_lifecycle "$OVERVIEW_INPUT" > "$OVERVIEW_OUTPUT"
run_session_lifecycle "$ISSUE_INPUT" > "$ISSUE_OUTPUT"

export LIVE_DB SANDBOX_DB BEGIN_OUTPUT OVERVIEW_OUTPUT ISSUE_OUTPUT ISSUE_INPUT SUMMARY_OUTPUT
python3 - <<'PY2'
import json
import os
import sqlite3
from pathlib import Path

begin_output = json.loads(Path(os.environ['BEGIN_OUTPUT']).read_text(encoding='utf-8'))
overview_output = json.loads(Path(os.environ['OVERVIEW_OUTPUT']).read_text(encoding='utf-8'))
issue_output = json.loads(Path(os.environ['ISSUE_OUTPUT']).read_text(encoding='utf-8'))
issue_input = json.loads(Path(os.environ['ISSUE_INPUT']).read_text(encoding='utf-8'))

issue_id = issue_input['input']['issueId']
live_db = Path(os.environ['LIVE_DB'])
sandbox_db = Path(os.environ['SANDBOX_DB'])

with sqlite3.connect(live_db) as conn:
    canonical_status = conn.execute('SELECT status FROM issues WHERE id = ?', (issue_id,)).fetchone()[0]
with sqlite3.connect(sandbox_db) as conn:
    sandbox_status = conn.execute('SELECT status FROM issues WHERE id = ?', (issue_id,)).fetchone()[0]

summary = {
    'claimedIssueId': begin_output['context']['issueId'],
    'claimMode': begin_output['context']['claimMode'],
    'sandboxIssueStatus': sandbox_status,
    'canonicalIssueStatus': canonical_status,
    'sandboxActiveLeaseCount': overview_output['result']['counts']['activeLeases'],
    'sandboxReadyIssueCountAfterClaim': overview_output['result']['counts']['readyIssues'],
    'sandboxRecoveryIssueCount': overview_output['result']['counts']['recoveryIssues'],
    'sandboxRecentRuns': overview_output['result']['counts']['recentRuns'],
    'issueCheckpointCount': len(issue_output['result']['checkpoints']),
    'issueEventKinds': [event['kind'] for event in issue_output['result']['events']],
    'sandboxDbPath': str(sandbox_db),
    'liveDbPath': str(live_db),
}
Path(os.environ['SUMMARY_OUTPUT']).write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8')
print(json.dumps(summary, indent=2))
PY2
