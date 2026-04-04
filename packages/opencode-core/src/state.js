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
    jobs: path.join(root, 'jobs.json'),
    schedules: path.join(root, 'schedules.json'),
    runsDir: path.join(root, 'runs'),
    workersDir: path.join(root, 'workers'),
    teamsDir: path.join(root, 'teams'),
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
  await fs.mkdir(paths.remoteDir, { recursive: true });
  await fs.mkdir(paths.memoryDir, { recursive: true });
  await fs.mkdir(paths.memoryTopicsDir, { recursive: true });
  await fs.mkdir(paths.memoryTeamDir, { recursive: true });

  await ensureJsonFile(paths.config, defaultConfig());
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
