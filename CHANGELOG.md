# Changelog

All notable changes to this project are documented in this file.

## 2.0.1 - 2026-04-01

### Fixed
- `harness_session(action: "begin")` and `harness_session(action: "begin_recovery")` now auto-generate a canonical `sessionId` when the caller omits it, instead of failing with an invalid-arguments error on `sessionId`.
- Updated MCP discoverability, packaged skills, and example payloads so clients no longer treat `sessionId` as a required field for new session claims.

## 2.0.0 - 2026-04-01

### Breaking Changes
- `harness_orchestrator(action: "plan_issues")` now accepts only the canonical `milestones[]` batch shape, even for single-milestone imports.
- Removed the legacy top-level planning payload based on `milestoneDescription` and `issues`.

### Added
- Added first-class cross-milestone planning with `depends_on_milestone_keys` for local batch edges and `depends_on_milestone_ids` for dependencies on already imported milestones.
- Added queue promotion gating on both issue dependencies and milestone dependencies so downstream work is unlocked only when its parent milestone is actually complete.
- Added skill and discoverability updates for the packaged `.github/skills` guidance and the capability catalog exposed through `harness_inspector(action: "capabilities")`.

### Changed
- Updated the MCP schema, runtime descriptions, architecture docs, and consumer workspace template to treat batch-first planning as the only canonical contract.
- Updated milestone status synchronization so parent and child milestones stay aligned with live queue state during imports, promotions, and issue transitions.

## 1.1.0 - 2026-03-31

### Added
- Added installable multi-host MCP setup for Codex, Copilot CLI, and antigravity.
- Added `harness_inspector(action: "capabilities")` for agent-readable tool, skill, and mem0 discovery.
- Added canonical session artifact paths and aligned admin mem0 snapshot and rollup scopes with the runtime session scopes.
