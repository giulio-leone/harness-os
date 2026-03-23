---
name: harness-interactive-setup
description: How to automatically configure, install, and sync HarnessOS to any host (Gemini, Cursor, Copilot, Windsurf) without human intervention.
---

# Interactive HarnessOS Setup Skill

When a user requests to "install", "setup", or "link" HarnessOS to their current environment or multiple environments, you can achieve this fully autonomously.

HarnessOS uses a central config file at `~/.agent-harness/config.json` to keep track of **Hosts** (absolute paths to workspace/IDE global locations where skills should be synchronized).

## Autonomous Setup Process

You have two ways to set this up for the user:

### Method 1: Direct File Mutation (Recommended for AI Agents)

1. Check if `~/.agent-harness/config.json` exists. If not, create an empty structure: `{"hosts": []}`
2. Add the requested absolute paths (e.g., `~/.gemini`, `/Users/username/.cursor`) to the `hosts` array. Ensure there are no duplicates.
3. Save the file.
4. Run `npx harness-sync` to push the skills to all registered hosts.

### Method 2: Interactive CLI

If you prefer to use the interactive menu:
1. Run `npx harness-setup` using your terminal control system.
2. Provide '1' (to add), '2' (to remove), or '3' (to exit) using terminal input mechanisms (like `send_command_input`).
3. Follow the prompts.
4. Once finished, run `npx harness-sync`.

## Verifying the Setup

After running the sync command, verify that the skill directories were correctly copied to `<host-path>/skills/` (e.g., `~/.gemini/skills/session-lifecycle`).

This makes HarnessOS truly "plug and play" across any tooling capable of reading standard `.md` skill files.
