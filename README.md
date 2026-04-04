# OpenCode Extension Stack

OpenCode-first extension stack for the durable gaps that OpenCode does not already cover natively: unattended jobs, scheduling, worker orchestration, persistent skeptical memory, prompt packs, and an optional remote bridge.

This repo started as an empty git repository, so the first pass focuses on a clean monorepo scaffold plus the Phase 0 and early Phase 1 foundation described in the planning docs.

## Packages

- `packages/opencode-core`: shared schemas, config loading, state bootstrap, append-only run logs, repo lock helper
- `packages/opencode-kairos`: unattended queue and minimal scheduler slice
- `packages/opencode-orchestrator`: placeholder for detached worker lifecycle
- `packages/opencode-memory`: evidence-backed skeptical memory storage, search, and compaction
- `packages/opencode-packs`: reusable command pack registry, renderer, and contract validator
- `packages/opencode-bridge`: remote enqueue, approval flow, and local control-plane state

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
- `/team create --template <name> [prompt override]`
- `/team template save <name> <count> <prompt>`
- `/team template save <name> --from-team <teamId>`
- `/team template list`
- `/team template show <name>`
- `/team template delete <name>`
- `/team memory <teamId> [show [topic] | search <query> [--stale] [--repairable] | stale [--repairable] | contradictions | rebuild | compact]`
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

- `/memory show [topic] [--team <teamId>]`
- `/memory search <query> [--stale] [--repairable] [--team <teamId>]`
- `/memory stale [--repairable] [--team <teamId>]`
- `/memory contradictions [--team <teamId>]`
- `/memory add <note> (--run <runId> | --worker <workerId> | --team-result <teamId>) [--topic <topic>] [--team <teamId>]`
- `/memory repair <memoryId> (--run <runId> | --worker <workerId> | --team-result <teamId>) [--summary <text>] [--team <teamId>]`
- `/memory merge <topicA> <topicB> [--target <topic>] [--force] [--team <teamId>]`
- `/memory rebuild [--team <teamId>]`
- `/memory compact [--team <teamId>]`

Run pack commands with `pnpm run packs -- ...`.

- `/packs list`
- `/packs show <pack>`
- `/packs examples <pack>`
- `/packs contract <pack>`
- `/packs render <pack> <request> [--context <text>] [--constraint <text>] [--json]`
- `/packs execute <pack> <request> [--context <text>] [--constraint <text>] [--channel <local|remote>] [--json]`
- `/packs complete <invocationId> (--output-json <json> | --output-file <path>) [--json]`
- `/packs invocation <invocationId>`
- `/packs history [limit] [--pack <pack>] [--action <action>]`
- `/packs validate <pack> <json>`
- `/ultraplan <request>`
- `/review <request>`
- `/review-remote <request>`
- `/triage <request>`
- `/handoff <request>`

Run remote bridge commands with `pnpm run bridge -- ...`.

- `/remote status [id]`
- `/remote enqueue <prompt>`
- `/remote approve <id>`
- `/remote revoke [id]`

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
pnpm run orchestrator -- /team template save review-template 2 "review current branch changes" --max-concurrency 1 --max-total-runs 3
pnpm run orchestrator -- /team create --template review-template
pnpm run orchestrator -- /team memory <team-id> show
pnpm run orchestrator -- /team memory <team-id> contradictions
pnpm run orchestrator -- /team list
pnpm run orchestrator -- /team show <team-id>
pnpm run orchestrator -- /parallel 2 "compare two implementation approaches"
pnpm run orchestrator -- /worker start "investigate flaky test output"
pnpm run orchestrator -- /worker list
pnpm run memory -- /memory add "Queue retries are delayed by retryAt" --topic "queue retry" --run <run-id>
pnpm run memory -- /memory add "Worker branch found a safe migration path" --topic migrations --worker <worker-id>
pnpm run memory -- /memory add "Team synthesis says option B is safer" --topic rollout --team-result <team-id>
pnpm run memory -- /memory stale --repairable
pnpm run memory -- /memory contradictions
pnpm run memory -- /memory merge "queue retry policy" "retry queue policy" --target "queue retry policy"
pnpm run memory -- /memory show
pnpm run memory -- /memory search retryAt
pnpm run memory -- /memory add "Release team keeps worker notes separate" --team release-team --topic workers --run <run-id>
pnpm run packs -- /packs list
pnpm run packs -- /packs show review
pnpm run packs -- /packs examples handoff
pnpm run packs -- /ultraplan "Design a safe rollout plan"
pnpm run packs -- /packs execute triage "Workers stopped after the last runtime change" --channel remote
pnpm run packs -- /packs render review-remote "Review remote branch changes" --context "Snapshot attached" --json
pnpm run bridge -- /remote enqueue "summarize open failures" --requested-by mobile
pnpm run bridge -- /remote approve <remote-id>
pnpm run bridge -- /remote status
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

