import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createJobRecord, loadConfig, loadJobsState, saveConfig, saveJobsState } from '@opencode-extension-stack/opencode-core';

import {
  activityPing,
  activityShow,
  cronAdd,
  cronList,
  cronRemove,
  cronTick,
  jobsList,
  jobsRetry,
  jobsShow,
  notificationsList,
  queueAdd,
  queueCancel,
  queueList,
  readDaemonState,
  runnerOnce,
  supervisorOnce,
  supervisorLoop,
} from '../src/index.js';

async function createTempRepo() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-kairos-'));
  await fs.mkdir(path.join(repoRoot, '.git'));
  return repoRoot;
}

test('queueAdd stores queued jobs and creates a run log', async () => {
  const repoRoot = await createTempRepo();
  const job = await queueAdd('inspect planning docs', { cwd: repoRoot, now: '2026-04-03T12:00:00.000Z' });

  const queued = await queueList({ cwd: repoRoot });
  const jobs = await jobsList({ cwd: repoRoot });

  assert.equal(queued.length, 1);
  assert.equal(jobs.length, 1);
  assert.equal(job.source, 'queue');

  const logContent = await fs.readFile(job.runLogPath, 'utf8');
  assert.match(logContent, /job\.enqueued/);
});

test('queueCancel, jobsShow, and jobsRetry update lifecycle state safely', async () => {
  const repoRoot = await createTempRepo();
  const queued = await queueAdd('inspect planning docs', { cwd: repoRoot, now: '2026-04-03T12:00:00.000Z' });

  const shown = await jobsShow(queued.jobId, { cwd: repoRoot });
  assert.equal(shown.jobId, queued.jobId);

  const cancelled = await queueCancel(queued.jobId, { cwd: repoRoot, now: '2026-04-03T12:02:00.000Z' });
  assert.equal(cancelled.status, 'cancelled');

  const queueAfterCancel = await queueList({ cwd: repoRoot });
  assert.equal(queueAfterCancel.length, 0);

  const retried = await jobsRetry(queued.jobId, { cwd: repoRoot, now: '2026-04-03T12:03:00.000Z' });
  assert.equal(retried.status, 'queued');
  assert.equal(retried.retriedFromJobId, queued.jobId);
  assert.equal(retried.attempt, 2);
});

test('jobsRetry rejects non-terminal jobs', async () => {
  const repoRoot = await createTempRepo();
  const queued = await queueAdd('inspect planning docs', { cwd: repoRoot, now: '2026-04-03T12:00:00.000Z' });

  await assert.rejects(
    () => jobsRetry(queued.jobId, { cwd: repoRoot, now: '2026-04-03T12:03:00.000Z' }),
    /Only terminal jobs can be retried/,
  );
});

test('cronAdd and cronTick materialize due schedules into queued jobs', async () => {
  const repoRoot = await createTempRepo();

  const schedule = await cronAdd('*/5 * * * *', 'check repo health', {
    cwd: repoRoot,
    now: '2026-04-03T12:00:00.000Z',
  });

  const schedules = await cronList({ cwd: repoRoot });
  assert.equal(schedules.length, 1);
  assert.equal(schedule.nextRunAt, '2026-04-03T12:05:00.000Z');

  const tick = await cronTick({ cwd: repoRoot, now: '2026-04-03T12:05:00.000Z' });
  assert.equal(tick.enqueued.length, 1);
  assert.equal(tick.enqueued[0].source, 'cron');
  assert.equal(tick.enqueued[0].scheduleId, schedule.cronId);

  const queued = await queueList({ cwd: repoRoot });
  assert.equal(queued.length, 1);
});

