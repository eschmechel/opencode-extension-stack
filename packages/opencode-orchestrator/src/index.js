import { spawn } from 'node:child_process';
import { createWriteStream, closeSync, openSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import {
  createStableId,
  ensureStateLayout,
  findRepoRoot,
  getOpencodePaths,
  loadConfig,
  withRepoLock,
} from '../../opencode-core/src/index.js';

const WORKER_LOOP_INTERVAL_MS = 1000;
const WORKER_HEARTBEAT_INTERVAL_MS = 5000;
const WORKER_STALE_AFTER_MS = 60_000;
const WORKER_STATUSES = new Set(['starting', 'idle', 'running', 'blocked', 'stopping', 'stopped', 'failed']);
const TEAM_STATUSES = new Set(['active', 'deleted']);

export async function workerStart(prompt, options = {}) {
  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt) {
    throw new Error('A prompt is required for /worker start.');
  }

  const repoRoot = await prepareRepo(options.cwd);
  const createdAt = toIso(options.now);

  return withOrchestratorLock(repoRoot, async () => {
    const config = await loadConfig(repoRoot);
    const workerId = createStableId('worker');
    const workerToken = createStableId('workerproc');
    const workerPaths = getWorkerPaths(repoRoot, workerId);

    await fs.mkdir(workerPaths.rootDir, { recursive: true });
    await fs.writeFile(workerPaths.currentStdoutPath, '', 'utf8');
    await fs.writeFile(workerPaths.currentStderrPath, '', 'utf8');

    const worker = parseWorkerRecord({
      workerId,
      workerToken,
      status: options.deferPrompt ? 'blocked' : 'starting',
      createdAt,
      updatedAt: createdAt,
      repoRoot,
      teamId: options.teamId ?? null,
      pid: null,
      heartbeatAt: null,
      startedAt: null,
      stoppedAt: null,
      lastPrompt: null,
      lastRunId: null,
      lastRunStartedAt: null,
      lastRunCompletedAt: null,
      lastExitCode: null,
      lastError: null,
      trustGateState: 'clear',
      trustGateMessage: null,
      stopRequested: false,
      nextControlIndex: 0,
      runCount: 0,
      archiveCount: 0,
      lastArchivePath: null,
      prunedAt: null,
      model: config.models.default,
    });

    await writeWorkerState(repoRoot, workerId, worker);
    if (!options.deferPrompt) {
      await appendWorkerControl(repoRoot, workerId, 'prompt', { prompt: trimmedPrompt });
    }
    await appendWorkerEvent(repoRoot, workerId, 'worker.created', {
      prompt: trimmedPrompt,
      deferred: Boolean(options.deferPrompt),
    });

    const child = typeof options.spawnWorkerProcess === 'function'
      ? options.spawnWorkerProcess({ repoRoot, workerId, workerToken })
      : spawnWorkerProcess(repoRoot, workerId, workerToken, options);
    worker.pid = child.pid ?? null;
    worker.updatedAt = toIso(options.now);
    await writeWorkerState(repoRoot, workerId, worker);

    return {
      ...worker,
      controlPath: workerPaths.controlPath,
      eventsPath: workerPaths.eventsPath,
      statePath: workerPaths.statePath,
    };
  });
}

export async function workerList(options = {}) {
  const repoRoot = await prepareRepo(options.cwd);
  await recoverStaleWorkers(repoRoot, options.now);
  const workersDir = getOpencodePaths(repoRoot).workersDir;

  const entries = await fs.readdir(workersDir, { withFileTypes: true }).catch(() => []);
  const workers = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    try {
      workers.push(await readWorkerState(repoRoot, entry.name));
    } catch {
      // Ignore malformed worker directories during listing.
    }
  }

  const enriched = await Promise.all(workers.map((worker) => enrichWorkerView(repoRoot, worker)));
  return enriched.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function workerShow(workerId, options = {}) {
  const repoRoot = await prepareRepo(options.cwd);
  await recoverStaleWorkers(repoRoot, options.now);
  const worker = await enrichWorkerView(repoRoot, await readWorkerState(repoRoot, workerId));
  const workerPaths = getWorkerPaths(repoRoot, workerId);
  const recentControls = await readRecentNdjson(workerPaths.controlPath, options.controlLimit ?? 5);
  const recentEvents = await readRecentNdjson(workerPaths.eventsPath, options.eventLimit ?? 10);
  const stdoutTail = await readFileTail(workerPaths.currentStdoutPath, options.outputTailBytes ?? 500);
  const stderrTail = await readFileTail(workerPaths.currentStderrPath, options.outputTailBytes ?? 500);

  return {
    ...worker,
    controlPath: workerPaths.controlPath,
    currentStdoutPath: workerPaths.currentStdoutPath,
    currentStderrPath: workerPaths.currentStderrPath,
    eventsPath: workerPaths.eventsPath,
    statePath: workerPaths.statePath,
    recentControls,
    recentEvents,
    stdoutTail,
    stderrTail,
  };
}

export async function workerStop(workerId, options = {}) {
  const repoRoot = await prepareRepo(options.cwd);
  await recoverStaleWorkers(repoRoot, options.now);

  return withOrchestratorLock(repoRoot, async () => {
    const worker = await readWorkerState(repoRoot, workerId);

    if (worker.status === 'stopped') {
      return worker;
    }

    worker.stopRequested = true;
    worker.status = worker.status === 'running' ? 'stopping' : 'stopped';
    worker.updatedAt = toIso(options.now);
    await writeWorkerState(repoRoot, workerId, worker);
    await appendWorkerControl(repoRoot, workerId, 'stop', {});
    await appendWorkerEvent(repoRoot, workerId, 'worker.stop_requested', {});

    return worker;
  });
}

export async function workerRestart(workerId, options = {}) {
  const repoRoot = await prepareRepo(options.cwd);
  await recoverStaleWorkers(repoRoot, options.now);

  return withOrchestratorLock(repoRoot, async () => {
    const worker = await readWorkerState(repoRoot, workerId);
    if (!['stopped', 'failed'].includes(worker.status)) {
      throw new Error(`Only stopped or failed workers can be restarted. Current status: ${worker.status}`);
    }

    const restarted = {
      ...worker,
      workerToken: createStableId('workerproc'),
      status: 'starting',
      stopRequested: false,
      pid: null,
      heartbeatAt: null,
      startedAt: null,
      stoppedAt: null,
      updatedAt: toIso(options.now),
      lastError: null,
    };

    await writeWorkerState(repoRoot, workerId, restarted);
    await appendWorkerEvent(repoRoot, workerId, 'worker.restart_requested', {});

    const child = typeof options.spawnWorkerProcess === 'function'
      ? options.spawnWorkerProcess({ repoRoot, workerId, workerToken: restarted.workerToken })
      : spawnWorkerProcess(repoRoot, workerId, restarted.workerToken, options);
    restarted.pid = child.pid ?? null;
    await writeWorkerState(repoRoot, workerId, restarted);

    return restarted;
  });
}

