import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  appendNotification,
  appendRunEvent,
  assertRepoAllowed,
  createJobRecord,
  createScheduleRecord,
  createStableId,
  ensureStateLayout,
  findRepoRoot,
  getRepoIdleState,
  getOpencodePaths,
  loadConfig,
  loadJobsState,
  loadNotifications,
  loadRepoActivity,
  loadSchedulesState,
  recordRepoActivity,
  saveJobsState,
  saveSchedulesState,
  withRepoLock,
} from '@opencode-extension-stack/opencode-core';

import { getNextCronOccurrence } from './cron.js';

const RUN_HEARTBEAT_INTERVAL_MS = 5000;
const RUN_STALE_AFTER_MS = 60_000;
const RUN_OUTPUT_TAIL_BYTES = 64 * 1024;
const DAEMON_STALE_AFTER_MS = 30_000;

export async function queueAdd(prompt, options = {}) {
  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt) {
    throw new Error('A prompt is required for /queue add.');
  }

  return enqueueJob(trimmedPrompt, {
    cwd: options.cwd,
    now: options.now,
    source: 'queue',
    scheduleId: null,
  });
}

export async function queueList(options = {}) {
  const repoRoot = await prepareRepo(options.cwd);
  const jobsState = await loadJobsState(repoRoot);

  return jobsState.jobs
    .filter((job) => job.status === 'queued')
    .sort(sortByNewest);
}

export async function queueCancel(jobId, options = {}) {
  const trimmedJobId = jobId.trim();
  if (!trimmedJobId) {
    throw new Error('A job id is required for /queue cancel.');
  }

  const repoRoot = await prepareRepo(options.cwd);
  const nowIso = toIso(options.now);

  return withRepoLock(repoRoot, async () => {
    const jobsState = await loadJobsState(repoRoot);
    const job = jobsState.jobs.find((entry) => entry.jobId === trimmedJobId);

    if (!job) {
      throw new Error(`Job not found: ${trimmedJobId}`);
    }

    if (job.status !== 'queued') {
      throw new Error(`Only queued jobs can be cancelled. Current status: ${job.status}`);
    }

    job.status = 'cancelled';
    job.updatedAt = nowIso;

    await saveJobsState(repoRoot, jobsState);
    await appendRunEvent(repoRoot, job.runId, 'job.cancelled', { jobId: job.jobId });

    return {
      ...job,
      runLogPath: getRunLogPath(repoRoot, job.runId),
    };
  });
}

export async function jobsList(options = {}) {
  const repoRoot = await prepareRepo(options.cwd);
  const jobsState = await loadJobsState(repoRoot);
  return jobsState.jobs.sort(sortByNewest);
}

export async function jobsShow(jobId, options = {}) {
  const trimmedJobId = jobId.trim();
  if (!trimmedJobId) {
    throw new Error('A job id is required for /jobs show.');
  }

  const repoRoot = await prepareRepo(options.cwd);
  const jobsState = await loadJobsState(repoRoot);
  const job = jobsState.jobs.find((entry) => entry.jobId === trimmedJobId);

  if (!job) {
    throw new Error(`Job not found: ${trimmedJobId}`);
  }

  return {
    ...job,
    runLogPath: getRunLogPath(repoRoot, job.runId),
    stdoutPath: getRunStdoutPath(repoRoot, job.runId),
    stderrPath: getRunStderrPath(repoRoot, job.runId),
    resultPath: getRunResultPath(repoRoot, job.runId),
  };
}

export async function jobsRetry(jobId, options = {}) {
  const trimmedJobId = jobId.trim();
  if (!trimmedJobId) {
    throw new Error('A job id is required for /jobs retry.');
  }

  const repoRoot = await prepareRepo(options.cwd);
  const nowIso = toIso(options.now);

  return withRepoLock(repoRoot, async () => {
    const config = await loadConfig(repoRoot);
    assertRepoAllowed(config, repoRoot);

    const jobsState = await loadJobsState(repoRoot);
    const original = jobsState.jobs.find((entry) => entry.jobId === trimmedJobId);

    if (!original) {
      throw new Error(`Job not found: ${trimmedJobId}`);
    }

    if (!['completed', 'failed', 'cancelled'].includes(original.status)) {
      throw new Error(`Only terminal jobs can be retried. Current status: ${original.status}`);
    }

    const effectiveMaxAttempts = Math.max(original.maxAttempts, config.retry.maxAttempts);
    if (original.attempt >= effectiveMaxAttempts) {
      throw new Error(`Job has reached max attempts (${effectiveMaxAttempts}). Cannot retry.`);
    }

    const retryDelayMs = calculateBackoffDelay(original.attempt, config.retry);
    const retryAt = new Date(new Date(nowIso).getTime() + retryDelayMs).toISOString();

    const retriedJob = createJobRecord({
      jobId: createStableId('job'),
      runId: createStableId('run'),
      source: original.source,
      prompt: original.prompt,
      createdAt: nowIso,
      updatedAt: nowIso,
      scheduleId: original.scheduleId,
      scheduledForAt: original.scheduledForAt,
      runnerPid: null,
      heartbeatAt: null,
      retriedFromJobId: original.jobId,
      attempt: original.attempt + 1,
      maxAttempts: effectiveMaxAttempts,
      retryAt,
      repoRoot,
    });

    jobsState.jobs.push(retriedJob);
    await saveJobsState(repoRoot, jobsState);

    const runLogPath = await appendRunEvent(repoRoot, retriedJob.runId, 'job.retried', {
      jobId: retriedJob.jobId,
      retriedFromJobId: original.jobId,
      retryAt,
      source: retriedJob.source,
      prompt: retriedJob.prompt,
    });

    return {
      ...retriedJob,
      runLogPath,
    };
  });
}