test('cronTick skips overlap and cronRemove deletes schedules', async () => {
  const repoRoot = await createTempRepo();

  const schedule = await cronAdd('*/5 * * * *', 'check repo health', {
    cwd: repoRoot,
    now: '2026-04-03T12:00:00.000Z',
  });

  await cronTick({ cwd: repoRoot, now: '2026-04-03T12:05:00.000Z' });
  const overlapTick = await cronTick({ cwd: repoRoot, now: '2026-04-03T12:10:00.000Z' });

  assert.equal(overlapTick.enqueued.length, 0);
  assert.deepEqual(overlapTick.skipped, [schedule.cronId]);

  await cronRemove(schedule.cronId, { cwd: repoRoot });
  const schedules = await cronList({ cwd: repoRoot });
  assert.equal(schedules.length, 0);
});

test('cron uses standard day-of-month or day-of-week semantics', async () => {
  const repoRoot = await createTempRepo();
  const schedule = await cronAdd('0 0 1 * 0', 'calendar check', {
    cwd: repoRoot,
    now: '2026-04-02T12:00:00.000Z',
  });

  assert.match(schedule.nextRunAt, /^2026-04-05T/);
});

test('cronTick avoids duplicate materialization when a due job already exists for that schedule slot', async () => {
  const repoRoot = await createTempRepo();
  const schedule = await cronAdd('*/5 * * * *', 'check repo health', {
    cwd: repoRoot,
    now: '2026-04-03T12:00:00.000Z',
  });

  const jobsState = await loadJobsState(repoRoot);
  jobsState.jobs.push(createJobRecord({
    jobId: 'job_existing',
    runId: 'run_existing',
    source: 'cron',
    prompt: 'check repo health',
    createdAt: '2026-04-03T12:05:00.000Z',
    updatedAt: '2026-04-03T12:05:00.000Z',
    scheduleId: schedule.cronId,
    scheduledForAt: '2026-04-03T12:05:00.000Z',
    runnerPid: null,
    heartbeatAt: null,
    retriedFromJobId: null,
    repoRoot,
  }));
  await saveJobsState(repoRoot, jobsState);

  const tick = await cronTick({ cwd: repoRoot, now: '2026-04-03T12:05:00.000Z' });
  assert.equal(tick.enqueued.length, 0);

  const queued = await queueList({ cwd: repoRoot });
  assert.equal(queued.length, 1);
});

test('runnerOnce claims one queued job, writes outputs, and completes it', async () => {
  const repoRoot = await createTempRepo();
  const queued = await queueAdd('inspect planning docs', { cwd: repoRoot, now: '2026-04-03T12:00:00.000Z' });

  const result = await runnerOnce({
    cwd: repoRoot,
    now: '2026-04-03T12:05:00.000Z',
    executeJob: async ({ prompt }) => ({
      command: 'test-runner',
      args: [prompt],
      exitCode: 0,
      stdout: 'completed output',
      stderr: '',
    }),
  });

  assert.equal(result.claimed.jobId, queued.jobId);
  assert.equal(result.finalized.status, 'completed');
  assert.equal(result.finalized.exitCode, 0);

  const shown = await jobsShow(queued.jobId, { cwd: repoRoot });
  assert.equal(shown.status, 'completed');
  assert.equal(shown.exitCode, 0);

  const stdout = await fs.readFile(result.finalized.stdoutPath, 'utf8');
  assert.equal(stdout, 'completed output');
});

