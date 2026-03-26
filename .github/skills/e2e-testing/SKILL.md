---
name: e2e-testing
description: "Deterministic, CI-ready end-to-end validation for critical user flows."
---
# E2E Testing Skill

## Purpose
Define deterministic, CI-ready end-to-end validation for critical user flows.

## Use when
- A user-facing flow changes
- A critical integration path is introduced or modified
- Regression risk is non-trivial

## Checklist
- Cover at least one E2E scenario per critical flow.
- Include happy path + key error/edge cases.
- Use programmatic execution only (CI-compatible, non-interactive).
- Prefer stable selectors (for example, `data-testid`).
- Keep tests deterministic and isolated with proper setup/teardown.
- Ensure E2E is part of non-regression validation before completion.

## Short examples
- Checkout flow: payment success + payment failure retry path.
- Auth flow: valid login + expired token refresh path.

## Anti-patterns
- Manual-only E2E verification
- Flaky timing-based waits without stable signals
- Skipping E2E updates after flow changes
