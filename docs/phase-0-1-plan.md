# Phase 0 and Phase 1 Plan

## Repo Reality

The target repository is an empty git repo with no prior OpenCode plugin or CLI implementation. Because of that, the planning documents are the source of truth and the first step is to establish a runnable monorepo foundation instead of retrofitting existing code.

## Phase 0

Deliver in `opencode-core`:

- workspace scaffold for the six planned packages
- shared record factories for jobs, schedules, workers, teams, memory, and remote requests
- repo-local config loader with safe defaults
- `.opencode/` state bootstrap
- stable prefixed IDs
- append-only per-run event logs
- repo lock helper for state mutations

## Phase 1

Deliver in `opencode-kairos`:

- queue state backed by `.opencode/jobs.json`
- `/queue add`
- `/queue list`
- `/jobs`
- minimal `/cron add` and `/cron list`
- one scheduler tick path that materializes due cron entries into queued jobs

## Explicit Deferrals

The following stay out of this first slice to keep the change small and reviewable:

- idle detection and unattended dispatch loop
- retry/backoff rules
- queue cancellation and job rerun
- detached worker lifecycle
- memory writes
- prompt packs and remote bridge integration
