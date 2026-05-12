import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createSymphonyWorkflowReloader,
  loadSymphonyWorkflow,
  loadSymphonyWorkflowFromText,
  renderSymphonyWorkflowPrompt,
  resolveSymphonyWorkflowPath,
  SymphonyWorkflowError,
  symphonyWorkflowConfigSchema,
  symphonyWorkflowDocumentSchema,
  symphonyWorkflowReloadResultSchema,
} from '../index.js';

const loadedAt = new Date('2026-05-12T12:00:00.000Z');

test('resolveSymphonyWorkflowPath defaults to WORKFLOW.md in cwd and accepts explicit paths', () => {
  assert.equal(
    resolveSymphonyWorkflowPath({ cwd: '/workspace/repo' }),
    '/workspace/repo/WORKFLOW.md',
  );
  assert.equal(
    resolveSymphonyWorkflowPath({
      cwd: '/workspace/repo',
      workflowPath: 'ops/SYMPHONY.md',
    }),
    '/workspace/repo/ops/SYMPHONY.md',
  );
  assert.equal(
    resolveSymphonyWorkflowPath({
      cwd: '/workspace/repo',
      workflowPath: '/tmp/custom/WORKFLOW.md',
    }),
    '/tmp/custom/WORKFLOW.md',
  );
});