Remote bridge state currently uses:

- `.opencode/remote/requests.json`
- `.opencode/remote/events.ndjson`

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
- team templates live under `.opencode/teams/templates/*.json`
- `/parallel` is a thin worker-fanout path built on top of team creation
- team list aggregates worker states into per-team counts for quick supervision
- teams expose synthesized summaries and per-worker branch status via `/team show`
- `/team show` also exposes the per-team memory namespace path and entry counts
- `/team memory ...` provides a team-scoped shortcut into the existing memory system without manually repeating `--team <teamId>`
- `/team create --template ...` and `/parallel --template ...` reuse saved fanout defaults for easy relaunch
- `/team template save --from-team ...` can capture an existing team setup as a reusable template
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
- team-local memory namespaces live under `.opencode/memory/team/<teamId>/`
- `MEMORY.md` is a generated pointer index, rebuilt from topic files
- `/memory add` accepts successful Kairos run evidence, successful detached worker evidence, or successful team synthesis evidence
- `/memory repair` creates a fresh entry for a stale note, links the old entry to the replacement, and rebinds evidence without deleting audit history
- `/memory stale --repairable` lists only stale entries that can be rebound to fresh evidence
- `/memory search ... --stale --repairable` narrows search to repairable stale notes
- `/memory contradictions` surfaces likely opposing claims inside the same topic using skeptical heuristics
- all memory commands default to repo-wide memory and can target a team namespace with `--team <teamId>`
- `/memory compact` refreshes stale markers when backing run artifacts disappear or stop being valid
- duplicate memory entries are compacted by marking older duplicates stale instead of deleting them
- topics with several active notes are consolidated into a single evidence-backed summary entry and the superseded notes are marked stale with an audit link
- `MEMORY.md` now includes heuristic merge candidates across topics and drift alerts for low-overlap active notes
- `/memory merge` lets you explicitly apply an advisory cross-topic merge and keeps audit links back to the source notes
- `MEMORY.md` now also includes contradiction alerts for opposing active claims in the same topic
- cross-topic heuristics are advisory only; they surface candidates without silently merging topic files

## Pack Behavior

- packs are reusable prompt definitions with explicit agent presets and model defaults
- each pack exposes a structured JSON output contract for automation-friendly validation
- packs now store invocation packets and append-only history under `.opencode/packs/`
- `/packs execute` prepares a durable execution/handoff packet for local or remote follow-up
- `/packs complete` validates a returned JSON payload against the selected pack contract and records the outcome
- `/ultraplan` renders a planning pack focused on assumptions, steps, and validation
- `/review` renders a findings-first review pack aligned with the repo review style
- `/review-remote` renders an async approval/handoff review packet for remote workflows
- `/triage` classifies incoming work by category, priority, and next actions
- `/handoff` prepares a concise continuation packet for another human or agent
- pack definitions now include validated sample inputs/outputs for automation and documentation
- `/packs validate` checks a JSON output payload against the selected pack contract

## Remote Behavior

- remote requests are stored under `.opencode/remote/` so they can be monitored without keeping a local TUI session open
- `/remote enqueue` creates an approval-gated request by default
- `/remote approve` turns an approved request into a local Kairos queue job
- `/remote revoke` revokes pending approvals and can cancel a still-queued remote job before it starts
- `/remote status` polls request state and follows the linked Kairos job once approved
- prompts beginning with `/review` or `/review-remote` are tagged as remote review handoffs and generate a `review-remote` packet under `.opencode/remote/packets/`

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
  },
  "remote": {
    "approvalRequired": true,
    "maxStatusRequests": 20
  },
  "memory": {
    "compact": {
      "topicConsolidationMinActive": 3,
      "topicConsolidationSummaryLimit": 6,
      "crossTopicMergeMinSharedTerms": 2,
      "crossTopicMergeMinSimilarity": 0.8,
      "contradictionMinSharedTerms": 2,
      "driftMinActiveEntries": 2,
      "driftMaxPairSimilarity": 0.35
    },
    "repair": {
      "maxListedEntries": 20
    }
  }
}
```
