# External Project Adoption Matrix

## Decision Rules

- `Adopt`: use directly as an external companion because it solves an adjacent problem cleanly
- `Build on`: keep our own runtime and state model, but borrow patterns or interop with the project
- `Reference only`: useful inspiration, but too broad or too opinionated to become a dependency
- `Avoid`: poor fit, stale, or too risky

## By Project

### `jenslys/opencode-gemini-auth`

- Classification: `Adopt`
- Use: optional provider-auth companion plugin for local OpenCode usage
- Note: useful for operator ergonomics, but not part of the extension-stack runtime

### `inkdust2021/opencode-vibeguard`

- Classification: `Adopt`
- Use: optional secrets-redaction companion plugin for local OpenCode usage
- Note: strong cross-cutting safety value, but separate from queue/worker/memory runtime work

### `athal7/opencode-devcontainers`

- Classification: `Build on`
- Use: worker isolation and multi-branch workspace execution in later orchestrator phases
- Note: especially relevant for detached workers and team fan-out where container or worktree isolation matters

### `different-ai/opencode-scheduler`

- Classification: `Build on`
- Use: Phase 1 scheduler backend inspiration
- Note: strongest direct input for OS-native timers, supervised runs, and no-overlap execution

### `kdcokenny/opencode-background-agents`

- Classification: `Build on`
- Use: Phase 2 worker lifecycle inspiration
- Note: strongest reference for explicit delegation lifecycle, persistence-before-notification, and compaction-safe retrieval

### `backnotprop/plannotator`

- Classification: `Build on`
- Use: Phase 4 and Phase 5 human approval and review UX
- Note: preferred path for visual plan review, diff review, and structured feedback loops instead of inventing a bespoke review UI early

### `hosenur/portal`

- Classification: `Reference only`
- Use: Phase 6 remote/mobile control-plane inspiration
- Note: especially interesting for phone or separate-device prompting, browser access, and lightweight remote session control without making UI work the core runtime dependency

### `different-ai/openwork`

- Classification: `Reference only`
- Use: remote/team UX inspiration
- Note: relevant product direction, but broader than the extension-stack runtime target and mixed-license in parts

### `NeuralNomadsAI/CodeNomad`

- Classification: `Reference only`
- Use: desktop/server cockpit inspiration
- Note: useful if the project later grows into a richer operator UI, but not a runtime base today

### `darrenhinde/OpenAgentsControl`

- Classification: `Reference only`
- Use: pack and workflow conventions
- Note: strong source for plan-first, approval-gated, editable-agent workflow design

### `Cluster444/agentic`

- Classification: `Reference only`
- Use: context engineering and reusable workflow conventions
- Note: good source for memory and pack-adjacent structure, but not the runtime foundation

### `Opencode-DCP/opencode-dynamic-context-pruning`

- Classification: `Reference only`
- Use: optional companion for context control
- Note: useful adjacent capability, but not a replacement for persistent skeptical memory

### `kdcokenny/opencode-workspace`

- Classification: `Reference only`
- Use: bundled harness composition reference
- Note: helpful example of how multiple plugins, agents, and commands can be assembled, but not a fit as the core dependency

### `shekohex/opencode-google-antigravity-auth`

- Classification: `Avoid`
- Use: none
- Note: archived fork with policy risk and no roadmap relevance

## By Phase

### Phase 1

- Primary external reference: `different-ai/opencode-scheduler`
- Borrow points: OS-native wake-up, supervised execution, no-overlap semantics, per-workdir scoping

### Phase 2

- Primary external references: `kdcokenny/opencode-background-agents`, `athal7/opencode-devcontainers`
- Borrow points: explicit lifecycle states, durable delegation artifacts, notification ordering, isolated execution contexts

### Phase 3

- Secondary references: `Cluster444/agentic`, `Opencode-DCP/opencode-dynamic-context-pruning`
- Borrow points: context discipline, durable retrieval, compact memory index patterns

### Phase 4

- Primary external references: `backnotprop/plannotator`, `darrenhinde/OpenAgentsControl`
- Borrow points: visual review handoff, approval loops, structured feedback, reusable plan/review workflows

### Phase 5

- Primary external references: `backnotprop/plannotator`, `athal7/opencode-devcontainers`, `different-ai/openwork`
- Borrow points: team review UX, isolated parallel workspaces, orchestration ergonomics, team-facing surfaces

### Phase 6

- Primary external references: `hosenur/portal`, `different-ai/openwork`, `NeuralNomadsAI/CodeNomad`
- Borrow points: mobile/browser prompting, remote session access, lightweight control-plane UX, client/server split

## Current Decision

- Keep building the extension-stack runtime in-repo.
- Use companion plugins directly where they solve adjacent operator problems cleanly.
- Prefer interop or optional handoff over adopting larger UI products as base dependencies.
