import { tool } from '@opencode-ai/plugin';
import { runCli } from './cli.js';

export const remoteStatus = tool({
  description: 'Show remote bridge request status — pending approvals, queued jobs, recent events.',
  args: {
    id: tool.schema.string().optional(),
  },
  async execute({ id }) {
    const args = id ? ['/remote', 'status', id] : ['/remote', 'status'];
    const output = await runCli('bridge', args);
    return output;
  },
});

export const remoteEnqueue = tool({
  description: 'Enqueue a remote request — creates an approval-gated job that can be approved via the bridge API or Telegram.',
  args: {
    prompt: tool.schema.string(),
    requestedBy: tool.schema.string().optional(),
    kind: tool.schema.string().optional(),
  },
  async execute({ prompt, requestedBy, kind }) {
    const args = ['/remote', 'enqueue', prompt];
    if (requestedBy) { args.push('--requested-by', requestedBy); }
    if (kind) { args.push('--kind', kind); }
    const output = await runCli('bridge', args);
    return output;
  },
});

export const remoteApprove = tool({
  description: 'Approve a pending remote request and materialize it as a Kairos queue job.',
  args: {
    id: tool.schema.string(),
  },
  async execute({ id }) {
    const output = await runCli('bridge', ['/remote', 'approve', id]);
    return output;
  },
});

export const remoteRevoke = tool({
  description: 'Revoke a pending remote request and cancel it if already queued.',
  args: {
    id: tool.schema.string().optional(),
  },
  async execute({ id }) {
    const args = id ? ['/remote', 'revoke', id] : ['/remote', 'revoke'];
    const output = await runCli('bridge', args);
    return output;
  },
});

export const remoteAuthList = tool({
  description: 'List all bridge API bearer tokens and their expiration status.',
  args: {},
  async execute() {
    const output = await runCli('bridge', ['/remote', 'auth', 'list']);
    return output;
  },
});

export const remoteAuthCreate = tool({
  description: 'Create a new named bridge API bearer token.',
  args: {
    name: tool.schema.string(),
    session: tool.schema.boolean().optional(),
    expiresSeconds: tool.schema.number().int().positive().optional(),
  },
  async execute({ name, session, expiresSeconds }) {
    const args = ['/remote', 'auth', 'create', name];
    if (session) { args.push('--session'); }
    if (expiresSeconds) { args.push('--expires-seconds', String(expiresSeconds)); }
    const output = await runCli('bridge', args);
    return output;
  },
});

export const remoteAuthRevoke = tool({
  description: 'Revoke a bridge API token by ID.',
  args: {
    tokenId: tool.schema.string(),
  },
  async execute({ tokenId }) {
    const output = await runCli('bridge', ['/remote', 'auth', 'revoke', tokenId]);
    return output;
  },
});

export const telegramSync = tool({
  description: 'Poll Telegram for new bot updates and relay bridge commands.',
  args: {
    limit: tool.schema.string().optional(),
  },
  async execute({ limit }) {
    const args = limit ? ['telegram', 'sync', limit] : ['telegram', 'sync'];
    const output = await runCli('bridge', args);
    return output;
  },
});
