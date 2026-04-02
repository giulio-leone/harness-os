# Changelog

All notable changes to this project are documented in this file.

## 2.0.5 - 2026-04-03

### Fixed
- Fixed the `harness_orchestrator` MCP dispatch path so `init_workspace`, `create_campaign`, and `plan_issues` no longer re-parse strict action-less payload schemas with the top-level `action` field still attached.
- Pinned MCP runtime database resolution to the host-configured `HARNESS_DB_PATH` whenever the host provides one, preventing Copilot CLI and other MCP clients from drifting into hallucinated per-session SQLite paths.
- Added MCP-level regression coverage for the canonical `init_workspace -> create_campaign` setup flow and for conflicting `dbPath` overrides under a pinned host database.

## 2.0.4 - 2026-04-03

### Fixed
- Flattened MCP mega-tool input schemas at the public boundary so Copilot CLI receives top-level JSON Schema objects without unsupported `oneOf` / `anyOf` combinators.
- Normalized discriminated mega-tool action schemas into strict object-root function definitions while preserving runtime Zod validation for all HarnessOS MCP tools.
- Restored out-of-the-box `agent-harness` compatibility for Copilot CLI sessions that failed during tool registration before any prompt execution.

## 2.0.3 - 2026-04-02

### Breaking Path Rollback
- This release supersedes the withdrawn `v8.0.0` GitHub cut and keeps the public package on the `2.x` line.
- Public package versioning now stays decoupled from internal schema, contract, and workload-profile version cuts. Runtime boundaries remain explicit, but they no longer force a new package major by themselves.

### Added
- Added authoritative MCP and CLI discovery docs in `docs/mcp-tools.md` and `docs/cli-reference.md`.
- Added stronger workload-profile and bundled-skill discoverability docs, including profile selection guidance, skill membership tables, and cross-links to the packaged skill index.
- Expanded key bundled skills with concrete HarnessOS examples for error handling, context management, programmatic tool calling, policy coherence, and prompt bindings.

### Changed
- Published the schema v5 / workflow-metadata / workload-profile / reference-workspace tranche on the public `2.x` version line instead of `8.0.0`.
- Reframed README, getting-started, architecture, release, and workload-profile docs so public package versioning is easier to explain while MCP tools, CLIs, workload profiles, and skills are easier to discover.

## 8.0.0 - 2026-04-02

> Withdrawn public package cut. The technical content below was rolled forward into `2.0.3` on the public version line.

### Breaking Changes
- HarnessOS now enforces SQLite schema v5 as the only supported runtime store contract. Recreate older databases to adopt first-class issue/milestone workflow metadata columns.
- `plan_issues`, scheduler-injected jobs, and inspector outputs now model `deadlineAt`, `recipients`, `approvals`, and `externalRefs` as top-level issue/milestone fields instead of burying deadlines inside `policy`.
- `policy.deadlineAt` is removed from the public policy contract. Deadlines remain dispatch-aware, but they now come from the canonical work-item field instead of `policy_json`.

### Added
- Added typed workflow metadata contracts for recipients, approvals, external references, and deadlines, with shared validation across public plan schemas, planner inputs, scheduler jobs, inspector outputs, and next-action context.
- Added first-class SQLite persistence for issue and milestone workflow metadata through `deadline_at`, `recipients_json`, `approvals_json`, and `external_refs_json`.
- Added bundled reference workspaces for `assistant`, `research`, `ops`, and `support`, including metadata-rich live catalogs, domain-specific workflows/schemas, and workload-specific handoff assets under `examples/`.
- Added `docs/workload-profiles.md` plus regression coverage for shipped reference templates and metadata-capable example seeders.

