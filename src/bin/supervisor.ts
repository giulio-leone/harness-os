#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import {
  orchestrationSupervisorRunInputSchema,
  orchestrationSupervisorTickInputSchema,
} from '../contracts/orchestration-contracts.js';
import {
  runOrchestrationSupervisor,
  runOrchestrationSupervisorTick,
} from '../runtime/orchestration-supervisor.js';

const supervisorCliCommandSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('tick'),
      input: orchestrationSupervisorTickInputSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('run'),
      input: orchestrationSupervisorRunInputSchema,
    })
    .strict(),
]);

type SupervisorCliCommand = z.infer<typeof supervisorCliCommandSchema>;

async function main(): Promise<void> {
  const rawPayload = await readCommandPayload(process.argv.slice(2));
  const payload = supervisorCliCommandSchema.parse(
    JSON.parse(rawPayload) as unknown,
  );
  const result = await executeSupervisorCommand(payload);

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify(formatSupervisorCliError(error), null, 2)}\n`);
  process.exit(1);
});

async function executeSupervisorCommand(
  command: SupervisorCliCommand,
): Promise<Record<string, unknown>> {
  switch (command.action) {
    case 'tick':
      return {
        action: command.action,
        result: await runOrchestrationSupervisorTick(command.input),
      };
    case 'run':
      return {
        action: command.action,
        result: await runOrchestrationSupervisor(command.input),
      };
  }
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

function formatSupervisorCliError(error: unknown): Record<string, unknown> {
  if (error instanceof z.ZodError) {
    return {
      error: 'Invalid supervisor command payload',
      issues: error.issues,
    };
  }

  return {
    error: error instanceof Error ? error.message : String(error),
  };
}
