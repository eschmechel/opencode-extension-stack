#!/usr/bin/env node

import {
  remoteApprove,
  remoteEnqueue,
  remoteRevoke,
  remoteStatus,
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
    default:
      throw new Error('Usage: /remote status [id] | /remote enqueue <prompt> | /remote approve <id> | /remote revoke [id]');
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
  console.log('  pnpm run bridge -- /remote enqueue <prompt> [--requested-by <source>] [--kind <kind>]');
  console.log('  pnpm run bridge -- /remote approve <id>');
  console.log('  pnpm run bridge -- /remote revoke [id]');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
