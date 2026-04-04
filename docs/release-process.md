# Release Process

This repo is release-ready when tests, smoke checks, and docs all match the current command surface.

## Release Checklist

1. ensure the working tree is clean
2. run:

```bash
pnpm run release:check
```

3. review docs:

- `README.md`
- `docs/quickstart.md`
- `docs/operator-guide.md`
- `docs/remote-bridge-telegram-setup.md`
- `docs/team-template-memory-workflows.md`

4. update `CHANGELOG.md`
5. create a version tag
6. publish release notes using the changelog summary and notable commits

## Suggested Release Notes Structure

- Highlights
- New commands
- Breaking changes
- Upgrade notes
- Verification notes

## Suggested Validation Commands

```bash
pnpm test
pnpm run smoke
```
