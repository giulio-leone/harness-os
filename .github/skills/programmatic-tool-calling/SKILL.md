---
name: programmatic-tool-calling
description: "Multi-step tool workflows via code orchestration to reduce latency, context pollution, and token overhead."
---
# Programmatic Tool Calling Skill (Model-Agnostic)

## Purpose
Execute multi-step tool workflows via code orchestration to reduce latency, context pollution, and token overhead.

## Use when
- 3+ dependent tool calls
- Large intermediate outputs (logs, tables, files)
- Branching logic, retries, or fan-out/fan-in workflows

## Core Idea
Treat tools as callable functions inside an orchestration runtime (script/runner), not as one-turn-at-a-time chat actions.

## Procedure
1. Generate/execute orchestration code for loops, conditionals, parallel calls, retries, and early termination.
2. Process intermediate data in runtime (filter/aggregate/transform) instead of returning raw data to model context.
3. Return only high-signal outputs to the model (summary, decision, artifact references).

## Example — Multi-file lint check with summary

```javascript
// Instead of N separate tool calls returning full output to context:
async function lintAllFiles(files) {
  const results = [];
  
  // Fan-out: run lint on all files in parallel
  const promises = files.map(file =>
    runTool("run_command", { cmd: `eslint ${file} --format json` })
  );
  const outputs = await Promise.allSettled(promises);
  
  // Filter: keep only failures
  for (const [i, output] of outputs.entries()) {
    if (output.status === "rejected" || output.value.exitCode !== 0) {
      const parsed = JSON.parse(output.value?.stdout || "[]");
      const errors = parsed.filter(r => r.errorCount > 0);
      if (errors.length) {
        results.push({
          file: files[i],
          errorCount: errors[0].errorCount,
          topError: errors[0].messages[0]?.message
        });
      }
    }
  }
  
  // Return only summary — not raw lint output
  return {
    totalFiles: files.length,
    failedFiles: results.length,
    failures: results  // compact: file + count + top error only
  };
}
```

**Key**: the raw lint JSON never enters the model context — only the filtered summary does.

## Why It Works (provider/model independent)
- Fewer model round-trips for multi-call workflows.
- Intermediate data stays out of context unless needed.
- Explicit code control flow is easier to test, monitor, and debug.

## Guardrails
- Strict input/output schemas.
- Validate tool results before use.
- Idempotent/retry-safe tool design when possible.
- Timeout/cancellation/expiry handling.
- Sandbox execution for untrusted code; never blindly execute external payloads.

## Done Criteria
- Workflow completes with reduced context load and deterministic control flow.

## Anti-patterns
- Returning raw intermediate payloads to the model by default
- Unbounded loops without stop conditions
- Executing unvalidated tool output
