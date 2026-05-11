# Symphony-style orchestration MCP examples

These payloads document the stable fully agentic orchestration handoff:

1. discover Symphony support and required dispatch fields;
2. create workspace/campaign scope;
3. compile tracker-style milestones and slices;
4. inject the compiled queue with `plan_issues`;
5. dispatch up to four `gpt-5-high` subagents into isolated worktree assignments;
6. save deterministic evidence artifacts, including CSQR-lite scorecards for completed runs;
7. inspect evidence-backed orchestration health.

Each JSON file is shaped as:

```json
{
  "tool": "harness_symphony",
  "input": {
    "action": "dispatch_ready"
  }
}
```

Pass the `input` object to the named MCP `tool`. The examples are parse-tested against the public MCP schemas; replace placeholder workspace/campaign ids with values returned by setup calls, and replace placeholder issue ids in `05-dispatch-ready.json` / `07-save-assignment-screenshot.json` with ids returned by `plan_issues` or by `harness_inspector(action: "export")`.

HarnessOS records deterministic assignment/worktree metadata, but the host remains responsible for physical `git worktree add`, subagent process launch, tests, E2E screenshot capture, evidence file creation, and cleanup.
