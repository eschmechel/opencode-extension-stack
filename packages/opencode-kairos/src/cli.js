#!/usr/bin/env node

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const START_LOCK_STALE_AFTER_MS = 60_000;

import {
  activityPing,
  activityShow,
  clearDaemonStopSignal,
  cronAdd,
  cronList,
  cronRemove,
  cronTick,
  getDaemonFiles,
  getStatePaths,
  jobsList,
  jobsRetry,
  jobsShow,
  notificationsList,
  queueAdd,
  queueCancel,
  queueList,
  readDaemonState,
  requestDaemonStop,
  runnerOnce,
  shouldDaemonStop,
  supervisorLoop,
  supervisorOnce,
  writeDaemonState,
} from './index.js';

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === '--') {
    args.shift();
  }

  if (args.length === 0) {
    printHelp();
    return;
  }

  const command = stripSlash(args[0]);
  const subcommand = args[1];

  switch (command) {
    case 'queue':
      await runQueue(subcommand, args.slice(2));
      return;
    case 'jobs':
      await runJobs(subcommand, args.slice(2));
      return;
    case 'cron':
      await runCron(subcommand, args.slice(2));
      return;
    case 'paths':
      await runPaths();
      return;
    case 'activity':
      await runActivity(subcommand, args.slice(2));
      return;
    case 'notifications':
      await runNotifications(subcommand, args.slice(2));
      return;
    case 'runner':
      await runRunner(subcommand, args.slice(2));
      return;
    case 'supervisor':
      await runSupervisor(subcommand, args.slice(2));
      return;
    case 'daemon':
      await runDaemon(subcommand, args.slice(2));
      return;
    case 'help':
      printHelp();
      return;
    default:
      throw new Error(`Unknown command: ${args[0]}`);
  }
}

async function runQueue(subcommand, args) {
  switch (subcommand) {
    case 'add': {
      const prompt = args.join(' ').trim();
      const job = await queueAdd(prompt);
      printHeader(`Queued ${job.jobId}`);
      printKeyValue('status', job.status);
      printKeyValue('source', job.source);
      printKeyValue('run', job.runId);
      printKeyValue('created', job.createdAt);
      printKeyValue('log', job.runLogPath);
      printKeyValue('prompt', job.prompt);
      return;
    }
    case 'list': {
      const jobs = await queueList();
      printJobs('Queued jobs', jobs);
      return;
    }
    case 'cancel': {
      const jobId = args[0] ?? '';
      const job = await queueCancel(jobId);
      printHeader(`Cancelled ${job.jobId}`);
      printKeyValue('status', job.status);
      printKeyValue('updated', job.updatedAt);
      printKeyValue('log', job.runLogPath);
      return;
    }
    default:
      throw new Error('Usage: /queue add <prompt> | /queue list | /queue cancel <id>');
  }
}

async function runJobs(subcommand, args) {
  switch (subcommand) {
    case undefined: {
      const jobs = await jobsList();
      printJobs('All jobs', jobs);
      return;
    }
    case 'show': {
      const jobId = args[0] ?? '';
      const job = await jobsShow(jobId);
      printHeader(`Job ${job.jobId}`);
      printKeyValue('status', job.status);
      printKeyValue('source', job.source);
      printKeyValue('run', job.runId);
      printKeyValue('created', job.createdAt);
      printKeyValue('updated', job.updatedAt);
      if (job.startedAt) {
        printKeyValue('started', job.startedAt);
      }
      if (job.completedAt) {
        printKeyValue('completed', job.completedAt);
      }
      if (job.exitCode !== null && job.exitCode !== undefined) {
        printKeyValue('exit code', job.exitCode);
      }
      if (job.costUsd !== null && job.costUsd !== undefined) {
        printKeyValue('cost usd', job.costUsd);
      }
      if (job.errorMessage) {
        printKeyValue('error', job.errorMessage);
      }
      printKeyValue('prompt', job.prompt);
      printKeyValue('log', job.runLogPath);
      printKeyValue('stdout', job.stdoutPath);
      printKeyValue('stderr', job.stderrPath);
      printKeyValue('result', job.resultPath);
      if (job.scheduleId) {
        printKeyValue('schedule', job.scheduleId);
      }
      if (job.retriedFromJobId) {
        printKeyValue('retried from', job.retriedFromJobId);
      }
      return;
    }
    case 'retry': {
      const jobId = args[0] ?? '';
      const job = await jobsRetry(jobId);
      printHeader(`Retried ${job.jobId}`);
      printKeyValue('status', job.status);
      printKeyValue('source', job.source);
      printKeyValue('attempt', job.attempt);
      printKeyValue('retried from', job.retriedFromJobId);
      printKeyValue('log', job.runLogPath);
      return;
    }
    default:
      throw new Error('Usage: /jobs | /jobs show <id> | /jobs retry <id>');
  }
}

