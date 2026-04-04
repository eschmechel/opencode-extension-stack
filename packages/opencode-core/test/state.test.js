import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ensureStateLayout, getOpencodePaths, getRepoIdleState, loadConfig, withRepoLock } from '../src/index.js';

async function createTempRepo() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-core-'));
  await fs.mkdir(path.join(repoRoot, '.git'));
  return repoRoot;
}

test('ensureStateLayout creates the expected repo-local files', async () => {
  const repoRoot = await createTempRepo();
  const paths = await ensureStateLayout(repoRoot);

  assert.equal(await exists(paths.config), true);
  assert.equal(await exists(paths.activity), true);
  assert.equal(await exists(paths.jobs), true);
  assert.equal(await exists(paths.schedules), true);
  assert.equal(await exists(paths.memoryIndex), true);

  const config = await loadConfig(repoRoot);
  assert.deepEqual(config.repos.allowUnattended, ['.']);
});

test('withRepoLock prevents overlapping repo mutations', async () => {
  const repoRoot = await createTempRepo();
  const paths = getOpencodePaths(repoRoot);

  await withRepoLock(repoRoot, async () => {
    await assert.rejects(
      () => withRepoLock(repoRoot, async () => {}),
      /already locked/,
    );

    assert.equal(await exists(paths.repoLock), true);
  });

  assert.equal(await exists(paths.repoLock), false);
});

test('withRepoLock recovers stale lock files left by dead processes', async () => {
  const repoRoot = await createTempRepo();
  const paths = getOpencodePaths(repoRoot);

  await ensureStateLayout(repoRoot);
  await fs.writeFile(
    paths.repoLock,
    `${JSON.stringify({ pid: 999999, createdAt: '2026-04-04T00:00:00.000Z' }, null, 2)}\n`,
    'utf8',
  );

  await withRepoLock(repoRoot, async () => {
    assert.equal(await exists(paths.repoLock), true);
  });

  assert.equal(await exists(paths.repoLock), false);
});

test('getRepoIdleState heals stale repo locks instead of blocking forever', async () => {
  const repoRoot = await createTempRepo();
  const paths = getOpencodePaths(repoRoot);

  await ensureStateLayout(repoRoot);
  await fs.writeFile(
    paths.repoLock,
    `${JSON.stringify({ token: 'stale', pid: 999999, createdAt: '2026-04-04T00:00:00.000Z' }, null, 2)}\n`,
    'utf8',
  );

  const idleState = await getRepoIdleState(repoRoot, await loadConfig(repoRoot), { now: '2026-04-04T01:00:00.000Z' });
  assert.equal(idleState.reason !== 'repo_locked', true);
  assert.equal(await exists(paths.repoLock), false);
});

test('loadRepoActivity heals malformed activity payloads', async () => {
  const repoRoot = await createTempRepo();
  const paths = getOpencodePaths(repoRoot);

  await ensureStateLayout(repoRoot);
  await fs.writeFile(paths.activity, '{"lastTouchedAt":"not-a-date","source":123}', 'utf8');

  const idleState = await getRepoIdleState(repoRoot, await loadConfig(repoRoot), { now: '2026-04-04T01:00:00.000Z' });
  assert.equal(idleState.reason !== 'repo_locked', true);
});

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
