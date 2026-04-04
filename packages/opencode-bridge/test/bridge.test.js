import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ensureStateLayout, loadConfig, loadNotifications, saveConfig } from '../../opencode-core/src/index.js';
import { jobsShow, runnerOnce } from '../../opencode-kairos/src/index.js';

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
} from '../src/index.js';

async function createTempRepo() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-bridge-'));
  await fs.mkdir(path.join(repoRoot, '.git'));
  await ensureStateLayout(repoRoot);
  return repoRoot;
}

test('remoteEnqueue creates an approval-gated request and notification by default', async () => {
  const repoRoot = await createTempRepo();

  const request = await remoteEnqueue('summarize flaky test output', {
    cwd: repoRoot,
    requestedBy: 'mobile',
    now: '2026-04-04T15:00:00.000Z',
  });

  assert.equal(request.effectiveStatus, 'awaiting_approval');
  assert.equal(request.approvalRequired, true);
  assert.equal(request.requestedBy, 'mobile');
  assert.equal(request.jobId, null);

  const status = await remoteStatus('', { cwd: repoRoot });
  assert.equal(status.counts.awaiting_approval, 1);
  assert.equal(status.requests[0].remoteRequestId, request.remoteRequestId);

  const notifications = await loadNotifications(repoRoot, 10);
  assert.equal(notifications.some((entry) => entry.type === 'remote.awaiting_approval'), true);
});

test('remoteApprove materializes a queued job and status follows job completion', async () => {
  const repoRoot = await createTempRepo();

  const queued = await remoteEnqueue('run approved remote work', {
    cwd: repoRoot,
    now: '2026-04-04T15:00:00.000Z',
  });
  const approved = await remoteApprove(queued.remoteRequestId, {
    cwd: repoRoot,
    now: '2026-04-04T15:01:00.000Z',
  });

  assert.equal(approved.effectiveStatus, 'queued');
  assert.notEqual(approved.jobId, null);
  assert.notEqual(approved.runId, null);

  await runnerOnce({
    cwd: repoRoot,
    now: '2026-04-04T15:02:00.000Z',
    executeJob: async () => ({
      command: 'opencode',
      args: ['run'],
      exitCode: 0,
      stdout: 'remote success',
      stderr: '',
    }),
  });

  const status = await remoteStatus(queued.remoteRequestId, { cwd: repoRoot });
  assert.equal(status.request.effectiveStatus, 'completed');
  assert.equal(status.request.jobId, approved.jobId);
  assert.equal(typeof status.request.resultPath, 'string');
});

test('remoteEnqueue auto-queues when approvalRequired is disabled and detects review handoff', async () => {
  const repoRoot = await createTempRepo();
  const config = await loadConfig(repoRoot);
  config.remote.approvalRequired = false;
  await saveConfig(repoRoot, config);

  const request = await remoteEnqueue('/review inspect current diff', {
    cwd: repoRoot,
    requestedBy: 'portal',
    now: '2026-04-04T15:00:00.000Z',
  });

  assert.equal(request.effectiveStatus, 'queued');
  assert.equal(request.kind, 'review');
  assert.equal(request.requestedBy, 'portal');
  assert.notEqual(request.jobId, null);
  assert.notEqual(request.runId, null);
  assert.equal(request.packetPack, 'review-remote');
  assert.notEqual(request.packetPath, null);

  const packet = JSON.parse(await fs.readFile(request.packetPath, 'utf8'));
  assert.equal(packet.remoteRequestId, request.remoteRequestId);
  assert.equal(packet.rendered.pack.name, 'review-remote');
  assert.match(packet.rendered.prompt, /Remote review target:/);
});

test('remoteRevoke cancels a queued remote request when its job has not started', async () => {
  const repoRoot = await createTempRepo();
  const config = await loadConfig(repoRoot);
  config.remote.approvalRequired = false;
  await saveConfig(repoRoot, config);

  const request = await remoteEnqueue('cancel queued remote request', {
    cwd: repoRoot,
    now: '2026-04-04T15:00:00.000Z',
  });

  const revoked = await remoteRevoke(request.remoteRequestId, {
    cwd: repoRoot,
    now: '2026-04-04T15:01:00.000Z',
  });

  assert.deepEqual(revoked.revoked, [request.remoteRequestId]);

  const status = await remoteStatus(request.remoteRequestId, { cwd: repoRoot });
  assert.equal(status.request.effectiveStatus, 'revoked');

  const job = await jobsShow(request.jobId, { cwd: repoRoot });
  assert.equal(job.status, 'cancelled');
});

