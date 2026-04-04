#!/usr/bin/env node

import {
  bridgeServe,
  remoteApprove,
  remoteAuth,
  remoteAuthCreate,
  remoteAuthRevoke,
  remoteAuthRotateDefault,
  remoteEnqueue,
  remoteRevoke,
  remoteStatus,
  telegramSync,
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
    case 'remote':
      await runRemote(subcommand, args.slice(2));
      return;
    case 'telegram':
      await runTelegram(subcommand, args.slice(2));
      return;
    case 'help':
      printHelp();
      return;
    default:
      throw new Error(`Unknown command: ${args[0]}`);
  }
}

async function runRemote(subcommand, args) {
  switch (subcommand) {
    case 'status': {
      const requestId = args[0] ?? '';
      if (requestId) {
        const result = await remoteStatus(requestId);
        const request = result.request;
        printHeader(`Remote ${request.remoteRequestId}`);
        printKeyValue('kind', request.kind);
        printKeyValue('status', request.effectiveStatus);
        printKeyValue('approval required', request.approvalRequired);
        printKeyValue('requested by', request.requestedBy);
        printKeyValue('created', request.createdAt);
        if (request.approvedAt) {
          printKeyValue('approved', request.approvedAt);
        }
        if (request.revokedAt) {
          printKeyValue('revoked', request.revokedAt);
        }
        if (request.jobId) {
          printKeyValue('job', request.jobId);
        }
        if (request.runId) {
          printKeyValue('run', request.runId);
        }
        if (request.packetPack) {
          printKeyValue('packet pack', request.packetPack);
          printKeyValue('packet', request.packetPath);
        }
        printKeyValue('prompt', request.prompt);
        return;
      }

      const result = await remoteStatus();
      printHeader('Remote status');
      printKeyValue('approval required', result.approvalRequired);
      printKeyValue('requests', result.requests.length);
      if (result.truncated) {
        printKeyValue('total requests', result.totalRequests);
      }
      for (const [status, count] of Object.entries(result.counts)) {
        printKeyValue(status, count);
      }
      for (const request of result.requests) {
        console.log(`- ${request.remoteRequestId} ${request.kind} ${request.effectiveStatus}`);
        console.log(`  ${request.prompt}`);
      }
      return;
    }
    case 'auth': {
      await runRemoteAuth(args);
      return;
    }
    case 'enqueue': {
      const parsed = parseEnqueueArgs(args);
      const result = await remoteEnqueue(parsed.prompt, {
        requestedBy: parsed.requestedBy,
        kind: parsed.kind,
      });
      printHeader(`Remote queued ${result.remoteRequestId}`);
      printKeyValue('kind', result.kind);
      printKeyValue('status', result.effectiveStatus);
      printKeyValue('approval required', result.approvalRequired);
      printKeyValue('requested by', result.requestedBy);
      if (result.jobId) {
        printKeyValue('job', result.jobId);
      }
      if (result.packetPack) {
        printKeyValue('packet pack', result.packetPack);
        printKeyValue('packet', result.packetPath);
      }
      printKeyValue('prompt', result.prompt);
      return;
    }
    case 'approve': {
      const remoteRequestId = args[0] ?? '';
      const result = await remoteApprove(remoteRequestId);
      printHeader(`Remote approved ${result.remoteRequestId}`);
      printKeyValue('status', result.effectiveStatus);
      printKeyValue('job', result.jobId);
      printKeyValue('run', result.runId);
      return;
    }
    case 'revoke': {
      const remoteRequestId = args[0] ?? '';
      const result = await remoteRevoke(remoteRequestId);
      printHeader(remoteRequestId ? `Remote revoke ${remoteRequestId}` : 'Remote revoke');
      printKeyValue('revoked', result.revoked.length);
      if (result.revoked.length > 0) {
        console.log(`revoked ids: ${result.revoked.join(', ')}`);
      }
      if (result.skipped.length > 0) {
        for (const entry of result.skipped) {
          console.log(`- skipped ${entry.remoteRequestId}: ${entry.reason}`);
        }
      }
      return;
    }
    case 'serve': {
      const parsed = parseServeArgs(args);
      const server = await bridgeServe({ host: parsed.host, port: parsed.port });
      printHeader('Remote bridge server');
      printKeyValue('base url', server.baseUrl);
      printKeyValue('token', server.apiToken);
      printKeyValue('host', server.host);
      printKeyValue('port', server.port);
      const shutdown = async () => {
        await server.close();
        process.exit(0);
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
      await new Promise(() => {});
      return;
    }
    default:
      throw new Error('Usage: /remote status [id] | /remote auth | /remote enqueue <prompt> | /remote approve <id> | /remote revoke [id] | /remote serve [port] [--host <host>]');
  }
}

async function runTelegram(subcommand, args) {
  switch (subcommand) {
    case 'sync': {
      const limit = parseOptionalInt(args[0]);
      const result = await telegramSync({ limit });
      printHeader('Telegram sync');
      printKeyValue('updates processed', result.updatesProcessed);
      printKeyValue('messages sent', result.messagesSent);
      printKeyValue('last update id', result.lastUpdateId);
      return;
    }
    case 'webhook-info': {
      const auth = await remoteAuth();
      printHeader('Telegram webhook');
      printKeyValue('url', auth.publicBaseUrl ? `${auth.publicBaseUrl.replace(/\/+$/, '')}/v1/telegram/webhook` : '(set remote.publicBaseUrl first)');
      printKeyValue('secret', auth.telegram.webhookSecret ?? '(set remote.telegram.webhookSecret)');
      return;
    }
    default:
      throw new Error('Usage: telegram sync [limit] | telegram webhook-info');
  }
}

async function runRemoteAuth(args) {
  const subcommand = args[0];
  switch (subcommand) {
    case undefined:
    case 'show': {
      const result = await remoteAuth();
      printHeader('Remote auth');
      printKeyValue('default token', result.apiToken);
      printKeyValue('default token id', result.defaultTokenId);
      printKeyValue('auth file', result.authPath);
      printKeyValue('public base url', result.publicBaseUrl ?? '(not configured)');
      printKeyValue('approval ttl seconds', result.approvalTokenTtlSeconds);
      printKeyValue('telegram webhook secret', result.telegram.webhookSecret ?? '(not configured)');
      return;
    }
    case 'list': {
      const result = await remoteAuth();
      printHeader(`Remote auth tokens (${result.tokens.length})`);
      for (const token of result.tokens) {
        console.log(`- ${token.tokenId} ${token.role}/${token.kind} ${token.name}`);
        console.log(`  created=${token.createdAt} expires=${token.expiresAt ?? 'never'} revoked=${token.revokedAt ?? 'active'}`);
      }
      return;
    }
    case 'create': {
      const parsed = parseAuthCreateArgs(args.slice(1));
      const result = await remoteAuthCreate(parsed.name, {
        session: parsed.session,
        expiresInSeconds: parsed.expiresInSeconds,
      });
      printHeader(`Created auth token ${result.tokenId}`);
      printKeyValue('kind', result.kind);
      printKeyValue('name', result.name);
      printKeyValue('token', result.token);
      printKeyValue('expires', result.expiresAt ?? 'never');
      return;
    }
    case 'revoke': {
      const tokenId = args[1] ?? '';
      const result = await remoteAuthRevoke(tokenId);
      printHeader(`Revoked auth token ${result.tokenId}`);
      printKeyValue('revoked at', result.revokedAt);
      return;
    }
    case 'rotate-default': {
      const result = await remoteAuthRotateDefault();
      printHeader(`Rotated default auth token ${result.tokenId}`);
      if (result.rotatedFromTokenId) {
        printKeyValue('rotated from', result.rotatedFromTokenId);
      }
      printKeyValue('token', result.token);
      return;
    }
    default:
      throw new Error('Usage: /remote auth [show] | /remote auth list | /remote auth create <name> [--session] [--expires-seconds <n>] | /remote auth revoke <tokenId> | /remote auth rotate-default');
  }
}

function parseEnqueueArgs(args) {
  const promptParts = [];
  let requestedBy = 'remote';
  let kind = '';

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--requested-by') {
      requestedBy = args[index + 1] ?? 'remote';
      index += 1;
      continue;
    }
    if (value === '--kind') {
      kind = args[index + 1] ?? '';
      index += 1;
      continue;
    }
    promptParts.push(value);
  }

  return {
    prompt: promptParts.join(' ').trim(),
    requestedBy,
    kind,
  };
}

