# Publishing Strategy

## Overview

The opencode-extension-stack is a monorepo that publishes six independent packages under the [`@opencode-extension-stack`](https://www.npmjs.com/org/opencode-extension-stack) npm organization.

## Packages

| Package | Description | Registry |
|---|---|---|
| `opencode-core` | Schemas, config, state, locking, logging | npm |
| `opencode-kairos` | Queue, scheduler, runner, supervisor, daemon | npm |
| `opencode-orchestrator` | Worker lifecycle, team orchestration | npm |
| `opencode-memory` | Evidence-backed skeptical memory | npm |
| `opencode-packs` | Prompt pack registry, renderer, execution | npm |
| `opencode-bridge` | Remote enqueue, approval flow, Telegram bridge | npm |

## Versioning

- **Strategy**: Fixed versioning across the monorepo — all packages share the same `0.1.0` release baseline and increment together.
- **Rationale**: Packages are co-developed and tightly coupled by design; independent versioning would create compatibility tracking overhead without meaningful benefit at this scale.
- **Process**: Bump version in all `package.json` files + root `package.json` before each release tag.

```bash
# Version bump script (run before release)
VERSION=0.2.0
for pkg in packages/*/package.json; do
  node -e "const p=require('$pkg'); p.version='$VERSION'; require('fs').writeFileSync('$pkg', JSON.stringify(p, null, 2)+'\n')"
done
sed -i "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" package.json
git add -A && git commit -m "chore(release): bump to $VERSION"
git tag "v$VERSION"
```

## npm Organization Setup

1. Create an npm organization: https://www.npmjs.com/org/create
2. Name: `opencode-extension-stack`
3. Add team members with appropriate roles
4. Grant publish access to each package

## Publishing Process

### Prerequisites

```bash
# Login to npm
npm login

# Verify access
npm access ls-packages --org opencode-extension-stack
```

### Per-package publish

```bash
# Build/check each package, then publish
cd packages/opencode-core && npm publish --access public
cd packages/opencode-kairos && npm publish --access public
cd packages/opencode-orchestrator && npm publish --access public
cd packages/opencode-memory && npm publish --access public
cd packages/opencode-packs && npm publish --access public
cd packages/opencode-bridge && npm publish --access public
```

### Automated release

A `release:check` command verifies readiness:

```bash
pnpm run release:check
```

The CI workflow (`.github/workflows/ci.yml`) runs tests and smoke checks on every push and PR. A GitHub Actions release workflow can be added to automate npm publishing on tag push.

## Access Control

- All packages are published as **public** (`--access public`).
- Packages are **not** marked `private` in `package.json`.
- Use `npm access` to manage team permissions per package:

```bash
# Grant read-only to a team for a package
npm access grant read-only opencode-extension-stack:developers opencode-kairos

# Grant publish to maintainers only
npm access grant list opencode-extension-stack:maintainers opencode-kairos
```

## Stability Guarantees

This is a **v0.x** release series. API surface is not yet stable.

- **Patch** (`0.1.x`): Bug fixes, internal refactoring, test additions — no API changes.
- **Minor** (`0.x.1`): New commands, new options, new files in `.opencode/` state — backward-compatible.
- **Major** (`x.0.0`): Breaking command surface, schema changes, state layout changes.

## Installation

After publishing, consumers install via:

```bash
npm install @opencode-extension-stack/opencode-kairos
# or
pnpm add @opencode-extension-stack/opencode-kairos
```

## Workspace Development

During local development, packages reference each other via workspace protocol:

```json
{
  "dependencies": {
    "@opencode-extension-stack/opencode-core": "workspace:*"
  }
}
```

`pnpm install` resolves workspace links automatically. Do not publish workspace references — they resolve at install time.

## GitHub Release

Create a GitHub Release from `docs/releases/v{version}.md` matching the tag:

```bash
# Push the version tag (triggers CI + optional automation)
git push origin v0.1.0

# Create release notes via GitHub CLI
gh release create "v0.1.0" \
  --title "OpenCode Extension Stack v0.1.0" \
  --notes-file docs/releases/v0.1.0.md
```

## Release Checklist

- [ ] All tests pass: `pnpm test`
- [ ] All smoke tests pass: `pnpm run smoke`
- [ ] Version bumped in all `package.json` files
- [ ] `CHANGELOG.md` updated
- [ ] `v{version}` tag created
- [ ] npm packages published (`npm publish --access public`)
- [ ] GitHub Release created
- [ ] Tag pushed to origin

## Future Considerations

- **Scoped `@opencode` namespace**: If OpenCode itself adopts this stack, packages may migrate to `@opencode/kairos`, `@opencode/memory`, etc.
- **Auto-publish via GitHub Actions**: Add a release workflow that publishes to npm on tag push, with manual approval gate.
- **Provenance attestations**: Add SLSA provenance to published packages for supply-chain security.
