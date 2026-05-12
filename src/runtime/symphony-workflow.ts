import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  resolve,
} from 'node:path';

import { parseDocument } from 'yaml';
import { z } from 'zod';

import {
  symphonyWorkflowConfigSchema,
  symphonyWorkflowContractVersion,
  type SymphonyWorkflowConfig,
  type SymphonyWorkflowDocument,
  type SymphonyWorkflowErrorCode,
  type SymphonyWorkflowReloadResult,
} from '../contracts/symphony-workflow-contracts.js';

type Environment = Record<string, string | undefined>;
type SymphonyWorkflowReloadErrorPayload = Extract<
  SymphonyWorkflowReloadResult,
  { status: 'failed' }
>['error'];

export interface SymphonyWorkflowLoadOptions {
  workflowPath?: string;
  cwd?: string;
  env?: Environment;
  now?: () => Date;
}

export interface SymphonyWorkflowTextLoadOptions {
  content: string;
  workflowPath: string;
  env?: Environment;
  now?: () => Date;
}

export interface SymphonyWorkflowPromptRenderInput {
  issue: Record<string, unknown>;
  attempt?: number | null;
}

export interface SymphonyWorkflowReloader {
  load: () => SymphonyWorkflowReloadResult;
  reloadIfChanged: () => SymphonyWorkflowReloadResult;
  getLastKnownGood: () => SymphonyWorkflowDocument | undefined;
}

interface WorkflowSource {
  path: string;
  content: string;
  hash: string;
}

interface FrontMatterSplit {
  frontMatter: Record<string, unknown>;
  promptTemplate: string;
}

export class SymphonyWorkflowError extends Error {
  constructor(
    public readonly code: SymphonyWorkflowErrorCode,
    message: string,
    public readonly issues: string[] = [],
  ) {
    super(message);
  }
}

export function resolveSymphonyWorkflowPath(
  options: Pick<SymphonyWorkflowLoadOptions, 'workflowPath' | 'cwd'> = {},
): string {
  if (options.workflowPath !== undefined) {
    return isAbsolute(options.workflowPath)
      ? normalize(options.workflowPath)
      : resolve(options.cwd ?? process.cwd(), options.workflowPath);
  }

  return resolve(options.cwd ?? process.cwd(), 'WORKFLOW.md');
}

export function loadSymphonyWorkflow(
  options: SymphonyWorkflowLoadOptions = {},
): SymphonyWorkflowDocument {
  const workflowPath = resolveSymphonyWorkflowPath(options);
  return loadSymphonyWorkflowSource(readWorkflowSource(workflowPath), options);
}

export function loadSymphonyWorkflowFromText(
  options: SymphonyWorkflowTextLoadOptions,
): SymphonyWorkflowDocument {
  const workflowPath = isAbsolute(options.workflowPath)
    ? normalize(options.workflowPath)
    : resolve(options.workflowPath);
  const content = stripByteOrderMark(options.content);

  return loadSymphonyWorkflowSource(
    {
      path: workflowPath,
      content,
      hash: sha256(content),
    },
    options,
  );
}

