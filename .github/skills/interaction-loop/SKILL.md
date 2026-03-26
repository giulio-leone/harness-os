---
name: interaction-loop
description: "Iterative decision loop with consistent user checkpoints and explicit stop criteria."
---
# Interaction Loop Skill

## Purpose
Enforce a strict iterative decision loop with consistent user checkpoints and explicit stop criteria.

## Use when
- Starting a new task
- Hitting a decision point
- Completing an autonomous run

## Checklist
- Ask exactly one clear question per iteration using the runtime's designated question tool (e.g., `ask_user`, `vscode_askQuestions`), which is MANDATORY.
- Provide exactly 5 options by default:
  1) Recommended Development Path (mark with ⭐)
  2) Alternative Development Path A
  3) Alternative Development Path B
  4) Freeform (label must be exactly "Freeform", enum value `custom` to type directly inline)
  5) Autonomous Mode
- Escalation: Use the Compatibility Triad (Non-Breaking, Breaking, Alternative Structural) for options 1-3 ONLY when assessing contract impact or architectural reshaping. Options 4 and 5 must remain Freeform and Autonomous Mode.
- Each option card must include: `Why`, `Leads to`, and `Risk` level (low/medium/high).
- **Autonomous Mode Implementation**:
  - Execute the entire issue (implementation + tests + quality gate) as a single uninterrupted block.
  - Do **NOT** stop for intermediate feedback, confirmation, or progress updates.
  - Mandatory end-of-issue feedback: After completion, ask for rating, deliverable review, next action, and explicit satisfaction.
- Continue iterating until the exact stop phrase is provided: **"I am satisfied"**.

## Short examples
- Start-of-task question: "Which path should I execute first?" (5 options above).
- End-of-run question: "Rate this result, choose the next action, and confirm satisfaction."

## Related Skills
- **`breaking-change-paths`** — when the Compatibility Triad is used for options 1-3, read this skill for the full decision procedure

## Done Criteria
- User has explicitly said "I am satisfied" and the loop has terminated.

## Anti-patterns
- Multi-question prompts in one iteration
- Missing one or more of the 5 mandatory options
- Stopping without explicit "I am satisfied"