async function runCron(subcommand, args) {
  switch (subcommand) {
    case 'add': {
      if (args.length < 2) {
        throw new Error('Usage: /cron add <schedule> <prompt>');
      }

      const [schedule, ...promptParts] = args;
      const entry = await cronAdd(schedule, promptParts.join(' '));
      printHeader(`Scheduled ${entry.cronId}`);
      printKeyValue('schedule', entry.schedule);
      printKeyValue('next run', entry.nextRunAt);
      printKeyValue('created', entry.createdAt);
      printKeyValue('prompt', entry.prompt);
      return;
    }
    case 'list': {
      const entries = await cronList();
      printSchedules(entries);
      return;
    }
    case 'remove': {
      const cronId = args[0] ?? '';
      const entry = await cronRemove(cronId);
      printHeader(`Removed ${entry.cronId}`);
      printKeyValue('schedule', entry.schedule);
      printKeyValue('prompt', entry.prompt);
      return;
    }
    case 'tick': {
      const result = await cronTick();
      printHeader(`Cron tick at ${result.tickedAt}`);
      if (result.enqueued.length === 0) {
        console.log(result.skipped.length === 0 ? 'No due schedules.' : 'No jobs enqueued. Active runs caused overlap skips.');
        if (result.skipped.length > 0) {
          console.log(`Skipped schedules: ${result.skipped.join(', ')}`);
        }
        return;
      }

      printJobs('Enqueued jobs', result.enqueued);
      if (result.skipped.length > 0) {
        console.log(`Skipped schedules: ${result.skipped.join(', ')}`);
      }
      return;
    }
    default:
      throw new Error('Usage: /cron add <schedule> <prompt> | /cron list | /cron remove <id> | /cron tick');
  }
}

async function runPaths() {
  const paths = await getStatePaths();
  printHeader('State paths');
  for (const [label, value] of Object.entries(paths)) {
    printKeyValue(label, value);
  }
}

async function runActivity(subcommand, args) {
  switch (subcommand) {
    case 'ping': {
      const source = args[0] ?? 'manual';
      const result = await activityPing({ source });
      printHeader('Activity updated');
      printKeyValue('source', result.source);
      printKeyValue('last touched', result.lastTouchedAt);
      return;
    }
    case 'show': {
      const activity = await activityShow();
      printHeader('Activity state');
      printKeyValue('source', activity.source);
      printKeyValue('last touched', activity.lastTouchedAt);
      return;
    }
    default:
      throw new Error('Usage: activity ping [source] | activity show');
  }
}

async function runNotifications(subcommand, args) {
  switch (subcommand) {
    case 'list': {
      const limit = args[0] ? Number(args[0]) : 20;
      const entries = await notificationsList({ limit });
      printHeader(`Notifications (${entries.length})`);
      if (entries.length === 0) {
        console.log('None.');
        return;
      }

      for (const entry of entries) {
        console.log(`- ${entry.createdAt} [${entry.level}] ${entry.type}`);
        console.log(`  title: ${entry.title}`);
        console.log(`  body: ${entry.body}`);
      }
      return;
    }
    default:
      throw new Error('Usage: notifications list [limit]');
  }
}