function parseServeArgs(args) {
  let port = 0;
  let host = '127.0.0.1';

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--host') {
      host = args[index + 1] ?? host;
      index += 1;
      continue;
    }
    const parsedPort = parseOptionalInt(value);
    if (parsedPort !== null) {
      port = parsedPort;
    }
  }

  return { host, port };
}

function parseAuthCreateArgs(args) {
  const nameParts = [];
  let session = false;
  let expiresInSeconds = null;

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--session') {
      session = true;
      continue;
    }
    if (value === '--expires-seconds') {
      expiresInSeconds = parseOptionalInt(args[index + 1]);
      index += 1;
      continue;
    }
    nameParts.push(value);
  }

  return {
    name: nameParts.join(' ').trim(),
    session,
    expiresInSeconds,
  };
}

function parseOptionalInt(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function stripSlash(value) {
  return value.startsWith('/') ? value.slice(1) : value;
}

function printHeader(value) {
  console.log(`\n${value}`);
}

function printKeyValue(key, value) {
  console.log(`${key}: ${value}`);
}

function printHelp() {
  console.log('Usage:');
  console.log('  pnpm run bridge -- /remote status [id]');
  console.log('  pnpm run bridge -- /remote auth [show]');
  console.log('  pnpm run bridge -- /remote auth list');
  console.log('  pnpm run bridge -- /remote auth create <name> [--session] [--expires-seconds <n>]');
  console.log('  pnpm run bridge -- /remote auth revoke <tokenId>');
  console.log('  pnpm run bridge -- /remote auth rotate-default');
  console.log('  pnpm run bridge -- /remote enqueue <prompt> [--requested-by <source>] [--kind <kind>]');
  console.log('  pnpm run bridge -- /remote approve <id>');
  console.log('  pnpm run bridge -- /remote revoke [id]');
  console.log('  pnpm run bridge -- /remote serve [port] [--host <host>]');
  console.log('  pnpm run bridge -- telegram sync [limit]');
  console.log('  pnpm run bridge -- telegram webhook-info');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