export function renderSymphonyWorkflowPrompt(
  workflowOrTemplate: SymphonyWorkflowDocument | string,
  input: SymphonyWorkflowPromptRenderInput,
): string {
  const template =
    typeof workflowOrTemplate === 'string'
      ? workflowOrTemplate
      : workflowOrTemplate.promptTemplate;

  if (/{%[\s\S]*?%}/.test(template) || /{#[\s\S]*?#}/.test(template)) {
    throw new SymphonyWorkflowError(
      'template_parse_error',
      'Unsupported Liquid tags or comments in Symphony workflow prompt.',
    );
  }

  return template.replace(/{{([\s\S]*?)}}/g, (_match, expression: string) => {
    const trimmedExpression = expression.trim();
    if (trimmedExpression.length === 0) {
      throw new SymphonyWorkflowError(
        'template_parse_error',
        'Empty prompt template interpolation is not supported.',
      );
    }
    if (trimmedExpression.includes('|')) {
      throw new SymphonyWorkflowError(
        'template_parse_error',
        `Unsupported prompt template filter in "${trimmedExpression}".`,
      );
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(trimmedExpression)) {
      throw new SymphonyWorkflowError(
        'template_parse_error',
        `Invalid prompt template expression "${trimmedExpression}".`,
      );
    }

    return stringifyPromptValue(
      resolvePromptValue(
        {
          issue: input.issue,
          attempt: input.attempt ?? null,
        },
        trimmedExpression,
      ),
    );
  });
}

export function createSymphonyWorkflowReloader(
  options: SymphonyWorkflowLoadOptions = {},
): SymphonyWorkflowReloader {
  const workflowPath = resolveSymphonyWorkflowPath(options);
  let lastKnownGood: SymphonyWorkflowDocument | undefined;

  const loadWithStatus = (
    successfulStatus: Extract<SymphonyWorkflowReloadResult['status'], 'loaded' | 'reloaded'>,
    skipUnchanged: boolean,
  ): SymphonyWorkflowReloadResult => {
    try {
      const source = readWorkflowSource(workflowPath);
      if (skipUnchanged && lastKnownGood?.source.hash === source.hash) {
        return {
          status: 'unchanged',
          workflow: lastKnownGood,
        };
      }

      const workflow = loadSymphonyWorkflowSource(source, options);
      lastKnownGood = workflow;

      return {
        status: successfulStatus,
        workflow,
      };
    } catch (error) {
      return {
        status: 'failed',
        workflow: lastKnownGood,
        error: toReloadError(error),
      };
    }
  };

  return {
    load: () => loadWithStatus('loaded', false),
    reloadIfChanged: () =>
      loadWithStatus(lastKnownGood === undefined ? 'loaded' : 'reloaded', true),
    getLastKnownGood: () => lastKnownGood,
  };
}

function readWorkflowSource(workflowPath: string): WorkflowSource {
  if (!existsSync(workflowPath)) {
    throw new SymphonyWorkflowError(
      'missing_workflow_file',
      `Symphony workflow file does not exist: ${workflowPath}`,
    );
  }

  const content = stripByteOrderMark(readFileSync(workflowPath, 'utf8'));

  return {
    path: workflowPath,
    content,
    hash: sha256(content),
  };
}

function loadSymphonyWorkflowSource(
  source: WorkflowSource,
  options: Pick<SymphonyWorkflowLoadOptions, 'env' | 'now'>,
): SymphonyWorkflowDocument {
  const split = splitWorkflowFrontMatter(source.content);
  const config = buildEffectiveConfig({
    rawConfig: split.frontMatter,
    workflowPath: source.path,
    env: options.env ?? process.env,
  });

  return {
    contractVersion: symphonyWorkflowContractVersion,
    source: {
      path: source.path,
      directory: dirname(source.path),
      hash: source.hash,
      loadedAt: (options.now?.() ?? new Date()).toISOString(),
    },
    rawConfig: split.frontMatter,
    config,
    promptTemplate: split.promptTemplate,
  };
}

function splitWorkflowFrontMatter(content: string): FrontMatterSplit {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    return {
      frontMatter: {},
      promptTemplate: content.trim(),
    };
  }

  const closingDelimiterIndex = lines
    .slice(1)
    .findIndex((line) => line.trim() === '---');
  if (closingDelimiterIndex === -1) {
    throw new SymphonyWorkflowError(
      'workflow_parse_error',
      'Symphony workflow front matter is missing a closing delimiter.',
    );
  }

  const closingLineIndex = closingDelimiterIndex + 1;
  const frontMatterText = lines.slice(1, closingLineIndex).join('\n');
  const promptTemplate = lines.slice(closingLineIndex + 1).join('\n').trim();
  const document = parseDocument(frontMatterText, {
    prettyErrors: false,
    strict: true,
  });

  if (document.errors.length > 0) {
    throw new SymphonyWorkflowError(
      'workflow_parse_error',
      'Failed to parse Symphony workflow YAML front matter.',
      document.errors.map((error) => error.message),
    );
  }

  const parsedFrontMatter = document.toJS() as unknown;
  if (parsedFrontMatter === null || parsedFrontMatter === undefined) {
    return {
      frontMatter: {},
      promptTemplate,
    };
  }
  if (!isRecord(parsedFrontMatter)) {
    throw new SymphonyWorkflowError(
      'workflow_front_matter_not_a_map',
      'Symphony workflow front matter must decode to an object.',
    );
  }

  return {
    frontMatter: parsedFrontMatter,
    promptTemplate,
  };
}

