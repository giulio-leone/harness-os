# Symphony-style orchestration MCP examples

These payloads document the stable fully agentic orchestration handoff:

1. discover Symphony support and required dispatch fields;
2. create workspace/campaign scope;
3. compile tracker-style milestones and slices;
4. inject the compiled queue with `plan_issues`;
5. run a dry-run supervisor tick or bounded execute supervisor run for no-human promote/dispatch/assignment execution control;
6. dispatch up to four `gpt-5-high` subagents into isolated worktree assignments, either through the supervisor or the lower-level `dispatch_ready` action;
7. execute dispatched assignments through `dispatch.assignmentRunner` or `run_assignment`, requiring command-produced test, E2E, and CSQR-lite scorecard evidence;
8. save deterministic gate evidence artifacts, including typecheck, state export, test, E2E, screenshot, and CSQR-lite scorecard evidence;
9. inspect evidence-backed orchestration health;
10. load a filtered dashboard view model for agent navigation or proof review.

Each JSON file is shaped as:

```json
{
  "tool": "harness_symphony",
  "input": {
    "action": "dispatch_ready"
  }
}
```

Pass the `input` object to the named MCP `tool`. The examples are parse-tested against the public MCP schemas; replace placeholder workspace/campaign ids with values returned by setup calls, and replace placeholder issue ids in `05-dispatch-ready.json` plus the assignment evidence files with ids returned by `plan_issues` or by `harness_inspector(action: "export")`.

`10-supervisor-tick-dry-run.json` proves the read-only decision path, while `11-supervisor-run-execute.json` is the no-human runtime entrypoint that owns dashboard inspection, queue promotion, bounded dispatch, and assignment execution through the configured runner command. HarnessOS sets `HARNESS_*` evidence paths for the command and refuses to close `done` unless test, E2E, and run-scoped CSQR-lite proof files are produced.
