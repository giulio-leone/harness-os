---
name: testing-policy
description: "Deterministic, CI-ready quality verification with no regressions and no coverage drop."
---
# Testing Policy Skill

## Purpose
Guarantee deterministic, CI-ready quality verification with no regressions and no coverage drop.

## Use when
- Implementing or modifying any feature/fix
- Preparing issue closure or PR merge

## Required Test Layers
- Unit tests (business logic/utilities/pure functions)
- Integration tests (APIs/DB/cross-module flows, when applicable)
- E2E tests (user-facing/critical flows, when applicable)
- Non-regression checks (previously passing tests must remain green)

## Procedure
1. **Before changes**: run full suite and record baseline (totals + line/branch coverage).
2. Implement changes and add/update tests.
3. **After changes**: rerun full suite and produce diff (added/removed/broken tests + coverage delta).
4. If any previously passing test breaks or coverage drops, fix before completion.
5. Ensure tests are deterministic, isolated, non-interactive, and CI-compatible.

## E2E Notes
- Cover happy path + key edge/error cases for each critical flow.
- Prefer stable selectors (`data-testid`) over fragile CSS/DOM coupling.

## Done Criteria
- Full suite green, no regressions, coverage >= baseline.

## Related Skills
- **`e2e-testing`** — detailed E2E checklist for critical user flows (stable selectors, CI-compatible, deterministic setup/teardown)
- **`completion-gate`** — the quality gate that requires all tests to pass before closing issues/PRs

## Anti-patterns
- Manual-only validation
- Flaky timeout-driven E2E
- Merging with coverage regression