export async function workerSteer(workerId, message, options = {}) {
  const trimmedMessage = message.trim();
  if (!trimmedMessage) {
    throw new Error('A steering message is required for /worker steer.');
  }

  const repoRoot = await prepareRepo(options.cwd);
  await recoverStaleWorkers(repoRoot, options.now);

  return withOrchestratorLock(repoRoot, async () => {
    const worker = await readWorkerState(repoRoot, workerId);
    if (!['starting', 'idle', 'running', 'blocked', 'stopping'].includes(worker.status)) {
      throw new Error(`Cannot steer worker in status ${worker.status}.`);
    }

    if (worker.trustGateState === 'required') {
      worker.trustGateState = 'clear';
      worker.trustGateMessage = null;
      worker.status = 'idle';
      worker.updatedAt = toIso(options.now);
      await writeWorkerState(repoRoot, workerId, worker);
    }

    await appendWorkerControl(repoRoot, workerId, 'prompt', { prompt: trimmedMessage, source: 'steer' });
    await appendWorkerEvent(repoRoot, workerId, 'worker.steered', { prompt: trimmedMessage });

    return worker;
  });
}

export async function teamCreate(count, prompt, options = {}) {
  const repoRoot = await prepareRepo(options.cwd);
  const template = options.templateName ? await readTeamTemplate(repoRoot, options.templateName) : null;

  const requestedCount = Number.isInteger(Number(count)) && Number(count) > 0
    ? Number(count)
    : template?.requestedCount;
  const trimmedPrompt = typeof prompt === 'string' && prompt.trim()
    ? prompt.trim()
    : template?.prompt ?? '';
  if (!Number.isInteger(requestedCount) || requestedCount < 1) {
    throw new Error('A worker count >= 1 is required for /team create.');
  }

  if (!trimmedPrompt) {
    throw new Error('A prompt is required for /team create.');
  }

  const createdAt = toIso(options.now);
  const maxConcurrentWorkers = options.maxConcurrentWorkers ?? template?.maxConcurrentWorkers ?? requestedCount;
  const maxTotalRuns = options.maxTotalRuns ?? template?.maxTotalRuns ?? null;
  const team = parseTeamRecord({
    teamId: createStableId('team'),
    name: options.name ?? template?.name ?? null,
    prompt: trimmedPrompt,
    requestedCount,
    maxConcurrentWorkers,
    maxTotalRuns,
    templateName: template?.templateName ?? null,
    workerIds: [],
    status: 'active',
    createdAt,
    updatedAt: createdAt,
    archiveCount: 0,
    lastArchivePath: null,
    prunedAt: null,
  });

  await writeTeamState(repoRoot, team);

  const workers = [];
  for (let index = 0; index < requestedCount; index += 1) {
    const worker = await workerStart(trimmedPrompt, {
      cwd: repoRoot,
      now: options.now,
      teamId: team.teamId,
      deferPrompt: index >= maxConcurrentWorkers,
      spawnWorkerProcess: options.spawnWorkerProcess,
    });
    workers.push(worker);
    team.workerIds.push(worker.workerId);
  }

  team.updatedAt = toIso(options.now);
  await writeTeamState(repoRoot, team);
  await advanceTeamQueue(repoRoot, team.teamId, options.now);
  const memory = await summarizeTeamMemory(repoRoot, team.teamId);
  return {
    ...team,
    workers,
    memory,
  };
}

export async function parallelStart(count, prompt, options = {}) {
  return teamCreate(count, prompt, options);
}

export async function teamTemplateSave(templateName, options = {}) {
  const trimmedTemplateName = slugifyName(templateName);
  if (!trimmedTemplateName) {
    throw new Error('A template name is required for /team template save.');
  }

  const repoRoot = await prepareRepo(options.cwd);
  const nowIso = toIso(options.now);

  return withOrchestratorLock(repoRoot, async () => {
    let source = null;
    if (options.fromTeamId) {
      source = await readTeamState(repoRoot, options.fromTeamId);
    }

    const requestedCount = Number.isInteger(Number(options.count)) && Number(options.count) > 0
      ? Number(options.count)
      : source?.requestedCount;
    const prompt = typeof options.prompt === 'string' && options.prompt.trim()
      ? options.prompt.trim()
      : source?.prompt ?? '';

    if (!Number.isInteger(requestedCount) || requestedCount < 1) {
      throw new Error('A worker count >= 1 is required for /team template save.');
    }
    if (!prompt) {
      throw new Error('A prompt is required for /team template save.');
    }

    const existing = await readTeamTemplate(repoRoot, trimmedTemplateName).catch(() => null);
    const template = parseTeamTemplateRecord({
      templateName: trimmedTemplateName,
      name: options.name ?? source?.name ?? trimmedTemplateName,
      description: options.description ?? existing?.description ?? null,
      requestedCount,
      prompt,
      maxConcurrentWorkers: options.maxConcurrentWorkers ?? source?.maxConcurrentWorkers ?? requestedCount,
      maxTotalRuns: options.maxTotalRuns ?? source?.maxTotalRuns ?? null,
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
    });

    await writeTeamTemplate(repoRoot, template);
    return template;
  });
}

export async function teamTemplateList(options = {}) {
  const repoRoot = await prepareRepo(options.cwd);
  const entries = await fs.readdir(getOpencodePaths(repoRoot).teamTemplatesDir, { withFileTypes: true }).catch(() => []);
  const templates = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }

    try {
      templates.push(await readTeamTemplate(repoRoot, path.basename(entry.name, '.json')));
    } catch {
      // Ignore malformed template records during listing.
    }
  }

  return templates.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function teamTemplateShow(templateName, options = {}) {
  const repoRoot = await prepareRepo(options.cwd);
  return readTeamTemplate(repoRoot, templateName);
}

export async function teamTemplateDelete(templateName, options = {}) {
  const trimmedTemplateName = slugifyName(templateName);
  if (!trimmedTemplateName) {
    throw new Error('A template name is required for /team template delete.');
  }

  const repoRoot = await prepareRepo(options.cwd);
  const template = await readTeamTemplate(repoRoot, trimmedTemplateName);
  await fs.rm(getTeamTemplatePath(repoRoot, trimmedTemplateName), { force: true });
  return template;
}

export async function teamList(options = {}) {
  const repoRoot = await prepareRepo(options.cwd);
  await recoverStaleWorkers(repoRoot, options.now);
  const teamsDir = getOpencodePaths(repoRoot).teamsDir;
  const entries = await fs.readdir(teamsDir, { withFileTypes: true }).catch(() => []);
  const teams = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }

    try {
      teams.push(await enrichTeamView(repoRoot, await readTeamState(repoRoot, path.basename(entry.name, '.json'))));
    } catch {
      // Ignore malformed team records during listing.
    }
  }

  return teams.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function teamShow(teamId, options = {}) {
  const repoRoot = await prepareRepo(options.cwd);
  await recoverStaleWorkers(repoRoot, options.now);
  await advanceTeamQueue(repoRoot, teamId, options.now);
  return enrichTeamView(repoRoot, await readTeamState(repoRoot, teamId));
}

export async function teamDelete(teamId, options = {}) {
  const repoRoot = await prepareRepo(options.cwd);

  return withOrchestratorLock(repoRoot, async () => {
    const team = await readTeamState(repoRoot, teamId);
    if (team.status === 'deleted') {
      return team;
    }

    team.status = 'deleted';
    team.updatedAt = toIso(options.now);
    await writeTeamState(repoRoot, team);

    for (const workerId of team.workerIds) {
      try {
        const worker = await readWorkerState(repoRoot, workerId);
        worker.stopRequested = true;
        worker.status = worker.status === 'running' ? 'stopping' : 'stopped';
        worker.updatedAt = toIso(options.now);
        await writeWorkerState(repoRoot, workerId, worker);
        await appendWorkerControl(repoRoot, workerId, 'stop', { source: 'team.delete' });
      } catch {
        // Ignore missing workers during team deletion.
      }
    }

    return team;
  });
}