function buildEffectiveConfig(input: {
  rawConfig: Record<string, unknown>;
  workflowPath: string;
  env: Environment;
}): SymphonyWorkflowConfig {
  const workflowDir = dirname(input.workflowPath);
  const rawTracker = getRecord(input.rawConfig, 'tracker');
  const rawPolling = getRecord(input.rawConfig, 'polling');
  const rawWorkspace = getRecord(input.rawConfig, 'workspace');
  const rawHooks = getRecord(input.rawConfig, 'hooks');
  const rawAgent = getRecord(input.rawConfig, 'agent');
  const rawCodex = getRecord(input.rawConfig, 'codex');
  const trackerKind = getString(rawTracker, 'kind');
  const trackerApiKey = resolveTrackerApiKey(rawTracker, trackerKind, input.env);
  const workspaceRoot = resolvePathValue(
    getString(rawWorkspace, 'root') ?? join(tmpdir(), 'symphony_workspaces'),
    {
      env: input.env,
      workflowDir,
      path: ['workspace', 'root'],
    },
  );

  const candidateConfig = {
    tracker: {
      kind: trackerKind,
      endpoint:
        getString(rawTracker, 'endpoint') ??
        (trackerKind === 'linear' ? 'https://api.linear.app/graphql' : undefined),
      apiKey: trackerApiKey,
      projectSlug: getString(rawTracker, 'project_slug', 'projectSlug'),
      activeStates: getStringArray(rawTracker, 'active_states', 'activeStates'),
      terminalStates: getStringArray(
        rawTracker,
        'terminal_states',
        'terminalStates',
      ),
    },
    polling: {
      intervalMs: getNumber(rawPolling, 'interval_ms', 'intervalMs'),
    },
    workspace: {
      root: workspaceRoot,
    },
    hooks: {
      afterCreate: getString(rawHooks, 'after_create', 'afterCreate'),
      beforeRun: getString(rawHooks, 'before_run', 'beforeRun'),
      afterRun: getString(rawHooks, 'after_run', 'afterRun'),
      beforeRemove: getString(rawHooks, 'before_remove', 'beforeRemove'),
      timeoutMs: getNumber(rawHooks, 'timeout_ms', 'timeoutMs'),
    },
    agent: {
      maxConcurrentAgents: getNumber(
        rawAgent,
        'max_concurrent_agents',
        'maxConcurrentAgents',
      ),
      maxTurns: getNumber(rawAgent, 'max_turns', 'maxTurns'),
      maxRetryBackoffMs: getNumber(
        rawAgent,
        'max_retry_backoff_ms',
        'maxRetryBackoffMs',
      ),
      maxConcurrentAgentsByState: normalizePerStateConcurrency(
        getRecord(rawAgent, 'max_concurrent_agents_by_state', 'maxConcurrentAgentsByState'),
      ),
    },
    codex: {
      command: getString(rawCodex, 'command'),
      approvalPolicy: getUnknown(rawCodex, 'approval_policy', 'approvalPolicy'),
      threadSandbox: getUnknown(rawCodex, 'thread_sandbox', 'threadSandbox'),
      turnSandboxPolicy: getUnknown(
        rawCodex,
        'turn_sandbox_policy',
        'turnSandboxPolicy',
      ),
      turnTimeoutMs: getNumber(rawCodex, 'turn_timeout_ms', 'turnTimeoutMs'),
      readTimeoutMs: getNumber(rawCodex, 'read_timeout_ms', 'readTimeoutMs'),
      stallTimeoutMs: getNumber(rawCodex, 'stall_timeout_ms', 'stallTimeoutMs'),
    },
  };

  const parsed = symphonyWorkflowConfigSchema.safeParse(
    removeUndefinedDeep(candidateConfig),
  );
  if (!parsed.success) {
    throw new SymphonyWorkflowError(
      'workflow_config_error',
      'Invalid Symphony workflow configuration.',
      parsed.error.issues.map((issue) => {
        const issuePath = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
        return `${issuePath}${issue.message}`;
      }),
    );
  }

  return parsed.data;
}

function resolveTrackerApiKey(
  rawTracker: Record<string, unknown>,
  trackerKind: string | undefined,
  env: Environment,
): string | undefined {
  const configuredApiKey = getString(rawTracker, 'api_key', 'apiKey');
  if (configuredApiKey !== undefined) {
    return resolveEnvironmentReferences(configuredApiKey, {
      env,
      path: ['tracker', 'api_key'],
    });
  }

  if (trackerKind === 'linear') {
    const canonicalApiKey = env['LINEAR_API_KEY'];
    if (canonicalApiKey !== undefined && canonicalApiKey.length > 0) {
      return canonicalApiKey;
    }
  }

  return undefined;
}