test('loadSymphonyWorkflow parses optional YAML front matter and trims prompt body', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'symphony-workflow-'));
  try {
    const workflowPath = join(tempDir, 'WORKFLOW.md');
    writeFileSync(
      workflowPath,
      [
        '---',
        'tracker:',
        '  kind: linear',
        '  api_key: $LINEAR_TOKEN',
        '  project_slug: harness-os',
        'polling:',
        '  interval_ms: 5000',
        'workspace:',
        '  root: ./workspaces',
        'hooks:',
        '  before_run: |',
        '    npm test',
        'agent:',
        '  max_concurrent_agents: 4',
        '  max_concurrent_agents_by_state:',
        '    Todo: 2',
        '    invalid: 0',
        '    stringInvalid: "3"',
        'codex:',
        '  command: "$CODEX_BIN app-server"',
        'unknownFutureKey:',
        '  enabled: true',
        '---',
        '',
        'You are working on {{ issue.identifier }}.',
        '',
      ].join('\n'),
      'utf8',
    );

    const workflow = loadSymphonyWorkflow({
      cwd: tempDir,
      env: { LINEAR_TOKEN: 'linear-secret', CODEX_BIN: '/usr/bin/codex' },
      now: () => loadedAt,
    });

    assert.equal(workflow.contractVersion, '1.0.0');
    assert.equal(workflow.source.path, workflowPath);
    assert.equal(workflow.source.directory, tempDir);
    assert.equal(workflow.source.loadedAt, loadedAt.toISOString());
    assert.equal(workflow.config.tracker.kind, 'linear');
    assert.equal(workflow.config.tracker.endpoint, 'https://api.linear.app/graphql');
    assert.equal(workflow.config.tracker.apiKey, 'linear-secret');
    assert.equal(workflow.config.tracker.projectSlug, 'harness-os');
    assert.equal(workflow.config.polling.intervalMs, 5000);
    assert.equal(workflow.config.workspace.root, join(tempDir, 'workspaces'));
    assert.equal(workflow.config.hooks.beforeRun, 'npm test\n');
    assert.equal(workflow.config.agent.maxConcurrentAgents, 4);
    assert.deepEqual(workflow.config.agent.maxConcurrentAgentsByState, { todo: 2 });
    assert.equal(workflow.config.codex.command, '$CODEX_BIN app-server');
    assert.equal(workflow.promptTemplate, 'You are working on {{ issue.identifier }}.');
    assert.equal('unknownFutureKey' in workflow.config, false);
    assert.equal(symphonyWorkflowDocumentSchema.safeParse(workflow).success, true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('loadSymphonyWorkflowFromText applies defaults without front matter and ignores body delimiters', () => {
  const workflow = loadSymphonyWorkflowFromText({
    workflowPath: '/workspace/repo/WORKFLOW.md',
    content: '\uFEFFTitle\n---\nBody delimiter should remain prompt content.\n',
    now: () => loadedAt,
  });

  assert.equal(workflow.rawConfig && Object.keys(workflow.rawConfig).length, 0);
  assert.equal(
    workflow.promptTemplate,
    'Title\n---\nBody delimiter should remain prompt content.',
  );
  assert.equal(workflow.config.polling.intervalMs, 30_000);
  assert.equal(workflow.config.workspace.root, join(tmpdir(), 'symphony_workspaces'));
  assert.equal(workflow.config.hooks.timeoutMs, 60_000);
  assert.equal(workflow.config.agent.maxConcurrentAgents, 10);
  assert.equal(workflow.config.agent.maxTurns, 20);
  assert.equal(workflow.config.agent.maxRetryBackoffMs, 300_000);
  assert.equal(workflow.config.codex.command, 'codex app-server');
  assert.equal(workflow.config.codex.turnTimeoutMs, 3_600_000);
  assert.equal(workflow.config.codex.readTimeoutMs, 5_000);
  assert.equal(workflow.config.codex.stallTimeoutMs, 300_000);
});

test('loadSymphonyWorkflow reports typed workflow file and YAML errors', () => {
  assert.throws(
    () => loadSymphonyWorkflow({ workflowPath: '/tmp/missing-symphony-workflow.md' }),
    (error: unknown) =>
      error instanceof SymphonyWorkflowError &&
      error.code === 'missing_workflow_file',
  );
  assert.throws(
    () =>
      loadSymphonyWorkflowFromText({
        workflowPath: '/workspace/repo/WORKFLOW.md',
        content: '---\ntracker: [\n---\nPrompt',
      }),
    (error: unknown) =>
      error instanceof SymphonyWorkflowError &&
      error.code === 'workflow_parse_error',
  );
  assert.throws(
    () =>
      loadSymphonyWorkflowFromText({
        workflowPath: '/workspace/repo/WORKFLOW.md',
        content: '---\n- not\n- a map\n---\nPrompt',
      }),
    (error: unknown) =>
      error instanceof SymphonyWorkflowError &&
      error.code === 'workflow_front_matter_not_a_map',
  );
  assert.throws(
    () =>
      loadSymphonyWorkflowFromText({
        workflowPath: '/workspace/repo/WORKFLOW.md',
        content: '---\ntracker:\n  api_key: $MISSING_TOKEN\n---\nPrompt',
        env: {},
      }),
    (error: unknown) =>
      error instanceof SymphonyWorkflowError &&
      error.code === 'workflow_config_error' &&
      error.message.includes('MISSING_TOKEN'),
  );
  assert.throws(
    () =>
      loadSymphonyWorkflowFromText({
        workflowPath: '/workspace/repo/WORKFLOW.md',
        content: '---\nworkspace: []\n---\nPrompt',
      }),
    (error: unknown) =>
      error instanceof SymphonyWorkflowError &&
      error.code === 'workflow_config_error' &&
      error.message.includes('workspace'),
  );
  assert.throws(
    () =>
      loadSymphonyWorkflowFromText({
        workflowPath: '/workspace/repo/WORKFLOW.md',
        content: '---\npolling:\n  interval_ms: "5000"\n---\nPrompt',
      }),
    (error: unknown) =>
      error instanceof SymphonyWorkflowError &&
      error.code === 'workflow_config_error' &&
      error.message.includes('interval_ms'),
  );
});

test('renderSymphonyWorkflowPrompt resolves strict issue and attempt variables', () => {
  const rendered = renderSymphonyWorkflowPrompt(
    'Issue {{ issue.identifier }}: {{ issue.title }} attempt={{ attempt }} labels={{ issue.labels }}',
    {
      issue: {
        identifier: 'HAR-77',
        title: 'Add workflow contracts',
        labels: ['symphony', 'workflow'],
      },
      attempt: 2,
    },
  );

  assert.equal(
    rendered,
    'Issue HAR-77: Add workflow contracts attempt=2 labels=["symphony","workflow"]',
  );
  assert.equal(
    renderSymphonyWorkflowPrompt('first attempt={{ attempt }}', {
      issue: { identifier: 'HAR-77' },
    }),
    'first attempt=',
  );
});

test('renderSymphonyWorkflowPrompt fails unknown variables, filters, tags, comments, and invalid expressions', () => {
  assert.throws(
    () => renderSymphonyWorkflowPrompt('{{ issue.missing }}', { issue: {} }),
    (error: unknown) =>
      error instanceof SymphonyWorkflowError &&
      error.code === 'template_render_error',
  );
  assert.throws(
    () => renderSymphonyWorkflowPrompt('{{ issue.title | upcase }}', { issue: { title: 'A' } }),
    (error: unknown) =>
      error instanceof SymphonyWorkflowError &&
      error.code === 'template_parse_error',
  );
  assert.throws(
    () => renderSymphonyWorkflowPrompt('{% if issue.title %}A{% endif %}', { issue: { title: 'A' } }),
    (error: unknown) =>
      error instanceof SymphonyWorkflowError &&
      error.code === 'template_parse_error',
  );
  assert.throws(
    () => renderSymphonyWorkflowPrompt('{# comment #}', { issue: { title: 'A' } }),
    (error: unknown) =>
      error instanceof SymphonyWorkflowError &&
      error.code === 'template_parse_error',
  );
  assert.throws(
    () => renderSymphonyWorkflowPrompt('{{ issue[0] }}', { issue: { title: 'A' } }),
    (error: unknown) =>
      error instanceof SymphonyWorkflowError &&
      error.code === 'template_parse_error',
  );
});

test('createSymphonyWorkflowReloader reloads by content hash and keeps last known good on errors', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'symphony-reloader-'));
  try {
    const workflowPath = join(tempDir, 'WORKFLOW.md');
    writeFileSync(
      workflowPath,
      '---\nworkspace:\n  root: ./first\n---\nFirst {{ issue.identifier }}\n',
      'utf8',
    );
    const reloader = createSymphonyWorkflowReloader({
      workflowPath,
      now: () => loadedAt,
    });

    const loaded = reloader.load();
    assert.equal(loaded.status, 'loaded');
    assert.equal(loaded.workflow.config.workspace.root, join(tempDir, 'first'));
    assert.equal(symphonyWorkflowReloadResultSchema.safeParse(loaded).success, true);

    const unchanged = reloader.reloadIfChanged();
    assert.equal(unchanged.status, 'unchanged');
    assert.equal(unchanged.workflow.source.hash, loaded.workflow.source.hash);

    writeFileSync(
      workflowPath,
      '---\nworkspace:\n  root: ./second\n---\nSecond {{ issue.identifier }}\n',
      'utf8',
    );
    const reloaded = reloader.reloadIfChanged();
    assert.equal(reloaded.status, 'reloaded');
    assert.equal(reloaded.workflow.config.workspace.root, join(tempDir, 'second'));
    assert.notEqual(reloaded.workflow.source.hash, loaded.workflow.source.hash);

    writeFileSync(workflowPath, '---\ntracker: [\n---\nBroken\n', 'utf8');
    const failed = reloader.reloadIfChanged();
    assert.equal(failed.status, 'failed');
    assert.equal(failed.workflow?.config.workspace.root, join(tempDir, 'second'));
    assert.equal(failed.error.code, 'workflow_parse_error');
    assert.equal(reloader.getLastKnownGood()?.config.workspace.root, join(tempDir, 'second'));

    unlinkSync(workflowPath);
    const missing = reloader.reloadIfChanged();
    assert.equal(missing.status, 'failed');
    assert.equal(missing.workflow?.config.workspace.root, join(tempDir, 'second'));
    assert.equal(missing.error.code, 'missing_workflow_file');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('symphony workflow schemas reject invalid effective config values', () => {
  const parsed = symphonyWorkflowConfigSchema.safeParse({
    workspace: { root: '/tmp/workspaces' },
    polling: { intervalMs: 0 },
  });

  assert.equal(parsed.success, false);
});

test('symphony workflow config preserves SPEC stall detection disablement', () => {
  const workflow = loadSymphonyWorkflowFromText({
    workflowPath: '/workspace/repo/WORKFLOW.md',
    content: '---\ncodex:\n  stall_timeout_ms: 0\n---\nPrompt',
  });

  assert.equal(workflow.config.codex.stallTimeoutMs, 0);
});