export async function cronAdd(schedule, prompt, options = {}) {
  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt) {
    throw new Error('A prompt is required for /cron add.');
  }

  const repoRoot = await prepareRepo(options.cwd);
  const nowIso = toIso(options.now);
  const nextRunAt = getNextCronOccurrence(schedule, new Date(nowIso));

  return withRepoLock(repoRoot, async () => {
    const config = await loadConfig(repoRoot);
    assertRepoAllowed(config, repoRoot);

    const schedulesState = await loadSchedulesState(repoRoot);
    const scheduleRecord = createScheduleRecord({
      cronId: createStableId('cron'),
      schedule,
      prompt: trimmedPrompt,
      createdAt: nowIso,
      updatedAt: nowIso,
      nextRunAt,
      description: null,
    });

    schedulesState.schedules.push(scheduleRecord);
    await saveSchedulesState(repoRoot, schedulesState);

    return scheduleRecord;
  });
}

export async function cronList(options = {}) {
  const repoRoot = await prepareRepo(options.cwd);
  const schedulesState = await loadSchedulesState(repoRoot);
  return schedulesState.schedules.sort(sortByNewest);
}

export async function cronRemove(cronId, options = {}) {
  const trimmedCronId = cronId.trim();
  if (!trimmedCronId) {
    throw new Error('A cron id is required for /cron remove.');
  }

  const repoRoot = await prepareRepo(options.cwd);

  return withRepoLock(repoRoot, async () => {
    const schedulesState = await loadSchedulesState(repoRoot);
    const index = schedulesState.schedules.findIndex((entry) => entry.cronId === trimmedCronId);

    if (index === -1) {
      throw new Error(`Schedule not found: ${trimmedCronId}`);
    }

    const [removed] = schedulesState.schedules.splice(index, 1);
    await saveSchedulesState(repoRoot, schedulesState);
    return removed;
  });
}

export async function cronTick(options = {}) {
  const repoRoot = await prepareRepo(options.cwd);
  const tickTime = toIso(options.now);

  return withRepoLock(repoRoot, async () => {
    const config = await loadConfig(repoRoot);
    assertRepoAllowed(config, repoRoot);

    const jobsState = await loadJobsState(repoRoot);
    const schedulesState = await loadSchedulesState(repoRoot);
    await recoverStaleRunningJobs(repoRoot, jobsState, tickTime);
    const dueJobs = [];
    const skipped = [];

    for (const schedule of schedulesState.schedules) {
      if (!schedule.enabled) {
        continue;
      }

      if (schedule.nextRunAt > tickTime) {
        continue;
      }

      // Prevent overlapping scheduled work for the same repo-local schedule.
      const hasActiveJob = jobsState.jobs.some(
        (job) => job.scheduleId === schedule.cronId && (job.status === 'queued' || job.status === 'running'),
      );

      if (hasActiveJob) {
        schedule.updatedAt = tickTime;
        schedule.nextRunAt = getNextCronOccurrence(schedule.schedule, new Date(tickTime));
        skipped.push(schedule.cronId);
        continue;
      }

      const scheduledForAt = schedule.nextRunAt;
      const alreadyMaterialized = jobsState.jobs.some(
        (job) => job.scheduleId === schedule.cronId && job.scheduledForAt === scheduledForAt,
      );

      if (alreadyMaterialized) {
        schedule.lastRunAt = tickTime;
        schedule.updatedAt = tickTime;
        schedule.runCount += 1;
        schedule.nextRunAt = getNextCronOccurrence(schedule.schedule, new Date(tickTime));
        skipped.push(schedule.cronId);
        continue;
      }

      const job = createJobRecord({
        jobId: createStableId('job'),
        runId: createStableId('run'),
        source: 'cron',
        prompt: schedule.prompt,
        createdAt: tickTime,
        updatedAt: tickTime,
        scheduleId: schedule.cronId,
        scheduledForAt,
        runnerPid: null,
        heartbeatAt: null,
        retriedFromJobId: null,
        repoRoot,
      });

      jobsState.jobs.push(job);
      dueJobs.push(job);

      schedule.lastRunAt = tickTime;
      schedule.updatedAt = tickTime;
      schedule.runCount += 1;
      schedule.nextRunAt = getNextCronOccurrence(schedule.schedule, new Date(tickTime));
    }

    await saveJobsState(repoRoot, jobsState);
    await saveSchedulesState(repoRoot, schedulesState);

    for (const job of dueJobs) {
      await appendRunEvent(repoRoot, job.runId, 'job.enqueued', {
        jobId: job.jobId,
        source: job.source,
        scheduleId: job.scheduleId,
        prompt: job.prompt,
      });
    }

      return {
        tickedAt: tickTime,
        repoRoot,
        enqueued: dueJobs,
        skipped,
      };
  });
}

