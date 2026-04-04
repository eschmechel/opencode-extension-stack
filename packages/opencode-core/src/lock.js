import fs from 'node:fs/promises';

import { ensureStateLayout, getOpencodePaths } from './state.js';

export async function withRepoLock(repoRoot, work) {
  await ensureStateLayout(repoRoot);
  const { repoLock } = getOpencodePaths(repoRoot);

  let handle;

  try {
    handle = await fs.open(repoLock, 'wx');
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      throw new Error(`Repo state is already locked: ${repoLock}`);
    }

    throw error;
  }

  try {
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }, null, 2) + '\n',
      'utf8',
    );
    return await work();
  } finally {
    await handle.close().catch(() => {});
    await fs.rm(repoLock, { force: true }).catch(() => {});
  }
}
