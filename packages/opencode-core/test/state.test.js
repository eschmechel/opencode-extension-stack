import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ensureStateLayout, getOpencodePaths, loadConfig, withRepoLock } from '../src/index.js';

async function createTempRepo() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-core-'));
  await fs.mkdir(path.join(repoRoot, '.git'));
  return repoRoot;
}

test('ensureStateLayout creates the expected repo-local files', async () => {
  const repoRoot = await createTempRepo();
  const paths = await ensureStateLayout(repoRoot);

  assert.equal(await exists(paths.config), true);
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

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