async function enqueueJob(prompt, options) {
  const repoRoot = await prepareRepo(options.cwd);
  const nowIso = toIso(options.now);

  return withRepoLock(repoRoot, async () => {
    const config = await loadConfig(repoRoot);
    assertRepoAllowed(config, repoRoot);

    const jobsState = await loadJobsState(repoRoot);
    const job = createJobRecord({
      jobId: createStableId('job'),
      runId: createStableId('run'),
      source: options.source,
      prompt,
      createdAt: nowIso,
      updatedAt: nowIso,
      scheduleId: options.scheduleId,
      scheduledForAt: options.scheduledForAt ?? null,
      runnerPid: null,
      heartbeatAt: null,
      retriedFromJobId: null,
      repoRoot,
    });

    jobsState.jobs.push(job);
    await saveJobsState(repoRoot, jobsState);

    const runLogPath = await appendRunEvent(repoRoot, job.runId, 'job.enqueued', {
      jobId: job.jobId,
      source: job.source,
      scheduleId: job.scheduleId,
      prompt: job.prompt,
    });

    return {
      ...job,
      runLogPath,
    };
  });
}

async function prepareRepo(cwd = process.cwd()) {
  const repoRoot = await findRepoRoot(cwd);
  await ensureStateLayout(repoRoot);
  return repoRoot;
}

function sortByNewest(left, right) {
  return right.createdAt.localeCompare(left.createdAt);
}

function toIso(value) {
  return new Date(value ?? Date.now()).toISOString();
}

export async function getStatePaths(cwd = process.cwd()) {
  const repoRoot = await prepareRepo(cwd);
  return getOpencodePaths(repoRoot);
}

export async function activityPing(options = {}) {
  const repoRoot = await prepareRepo(options.cwd);
  return recordRepoActivity(repoRoot, options.source ?? 'manual', options.meta ?? {});
}

export async function activityShow(options = {}) {
  const repoRoot = await prepareRepo(options.cwd);
  return loadRepoActivity(repoRoot);
}

export async function notificationsList(options = {}) {
  const repoRoot = await prepareRepo(options.cwd);
  return loadNotifications(repoRoot, options.limit ?? 20);
}

export async function runnerOnce(options = {}) {
  const repoRoot = await prepareRepo(options.cwd);
  const config = await loadConfig(repoRoot);
  assertRepoAllowed(config, repoRoot);

  const preflight = await getRunnerPreflight(repoRoot, config, options);
  if (!preflight.allowed) {
    await notify(repoRoot, {
      type: 'runner.skipped',
      title: `Runner skipped: ${preflight.reason}`,
      body: buildSkipMessage(preflight),
      level: preflight.reason === 'budget_exhausted' ? 'warn' : 'info',
    });
    return {
      repoRoot,
      claimed: null,
      skipped: preflight,
    };
  }

  const claimResult = await claimNextQueuedJob(repoRoot, config, options.now);
  if (claimResult.skipped) {
    await notify(repoRoot, {
      type: 'runner.skipped',
      title: `Runner skipped: ${claimResult.skipped.reason}`,
      body: buildSkipMessage(claimResult.skipped),
      level: claimResult.skipped.reason === 'budget_exhausted' ? 'warn' : 'info',
    });
    return {
      repoRoot,
      claimed: null,
      skipped: claimResult.skipped,
    };
  }

  const claimed = claimResult.job;

  if (!claimed) {
    return {
      repoRoot,
      claimed: null,
      skipped: null,
    };
  }

  const runArtifacts = await ensureRunArtifacts(repoRoot, claimed.runId);

  let execution;

  try {
    execution = await executeJob(repoRoot, claimed, options, runArtifacts);
  } catch (error) {
    execution = {
      command: 'opencode',
      args: ['run', claimed.prompt],
      exitCode: 1,
      stdout: '',
      stderr: error instanceof Error ? (error.stack || error.message) : String(error),
    };
  }

  const finalized = await finalizeJobRun(repoRoot, claimed.jobId, claimed.runId, execution, options.now, config, runArtifacts);

  return {
    repoRoot,
    claimed,
    finalized,
    skipped: null,
  };
}

export async function supervisorOnce(options = {}) {
  const repoRoot = await prepareRepo(options.cwd);
  const tick = await cronTick({ cwd: repoRoot, now: options.now });
  const run = await runnerOnce(options);

  return {
    repoRoot,
    tick,
    run,
  };
}

