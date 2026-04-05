# opencode-opencode-plugin

OpenCode plugin that exposes the [opencode-extension-stack](https://github.com/eschmechel/opencode-extension-stack) packages as custom tools inside any OpenCode session.

## What it does

This plugin makes the extension stack commands available as callable tools from within OpenCode sessions:

- **Kairos tools**: queue management, cron schedules, job inspection, daemon control
- **Memory tools**: evidence-backed note storage, stale detection, contradiction checks, repair, merge
- **Orchestrator tools**: worker lifecycle, team creation/management, team templates, retention policy
- **Pack tools**: prompt pack rendering, execution, invocation history, `/ultraplan`, `/review`, `/triage`, `/handoff`
- **Bridge tools**: remote enqueue, approval flow, Telegram polling, bearer token management

The plugin also triggers the Kairos job runner automatically after each OpenCode session completes (`session.idle` hook), so queued jobs get processed without manual intervention.

## Prerequisites

- [opencode-extension-stack](https://github.com/eschmechel/opencode-extension-stack) installed locally
- OpenCode running with Bun (plugin uses Bun's `$` shell API)

## Installation

### Option 1: Run the setup script (recommended)

```bash
cd /path/to/opencode-extension-stack
node packages/opencode-opencode-plugin/setup.js
```

This copies the plugin to `~/.config/opencode/plugins/opencode-opencode-plugin/` and adds it to your `opencode.jsonc`.

### Option 2: Manual installation

1. Copy the plugin to your OpenCode plugins directory:
   ```bash
   cp -r packages/opencode-opencode-plugin/src ~/.config/opencode/plugins/opencode-opencode-plugin
   ```

2. Add it to your `opencode.jsonc`:
   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "plugin": [
       "opencode-gemini-auth@latest",
       "opencode-vibeguard@latest",
       "opencode-opencode-plugin"
     ]
   }
   ```

3. Restart OpenCode

## Configuration

### Extension stack path

By default, the plugin looks for the extension stack at `/mnt/GOONDRIVE/Repos/opencode-extension-stack`. Override with:

```bash
export EXTENSION_STACK_PATH=/your/path/to/opencode-extension-stack
```

Add to your shell profile (`~/.zshrc`, `~/.bashrc`) to persist.

## Usage

After installing and restarting OpenCode, the following tools become available:

### Queue & Jobs
- `queue_add` — add a prompt to the unattended queue
- `queue_list` — list queued prompts
- `queue_cancel` — cancel a queued job by ID
- `jobs_list` — list all jobs (queued, running, completed, failed)
- `jobs_show` — show detailed job status
- `jobs_retry` — retry a failed job
- `cron_add` — schedule a recurring prompt
- `cron_list` — list scheduled cron jobs
- `cron_remove` — remove a cron schedule
- `daemon_status` — check if the daemon is running
- `runner_once` — run one pending job immediately
- `supervisor_once` — run one supervisor cycle

### Memory
- `memory_show` — show memory entries for a topic
- `memory_search` — search memory notes
- `memory_stale` — list stale entries needing repair
- `memory_contradictions` — surface contradictory claims
- `memory_add` — add an evidence-backed note
- `memory_repair` — repair a stale note with fresh evidence
- `memory_merge` — merge two topics
- `memory_compact` — compact and deduplicate memory
- `memory_rebuild` — rebuild the MEMORY.md index

### Workers & Teams
- `worker_start` — start a detached background worker
- `worker_list` — list all workers
- `worker_show` — show worker details
- `worker_stop` — stop a worker
- `worker_restart` — restart a stopped worker
- `worker_steer` — send a steering message to a worker
- `team_create` — create a parallel team
- `team_create_from_template` — launch from a saved template
- `team_list` — list all teams
- `team_show` — show team details
- `team_delete` — delete a team
- `team_rerun_failed` — restart failed team branches
- `team_template_save` — save current config as template
- `team_template_list` — list saved templates
- `team_memory` — run memory commands in a team namespace
- `parallel_run` — run a prompt in parallel
- `retention_status` — show retention policy status
- `retention_apply` — apply retention policy

### Packs
- `packs_list` — list available packs
- `packs_show` — show pack details
- `packs_examples` — show sample payloads
- `packs_contract` — show output contract
- `packs_render` — render a pack with context
- `packs_execute` — execute a pack and prepare handoff packet
- `packs_complete` — provide output and validate against contract
- `packs_invocation` — inspect an invocation packet
- `packs_history` — show invocation history
- `packs_validate` — validate output against contract
- `ultraplan` — render a planning pack
- `review_pack` — render a review pack
- `review_remote` — render a remote review pack
- `triage` — render a triage pack
- `handoff` — render a handoff pack

### Bridge
- `remote_status` — show remote request status
- `remote_enqueue` — enqueue a remote request
- `remote_approve` — approve a pending request
- `remote_revoke` — revoke a request
- `remote_auth_list` — list API tokens
- `remote_auth_create` — create a new token
- `telegram_sync` — poll Telegram for updates

## Automatic job processing

After each OpenCode session ends, the plugin automatically calls `runner once` to process any queued jobs. No manual trigger needed.

## Custom tools vs. slash commands

This plugin exposes commands as OpenCode **custom tools** (callable by the AI model mid-session) rather than slash commands typed by the user. The AI can decide to call these tools autonomously based on context.
