---
name: breaking-change-paths
description: "Structured decision process between Non-Breaking and Breaking paths without relaxing quality gates."
---
# Breaking Change Decision Skill

## Purpose
Run a structured, future-proof decision process between Non-Breaking and Breaking paths without relaxing quality gates.

## Use when
- A task may affect public contracts, APIs, schemas, or behavioral compatibility
- Root-cause fixes suggest architectural reshaping

## Checklist
- Explicitly classify impact: Non-Breaking vs Breaking vs Alternative Structural.
- Present the decision using the 5-option Compatibility Triad (Non-Breaking, Breaking, Alternative Structural, Freeform, Autonomous Mode).
- For the Triad options, include:
  - pros/cons
  - risk level
  - migration steps
- State explicitly: quality gates are unchanged for both paths.
- Require green unit/integration/E2E/non-regression tests in both cases.
- If Breaking is selected, include migration and compatibility notes before execution.

## Short examples
- Non-Breaking path: adapter layer preserving old contract while introducing new internals.
- Breaking path: remove deprecated endpoint + provide migration map + test updates.

## Anti-patterns
- Assuming breaking path without explicit selection
- Treating breaking changes as exempt from test gates
- Missing migration guidance
