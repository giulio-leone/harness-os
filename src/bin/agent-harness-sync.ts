#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type HarnessConfig,
  type HarnessHostConfig,
  loadConfig,
  saveConfig,
} from './agent-harness-setup.js';
import {
  BUNDLED_SKILL_MANIFEST_FILE,
  type BundledSkillManifest,
  getBundledSkillsForWorkloadProfile,
  getBundledWorkloadProfile,
  getBundledSkillsDir,
  isCleanBundledSkillValidationResult,
  loadBundledSkillManifest,
  readBundledSkillManifest,
  validateInstalledSkillBundle,
} from '../runtime/bundled-skill-manifest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const SOURCE_SKILLS_DIR = getBundledSkillsDir(PACKAGE_ROOT);

function collectRelativePaths(dir: string, base: string = dir): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      console.warn(`  ⚠ Skipping symlink: ${path.relative(base, fullPath)}`);
      continue;
    }

    if (entry.isDirectory()) {
      results.push(...collectRelativePaths(fullPath, base));
      continue;
    }

    results.push(path.relative(base, fullPath));
  }

  return results.sort((left, right) => left.localeCompare(right));
}

function syncDirectory(
  src: string,
  dest: string,
  expectedFiles: string[],
): { synced: number; pruned: number } {
  const sourceFiles = new Set(expectedFiles);
  let synced = 0;
  let pruned = 0;

  for (const relPath of sourceFiles) {
    const srcPath = path.join(src, relPath);
    const destPath = path.join(dest, relPath);
    const destDir = path.dirname(destPath);

    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    fs.copyFileSync(srcPath, destPath);
    synced++;
  }

  const destFiles = collectRelativePaths(dest);
  for (const relPath of destFiles) {
    if (!sourceFiles.has(relPath)) {
      fs.unlinkSync(path.join(dest, relPath));
      console.log(`  Pruned stale: ${relPath}`);
      pruned++;
    }
  }

  removeEmptyDirs(dest);

  return { synced, pruned };
}

function removeEmptyDirs(dir: string): void {
  if (!fs.existsSync(dir)) {
    return;
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      removeEmptyDirs(path.join(dir, entry.name));
    }
  }

  if (fs.readdirSync(dir).length === 0) {
    fs.rmdirSync(dir);
  }
}