### Changed
- Policy-aware dispatch, export/audit surfaces, and next-action reasoning now read issue deadlines from the canonical work-item field while preserving policy-driven escalation, owner, SLA, and dispatch behavior.
- Generated plan examples and public contract docs now show workflow metadata on issues and milestones instead of the removed `policy.deadlineAt` shape.
- Example `seed-live-catalog.py` flows now persist `deadlineAt`, `recipients`, `approvals`, and `externalRefs` into the canonical SQLite issue columns for the shipped reference workspaces.
- Public quick starts and architecture guidance now present non-coding workload profiles as first-class runtime paths instead of centering the product story on coding-only flows.

## 7.0.0 - 2026-04-02

### Breaking Changes
- Host bundle selection is now workload-profile driven. The old singleton `runtime-default` profile-pack concept is removed, and host sync config now requires schemaVersion `3` with an explicit `selectedWorkloadProfile`.
- `harness-sync` now installs only the skills required by the selected workload profile and prunes the rest atomically, so old all-skills host installs are replaced by the canonical profile selection on the next sync.
- Host metadata no longer records `installedProfilePackIds`; it now persists the selected workload profile plus its installed version and checksum.

### Added
- Added six explicit bundled workload profiles (`coding`, `research`, `ops`, `sales`, `support`, `assistant`) with versioned guidance and skill membership in the canonical bundle manifest.
- Added profile-aware capability catalog metadata and profile filtering so bundled skills now expose `workloadProfileIds` instead of the removed pack metadata.
- Added interactive workload-profile selection to `harness-setup` and optional `HARNESS_WORKLOAD_PROFILE` wiring in MCP host installation.

### Changed
- The bundled skill manifest now publishes `workloadProfiles` and per-skill `workloadProfileIds`, replacing the removed `profilePacks` / `profilePackIds` fields.
- Public package metadata, packed-artifact smoke coverage, and host sync flows now validate the selected workload profile version/checksum as part of the release cut.

## 6.0.0 - 2026-04-02

### Breaking Changes
- Session-lifecycle claim and recovery payloads now use a generic `artifacts` array instead of the removed coding-specific `progressPath`, `featureListPath`, `planPath`, and `syncManifestPath` fields.
- `harness_session(action: "begin" | "begin_recovery")` and the JSON session-lifecycle CLI now reject the removed fixed artifact-path fields at the public boundary.

### Added
- Added first-class `SessionArtifactReference` contracts so lifecycle callers can pass typed artifact references for any workload domain instead of only coding-shaped files.
- Added regression coverage for the new generic artifact contract across lifecycle CLI, MCP mega-tool, and session context payloads.

### Changed
- Public examples, generated contract docs, bundled skill metadata, and release notes now align with the `6.0.0` session-lifecycle contract cut.
- Host-aware routing remains required for claim and recovery flows, but it now composes with the generic artifact contract instead of the old fixed file-path shape.

## 5.0.0 - 2026-04-02

### Breaking Changes
- Session-lifecycle claim and recovery entrypoints now require explicit host routing context. Public `begin_incremental` / `begin_recovery` payloads and `harness_session(action: "begin" | "begin_recovery")` calls must provide both `host` and `hostCapabilities`.
- `harness_inspector(action: "next_action")` is now host-aware for dispatch decisions, so callers must provide the same routing context when they want actionable claim guidance for workload-routed queues.
- Harness policy now includes first-class `dispatch` rules for workload classes and required host capabilities. Preferred-issue claims and recovery attempts fail fast when the selected host cannot legally run the work.

### Added
- Added policy-driven dispatch rules for `workloadClass` and `requiredHostCapabilities`, plus runtime normalization for host capability inputs.
- Added host-aware `dispatch_mismatch` next-action reasoning so the inspector can explain why a queue is blocked for the current host and surface candidate mismatch details.
- Added regression coverage for host-routed claims, mismatch rejection, and host-aware mega-tool guidance.

### Changed
- Ready and recovery selection now filter by dispatch eligibility before normal queue ordering, keeping policy ordering intact while ensuring host capabilities actively influence lease claims.
- Public examples, generated contract docs, packaged bundle metadata, and release notes now align with the `5.0.0` session-lifecycle contract cut.

