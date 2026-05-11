# Hard-Cut Release Playbooks

HarnessOS treats breaking releases as **single-cut upgrades**. We do not keep long deprecation windows alive once a public contract has been replaced.

## Canonical release gate

Run this exact gate before publishing a breaking release:

```bash
npm run contracts:render
npm run skills:render
npm run verify:release
```

`npm run verify:release` is the canonical release verification entrypoint. It must stay green before `npm publish`.

## Package version policy

HarnessOS keeps the public npm package on the **2.x** line. Internal contract cuts still use their own explicit versions (`schema v5`, `contractVersion: "6.0.0"`, workload-profile bundle versions, and so on), and release notes must explain both the public package version and the internal contract boundaries it ships.

## Hard-cut upgrade path

When a breaking release lands, update all public surfaces atomically:

1. **Release notes** — update `CHANGELOG.md` with the single supported upgrade path.
2. **Examples** — regenerate `examples/session-lifecycle/*.json` from the canonical contract model.
3. **Installers** — keep `harness-install-mcp`, `harness-setup`, and `harness-sync` aligned with the cutover.
4. **Bundle assets** — regenerate `.github/skills/bundle-manifest.json`.
5. **Verification** — rerun the canonical release gate.

## Fail-fast contract boundaries

| Surface | Canonical source | Hard-cut behavior |
| --- | --- | --- |
| Session-lifecycle CLI payloads | `src/runtime/session-lifecycle-cli.schemas.ts` | Every payload must declare `contractVersion: "6.0.0"` and stale or missing versions are rejected immediately; `begin_incremental` / `begin_recovery` payloads must include explicit `host` and `hostCapabilities` routing context plus the generic `artifacts` array instead of removed fixed path fields. |
| Harness MCP tools | `src/runtime/harness-tool-contracts.ts` | Inputs are `.strict()` and unknown or removed fields fail at the public boundary. |
| SQLite runtime store | `src/db/store.ts` | Only schema v5 is supported; older DBs fail with an explicit recreate instruction. |
| Issue/milestone workflow metadata | `src/contracts/workflow-contracts.ts` + `src/runtime/harness-planning-tools.ts` | `deadlineAt`, `recipients`, `approvals`, and `externalRefs` are first-class issue/milestone fields; `policy.deadlineAt` is removed and rejected at the public boundary. |
| Host sync config | `src/bin/agent-harness-setup.ts` | `harness-sync` rejects legacy host configs until `harness-setup` rewrites them to schemaVersion 3 with an explicit `selectedWorkloadProfile`. |
| Bundled skills | `src/runtime/bundled-skill-manifest.ts` | Hosts must match `bundle-manifest.json`; drifted or outdated assets are replaced explicitly. |

## Release checklist for breaking cuts

1. Bump or confirm the intended contract/version constants for the cutover.
2. Update installers, docs, and generated examples in the same change.
3. Remove the deprecated path instead of keeping an adapter window alive.
4. Document the single supported upgrade/recreate path in `CHANGELOG.md`.
5. Run `npm run verify:release`.

## Current hard-cut migrations

- **SQLite v4 -> v5**: recreate the harness database instead of migrating in place so issue and milestone workflow metadata columns (`deadline_at`, `recipients_json`, `approvals_json`, `external_refs_json`) become canonical.
- **Issue/milestone workflow metadata cutover**: move deadlines out of `policy.deadlineAt`, send `deadlineAt` / `recipients` / `approvals` / `externalRefs` as top-level issue or milestone fields, and regenerate generated contract examples before publishing.
- **Legacy host sync config -> schemaVersion 3**: rerun `harness-setup`, select the canonical workload profile for each host, then rerun `harness-sync`.
- **Bundled skill packs -> workload profiles**: replace the removed `runtime-default` pack metadata with `workloadProfiles` / `workloadProfileIds`, and let host sync prune skills to the selected workload profile atomically.
- **Session-lifecycle CLI payloads -> contractVersion 6.0.0**: regenerate examples and update any external payload producers before invoking the CLI.
- **Generic artifact contract cutover**: replace `progressPath`, `featureListPath`, `planPath`, and `syncManifestPath` with the new `artifacts[{ kind, path }]` payload before calling `begin_incremental` or `begin_recovery`.
- **Host-aware dispatch routing**: update external `begin_incremental`, `begin_recovery`, and host-aware `next_action` callers to send explicit `host` and `hostCapabilities` values that match the target execution environment.
- **Observability inspection cutover**: replace `overview` / `issue` and `inspect_overview` / `inspect_issue` consumers with `export` / `audit` / `health_snapshot` and `inspect_export` / `inspect_audit` / `inspect_health_snapshot`.
