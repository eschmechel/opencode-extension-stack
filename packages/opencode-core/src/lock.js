import { ensureStateLayout, getOpencodePaths } from './state.js';
import { acquireLockFile, releaseOwnedLockFile } from './repo-lock.js';

export async function withRepoLock(repoRoot, work) {
  await ensureStateLayout(repoRoot);
  const { repoLock } = getOpencodePaths(repoRoot);
  const lock = await acquireLockFile(repoLock);

  try {
    return await work();
  } finally {
    await releaseOwnedLockFile(repoLock, lock.token);
  }
}