function getExpectedBundledFiles(
  manifest: BundledSkillManifest,
  workloadProfileId: HarnessHostConfig['selectedWorkloadProfile'],
): string[] {
  return [
    BUNDLED_SKILL_MANIFEST_FILE,
    ...getBundledSkillsForWorkloadProfile(manifest, workloadProfileId).flatMap((skill) =>
      skill.files.map((file) => path.join(skill.id, file.relativePath)),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

interface SyncResult {
  host: string;
  synced: number;
  pruned: number;
  replacedLegacyInstall: boolean;
  replacedOutdatedSkills: string[];
  replacedDriftedSkills: string[];
  installedBundleVersion?: string;
  error?: string;
}

function loadInstalledManifest(targetSkillsDir: string): BundledSkillManifest | null {
  const manifestPath = path.join(targetSkillsDir, BUNDLED_SKILL_MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  try {
    return readBundledSkillManifest(manifestPath);
  } catch {
    return null;
  }
}

function planSkillReplacement(
  sourceManifest: BundledSkillManifest,
  installedManifest: BundledSkillManifest | null,
  targetSkillsDir: string,
  workloadProfileId: HarnessHostConfig['selectedWorkloadProfile'],
): {
  replacedLegacyInstall: boolean;
  replacedOutdatedSkills: string[];
  replacedDriftedSkills: string[];
} {
  const sourceSkills = getBundledSkillsForWorkloadProfile(sourceManifest, workloadProfileId);

  if (installedManifest === null) {
    const hasLegacyFiles = collectRelativePaths(targetSkillsDir).length > 0;
    return {
      replacedLegacyInstall: hasLegacyFiles,
      replacedOutdatedSkills: sourceSkills.map((skill) => skill.id),
      replacedDriftedSkills: [],
    };
  }

  const driftedValidation = validateInstalledSkillBundle(
    targetSkillsDir,
    installedManifest,
    workloadProfileId,
  );
  const replacedDriftedSkills = Array.from(
    new Set(
      driftedValidation.driftedFiles
        .concat(driftedValidation.missingFiles)
        .filter((relativePath) => relativePath.includes('/'))
        .map((relativePath) => relativePath.split('/')[0] ?? relativePath),
    ),
  ).sort((left, right) => left.localeCompare(right));

  const installedById = new Map(installedManifest.skills.map((skill) => [skill.id, skill]));
  const replacedOutdatedSkills = sourceSkills
    .filter((skill) => {
      const installedSkill = installedById.get(skill.id);
      if (!installedSkill) {
        return true;
      }

      return (
        installedSkill.version !== skill.version ||
        installedSkill.checksum !== skill.checksum ||
        installedSkill.workloadProfileIds.join(',') !== skill.workloadProfileIds.join(',')
      );
    })
    .map((skill) => skill.id)
    .sort((left, right) => left.localeCompare(right));

  return {
    replacedLegacyInstall: false,
    replacedOutdatedSkills,
    replacedDriftedSkills,
  };
}

function describeSyncPlan(
  hostPath: string,
  sourceManifest: BundledSkillManifest,
  plan: {
    replacedLegacyInstall: boolean;
    replacedOutdatedSkills: string[];
    replacedDriftedSkills: string[];
  },
): void {
  console.log(`\n🔄 Syncing to host: ${hostPath}`);
  if (plan.replacedLegacyInstall) {
    console.log(`  Replacing legacy unversioned skill install with bundle ${sourceManifest.bundleVersion}.`);
  }
  if (plan.replacedOutdatedSkills.length > 0) {
    console.log(`  Replacing outdated skills: ${plan.replacedOutdatedSkills.join(', ')}`);
  }
  if (plan.replacedDriftedSkills.length > 0) {
    console.log(`  Replacing drifted skills: ${plan.replacedDriftedSkills.join(', ')}`);
  }
  if (
    !plan.replacedLegacyInstall &&
    plan.replacedOutdatedSkills.length === 0 &&
    plan.replacedDriftedSkills.length === 0
  ) {
    console.log(`  Host already matches bundle ${sourceManifest.bundleVersion}; revalidating and refreshing manifest.`);
  }
}

function updateHostMetadata(
  config: HarnessConfig,
  host: HarnessHostConfig,
  manifest: BundledSkillManifest,
): void {
  const configHost = config.hosts.find((candidate) => candidate.path === host.path);
  if (!configHost) {
    return;
  }

  configHost.installedBundleVersion = manifest.bundleVersion;
  configHost.installedManifestChecksum = manifest.manifestChecksum;
  const profile = getBundledWorkloadProfile(manifest, host.selectedWorkloadProfile);
  configHost.installedWorkloadProfileVersion = profile.version;
  configHost.installedWorkloadProfileChecksum = profile.checksum;
  configHost.lastSyncedAt = new Date().toISOString();
}

async function runSync() {
  console.log('=== HarnessOS: Syncing Skills ===');
  const { config } = loadConfig();
  const sourceManifest = loadBundledSkillManifest(PACKAGE_ROOT);

  if (config.hosts.length === 0) {
    console.log('❌ No active hosts configured. Run `npx harness-setup` first.');
    process.exit(1);
  }

  if (!fs.existsSync(SOURCE_SKILLS_DIR)) {
    console.log(`❌ Source skills directory not found: ${SOURCE_SKILLS_DIR}`);
    console.log('Are you running this inside the harness-os installation?');
    process.exit(1);
  }

  const results: SyncResult[] = [];
  for (const host of config.hosts) {
    const targetSkillsDir = path.join(host.path, 'skills');
    const installedManifest = loadInstalledManifest(targetSkillsDir);
    const plan = planSkillReplacement(
      sourceManifest,
      installedManifest,
      targetSkillsDir,
      host.selectedWorkloadProfile,
    );
    describeSyncPlan(host.path, sourceManifest, plan);

    try {
      const { synced, pruned } = syncDirectory(
        SOURCE_SKILLS_DIR,
        targetSkillsDir,
        getExpectedBundledFiles(sourceManifest, host.selectedWorkloadProfile),
      );
      const validationResult = validateInstalledSkillBundle(
        targetSkillsDir,
        sourceManifest,
        host.selectedWorkloadProfile,
      );
      if (!isCleanBundledSkillValidationResult(validationResult)) {
        throw new Error(
          [
            validationResult.manifestMismatch ? 'manifest checksum mismatch' : null,
            validationResult.missingFiles.length > 0
              ? `missing files: ${validationResult.missingFiles.join(', ')}`
              : null,
            validationResult.driftedFiles.length > 0
              ? `drifted files: ${validationResult.driftedFiles.join(', ')}`
              : null,
            validationResult.unexpectedFiles.length > 0
              ? `unexpected files: ${validationResult.unexpectedFiles.join(', ')}`
              : null,
          ]
            .filter((message): message is string => message !== null)
            .join('; '),
        );
      }

      updateHostMetadata(config, host, sourceManifest);
      saveConfig(config);
      console.log(
        `✅ ${synced} files synced, ${pruned} stale files pruned → ${targetSkillsDir} (bundle ${sourceManifest.bundleVersion})`,
      );
      results.push({
        host: host.path,
        synced,
        pruned,
        replacedLegacyInstall: plan.replacedLegacyInstall,
        replacedOutdatedSkills: plan.replacedOutdatedSkills,
        replacedDriftedSkills: plan.replacedDriftedSkills,
        installedBundleVersion: sourceManifest.bundleVersion,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`❌ Failed to sync to ${host.path}: ${message}`);
      results.push({
        host: host.path,
        synced: 0,
        pruned: 0,
        replacedLegacyInstall: plan.replacedLegacyInstall,
        replacedOutdatedSkills: plan.replacedOutdatedSkills,
        replacedDriftedSkills: plan.replacedDriftedSkills,
        error: message,
      });
    }
  }

  const failed = results.filter((result) => result.error);
  const succeeded = results.filter((result) => !result.error);

  console.log('\n── Summary ──');
  console.log(`  Hosts: ${succeeded.length} OK, ${failed.length} failed`);
  console.log(`  Files synced: ${succeeded.reduce((sum, result) => sum + result.synced, 0)}`);
  console.log(`  Stale pruned: ${succeeded.reduce((sum, result) => sum + result.pruned, 0)}`);
  console.log(
    `  Skills explicitly replaced: ${succeeded.reduce(
      (sum, result) =>
        sum +
        result.replacedOutdatedSkills.length +
        result.replacedDriftedSkills.length +
        (result.replacedLegacyInstall ? 1 : 0),
      0,
    )}`,
  );

  if (failed.length > 0) {
    console.log('\n⚠️  Failed hosts:');
    for (const result of failed) {
      console.log(`  - ${result.host}: ${result.error}`);
    }
    process.exitCode = 1;
  }
}

runSync().catch((error) => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