export async function workerArchive(workerId, options = {}) {
  const repoRoot = await prepareRepo(options.cwd);

  return withOrchestratorLock(repoRoot, async () => {
    const worker = await readWorkerState(repoRoot, workerId);
    if (['starting', 'running', 'stopping'].includes(worker.status)) {
      throw new Error(`Cannot archive an active worker in status ${worker.status}.`);
    }

    const archivePath = await archiveWorkerArtifacts(repoRoot, workerId, { prune: false, now: options.now });
    worker.archiveCount += 1;
    worker.lastArchivePath = archivePath;
    worker.updatedAt = toIso(options.now);
    await writeWorkerState(repoRoot, workerId, worker);
    return worker;
  });
}

export async function workerPrune(workerId, options = {}) {
  const repoRoot = await prepareRepo(options.cwd);

  return withOrchestratorLock(repoRoot, async () => {
    const worker = await readWorkerState(repoRoot, workerId);
    if (!['stopped', 'failed'].includes(worker.status)) {
      throw new Error(`Only stopped or failed workers can be pruned. Current status: ${worker.status}`);
    }

    const archivePath = await archiveWorkerArtifacts(repoRoot, workerId, { prune: true, now: options.now });
    worker.archiveCount += 1;
    worker.lastArchivePath = archivePath;
    worker.prunedAt = toIso(options.now);
    worker.updatedAt = toIso(options.now);
    await writeWorkerState(repoRoot, workerId, worker);
    return worker;
  });
}

export async function teamArchive(teamId, options = {}) {
  const repoRoot = await prepareRepo(options.cwd);

  return withOrchestratorLock(repoRoot, async () => {
    const team = await readTeamState(repoRoot, teamId);
    const archivePath = await archiveTeamArtifacts(repoRoot, team, options.now);
    team.archiveCount += 1;
    team.lastArchivePath = archivePath;
    team.updatedAt = toIso(options.now);
    await writeTeamState(repoRoot, team);
    return team;
  });
}

export async function teamPrune(teamId, options = {}) {
  const repoRoot = await prepareRepo(options.cwd);
  const archived = await teamArchive(teamId, options);

  for (const workerId of archived.workerIds) {
    try {
      const worker = await readWorkerState(repoRoot, workerId);
      if (['stopped', 'failed'].includes(worker.status)) {
        await workerPrune(workerId, options);
      }
    } catch {
      // Ignore missing workers during team prune.
    }
  }

  return withOrchestratorLock(repoRoot, async () => {
    const team = await readTeamState(repoRoot, teamId);
    team.prunedAt = toIso(options.now);
    team.updatedAt = toIso(options.now);
    await writeTeamState(repoRoot, team);
    return team;
  });
}

export async function retentionStatus(options = {}) {
  const repoRoot = await prepareRepo(options.cwd);
  const config = await loadConfig(repoRoot);
  return buildRetentionReport(repoRoot, config.retention, options.now);
}

export async function retentionApply(options = {}) {
  const repoRoot = await prepareRepo(options.cwd);
  const config = await loadConfig(repoRoot);
  const dryRun = Boolean(options.dryRun);
  const now = options.now;

  const before = await buildRetentionReport(repoRoot, config.retention, now);
  const actions = {
    workerArchivesCompacted: 0,
    teamArchivesCompacted: 0,
    workersPruned: 0,
    teamsPruned: 0,
    workerArchivesDeleted: 0,
    teamArchivesDeleted: 0,
  };

  if (!dryRun) {
    actions.workersPruned = await autoPruneWorkers(repoRoot, config.retention.workers, now);
    actions.teamsPruned = await autoPruneTeams(repoRoot, config.retention.teams, now);
    actions.workerArchivesCompacted = await compactWorkerArchives(repoRoot, config.retention.workers);
    actions.teamArchivesCompacted = await compactTeamArchives(repoRoot, config.retention.teams);
    actions.workerArchivesDeleted = await rotateWorkerArchives(repoRoot, config.retention.workers, now);
    actions.teamArchivesDeleted = await rotateTeamArchives(repoRoot, config.retention.teams, now);
  }

  const after = dryRun ? before : await buildRetentionReport(repoRoot, config.retention, now);
  return {
    repoRoot,
    dryRun,
    actions,
    before,
    after,
  };
}

export async function teamRerunFailed(teamId, options = {}) {
  const repoRoot = await prepareRepo(options.cwd);
  const team = await readTeamState(repoRoot, teamId);
  const rerunWorkers = [];
  let remainingRuns = team.maxTotalRuns;
  if (remainingRuns !== null) {
    const currentWorkers = await Promise.all(team.workerIds.map((workerId) => readWorkerState(repoRoot, workerId).catch(() => null)));
    const totalRuns = currentWorkers.filter(Boolean).reduce((sum, worker) => sum + worker.runCount, 0);
    remainingRuns = Math.max(0, remainingRuns - totalRuns);
  }

  for (const workerId of team.workerIds) {
    const worker = await workerShow(workerId, { cwd: repoRoot, now: options.now });
    if (worker.status !== 'failed') {
      continue;
    }

    if (remainingRuns !== null && remainingRuns < 1) {
      break;
    }

    const restarted = await workerRestart(workerId, {
      cwd: repoRoot,
      now: options.now,
      spawnWorkerProcess: options.spawnWorkerProcess,
    });

    await workerSteer(workerId, worker.lastPrompt ?? team.prompt, {
      cwd: repoRoot,
      now: options.now,
    });

    rerunWorkers.push(restarted.workerId);
    if (remainingRuns !== null) {
      remainingRuns -= 1;
    }
  }

  return {
    teamId,
    rerunWorkers,
  };
}

export async function runWorkerLoop(options) {
  const repoRoot = await prepareRepo(options.repoRoot ?? options.cwd);
  const workerId = options.workerId;
  const workerToken = options.workerToken;

  if (!workerId || !workerToken) {
    throw new Error('runWorkerLoop requires workerId and workerToken.');
  }

  let shouldStop = false;
  let activeChild = null;

  const onTerminate = () => {
    shouldStop = true;
    if (activeChild) {
      activeChild.kill('SIGTERM');
    }
  };

  process.on('SIGTERM', onTerminate);
  process.on('SIGINT', onTerminate);

  try {
    await markWorkerBooted(repoRoot, workerId, workerToken, options.now);

    while (!shouldStop) {
      const state = await readWorkerState(repoRoot, workerId);

      if (state.workerToken !== workerToken) {
        return state;
      }

      if (state.stopRequested) {
        return stopWorkerLoop(repoRoot, workerId, 'stopped', null, options.now);
      }

      const nextPrompt = await consumeNextPrompt(repoRoot, workerId, state.nextControlIndex, options.now);
      if (!nextPrompt) {
        await updateWorkerHeartbeat(repoRoot, workerId, state.status === 'blocked' ? 'blocked' : 'idle', options.now);
        await sleep(WORKER_LOOP_INTERVAL_MS);
        continue;
      }

      const runId = createStableId('run');
      await markWorkerRunning(repoRoot, workerId, runId, nextPrompt.prompt, options.now);

      const currentPaths = getWorkerPaths(repoRoot, workerId);
      await fs.writeFile(currentPaths.currentStdoutPath, '', 'utf8');
      await fs.writeFile(currentPaths.currentStderrPath, '', 'utf8');

      let execution;
      try {
        if (typeof options.executePrompt === 'function') {
          execution = await options.executePrompt({ prompt: nextPrompt.prompt, repoRoot, workerId, runId });
          if (execution.stdout) {
            await fs.writeFile(currentPaths.currentStdoutPath, execution.stdout, 'utf8');
          }
          if (execution.stderr) {
            await fs.writeFile(currentPaths.currentStderrPath, execution.stderr, 'utf8');
          }
        } else {
          execution = await spawnWorkerPrompt(repoRoot, nextPrompt.prompt, currentPaths, () => {
            activeChild = null;
          }, (child) => {
            activeChild = child;
          }, workerId);
        }
      } catch (error) {
        execution = {
          exitCode: 1,
          stdout: '',
          stderr: error instanceof Error ? (error.stack || error.message) : String(error),
        };
      }

      activeChild = null;

      if ((execution.exitCode ?? 1) !== 0) {
        return failWorkerLoop(repoRoot, workerId, runId, execution, options.now);
      }

      await finishWorkerRun(repoRoot, workerId, runId, execution, options.now);
    }

    return stopWorkerLoop(repoRoot, workerId, 'stopped', null, options.now);
  } finally {
    process.off('SIGTERM', onTerminate);
    process.off('SIGINT', onTerminate);
  }
}

