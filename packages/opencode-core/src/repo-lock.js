import crypto from 'node:crypto';
import fs from 'node:fs/promises';

export const LOCK_STALE_AFTER_MS = 5 * 60_000;

export async function acquireLockFile(lockPath, options = {}) {
  const metadata = createLockMetadata(options.metadata);
  const staleAfterMs = options.staleAfterMs ?? LOCK_STALE_AFTER_MS;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fs.writeFile(lockPath, serializeLockMetadata(metadata), { flag: 'wx' });
      return metadata;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        throw error;
      }

      const probe = await probeLockFile(lockPath, { staleAfterMs });
      if (!probe.locked) {
        continue;
      }

      throw new Error(`Repo state is already locked: ${lockPath}`);
    }
  }

  throw new Error(`Repo state is already locked: ${lockPath}`);
}

export async function releaseOwnedLockFile(lockPath, token) {
  try {
    const current = await inspectLockFile(lockPath);
    if (!current.exists) {
      return;
    }

    if (current.metadata?.token !== token) {
      return;
    }

    await fs.rm(lockPath, { force: true });
  } catch {
    // Lock cleanup should not hide the original work result.
  }
}

export async function probeLockFile(lockPath, options = {}) {
  const inspection = await inspectLockFile(lockPath, options);
  if (!inspection.exists) {
    return {
      locked: false,
      stale: false,
      recovered: false,
      metadata: null,
    };
  }

  if (!inspection.stale) {
    return {
      locked: true,
      stale: false,
      recovered: false,
      metadata: inspection.metadata,
    };
  }

  const removed = await removeInspectedStaleLock(lockPath, inspection);
  if (!removed) {
    return {
      locked: true,
      stale: false,
      recovered: false,
      metadata: inspection.metadata,
    };
  }

  return {
    locked: false,
    stale: true,
    recovered: true,
    metadata: inspection.metadata,
  };
}

async function removeInspectedStaleLock(lockPath, inspection) {
  const current = await inspectLockFile(lockPath, { staleAfterMs: LOCK_STALE_AFTER_MS });
  if (!current.exists) {
    return true;
  }

  if (!isSameInspectedLock(inspection, current)) {
    return false;
  }

  await fs.rm(lockPath, { force: true }).catch(() => {});
  return true;
}

function isSameInspectedLock(left, right) {
  if (!left.metadata || !right.metadata) {
    return left.mtimeMs === right.mtimeMs;
  }

  if (left.metadata.token && right.metadata.token) {
    return left.metadata.token === right.metadata.token;
  }

  return left.metadata.pid === right.metadata.pid && left.metadata.createdAt === right.metadata.createdAt;
}

export async function inspectLockFile(lockPath, options = {}) {
  const staleAfterMs = options.staleAfterMs ?? LOCK_STALE_AFTER_MS;

  let stats;
  try {
    stats = await fs.stat(lockPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return {
        exists: false,
        stale: false,
        metadata: null,
      };
    }

    throw error;
  }

  const ageMs = Math.max(0, Date.now() - stats.mtimeMs);

  try {
    const content = await fs.readFile(lockPath, 'utf8');
    const metadata = JSON.parse(content);
    const ownerAlive = typeof metadata?.pid === 'number' && isProcessAlive(metadata.pid);

    return {
      exists: true,
      stale: !ownerAlive,
      metadata,
      ageMs,
      mtimeMs: stats.mtimeMs,
    };
  } catch {
    return {
      exists: true,
      stale: ageMs > staleAfterMs,
      metadata: null,
      ageMs,
      mtimeMs: stats.mtimeMs,
    };
  }
}

function createLockMetadata(extra = {}) {
  return {
    token: crypto.randomUUID(),
    pid: process.pid,
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

function serializeLockMetadata(metadata) {
  return JSON.stringify(metadata, null, 2) + '\n';
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
