# OpenCode Extension Stack

OpenCode-first extension stack for the durable gaps that OpenCode does not already cover natively: unattended jobs, scheduling, worker orchestration, persistent skeptical memory, prompt packs, and an optional remote bridge.

This repo started as an empty git repository, so the first pass focuses on a clean monorepo scaffold plus the Phase 0 and early Phase 1 foundation described in the planning docs.

## Packages

- `packages/opencode-core`: shared schemas, config loading, state bootstrap, append-only run logs, repo lock helper
- `packages/opencode-kairos`: unattended queue and minimal scheduler slice
- `packages/opencode-orchestrator`: placeholder for detached worker lifecycle
- `packages/opencode-memory`: evidence-backed skeptical memory storage, search, and compaction
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
- `activity ping [source]`
- `activity show`
- `notifications list [limit]`
- `runner once`
- `supervisor once`
- `supervisor loop`
- `daemon start`
- `daemon status`
- `daemon stop`

Run worker lifecycle commands with `pnpm run orchestrator -- ...`.

- `retention status`
- `retention apply [--dry-run]`
- `/team create <count> <prompt>`
- `/team list`
- `/team show <id>`
- `/team archive <id>`
- `/team prune <id>`
- `/team rerun-failed <id>`
- `/team delete <id>`
- `/parallel <count> <prompt>`
- `/worker start <prompt>`
- `/worker list`
- `/worker show <id>`
- `/worker archive <id>`
- `/worker prune <id>`
- `/worker stop <id>`
- `/worker restart <id>`
- `/worker steer <id> <message>`

Run memory commands with `pnpm run memory -- ...`.

- `/memory show [topic]`
- `/memory search <query>`
- `/memory add <note> --run <runId> [--topic <topic>]`
- `/memory rebuild`
- `/memory compact`

Examples:

```bash
pnpm run kairos -- /queue add "review the Phase 1 backlog"
pnpm run kairos -- /queue list
pnpm run kairos -- /jobs
pnpm run kairos -- /cron add "*/30 * * * *" "summarize open TODOs"
pnpm run kairos -- /cron list
pnpm run kairos -- /cron tick
pnpm run kairos -- activity ping "manual-review"
pnpm run kairos -- notifications list 10
pnpm run kairos -- runner once --force
pnpm run kairos -- supervisor once --force
pnpm run kairos -- daemon start 5000 --force
pnpm run orchestrator -- retention status
pnpm run orchestrator -- retention apply --dry-run
pnpm run orchestrator -- /team create 3 "investigate flaky test output"
pnpm run orchestrator -- /team list
pnpm run orchestrator -- /team show <team-id>
pnpm run orchestrator -- /parallel 2 "compare two implementation approaches"
pnpm run orchestrator -- /worker start "investigate flaky test output"
pnpm run orchestrator -- /worker list
pnpm run memory -- /memory add "Queue retries are delayed by retryAt" --topic "queue retry" --run <run-id>
pnpm run memory -- /memory show
pnpm run memory -- /memory search retryAt
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

## Supervisor Behavior

- `runner once` attempts one queued job
- `supervisor once` first materializes due cron entries, then attempts one queued job
- `supervisor loop [cycles] [intervalMs]` repeats that supervisor cycle
- idle policy is enforced by default; use `--force` to bypass idle gating for manual runs
- daily budget gating is enforced before execution when `budgets.perDayUsd` is configured
- request-count style gating is also available through `budgets.perDayRuns`
- explicit activity heartbeats can be written with `activity ping` and later fed by a UI or remote bridge
- unattended notifications are appended to `.opencode/notifications.ndjson`
- `daemon start` runs the supervisor loop in the background and records state in `.opencode/workers/`

## Worker Behavior

- workers persist their state under `.opencode/workers/<workerId>/`
- worker control messages are append-only in `control.ndjson`
- steering queues follow-up prompts for the detached worker loop
- workers expose `readyForPrompt`, pending prompt counts, and trust-gate state for supervision
- stale workers are recovered as failed during inspection and control flows
- worker inspection includes recent control/event tails for supervision
- restart respawns a stopped or failed worker with its existing control history preserved
- archive-first prune is available through `/worker archive` and `/worker prune`

## Team Behavior

- team records live under `.opencode/teams/*.json`
- `/parallel` is a thin worker-fanout path built on top of team creation
- team list aggregates worker states into per-team counts for quick supervision
- teams expose synthesized summaries and per-worker branch status via `/team show`
- rerun support is available through `/team rerun-failed`
- per-team concurrency and total run budgets can be set on create/parallel commands

## Retention Policy

- live worker/team state is durable by default for auditability
- pruning is archive-first; no live artifact is removed before an archive copy is written
- archived snapshots are only deleted automatically when policy explicitly allows it
- `retention status` shows current archive counts, bytes, and prune/delete eligibility
- `retention apply` enforces policy-driven prune, compaction, and archive rotation

## Memory Behavior

- memory entries are stored per topic under `.opencode/memory/topics/*.json`
- `MEMORY.md` is a generated pointer index, rebuilt from topic files
- `/memory add` currently requires `--run <runId>` and only accepts successful run evidence
- `/memory compact` refreshes stale markers when backing run artifacts disappear or stop being valid
- duplicate memory entries are compacted by marking older duplicates stale instead of deleting them

`config.json` now supports:

```json
{
  "retention": {
    "workers": {
      "autoPruneAfterDays": 7,
      "compactArchives": true,
      "maxArchiveEntries": 10,
      "maxArchiveAgeDays": 30,
      "maxArchiveBytes": 50000000,
      "allowDeleteArchived": false
    },
    "teams": {
      "autoPruneAfterDays": 14,
      "compactArchives": true,
      "maxArchiveEntries": 10,
      "maxArchiveAgeDays": 30,
      "maxArchiveBytes": 50000000,
      "allowDeleteArchived": false
    }
  }
}
```
