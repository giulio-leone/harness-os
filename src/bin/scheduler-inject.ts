#!/usr/bin/env node
import { resolve } from 'node:path';

import { runHarnessScheduler } from '../runtime/harness-scheduler.js';

async function main(): Promise<void> {
  const dbPath = process.env.HARNESS_DB_PATH;
  const configPath = process.env.HARNESS_CRON_PATH;

  if (dbPath === undefined || configPath === undefined) {
    throw new Error('Missing HARNESS_DB_PATH or HARNESS_CRON_PATH');
  }

  const result = runHarnessScheduler({
    dbPath: resolve(process.cwd(), dbPath),
    configPath: resolve(process.cwd(), configPath),
  });

  console.log(
    `Loaded ${result.loadedJobs} scheduled jobs; ${result.insertedIssues.length} injected, ${result.skippedJobs.length} skipped.`,
  );

  for (const issue of result.insertedIssues) {
    console.log(
      `Injected scheduled task ${issue.task} as ${issue.issueId} for ${issue.scheduledFor}.`,
    );
  }

  for (const skipped of result.skippedJobs) {
    console.log(`Skipped ${skipped.task}: ${skipped.reason}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