async function runRunner(subcommand, args) {
  const force = args.includes('--force');

  switch (subcommand) {
    case 'once': {
      const result = await runnerOnce({ force });
      if (!result.claimed) {
        printRunnerSkipped(result.skipped, 'Runner found no queued jobs');
        return;
      }

      printHeader(`Runner executed ${result.finalized.jobId}`);
      printKeyValue('status', result.finalized.status);
      printKeyValue('exit code', result.finalized.exitCode);
      printKeyValue('stdout', result.finalized.stdoutPath);
      printKeyValue('stderr', result.finalized.stderrPath);
      printKeyValue('result', result.finalized.resultPath);
      return;
    }
    default:
      throw new Error('Usage: runner once [--force]');
  }
}

async function runSupervisor(subcommand, args) {
  const force = args.includes('--force');
  const positional = args.filter((value) => !value.startsWith('--'));

  switch (subcommand) {
    case 'once': {
      const result = await supervisorOnce({ force });
      printHeader(`Supervisor ticked at ${result.tick.tickedAt}`);
      printKeyValue('cron enqueued', result.tick.enqueued.length);
      printKeyValue('cron skipped', result.tick.skipped.length);

      if (!result.run.claimed) {
        printRunnerSkipped(result.run.skipped, 'Supervisor found no runnable jobs');
        return;
      }

      printKeyValue('job', result.run.finalized.jobId);
      printKeyValue('status', result.run.finalized.status);
      printKeyValue('exit code', result.run.finalized.exitCode);
      return;
    }
    case 'loop': {
      const cycles = positional[0] ? Number(positional[0]) : 1;
      const intervalMs = positional[1] ? Number(positional[1]) : 1000;
      const result = await supervisorLoop({ cycles, intervalMs, force });
      printHeader(`Supervisor loop finished`);
      printKeyValue('cycles', result.cycles);
      printKeyValue('interval ms', result.intervalMs);
      printKeyValue('runs attempted', result.results.length);
      return;
    }
    default:
      throw new Error('Usage: supervisor once [--force] | supervisor loop [cycles] [intervalMs] [--force]');
  }
}

async function runDaemon(subcommand, args) {
  const force = args.includes('--force');
  const positional = args.filter((value) => !value.startsWith('--'));

  switch (subcommand) {
    case 'start': {
      const intervalMs = positional[0] ? Number(positional[0]) : 5000;
      assertIntervalMs(intervalMs);
      const state = await readDaemonState();
      if (state.running) {
        printHeader('Daemon already running');
        printKeyValue('pid', state.pid);
        return;
      }

      const paths = await getStatePaths();
      const repoRoot = path.dirname(paths.root);
      const files = getDaemonFiles(repoRoot);
      const startLockPath = `${files.statePath}.start.lock`;
      const startLock = acquireStartLockSync(startLockPath);

      const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));
      const logFd = fs.openSync(files.logPath, 'a');

      try {
        const child = spawn(process.execPath, [cliPath, '--', 'daemon', 'run', String(intervalMs), ...(force ? ['--force'] : [])], {
          detached: true,
          stdio: ['ignore', logFd, logFd],
        });
        child.unref();
        await writeDaemonState(repoRoot, {
          state: 'starting',
          pid: child.pid,
          startedAt: new Date().toISOString(),
          intervalMs,
          force,
        });

        printHeader('Daemon started');
        printKeyValue('pid', child.pid);
        printKeyValue('interval ms', intervalMs);
        printKeyValue('log', files.logPath);
        return;
      } finally {
        fs.closeSync(logFd);
        releaseStartLockSync(startLockPath, startLock.token);
      }
    }
    case 'run': {
      const intervalMs = positional[0] ? Number(positional[0]) : 5000;
      assertIntervalMs(intervalMs);
      await runDaemonLoop({ intervalMs, force });
      return;
    }
    case 'stop': {
      const state = await readDaemonState();
      if (!state.running) {
        printHeader('Daemon is not running');
        return;
      }

      await requestDaemonStop(state.repoRoot);
      printHeader('Daemon stop requested');
      printKeyValue('pid', state.pid);
      return;
    }
    case 'status': {
      const state = await readDaemonState();
      printHeader('Daemon status');
      printKeyValue('state', state.state);
      printKeyValue('running', state.running);
      if (state.stopRequested !== undefined) {
        printKeyValue('stop requested', state.stopRequested);
      }
      if (state.pid) {
        printKeyValue('pid', state.pid);
      }
      if (state.activeJobId) {
        printKeyValue('active job', state.activeJobId);
      }
      printKeyValue('log', state.logPath);
      if (state.lastError) {
        printKeyValue('last error', state.lastError);
      }
      if (state.lastCycleAt) {
        printKeyValue('last cycle', state.lastCycleAt);
      }
      return;
    }
    default:
      throw new Error('Usage: daemon start [intervalMs] [--force] | daemon run [intervalMs] [--force] | daemon stop | daemon status');
  }
}

