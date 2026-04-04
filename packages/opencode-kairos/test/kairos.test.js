import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  cronAdd,
  cronList,
  cronRemove,
  cronTick,
  jobsList,
  jobsRetry,
  jobsShow,
  queueAdd,
  queueCancel,
  queueList,
  runnerOnce,
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