function getWorkerPaths(repoRoot, workerId) {
  const rootDir = path.join(getOpencodePaths(repoRoot).workersDir, workerId);
  return {
    rootDir,
    statePath: path.join(rootDir, 'worker.json'),
    controlPath: path.join(rootDir, 'control.ndjson'),
    eventsPath: path.join(rootDir, 'events.ndjson'),
    currentStdoutPath: path.join(rootDir, 'current.stdout.txt'),
    currentStderrPath: path.join(rootDir, 'current.stderr.txt'),
    processLogPath: path.join(rootDir, 'worker-process.log'),
  };
}

function getTeamPath(repoRoot, teamId) {
  return path.join(getOpencodePaths(repoRoot).teamsDir, `${teamId}.json`);
}

function getTeamTemplatePath(repoRoot, templateName) {
  return path.join(getOpencodePaths(repoRoot).teamTemplatesDir, `${slugifyName(templateName)}.json`);
}

async function prepareRepo(cwd = process.cwd()) {
  const repoRoot = await findRepoRoot(cwd);
  await ensureStateLayout(repoRoot);
  return repoRoot;
}

async function readWorkerState(repoRoot, workerId) {
  const workerPaths = getWorkerPaths(repoRoot, workerId);
  const content = await fs.readFile(workerPaths.statePath, 'utf8');
  return parseWorkerRecord(JSON.parse(content));
}

async function readTeamState(repoRoot, teamId) {
  const content = await fs.readFile(getTeamPath(repoRoot, teamId), 'utf8');
  return parseTeamRecord(JSON.parse(content));
}

async function readTeamTemplate(repoRoot, templateName) {
  const content = await fs.readFile(getTeamTemplatePath(repoRoot, templateName), 'utf8');
  return parseTeamTemplateRecord(JSON.parse(content));
}

