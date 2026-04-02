---
name: context-management
description: "Rules and strategies for managing agent context window size, avoiding bloat, and preserving signal-to-noise ratio."
---
# Context Management Skill

## Purpose
Prevent context window bloat and maintain a high signal-to-noise ratio during long agent sessions.

## Use when
- Working on tasks spanning multiple files or long sessions
- Intermediate tool outputs are large (logs, test results, file contents)
- Context window is approaching capacity
- Planning multi-step operations

## Core Principles

1. **Read what you need, not everything** — read specific line ranges instead of full files
2. **Summarize before inject** — transform large outputs into compact summaries before returning to context
3. **Forget what's done** — completed subtask details do not need to persist in active context
4. **Reference, don't inline** — point to files and line numbers instead of copying content

## Rules

### File Reading
- **Max initial read**: 200 lines per file for orientation; use targeted reads after
- **Prefer `grep_search`** over full file reads when looking for specific patterns
- **Never read the same file twice** in the same task unless it was modified between reads

### Tool Output
- **Filter before returning**: pipe large outputs through aggregation (see `programmatic-tool-calling` skill)
- **Cap output**: when running commands, limit output length (`head -n 50`, `tail -n 20`)
- **Summarize test runs**: report pass/fail count + only failing test details, not full green output

### Multi-file Operations
- **Batch reads**: read related files in parallel, not sequentially
- **Work in phases**: complete one component before moving to the next; don't keep all files in working memory
- **Update incrementally**: modify files one at a time, verify each before proceeding

### Planning Long Tasks
- **Create a plan artifact first** — offload the plan to a file instead of keeping it in context
- **Reference issue IDs** (`M1-I3`) instead of re-describing tasks
- **Checkpoint progress** in session logs so context can be reconstructed if needed

## Warning Signs (Context Bloat)

| Sign | Action |
|------|--------|
| Repeating information the agent already stated | Context is too large — summarize and drop old details |
| Tool outputs exceeding 100 lines | Filter before returning |
| Reading 5+ full files without processing | Switch to targeted reads |
| Agent "forgetting" earlier decisions | Checkpoint to file, reference it |

## Token Budget Heuristics

Use simple budgeting rules instead of waiting until the window is already polluted:

| Situation | Practical heuristic |
|------|--------|
| Large repo exploration | keep the active working set under ~5 files at once |
| Command output | keep only pass/fail summary plus failing details |
| Multi-phase task | checkpoint after each phase and drop solved details |
| Repeated docs/spec references | reference the file path and section instead of pasting it again |

## HarnessOS Session Reset Pattern

For long tasks, prefer this loop:

1. plan or checkpoint the current phase
2. persist the important decision in `progress.md`, `plan.md`, or a Harness checkpoint
3. clear the active mental stack
4. reopen only the files needed for the next phase

That is usually better than carrying the full earlier implementation and test history in active context.

## Related Skills
- **`programmatic-tool-calling`** — use code orchestration to filter intermediate data
- **`planning-tracking`** — offload plans to files instead of context
- **`session-logging`** — checkpoint progress for context reconstruction
- **`harness-lifecycle`** — use canonical checkpoints and handoffs instead of bloated chat memory

## Done Criteria
- No raw, unprocessed tool outputs exceeding 100 lines in context
- Plans and progress tracked in files, not only in memory
- File reads are targeted, not blanket

## Anti-patterns
- Reading entire files when only specific functions are needed
- Returning raw `npm test` output (hundreds of lines) to context
- Re-reading files that haven't changed
- Keeping completed subtask details in active reasoning
- Carrying old release/debug context forward after it has already been checkpointed elsewhere