test('runnerOnce recovers stale running jobs before claiming new work', async () => {
  const repoRoot = await createTempRepo();
  const jobsState = await loadJobsState(repoRoot);
  jobsState.jobs.push(createJobRecord({
    jobId: 'job_stale',
    runId: 'run_stale',
    source: 'queue',
    status: 'running',
    prompt: 'stale work',
    createdAt: '2026-04-03T12:00:00.000Z',
    updatedAt: '2026-04-03T12:00:00.000Z',
    startedAt: '2026-04-03T12:00:00.000Z',
    heartbeatAt: '2026-04-03T12:00:00.000Z',
    runnerPid: 999999,
    completedAt: null,
    exitCode: null,
    costUsd: null,
    errorMessage: null,
    scheduleId: null,
    scheduledForAt: null,
    retriedFromJobId: null,
    repoRoot,
  }));
  await saveJobsState(repoRoot, jobsState);
  await queueAdd('fresh work', { cwd: repoRoot, now: '2026-04-03T12:01:00.000Z' });

  const result = await runnerOnce({
    cwd: repoRoot,
    now: '2026-04-03T12:05:00.000Z',
    executeJob: async ({ prompt }) => ({
      command: 'test-runner',
      args: [prompt],
      exitCode: 0,
      stdout: 'completed output',
      stderr: '',
    }),
  });

  const stale = await jobsShow('job_stale', { cwd: repoRoot });
  assert.equal(stale.status, 'failed');
  assert.equal(result.finalized.status, 'completed');
});

test('runnerOnce skips when another repo job is already running', async () => {
  const repoRoot = await createTempRepo();
  const jobsState = await loadJobsState(repoRoot);
  jobsState.jobs.push(createJobRecord({
    jobId: 'job_running',
    runId: 'run_running',
    source: 'queue',
    status: 'running',
    prompt: 'active work',
    createdAt: '2026-04-03T12:00:00.000Z',
    updatedAt: '2026-04-03T12:00:10.000Z',
    startedAt: '2026-04-03T12:00:00.000Z',
    heartbeatAt: '2026-04-03T12:00:30.000Z',
    runnerPid: process.pid,
    completedAt: null,
    exitCode: null,
    costUsd: null,
    errorMessage: null,
    scheduleId: null,
    scheduledForAt: null,
    retriedFromJobId: null,
    repoRoot,
  }));
  await saveJobsState(repoRoot, jobsState);
  await queueAdd('fresh work', { cwd: repoRoot, now: '2026-04-03T12:01:00.000Z' });

  const result = await runnerOnce({ cwd: repoRoot, now: '2026-04-03T12:01:10.000Z' });
  assert.equal(result.claimed, null);
  assert.equal(result.skipped.reason, 'repo_busy');
});

test('late finalize does not resurrect a recovered stale job', async () => {
  const repoRoot = await createTempRepo();
  await queueAdd('inspect planning docs', { cwd: repoRoot, now: '2026-04-03T12:00:00.000Z' });

  let releaseExecution;
  const firstRun = runnerOnce({
    cwd: repoRoot,
    now: '2026-04-03T12:00:00.000Z',
    executeJob: async () => new Promise((resolve) => {
      releaseExecution = resolve;
    }),
  });

  await waitFor(async () => {
    const jobs = await jobsList({ cwd: repoRoot });
    return jobs.some((job) => job.status === 'running');
  });
  await runnerOnce({ cwd: repoRoot, now: '2026-04-03T12:02:00.000Z' });

  releaseExecution({
    command: 'test-runner',
    args: [],
    exitCode: 0,
    stdout: 'completed output',
    stderr: '',
  });

  const finalized = await firstRun;
  const shown = await jobsShow(finalized.claimed.jobId, { cwd: repoRoot });
  assert.equal(shown.status, 'failed');
  assert.match(shown.errorMessage, /stopped before the job finalized cleanly/);
  await assert.rejects(() => fs.readFile(shown.stdoutPath, 'utf8'), /ENOENT/);
});

test('runnerOnce marks the job failed when execution throws', async () => {
  const repoRoot = await createTempRepo();
  const queued = await queueAdd('inspect planning docs', { cwd: repoRoot, now: '2026-04-03T12:00:00.000Z' });

  const result = await runnerOnce({
    cwd: repoRoot,
    now: '2026-04-03T12:05:00.000Z',
    executeJob: async () => {
      throw new Error('runner exploded');
    },
  });

  assert.equal(result.claimed.jobId, queued.jobId);
  assert.equal(result.finalized.status, 'failed');
  assert.equal(result.finalized.exitCode, 1);
  assert.match(result.finalized.errorMessage, /runner exploded/);
});

