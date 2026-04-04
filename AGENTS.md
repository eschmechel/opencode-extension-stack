# AGENTS.md

## Goal

Build an OpenCode-first extension stack that adds the durable missing pieces around unattended jobs, scheduling, worker lifecycle, skeptical memory, prompt packs, team orchestration, and an optional remote bridge.

Do not chase full Claw parity. Reuse OpenCode where it already has strong primitives.

## Source Of Truth

Read these first before making structural changes:

- `docs/phase-0-1-plan.md`
- `docs/external-project-adoption-matrix.md`
- `/home/Eragon/Documents/opencode-extension-architecture.md`
- `/home/Eragon/Documents/opencode-porting-roadmap.md`
- `/home/Eragon/Documents/opencode-mvp-backlog.md`
- `/home/Eragon/Documents/opencode-session-archive-2026-04-03.md`

## Package Responsibilities

- `packages/opencode-core`: schemas, config, state layout, logs, locking, shared helpers
- `packages/opencode-kairos`: queue, schedules, runner, unattended execution slice
- `packages/opencode-orchestrator`: detached workers and team orchestration
- `packages/opencode-memory`: persistent skeptical memory
- `packages/opencode-packs`: reusable command packs like `/ultraplan` and `/review`
- `packages/opencode-bridge`: remote enqueue, approvals, and control plane

## Current Priority

Finish Phase 1 before spreading into later packages:

1. queue and job lifecycle
2. recurring schedule lifecycle
3. minimal runner/supervisor path
4. budget and allowlist enforcement

## External Project Guidance

- Build on: `different-ai/opencode-scheduler`, `kdcokenny/opencode-background-agents`, `athal7/opencode-devcontainers`, `backnotprop/plannotator`
- Reference only: `hosenur/portal`, `different-ai/openwork`, `NeuralNomadsAI/CodeNomad`, `darrenhinde/OpenAgentsControl`, `Cluster444/agentic`
- Companion plugins already chosen locally: `opencode-gemini-auth`, `opencode-vibeguard`

## Working Rules

- Prefer small, reviewable changes.
- Keep repo-local state under `.opencode/`.
- Prefer append-only logs over silent state mutation.
- Do not add speculative abstractions when one concrete function is enough.
- Preserve the slash-command surface from the roadmap, but internal runner/admin commands are acceptable when needed for implementation.

## Commits

- Use thoughtful commits at good stopping points.
- Use conventional commit styling.
- Keep unrelated work out of the same commit.
- Example scopes: `feat(kairos): ...`, `feat(core): ...`, `docs(roadmap): ...`, `fix(kairos): ...`