function resolvePathValue(
  value: string,
  input: {
    env: Environment;
    workflowDir: string;
    path: string[];
  },
): string {
  const envResolvedValue = resolveEnvironmentReferences(value, {
    env: input.env,
    path: input.path,
  });
  const homeResolvedValue =
    envResolvedValue === '~'
      ? homedir()
      : envResolvedValue.startsWith('~/')
        ? join(homedir(), envResolvedValue.slice(2))
        : envResolvedValue;

  return normalize(
    isAbsolute(homeResolvedValue)
      ? homeResolvedValue
      : resolve(input.workflowDir, homeResolvedValue),
  );
}

function resolveEnvironmentReferences(
  value: string,
  input: {
    env: Environment;
    path: string[];
  },
): string {
  return value.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, variableName: string) => {
    const resolved = input.env[variableName];
    if (resolved === undefined || resolved.length === 0) {
      throw new SymphonyWorkflowError(
        'workflow_config_error',
        `Environment variable "${variableName}" referenced by ${input.path.join('.')} is not set.`,
      );
    }

    return resolved;
  });
}

function normalizePerStateConcurrency(
  value: Record<string, unknown> | undefined,
): Record<string, number> {
  if (value === undefined) {
    return {};
  }

  // Symphony SPEC defines invalid per-state concurrency entries as ignored.
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, number] => {
        const [, maybeNumber] = entry;
        return (
          typeof maybeNumber === 'number' &&
          Number.isInteger(maybeNumber) &&
          maybeNumber > 0
        );
      })
      .map(([state, limit]) => [state.toLowerCase(), limit]),
  );
}

function resolvePromptValue(
  context: Record<string, unknown>,
  expression: string,
): unknown {
  let value: unknown = context;
  const parts = expression.split('.');

  for (const part of parts) {
    if (!isRecord(value) || !(part in value)) {
      throw new SymphonyWorkflowError(
        'template_render_error',
        `Unknown prompt template variable "${expression}".`,
      );
    }
    value = value[part];
  }

  return value;
}

function stringifyPromptValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }

  return JSON.stringify(value);
}

function getRecord(
  source: Record<string, unknown>,
  ...keys: string[]
): Record<string, unknown> {
  for (const key of keys) {
    if (!(key in source)) {
      continue;
    }
    const value = source[key];
    if (isRecord(value)) {
      return value;
    }
    throw new SymphonyWorkflowError(
      'workflow_config_error',
      `Symphony workflow config field "${key}" must be an object.`,
    );
  }

  return {};
}

function getString(
  source: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    if (!(key in source)) {
      continue;
    }
    const value = source[key];
    if (typeof value === 'string') {
      return value;
    }
    throw new SymphonyWorkflowError(
      'workflow_config_error',
      `Symphony workflow config field "${key}" must be a string.`,
    );
  }

  return undefined;
}

function getStringArray(
  source: Record<string, unknown>,
  ...keys: string[]
): string[] | undefined {
  for (const key of keys) {
    if (!(key in source)) {
      continue;
    }
    const value = source[key];
    if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
      return value;
    }
    throw new SymphonyWorkflowError(
      'workflow_config_error',
      `Symphony workflow config field "${key}" must be an array of strings.`,
    );
  }

  return undefined;
}

function getNumber(
  source: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    if (!(key in source)) {
      continue;
    }
    const value = source[key];
    if (typeof value === 'number') {
      return value;
    }
    throw new SymphonyWorkflowError(
      'workflow_config_error',
      `Symphony workflow config field "${key}" must be a number.`,
    );
  }

  return undefined;
}

function getUnknown(
  source: Record<string, unknown>,
  ...keys: string[]
): unknown {
  for (const key of keys) {
    if (key in source) {
      return source[key];
    }
  }

  return undefined;
}

function removeUndefinedDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(removeUndefinedDeep);
  }
  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, removeUndefinedDeep(entry)]),
  );
}

function toReloadError(error: unknown): SymphonyWorkflowReloadErrorPayload {
  if (error instanceof SymphonyWorkflowError) {
    return {
      code: error.code,
      message: error.message,
      issues: error.issues,
    };
  }
  if (error instanceof z.ZodError) {
    return {
      code: 'workflow_config_error',
      message: 'Invalid Symphony workflow configuration.',
      issues: error.issues.map((issue) => {
        const issuePath = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
        return `${issuePath}${issue.message}`;
      }),
    };
  }

  return {
    code: 'workflow_parse_error',
    message: error instanceof Error ? error.message : String(error),
    issues: [],
  };
}

function stripByteOrderMark(content: string): string {
  return content.replace(/^\uFEFF/, '');
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
