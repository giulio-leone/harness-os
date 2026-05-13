#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import { symphonyAssignmentRunnerInputSchema } from '../contracts/orchestration-assignment-runner-contracts.js';
import { runSymphonyAssignment } from '../runtime/orchestration-assignment-runner.js';

const assignmentRunnerCliCommandSchema = z
  .object({
    action: z.literal('run_assignment'),
    input: symphonyAssignmentRunnerInputSchema,
  })
  .strict();

type AssignmentRunnerCliCommand = z.infer<
  typeof assignmentRunnerCliCommandSchema
>;

async function main(): Promise<void> {
  const rawPayload = await readCommandPayload(process.argv.slice(2));
  const payload = assignmentRunnerCliCommandSchema.parse(
    JSON.parse(rawPayload) as unknown,
  );
  const result = await executeAssignmentRunnerCommand(payload);

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify(formatAssignmentRunnerCliError(error), null, 2)}\n`,
  );
  process.exit(1);
});

async function executeAssignmentRunnerCommand(
  command: AssignmentRunnerCliCommand,
): Promise<Record<string, unknown>> {
  return {
    action: command.action,
    result: await runSymphonyAssignment(command.input),
  };
}

async function readCommandPayload(argv: string[]): Promise<string> {
  const inputFlagIndex = argv.indexOf('--input');

  if (inputFlagIndex !== -1) {
    const inputPath = argv[inputFlagIndex + 1];

    if (inputPath === undefined) {
      throw new Error('Missing value for --input');
    }

    return readFile(inputPath, 'utf8');
  }

  if (process.stdin.isTTY) {
    throw new Error('Provide a JSON payload on stdin or with --input <path>');
  }

  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf8');
}

function formatAssignmentRunnerCliError(error: unknown): Record<string, unknown> {
  if (error instanceof z.ZodError) {
    return {
      error: 'Invalid assignment runner command payload',
      issues: error.issues,
    };
  }

  return {
    error: error instanceof Error ? error.message : String(error),
  };
}