async function writeWorkerState(repoRoot, workerId, worker) {
  const workerPaths = getWorkerPaths(repoRoot, workerId);
  await fs.mkdir(workerPaths.rootDir, { recursive: true });
  const tempPath = `${workerPaths.statePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(parseWorkerRecord(worker), null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, workerPaths.statePath);
}

async function writeTeamState(repoRoot, team) {
  const teamPath = getTeamPath(repoRoot, team.teamId);
  const tempPath = `${teamPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(parseTeamRecord(team), null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, teamPath);
}

async function writeTeamTemplate(repoRoot, template) {
  const templatePath = getTeamTemplatePath(repoRoot, template.templateName);
  const tempPath = `${templatePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(parseTeamTemplateRecord(template), null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, templatePath);
}

async function appendWorkerControl(repoRoot, workerId, type, payload) {
  const workerPaths = getWorkerPaths(repoRoot, workerId);
  await fs.mkdir(workerPaths.rootDir, { recursive: true });
  await fs.appendFile(
    workerPaths.controlPath,
    `${JSON.stringify({ type, createdAt: new Date().toISOString(), payload })}\n`,
    'utf8',
  );
}

async function appendWorkerEvent(repoRoot, workerId, event, payload) {
  const workerPaths = getWorkerPaths(repoRoot, workerId);
  await fs.mkdir(workerPaths.rootDir, { recursive: true });
  await fs.appendFile(
    workerPaths.eventsPath,
    `${JSON.stringify({ at: new Date().toISOString(), event, payload })}\n`,
    'utf8',
  );
}

async function loadWorkerControls(repoRoot, workerId) {
  const workerPaths = getWorkerPaths(repoRoot, workerId);
  try {
    const content = await fs.readFile(workerPaths.controlPath, 'utf8');
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

async function readRecentNdjson(filePath, limit) {
  if (limit <= 0) {
    return [];
  }

  try {
    const content = await fs.readFile(filePath, 'utf8');
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-limit)
      .map((line) => JSON.parse(line))
      .reverse();
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

async function markWorkerBooted(repoRoot, workerId, workerToken, now) {
  return withOrchestratorLock(repoRoot, async () => {
    const worker = await readWorkerState(repoRoot, workerId);
    if (worker.workerToken !== workerToken) {
      return worker;
    }

    worker.pid = process.pid;
    worker.startedAt = worker.startedAt ?? toIso(now);
    worker.heartbeatAt = toIso(now);
    worker.status = 'idle';
    worker.updatedAt = toIso(now);
    await writeWorkerState(repoRoot, workerId, worker);
    await appendWorkerEvent(repoRoot, workerId, 'worker.booted', { pid: process.pid });
    return worker;
  });
}

async function consumeNextPrompt(repoRoot, workerId, nextControlIndex, now) {
  return withOrchestratorLock(repoRoot, async () => {
    const worker = await readWorkerState(repoRoot, workerId);
    const controls = await loadWorkerControls(repoRoot, workerId);

    let index = worker.nextControlIndex;
    while (index < controls.length) {
      const entry = controls[index];
      index += 1;
      worker.nextControlIndex = index;

      if (entry.type === 'stop') {
        worker.stopRequested = true;
        worker.status = 'stopping';
        worker.updatedAt = toIso(now);
        await writeWorkerState(repoRoot, workerId, worker);
        return null;
      }

      if (entry.type === 'prompt') {
        worker.updatedAt = toIso(now);
        await writeWorkerState(repoRoot, workerId, worker);
        return entry.payload;
      }
    }

    return null;
  });
}

async function markWorkerRunning(repoRoot, workerId, runId, prompt, now) {
  return withOrchestratorLock(repoRoot, async () => {
    const worker = await readWorkerState(repoRoot, workerId);
    worker.status = 'running';
    worker.lastPrompt = prompt;
    worker.lastRunId = runId;
    worker.lastRunStartedAt = toIso(now);
    worker.heartbeatAt = toIso(now);
    worker.updatedAt = toIso(now);
    worker.runCount += 1;
    await writeWorkerState(repoRoot, workerId, worker);
    await appendWorkerEvent(repoRoot, workerId, 'worker.run_started', { prompt, runId });
    return worker;
  });
}

async function finishWorkerRun(repoRoot, workerId, runId, execution, now) {
  return withOrchestratorLock(repoRoot, async () => {
    const worker = await readWorkerState(repoRoot, workerId);
    const trustGate = normalizeTrustGate(execution.trustGate);
    worker.status = worker.stopRequested ? 'stopped' : (trustGate.state === 'required' ? 'blocked' : 'idle');
    worker.lastRunCompletedAt = toIso(now);
    worker.lastExitCode = execution.exitCode ?? 0;
    worker.lastError = null;
    worker.trustGateState = trustGate.state;
    worker.trustGateMessage = trustGate.message;
    worker.heartbeatAt = toIso(now);
    worker.updatedAt = toIso(now);
    await writeWorkerState(repoRoot, workerId, worker);
    await appendWorkerEvent(repoRoot, workerId, trustGate.state === 'required' ? 'worker.trust_gate_requested' : 'worker.run_completed', {
      runId,
      exitCode: execution.exitCode ?? 0,
      trustGateMessage: trustGate.message,
    });
    if (worker.teamId) {
      await advanceTeamQueue(repoRoot, worker.teamId, now);
    }
    return worker;
  });
}

async function failWorkerLoop(repoRoot, workerId, runId, execution, now) {
  return withOrchestratorLock(repoRoot, async () => {
    const worker = await readWorkerState(repoRoot, workerId);
    worker.status = 'failed';
    worker.lastRunCompletedAt = toIso(now);
    worker.lastExitCode = execution.exitCode ?? 1;
    worker.lastError = summarizeError(execution);
    worker.trustGateState = 'clear';
    worker.trustGateMessage = null;
    worker.heartbeatAt = toIso(now);
    worker.updatedAt = toIso(now);
    await writeWorkerState(repoRoot, workerId, worker);
    await appendWorkerEvent(repoRoot, workerId, 'worker.run_failed', { runId, exitCode: execution.exitCode ?? 1 });
    if (worker.teamId) {
      await advanceTeamQueue(repoRoot, worker.teamId, now);
    }
    return worker;
  });
}

async function stopWorkerLoop(repoRoot, workerId, status, errorMessage, now) {
  return withOrchestratorLock(repoRoot, async () => {
    const worker = await readWorkerState(repoRoot, workerId);
    worker.status = status;
    worker.stoppedAt = toIso(now);
    worker.updatedAt = toIso(now);
    worker.heartbeatAt = null;
    worker.pid = null;
    worker.trustGateState = worker.trustGateState ?? 'clear';
    if (errorMessage) {
      worker.lastError = errorMessage;
    }
    await writeWorkerState(repoRoot, workerId, worker);
    await appendWorkerEvent(repoRoot, workerId, 'worker.stopped', { status });
    if (worker.teamId) {
      await advanceTeamQueue(repoRoot, worker.teamId, now);
    }
    return worker;
  });
}

async function updateWorkerHeartbeat(repoRoot, workerId, status, now) {
  return withOrchestratorLock(repoRoot, async () => {
    const worker = await readWorkerState(repoRoot, workerId);
    if (!WORKER_STATUSES.has(worker.status)) {
      return worker;
    }

    if (worker.trustGateState === 'required' && status === 'idle') {
      worker.status = 'blocked';
    } else {
      worker.status = worker.stopRequested && status === 'idle' ? 'stopping' : status;
    }
    worker.heartbeatAt = toIso(now);
    worker.updatedAt = toIso(now);
    await writeWorkerState(repoRoot, workerId, worker);
    return worker;
  });
}

async function recoverStaleWorkers(repoRoot, now) {
  return withOrchestratorLock(repoRoot, async () => {
    const workers = await loadWorkerDirectories(repoRoot);
    const nowIso = toIso(now);
    const nowMs = new Date(nowIso).getTime();

    for (const worker of workers) {
      if (!['starting', 'idle', 'running', 'blocked', 'stopping'].includes(worker.status)) {
        continue;
      }

      const lastSeenMs = new Date(worker.heartbeatAt ?? worker.updatedAt ?? worker.createdAt).getTime();
      const runnerAlive = worker.pid ? isProcessAlive(worker.pid) : false;
      const stale = worker.status === 'starting'
        ? nowMs - lastSeenMs > WORKER_STALE_AFTER_MS
        : (!runnerAlive || nowMs - lastSeenMs > WORKER_STALE_AFTER_MS);
      if (!stale) {
        continue;
      }

      const recovered = {
        ...worker,
        status: 'failed',
        pid: null,
        stoppedAt: nowIso,
        updatedAt: nowIso,
        heartbeatAt: null,
        lastError: 'Worker process stopped before clean shutdown.',
      };
      await writeWorkerState(repoRoot, worker.workerId, recovered);
      await appendWorkerEvent(repoRoot, worker.workerId, 'worker.recovered_as_failed', {});
    }
  });
}

async function enrichWorkerView(repoRoot, worker) {
  const controls = await loadWorkerControls(repoRoot, worker.workerId);
  const pendingControls = controls.slice(worker.nextControlIndex);
  const pendingPromptCount = pendingControls.filter((entry) => entry.type === 'prompt').length;
  const readyForPrompt = worker.status === 'idle' && worker.trustGateState !== 'required' && pendingPromptCount === 0 && !worker.stopRequested;
  const stale = ['starting', 'idle', 'running', 'blocked', 'stopping'].includes(worker.status)
    ? !worker.pid || !isProcessAlive(worker.pid)
    : false;

  return {
    ...worker,
    pendingPromptCount,
    readyForPrompt,
    stale,
  };
}

async function enrichTeamView(repoRoot, team) {
  const workers = await Promise.all(team.workerIds.map(async (workerId) => {
    try {
      return await enrichWorkerView(repoRoot, await readWorkerState(repoRoot, workerId));
    } catch {
      return null;
    }
  }));

  const liveWorkers = workers.filter(Boolean);
  const counts = {
    starting: 0,
    idle: 0,
    running: 0,
    blocked: 0,
    stopping: 0,
    stopped: 0,
    failed: 0,
  };

  for (const worker of liveWorkers) {
    counts[worker.status] += 1;
  }

  return {
    ...team,
    counts,
    workerCount: liveWorkers.length,
    memory: await summarizeTeamMemory(repoRoot, team.teamId),
    synthesis: await synthesizeTeamResults(repoRoot, liveWorkers),
    workers: liveWorkers.map((worker) => ({
      workerId: worker.workerId,
      status: worker.status,
      readyForPrompt: worker.readyForPrompt,
      pendingPromptCount: worker.pendingPromptCount,
      lastPrompt: worker.lastPrompt,
      lastError: worker.lastError,
      trustGateState: worker.trustGateState,
      trustGateMessage: worker.trustGateMessage,
    })),
  };
}

async function summarizeTeamMemory(repoRoot, teamId) {
  const namespaceDir = path.join(getOpencodePaths(repoRoot).memoryTeamDir, teamId);
  const topicsDir = path.join(namespaceDir, 'topics');
  const indexPath = path.join(namespaceDir, 'MEMORY.md');
  const entries = await fs.readdir(topicsDir, { withFileTypes: true }).catch(() => []);
  let topicCount = 0;
  let entryCount = 0;
  let staleCount = 0;

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }

    topicCount += 1;
    try {
      const content = JSON.parse(await fs.readFile(path.join(topicsDir, entry.name), 'utf8'));
      const topicEntries = Array.isArray(content.entries) ? content.entries : [];
      entryCount += topicEntries.length;
      staleCount += topicEntries.filter((item) => item?.stale).length;
    } catch {
      // Ignore malformed topic files in summary output.
    }
  }

  return {
    namespace: teamId,
    memoryDir: namespaceDir,
    indexPath,
    topicCount,
    entryCount,
    staleCount,
    activeCount: Math.max(0, entryCount - staleCount),
  };
}

async function loadWorkerDirectories(repoRoot) {
  const workersDir = getOpencodePaths(repoRoot).workersDir;
  const entries = await fs.readdir(workersDir, { withFileTypes: true }).catch(() => []);
  const workers = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    try {
      workers.push(await readWorkerState(repoRoot, entry.name));
    } catch {
      // Ignore malformed worker directories.
    }
  }

  return workers;
}

async function advanceTeamQueue(repoRoot, teamId, now) {
  const team = await readTeamState(repoRoot, teamId).catch(() => null);
  if (!team || team.status !== 'active') {
    return null;
  }

  const workers = await Promise.all(team.workerIds.map((workerId) => readWorkerState(repoRoot, workerId).catch(() => null)));
  const liveWorkers = workers.filter(Boolean);
  const activeCount = liveWorkers.filter((worker) => ['starting', 'running', 'stopping'].includes(worker.status)).length;
  const availableSlots = Math.max(0, team.maxConcurrentWorkers - activeCount);
  if (availableSlots < 1) {
    return null;
  }

  const totalRuns = liveWorkers.reduce((sum, worker) => sum + worker.runCount, 0);
  let remainingRuns = team.maxTotalRuns === null ? Infinity : Math.max(0, team.maxTotalRuns - totalRuns);
  if (remainingRuns < 1) {
    return null;
  }

  const candidates = liveWorkers.filter((worker) => worker.status === 'blocked' && worker.trustGateState !== 'required' && !worker.stopRequested);
  let promoted = 0;
  for (const worker of candidates) {
    if (promoted >= availableSlots || remainingRuns < 1) {
      break;
    }

    await withOrchestratorLock(repoRoot, async () => {
      const current = await readWorkerState(repoRoot, worker.workerId);
      current.status = 'idle';
      current.updatedAt = toIso(now);
      await writeWorkerState(repoRoot, worker.workerId, current);
      await appendWorkerControl(repoRoot, worker.workerId, 'prompt', { prompt: team.prompt, source: 'team.advance' });
      await appendWorkerEvent(repoRoot, worker.workerId, 'worker.team_slot_granted', { teamId });
    });

    promoted += 1;
    remainingRuns -= 1;
  }

  return promoted;
}

async function archiveWorkerArtifacts(repoRoot, workerId, options) {
  const workerPaths = getWorkerPaths(repoRoot, workerId);
  const archiveDir = path.join(workerPaths.rootDir, 'archive', toArchiveSlug(options.now));
  await fs.mkdir(archiveDir, { recursive: true });

  const files = [
    ['worker.json', workerPaths.statePath],
    ['control.ndjson', workerPaths.controlPath],
    ['events.ndjson', workerPaths.eventsPath],
    ['current.stdout.txt', workerPaths.currentStdoutPath],
    ['current.stderr.txt', workerPaths.currentStderrPath],
    ['worker-process.log', workerPaths.processLogPath],
  ];

  const archivedFiles = [];
  for (const [name, sourcePath] of files) {
    if (!(await exists(sourcePath))) {
      continue;
    }

    const targetPath = path.join(archiveDir, name);
    await fs.copyFile(sourcePath, targetPath);
    archivedFiles.push(targetPath);

    if (options.prune && sourcePath !== workerPaths.statePath) {
      await fs.rm(sourcePath, { force: true });
    }
  }

  await fs.writeFile(
    path.join(archiveDir, 'manifest.json'),
    `${JSON.stringify({ archivedAt: toIso(options.now), prune: options.prune, archivedFiles }, null, 2)}\n`,
    'utf8',
  );

  return archiveDir;
}

async function archiveTeamArtifacts(repoRoot, team, now) {
  const archiveDir = path.join(getOpencodePaths(repoRoot).teamsDir, 'archive');
  await fs.mkdir(archiveDir, { recursive: true });
  const archivePath = path.join(archiveDir, `${team.teamId}-${toArchiveSlug(now)}.json`);
  const enriched = await enrichTeamView(repoRoot, team);
  await fs.writeFile(archivePath, `${JSON.stringify(enriched, null, 2)}\n`, 'utf8');
  return archivePath;
}

async function synthesizeTeamResults(repoRoot, workers) {
  const completed = workers.filter((worker) => worker.status === 'idle' && worker.runCount > 0).map((worker) => worker.workerId);
  const failed = workers.filter((worker) => worker.status === 'failed').map((worker) => worker.workerId);
  const blocked = workers.filter((worker) => worker.status === 'blocked').map((worker) => worker.workerId);
  const running = workers.filter((worker) => worker.status === 'running').map((worker) => worker.workerId);
  const previews = [];

  for (const worker of workers.slice(0, 5)) {
    const workerPaths = getWorkerPaths(repoRoot, worker.workerId);
    const tail = await readFileTail(workerPaths.currentStdoutPath, 500);
    if (tail) {
      previews.push({ workerId: worker.workerId, output: tail });
    }
  }

  return {
    completed,
    failed,
    blocked,
    running,
    previews,
    summaryText: `completed=${completed.length} failed=${failed.length} blocked=${blocked.length} running=${running.length}`,
  };
}

async function buildRetentionReport(repoRoot, retention, now) {
  const workerArchives = await collectWorkerArchiveEntries(repoRoot);
  const teamArchives = await collectTeamArchiveEntries(repoRoot);
  const workers = await loadWorkerDirectories(repoRoot);
  const teams = await loadTeams(repoRoot);
  const teamEligible = await Promise.all(teams.map((team) => isTeamEligibleForAutoPrune(repoRoot, team, retention.teams, now)));

  return {
    repoRoot,
    workers: {
      policy: retention.workers,
      archiveEntries: workerArchives.length,
      archiveBytes: workerArchives.reduce((sum, entry) => sum + entry.bytes, 0),
      eligibleToPrune: workers.filter((worker) => isWorkerEligibleForAutoPrune(worker, retention.workers, now)).length,
      deletableArchives: countDeletableArchives(workerArchives, retention.workers, now),
    },
    teams: {
      policy: retention.teams,
      archiveEntries: teamArchives.length,
      archiveBytes: teamArchives.reduce((sum, entry) => sum + entry.bytes, 0),
      eligibleToPrune: teamEligible.filter(Boolean).length,
      deletableArchives: countDeletableArchives(teamArchives, retention.teams, now),
    },
  };
}

async function compactWorkerArchives(repoRoot, policy) {
  if (!policy.compactArchives) {
    return 0;
  }

  const archives = await collectWorkerArchiveEntries(repoRoot);
  let compacted = 0;
  for (const entry of archives) {
    compacted += await compactArchivePath(entry.path);
  }
  return compacted;
}

async function compactTeamArchives(repoRoot, policy) {
  if (!policy.compactArchives) {
    return 0;
  }

  const archives = await collectTeamArchiveEntries(repoRoot);
  let compacted = 0;
  for (const entry of archives) {
    if (entry.path.endsWith('.gz')) {
      continue;
    }

    const content = await fs.readFile(entry.path);
    const gzPath = `${entry.path}.gz`;
    await fs.writeFile(gzPath, gzipSync(content));
    await fs.rm(entry.path, { force: true });
    try {
      const team = await readTeamState(repoRoot, entry.scopeId);
      if (team.lastArchivePath === entry.path) {
        team.lastArchivePath = gzPath;
        await writeTeamState(repoRoot, team);
      }
    } catch {
      // Ignore missing team state during compaction.
    }
    compacted += 1;
  }
  return compacted;
}

async function autoPruneWorkers(repoRoot, policy, now) {
  const workers = await loadWorkerDirectories(repoRoot);
  let pruned = 0;
  for (const worker of workers) {
    if (!isWorkerEligibleForAutoPrune(worker, policy, now)) {
      continue;
    }

    await workerPrune(worker.workerId, { cwd: repoRoot, now });
    pruned += 1;
  }
  return pruned;
}

async function autoPruneTeams(repoRoot, policy, now) {
  const teams = await loadTeams(repoRoot);
  let pruned = 0;
  for (const team of teams) {
    if (!(await isTeamEligibleForAutoPrune(repoRoot, team, policy, now))) {
      continue;
    }

    await teamPrune(team.teamId, { cwd: repoRoot, now });
    pruned += 1;
  }
  return pruned;
}

async function rotateWorkerArchives(repoRoot, policy, now) {
  const archives = await collectWorkerArchiveEntries(repoRoot);
  return deleteArchivesByPolicy(archives, policy, now);
}

async function rotateTeamArchives(repoRoot, policy, now) {
  const archives = await collectTeamArchiveEntries(repoRoot);
  return deleteArchivesByPolicy(archives, policy, now);
}

async function collectWorkerArchiveEntries(repoRoot) {
  const workers = await loadWorkerDirectories(repoRoot);
  const entries = [];
  for (const worker of workers) {
    const archiveRoot = path.join(getWorkerPaths(repoRoot, worker.workerId).rootDir, 'archive');
    const children = await fs.readdir(archiveRoot, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      const childPath = path.join(archiveRoot, child.name);
      entries.push({
        scopeId: worker.workerId,
        path: childPath,
        createdAt: await readPathCreatedAt(childPath),
        bytes: await getPathSize(childPath),
      });
    }
  }
  return entries;
}

async function collectTeamArchiveEntries(repoRoot) {
  const archiveDir = path.join(getOpencodePaths(repoRoot).teamsDir, 'archive');
  const children = await fs.readdir(archiveDir, { withFileTypes: true }).catch(() => []);
  const entries = [];
  for (const child of children) {
    if (!child.isFile()) {
      continue;
    }
    const childPath = path.join(archiveDir, child.name);
    entries.push({
      scopeId: child.name.split('-')[0],
      path: childPath,
      createdAt: await readPathCreatedAt(childPath),
      bytes: await getPathSize(childPath),
    });
  }
  return entries;
}

async function compactArchivePath(targetPath) {
  let compacted = 0;
  const stats = await fs.stat(targetPath).catch(() => null);
  if (!stats) {
    return compacted;
  }

  if (stats.isFile()) {
    if (targetPath.endsWith('.gz')) {
      return 0;
    }

    const content = await fs.readFile(targetPath);
    await fs.writeFile(`${targetPath}.gz`, gzipSync(content));
    await fs.rm(targetPath, { force: true });
    return 1;
  }

  const children = await fs.readdir(targetPath, { withFileTypes: true });
  for (const child of children) {
    const childPath = path.join(targetPath, child.name);
    compacted += await compactArchivePath(childPath);
  }
  return compacted;
}

function countDeletableArchives(archives, policy, now) {
  return computeArchivesToDelete(archives, policy, now).length;
}

function computeArchivesToDelete(archives, policy, now) {
  const byScope = new Map();
  for (const entry of archives) {
    if (!byScope.has(entry.scopeId)) {
      byScope.set(entry.scopeId, []);
    }
    byScope.get(entry.scopeId).push(entry);
  }

  const deletions = [];
  const nowMs = new Date(now ?? Date.now()).getTime();

  for (const scopedEntries of byScope.values()) {
    scopedEntries.sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());

    const ageLimited = policy.maxArchiveAgeDays === null
      ? []
      : scopedEntries.filter((entry) => nowMs - new Date(entry.createdAt).getTime() > policy.maxArchiveAgeDays * 24 * 60 * 60 * 1000);

    const countLimited = scopedEntries.slice(policy.maxArchiveEntries);

    const sizeLimited = [];
    if (policy.maxArchiveBytes !== null) {
      let runningBytes = 0;
      for (const entry of scopedEntries) {
        runningBytes += entry.bytes;
        if (runningBytes > policy.maxArchiveBytes) {
          sizeLimited.push(entry);
        }
      }
    }

    const deduped = new Map();
    for (const entry of [...ageLimited, ...countLimited, ...sizeLimited]) {
      deduped.set(entry.path, entry);
    }
    deletions.push(...deduped.values());
  }

  return deletions;
}

async function deleteArchivesByPolicy(archives, policy, now) {
  const deletions = computeArchivesToDelete(archives, policy, now);
  if (!policy.allowDeleteArchived) {
    return 0;
  }

  for (const entry of deletions) {
    await fs.rm(entry.path, { recursive: true, force: true });
  }

  return deletions.length;
}

async function loadTeams(repoRoot) {
  const teamsDir = getOpencodePaths(repoRoot).teamsDir;
  const entries = await fs.readdir(teamsDir, { withFileTypes: true }).catch(() => []);
  const teams = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }

    try {
      teams.push(await readTeamState(repoRoot, path.basename(entry.name, '.json')));
    } catch {
      // Ignore malformed team files.
    }
  }

  return teams;
}

function isWorkerEligibleForAutoPrune(worker, policy, now) {
  if (policy.autoPruneAfterDays === null || !['stopped', 'failed'].includes(worker.status)) {
    return false;
  }

  const lastTouchedAt = new Date(worker.prunedAt ?? worker.updatedAt ?? worker.createdAt).getTime();
  const nowMs = new Date(now ?? Date.now()).getTime();
  return !worker.prunedAt && nowMs - lastTouchedAt >= policy.autoPruneAfterDays * 24 * 60 * 60 * 1000;
}

async function isTeamEligibleForAutoPrune(repoRoot, team, policy, now) {
  if (policy.autoPruneAfterDays === null) {
    return false;
  }

  const nowMs = new Date(now ?? Date.now()).getTime();
  const lastTouchedAt = new Date(team.prunedAt ?? team.updatedAt ?? team.createdAt).getTime();
  if (team.prunedAt || nowMs - lastTouchedAt < policy.autoPruneAfterDays * 24 * 60 * 60 * 1000) {
    return false;
  }

  if (team.status === 'deleted') {
    return true;
  }

  const workers = await Promise.all(team.workerIds.map((workerId) => readWorkerState(repoRoot, workerId).catch(() => null)));
  const liveWorkers = workers.filter(Boolean);
  return liveWorkers.length > 0 && liveWorkers.every((worker) => ['stopped', 'failed'].includes(worker.status));
}

async function readPathCreatedAt(targetPath) {
  const stats = await fs.stat(targetPath);
  return new Date(stats.mtimeMs).toISOString();
}

async function getPathSize(targetPath) {
  const stats = await fs.stat(targetPath).catch(() => null);
  if (!stats) {
    return 0;
  }

  if (stats.isFile()) {
    return stats.size;
  }

  const children = await fs.readdir(targetPath, { withFileTypes: true }).catch(() => []);
  let total = 0;
  for (const child of children) {
    total += await getPathSize(path.join(targetPath, child.name));
  }
  return total;
}

async function spawnWorkerPrompt(repoRoot, prompt, workerPaths, onExit, onStart, workerId) {
  return new Promise((resolve, reject) => {
    const child = spawn('opencode', ['run', '--dir', repoRoot, '--format', 'json', prompt], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    onStart(child);

    const stdoutStream = createWriteStream(workerPaths.currentStdoutPath, { flags: 'a' });
    const stderrStream = createWriteStream(workerPaths.currentStderrPath, { flags: 'a' });

    let heartbeatTimer = setInterval(() => {
      updateWorkerHeartbeat(repoRoot, workerId, 'running').catch(() => {});
    }, WORKER_HEARTBEAT_INTERVAL_MS);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdoutStream.write(text);
      stdout = appendTail(stdout, text);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderrStream.write(text);
      stderr = appendTail(stderr, text);
    });

    child.on('error', (error) => {
      cleanup();
      reject(error);
    });

    child.on('close', (exitCode) => {
      cleanup();
      resolve({ exitCode: exitCode ?? 1, stdout, stderr });
    });

    function cleanup() {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      stdoutStream.end();
      stderrStream.end();
      onExit();
    }
  });
}

function spawnWorkerProcess(repoRoot, workerId, workerToken, options) {
  const cliPath = fileURLToPath(new URL('./worker-process.js', import.meta.url));
  const workerPaths = getWorkerPaths(repoRoot, workerId);
  const logFd = createDetachedLog(workerPaths.processLogPath);

  const child = spawn(process.execPath, [cliPath, '--repo-root', repoRoot, '--worker-id', workerId, '--worker-token', workerToken], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
  });
  child.unref();
  closeSync(logFd);
  return child;
}

function createDetachedLog(filePath) {
  return openSync(filePath, 'a');
}

function parseWorkerRecord(value) {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid worker record.');
  }

  if (!WORKER_STATUSES.has(value.status)) {
    throw new Error(`Invalid worker status: ${value.status}`);
  }

  return {
    workerId: String(value.workerId),
    workerToken: String(value.workerToken),
    status: value.status,
    createdAt: normalizeIso(value.createdAt),
    updatedAt: normalizeIso(value.updatedAt),
    repoRoot: String(value.repoRoot),
    teamId: typeof value.teamId === 'string' ? value.teamId : null,
    pid: value.pid ?? null,
    heartbeatAt: normalizeNullableIso(value.heartbeatAt),
    startedAt: normalizeNullableIso(value.startedAt),
    stoppedAt: normalizeNullableIso(value.stoppedAt),
    lastPrompt: typeof value.lastPrompt === 'string' ? value.lastPrompt : null,
    lastRunId: typeof value.lastRunId === 'string' ? value.lastRunId : null,
    lastRunStartedAt: normalizeNullableIso(value.lastRunStartedAt),
    lastRunCompletedAt: normalizeNullableIso(value.lastRunCompletedAt),
    lastExitCode: value.lastExitCode ?? null,
    lastError: typeof value.lastError === 'string' ? value.lastError : null,
    trustGateState: value.trustGateState === 'required' ? 'required' : 'clear',
    trustGateMessage: typeof value.trustGateMessage === 'string' ? value.trustGateMessage : null,
    stopRequested: Boolean(value.stopRequested),
    nextControlIndex: Number.isInteger(value.nextControlIndex) ? value.nextControlIndex : 0,
    runCount: Number.isInteger(value.runCount) ? value.runCount : 0,
    archiveCount: Number.isInteger(value.archiveCount) ? value.archiveCount : 0,
    lastArchivePath: typeof value.lastArchivePath === 'string' ? value.lastArchivePath : null,
    prunedAt: normalizeNullableIso(value.prunedAt),
    model: typeof value.model === 'string' ? value.model : null,
  };
}

function parseTeamRecord(value) {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid team record.');
  }

  if (!TEAM_STATUSES.has(value.status)) {
    throw new Error(`Invalid team status: ${value.status}`);
  }

  return {
    teamId: String(value.teamId),
    name: typeof value.name === 'string' ? value.name : null,
    templateName: typeof value.templateName === 'string' ? value.templateName : null,
    prompt: String(value.prompt),
    requestedCount: Number.isInteger(value.requestedCount) ? value.requestedCount : 0,
    maxConcurrentWorkers: Number.isInteger(value.maxConcurrentWorkers) ? value.maxConcurrentWorkers : value.requestedCount,
    maxTotalRuns: Number.isInteger(value.maxTotalRuns) ? value.maxTotalRuns : null,
    workerIds: Array.isArray(value.workerIds) ? value.workerIds.map(String) : [],
    status: value.status,
    createdAt: normalizeIso(value.createdAt),
    updatedAt: normalizeIso(value.updatedAt),
    archiveCount: Number.isInteger(value.archiveCount) ? value.archiveCount : 0,
    lastArchivePath: typeof value.lastArchivePath === 'string' ? value.lastArchivePath : null,
    prunedAt: normalizeNullableIso(value.prunedAt),
  };
}

function parseTeamTemplateRecord(value) {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid team template record.');
  }

  const templateName = slugifyName(value.templateName);
  const prompt = typeof value.prompt === 'string' ? value.prompt.trim() : '';
  const requestedCount = Number.isInteger(value.requestedCount) ? value.requestedCount : 0;
  if (!templateName) {
    throw new Error('Invalid team template record: templateName is required.');
  }
  if (!prompt) {
    throw new Error('Invalid team template record: prompt is required.');
  }
  if (requestedCount < 1) {
    throw new Error('Invalid team template record: requestedCount must be >= 1.');
  }

  return {
    templateName,
    name: typeof value.name === 'string' ? value.name : null,
    description: typeof value.description === 'string' ? value.description : null,
    prompt,
    requestedCount,
    maxConcurrentWorkers: Number.isInteger(value.maxConcurrentWorkers) ? value.maxConcurrentWorkers : requestedCount,
    maxTotalRuns: Number.isInteger(value.maxTotalRuns) ? value.maxTotalRuns : null,
    createdAt: normalizeIso(value.createdAt),
    updatedAt: normalizeIso(value.updatedAt),
  };
}

function normalizeIso(value) {
  return new Date(value).toISOString();
}

function normalizeNullableIso(value) {
  return value ? new Date(value).toISOString() : null;
}

function normalizeTrustGate(value) {
  if (!value || typeof value !== 'object') {
    return { state: 'clear', message: null };
  }

  return {
    state: value.state === 'required' ? 'required' : 'clear',
    message: typeof value.message === 'string' ? value.message : null,
  };
}

function toIso(value) {
  return new Date(value ?? Date.now()).toISOString();
}

function slugifyName(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function summarizeError(execution) {
  const text = (execution.stderr || execution.stdout || '').trim();
  return text ? text.split('\n')[0].slice(0, 500) : `Process exited with code ${execution.exitCode ?? 1}`;
}

function appendTail(existing, chunk, maxBytes = 64 * 1024) {
  const combined = existing + chunk;
  if (Buffer.byteLength(combined, 'utf8') <= maxBytes) {
    return combined;
  }

  return Buffer.from(combined, 'utf8').subarray(-maxBytes).toString('utf8');
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readFileTail(filePath, maxBytes) {
  try {
    const handle = await fs.open(filePath, 'r');
    try {
      const stats = await handle.stat();
      const size = Math.min(stats.size, maxBytes);
      const buffer = Buffer.alloc(size);
      await handle.read(buffer, 0, size, stats.size - size);
      return buffer.toString('utf8').trim();
    } finally {
      await handle.close();
    }
  } catch {
    return '';
  }
}

function toArchiveSlug(now) {
  return toIso(now).replace(/[:.]/g, '-');
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function withOrchestratorLock(repoRoot, work) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      return await withRepoLock(repoRoot, work);
    } catch (error) {
      if (!(error instanceof Error) || !/already locked/.test(error.message) || attempt === 9) {
        throw error;
      }

      await sleep(25);
    }
  }

  throw new Error('Failed to acquire orchestrator repo lock.');
}
