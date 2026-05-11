# Orchestration dashboard

HarnessOS ships a full Next.js dashboard under `apps/dashboard` for the Symphony-style orchestration read model. The app is intentionally separate from the core package so React and Next.js do not become runtime dependencies of `harness-os`.

## What it renders

- campaign scope and aggregate issue counts;
- stable ordered issue lanes from `orchestrationDashboardLaneOrder`;
- issue cards with priority, size, active leases, worktree paths, artifact kinds, CSQR scorecards, blockers, and next actions;
- active-agent lease cards with expired/primary status;
- evidence counters for worktrees, packets, screenshots, E2E reports, state exports, and CSQR-lite scorecards;
- recent orchestration events and health flags;
- a live create-ticket form that inserts real `ready` issues into the configured project/campaign scope.

The UI consumes `loadOrchestrationDashboardViewModel()` and `buildOrchestrationDashboardViewModel()` from `harness-os/orchestration`; it does not recompute orchestration relationships from raw SQLite rows. Write actions use the server-only `harness-os/dashboard-server` package subpath so the Next.js app can create scoped tickets without importing the MCP server bundle.

## Run it locally

From the repository root:

```bash
npm run dashboard:install
```

Without environment variables, the app renders a setup screen instead of sample data. Start it with a live HarnessOS database:

```bash
HARNESS_DASHBOARD_DB_PATH="$HOME/.agent-harness/harness.sqlite" \
HARNESS_DASHBOARD_PROJECT_ID="P-09c1da36-0432-4633-82d4-7109e7474559" \
HARNESS_DASHBOARD_CAMPAIGN_ID="C-4ba66c16-2b7f-41a0-9b66-6bc9e91a556f" \
npm run dashboard:dev
```

The deterministic sample campaign is available only when explicitly requested:

```bash
HARNESS_DASHBOARD_DEMO=1 npm run dashboard:dev
```

In live mode, the create-ticket form writes directly to the configured SQLite database. New dashboard-created tickets are standalone `ready` issues with no milestone dependency, scoped to `HARNESS_DASHBOARD_PROJECT_ID` and the optional `HARNESS_DASHBOARD_CAMPAIGN_ID`. Demo mode renders the form disabled so sample data cannot be mistaken for mutable state.

Optional scope variables:

| Variable | Meaning |
| --- | --- |
| `HARNESS_DASHBOARD_CAMPAIGN_ID` | Restrict the read model to one campaign. |
| `HARNESS_DASHBOARD_ISSUE_ID` | Restrict the read model to one issue. |
| `HARNESS_DASHBOARD_EVENT_LIMIT` | Recent event count, default `40`; must be a positive integer. |
| `HARNESS_DASHBOARD_DEMO` | Set to `1`, `true`, or `yes` to render sample data instead of requiring a live DB. |

## Quality gate

Use the dashboard gate whenever dashboard files change:

```bash
npm run dashboard:verify
```

The root script rebuilds the core package first, installs the app from its committed lockfile, then runs app typecheck, server-rendered UI tests, ticket-writer integration tests, boundary tests, and `next build`.

For release hardening, run both:

```bash
npm run verify:release
npm run dashboard:verify
```