test('runnerOnce skips execution when repo is not idle', async () => {
  const repoRoot = await createTempRepo();
  await fs.writeFile(path.join(repoRoot, 'recent.txt'), 'busy\n', 'utf8');
  await queueAdd('inspect planning docs', { cwd: repoRoot, now: '2026-04-03T12:00:00.000Z' });

  const config = await loadConfig(repoRoot);
  config.idle.minIdleSeconds = 60;
  await saveConfig(repoRoot, config);

  const result = await runnerOnce({ cwd: repoRoot, now: new Date().toISOString() });
  assert.equal(result.claimed, null);
  assert.equal(result.skipped.reason, 'not_idle');
});

test('runnerOnce skips execution when daily budget is exhausted', async () => {
  const repoRoot = await createTempRepo();
  await queueAdd('inspect planning docs', { cwd: repoRoot, now: '2026-04-03T12:00:00.000Z' });

  const config = await loadConfig(repoRoot);
  config.budgets.perDayUsd = 0;
  await saveConfig(repoRoot, config);

  const result = await runnerOnce({ cwd: repoRoot, now: '2026-04-03T12:05:00.000Z' });
  assert.equal(result.claimed, null);
  assert.equal(result.skipped.reason, 'budget_exhausted');
});

test('runnerOnce skips execution when per-day run budget is exhausted', async () => {
  const repoRoot = await createTempRepo();
  await queueAdd('inspect planning docs', { cwd: repoRoot, now: '2026-04-03T12:00:00.000Z' });

  const config = await loadConfig(repoRoot);
  config.budgets.perDayRuns = 0;
  await saveConfig(repoRoot, config);

  const result = await runnerOnce({ cwd: repoRoot, now: '2026-04-03T12:05:00.000Z' });
  assert.equal(result.claimed, null);
  assert.equal(result.skipped.reason, 'budget_exhausted');
});

test('supervisorOnce ticks cron and runs the queued job', async () => {
  const repoRoot = await createTempRepo();
  await cronAdd('*/5 * * * *', 'check repo health', {
    cwd: repoRoot,
    now: '2026-04-03T12:00:00.000Z',
  });

  const result = await supervisorOnce({
    cwd: repoRoot,
    now: '2026-04-03T12:05:00.000Z',
    executeJob: async ({ prompt }) => ({
      command: 'test-runner',
      args: [prompt],
      exitCode: 0,
      costUsd: 0.12,
      stdout: '{"costUsd":0.12}\n',
      stderr: '',
    }),
  });

  assert.equal(result.tick.enqueued.length, 1);
  assert.equal(result.run.finalized.status, 'completed');

  const shown = await jobsShow(result.run.finalized.jobId, { cwd: repoRoot });
  assert.equal(shown.costUsd, 0.12);
});

test('runnerOnce fails the job when per-run budget is exceeded', async () => {
  const repoRoot = await createTempRepo();
  await queueAdd('inspect planning docs', { cwd: repoRoot, now: '2026-04-03T12:00:00.000Z' });

  const config = await loadConfig(repoRoot);
  config.budgets.perRunUsd = 0.05;
  await saveConfig(repoRoot, config);

  const result = await runnerOnce({
    cwd: repoRoot,
    now: '2026-04-03T12:05:00.000Z',
    executeJob: async ({ prompt }) => ({
      command: 'test-runner',
      args: [prompt],
      exitCode: 0,
      costUsd: 0.12,
      stdout: 'completed output',
      stderr: '',
    }),
  });

  assert.equal(result.finalized.status, 'failed');
  assert.match(result.finalized.errorMessage, /exceeded per-run budget/);
});

