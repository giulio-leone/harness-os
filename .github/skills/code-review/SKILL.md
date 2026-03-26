---
name: code-review
description: "Structured code review checklist covering correctness, security, performance, and maintainability."
---
# Code Review Skill

## Purpose
Provide a structured, repeatable code review checklist that ensures no critical concern is overlooked.

## Use when
- Reviewing a PR or code change (self-review or peer review)
- Before running the completion gate
- When the agent generates a batch of code changes

## Review Checklist

### 1. Correctness
- [ ] Code does what the task/issue requires — no more, no less
- [ ] Edge cases handled (null, empty, boundary values, negative numbers)
- [ ] Error paths return meaningful errors, not silent failures
- [ ] State mutations are intentional and documented

### 2. Security
- [ ] No secrets, tokens, or credentials in code or comments
- [ ] User input is validated and sanitized before use
- [ ] SQL/NoSQL queries use parameterized inputs (no string concatenation)
- [ ] Authentication/authorization checks are present where required
- [ ] Dependencies are from trusted sources and pinned to specific versions

### 3. Performance
- [ ] No unnecessary loops, re-renders, or redundant computations
- [ ] Database queries are indexed and bounded (no unbounded SELECTs)
- [ ] Large data sets are paginated or streamed
- [ ] Async operations use proper concurrency control (no unhandled promises)

### 4. Maintainability
- [ ] Functions/classes have single responsibility
- [ ] Names are descriptive (no `temp`, `data2`, `handleStuff`)
- [ ] Comments explain "why", not "what" (code should be self-documenting)
- [ ] Dead code and unused imports are removed
- [ ] Magic numbers/strings are extracted to named constants

### 5. Testing
- [ ] New/changed logic has corresponding unit tests
- [ ] Tests cover happy path + at least one error/edge case
- [ ] Tests are deterministic (no timing dependencies, random values)
- [ ] Test names describe the scenario, not the implementation

### 6. Consistency
- [ ] Follows existing project patterns and conventions
- [ ] File/folder structure matches project organization
- [ ] Linting/formatting passes with zero warnings

## Severity Classification

| Severity | Action | Examples |
|----------|--------|---------|
| **Blocker** | Must fix before merge | Security vulnerability, data loss risk, crash |
| **Major** | Should fix before merge | Logic error, missing validation, performance issue |
| **Minor** | Can fix in follow-up | Naming improvement, documentation gap |
| **Nit** | Optional, author's discretion | Style preference, alternative approach suggestion |

## Done Criteria
- All **Blocker** and **Major** items are resolved
- **Minor** items have tracking issues created if deferred
- Reviewer has explicitly approved

## Anti-patterns
- Rubber-stamp approvals without reading the code
- Reviewing only the diff without understanding the broader context
- Blocking on style nits while missing logic errors
- Reviewing 500+ line PRs in one pass (split first)