test('remoteStatus respects maxStatusRequests config when listing recent requests', async () => {
  const repoRoot = await createTempRepo();
  const config = await loadConfig(repoRoot);
  config.remote.maxStatusRequests = 1;
  await saveConfig(repoRoot, config);

  await remoteEnqueue('first remote request', {
    cwd: repoRoot,
    now: '2026-04-04T15:00:00.000Z',
  });
  await remoteEnqueue('second remote request', {
    cwd: repoRoot,
    now: '2026-04-04T15:01:00.000Z',
  });

  const status = await remoteStatus('', { cwd: repoRoot });
  assert.equal(status.requests.length, 1);
  assert.equal(status.totalRequests, 2);
  assert.equal(status.truncated, true);
  assert.match(status.requests[0].prompt, /second remote request/);
});

test('bridge HTTP API uses bearer auth and signed approval links', async () => {
  const repoRoot = await createTempRepo();
  const server = await bridgeServe({ cwd: repoRoot, port: 0 });

  try {
    let response = await fetch(`${server.baseUrl}/v1/remote/status`);
    assert.equal(response.status, 401);

    response = await fetch(`${server.baseUrl}/v1/remote/enqueue`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${server.apiToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ prompt: 'enqueue through http api', requestedBy: 'http' }),
    });
    assert.equal(response.status, 200);
    const created = await response.json();
    assert.equal(created.requestedBy, 'http');

    const config = await loadConfig(repoRoot);
    config.remote.publicBaseUrl = server.baseUrl;
    await saveConfig(repoRoot, config);

    const gated = await remoteEnqueue('approve through signed link', {
      cwd: repoRoot,
      notifyTelegram: false,
    });
    assert.notEqual(gated.approvalLinks, null);

    response = await fetch(gated.approvalLinks.approveUrl);
    assert.equal(response.status, 200);
    const approved = await response.json();
    assert.equal(approved.result.jobId !== null, true);

    const auth = await remoteAuth({ cwd: repoRoot });
    assert.equal(auth.apiToken, server.apiToken);
  } finally {
    await server.close();
  }
});

test('bridge auth supports named tokens, session expiry, and default rotation', async () => {
  const repoRoot = await createTempRepo();
  const server = await bridgeServe({ cwd: repoRoot, port: 0 });

  try {
    const named = await remoteAuthCreate('ci client', { cwd: repoRoot });
    let response = await fetch(`${server.baseUrl}/v1/remote/status`, {
      headers: { authorization: `Bearer ${named.token}` },
    });
    assert.equal(response.status, 200);

    await remoteAuthRevoke(named.tokenId, { cwd: repoRoot });
    response = await fetch(`${server.baseUrl}/v1/remote/status`, {
      headers: { authorization: `Bearer ${named.token}` },
    });
    assert.equal(response.status, 401);

    const session = await remoteAuthCreate('mobile session', {
      cwd: repoRoot,
      session: true,
      expiresInSeconds: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    response = await fetch(`${server.baseUrl}/v1/remote/status`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.equal(response.status, 401);

    const authBefore = await remoteAuth({ cwd: repoRoot });
    const rotated = await remoteAuthRotateDefault({ cwd: repoRoot });
    assert.notEqual(rotated.token, authBefore.apiToken);

    response = await fetch(`${server.baseUrl}/v1/remote/status`, {
      headers: { authorization: `Bearer ${rotated.token}` },
    });
    assert.equal(response.status, 200);
  } finally {
    await server.close();
  }
});

test('bridge HTTP API supports Telegram webhook mode with secret validation', async () => {
  const repoRoot = await createTempRepo();
  const config = await loadConfig(repoRoot);
  config.remote.telegram.botToken = 'telegram-token';
  config.remote.telegram.allowedUserIds = ['123'];
  config.remote.telegram.apiBaseUrl = 'https://telegram.example.test';
  config.remote.telegram.webhookSecret = 'webhook-secret';
  await saveConfig(repoRoot, config);

  const server = await bridgeServe({ cwd: repoRoot, port: 0 });
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).startsWith(server.baseUrl)) {
      return originalFetch(url, init);
    }
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/sendMessage')) {
      return fakeJsonResponse({ ok: true, result: { message_id: 1 } });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  try {
    let response = await fetch(`${server.baseUrl}/v1/telegram/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ update_id: 1, message: { chat: { id: 123 }, from: { id: 123 }, text: '/enqueue webhook request' } }),
    });
    assert.equal(response.status, 401);

    response = await fetch(`${server.baseUrl}/v1/telegram/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'webhook-secret',
      },
      body: JSON.stringify({ update_id: 2, message: { chat: { id: 123 }, from: { id: 123 }, text: '/enqueue webhook request' } }),
    });
    assert.equal(response.status, 200);

    const status = await remoteStatus('', { cwd: repoRoot });
    assert.equal(status.requests.length, 1);
    assert.equal(status.requests[0].requestedBy, 'telegram:123');
    assert.equal(calls.some((entry) => String(entry.url).endsWith('/sendMessage')), true);
  } finally {
    globalThis.fetch = originalFetch;
    await server.close();
  }
});