test('activityPing updates explicit activity state', async () => {
  const repoRoot = await createTempRepo();
  const ping = await activityPing({ cwd: repoRoot, source: 'test-suite' });
  const shown = await activityShow({ cwd: repoRoot });

  assert.equal(shown.source, 'test-suite');
  assert.equal(shown.lastTouchedAt, ping.lastTouchedAt);
});

test('notificationsList returns unattended runner notifications', async () => {
  const repoRoot = await createTempRepo();
  await queueAdd('inspect planning docs', { cwd: repoRoot, now: '2026-04-03T12:00:00.000Z' });

  await runnerOnce({
    cwd: repoRoot,
    now: '2026-04-03T12:05:00.000Z',
    executeJob: async ({ prompt }) => ({
      command: 'test-runner',
      args: [prompt],
      exitCode: 0,
      stdout: 'completed output',
      stderr: '',
    }),
  });

  const notifications = await notificationsList({ cwd: repoRoot, limit: 10 });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, 'job.completed');
});

test('readDaemonState marks dead running daemons as stale', async () => {
  const repoRoot = await createTempRepo();
  const daemonPath = path.join(repoRoot, '.opencode', 'workers', 'kairos-daemon.json');
  await fs.mkdir(path.dirname(daemonPath), { recursive: true });
  await fs.writeFile(
    daemonPath,
    `${JSON.stringify({ state: 'running', pid: 999999, startedAt: '2026-04-03T12:00:00.000Z', intervalMs: 1000 }, null, 2)}\n`,
    'utf8',
  );

  const state = await readDaemonState({ cwd: repoRoot });
  assert.equal(state.state, 'stale');
});

test('readDaemonState does not mark a daemon hung while a job heartbeat is fresh', async () => {
  const repoRoot = await createTempRepo();
  const workersDir = path.join(repoRoot, '.opencode', 'workers');
  await fs.mkdir(workersDir, { recursive: true });
  await fs.writeFile(
    path.join(workersDir, 'kairos-daemon.lock'),
    `${JSON.stringify({ token: 'daemon-token', pid: process.pid, createdAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );
  await fs.writeFile(
    path.join(workersDir, 'kairos-daemon.json'),
    `${JSON.stringify({ state: 'running', daemonToken: 'daemon-token', pid: process.pid, startedAt: '2026-04-03T12:00:00.000Z', lastCycleAt: '2026-04-03T12:00:00.000Z', intervalMs: 1000 }, null, 2)}\n`,
    'utf8',
  );

  const jobsState = await loadJobsState(repoRoot);
  jobsState.jobs.push(createJobRecord({
    jobId: 'job_active',
    runId: 'run_active',
    source: 'queue',
    status: 'running',
    prompt: 'active work',
    createdAt: '2026-04-03T12:00:00.000Z',
    updatedAt: new Date().toISOString(),
    startedAt: '2026-04-03T12:00:00.000Z',
    heartbeatAt: new Date().toISOString(),
    runnerPid: process.pid,
    completedAt: null,
    exitCode: null,
    costUsd: null,
    errorMessage: null,
    scheduleId: null,
    scheduledForAt: null,
    retriedFromJobId: null,
    repoRoot,
  }));
  await saveJobsState(repoRoot, jobsState);

  const state = await readDaemonState({ cwd: repoRoot });
  assert.equal(state.state, 'running');
  assert.equal(state.activeJobId, 'job_active');
});

test('supervisorLoop runs the requested number of cycles', async () => {
  const repoRoot = await createTempRepo();
  const result = await supervisorLoop({ cwd: repoRoot, cycles: 2, intervalMs: 0, force: true });

  assert.equal(result.results.length, 2);
});

test('readDaemonState reports stopped when no daemon state exists', async () => {
  const repoRoot = await createTempRepo();
  const state = await readDaemonState({ cwd: repoRoot });

  assert.equal(state.running, false);
  assert.equal(state.state, 'stopped');
});

async function waitFor(check) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await check()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error('Timed out waiting for condition.');
}