export async function supervisorLoop(options = {}) {
  const cycles = options.cycles ?? 1;
  const intervalMs = options.intervalMs ?? 1000;

  if (!Number.isInteger(cycles) || cycles < 1) {
    throw new Error('supervisorLoop requires cycles >= 1.');
  }

  if (!Number.isInteger(intervalMs) || intervalMs < 0) {
    throw new Error('supervisorLoop requires intervalMs >= 0.');
  }

  const results = [];
  for (let index = 0; index < cycles; index += 1) {
    results.push(await supervisorOnce(options));
    if (index < cycles - 1 && intervalMs > 0) {
      await sleep(intervalMs);
    }
  }

  return {
    repoRoot: results[0]?.repoRoot ?? await prepareRepo(options.cwd),
    cycles,
    intervalMs,
    results,
  };
}

export function getDaemonFiles(repoRoot) {
  const paths = getOpencodePaths(repoRoot);
  return {
    statePath: path.join(paths.workersDir, 'kairos-daemon.json'),
    lockPath: path.join(paths.workersDir, 'kairos-daemon.lock'),
    stopPath: path.join(paths.workersDir, 'kairos-daemon.stop'),
    logPath: path.join(paths.workersDir, 'kairos-daemon.log'),
  };
}

export async function readDaemonState(options = {}) {
  const repoRoot = await prepareRepo(options.cwd);
  const files = getDaemonFiles(repoRoot);

  try {
    const content = await fs.readFile(files.statePath, 'utf8');
    const state = JSON.parse(content);
    const ownerLock = await readDaemonOwnerLock(repoRoot);
    const nowMs = Date.now();
    const startedMs = state.startedAt ? new Date(state.startedAt).getTime() : null;
    const staleThresholdMs = Math.max((state.intervalMs ?? 5000) * 3, DAEMON_STALE_AFTER_MS);
    const startingWindowAlive =
      state.state === 'starting' &&
      state.pid &&
      startedMs !== null &&
      nowMs - startedMs <= staleThresholdMs &&
      isProcessRunning(state.pid);
    const running =
      startingWindowAlive ||
      state.pid &&
      state.daemonToken &&
      ownerLock.token === state.daemonToken &&
      ownerLock.pid === state.pid &&
      isProcessRunning(state.pid);
    const stopRequested = await shouldDaemonStop(repoRoot);
    const lastCycleMs = state.lastCycleAt ? new Date(state.lastCycleAt).getTime() : null;
    const runningJob = running ? await loadFreshRunningJob(repoRoot, nowMs, staleThresholdMs) : null;
    let daemonState = state.state;

    if (!running && (state.state === 'running' || state.state === 'starting')) {
      daemonState = 'stale';
    } else if (running && state.state === 'running' && lastCycleMs !== null && nowMs - lastCycleMs > staleThresholdMs && !runningJob) {
      daemonState = 'hung';
    } else if (running && state.state === 'starting' && startedMs !== null && nowMs - startedMs > staleThresholdMs) {
      daemonState = 'hung';
    }

    return {
      ...state,
      repoRoot,
      running,
      state: daemonState,
      stopRequested,
      activeJobId: runningJob?.jobId ?? null,
      logPath: files.logPath,
      stopPath: files.stopPath,
      statePath: files.statePath,
    };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return {
        repoRoot,
        running: false,
        state: 'stopped',
        logPath: files.logPath,
        stopPath: files.stopPath,
        statePath: files.statePath,
      };
    }

    throw error;
  }
}

