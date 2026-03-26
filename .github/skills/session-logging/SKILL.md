---
name: session-logging
description: "Accurate, auditable execution journal for each working session."
---
# Session Logging Skill

## Purpose
Maintain an accurate, auditable execution journal for each working session.

## Use when
- Starting/ending a session
- Completing issues/milestones
- Syncing GitHub status

## Required File
`sessions-<ISO-date>.md`

## Required Sections
- Status (milestone states)
- Work Completed (`[mX/iY]` references)
- Completion Gate Passed (include ✅ and consecutive-pass evidence)
- Decisions Made
- Blockers
- GitHub Sync (created/closed/updated issue IDs)
- Branch
- Date (ISO timestamp)

## Template

```markdown
# Session — <ISO-date>

## Status
- M1: in_progress (2/3 issues done)
- M2: todo

## Work Completed
- [M1/I1] Set up project scaffold ✅
- [M1/I2] Implement core module ✅
- [M1/I3] Unit tests — in progress

## Completion Gate Passed
- M1/I1: ✅ 2 consecutive clean passes (run 1: 0 errors, run 2: 0 errors)
- M1/I2: ✅ 2 consecutive clean passes (run 1: 0 errors, run 2: 0 errors)

## Decisions Made
- Chose adapter pattern over inheritance for extensibility (interaction-loop option 1)

## Blockers
- None

## GitHub Sync
- Created: #12, #13, #14
- Closed: #12, #13
- Updated: #14 (status → in-progress)

## Branch
`feature/core-module`

## Date
<ISO-8601 timestamp>
```

## Procedure
1. Create/update the session file at session start and after meaningful milestones.
2. Keep entries factual and aligned with plan/GitHub state.
3. Record gate-pass evidence per completed issue.

## Done Criteria
- Session file reflects real progress and traceable references.

## Related Skills
- **`github-sync`** — ensure the GitHub Sync section in the session log is aligned with actual GitHub milestone/issue state

## Harness Handoff

When using the `harness-lifecycle` pattern, every session must append a structured handoff block to `progress.md` **before ending**. This is the cross-session memory that allows the next context window to quickly get up to speed.

### Handoff Format

```markdown
## Session [N] — YYYY-MM-DD

### Done
- [Feature/task description with concrete outcome]

### Next
- [Highest-priority incomplete feature to pick up]

### Blockers
- [Any issues that prevent progress, or "None"]
```

### Rules
1. Write the handoff **after** committing code and updating `feature_list.json`.
2. The `Done` section must reference specific features or issue IDs.
3. The `Next` section must point to a single, actionable next step.
4. Never end a session without writing the handoff.

## Anti-patterns
- Retroactive guesswork
- Missing gate evidence
- Inconsistent milestone/issue IDs
- Ending a session without writing a handoff to `progress.md`
