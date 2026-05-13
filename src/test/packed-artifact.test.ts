import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  openHarnessDatabase,
  runStatement,
  SESSION_LIFECYCLE_CLI_CONTRACT_VERSION,
} from '../index.js';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

test('packed npm artifact executes installable bins and host smoke paths', async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), 'packed-artifact-'));

  try {
    const tarballPath = createPackedArtifact(tempDir);
    const installRoot = installPackedArtifact(tempDir, tarballPath);
    const packageRoot = join(installRoot, 'node_modules', 'harness-os');
    const binDir = join(installRoot, 'node_modules', '.bin');
    const bundleManifest = JSON.parse(
      readFileSync(join(packageRoot, '.github', 'skills', 'bundle-manifest.json'), 'utf8'),
    ) as {
      bundleVersion: string;
      manifestChecksum: string;
      workloadProfiles: Array<{
        id: string;
        version: string;
        checksum: string;
      }>;
    };
    const homeDir = join(tempDir, 'home');
    const stubBinDir = join(tempDir, 'stub-bin');
    const codexLogPath = join(tempDir, 'codex.log');
    const dbPath = join(homeDir, '.agent-harness', 'harness.sqlite');
    const hostWorkspace = join(tempDir, 'workspace-host');
    const cronConfigPath = join(tempDir, 'cron-jobs.json');
    const payloadPath = join(tempDir, 'inspect-export.json');

    mkdirSync(homeDir, { recursive: true });
    mkdirSync(join(homeDir, '.agent-harness'), { recursive: true });
    mkdirSync(hostWorkspace, { recursive: true });
    mkdirSync(stubBinDir, { recursive: true });
    seedSmokeDatabase(dbPath);
    writeCodexStub(join(stubBinDir, 'codex'));
    writeFileSync(
      cronConfigPath,
      `${JSON.stringify([
        {
          task: 'Nightly packed-artifact smoke test',
          cron: '0 0 1 1 *',
          projectKey: 'test-project',
          campaignName: 'Smoke Campaign',
          priority: 'low',
          size: 'S',
        },
      ], null, 2)}\n`,
      'utf8',
    );
    writeFileSync(
      payloadPath,
      `${JSON.stringify({
        contractVersion: SESSION_LIFECYCLE_CLI_CONTRACT_VERSION,
        action: 'inspect_export',
        input: {
          dbPath,
          projectId: 'project-1',
        },
      }, null, 2)}\n`,
      'utf8',
    );

    const baseEnv = {
      ...process.env,
      HOME: homeDir,
      PATH: `${stubBinDir}:${binDir}:${process.env.PATH ?? ''}`,
      CODEX_LOG_PATH: codexLogPath,
      AGENT_HARNESS_DISABLE_DEFAULT_MEM0: '1',
      HARNESS_DB_PATH: dbPath,
      HARNESS_CRON_PATH: cronConfigPath,
    };

    await t.test('installed harness-setup and harness-sync bins execute from the packed artifact', async () => {
      const setupResult = await runInteractiveSetupBin(
        join(binDir, 'harness-setup'),
        baseEnv,
        hostWorkspace,
      );

      assert.equal(setupResult.status, 0, setupResult.stderr || setupResult.stdout);
      const configPath = join(homeDir, '.agent-harness', 'config.json');
      const setupConfig = JSON.parse(readFileSync(configPath, 'utf8')) as {
        schemaVersion: number;
        hosts: Array<{
          path: string;
          selectedWorkloadProfile: string;
          installedBundleVersion: string | null;
        }>;
      };
      assert.equal(setupConfig.schemaVersion, 3);
      assert.equal(setupConfig.hosts[0]?.path, hostWorkspace);
      assert.equal(setupConfig.hosts[0]?.selectedWorkloadProfile, 'coding');
      assert.equal(setupConfig.hosts[0]?.installedBundleVersion, null);

      const syncResult = runBin(join(binDir, 'harness-sync'), [], { env: baseEnv });
      assert.equal(syncResult.status, 0, syncResult.stderr || syncResult.stdout);
      assert.equal(
        existsSync(join(hostWorkspace, 'skills', 'harness-lifecycle', 'SKILL.md')),
        true,
      );
      assert.equal(existsSync(join(hostWorkspace, 'skills', 'bundle-manifest.json')), true);
      assert.match(
        syncResult.stdout,
        new RegExp(`bundle ${bundleManifest.bundleVersion.replaceAll('.', '\\.')}`),
      );

      const syncedConfig = JSON.parse(readFileSync(configPath, 'utf8')) as {
        schemaVersion: number;
        hosts: Array<{
          path: string;
          selectedWorkloadProfile: string;
          installedBundleVersion: string | null;
          installedManifestChecksum: string | null;
          installedWorkloadProfileVersion: string | null;
          installedWorkloadProfileChecksum: string | null;
          lastSyncedAt: string | null;
        }>;
      };
      assert.equal(syncedConfig.hosts[0]?.installedBundleVersion, bundleManifest.bundleVersion);
      assert.equal(
        syncedConfig.hosts[0]?.installedManifestChecksum,
        bundleManifest.manifestChecksum,
      );
      assert.equal(syncedConfig.hosts[0]?.selectedWorkloadProfile, 'coding');
      assert.equal(
        syncedConfig.hosts[0]?.installedWorkloadProfileVersion,
        bundleManifest.workloadProfiles.find((profile) => profile.id === 'coding')?.version ?? null,
      );
      assert.equal(
        syncedConfig.hosts[0]?.installedWorkloadProfileChecksum,
        bundleManifest.workloadProfiles.find((profile) => profile.id === 'coding')?.checksum ?? null,
      );
      assert.equal(typeof syncedConfig.hosts[0]?.lastSyncedAt, 'string');
    });

    await t.test('installed harness-scheduler-inject bin executes from the packed artifact', () => {
      const result = runBin(join(binDir, 'harness-scheduler-inject'), [], {
        env: baseEnv,
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /Loaded 1 scheduled jobs;/);
    });

    await t.test('installed harness-session-lifecycle bin executes from the packed artifact', () => {
      const result = runBin(
        join(binDir, 'harness-session-lifecycle'),
        ['--input', payloadPath],
        { env: baseEnv },
      );

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const parsed = JSON.parse(result.stdout) as { action: string; result: Record<string, unknown> };
      assert.equal(parsed.action, 'inspect_export');
      assert.ok(parsed.result);
    });

    await t.test('installed harness-supervisor bin executes bounded runs from the packed artifact', () => {
      const result = runBin(join(binDir, 'harness-supervisor'), [], {
        env: baseEnv,
        input: `${JSON.stringify({
          action: 'run',
          input: {
            contractVersion: '1.0.0',
            runId: 'packed-supervisor-run',
            dbPath,
            projectId: 'project-1',
            mode: 'dry_run',
            stopCondition: {
              maxTicks: 2,
              stopWhenIdle: true,
            },
          },
        })}\n`,
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const parsed = JSON.parse(result.stdout) as {
        action: string;
        result: { runId: string; status: string; stopReason: string; tickResults: unknown[] };
      };
      assert.equal(parsed.action, 'run');
      assert.equal(parsed.result.runId, 'packed-supervisor-run');
      assert.equal(parsed.result.status, 'succeeded');
      assert.equal(parsed.result.stopReason, 'idle');
      assert.equal(parsed.result.tickResults.length, 1);
    });

    await t.test('installed harness-supervisor bin executes deterministic single ticks from the packed artifact', () => {
      const result = runBin(join(binDir, 'harness-supervisor'), [], {
        env: baseEnv,
        input: `${JSON.stringify({
          action: 'tick',
          input: {
            contractVersion: '1.0.0',
            tickId: 'packed-supervisor-tick',
            dbPath,
            projectId: 'project-1',
            mode: 'dry_run',
            stopCondition: {
              stopWhenIdle: true,
            },
          },
        })}\n`,
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const parsed = JSON.parse(result.stdout) as {
        action: string;
        result: {
          tickId: string;
          mode: string;
          stopReason: string;
          decisions: Array<{ kind: string }>;
        };
      };
      assert.equal(parsed.action, 'tick');
      assert.equal(parsed.result.tickId, 'packed-supervisor-tick');
      assert.equal(parsed.result.mode, 'dry_run');
      assert.equal(parsed.result.stopReason, 'idle');
      assert.deepEqual(
        parsed.result.decisions.map((decision) => decision.kind),
        ['inspect_dashboard', 'idle'],
      );
    });

    await t.test('installed harness-session-lifecycle-mcp bin responds over JSON-RPC', async () => {
      const messages = await smokeTestInstalledMcpServer(
        join(binDir, 'harness-session-lifecycle-mcp'),
        baseEnv,
      );
      const toolList = messages.find((message) => message.id === 2);
      const supervisorCall = messages.find((message) => message.id === 3);

      assert.ok(toolList);
      assert.equal(
        Array.isArray((toolList?.result as { tools?: unknown[] } | undefined)?.tools),
        true,
      );
      assert.equal(
        ((toolList?.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? []).some(
          (tool) => tool.name === 'harness_session',
        ),
        true,
      );
      assert.ok(supervisorCall);
      const supervisorToolResult = supervisorCall.result as {
        structuredContent?: {
          result?: {
            tickId?: string;
            mode?: string;
            stopReason?: string;
          };
        };
        isError?: boolean;
      };
      const supervisorContent = (
        supervisorToolResult as {
          structuredContent?: {
            result?: {
              tickId?: string;
              mode?: string;
              stopReason?: string;
            };
          };
        }
      ).structuredContent;
      assert.equal(supervisorToolResult.isError, false);
      assert.equal(supervisorContent?.result?.tickId, 'packed-mcp-supervisor-tick');
      assert.equal(supervisorContent?.result?.mode, 'dry_run');
      assert.equal(supervisorContent?.result?.stopReason, 'idle');
    });

    await t.test('installed package exposes orchestration root and subpath exports', () => {
      const result = runInstalledPackageScript(installRoot, baseEnv, `
        import {
          applyOrchestrationDashboardIssueFilters as applyFiltersFromRoot,
          buildSymphonyCodexAppServerCommand as buildCodexCommandFromRoot,
           buildCsqrLiteScorecard,
           buildOrchestrationDashboardViewModel,
           buildWorktreeAllocation as buildFromRoot,
           cleanupSymphonyPhysicalWorktree as cleanupPhysicalWorktreeFromRoot,
           createScriptedCodexAppServerProcessAdapter as createCodexProcessAdapterFromRoot,
           createSymphonyPhysicalWorktree as createPhysicalWorktreeFromRoot,
           createSymphonyWorkflowReloader as createReloaderFromRoot,
          createDefaultGpt5HighSubagents,
          csqrLiteDefaultCriteria,
           deriveSymphonyCodexSessionId as deriveCodexSessionFromRoot,
           loadSymphonyWorkflowFromText as loadWorkflowFromRoot,
           launchCodexAppServerRunner as launchCodexRunnerFromRoot,
           symphonyCodexRunnerTurnExecutionEnvelopeSchema as codexEnvelopeSchemaFromRoot,
           referenceOrchestrationE2eEvidenceMatrix as matrixFromRoot,
          renderSymphonyWorkflowPrompt as renderWorkflowPromptFromRoot,
          runOrchestrationSupervisor as runSupervisorFromRoot,
          runOrchestrationSupervisorTick as runSupervisorTickFromRoot,
        } from 'harness-os';
        import {
          openHarnessDatabase,
          openReadonlyHarnessDatabase,
          selectAll,
          selectOne,
          SessionOrchestrator,
        } from 'harness-os/dashboard-server';
        import {
          applyOrchestrationDashboardIssueFilters as applyFiltersFromSubpath,
          buildSymphonyCodexAppServerCommand as buildCodexCommandFromSubpath,
          buildWorktreeAllocation as buildFromSubpath,
            assertReferenceOrchestrationEvidencePacket,
            createScriptedCodexAppServerProcessAdapter as createCodexProcessAdapterFromSubpath,
            createSymphonyWorkflowReloader as createReloaderFromSubpath,
            cleanupSymphonyPhysicalWorktree as cleanupPhysicalWorktreeFromSubpath,
            csqrLiteScorecardSchema,
            createSymphonyPhysicalWorktree as createPhysicalWorktreeFromSubpath,
            deriveSymphonyCodexSessionId as deriveCodexSessionFromSubpath,
            inspectOrchestration,
           loadSymphonyWorkflowFromText as loadWorkflowFromSubpath,
           launchCodexAppServerRunner as launchCodexRunnerFromSubpath,
           symphonyCodexRunnerTurnExecutionEnvelopeSchema as codexEnvelopeSchemaFromSubpath,
           orchestrationDashboardViewModelSchema,
          orchestrationPlanSchema,
          symphonyCodexRunnerLaunchResultSchema,
          symphonyCodexRunnerTurnResultSchema,
          orchestrationSupervisorRunInputSchema,
          orchestrationSupervisorRunSummarySchema,
          orchestrationSupervisorTickInputSchema,
          orchestrationSupervisorTickResultSchema,
           renderSymphonyWorkflowPrompt as renderWorkflowPromptFromSubpath,
           symphonyWorktreeOperationResultSchema,
           symphonyWorkflowDocumentSchema,
          referenceOrchestrationE2eEvidenceMatrix as matrixFromSubpath,
          runOrchestrationSupervisor as runSupervisorFromSubpath,
          runOrchestrationSupervisorTick as runSupervisorTickFromSubpath,
        } from 'harness-os/orchestration';

        const worktree = buildFromSubpath({
          issueId: 'M4-I1 Public Exports',
          repoRoot: '/workspace/harness-os',
          worktreeRoot: '/workspace/worktrees',
          baseRef: 'main',
          branchPrefix: 'feat',
        });

        console.log(JSON.stringify({
          rootBuilderType: typeof buildFromRoot,
          assertionType: typeof assertReferenceOrchestrationEvidencePacket,
          scorecardBuilderType: typeof buildCsqrLiteScorecard,
          dashboardBuilderType: typeof buildOrchestrationDashboardViewModel,
          dashboardFilterType: typeof applyFiltersFromRoot,
          csqrCriteriaCount: csqrLiteDefaultCriteria.length,
          csqrSchemaType: typeof csqrLiteScorecardSchema.safeParse,
          dashboardSchemaType: typeof orchestrationDashboardViewModelSchema.safeParse,
          dashboardServerOpenType: typeof openHarnessDatabase,
          dashboardServerReadonlyType: typeof openReadonlyHarnessDatabase,
          dashboardServerSelectAllType: typeof selectAll,
          dashboardServerSelectOneType: typeof selectOne,
          dashboardServerOrchestratorType: typeof SessionOrchestrator,
          matrixSameReference: matrixFromRoot === matrixFromSubpath,
          filterSameReference: applyFiltersFromRoot === applyFiltersFromSubpath,
           workflowLoaderSameReference: loadWorkflowFromRoot === loadWorkflowFromSubpath,
           workflowRendererSameReference: renderWorkflowPromptFromRoot === renderWorkflowPromptFromSubpath,
           workflowReloaderSameReference: createReloaderFromRoot === createReloaderFromSubpath,
           codexCommandSameReference: buildCodexCommandFromRoot === buildCodexCommandFromSubpath,
           codexSessionSameReference: deriveCodexSessionFromRoot === deriveCodexSessionFromSubpath,
            codexProcessAdapterSameReference: createCodexProcessAdapterFromRoot === createCodexProcessAdapterFromSubpath,
            codexRunnerSameReference: launchCodexRunnerFromRoot === launchCodexRunnerFromSubpath,
            codexEnvelopeSchemaSameReference: codexEnvelopeSchemaFromRoot === codexEnvelopeSchemaFromSubpath,
             physicalWorktreeCreateSameReference: createPhysicalWorktreeFromRoot === createPhysicalWorktreeFromSubpath,
           physicalWorktreeCleanupSameReference: cleanupPhysicalWorktreeFromRoot === cleanupPhysicalWorktreeFromSubpath,
           supervisorRunSameReference: runSupervisorFromRoot === runSupervisorFromSubpath,
          supervisorTickSameReference: runSupervisorTickFromRoot === runSupervisorTickFromSubpath,
          inspectorType: typeof inspectOrchestration,
          workflowLoaderType: typeof loadWorkflowFromSubpath,
           workflowRendererType: typeof renderWorkflowPromptFromSubpath,
            workflowSchemaType: typeof symphonyWorkflowDocumentSchema.safeParse,
            codexLaunchSchemaType: typeof symphonyCodexRunnerLaunchResultSchema.safeParse,
            codexTurnSchemaType: typeof symphonyCodexRunnerTurnResultSchema.safeParse,
            codexCommandBuilderType: typeof buildCodexCommandFromSubpath,
            codexSessionId: deriveCodexSessionFromSubpath({ threadId: 'thread-packed', turnId: 'turn-packed' }),
             codexProcessAdapterType: typeof createCodexProcessAdapterFromSubpath,
             codexRunnerType: typeof launchCodexRunnerFromSubpath,
             codexEnvelopeSchemaType: typeof codexEnvelopeSchemaFromSubpath.safeParse,
             physicalWorktreeCreateType: typeof createPhysicalWorktreeFromSubpath,
           physicalWorktreeCleanupType: typeof cleanupPhysicalWorktreeFromSubpath,
           physicalWorktreeSchemaType: typeof symphonyWorktreeOperationResultSchema.safeParse,
           supervisorRunType: typeof runSupervisorFromSubpath,
          supervisorTickType: typeof runSupervisorTickFromSubpath,
          schemaType: typeof orchestrationPlanSchema.safeParse,
          supervisorRunSchemaType: typeof orchestrationSupervisorRunInputSchema.safeParse,
          supervisorSchemaType: typeof orchestrationSupervisorTickInputSchema.safeParse,
          supervisorTickResultSchemaType: typeof orchestrationSupervisorTickResultSchema.safeParse,
          supervisorRunSummarySchemaType: typeof orchestrationSupervisorRunSummarySchema.safeParse,
          worktreeBranch: worktree.branch,
          subagentCount: createDefaultGpt5HighSubagents().length,
        }));
      `);
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const parsed = JSON.parse(result.stdout) as {
        rootBuilderType: string;
        assertionType: string;
        scorecardBuilderType: string;
        dashboardBuilderType: string;
        dashboardFilterType: string;
        csqrCriteriaCount: number;
        csqrSchemaType: string;
        dashboardSchemaType: string;
        dashboardServerOpenType: string;
        dashboardServerReadonlyType: string;
        dashboardServerSelectAllType: string;
        dashboardServerSelectOneType: string;
        dashboardServerOrchestratorType: string;
        matrixSameReference: boolean;
        filterSameReference: boolean;
        workflowLoaderSameReference: boolean;
         workflowRendererSameReference: boolean;
         workflowReloaderSameReference: boolean;
         codexCommandSameReference: boolean;
         codexSessionSameReference: boolean;
          codexProcessAdapterSameReference: boolean;
          codexRunnerSameReference: boolean;
          codexEnvelopeSchemaSameReference: boolean;
           physicalWorktreeCreateSameReference: boolean;
         physicalWorktreeCleanupSameReference: boolean;
         supervisorRunSameReference: boolean;
        supervisorTickSameReference: boolean;
        inspectorType: string;
        workflowLoaderType: string;
         workflowRendererType: string;
         workflowSchemaType: string;
         codexLaunchSchemaType: string;
         codexTurnSchemaType: string;
         codexCommandBuilderType: string;
         codexSessionId: string;
          codexProcessAdapterType: string;
          codexRunnerType: string;
          codexEnvelopeSchemaType: string;
           physicalWorktreeCreateType: string;
         physicalWorktreeCleanupType: string;
         physicalWorktreeSchemaType: string;
         supervisorRunType: string;
        supervisorTickType: string;
        schemaType: string;
        supervisorRunSchemaType: string;
        supervisorSchemaType: string;
        supervisorTickResultSchemaType: string;
        supervisorRunSummarySchemaType: string;
        worktreeBranch: string;
        subagentCount: number;
      };

      assert.deepEqual(parsed, {
        rootBuilderType: 'function',
        assertionType: 'function',
        scorecardBuilderType: 'function',
        dashboardBuilderType: 'function',
        dashboardFilterType: 'function',
        csqrCriteriaCount: 4,
        csqrSchemaType: 'function',
        dashboardSchemaType: 'function',
        dashboardServerOpenType: 'function',
        dashboardServerReadonlyType: 'function',
        dashboardServerSelectAllType: 'function',
        dashboardServerSelectOneType: 'function',
        dashboardServerOrchestratorType: 'function',
        matrixSameReference: true,
        filterSameReference: true,
        workflowLoaderSameReference: true,
         workflowRendererSameReference: true,
         workflowReloaderSameReference: true,
         codexCommandSameReference: true,
         codexSessionSameReference: true,
          codexProcessAdapterSameReference: true,
          codexRunnerSameReference: true,
          codexEnvelopeSchemaSameReference: true,
           physicalWorktreeCreateSameReference: true,
         physicalWorktreeCleanupSameReference: true,
         supervisorRunSameReference: true,
        supervisorTickSameReference: true,
        inspectorType: 'function',
        workflowLoaderType: 'function',
         workflowRendererType: 'function',
         workflowSchemaType: 'function',
         codexLaunchSchemaType: 'function',
         codexTurnSchemaType: 'function',
         codexCommandBuilderType: 'function',
         codexSessionId: 'thread-packed-turn-packed',
          codexProcessAdapterType: 'function',
          codexRunnerType: 'function',
          codexEnvelopeSchemaType: 'function',
           physicalWorktreeCreateType: 'function',
         physicalWorktreeCleanupType: 'function',
         physicalWorktreeSchemaType: 'function',
         supervisorRunType: 'function',
        supervisorTickType: 'function',
        schemaType: 'function',
        supervisorRunSchemaType: 'function',
        supervisorSchemaType: 'function',
        supervisorTickResultSchemaType: 'function',
        supervisorRunSummarySchemaType: 'function',
        worktreeBranch: 'feat/m4-i1-public-exports',
        subagentCount: 4,
      });
    });

    await t.test('installed harness-install-mcp bin updates Codex, Copilot, and antigravity smoke paths', () => {
      const result = runBin(
        join(binDir, 'harness-install-mcp'),
        ['--host', 'codex', '--host', 'copilot', '--host', 'antigravity'],
        { env: baseEnv },
      );

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(existsSync(join(homeDir, '.agent-harness')), true);

      const expectedServerScript = join(
        packageRoot,
        'dist',
        'bin',
        'session-lifecycle-mcp.js',
      );

      const copilotConfig = JSON.parse(
        readFileSync(join(homeDir, '.copilot', 'mcp-config.json'), 'utf8'),
      ) as {
        mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
      };
      const antigravityConfig = JSON.parse(
        readFileSync(join(homeDir, '.gemini', 'antigravity', 'mcp_config.json'), 'utf8'),
      ) as {
        mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
      };

      assert.equal(
        realpathSync(copilotConfig.mcpServers['agent-harness']?.args[0] ?? ''),
        realpathSync(expectedServerScript),
      );
      assert.equal(
        realpathSync(antigravityConfig.mcpServers['agent-harness']?.args[0] ?? ''),
        realpathSync(expectedServerScript),
      );

      const codexLog = readFileSync(codexLogPath, 'utf8');
      assert.match(codexLog, /mcp remove harness_os/);
      assert.match(codexLog, /mcp add harness_os/);
      assert.match(codexLog, /session-lifecycle-mcp\.js/);
    });

    await t.test('installed harness-sync rejects legacy host config and requires explicit setup rewrite', () => {
      const legacyHomeDir = join(tempDir, 'legacy-home');
      const legacyHostWorkspace = join(tempDir, 'legacy-host');
      mkdirSync(join(legacyHomeDir, '.agent-harness'), { recursive: true });
      mkdirSync(legacyHostWorkspace, { recursive: true });
      writeFileSync(
        join(legacyHomeDir, '.agent-harness', 'config.json'),
        `${JSON.stringify({ hosts: [legacyHostWorkspace] }, null, 2)}\n`,
        'utf8',
      );

      const result = runBin(join(binDir, 'harness-sync'), [], {
        env: {
          ...baseEnv,
          HOME: legacyHomeDir,
        },
      });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr || result.stdout, /Legacy Harness config detected/);
      assert.match(result.stderr || result.stdout, /harness-setup/);
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function createPackedArtifact(tempDir: string): string {
  const result = spawnSync(
    'npm',
    ['pack', '--json', '--pack-destination', tempDir],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout) as Array<{ filename: string }>;
  const filename = parsed[0]?.filename;

  assert.ok(filename, 'npm pack must return a tarball filename');
  return join(tempDir, filename);
}

function installPackedArtifact(tempDir: string, tarballPath: string): string {
  const installRoot = join(tempDir, 'install-root');
  mkdirSync(installRoot, { recursive: true });
  writeFileSync(
    join(installRoot, 'package.json'),
    `${JSON.stringify({ private: true, name: 'packed-artifact-smoke' }, null, 2)}\n`,
    'utf8',
  );

  const result = spawnSync(
    'npm',
    ['install', '--no-package-lock', tarballPath],
    {
      cwd: installRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  return installRoot;
}

function seedSmokeDatabase(dbPath: string): void {
  const database = openHarnessDatabase({ dbPath });

  try {
    const now = '2026-04-02T00:00:00.000Z';
    runStatement(
      database.connection,
      `INSERT INTO workspaces (id, name, kind, created_at, updated_at)
       VALUES (?, ?, 'local', ?, ?)`,
      ['workspace-1', 'Smoke Workspace', now, now],
    );
    runStatement(
      database.connection,
      `INSERT INTO projects (id, workspace_id, key, name, domain, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'default', 'active', ?, ?)`,
      ['project-1', 'workspace-1', 'test-project', 'Smoke Project', now, now],
    );
    runStatement(
      database.connection,
      `INSERT INTO campaigns (id, project_id, name, objective, status, scope_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', '{}', ?, ?)`,
      ['campaign-1', 'project-1', 'Smoke Campaign', 'Packed artifact smoke coverage.', now, now],
    );
  } finally {
    database.close();
  }
}

function writeCodexStub(stubPath: string): void {
  writeFileSync(
    stubPath,
    '#!/usr/bin/env sh\nprintf "%s\\n" "$*" >> "$CODEX_LOG_PATH"\nexit 0\n',
    'utf8',
  );
  chmodSync(stubPath, 0o755);
}

function runBin(
  binPath: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    input?: string;
  },
): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  return spawnSync(binPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: options.env,
    input: options.input,
    stdio: 'pipe',
  });
}

function runInstalledPackageScript(
  installRoot: string,
  env: NodeJS.ProcessEnv,
  script: string,
): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  return spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: installRoot,
    encoding: 'utf8',
    env,
    stdio: 'pipe',
  });
}

async function smokeTestInstalledMcpServer(
  binPath: string,
  env: NodeJS.ProcessEnv,
): Promise<Array<{ id?: number; result?: unknown }>> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binPath, [], {
      cwd: repoRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`MCP smoke test timed out.\nSTDERR:\n${stderr}`));
    }, 5000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(stderr || `MCP server exited with code ${code}`));
        return;
      }

      try {
        const messages = stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as { id?: number; result?: unknown });
        resolvePromise(messages);
      } catch (error) {
        reject(error);
      }
    });

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: {
            name: 'packed-artifact-smoke',
            version: '1.0.0',
          },
        },
      })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'harness_symphony',
          arguments: {
            action: 'supervisor_tick',
            contractVersion: '1.0.0',
            tickId: 'packed-mcp-supervisor-tick',
            dbPath: env['HARNESS_DB_PATH'],
            projectId: 'project-1',
            mode: 'dry_run',
            stopCondition: {
              stopWhenIdle: true,
            },
          },
        },
      })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'shutdown',
      })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'exit',
      })}\n`,
    );
    child.stdin.end();
  });
}

async function runInteractiveSetupBin(
  binPath: string,
  env: NodeJS.ProcessEnv,
  hostWorkspace: string,
): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binPath, [], {
      cwd: repoRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let step = 0;
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Interactive setup smoke test timed out.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
    }, 5000);

    const advance = () => {
      if (step === 0 && stdout.includes('Select an option [1-4]: ')) {
        child.stdin.write('1\n');
        step = 1;
      }

      if (step === 1 && stdout.includes('Enter the absolute path to the host directory (or use ~): ')) {
        child.stdin.write(`${hostWorkspace}\n`);
        step = 2;
      }

      if (step === 2 && stdout.includes('Select a workload profile [1-6]')) {
        child.stdin.write('1\n');
        step = 3;
      }

      if (
        step === 3 &&
        (stdout.includes(`✅ Added ${hostWorkspace}`) || stdout.includes('⚠️ Host already exists.'))
      ) {
        child.stdin.end('4\n');
        step = 4;
      }
    };

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      advance();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('exit', (status) => {
      clearTimeout(timeout);
      resolvePromise({
        status,
        stdout,
        stderr,
      });
    });
  });
}
