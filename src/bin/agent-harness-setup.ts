#!/usr/bin/env node
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';

import type { WorkloadProfileId } from '../contracts/workload-profiles.js';
import {
  getWorkloadProfileMetadata,
  isWorkloadProfileId,
} from '../runtime/workload-profile-registry.js';

const CONFIG_SCHEMA_VERSION = 3 as const;
const CONFIG_DIR = path.join(os.homedir(), '.agent-harness');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const AVAILABLE_WORKLOAD_PROFILES = getWorkloadProfileMetadata();

export interface HarnessHostConfig {
  path: string;
  selectedWorkloadProfile: WorkloadProfileId;
  installedBundleVersion: string | null;
  installedManifestChecksum: string | null;
  installedWorkloadProfileVersion: string | null;
  installedWorkloadProfileChecksum: string | null;
  lastSyncedAt: string | null;
}

export interface HarnessConfig {
  schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  hosts: HarnessHostConfig[];
}

export interface LoadedHarnessConfig {
  config: HarnessConfig;
  migratedFromLegacy: boolean;
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

function createEmptyConfig(): HarnessConfig {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    hosts: [],
  };
}

function createHostConfig(
  hostPath: string,
  selectedWorkloadProfile: WorkloadProfileId,
): HarnessHostConfig {
  return {
    path: hostPath,
    selectedWorkloadProfile,
    installedBundleVersion: null,
    installedManifestChecksum: null,
    installedWorkloadProfileVersion: null,
    installedWorkloadProfileChecksum: null,
    lastSyncedAt: null,
  };
}

export function loadConfig(
  options: {
    allowLegacyMigration?: boolean;
  } = {},
): LoadedHarnessConfig {
  if (!fs.existsSync(CONFIG_FILE)) {
    return {
      config: createEmptyConfig(),
      migratedFromLegacy: false,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    throw new Error(
      `Invalid Harness config at ${CONFIG_FILE}. Run \`harness-setup\` to recreate it.`,
    );
  }

  if (isHarnessConfig(parsed)) {
    return {
      config: parsed,
      migratedFromLegacy: false,
    };
  }

  if (isLegacyHarnessConfig(parsed)) {
    if (!options.allowLegacyMigration) {
      throw new Error(
        `Legacy Harness config detected at ${CONFIG_FILE}. Run \`harness-setup\` once to rewrite it to schemaVersion 3 before running \`harness-sync\`.`,
      );
    }

    return {
      config: {
        schemaVersion: CONFIG_SCHEMA_VERSION,
        hosts: parsed.hosts.map((hostPath) => createHostConfig(hostPath, 'assistant')),
      },
      migratedFromLegacy: true,
    };
  }

  if (isHarnessConfigV2(parsed)) {
    if (!options.allowLegacyMigration) {
      throw new Error(
        `Harness config schemaVersion 2 detected at ${CONFIG_FILE}. Run \`harness-setup\` once to rewrite it to schemaVersion 3 and select workload profiles before running \`harness-sync\`.`,
      );
    }

    return {
      config: {
        schemaVersion: CONFIG_SCHEMA_VERSION,
        hosts: parsed.hosts.map((host) => ({
          path: host.path,
          selectedWorkloadProfile: 'assistant',
          installedBundleVersion: host.installedBundleVersion,
          installedManifestChecksum: host.installedManifestChecksum,
          installedWorkloadProfileVersion: null,
          installedWorkloadProfileChecksum: null,
          lastSyncedAt: host.lastSyncedAt,
        })),
      },
      migratedFromLegacy: true,
    };
  }

  throw new Error(
    `Unsupported Harness config shape at ${CONFIG_FILE}. Run \`harness-setup\` to recreate it.`,
  );
}

export function saveConfig(config: HarnessConfig): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }

  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