async function runDaemonLoop(options) {
  const paths = await getStatePaths();
  const repoRoot = path.dirname(paths.root);
  const startedAt = new Date().toISOString();
  const files = getDaemonFiles(repoRoot);
  const ownerLock = acquireFileLockSync(files.lockPath, 'Daemon is already running.');
  let shuttingDown = false;

  try {
    await clearDaemonStopSignal(repoRoot);
    await writeDaemonState(repoRoot, {
      state: 'running',
      daemonToken: ownerLock.token,
      pid: process.pid,
      startedAt,
      intervalMs: options.intervalMs,
      force: options.force,
    });

    const stop = async (state = 'stopped', extra = {}) => {
      await writeDaemonState(repoRoot, {
        state,
        daemonToken: ownerLock.token,
        pid: process.pid,
        startedAt,
        stoppedAt: new Date().toISOString(),
        intervalMs: options.intervalMs,
        force: options.force,
        ...extra,
      });
    };

    process.on('SIGTERM', () => {
      shuttingDown = true;
    });
    process.on('SIGINT', () => {
      shuttingDown = true;
    });

    while (!shuttingDown && !(await shouldDaemonStop(repoRoot))) {
      const result = await supervisorOnce({ force: options.force });
      await writeDaemonState(repoRoot, {
        state: 'running',
        daemonToken: ownerLock.token,
        pid: process.pid,
        startedAt,
        lastCycleAt: new Date().toISOString(),
        intervalMs: options.intervalMs,
        force: options.force,
        lastJobId: result.run.finalized?.jobId ?? null,
        lastJobStatus: result.run.finalized?.status ?? null,
      });
      if (!shuttingDown && !(await shouldDaemonStop(repoRoot))) {
        await sleep(options.intervalMs);
      }
    }
    await stop();
  } catch (error) {
    await writeDaemonState(repoRoot, {
      state: 'failed',
      daemonToken: ownerLock.token,
      pid: process.pid,
      startedAt,
      stoppedAt: new Date().toISOString(),
      intervalMs: options.intervalMs,
      force: options.force,
      lastError: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    releaseFileLockSync(files.lockPath, ownerLock.token);
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function acquireStartLockSync(lockPath) {
  return acquireFileLockSync(lockPath, 'Daemon start is already in progress.');
}

function releaseStartLockSync(lockPath, token) {
  releaseFileLockSync(lockPath, token);
}

function acquireFileLockSync(lockPath, errorMessage) {
  const token = crypto.randomUUID();
  const payload = JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() }, null, 2) + '\n';

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lockPath, payload, { flag: 'wx' });
      return { token };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        throw error;
      }

      if (!clearStaleStartLockSync(lockPath)) {
        throw new Error(errorMessage);
      }
    }
  }

  throw new Error(errorMessage);
}

function releaseFileLockSync(lockPath, token) {
  try {
    const content = fs.readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(content);
    if (parsed?.token !== token) {
      return;
    }

    fs.rmSync(lockPath, { force: true });
  } catch {
    // Ignore cleanup failures.
  }
}

