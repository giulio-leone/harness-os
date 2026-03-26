---
name: git-workflow
description: "Branch naming, commit messages, PR conventions, and merge strategy for clean, traceable git history."
---
# Git Workflow Skill

## Purpose
Enforce clean, traceable git history with consistent branch naming, commit messages, and PR conventions.

## Use when
- Creating branches
- Writing commit messages
- Opening or merging PRs
- Deciding merge strategy

## Branch Naming

Format: `<type>/<issue-id>-<short-description>`

| Type | Use for |
|------|---------|
| `feat/` | New features |
| `fix/` | Bug fixes |
| `refactor/` | Code restructuring without behavior change |
| `chore/` | Build, CI, tooling, dependencies |
| `test/` | Test additions or fixes |
| `docs/` | Documentation only |
| `hotfix/` | Urgent production fixes |

**Examples**:
- `feat/M1-I3-user-authentication`
- `fix/M2-I1-null-pointer-on-empty-list`
- `chore/update-eslint-config`

## Commit Messages

Format: `<type>(<scope>): <description>`

Rules:
- **Type**: same as branch types above
- **Scope**: module or component affected (optional but recommended)
- **Description**: imperative present tense, lowercase, no period
- **Max length**: 72 characters for the subject line
- **Body**: optional; explain "why" not "what" — wrap at 80 characters

**Examples**:
```
feat(auth): add JWT refresh token rotation
fix(api): prevent duplicate webhook delivery on retry
refactor(db): extract query builder from repository layer
chore(deps): bump express from 4.18 to 4.21
```

**Multi-line example**:
```
fix(payments): handle race condition in concurrent refunds

Two simultaneous refund requests could both succeed because the
balance check was not atomic. Wrapped in a database transaction
with SELECT FOR UPDATE to prevent double-spending.

Closes #42
```

## PR Conventions

### Title
Same format as commit: `<type>(<scope>): <description>`

### Description Template
```markdown
## What
Brief description of the change.

## Why
Context: what problem this solves or what feature it delivers.

## How
Key implementation decisions (not a line-by-line walkthrough).

## Testing
- [ ] Unit tests added/updated
- [ ] Integration tests (if applicable)
- [ ] Manual verification steps

## Related
- Closes #<issue_number>
- Depends on #<pr_number> (if any)
```

### PR Size
- **Target**: < 400 lines changed
- **Hard limit**: > 800 lines → must split into stacked PRs
- **Exception**: auto-generated files (lock files, migrations) excluded from count

## Merge Strategy

| Scenario | Strategy |
|----------|----------|
| Feature branch → main | **Squash merge** (clean history) |
| Long-lived branch → main | **Merge commit** (preserve branch history) |
| Hotfix → main | **Fast-forward** or **squash** |
| main → feature branch (sync) | **Rebase** (keep linear history) |

## Related Skills
- **`github-sync`** — label and milestone alignment for issues/PRs
- **`completion-gate`** — quality gate before merge

## Done Criteria
- Branch follows naming convention
- All commits follow message format
- PR has description, linked issues, and passes quality gate

## Anti-patterns
- Generic branch names (`my-branch`, `wip`, `test2`)
- Commit messages like `fix`, `update`, `wip`, `asdf`
- PRs with 1000+ lines and no split
- Force-pushing to shared branches
