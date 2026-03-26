#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './agent-harness-setup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const SOURCE_SKILLS_DIR = path.join(PACKAGE_ROOT, '.github', 'skills');

function collectRelativePaths(dir: string, base: string = dir): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectRelativePaths(fullPath, base));
    } else {
      results.push(path.relative(base, fullPath));
    }
  }

  return results;
}

function syncDirectory(src: string, dest: string): { synced: number; pruned: number } {
  const sourceFiles = new Set(collectRelativePaths(src));
  let synced = 0;
  let pruned = 0;

  // Copy all source files to destination
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

  // Prune stale files in destination that are not in source
  const destFiles = collectRelativePaths(dest);

  for (const relPath of destFiles) {
    if (!sourceFiles.has(relPath)) {
      const stalePath = path.join(dest, relPath);
      fs.unlinkSync(stalePath);
      console.log(`  Pruned stale: ${relPath}`);
      pruned++;
    }
  }

  // Remove empty directories left after pruning
  removeEmptyDirs(dest);

  return { synced, pruned };
}

function removeEmptyDirs(dir: string): void {
  if (!fs.existsSync(dir)) return;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      removeEmptyDirs(path.join(dir, entry.name));
    }
  }

  if (fs.readdirSync(dir).length === 0) {
    fs.rmdirSync(dir);
  }
}

interface SyncResult {
  host: string;
  synced: number;
  pruned: number;
  error?: string;
}

async function runSync() {
  console.log('=== HarnessOS: Syncing Skills ===');
  const config = loadConfig();

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
    const targetSkillsDir = path.join(host, 'skills');
    console.log(`\n🔄 Syncing to host: ${host}`);

    try {
      const { synced, pruned } = syncDirectory(SOURCE_SKILLS_DIR, targetSkillsDir);
      console.log(`✅ ${synced} files synced, ${pruned} stale files pruned → ${targetSkillsDir}`);
      results.push({ host, synced, pruned });
    } catch (err: any) {
      console.error(`❌ Failed to sync to ${host}:`, err.message);
      results.push({ host, synced: 0, pruned: 0, error: err.message });
    }
  }

  const failed = results.filter((r) => r.error);
  const succeeded = results.filter((r) => !r.error);

  console.log(`\n── Summary ──`);
  console.log(`  Hosts: ${succeeded.length} OK, ${failed.length} failed`);
  console.log(`  Files synced: ${succeeded.reduce((sum, r) => sum + r.synced, 0)}`);
  console.log(`  Stale pruned: ${succeeded.reduce((sum, r) => sum + r.pruned, 0)}`);

  if (failed.length > 0) {
    console.log(`\n⚠️  Failed hosts:`);
    for (const r of failed) {
      console.log(`  - ${r.host}: ${r.error}`);
    }
  }
}

runSync().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
