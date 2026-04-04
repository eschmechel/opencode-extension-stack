# Operator Guide

This guide is the shortest path to using the stack day to day.

## Prerequisites

- install dependencies with `pnpm install`
- run commands from the repo root
- bootstrap repo-local state by running any package command once

## Quick Checks

- run the full suite with `pnpm test`
- run CLI smoke checks with `pnpm run smoke`

## Unattended Jobs

- queue work: `pnpm run kairos -- /queue add "summarize open failures"`
- run one unattended cycle: `pnpm run kairos -- runner once --force`
- tick the scheduler and runner together: `pnpm run kairos -- supervisor once --force`
- inspect jobs: `pnpm run kairos -- /jobs`
- inspect notifications: `pnpm run kairos -- notifications list 20`

## Teams And Workers

- save a reusable team shape: `pnpm run orchestrator -- /team template save review-template 2 "review current diff" --max-concurrency 1`
- launch from the template: `pnpm run orchestrator -- /team create --template review-template`
- inspect a team: `pnpm run orchestrator -- /team show <team-id>`
- rerun failed branches: `pnpm run orchestrator -- /team rerun-failed <team-id>`
- inspect team-scoped memory: `pnpm run orchestrator -- /team memory <team-id> show`

## Skeptical Memory

- add run-backed memory: `pnpm run memory -- /memory add "Queue retries are delayed by retryAt" --run <run-id> --topic queue`
- list repairable stale entries: `pnpm run memory -- /memory stale --repairable`
- inspect contradictions: `pnpm run memory -- /memory contradictions`
- apply an advisory merge: `pnpm run memory -- /memory merge "queue retry policy" "retry queue policy" --target "queue retry policy"`

## Packs

- browse packs: `pnpm run packs -- /packs list`
- inspect a contract: `pnpm run packs -- /packs contract review-remote`
- prepare a remote packet: `pnpm run packs -- /packs execute review-remote "Review release branch changes" --channel remote`
- inspect invocation history: `pnpm run packs -- /packs history 20`

## Remote Bridge

- show auth and webhook state: `pnpm run bridge -- /remote auth`
- enqueue remote work: `pnpm run bridge -- /remote enqueue "summarize open failures" --requested-by mobile`
- approve a request: `pnpm run bridge -- /remote approve <remote-id>`
- revoke queued or pending requests: `pnpm run bridge -- /remote revoke [<remote-id>]`
- serve the local control plane: `pnpm run bridge -- /remote serve 8787`

## Recommended Release Check

1. `pnpm test`
2. `pnpm run smoke`
3. verify `README.md` and relevant `docs/*.md` changes match the shipped command surface
