# Changelog

## Unreleased

- Nothing yet.

## 0.1.0 - 2026-04-04

### Highlights

- completed the initial OpenCode extension stack across unattended jobs, orchestration, skeptical memory, prompt packs, and the remote bridge
- added end-to-end integration coverage, smoke checks, operator docs, CI workflows, and release scaffolding

### Included Packages

- `@opencode-extension-stack/opencode-core`
- `@opencode-extension-stack/opencode-kairos`
- `@opencode-extension-stack/opencode-orchestrator`
- `@opencode-extension-stack/opencode-memory`
- `@opencode-extension-stack/opencode-packs`
- `@opencode-extension-stack/opencode-bridge`

### Notable Capabilities

- unattended queue, cron scheduling, runner/supervisor/daemon lifecycle, retry/backoff, and budgets
- detached workers, team templates, retention controls, synthesis, and team-scoped memory shortcuts
- skeptical memory with evidence-backed notes, repair, consolidation, contradiction checks, merge workflows, and team namespaces
- reusable prompt packs including local and remote review flows with durable invocation history
- remote enqueue, approval, revoke, SSE events, signed approval links, and Telegram integration

### Verification

- `pnpm test`
- `pnpm run smoke`
