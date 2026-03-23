import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import * as os from 'node:os';

const CONFIG_DIR = path.join(os.homedir(), '.agent-harness');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export interface HarnessConfig {
  hosts: string[];
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function ask(question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve));
}

export function loadConfig(): HarnessConfig {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    } catch {
      return { hosts: [] };
    }
  }
  return { hosts: [] };
}

function saveConfig(config: HarnessConfig) {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

async function menu() {
  console.log('\n=== Agent Harness Core Interactive Setup ===');
  const config = loadConfig();
  
  if (config.hosts.length === 0) {
    console.log('No active hosts configured.');
  } else {
    console.log('Active hosts integrating the Agent Harness:');
    config.hosts.forEach((host, i) => console.log(`  ${i + 1}. ${host}`));
  }

  console.log('\nOptions:');
  console.log('1. Add a new workspace / host (e.g., ~/.gemini, ~/.windsurf, ~/.cursor, ~/.copilot)');
  console.log('2. Remove a workspace / host');
  console.log('3. Exit and save');

  const answer = await ask('\nSelect an option [1-3]: ');
  
  if (answer === '1') {
    let newHost = await ask('Enter the absolute path to the host directory (or use ~): ');
    if (newHost.startsWith('~/')) {
      newHost = path.join(os.homedir(), newHost.slice(2));
    }
    
    // Ensure the path resolves to absolute
    newHost = path.resolve(newHost);

    if (!config.hosts.includes(newHost)) {
      config.hosts.push(newHost);
      saveConfig(config);
      console.log(`✅ Added ${newHost}`);
    } else {
      console.log('⚠️ Host already exists.');
    }
    await menu();
  } else if (answer === '2') {
    if (config.hosts.length === 0) {
      console.log('Nothing to remove.');
      await menu();
      return;
    }
    const idxStr = await ask(`Enter the number of the host to remove [1-${config.hosts.length}]: `);
    const idx = parseInt(idxStr, 10) - 1;
    if (idx >= 0 && idx < config.hosts.length) {
      const removed = config.hosts.splice(idx, 1);
      saveConfig(config);
      console.log(`✅ Removed ${removed[0]}`);
    } else {
      console.log('❌ Invalid selection.');
    }
    await menu();
  } else if (answer === '3') {
    console.log(`\nSetup finished. Configuration saved to ${CONFIG_FILE}`);
    console.log('To synchronize core skills to these hosts, run the sync script.');
    rl.close();
  } else {
    console.log('❌ Invalid selection.');
    await menu();
  }
}

// Only run the menu if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  menu().catch(err => {
    console.error(err);
    rl.close();
    process.exit(1);
  });
}
