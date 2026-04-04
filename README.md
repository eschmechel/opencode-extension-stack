# OpenCode Extension Stack

OpenCode-first extension stack for the durable gaps that OpenCode does not already cover natively: unattended jobs, scheduling, worker orchestration, persistent skeptical memory, prompt packs, and an optional remote bridge.

This repo started as an empty git repository, so the first pass focuses on a clean monorepo scaffold plus the Phase 0 and early Phase 1 foundation described in the planning docs.

## Packages

- `packages/opencode-core`: shared schemas, config loading, state bootstrap, append-only run logs, repo lock helper
- `packages/opencode-kairos`: unattended queue and minimal scheduler slice
- `packages/opencode-orchestrator`: placeholder for detached worker lifecycle
- `packages/opencode-memory`: placeholder for skeptical memory storage
- `packages/opencode-packs`: placeholder for reusable command packs
- `packages/opencode-bridge`: placeholder for remote control plane work

## Current Commands

Run commands with `pnpm run kairos -- ...`.

- `/queue add <prompt>`
- `/queue list`
- `/queue cancel <id>`
- `/jobs`
- `/jobs show <id>`
- `/jobs retry <id>`
- `/cron add <schedule> <prompt>`
- `/cron list`
- `/cron remove <id>`
- `/cron tick`
- `runner once`

Examples:

```bash
pnpm run kairos -- /queue add "review the Phase 1 backlog"
pnpm run kairos -- /queue list
pnpm run kairos -- /jobs
pnpm run kairos -- /cron add "*/30 * * * *" "summarize open TODOs"
pnpm run kairos -- /cron list
pnpm run kairos -- /cron tick
pnpm run kairos -- runner once
```

Supported schedule formats in the current slice:

- standard five-field cron expressions
- aliases: `@hourly`, `@daily`, `@weekly`, `@monthly`

## Companion Inputs

- Local companion plugins currently targeted for OpenCode use: `opencode-gemini-auth`, `opencode-vibeguard`
- Phase 4 and Phase 5 review UX reference: `backnotprop/plannotator`
- Phase 6 mobile and remote prompting reference: `hosenur/portal`

## Repo-Local State

The first command bootstrap creates repo-local state under `.opencode/`:

- `.opencode/config.json`
- `.opencode/jobs.json`
- `.opencode/schedules.json`
- `.opencode/runs/`
- `.opencode/workers/`
- `.opencode/teams/`
- `.opencode/memory/MEMORY.md`
- `.opencode/memory/topics/`
- `.opencode/memory/team/`
- `.opencode/remote/`

State is intentionally gitignored so unattended/runtime artifacts stay local to the working repo.

Each run directory can contain:

- `events.ndjson`
- `stdout.txt`
- `stderr.txt`
- `result.json`
