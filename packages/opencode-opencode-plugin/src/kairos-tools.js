import { tool } from '@opencode-ai/plugin';
import { runCli, buildArgs } from './cli.js';

export const queueAdd = tool({
  description: 'Add a prompt to the Kairos job queue for unattended execution by the supervisor/daemon.',
  args: {
    prompt: tool.schema.string(),
  },
  async execute({ prompt }) {
    const output = await runCli('kairos', ['/queue', 'add', prompt]);
    return output;
  },
});

export const queueList = tool({
  description: 'List all queued jobs waiting for the supervisor.',
  args: {},
  async execute() {
    const output = await runCli('kairos', ['/queue', 'list']);
    return output;
  },
});

export const queueCancel = tool({
  description: 'Cancel a queued job by ID.',
  args: {
    id: tool.schema.string(),
  },
  async execute({ id }) {
    const output = await runCli('kairos', ['/queue', 'cancel', id]);
    return output;
  },
});

export const jobsList = tool({
  description: 'List all jobs (queued, running, completed, failed).',
  args: {},
  async execute() {
    const output = await runCli('kairos', ['/jobs']);
    return output;
  },
});

export const jobsShow = tool({
  description: 'Show detailed status of a specific job.',
  args: {
    id: tool.schema.string(),
  },
  async execute({ id }) {
    const output = await runCli('kairos', ['/jobs', 'show', id]);
    return output;
  },
});

export const jobsRetry = tool({
  description: 'Retry a failed job.',
  args: {
    id: tool.schema.string(),
  },
  async execute({ id }) {
    const output = await runCli('kairos', ['/jobs', 'retry', id]);
    return output;
  },
});

export const cronAdd = tool({
  description: 'Add a recurring cron job. Schedule uses standard cron syntax (e.g. "*/30 * * * *" or "@daily").',
  args: {
    schedule: tool.schema.string(),
    prompt: tool.schema.string(),
  },
  async execute({ schedule, prompt }) {
    const output = await runCli('kairos', ['/cron', 'add', schedule, prompt]);
    return output;
  },
});

export const cronList = tool({
  description: 'List all scheduled cron jobs.',
  args: {},
  async execute() {
    const output = await runCli('kairos', ['/cron', 'list']);
    return output;
  },
});

export const cronRemove = tool({
  description: 'Remove a cron schedule by ID.',
  args: {
    id: tool.schema.string(),
  },
  async execute({ id }) {
    const output = await runCli('kairos', ['/cron', 'remove', id]);
    return output;
  },
});

export const cronTick = tool({
  description: 'Manually trigger the cron scheduler to materialize due jobs.',
  args: {},
  async execute() {
    const output = await runCli('kairos', ['/cron', 'tick']);
    return output;
  },
});

export const daemonStatus = tool({
  description: 'Check whether the Kairos daemon is running.',
  args: {},
  async execute() {
    const output = await runCli('kairos', ['daemon', 'status']);
    return output;
  },
});

export const notificationsList = tool({
  description: 'List recent unattended notifications.',
  args: {
    limit: tool.schema.string().optional(),
  },
  async execute({ limit }) {
    const args = limit ? ['notifications', 'list', limit] : ['notifications', 'list'];
    const output = await runCli('kairos', args);
    return output;
  },
});

export const runnerOnce = tool({
  description: 'Run one pending job immediately (bypasses idle check with --force).',
  args: {
    force: tool.schema.boolean().optional(),
  },
  async execute({ force }) {
    const args = force ? ['runner', 'once', '--force'] : ['runner', 'once'];
    const output = await runCli('kairos', args);
    return output;
  },
});

export const supervisorOnce = tool({
  description: 'Run one supervisor cycle (materializes due crons, then runs one job).',
  args: {
    force: tool.schema.boolean().optional(),
  },
  async execute({ force }) {
    const args = force ? ['supervisor', 'once', '--force'] : ['supervisor', 'once'];
    const output = await runCli('kairos', args);
    return output;
  },
});