test('bridge HTTP API streams SSE remote events', async () => {
  const repoRoot = await createTempRepo();
  const server = await bridgeServe({ cwd: repoRoot, port: 0 });

  try {
    const response = await fetch(`${server.baseUrl}/v1/remote/events`, {
      headers: { authorization: `Bearer ${server.apiToken}` },
    });
    assert.equal(response.status, 200);

    const reader = response.body.getReader();
    const snapshotChunk = await readSseChunk(reader);
    assert.match(snapshotChunk, /event: snapshot/);

    await remoteEnqueue('event stream request', {
      cwd: repoRoot,
      notifyTelegram: false,
      now: new Date().toISOString(),
    });

    const remoteChunk = await readSseChunk(reader, /event: remote/);
    assert.match(remoteChunk, /remote\.enqueued/);
    await reader.cancel();
  } finally {
    await server.close();
  }
});

test('telegramSync relays enqueue commands into remote bridge state', async () => {
  const repoRoot = await createTempRepo();
  const config = await loadConfig(repoRoot);
  config.remote.telegram.botToken = 'telegram-token';
  config.remote.telegram.allowedUserIds = ['123'];
  config.remote.telegram.apiBaseUrl = 'https://telegram.example.test';
  await saveConfig(repoRoot, config);

  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/getUpdates')) {
      return fakeJsonResponse({
        ok: true,
        result: [{
          update_id: 1,
          message: {
            chat: { id: 123 },
            from: { id: 123 },
            text: '/enqueue inspect bridge from telegram',
          },
        }],
      });
    }
    if (String(url).endsWith('/sendMessage')) {
      return fakeJsonResponse({ ok: true, result: { message_id: 1 } });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  try {
    const synced = await telegramSync({ cwd: repoRoot });
    assert.equal(synced.updatesProcessed, 1);
    assert.equal(synced.messagesSent, 1);

    const status = await remoteStatus('', { cwd: repoRoot });
    assert.equal(status.requests.length, 1);
    assert.equal(status.requests[0].requestedBy, 'telegram:123');
    assert.equal(calls.some((entry) => String(entry.url).endsWith('/sendMessage')), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('telegramSync can approve a pending remote request', async () => {
  const repoRoot = await createTempRepo();
  const config = await loadConfig(repoRoot);
  config.remote.telegram.botToken = 'telegram-token';
  config.remote.telegram.allowedUserIds = ['123'];
  config.remote.telegram.apiBaseUrl = 'https://telegram.example.test';
  await saveConfig(repoRoot, config);

  const request = await remoteEnqueue('pending approval from bridge', {
    cwd: repoRoot,
    notifyTelegram: false,
    now: '2026-04-04T15:00:00.000Z',
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/getUpdates')) {
      return fakeJsonResponse({
        ok: true,
        result: [{
          update_id: 2,
          message: {
            chat: { id: 123 },
            from: { id: 123 },
            text: `/approve ${request.remoteRequestId}`,
          },
        }],
      });
    }
    if (String(url).endsWith('/sendMessage')) {
      return fakeJsonResponse({ ok: true, result: { message_id: 1 } });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  try {
    await telegramSync({ cwd: repoRoot });
    const status = await remoteStatus(request.remoteRequestId, { cwd: repoRoot });
    assert.equal(status.request.effectiveStatus, 'queued');
    assert.notEqual(status.request.jobId, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('remoteEnqueue can push approval-needed notifications to Telegram with signed links', async () => {
  const repoRoot = await createTempRepo();
  const config = await loadConfig(repoRoot);
  config.remote.publicBaseUrl = 'https://bridge.example.test';
  config.remote.telegram.botToken = 'telegram-token';
  config.remote.telegram.allowedUserIds = ['123'];
  config.remote.telegram.apiBaseUrl = 'https://telegram.example.test';
  await saveConfig(repoRoot, config);

  const originalFetch = globalThis.fetch;
  const sentBodies = [];
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith('/sendMessage')) {
      sentBodies.push(JSON.parse(init.body));
      return fakeJsonResponse({ ok: true, result: { message_id: 1 } });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  try {
    const request = await remoteEnqueue('notify telegram bridge user', {
      cwd: repoRoot,
      now: new Date().toISOString(),
    });

    assert.equal(sentBodies.length, 1);
    assert.match(sentBodies[0].text, new RegExp(request.remoteRequestId));
    assert.match(sentBodies[0].text, /approve: https:\/\/bridge\.example\.test\/v1\/remote\/action\//);
    assert.match(sentBodies[0].text, /revoke: https:\/\/bridge\.example\.test\/v1\/remote\/action\//);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function fakeJsonResponse(value) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    async json() {
      return value;
    },
  };
}

async function readSseChunk(reader, pattern = /event:/) {
  let buffer = '';
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += Buffer.from(value).toString('utf8');
    if (pattern.test(buffer)) {
      return buffer;
    }
  }
  throw new Error(`Timed out waiting for SSE chunk matching ${pattern}`);
}
