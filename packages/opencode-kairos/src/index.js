import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  appendRunEvent,
  assertRepoAllowed,
  createJobRecord,
  createScheduleRecord,
  createStableId,
  ensureStateLayout,
  findRepoRoot,
  getOpencodePaths,
  loadConfig,
  loadJobsState,
  loadSchedulesState,
  saveJobsState,
  saveSchedulesState,
  withRepoLock,
} from '@opencode-extension-stack/opencode-core';

import { getNextCronOccurrence } from './cron.js';

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

    const retriedJob = createJobRecord({
      jobId: createStableId('job'),
      runId: createStableId('run'),
      source: original.source,
      prompt: original.prompt,
      createdAt: nowIso,
      updatedAt: nowIso,
      scheduleId: original.scheduleId,
      retriedFromJobId: original.jobId,
      attempt: original.attempt + 1,
      maxAttempts: Math.max(original.maxAttempts, original.attempt + 1),
      repoRoot,
    });

    jobsState.jobs.push(retriedJob);
    await saveJobsState(repoRoot, jobsState);

    const runLogPath = await appendRunEvent(repoRoot, retriedJob.runId, 'job.retried', {
      jobId: retriedJob.jobId,
      retriedFromJobId: original.jobId,
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

      const job = createJobRecord({
        jobId: createStableId('job'),
        runId: createStableId('run'),
        source: 'cron',
        prompt: schedule.prompt,
        createdAt: tickTime,
        updatedAt: tickTime,
        scheduleId: schedule.cronId,
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

export async function runnerOnce(options = {}) {
  const repoRoot = await prepareRepo(options.cwd);
  const claimed = await claimNextQueuedJob(repoRoot, options.now);

  if (!claimed) {
    return {
      repoRoot,
      claimed: null,
    };
  }

  let execution;

  try {
    execution = await executeJob(repoRoot, claimed, options);
  } catch (error) {
    execution = {
      command: 'opencode',
      args: ['run', claimed.prompt],
      exitCode: 1,
      stdout: '',
      stderr: error instanceof Error ? (error.stack || error.message) : String(error),
    };
  }

  const finalized = await finalizeJobRun(repoRoot, claimed.jobId, claimed.runId, execution, options.now);

  return {
    repoRoot,
    claimed,
    finalized,
  };
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

async function claimNextQueuedJob(repoRoot, now) {
  const claimTime = toIso(now);

  return withRepoLock(repoRoot, async () => {
    const jobsState = await loadJobsState(repoRoot);
    const job = jobsState.jobs
      .filter((entry) => entry.status === 'queued')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];

    if (!job) {
      return null;
    }

    job.status = 'running';
    job.startedAt = job.startedAt ?? claimTime;
    job.updatedAt = claimTime;

    await saveJobsState(repoRoot, jobsState);
    await appendRunEvent(repoRoot, job.runId, 'job.started', {
      jobId: job.jobId,
      prompt: job.prompt,
      source: job.source,
    });

    return { ...job };
  });
}

async function executeJob(repoRoot, job, options) {
  if (typeof options.executeJob === 'function') {
    return options.executeJob({ repoRoot, job, prompt: job.prompt });
  }

  const args = ['run', '--dir', repoRoot, '--format', 'json', job.prompt];
  return spawnRunner('opencode', args);
}

async function finalizeJobRun(repoRoot, jobId, runId, execution, now) {
  const finishTime = toIso(now);
  const paths = getOpencodePaths(repoRoot);
  const runDir = path.join(paths.runsDir, runId);
  const stdoutPath = getRunStdoutPath(repoRoot, runId);
  const stderrPath = getRunStderrPath(repoRoot, runId);
  const resultPath = getRunResultPath(repoRoot, runId);

  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(stdoutPath, execution.stdout ?? '', 'utf8');
  await fs.writeFile(stderrPath, execution.stderr ?? '', 'utf8');
  await fs.writeFile(
    resultPath,
    `${JSON.stringify({
      finishedAt: finishTime,
      exitCode: execution.exitCode,
      command: execution.command,
      args: execution.args,
    }, null, 2)}\n`,
    'utf8',
  );

  return withRepoLock(repoRoot, async () => {
    const jobsState = await loadJobsState(repoRoot);
    const job = jobsState.jobs.find((entry) => entry.jobId === jobId);

    if (!job) {
      throw new Error(`Job not found during finalize: ${jobId}`);
    }

    job.updatedAt = finishTime;
    job.completedAt = finishTime;
    job.exitCode = execution.exitCode;
    job.errorMessage = execution.exitCode === 0 ? null : summarizeError(execution);
    job.status = execution.exitCode === 0 ? 'completed' : 'failed';

    await saveJobsState(repoRoot, jobsState);
    await appendRunEvent(repoRoot, runId, execution.exitCode === 0 ? 'job.completed' : 'job.failed', {
      jobId,
      exitCode: execution.exitCode,
      stdoutPath,
      stderrPath,
      resultPath,
    });

    return {
      ...job,
      stdoutPath,
      stderrPath,
      resultPath,
      runLogPath: getRunLogPath(repoRoot, runId),
    };
  });
}

function spawnRunner(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (exitCode) => {
      resolve({
        command,
        args,
        exitCode: exitCode ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

function summarizeError(execution) {
  const text = (execution.stderr || execution.stdout || '').trim();
  return text ? text.split('\n')[0].slice(0, 500) : `Process exited with code ${execution.exitCode}`;
}
