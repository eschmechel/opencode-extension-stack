import { tool } from '@opencode-ai/plugin';
import { runCli } from './cli.js';

export const workerStart = tool({
  description: 'Start a detached worker that executes prompts in the background.',
  args: {
    prompt: tool.schema.string(),
  },
  async execute({ prompt }) {
    const output = await runCli('orchestrator', ['/worker', 'start', prompt]);
    return output;
  },
});

export const workerList = tool({
  description: 'List all workers (running, stopped, failed) with their current status.',
  args: {},
  async execute() {
    const output = await runCli('orchestrator', ['/worker', 'list']);
    return output;
  },
});

export const workerShow = tool({
  description: 'Show detailed status and recent events for a worker.',
  args: {
    id: tool.schema.string(),
  },
  async execute({ id }) {
    const output = await runCli('orchestrator', ['/worker', 'show', id]);
    return output;
  },
});

export const workerStop = tool({
  description: 'Stop a running or stuck worker.',
  args: {
    id: tool.schema.string(),
  },
  async execute({ id }) {
    const output = await runCli('orchestrator', ['/worker', 'stop', id]);
    return output;
  },
});

export const workerRestart = tool({
  description: 'Restart a stopped or failed worker with its existing control history.',
  args: {
    id: tool.schema.string(),
  },
  async execute({ id }) {
    const output = await runCli('orchestrator', ['/worker', 'restart', id]);
    return output;
  },
});

export const workerSteer = tool({
  description: 'Send a follow-up steering message to a running worker.',
  args: {
    id: tool.schema.string(),
    message: tool.schema.string(),
  },
  async execute({ id, message }) {
    const output = await runCli('orchestrator', ['/worker', 'steer', id, message]);
    return output;
  },
});

export const workerArchive = tool({
  description: 'Archive a worker before pruning — preserves state for audit before deletion.',
  args: {
    id: tool.schema.string(),
  },
  async execute({ id }) {
    const output = await runCli('orchestrator', ['/worker', 'archive', id]);
    return output;
  },
});

export const workerPrune = tool({
  description: 'Delete a worker and all its artifacts. Archive first to preserve audit trail.',
  args: {
    id: tool.schema.string(),
  },
  async execute({ id }) {
    const output = await runCli('orchestrator', ['/worker', 'prune', id]);
    return output;
  },
});

export const teamCreate = tool({
  description: 'Create a team of workers that execute a prompt in parallel fanout.',
  args: {
    count: tool.schema.number().int().positive(),
    prompt: tool.schema.string(),
    maxConcurrency: tool.schema.number().int().positive().optional(),
    maxTotalRuns: tool.schema.number().int().positive().optional(),
  },
  async execute({ count, prompt, maxConcurrency, maxTotalRuns }) {
    const args = ['/team', 'create', String(count), prompt];
    if (maxConcurrency) { args.push('--max-concurrency', String(maxConcurrency)); }
    if (maxTotalRuns) { args.push('--max-total-runs', String(maxTotalRuns)); }
    const output = await runCli('orchestrator', args);
    return output;
  },
});

export const teamCreateFromTemplate = tool({
  description: 'Create a team from a saved template.',
  args: {
    name: tool.schema.string(),
    promptOverride: tool.schema.string().optional(),
  },
  async execute({ name, promptOverride }) {
    const args = ['/team', 'create', '--template', name];
    if (promptOverride) { args.push(promptOverride); }
    const output = await runCli('orchestrator', args);
    return output;
  },
});

export const teamList = tool({
  description: 'List all teams with worker counts and aggregate status.',
  args: {},
  async execute() {
    const output = await runCli('orchestrator', ['/team', 'list']);
    return output;
  },
});

export const teamShow = tool({
  description: 'Show detailed team status, per-worker branches, and memory namespace summary.',
  args: {
    id: tool.schema.string(),
  },
  async execute({ id }) {
    const output = await runCli('orchestrator', ['/team', 'show', id]);
    return output;
  },
});

export const teamArchive = tool({
  description: 'Archive a team and all its workers before pruning.',
  args: {
    id: tool.schema.string(),
  },
  async execute({ id }) {
    const output = await runCli('orchestrator', ['/team', 'archive', id]);
    return output;
  },
});