async function menu() {
  console.log('\n=== HarnessOS — Interactive Setup ===');
  const { config, migratedFromLegacy } = loadConfig({ allowLegacyMigration: true });

  if (migratedFromLegacy) {
    console.log(
      `⚠️  Legacy host config detected. Saving from this setup flow will rewrite it to schemaVersion ${CONFIG_SCHEMA_VERSION} with explicit workload profile metadata.`,
    );
  }

  if (config.hosts.length === 0) {
    console.log('No active hosts configured.');
  } else {
    console.log('Active hosts:');
    config.hosts.forEach((host, index) => {
      const bundleLabel = host.installedBundleVersion === null
        ? 'not synced yet'
        : `bundle ${host.installedBundleVersion}`;
      console.log(
        `  ${index + 1}. ${host.path} (${host.selectedWorkloadProfile}, ${bundleLabel})`,
      );
    });
  }

  console.log('\nOptions:');
  console.log('1. Add a new workspace / host (e.g., ~/.gemini, ~/.windsurf, ~/.cursor, ~/.copilot)');
  console.log('2. Change workload profile for a workspace / host');
  console.log('3. Remove a workspace / host');
  console.log('4. Exit and save');

  const answer = await ask('\nSelect an option [1-4]: ');

  if (answer === '1') {
    let newHost = await ask('\nEnter the absolute path to the host directory (or use ~): ');
    if (newHost.startsWith('~/')) {
      newHost = path.join(os.homedir(), newHost.slice(2));
    }

    newHost = path.resolve(newHost);

    if (!fs.existsSync(newHost)) {
      console.log(`⚠️  Directory does not exist: ${newHost}`);
      const create = await ask('Create it now? [y/N]: ');
      if (create.toLowerCase() === 'y') {
        try {
          fs.mkdirSync(newHost, { recursive: true });
          console.log(`  Created ${newHost}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.log(`❌ Cannot create directory: ${message}`);
          await menu();
          return;
        }
      } else {
        console.log('  Skipped — host not added.');
        await menu();
        return;
      }
    }

    try {
      fs.accessSync(newHost, fs.constants.W_OK);
    } catch {
      console.log(`❌ No write permission to ${newHost}. Check filesystem permissions.`);
      await menu();
      return;
    }

    const selectedWorkloadProfile = await selectWorkloadProfile();

    if (!config.hosts.some((host) => host.path === newHost)) {
      config.hosts.push(createHostConfig(newHost, selectedWorkloadProfile));
      saveConfig(config);
      console.log(`✅ Added ${newHost} (${selectedWorkloadProfile})`);
    } else {
      console.log('⚠️ Host already exists.');
    }

    await menu();
    return;
  }

  if (answer === '2') {
    if (config.hosts.length === 0) {
      console.log('Nothing to update.');
      await menu();
      return;
    }

    const idxStr = await ask(`Enter the number of the host to update [1-${config.hosts.length}]: `);
    const idx = Number.parseInt(idxStr, 10) - 1;
    if (idx >= 0 && idx < config.hosts.length) {
      const nextProfile = await selectWorkloadProfile(config.hosts[idx]?.selectedWorkloadProfile);
      const updatedHost = config.hosts[idx];
      if (updatedHost) {
        updatedHost.selectedWorkloadProfile = nextProfile;
        updatedHost.installedWorkloadProfileVersion = null;
        updatedHost.installedWorkloadProfileChecksum = null;
        updatedHost.lastSyncedAt = null;
        saveConfig(config);
        console.log(`✅ Updated ${updatedHost.path} → ${nextProfile}`);
      }
    } else {
      console.log('❌ Invalid selection.');
    }

    await menu();
    return;
  }

  if (answer === '3') {
    if (config.hosts.length === 0) {
      console.log('Nothing to remove.');
      await menu();
      return;
    }

    const idxStr = await ask(`Enter the number of the host to remove [1-${config.hosts.length}]: `);
    const idx = Number.parseInt(idxStr, 10) - 1;
    if (idx >= 0 && idx < config.hosts.length) {
      const removed = config.hosts.splice(idx, 1);
      saveConfig(config);
      console.log(`✅ Removed ${removed[0]?.path}`);
    } else {
      console.log('❌ Invalid selection.');
    }

    await menu();
    return;
  }

  if (answer === '4') {
    if (migratedFromLegacy) {
      saveConfig(config);
      console.log(`✅ Rewrote legacy host config to schemaVersion ${CONFIG_SCHEMA_VERSION}.`);
    }
    console.log(`\nSetup finished. Configuration saved to ${CONFIG_FILE}`);
    console.log('To synchronize the versioned skill bundle to these hosts, run: npx harness-sync');
    rl.close();
    return;
  }

  console.log('❌ Invalid selection.');
  await menu();
}

async function selectWorkloadProfile(currentProfile?: WorkloadProfileId): Promise<WorkloadProfileId> {
  console.log('\nAvailable workload profiles:');
  AVAILABLE_WORKLOAD_PROFILES.forEach((profile, index) => {
    const currentLabel = currentProfile === profile.id ? ' (current)' : '';
    console.log(`  ${index + 1}. ${profile.id} — ${profile.description}${currentLabel}`);
  });

  const defaultIndex = Math.max(
    0,
    AVAILABLE_WORKLOAD_PROFILES.findIndex((profile) => profile.id === (currentProfile ?? 'assistant')),
  ) + 1;
  const answer = await ask(`Select a workload profile [1-${AVAILABLE_WORKLOAD_PROFILES.length}] (default ${defaultIndex}): `);
  const trimmed = answer.trim();

  if (trimmed.length === 0) {
    return AVAILABLE_WORKLOAD_PROFILES[defaultIndex - 1]!.id;
  }

  const numericIndex = Number.parseInt(trimmed, 10);
  if (numericIndex >= 1 && numericIndex <= AVAILABLE_WORKLOAD_PROFILES.length) {
    return AVAILABLE_WORKLOAD_PROFILES[numericIndex - 1]!.id;
  }

  if (isWorkloadProfileId(trimmed)) {
    return trimmed;
  }

  console.log('❌ Invalid workload profile selection.');
  return selectWorkloadProfile(currentProfile);
}

function isHarnessHostConfig(value: unknown): value is HarnessHostConfig {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['path'] === 'string' &&
    isWorkloadProfileId(String(candidate['selectedWorkloadProfile'] ?? '')) &&
    (candidate['installedBundleVersion'] === null || typeof candidate['installedBundleVersion'] === 'string') &&
    (candidate['installedManifestChecksum'] === null || typeof candidate['installedManifestChecksum'] === 'string') &&
    (candidate['installedWorkloadProfileVersion'] === null || typeof candidate['installedWorkloadProfileVersion'] === 'string') &&
    (candidate['installedWorkloadProfileChecksum'] === null || typeof candidate['installedWorkloadProfileChecksum'] === 'string') &&
    (candidate['lastSyncedAt'] === null || typeof candidate['lastSyncedAt'] === 'string')
  );
}

function isHarnessConfig(value: unknown): value is HarnessConfig {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate['schemaVersion'] === CONFIG_SCHEMA_VERSION &&
    Array.isArray(candidate['hosts']) &&
    candidate['hosts'].every(isHarnessHostConfig)
  );
}

function isHarnessConfigV2(value: unknown): value is {
  schemaVersion: 2;
  hosts: Array<{
    path: string;
    installedBundleVersion: string | null;
    installedManifestChecksum: string | null;
    installedProfilePackIds: string[];
    lastSyncedAt: string | null;
  }>;
} {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate['schemaVersion'] === 2 &&
    Array.isArray(candidate['hosts']) &&
    candidate['hosts'].every((host) => {
      if (host === null || typeof host !== 'object') {
        return false;
      }

      const record = host as Record<string, unknown>;
      return (
        typeof record['path'] === 'string' &&
        (record['installedBundleVersion'] === null || typeof record['installedBundleVersion'] === 'string') &&
        (record['installedManifestChecksum'] === null || typeof record['installedManifestChecksum'] === 'string') &&
        Array.isArray(record['installedProfilePackIds']) &&
        record['installedProfilePackIds'].every((profilePackId) => typeof profilePackId === 'string') &&
        (record['lastSyncedAt'] === null || typeof record['lastSyncedAt'] === 'string')
      );
    })
  );
}

function isLegacyHarnessConfig(value: unknown): value is { hosts: string[] } {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return Array.isArray(candidate['hosts']) && candidate['hosts'].every((host) => typeof host === 'string');
}

const invokedEntryPoint = path.basename(process.argv[1] ?? '');
if (
  import.meta.url === `file://${process.argv[1]}` ||
  invokedEntryPoint === 'agent-harness-setup' ||
  invokedEntryPoint === 'agent-harness-setup.js' ||
  invokedEntryPoint === 'harness-setup' ||
  invokedEntryPoint === 'harness-setup.js'
) {
  menu().catch((error) => {
    console.error(error);
    rl.close();
    process.exit(1);
  });
}