function clearStaleStartLockSync(lockPath) {
  try {
    const stats = fs.statSync(lockPath);
    const ageMs = Math.max(0, Date.now() - stats.mtimeMs);
    const content = fs.readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(content);
    if (parsed?.pid && isProcessAlive(parsed.pid)) {
      return false;
    }

    fs.rmSync(lockPath, { force: true });
    return true;
  } catch {
    try {
      const stats = fs.statSync(lockPath);
      const ageMs = Math.max(0, Date.now() - stats.mtimeMs);
      if (ageMs <= START_LOCK_STALE_AFTER_MS) {
        return false;
      }

      fs.rmSync(lockPath, { force: true });
      return true;
    } catch {
      return true;
    }
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function assertIntervalMs(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('intervalMs must be a non-negative integer.');
  }
}

function printRunnerSkipped(skipped, emptyMessage) {
  if (!skipped) {
    printHeader(emptyMessage);
    return;
  }

  if (skipped.reason === 'not_idle') {
    printHeader('Runner skipped because repo is not idle');
    if (skipped.idleState?.latestActivityAt) {
      printKeyValue('latest activity', skipped.idleState.latestActivityAt);
    }
    if (skipped.idleState?.idleSeconds !== null && skipped.idleState?.idleSeconds !== undefined) {
      printKeyValue('idle seconds', skipped.idleState.idleSeconds);
    }
    return;
  }

  if (skipped.reason === 'budget_exhausted') {
    printHeader('Runner skipped because daily budget is exhausted');
    if (skipped.budgetState.perDayUsd !== null) {
      printKeyValue('spent today usd', skipped.budgetState.spentTodayUsd);
      printKeyValue('per-day usd', skipped.budgetState.perDayUsd);
    }
    if (skipped.budgetState.perDayRuns !== null) {
      printKeyValue('runs today', skipped.budgetState.runsStartedToday);
      printKeyValue('per-day runs', skipped.budgetState.perDayRuns);
    }
    return;
  }

  if (skipped.reason === 'repo_busy') {
    printHeader('Runner skipped because another repo job is already running');
    if (skipped.activeJobId) {
      printKeyValue('active job', skipped.activeJobId);
    }
    return;
  }

  printHeader(emptyMessage);
}

function printJobs(title, jobs) {
  printHeader(`${title} (${jobs.length})`);

  if (jobs.length === 0) {
    console.log('None.');
    return;
  }

  for (const job of jobs) {
    console.log(`- ${job.jobId} [${job.status}] ${job.source} ${job.createdAt}`);
    console.log(`  prompt: ${job.prompt}`);
    if (job.scheduleId) {
      console.log(`  schedule: ${job.scheduleId}`);
    }
  }
}

function printSchedules(entries) {
  printHeader(`Schedules (${entries.length})`);

  if (entries.length === 0) {
    console.log('None.');
    return;
  }

  for (const entry of entries) {
    console.log(`- ${entry.cronId} [${entry.enabled ? 'enabled' : 'disabled'}] ${entry.schedule}`);
    console.log(`  next: ${entry.nextRunAt}`);
    console.log(`  runs: ${entry.runCount}`);
    console.log(`  prompt: ${entry.prompt}`);
  }
}

function printHeader(value) {
  console.log(value);
}

function printKeyValue(key, value) {
  console.log(`${key}: ${value}`);
}

function stripSlash(value) {
  return value.startsWith('/') ? value.slice(1) : value;
}

function printHelp() {
  console.log('OpenCode Kairos');
  console.log('');
  console.log('Commands:');
  console.log('  /queue add <prompt>');
  console.log('  /queue list');
  console.log('  /queue cancel <id>');
  console.log('  /jobs');
  console.log('  /jobs show <id>');
  console.log('  /jobs retry <id>');
  console.log('  /cron add <schedule> <prompt>');
  console.log('  /cron list');
  console.log('  /cron remove <id>');
  console.log('  /cron tick');
  console.log('  activity ping [source]');
  console.log('  activity show');
  console.log('  notifications list [limit]');
  console.log('  runner once [--force]');
  console.log('  supervisor once [--force]');
  console.log('  supervisor loop [cycles] [intervalMs] [--force]');
  console.log('  daemon start [intervalMs] [--force]');
  console.log('  daemon run [intervalMs] [--force]');
  console.log('  daemon stop');
  console.log('  daemon status');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
