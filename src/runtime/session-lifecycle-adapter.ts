import { z } from 'zod';

import type {
  IncrementalSessionInput,
  SessionCloseInput,
  SessionContext,
} from '../contracts/session-contracts.js';
import { resolveDbPath } from './harness-agentic-helpers.js';
import { sessionLifecycleCommandSchema, type SessionLifecycleCommand } from './session-lifecycle-cli.schemas.js';
import { SessionLifecycleInspector } from './session-lifecycle-inspector.js';
import { SessionOrchestrator } from './session-orchestrator.js';
import type { SessionAdvanceResult } from './session-orchestrator.js';

export class SessionLifecycleAdapter {
  constructor(
    private readonly orchestrator: SessionOrchestrator,
    private readonly inspector = new SessionLifecycleInspector(),
  ) {}

  async advanceSession(
    context: SessionContext,
    closeInput: SessionCloseInput,
    nextInput: IncrementalSessionInput,
  ): Promise<SessionAdvanceResult> {
    return this.orchestrator.advanceSession(
      { ...context, dbPath: resolveDbPath(context.dbPath) },
      closeInput,
      { ...nextInput, dbPath: resolveDbPath(nextInput.dbPath) },
    );
  }

  async execute(rawCommand: unknown): Promise<Record<string, unknown>> {
    const command = sessionLifecycleCommandSchema.parse(rawCommand);

    switch (command.action) {
      case 'begin_incremental':
        return {
          action: command.action,
          context: await this.orchestrator.beginIncrementalSession({
            ...command.input,
            dbPath: resolveDbPath(command.input.dbPath),
          }),
        };
      case 'begin_recovery':
        return {
          action: command.action,
          context: await this.orchestrator.beginRecoverySession({
            ...command.input,
            dbPath: resolveDbPath(command.input.dbPath),
          }),
        };
      case 'checkpoint':
        return {
          action: command.action,
          result: await this.orchestrator.checkpoint(
            { ...command.context, dbPath: resolveDbPath(command.context.dbPath) },
            command.input,
          ),
        };
      case 'close':
        return {
          action: command.action,
          result: await this.orchestrator.close(
            { ...command.context, dbPath: resolveDbPath(command.context.dbPath) },
            command.input,
          ),
        };
      case 'inspect_overview':
        return {
          action: command.action,
          result: this.inspector.inspectOverview({
            ...command.input,
            dbPath: resolveDbPath(command.input.dbPath),
          }),
        };
      case 'inspect_issue':
        return {
          action: command.action,
          result: this.inspector.inspectIssue({
            ...command.input,
            dbPath: resolveDbPath(command.input.dbPath),
          }),
        };
      case 'promote_queue':
        return {
          action: command.action,
          result: await this.orchestrator.promoteQueue({
            ...command.input,
            dbPath: resolveDbPath(command.input.dbPath),
          }),
        };
      default:
        return assertNever(command);
    }
  }
}

export function parseSessionLifecycleCommand(rawCommand: unknown): SessionLifecycleCommand {
  return sessionLifecycleCommandSchema.parse(rawCommand);
}

export function formatSessionLifecycleError(error: unknown): Record<string, unknown> {
  if (error instanceof z.ZodError) {
    return {
      error: 'Invalid session lifecycle command payload',
      issues: error.issues,
    };
  }

  return {
    error: error instanceof Error ? error.message : String(error),
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled session lifecycle action: ${JSON.stringify(value)}`);
}
