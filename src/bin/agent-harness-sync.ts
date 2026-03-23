#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './agent-harness-setup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In compiled dist/bin/, we need to reach back up to the project root where .github is
// dist/bin/agent-harness-sync.js -> dist -> root -> .github/skills
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const SOURCE_SKILLS_DIR = path.join(PACKAGE_ROOT, '.github', 'skills');

function syncDirectory(src: string, dest: string) {
  if (!fs.existsSync(src)) return;
  if (!fs.existsSync(dest)) {
    console.log(`Creating directory: ${dest}`);
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      syncDirectory(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
      console.log(`Synced: ${entry.name}`);
    }
  }
}

async function runSync() {
  console.log('=== Agent Harness Core: Syncing Skills ===');
  const config = loadConfig();

  if (config.hosts.length === 0) {
    console.log('❌ No active hosts configured. Run `npx agent-harness-setup` first.');
    process.exit(1);
  }

  if (!fs.existsSync(SOURCE_SKILLS_DIR)) {
    console.log(`❌ Source skills directory not found: ${SOURCE_SKILLS_DIR}`);
    console.log('Are you running this inside the agent-harness-core installation?');
    process.exit(1);
  }

  for (const host of config.hosts) {
    const targetSkillsDir = path.join(host, 'skills');
    console.log(`\n🔄 Syncing to host: ${host}`);
    try {
      syncDirectory(SOURCE_SKILLS_DIR, targetSkillsDir);
      console.log(`✅ Successfully synced skills to ${targetSkillsDir}`);
    } catch (err: any) {
      console.error(`❌ Failed to sync to ${host}:`, err.message);
    }
  }
  
  console.log('\nAll done!');
}

runSync().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
