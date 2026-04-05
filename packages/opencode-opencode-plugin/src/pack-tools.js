import { tool } from '@opencode-ai/plugin';
import { runCli } from './cli.js';

export const packsList = tool({
  description: 'List all available prompt packs.',
  args: {},
  async execute() {
    const output = await runCli('packs', ['/packs', 'list']);
    return output;
  },
});

export const packsShow = tool({
  description: 'Show full details of a pack including metadata, model defaults, and examples.',
  args: {
    pack: tool.schema.string(),
  },
  async execute({ pack }) {
    const output = await runCli('packs', ['/packs', 'show', pack]);
    return output;
  },
});

export const packsExamples = tool({
  description: 'Show curated sample payloads for a pack.',
  args: {
    pack: tool.schema.string(),
  },
  async execute({ pack }) {
    const output = await runCli('packs', ['/packs', 'examples', pack]);
    return output;
  },
});

export const packsContract = tool({
  description: 'Show the machine-readable JSON output contract for a pack.',
  args: {
    pack: tool.schema.string(),
  },
  async execute({ pack }) {
    const output = await runCli('packs', ['/packs', 'contract', pack]);
    return output;
  },
});

export const packsRender = tool({
  description: 'Render a pack template with a request and optional context/constraints.',
  args: {
    pack: tool.schema.string(),
    request: tool.schema.string(),
    context: tool.schema.string().optional(),
    constraint: tool.schema.string().optional(),
    json: tool.schema.boolean().optional(),
  },
  async execute({ pack, request, context, constraint, json }) {
    const args = ['/packs', 'render', pack, request];
    if (context) { args.push('--context', context); }
    if (constraint) { args.push('--constraint', constraint); }
    if (json) { args.push('--json'); }
    const output = await runCli('packs', args);
    return output;
  },
});

export const packsExecute = tool({
  description: 'Execute a pack and prepare a durable invocation packet for local or remote handoff.',
  args: {
    pack: tool.schema.string(),
    request: tool.schema.string(),
    context: tool.schema.string().optional(),
    constraint: tool.schema.string().optional(),
    channel: tool.schema.string().optional(),
    json: tool.schema.boolean().optional(),
  },
  async execute({ pack, request, context, constraint, channel, json }) {
    const args = ['/packs', 'execute', pack, request];
    if (context) { args.push('--context', context); }
    if (constraint) { args.push('--constraint', constraint); }
    if (channel) { args.push('--channel', channel); }
    if (json) { args.push('--json'); }
    const output = await runCli('packs', args);
    return output;
  },
});

export const packsComplete = tool({
  description: 'Complete a pack invocation by providing output (JSON or file) and validating against the contract.',
  args: {
    invocationId: tool.schema.string(),
    outputJson: tool.schema.string().optional(),
    outputFile: tool.schema.string().optional(),
    json: tool.schema.boolean().optional(),
  },
  async execute({ invocationId, outputJson, outputFile, json }) {
    const args = ['/packs', 'complete', invocationId];
    if (outputJson) { args.push('--output-json', outputJson); }
    if (outputFile) { args.push('--output-file', outputFile); }
    if (json) { args.push('--json'); }
    const output = await runCli('packs', args);
    return output;
  },
});

export const packsInvocation = tool({
  description: 'Inspect a pack invocation packet by ID.',
  args: {
    invocationId: tool.schema.string(),
  },
  async execute({ invocationId }) {
    const output = await runCli('packs', ['/packs', 'invocation', invocationId]);
    return output;
  },
});

export const packsHistory = tool({
  description: 'Show pack invocation history, optionally filtered by pack name or action.',
  args: {
    limit: tool.schema.string().optional(),
    pack: tool.schema.string().optional(),
    action: tool.schema.string().optional(),
  },
  async execute({ limit, pack, action }) {
    const args = ['/packs', 'history'];
    if (limit) { args.push(limit); }
    if (pack) { args.push('--pack', pack); }
    if (action) { args.push('--action', action); }
    const output = await runCli('packs', args);
    return output;
  },
});

export const packsValidate = tool({
  description: 'Validate a JSON output payload against a pack output contract.',
  args: {
    pack: tool.schema.string(),
    json: tool.schema.string(),
  },
  async execute({ pack, json }) {
    const output = await runCli('packs', ['/packs', 'validate', pack, json]);
    return output;
  },
});

export const ultraplan = tool({
  description: 'Render the ultraplan pack — a planning prompt focused on assumptions, steps, and validation criteria.',
  args: {
    request: tool.schema.string(),
  },
  async execute({ request }) {
    const output = await runCli('packs', ['/ultraplan', request]);
    return output;
  },
});

export const reviewPack = tool({
  description: 'Render the review pack — findings-first review aligned with the repo review style.',
  args: {
    request: tool.schema.string(),
  },
  async execute({ request }) {
    const output = await runCli('packs', ['/review', request]);
    return output;
  },
});

export const reviewRemote = tool({
  description: 'Render the review-remote pack — async approval/handoff review for remote workflows.',
  args: {
    request: tool.schema.string(),
  },
  async execute({ request }) {
    const output = await runCli('packs', ['/review-remote', request]);
    return output;
  },
});

export const triage = tool({
  description: 'Render the triage pack — classifies incoming work by category, priority, and next actions.',
  args: {
    request: tool.schema.string(),
  },
  async execute({ request }) {
    const output = await runCli('packs', ['/triage', request]);
    return output;
  },
});

export const handoff = tool({
  description: 'Render the handoff pack — prepares a concise continuation packet for another human or agent.',
  args: {
    request: tool.schema.string(),
  },
  async execute({ request }) {
    const output = await runCli('packs', ['/handoff', request]);
    return output;
  },
});
