#!/usr/bin/env node

import {
  cronAdd,
  cronList,
  cronRemove,
  cronTick,
  getStatePaths,
  jobsList,
  jobsRetry,
  jobsShow,
  queueAdd,
  queueCancel,
  queueList,
  runnerOnce,
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
    case 'runner':
      await runRunner(subcommand);
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

async function runRunner(subcommand) {
  switch (subcommand) {
    case 'once': {
      const result = await runnerOnce();
      if (!result.claimed) {
        printHeader('Runner found no queued jobs');
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
      throw new Error('Usage: runner once');
  }
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
  console.log('  runner once');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