export async function writeDaemonState(repoRoot, state) {
  const files = getDaemonFiles(repoRoot);
  await fs.mkdir(path.dirname(files.statePath), { recursive: true });
  const tempPath = `${files.statePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, files.statePath);
  return files.statePath;
}

export async function clearDaemonStopSignal(repoRoot) {
  const files = getDaemonFiles(repoRoot);
  await fs.rm(files.stopPath, { force: true });
}

export async function requestDaemonStop(repoRoot) {
  const files = getDaemonFiles(repoRoot);
  await fs.writeFile(files.stopPath, `${new Date().toISOString()}\n`, 'utf8');
  return files.stopPath;
}

export async function shouldDaemonStop(repoRoot) {
  const files = getDaemonFiles(repoRoot);
  try {
    await fs.access(files.stopPath);
    return true;
  } catch {
    return false;
  }
}

function getRunLogPath(repoRoot, runId) {
  return `${getOpencodePaths(repoRoot).runsDir}/${runId}/events.ndjson`;
}

function getRunStdoutPath(repoRoot, runId) {
  return `${getOpencodePaths(repoRoot).runsDir}/${runId}/stdout.txt`;
}

function getRunStderrPath(repoRoot, runId) {
  return `${getOpencodePaths(repoRoot).runsDir}/${runId}/stderr.txt`;
}

function getRunResultPath(repoRoot, runId) {
  return `${getOpencodePaths(repoRoot).runsDir}/${runId}/result.json`;
}

async function ensureRunArtifacts(repoRoot, runId) {
  const paths = getOpencodePaths(repoRoot);
  const runDir = path.join(paths.runsDir, runId);
  const stdoutPath = getRunStdoutPath(repoRoot, runId);
  const stderrPath = getRunStderrPath(repoRoot, runId);
  const resultPath = getRunResultPath(repoRoot, runId);
  const stdoutTempPath = `${stdoutPath}.tmp.${process.pid}`;
  const stderrTempPath = `${stderrPath}.tmp.${process.pid}`;

  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(stdoutTempPath, '', 'utf8');
  await fs.writeFile(stderrTempPath, '', 'utf8');

  return {
    runDir,
    stdoutPath,
    stderrPath,
    resultPath,
    stdoutTempPath,
    stderrTempPath,
  };
}

async function claimNextQueuedJob(repoRoot, config, now) {
  const claimTime = toIso(now);

  return withRepoLock(repoRoot, async () => {
    const jobsState = await loadJobsState(repoRoot);
    await recoverStaleRunningJobs(repoRoot, jobsState, claimTime);

    const activeJob = jobsState.jobs.find((entry) => entry.status === 'running');
    if (activeJob) {
      return {
        job: null,
        skipped: {
          allowed: false,
          reason: 'repo_busy',
          idleState: null,
          budgetState: null,
          activeJobId: activeJob.jobId,
        },
      };
    }

    const budgetState = await getBudgetStateFromJobsState(jobsState, config, claimTime);
    if (!budgetState.allowed) {
      return {
        job: null,
        skipped: {
          allowed: false,
          reason: 'budget_exhausted',
          idleState: null,
          budgetState,
        },
      };
    }

    const nowMs = new Date(claimTime).getTime();

    const eligibleJobs = jobsState.jobs
      .filter((entry) => entry.status === 'queued')
      .filter((entry) => {
        if (!entry.retryAt) {
          return true;
        }
        return new Date(entry.retryAt).getTime() <= nowMs;
      })
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

    const job = eligibleJobs[0] ?? null;

    if (!job) {
      return { job: null, skipped: null };
    }

    job.status = 'running';
    job.startedAt = job.startedAt ?? claimTime;
    job.heartbeatAt = claimTime;
    job.runnerPid = process.pid;
    job.updatedAt = claimTime;

    await saveJobsState(repoRoot, jobsState);
    await appendRunEvent(repoRoot, job.runId, 'job.started', {
      jobId: job.jobId,
      prompt: job.prompt,
      source: job.source,
    });

    return {
      job: { ...job },
      skipped: null,
    };
  });
}

async function executeJob(repoRoot, job, options, runArtifacts) {
  if (typeof options.executeJob === 'function') {
    return options.executeJob({ repoRoot, job, prompt: job.prompt, runArtifacts });
  }

  const args = ['run', '--dir', repoRoot, '--format', 'json', job.prompt];
  return spawnRunner('opencode', args, {
    stdoutPath: runArtifacts.stdoutTempPath,
    stderrPath: runArtifacts.stderrTempPath,
    onHeartbeat: () => heartbeatJob(repoRoot, job.jobId),
    heartbeatIntervalMs: RUN_HEARTBEAT_INTERVAL_MS,
  });
}

async function finalizeJobRun(repoRoot, jobId, runId, execution, now, config, runArtifacts) {
  const finishTime = toIso(now);
  const { resultPath, stderrPath, stderrTempPath, stdoutPath, stdoutTempPath } = runArtifacts;
  const costUsd = extractCostUsd(execution);

  if (!execution.streamed) {
    await fs.writeFile(stdoutTempPath, execution.stdout ?? '', 'utf8');
    await fs.writeFile(stderrTempPath, execution.stderr ?? '', 'utf8');
  }

  return withRepoLock(repoRoot, async () => {
    const jobsState = await loadJobsState(repoRoot);
    const job = jobsState.jobs.find((entry) => entry.jobId === jobId);

    if (!job) {
      throw new Error(`Job not found during finalize: ${jobId}`);
    }

    if (job.status !== 'running' || job.runnerPid !== process.pid) {
      await fs.rm(stdoutTempPath, { force: true }).catch(() => {});
      await fs.rm(stderrTempPath, { force: true }).catch(() => {});
      await appendRunEvent(repoRoot, runId, 'job.finalize_ignored', {
        jobId,
        currentStatus: job.status,
        currentRunnerPid: job.runnerPid,
      });
      return {
        ...job,
        stdoutPath,
        stderrPath,
        resultPath,
        runLogPath: getRunLogPath(repoRoot, runId),
      };
    }

    await fs.rename(stdoutTempPath, stdoutPath).catch(async () => {
      const content = await fs.readFile(stdoutTempPath, 'utf8').catch(() => '');
      await fs.writeFile(stdoutPath, content, 'utf8');
      await fs.rm(stdoutTempPath, { force: true }).catch(() => {});
    });
    await fs.rename(stderrTempPath, stderrPath).catch(async () => {
      const content = await fs.readFile(stderrTempPath, 'utf8').catch(() => '');
      await fs.writeFile(stderrPath, content, 'utf8');
      await fs.rm(stderrTempPath, { force: true }).catch(() => {});
    });
    await fs.writeFile(
      resultPath,
      `${JSON.stringify({
        finishedAt: finishTime,
        exitCode: execution.exitCode,
        costUsd,
        command: execution.command,
        args: execution.args,
      }, null, 2)}\n`,
      'utf8',
    );

    const perRunLimitExceeded =
      execution.exitCode === 0 &&
      costUsd !== null &&
      config.budgets.perRunUsd !== null &&
      costUsd > config.budgets.perRunUsd;

    job.updatedAt = finishTime;
    job.completedAt = finishTime;
    job.heartbeatAt = null;
    job.runnerPid = null;
    job.exitCode = execution.exitCode;
    job.costUsd = costUsd;
    job.errorMessage =
      execution.exitCode === 0
        ? (perRunLimitExceeded ? `Run cost ${formatUsd(costUsd)} exceeded per-run budget ${formatUsd(config.budgets.perRunUsd)}.` : null)
        : summarizeError(execution);
    job.status = execution.exitCode === 0 && !perRunLimitExceeded ? 'completed' : 'failed';

    await saveJobsState(repoRoot, jobsState);
    await appendRunEvent(repoRoot, runId, execution.exitCode === 0 && !perRunLimitExceeded ? 'job.completed' : 'job.failed', {
      jobId,
      exitCode: execution.exitCode,
      costUsd,
      stdoutPath,
      stderrPath,
      resultPath,
    });

    if (perRunLimitExceeded) {
      await appendRunEvent(repoRoot, runId, 'job.budget_exceeded', {
        jobId,
        costUsd,
        perRunUsd: config.budgets.perRunUsd,
      });
    }

    await notify(repoRoot, {
      type: job.status === 'completed' ? 'job.completed' : 'job.failed',
      title: `${job.status === 'completed' ? 'Completed' : 'Failed'} ${job.jobId}`,
      body: job.status === 'completed'
        ? `Prompt executed successfully.${costUsd !== null ? ` Cost ${formatUsd(costUsd)}.` : ''}`
        : (job.errorMessage ?? 'Job failed.'),
      level: job.status === 'completed' ? 'info' : 'warn',
      jobId: job.jobId,
      runId,
    });

    if (job.status === 'failed' && job.attempt < config.retry.maxAttempts && config.retry.maxAttempts > 1) {
      const retryDelayMs = calculateBackoffDelay(job.attempt, config.retry);
      const retryAt = new Date(new Date(finishTime).getTime() + retryDelayMs).toISOString();
      const retriedJob = createJobRecord({
        jobId: createStableId('job'),
        runId: createStableId('run'),
        source: job.source,
        prompt: job.prompt,
        createdAt: finishTime,
        updatedAt: finishTime,
        scheduleId: job.scheduleId,
        scheduledForAt: job.scheduledForAt,
        runnerPid: null,
        heartbeatAt: null,
        retriedFromJobId: job.jobId,
        attempt: job.attempt + 1,
        maxAttempts: config.retry.maxAttempts,
        retryAt,
        repoRoot,
      });
      jobsState.jobs.push(retriedJob);
      await saveJobsState(repoRoot, jobsState);
      await appendRunEvent(repoRoot, retriedJob.runId, 'job.scheduled_retry', {
        jobId: retriedJob.jobId,
        retriedFromJobId: job.jobId,
        retryAt,
        attempt: retriedJob.attempt,
        maxAttempts: retriedJob.maxAttempts,
      });
    }

    return {
      ...job,
      stdoutPath,
      stderrPath,
      resultPath,
      runLogPath: getRunLogPath(repoRoot, runId),
    };
  });
}

function spawnRunner(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    const stdoutStream = createWriteStream(options.stdoutPath, { flags: 'a' });
    const stderrStream = createWriteStream(options.stderrPath, { flags: 'a' });

    let heartbeatTimer = null;
    if (options.onHeartbeat) {
      heartbeatTimer = setInterval(() => {
        options.onHeartbeat().catch(() => {});
      }, options.heartbeatIntervalMs ?? RUN_HEARTBEAT_INTERVAL_MS);
    }

    let stdout = '';
    let stderr = '';

    const onSignal = () => {
      child.kill('SIGTERM');
    };

    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdoutStream.write(text);
      stdout = appendTail(stdout, text, RUN_OUTPUT_TAIL_BYTES);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderrStream.write(text);
      stderr = appendTail(stderr, text, RUN_OUTPUT_TAIL_BYTES);
    });

    child.on('error', (error) => {
      cleanup();
      reject(error);
    });

    child.on('close', (exitCode) => {
      cleanup();
      resolve({
        command,
        args,
        exitCode: exitCode ?? 1,
        stdout,
        stderr,
        streamed: true,
      });
    });

    function cleanup() {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
      stdoutStream.end();
      stderrStream.end();
    }
  });
}

function summarizeError(execution) {
  const text = (execution.stderr || execution.stdout || '').trim();
  return text ? text.split('\n')[0].slice(0, 500) : `Process exited with code ${execution.exitCode}`;
}

async function getRunnerPreflight(repoRoot, config, options) {
  const idleState = options.force
    ? { idle: true, reason: 'force_bypass', idleSeconds: null, latestActivityAt: null }
    : await getRepoIdleState(repoRoot, config, { now: options.now });

  if (!idleState.idle) {
    return {
      allowed: false,
      reason: 'not_idle',
      idleState,
      budgetState: null,
    };
  }

  const budgetState = await getBudgetState(repoRoot, config, options.now);
  if (!budgetState.allowed) {
    return {
      allowed: false,
      reason: 'budget_exhausted',
      idleState,
      budgetState,
    };
  }

  return {
    allowed: true,
    reason: 'ready',
    idleState,
    budgetState,
  };
}

async function getBudgetState(repoRoot, config, now) {
  const spentTodayUsd = await getSpentTodayUsd(repoRoot, now);
  const runsStartedToday = await getRunsStartedToday(repoRoot, now);
  const perDayUsd = config.budgets.perDayUsd;
  const perDayRuns = config.budgets.perDayRuns;
  const usdAllowed = perDayUsd === null ? true : spentTodayUsd < perDayUsd;
  const runsAllowed = perDayRuns === null ? true : runsStartedToday < perDayRuns;
  const allowed = usdAllowed && runsAllowed;

  return {
    allowed,
    spentTodayUsd,
    perDayUsd,
    runsStartedToday,
    perDayRuns,
  };
}

function getBudgetStateFromJobsState(jobsState, config, now) {
  const today = toIso(now).slice(0, 10);
  const spentTodayUsd = jobsState.jobs.reduce((total, job) => {
    if (job.costUsd === null || job.costUsd === undefined || !job.completedAt) {
      return total;
    }

    return job.completedAt.slice(0, 10) === today ? total + job.costUsd : total;
  }, 0);

  const runsStartedToday = jobsState.jobs.reduce((total, job) => {
    if (!job.startedAt) {
      return total;
    }

    return job.startedAt.slice(0, 10) === today ? total + 1 : total;
  }, 0);

  const perDayUsd = config.budgets.perDayUsd;
  const perDayRuns = config.budgets.perDayRuns;
  const usdAllowed = perDayUsd === null ? true : spentTodayUsd < perDayUsd;
  const runsAllowed = perDayRuns === null ? true : runsStartedToday < perDayRuns;

  return {
    allowed: usdAllowed && runsAllowed,
    spentTodayUsd,
    perDayUsd,
    runsStartedToday,
    perDayRuns,
  };
}

async function getSpentTodayUsd(repoRoot, now) {
  const jobsState = await loadJobsState(repoRoot);
  const today = toIso(now).slice(0, 10);

  return jobsState.jobs.reduce((total, job) => {
    if (job.costUsd === null || job.costUsd === undefined || !job.completedAt) {
      return total;
    }

    return job.completedAt.slice(0, 10) === today ? total + job.costUsd : total;
  }, 0);
}

async function getRunsStartedToday(repoRoot, now) {
  const jobsState = await loadJobsState(repoRoot);
  const today = toIso(now).slice(0, 10);

  return jobsState.jobs.reduce((total, job) => {
    if (!job.startedAt) {
      return total;
    }

    return job.startedAt.slice(0, 10) === today ? total + 1 : total;
  }, 0);
}

async function heartbeatJob(repoRoot, jobId) {
  return withRepoLock(repoRoot, async () => {
    const jobsState = await loadJobsState(repoRoot);
    const job = jobsState.jobs.find((entry) => entry.jobId === jobId);

    if (!job || job.status !== 'running') {
      return;
    }

    const nowIso = new Date().toISOString();
    job.heartbeatAt = nowIso;
    job.updatedAt = nowIso;
    await saveJobsState(repoRoot, jobsState);
  });
}

async function recoverStaleRunningJobs(repoRoot, jobsState, now) {
  const nowMs = new Date(now).getTime();
  let changed = false;
  const recovered = [];

  for (const job of jobsState.jobs) {
    if (job.status !== 'running') {
      continue;
    }

    const heartbeatMs = job.heartbeatAt ? new Date(job.heartbeatAt).getTime() : 0;
    const runnerAlive = job.runnerPid ? isProcessRunning(job.runnerPid) : false;
    const stale = !runnerAlive || nowMs - heartbeatMs > RUN_STALE_AFTER_MS;

    if (!stale) {
      continue;
    }

    const nowIso = new Date(now).toISOString();
    job.status = 'failed';
    job.updatedAt = nowIso;
    job.completedAt = nowIso;
    job.exitCode = 1;
    job.errorMessage = 'Runner process stopped before the job finalized cleanly.';
    job.heartbeatAt = null;
    job.runnerPid = null;
    changed = true;
    recovered.push({
      jobId: job.jobId,
      runId: job.runId,
      scheduleId: job.scheduleId,
      errorMessage: job.errorMessage,
    });
  }

  if (changed) {
    await saveJobsState(repoRoot, jobsState);
    for (const job of recovered) {
      await appendRunEvent(repoRoot, job.runId, 'job.recovered_as_failed', {
        jobId: job.jobId,
        scheduleId: job.scheduleId,
      });
      await notify(repoRoot, {
        type: 'job.recovered_as_failed',
        title: `Recovered stale run ${job.jobId}`,
        body: job.errorMessage,
        level: 'warn',
        jobId: job.jobId,
        runId: job.runId,
      });
    }
  }
}

function extractCostUsd(execution) {
  if (typeof execution.costUsd === 'number' && Number.isFinite(execution.costUsd)) {
    return execution.costUsd;
  }

  let costUsd = null;
  for (const line of (execution.stdout ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      const value = JSON.parse(trimmed);
      const found = findCostUsd(value);
      if (found !== null) {
        costUsd = found;
      }
    } catch {
      continue;
    }
  }

  return costUsd;
}

function findCostUsd(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const keys = ['costUsd', 'cost', 'totalCostUsd', 'totalCost'];
  for (const key of keys) {
    if (typeof value[key] === 'number' && Number.isFinite(value[key])) {
      return value[key];
    }
  }

  for (const [key, nested] of Object.entries(value)) {
    if (typeof nested === 'number' && Number.isFinite(nested) && /(cost|usd)/i.test(key)) {
      return nested;
    }
  }

  for (const nested of Object.values(value)) {
    const found = findCostUsd(nested);
    if (found !== null) {
      return found;
    }
  }

  return null;
}

function appendTail(existing, chunk, maxBytes) {
  const combined = existing + chunk;
  if (Buffer.byteLength(combined, 'utf8') <= maxBytes) {
    return combined;
  }

  return Buffer.from(combined, 'utf8').subarray(-maxBytes).toString('utf8');
}

function formatUsd(value) {
  return `$${Number(value).toFixed(4)}`;
}

function buildSkipMessage(preflight) {
  if (preflight.reason === 'not_idle') {
    return preflight.idleState?.latestActivityAt
      ? `Latest activity at ${preflight.idleState.latestActivityAt}; idle seconds ${preflight.idleState.idleSeconds}.`
      : 'Repo is considered active.';
  }

  if (preflight.reason === 'budget_exhausted') {
    const parts = [];
    if (preflight.budgetState?.perDayUsd !== null) {
      parts.push(`spent today ${formatUsd(preflight.budgetState.spentTodayUsd)} of ${formatUsd(preflight.budgetState.perDayUsd)}`);
    }
    if (preflight.budgetState?.perDayRuns !== null) {
      parts.push(`runs today ${preflight.budgetState.runsStartedToday} of ${preflight.budgetState.perDayRuns}`);
    }
    return parts.join('; ');
  }

  if (preflight.reason === 'repo_busy') {
    return preflight.activeJobId ? `Active job ${preflight.activeJobId} is still running.` : 'Another repo job is already running.';
  }

  return preflight.reason;
}

async function notify(repoRoot, input) {
  const notification = {
    notificationId: createStableId('notice'),
    createdAt: new Date().toISOString(),
    ...input,
  };
  const recent = await loadNotifications(repoRoot, 1);
  const last = recent[0];
  const duplicate =
    last &&
    last.type === notification.type &&
    last.title === notification.title &&
    last.body === notification.body &&
    last.level === notification.level &&
    last.jobId === notification.jobId &&
    Date.now() - new Date(last.createdAt).getTime() < 60_000;

  if (duplicate) {
    return null;
  }

  const config = await loadConfig(repoRoot);
  if (config.notifications.console) {
    console.log(`[kairos:${notification.level}] ${notification.title} - ${notification.body}`);
  }

  return appendNotification(repoRoot, notification);
}

async function readDaemonOwnerLock(repoRoot) {
  const { lockPath } = getDaemonFiles(repoRoot);
  try {
    const content = await fs.readFile(lockPath, 'utf8');
    const parsed = JSON.parse(content);
    return {
      token: typeof parsed?.token === 'string' ? parsed.token : null,
      pid: typeof parsed?.pid === 'number' ? parsed.pid : null,
    };
  } catch {
    return {
      token: null,
      pid: null,
    };
  }
}

async function loadFreshRunningJob(repoRoot, nowMs, staleThresholdMs) {
  const jobsState = await loadJobsState(repoRoot);
  return jobsState.jobs.find((job) => {
    if (job.status !== 'running' || !job.heartbeatAt) {
      return false;
    }

    return nowMs - new Date(job.heartbeatAt).getTime() <= staleThresholdMs;
  }) ?? null;
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function calculateBackoffDelay(attempt, retryConfig) {
  const { backoffType, baseDelaySeconds, maxDelaySeconds } = retryConfig;
  const delaySeconds = Math.min(
    backoffType === 'exponential'
      ? baseDelaySeconds * Math.pow(2, attempt - 1)
      : backoffType === 'linear'
        ? baseDelaySeconds * attempt
        : baseDelaySeconds,
    maxDelaySeconds
  );
  return Math.max(delaySeconds * 1000, 0);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
