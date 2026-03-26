---
name: github-sync
description: "Keep local plan and GitHub project artifacts perfectly aligned with milestones, issues, labels, and statuses."
---
# GitHub Sync Skill

## Purpose
Keep local plan and GitHub project artifacts perfectly aligned (milestones, issues, labels, statuses, dependencies).

## Use when
- Creating/updating plan
- Changing issue status
- Completing milestones

## Naming Rules
- Milestone: `M<id> — <description>`
- Issue: `[M<milestone_id>] I<issue_id> — <task>`

## Required Metadata
- Priority label: `P-critical|P-high|P-medium|P-low`
- Type label: `feat|fix|refactor|chore|test`
- Status label: `in-progress|review|blocked`
- Size label: `size-S|size-M|size-L|size-XL`
- Milestone link
- Dependency note: `depends on #<issue_number>`
- Parent/child note: `part of #<issue_number>`

## Default Label Set

Create these labels at project setup:

| Label | Color | Category |
|-------|-------|----------|
| `P-critical` | `#b60205` | Priority |
| `P-high` | `#d93f0b` | Priority |
| `P-medium` | `#fbca04` | Priority |
| `P-low` | `#0e8a16` | Priority |
| `feat` | `#1d76db` | Type |
| `fix` | `#e11d48` | Type |
| `refactor` | `#5319e7` | Type |
| `chore` | `#6b7280` | Type |
| `test` | `#0d9488` | Type |
| `in-progress` | `#ededed` | Status |
| `review` | `#fbca04` | Status |
| `blocked` | `#b60205` | Status |
| `size-S` | `#c2e0c6` | Size |
| `size-M` | `#bfd4f2` | Size |
| `size-L` | `#d4c5f9` | Size |
| `size-XL` | `#f9d0c4` | Size |

## Procedure
1. On plan create/update, create/update corresponding GitHub milestones/issues.
2. On local issue status change, sync GitHub status + labels immediately.
3. Close milestone when all linked issues are done.
4. Ensure no orphan issues (every issue belongs to a milestone).

## Done Criteria
- Local plan == GitHub state (titles, labels, status, dependencies).

## Anti-patterns
- Local-only tracking
- Orphan issues
- Stale labels/status
