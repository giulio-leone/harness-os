---
name: completion-gate
description: "Mandatory quality gate for every Issue, Milestone, and PR with zero-error execution and no technical debt carry-over."
---
# Universal Completion Gate Skill

## Purpose
Enforce a mandatory quality gate for every Issue, Milestone, and PR with zero-error execution and no technical debt carry-over.

## Use when
- Closing an issue
- Marking a milestone as done
- Opening/merging a PR

## Mandatory Gate (no exceptions)
1. **Double consecutive review**: two full consecutive passes **in the same session** with **0 errors**, **0 warnings**, and **no code changes between the two passes**. Both passes must be recorded as evidence.
2. **Complete Audit**: After passing the two consecutive reviews, perform a comprehensive audit to verify that everything went as expected and the desired outcome is fully achieved.
3. Fix all new issues and all pre-existing issues in touched scope.
4. Lint/type-check/build/static analysis pass with 0 errors/0 warnings.
5. Required tests pass (unit, integration if applicable, E2E if applicable, non-regression).
6. Full suite passes; coverage is not below baseline.

## Procedure
1. Run full review/check suite (= Pass 1).
2. If any error/warning exists, fix and restart from step 1 (counter resets).
3. If Pass 1 is clean, immediately run the suite again **without modifying code** (= Pass 2).
4. If Pass 2 is also clean, record both results as gate evidence and mark status `done`/merge.
5. If Pass 2 fails, investigate the flaky/non-deterministic cause, fix, and restart from step 1.

## Done Criteria
- Two consecutive clean review passes are documented.
- No unresolved pre-existing issues in touched scope.

## Harness Verification

When using the `harness-lifecycle` pattern, an additional rule applies:

> A feature is only `"passes": true` in `feature_list.json` if a **real test execution** (unit, integration, or e2e) confirms it works. Code review alone is insufficient. The agent must have **run** the tests, not just inspected the code.

## Related Skills
- **`testing-policy`** — defines the required test layers (unit/integration/E2E/non-regression) that must pass during this gate
- **`harness-lifecycle`** — defines the two-phase lifecycle that uses this gate for feature verification

## Anti-patterns
- Single-pass approval
- Ignoring warnings
- Deferring known issues to “later”
