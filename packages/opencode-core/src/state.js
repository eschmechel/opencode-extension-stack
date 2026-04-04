import fs from 'node:fs/promises';
import path from 'node:path';

import {
  defaultConfig,
  defaultJobsState,
  defaultSchedulesState,
  parseConfig,
  parseJobsState,
  parseSchedulesState,
} from './schemas.js';
import { probeLockFile } from './repo-lock.js';

const MEMORY_INDEX_CONTENT = `# MEMORY\n\nThis pointer index is reserved for evidence-backed memory summaries.\n`;

export async function findRepoRoot(startDir = process.cwd()) {
  let current = path.resolve(startDir);

  while (true) {
    const gitPath = path.join(current, '.git');

    if (await pathExists(gitPath)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(startDir);
    }

    current = parent;
  }
}

export function getOpencodePaths(repoRoot) {
  const root = path.join(repoRoot, '.opencode');
  const memoryRoot = path.join(root, 'memory');

  return {
    root,
    config: path.join(root, 'config.json'),
    activity: path.join(root, 'activity.json'),
    jobs: path.join(root, 'jobs.json'),
    notifications: path.join(root, 'notifications.ndjson'),
    schedules: path.join(root, 'schedules.json'),
    runsDir: path.join(root, 'runs'),
    workersDir: path.join(root, 'workers'),
    teamsDir: path.join(root, 'teams'),
    teamTemplatesDir: path.join(root, 'teams', 'templates'),
    remoteDir: path.join(root, 'remote'),
    memoryDir: memoryRoot,
    memoryIndex: path.join(memoryRoot, 'MEMORY.md'),
    memoryTopicsDir: path.join(memoryRoot, 'topics'),
    memoryTeamDir: path.join(memoryRoot, 'team'),
    repoLock: path.join(root, '.repo.lock'),
  };
}

export async function ensureStateLayout(repoRoot) {
  const paths = getOpencodePaths(repoRoot);

  await fs.mkdir(paths.root, { recursive: true });
  await fs.mkdir(paths.runsDir, { recursive: true });
  await fs.mkdir(paths.workersDir, { recursive: true });
  await fs.mkdir(paths.teamsDir, { recursive: true });
  await fs.mkdir(paths.teamTemplatesDir, { recursive: true });
  await fs.mkdir(paths.remoteDir, { recursive: true });
  await fs.mkdir(paths.memoryDir, { recursive: true });
  await fs.mkdir(paths.memoryTopicsDir, { recursive: true });
  await fs.mkdir(paths.memoryTeamDir, { recursive: true });

  await ensureJsonFile(paths.config, defaultConfig());
  await ensureJsonFile(paths.activity, { lastTouchedAt: null, source: null, meta: {} });
  await ensureJsonFile(paths.jobs, defaultJobsState());
  await ensureJsonFile(paths.schedules, defaultSchedulesState());
  await ensureTextFile(paths.memoryIndex, MEMORY_INDEX_CONTENT);

  return paths;
}

export async function loadConfig(repoRoot) {
  const paths = await ensureStateLayout(repoRoot);
  const raw = await readJson(paths.config, defaultConfig());
  return parseConfig(raw);
}

export async function saveConfig(repoRoot, config) {
  const paths = await ensureStateLayout(repoRoot);
  await writeJsonAtomic(paths.config, parseConfig(config));
}

export async function loadJobsState(repoRoot) {
  const paths = await ensureStateLayout(repoRoot);
  const raw = await readJson(paths.jobs, defaultJobsState());
  return parseJobsState(raw);
}

export async function saveJobsState(repoRoot, jobsState) {
  const paths = await ensureStateLayout(repoRoot);
  await writeJsonAtomic(paths.jobs, parseJobsState(jobsState));
}

export async function loadSchedulesState(repoRoot) {
  const paths = await ensureStateLayout(repoRoot);
  const raw = await readJson(paths.schedules, defaultSchedulesState());
  return parseSchedulesState(raw);
}

export async function saveSchedulesState(repoRoot, schedulesState) {
  const paths = await ensureStateLayout(repoRoot);
  await writeJsonAtomic(paths.schedules, parseSchedulesState(schedulesState));
}

export async function appendRunEvent(repoRoot, runId, eventType, payload = {}) {
  const paths = await ensureStateLayout(repoRoot);
  const runDir = path.join(paths.runsDir, runId);
  const eventPath = path.join(runDir, 'events.ndjson');

  await fs.mkdir(runDir, { recursive: true });
  await fs.appendFile(
    eventPath,
    `${JSON.stringify({ at: new Date().toISOString(), event: eventType, payload })}\n`,
    'utf8',
  );

  return eventPath;
}

export async function loadRepoActivity(repoRoot) {
  const paths = await ensureStateLayout(repoRoot);
  const raw = await readJson(paths.activity, { lastTouchedAt: null, source: null, meta: {} });
  return parseRepoActivity(raw);
}

export async function recordRepoActivity(repoRoot, source = 'manual', meta = {}) {
  const paths = await ensureStateLayout(repoRoot);
  const activity = {
    lastTouchedAt: new Date().toISOString(),
    source,
    meta,
  };
  await writeJsonAtomic(paths.activity, activity);
  return activity;
}