## 4.0.0 - 2026-04-02

### Breaking Changes
- HarnessOS now enforces schema v4 as the only supported SQLite contract. Opening a v3 database fails fast with an explicit recreate instruction instead of attempting any in-place migration.
- Harness MCP mega-tool inputs and session-lifecycle CLI payloads now reject unknown or removed public fields immediately instead of tolerating legacy shapes.
- `harness-sync` now requires the versioned host config written by `harness-setup`; legacy flat `{"hosts":["/path"]}` configs are rejected until they are explicitly rewritten through setup.
- Session-lifecycle CLI payloads now require `contractVersion: "4.0.0"` at the public boundary; missing or stale payload versions are rejected immediately.
- The read-only observability surface was cut over to the new export/audit/health model. MCP callers must use `harness_inspector(action: "export" | "audit" | "health_snapshot")`, and CLI callers must use `inspect_export`, `inspect_audit`, and `inspect_health_snapshot` instead of the removed `overview`/`issue` inspection contract.
- Campaigns and issues now persist operational policy in first-class `policy_json` columns, so legacy schema snapshots without the new policy contract are no longer accepted.

### Added
- Added explicit `blocked_reason` persistence for dependency, milestone, recovery, and campaign-drain blockers so issues and milestones can expose concrete blocked-by causes.
- Added regression drills for the hard-break v2 rejection path and for the blocker lifecycle that clears stale reasons when dependencies complete.
- Added a canonical public contract model that now renders the MCP tool catalog, session-lifecycle example payloads, and generated README/getting-started reference sections from one source.
- Added packed-artifact release smoke coverage that `npm pack`s the package, installs the tarball, executes the published CLIs, and exercises Codex, Copilot CLI, and antigravity host integration against the installed artifact.
- Added a canonical bundled-skill manifest and versioned `runtime-default` profile pack so the packaged skill bundle ships as a tracked release artifact instead of loose host-side docs.
- Added `docs/release-playbooks.md` as the canonical hard-cut release checklist and contract-enforcement reference for breaking releases.
- Added typed policy controls for campaign defaults, issue overrides, and scheduler-injected work so queues can carry owners, deadlines, service expectations, and escalation rules as canonical runtime data.

### Changed
- Queue promotion now recomputes blocker reasons deterministically and clears stale `blocked_reason` values when dependents become ready again.
- MCP tool schemas, capability metadata, and rendered public examples/docs now stay aligned through the shared contract definitions used at the validation boundary.
- `harness_inspector(action: "next_action")` now returns structured issue, milestone, blocker, and lease context so recommendations are auditable and point to the exact dependency or recovery cause.
- `harness_inspector(action: "export")`, `audit`, `health_snapshot`, and `next_action` now expose machine-readable observability data, including effective policy state, normalized issue audit timelines, operational alerts, and policy breach summaries aligned with lease claim selection.
- Queue planning and scheduler injection now accept the same typed `policy` contract, and campaign defaults merge into issue overrides before dispatch decisions are made.
- The release workflow now blocks `npm publish` on the full typecheck and test suite, including the packed-artifact smoke gate.
- `harness-sync` now writes and validates `skills/bundle-manifest.json` on every host, exposes installed bundle/profile metadata through the tracked host config, and prunes non-manifest legacy files instead of silently leaving them behind.
- The canonical release gate is now `npm run verify:release`, which keeps the hard-cut docs/examples/installers aligned with the tested artifact before publish.

### Fixed
- The published `harness-setup` bin now recognizes its public npm bin name when launched from an installed package, so interactive host setup works from the shipped artifact and not only from the source filename.

## 2.0.2 - 2026-04-01

### Fixed
- Restored `#!/usr/bin/env node` shebangs on the published CLI entrypoints so global installs expose directly executable bins again.
- Added packaging regression coverage for built CLI entrypoints to prevent future releases from shipping non-executable JS bin shims.

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
