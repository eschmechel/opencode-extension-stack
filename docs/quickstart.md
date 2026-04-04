# Quickstart

## Install

```bash
pnpm install
```

## Verify The Repo

```bash
pnpm test
pnpm run smoke
```

## First Commands

Queue unattended work:

```bash
pnpm run kairos -- /queue add "summarize open failures"
pnpm run kairos -- runner once --force
```

Launch a reusable team:

```bash
pnpm run orchestrator -- /team template save review-template 2 "review current branch changes" --max-concurrency 1
pnpm run orchestrator -- /team create --template review-template
pnpm run orchestrator -- /team show <team-id>
```

Store skeptical memory:

```bash
pnpm run memory -- /memory add "Queue retries are delayed by retryAt" --topic queue --run <run-id>
pnpm run memory -- /memory contradictions
```

Prepare and inspect packs:

```bash
pnpm run packs -- /packs list
pnpm run packs -- /review-remote "Review release branch changes"
```

Use the remote bridge:

```bash
pnpm run bridge -- /remote enqueue "/review inspect current diff" --requested-by mobile
pnpm run bridge -- /remote status
```

## Next Reading

- `docs/operator-guide.md`
- `docs/remote-bridge-telegram-setup.md`
- `docs/team-template-memory-workflows.md`
- `docs/release-process.md`