export const teamPrune = tool({
  description: 'Delete a team and all its workers. Archive first to preserve state.',
  args: {
    id: tool.schema.string(),
  },
  async execute({ id }) {
    const output = await runCli('orchestrator', ['/team', 'prune', id]);
    return output;
  },
});

export const teamDelete = tool({
  description: 'Delete a team and signal all members to shut down.',
  args: {
    id: tool.schema.string(),
  },
  async execute({ id }) {
    const output = await runCli('orchestrator', ['/team', 'delete', id]);
    return output;
  },
});

export const teamRerunFailed = tool({
  description: 'Restart failed team branches and requeue their prompts.',
  args: {
    id: tool.schema.string(),
  },
  async execute({ id }) {
    const output = await runCli('orchestrator', ['/team', 'rerun-failed', id]);
    return output;
  },
});

export const teamTemplateSave = tool({
  description: 'Save the current team configuration as a reusable template.',
  args: {
    name: tool.schema.string(),
    count: tool.schema.number().int().positive(),
    prompt: tool.schema.string(),
    fromTeam: tool.schema.string().optional(),
    maxConcurrency: tool.schema.number().int().positive().optional(),
    maxTotalRuns: tool.schema.number().int().positive().optional(),
  },
  async execute({ name, count, prompt, fromTeam, maxConcurrency, maxTotalRuns }) {
    if (fromTeam) {
      const args = ['/team', 'template', 'save', name, '--from-team', fromTeam];
      const output = await runCli('orchestrator', args);
      return output;
    }
    const args = ['/team', 'template', 'save', name, String(count), prompt];
    if (maxConcurrency) { args.push('--max-concurrency', String(maxConcurrency)); }
    if (maxTotalRuns) { args.push('--max-total-runs', String(maxTotalRuns)); }
    const output = await runCli('orchestrator', args);
    return output;
  },
});

export const teamTemplateList = tool({
  description: 'List all saved team templates.',
  args: {},
  async execute() {
    const output = await runCli('orchestrator', ['/team', 'template', 'list']);
    return output;
  },
});

export const teamTemplateShow = tool({
  description: 'Show a saved team template.',
  args: {
    name: tool.schema.string(),
  },
  async execute({ name }) {
    const output = await runCli('orchestrator', ['/team', 'template', 'show', name]);
    return output;
  },
});

export const teamTemplateDelete = tool({
  description: 'Delete a saved team template.',
  args: {
    name: tool.schema.string(),
  },
  async execute({ name }) {
    const output = await runCli('orchestrator', ['/team', 'template', 'delete', name]);
    return output;
  },
});

export const teamMemory = tool({
  description: 'Run a memory command scoped to a specific team namespace.',
  args: {
    teamId: tool.schema.string(),
    command: tool.schema.string(),
    topic: tool.schema.string().optional(),
    query: tool.schema.string().optional(),
    stale: tool.schema.boolean().optional(),
    repairable: tool.schema.boolean().optional(),
  },
  async execute({ teamId, command, topic, query, stale, repairable }) {
    const args = ['/team', 'memory', teamId, command];
    if (topic) { args.push(topic); }
    if (query) { args.push(query); }
    if (stale) { args.push('--stale'); }
    if (repairable) { args.push('--repairable'); }
    const output = await runCli('orchestrator', args);
    return output;
  },
});

export const parallelRun = tool({
  description: 'Run a prompt in parallel using multiple workers (convenience wrapper over team create).',
  args: {
    count: tool.schema.number().int().positive(),
    prompt: tool.schema.string(),
  },
  async execute({ count, prompt }) {
    const output = await runCli('orchestrator', ['/parallel', String(count), prompt]);
    return output;
  },
});

export const retentionStatus = tool({
  description: 'Show retention policy status — archive counts, bytes used, and prune eligibility.',
  args: {},
  async execute() {
    const output = await runCli('orchestrator', ['retention', 'status']);
    return output;
  },
});

export const retentionApply = tool({
  description: 'Apply retention policy: prune archived artifacts, compact memory, rotate old archives.',
  args: {
    dryRun: tool.schema.boolean().optional(),
  },
  async execute({ dryRun }) {
    const args = dryRun ? ['retention', 'apply', '--dry-run'] : ['retention', 'apply'];
    const output = await runCli('orchestrator', args);
    return output;
  },
});
