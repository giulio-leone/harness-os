# Orchestration dashboard

HarnessOS ships a full Next.js dashboard under `apps/dashboard` for the Symphony-style orchestration read model. The app is intentionally separate from the core package so React and Next.js do not become runtime dependencies of `harness-os`.

## What it renders

- campaign scope and aggregate issue counts;
- stable ordered issue lanes from `orchestrationDashboardLaneOrder`;
- issue cards with priority, size, active leases, worktree paths, artifact kinds, CSQR scorecards, blockers, and next actions;
- active-agent lease cards with expired/primary status;
- evidence counters for worktrees, packets, screenshots, E2E reports, state exports, and CSQR-lite scorecards;
- recent orchestration events and health flags.

The UI consumes `loadOrchestrationDashboardViewModel()` and `buildOrchestrationDashboardViewModel()` from `harness-os/orchestration`; it does not recompute orchestration relationships from raw SQLite rows.

## Run it locally

From the repository root:

```bash
npm run dashboard:install
npm run dashboard:dev
```

Without environment variables, the app renders a deterministic demo campaign that exercises every important UI state. To point it at a live HarnessOS database:

```bash
HARNESS_DASHBOARD_DB_PATH="$HOME/.agent-harness/harness.sqlite" \
HARNESS_DASHBOARD_PROJECT_ID="harness-os" \
HARNESS_DASHBOARD_CAMPAIGN_ID="symphony-dashboard" \
npm run dashboard:dev
```

Optional scope variables:

| Variable | Meaning |
| --- | --- |
| `HARNESS_DASHBOARD_CAMPAIGN_ID` | Restrict the read model to one campaign. |
| `HARNESS_DASHBOARD_ISSUE_ID` | Restrict the read model to one issue. |
| `HARNESS_DASHBOARD_EVENT_LIMIT` | Recent event count, default `40`; must be a positive integer. |

## Quality gate

Use the dashboard gate whenever dashboard files change:

```bash
npm run dashboard:verify
```

The root script rebuilds the core package first, installs the app from its committed lockfile, then runs app typecheck, server-rendered UI tests, boundary tests, and `next build`.

For release hardening, run both:

```bash
npm run verify:release
npm run dashboard:verify
```