export async function appendNotification(repoRoot, notification) {
  const paths = await ensureStateLayout(repoRoot);
  await fs.appendFile(paths.notifications, `${JSON.stringify(notification)}\n`, 'utf8');
  return paths.notifications;
}

export async function loadNotifications(repoRoot, limit = 50) {
  const paths = await ensureStateLayout(repoRoot);
  return readLastJsonLines(paths.notifications, limit);
}

export async function isRepoStateLocked(repoRoot) {
  const paths = getOpencodePaths(repoRoot);
  const probe = await probeLockFile(paths.repoLock);
  return probe.locked;
}

export async function getRepoIdleState(repoRoot, config, options = {}) {
  if (!config.idle.dispatchWhenIdle) {
    return {
      idle: true,
      reason: 'idle_policy_disabled',
      idleSeconds: null,
      latestActivityAt: null,
    };
  }

  if (await isRepoStateLocked(repoRoot)) {
    return {
      idle: false,
      reason: 'repo_locked',
      idleSeconds: 0,
      latestActivityAt: null,
    };
  }

  const latestActivityAt = await getLatestRepoActivityAt(repoRoot, options);
  if (!latestActivityAt) {
    return {
      idle: true,
      reason: 'no_recent_repo_activity',
      idleSeconds: null,
      latestActivityAt: null,
    };
  }

  const nowMs = new Date(options.now ?? Date.now()).getTime();
  const idleSeconds = Math.max(0, Math.floor((nowMs - latestActivityAt.getTime()) / 1000));

  return {
    idle: idleSeconds >= config.idle.minIdleSeconds,
    reason: idleSeconds >= config.idle.minIdleSeconds ? 'idle_window_satisfied' : 'recent_repo_activity',
    idleSeconds,
    latestActivityAt: latestActivityAt.toISOString(),
  };
}

export function isRepoAllowed(config, repoRoot) {
  return config.repos.allowUnattended.some((entry) => {
    if (entry === '*') {
      return true;
    }

    return path.resolve(repoRoot, entry) === repoRoot;
  });
}

export function assertRepoAllowed(config, repoRoot) {
  if (!isRepoAllowed(config, repoRoot)) {
    throw new Error(`Repo ${repoRoot} is not allowlisted for unattended work in .opencode/config.json.`);
  }
}

async function getLatestRepoActivityAt(repoRoot, options = {}) {
  const ignore = new Set(options.ignoreDirs ?? ['.git', '.opencode', 'node_modules']);
  let latestMtimeMs = null;
  const explicitActivity = await loadRepoActivity(repoRoot);

  if (explicitActivity.lastTouchedAt) {
    latestMtimeMs = new Date(explicitActivity.lastTouchedAt).getTime();
  }

  await walkDirectory(repoRoot);

  if (latestMtimeMs === null) {
    return null;
  }

  return new Date(latestMtimeMs);

  async function walkDirectory(currentDir) {
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'EPERM')) {
        return;
      }

      throw error;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (ignore.has(entry.name)) {
          continue;
        }

        await walkDirectory(path.join(currentDir, entry.name));
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const fullPath = path.join(currentDir, entry.name);
      let stats;
      try {
        stats = await fs.stat(fullPath);
      } catch (error) {
        if (error && (error.code === 'ENOENT' || error.code === 'EPERM')) {
          continue;
        }

        throw error;
      }
      latestMtimeMs = latestMtimeMs === null ? stats.mtimeMs : Math.max(latestMtimeMs, stats.mtimeMs);
    }
  }
}

async function ensureJsonFile(filePath, value) {
  if (await pathExists(filePath)) {
    return;
  }

  await writeJsonAtomic(filePath, value);
}

async function ensureTextFile(filePath, content) {
  if (await pathExists(filePath)) {
    return;
  }

  await fs.writeFile(filePath, content, 'utf8');
}

async function readJson(filePath, fallback) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return fallback;
    }

    throw error;
  }
}

async function readLastJsonLines(filePath, limit) {
  if (limit <= 0) {
    return [];
  }

  let handle;
  try {
    handle = await fs.open(filePath, 'r');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }

  try {
    const stats = await handle.stat();
    let position = stats.size;
    let buffer = Buffer.alloc(0);
    let lines = [];
    const chunkSize = 4096;

    while (position > 0 && lines.filter(Boolean).length <= limit) {
      const readSize = Math.min(chunkSize, position);
      position -= readSize;
      const chunk = Buffer.alloc(readSize);
      await handle.read(chunk, 0, readSize, position);
      buffer = Buffer.concat([chunk, buffer]);
      lines = buffer.toString('utf8').split('\n');
    }

    return lines
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-limit)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      })
      .reverse();
  } finally {
    await handle.close();
  }
}

function parseRepoActivity(value) {
  const source = typeof value?.source === 'string' ? value.source : null;
  const lastTouchedAt =
    typeof value?.lastTouchedAt === 'string' && !Number.isNaN(Date.parse(value.lastTouchedAt))
      ? new Date(value.lastTouchedAt).toISOString()
      : null;
  const meta = value?.meta && typeof value.meta === 'object' && !Array.isArray(value.meta) ? value.meta : {};

  return {
    lastTouchedAt,
    source,
    meta,
  };
}

async function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const content = JSON.stringify(value, null, 2) + '\n';

  await fs.writeFile(tempPath, content, 'utf8');
  await fs.rename(tempPath, filePath);
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
