---
name: rollback-rca
description: "Stop ineffective iteration loops and choose a controlled recovery path after repeated gate failures."
---
# Rollback & RCA Skill

## Purpose
Stop ineffective iteration loops and choose a controlled recovery path after repeated gate failures.

## Use when
- An issue fails completion gate 3 consecutive times

## Procedure
1. Stop work on the issue immediately.
2. Run root cause analysis:
   - Architecture mismatch?
   - Dependency/environment problem?
   - Scope too broad?
3. Present options via the runtime's designated question tool (e.g., `ask_user`, `#askQuestion`), which is MANDATORY:
   - Rescope (split into smaller sub-issues)
   - Rollback (revert to last known good commit)
   - Redesign (change architecture)
4. Execute selected path and document rationale in session log.

## Related Skills
- **`completion-gate`** — this skill triggers when the gate fails 3 times consecutively
- **`session-logging`** — document the rollback rationale and recovery path in the session journal

## Rollback Rules
- Keep history clean and revertible.
- Roll back only to the last commit that passed gate.
- Record rollback cause and follow-up plan.

## Done Criteria
- Issue has an approved recovery path and documented rationale.

## Anti-patterns
- Blindly retrying same failing strategy
- Silent rollback without traceability
- Continuing without user alignment
