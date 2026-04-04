# Team Template And Memory Workflows

This guide covers the practical Phase 5 flow: save a team shape, launch it repeatedly, inspect synthesis, and use the per-team skeptical memory namespace.

## Save A Template

Create a reusable team definition directly:

```bash
pnpm run orchestrator -- /team template save review-template 2 "review current branch changes" --max-concurrency 1 --max-total-runs 3 --description "small review fanout"
```

Or capture an existing team:

```bash
pnpm run orchestrator -- /team template save review-template --from-team <team-id>
```

Inspect templates:

```bash
pnpm run orchestrator -- /team template list
pnpm run orchestrator -- /team template show review-template
```

## Launch From A Template

```bash
pnpm run orchestrator -- /team create --template review-template
pnpm run orchestrator -- /parallel --template review-template
```

You can still override prompt text or runtime limits at launch time.

## Supervise The Team

```bash
pnpm run orchestrator -- /team list
pnpm run orchestrator -- /team show <team-id>
pnpm run orchestrator -- /team rerun-failed <team-id>
```

`/team show` includes:

- worker status counts
- synthesized summary text
- per-worker output previews
- per-team memory summary counts and index path

## Use Team Memory Shortcuts

Every team has its own memory namespace under `.opencode/memory/team/<team-slug>/`.

Use the orchestrator shortcuts when you already know the team id:

```bash
pnpm run orchestrator -- /team memory <team-id> show
pnpm run orchestrator -- /team memory <team-id> search rollback --stale
pnpm run orchestrator -- /team memory <team-id> stale --repairable
pnpm run orchestrator -- /team memory <team-id> contradictions
pnpm run orchestrator -- /team memory <team-id> rebuild
pnpm run orchestrator -- /team memory <team-id> compact
```

Use the direct memory CLI when you want to add or repair entries in that namespace:

```bash
pnpm run memory -- /memory add "Release team found a safe rollback path" --team <team-id> --topic rollback --worker <worker-id>
pnpm run memory -- /memory repair <memory-id> --team <team-id> --run <run-id>
```

## Suggested Workflow

1. save a template for a repeated team pattern
2. launch the team from the template
3. inspect `/team show` for synthesis and branch failures
4. rerun failed branches if needed
5. add high-value results into the team memory namespace
6. run contradiction or stale checks before reusing that memory later
