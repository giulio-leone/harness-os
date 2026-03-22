#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
HARNESS_DIR="$ROOT_DIR/.harness"

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

HARNESS_CORE="$(resolve_harness_core || true)"
export HARNESS_DIR

printf '=== Consumer Workspace Template Init ===\n'
mkdir -p \
  "$HARNESS_DIR/runtime/generated" \
  "$HARNESS_DIR/logs" \
  "$HARNESS_DIR/fixtures" \
  "$HARNESS_DIR/mem0" \
  "$HARNESS_DIR/schemas" \
  "$HARNESS_DIR/mission-workflows"

printf '[ok] runtime directories ensured\n'

if command -v node >/dev/null 2>&1; then
  printf '[ok] node: %s\n' "$(node --version)"
else
  printf '[error] node is required but not available in PATH\n' >&2
  exit 1
fi

if command -v python3 >/dev/null 2>&1; then
  printf '[ok] python3: %s\n' "$(python3 --version | awk '{print $2}')"
else
  printf '[error] python3 is required but not available in PATH\n' >&2
  exit 1
fi

if command -v onecrawl >/dev/null 2>&1; then
  printf '[ok] onecrawl available\n'
else
  printf '[warn] onecrawl not found in PATH\n'
fi

if command -v mobile-mcp >/dev/null 2>&1; then
  printf '[ok] mobile-mcp available\n'
else
  printf '[warn] mobile-mcp not found in PATH\n'
fi

if [ -n "$HARNESS_CORE" ]; then
  printf '[ok] HARNESS_CORE resolved: %s\n' "$HARNESS_CORE"
else
  printf '[warn] HARNESS_CORE not resolved automatically; set HARNESS_CORE before running live wrappers outside this repo\n'
fi

if [ -n "$HARNESS_CORE" ] && [ -f "$HARNESS_CORE/dist/bin/session-lifecycle.js" ]; then
  printf '[ok] session-lifecycle CLI found\n'
else
  printf '[warn] session-lifecycle CLI missing; expected %s/dist/bin/session-lifecycle.js\n' "${HARNESS_CORE:-<unset>}"
fi

if [ -n "$HARNESS_CORE" ] && [ -f "$HARNESS_CORE/dist/bin/mem0-mcp.js" ]; then
  printf '[ok] mem0 CLI found\n'
else
  printf '[warn] mem0 CLI missing; expected %s/dist/bin/mem0-mcp.js\n' "${HARNESS_CORE:-<unset>}"
fi

for required_file in \
  "$ROOT_DIR/AGENTS.MD" \
  "$ROOT_DIR/progress.md" \
  "$ROOT_DIR/feature_list.json" \
  "$ROOT_DIR/harness-project.json" \
  "$ROOT_DIR/CONTEXT.MD" \
  "$ROOT_DIR/JOBS.MD" \
  "$ROOT_DIR/NETWORK.MD" \
  "$ROOT_DIR/resume.md" \
  "$ROOT_DIR/cover-letter.md" \
  "$HARNESS_DIR/fixtures/template.prompt.txt" \
  "$HARNESS_DIR/prompt-workflow-bindings.json" \
  "$HARNESS_DIR/schemas/domain-schema.json" \
  "$HARNESS_DIR/mission-workflows/workflow.json" \
  "$HARNESS_DIR/live-mission-catalog.json" \
  "$ROOT_DIR/.github/skills/session-lifecycle/SKILL.md" \
  "$ROOT_DIR/.github/skills/prompt-contract-bindings/SKILL.md" \
  "$HARNESS_DIR/smoke-suite-manifest.json" \
  "$HARNESS_DIR/run-smoke-suites.js" \
  "$HARNESS_DIR/seed-live-catalog.py" \
  "$HARNESS_DIR/render-live-inputs.py" \
  "$HARNESS_DIR/run-live-dry-run.sh" \
  "$HARNESS_DIR/run-live-claim.sh" \
  "$HARNESS_DIR/run-live-queue-promotion.sh"
do
  if [ -f "$required_file" ]; then
    printf '[ok] found %s\n' "${required_file#$ROOT_DIR/}"
  else
    printf '[warn] missing %s\n' "${required_file#$ROOT_DIR/}"
  fi
done

printf 'Template smoke suites configured: %s\n' "$(
  python3 - <<'PY2'
import json
import os
from pathlib import Path
manifest = json.loads(Path(os.environ['HARNESS_DIR']).joinpath('smoke-suite-manifest.json').read_text(encoding='utf-8'))
print(len(manifest.get('suites', [])))
PY2
)"

printf '=== Environment Ready ===\n'
printf 'Next steps:\n'
printf '  1. Customize the template context files and JSON contracts\n'
printf '  2. Run python3 .harness/seed-live-catalog.py --reset\n'
printf '  3. Run bash .harness/run-live-dry-run.sh\n'
