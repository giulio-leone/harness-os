---
name: systematic-debugging
description: "Evidence-based debugging via structured logging, debug-data.log analysis, and MCP tool integration — replaces trial-and-error."
---
# Systematic Debugging Skill

## Purpose
Replace blind trial-and-error debugging with a structured, evidence-based process. Every fix must be backed by data collected in `debug-data.log`.

## Use when
- A bug or unexpected behavior is reported or observed
- A test fails and the root cause is not immediately obvious
- An error appears in console, logs, or CI output
- A previous fix attempt did not solve the issue

## Procedure

### Step 1 — Reproduce
1. Confirm the bug is reproducible with a clear set of steps.
2. Capture the **initial error output** (stack trace, console error, failing test output).
3. If the bug is intermittent, note frequency and conditions.

### Step 2 — Hypothesize
1. Based on the error and context, form **max 3 ranked hypotheses**.
2. For each hypothesis state:
   - **What**: what you believe is wrong
   - **Where**: file(s) and line(s) most likely involved
   - **Why**: evidence supporting this hypothesis
3. Rank by likelihood: `H1` (most likely) → `H3` (least likely).

### Step 3 — Instrument
1. Add **targeted logging** at the locations identified in hypotheses.
2. Use structured prefixes so output is parseable:
   ```
   [DEBUG:H1:functionName] variable = value
   [DEBUG:H2:moduleName] state = value
   ```
3. Log **inputs, outputs, and intermediate state** — not just "reached here".
4. For async code, include timestamps:
   ```
   [DEBUG:H1:fetch] ${new Date().toISOString()} response.status = ${res.status}
   ```

### Step 4 — Collect
1. Run the code / test that triggers the bug.
2. Pipe **all debug output** to `debug-data.log`:
   - Terminal: `node app.js 2>&1 | tee debug-data.log`
   - Test runner: `npm test 2>&1 | tee debug-data.log`
   - Browser: copy console output into `debug-data.log`
3. If using MCP tools, also collect:
   - `chrome-devtools` → `list_console_messages` → append to `debug-data.log`
   - `chrome-devtools` → `list_network_requests` → append failed/relevant requests
   - `next-devtools` → `nextjs_call("get_errors")` → append runtime errors

### Step 5 — Analyze
1. Read `debug-data.log` and correlate with hypotheses.
2. For each hypothesis, determine:
   - **Confirmed**: log data proves this is the cause
   - **Eliminated**: log data contradicts this hypothesis
   - **Inconclusive**: need more instrumentation → go back to Step 3
3. If all hypotheses are eliminated, form new hypotheses based on collected data.
4. **Max 2 re-instrumentation cycles** before escalating (see Escalation below).

### Step 6 — Fix
1. Apply the **minimal fix** that addresses the confirmed root cause.
2. Re-run the failing test / reproduction steps to verify the fix.
3. Ensure no regressions: run the full test suite if available.

### Step 7 — Clean Up
1. Remove **all** `[DEBUG:...]` logging added in Step 3.
2. Delete `debug-data.log`.
3. Commit only the fix, not the debug instrumentation.

## MCP Tool Integration

When available, prefer MCP tools over manual instrumentation:

| Tool | Use for |
|------|---------|
| `chrome-devtools` → `list_console_messages` | Capture browser console output |
| `chrome-devtools` → `evaluate_script` | Test hypotheses live in browser context |
| `chrome-devtools` → `list_network_requests` | Debug API/network failures |
| `chrome-devtools` → `get_network_request` | Inspect specific request/response bodies |
| `chrome-devtools` → `take_screenshot` | Visual/layout bug evidence |
| `chrome-devtools` → `take_memory_snapshot` | Memory leak investigation |
| `chrome-devtools` → `lighthouse_audit` | Performance regression debugging |
| Framework runtime tools (e.g., framework-specific error collectors) | Capture runtime errors for the active framework |
| Terminal → `run_command` | Execute tests, capture output |
| File system → `grep_search` | Trace error messages to source code |

## Escalation
If after **2 instrumentation → analysis cycles** the root cause is still unclear:
1. Document all collected evidence in `debug-data.log`
2. Present findings to the user with the data
3. Ask whether to:
   - Broaden the investigation scope
   - Involve additional expertise (e.g., review architecture)
   - Accept a workaround while root cause is investigated

See also **`rollback-rca`** — if a fix fails the completion gate 3 times, switch to the rollback/RCA procedure instead of continuing to debug.

## Done Criteria
- Root cause identified and documented
- Fix verified by reproducing the original steps (bug no longer occurs)
- Full test suite passes (no regressions)
- All debug instrumentation removed
- `debug-data.log` deleted from working directory

## Anti-patterns
- **Blind changes** — modifying code without evidence of what is wrong
- **Skipping log collection** — "fixing" based on guesses without data
- **Shotgun debugging** — changing multiple things simultaneously
- **Leaving debug code** — forgetting to remove `console.log` instrumentation
- **Symptom fixing** — addressing the visible error instead of the root cause
- **Infinite retry loops** — more than 3 fix attempts without re-analyzing from data
- **No reproduction** — attempting to fix without confirming the bug exists
