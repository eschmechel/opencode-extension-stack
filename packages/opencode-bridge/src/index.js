import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import {
  appendNotification,
  appendRunEvent,
  assertRepoAllowed,
  createJobRecord,
  createRemoteRequest,
  createStableId,
  ensureStateLayout,
  findRepoRoot,
  getOpencodePaths,
  loadConfig,
  loadJobsState,
  withRepoLock,
  saveJobsState,
} from '../../opencode-core/src/index.js';
import { executePack } from '../../opencode-packs/src/index.js';

const REMOTE_STATE_VERSION = 1;
const REMOTE_AUTH_VERSION = 1;
const TELEGRAM_STATE_VERSION = 1;
const REMOTE_REQUEST_STATUSES = new Set(['awaiting_approval', 'queued', 'revoked']);

export async function remoteStatus(remoteRequestId = '', options = {}) {
  const repoRoot = await prepareRepo(options.cwd);
  const config = await loadConfig(repoRoot);
  const authState = await ensureRemoteAuthState(repoRoot);
  const remoteState = await loadRemoteState(repoRoot);
  const jobsState = await loadJobsState(repoRoot);
  const requests = remoteState.requests
    .sort(sortByNewest)
    .map((request) => enrichRemoteRequest(repoRoot, request, jobsState, config, authState, options.now));

  const trimmedRequestId = typeof remoteRequestId === 'string' ? remoteRequestId.trim() : '';
  if (trimmedRequestId) {
    const request = requests.find((entry) => entry.remoteRequestId === trimmedRequestId);
    if (!request) {
      throw new Error(`Remote request not found: ${trimmedRequestId}`);
    }

    return {
      repoRoot,
      approvalRequired: config.remote.approvalRequired,
      request,
    };
  }

  const limit = Number.isInteger(options.limit) && options.limit > 0
    ? options.limit
    : config.remote.maxStatusRequests;
  const visibleRequests = requests.slice(0, limit);

  return {
    repoRoot,
    approvalRequired: config.remote.approvalRequired,
    totalRequests: requests.length,
    truncated: requests.length > visibleRequests.length,
    counts: countRemoteStatuses(requests),
    requests: visibleRequests,
  };
}

export async function remoteEnqueue(prompt, options = {}) {
  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt) {
    throw new Error('A prompt is required for /remote enqueue.');
  }

  const repoRoot = await prepareRepo(options.cwd);
  const nowIso = toIso(options.now);

  return withRepoLock(repoRoot, async () => {
    const config = await loadConfig(repoRoot);
    const authState = await ensureRemoteAuthState(repoRoot);
    assertRepoAllowed(config, repoRoot);

    const remoteState = await loadRemoteState(repoRoot);
    const jobsState = await loadJobsState(repoRoot);
    const approvalRequired = config.remote.approvalRequired;
    const request = {
      ...createRemoteRequest({
        status: approvalRequired ? 'awaiting_approval' : 'queued',
        createdAt: nowIso,
        prompt: trimmedPrompt,
      }),
      updatedAt: nowIso,
      kind: detectRemoteKind(trimmedPrompt, options.kind),
      requestedBy: typeof options.requestedBy === 'string' && options.requestedBy.trim() ? options.requestedBy.trim() : 'remote',
      approvalRequired,
      approvedAt: null,
      revokedAt: null,
      jobId: null,
      runId: null,
      packetPath: null,
      packetPack: null,
      packetInvocationId: null,
    };

    if (request.kind === 'review') {
      const packet = await writeRemoteReviewPacket(repoRoot, request, nowIso);
      request.packetPath = packet.packetPath;
      request.packetPack = packet.packetPack;
      request.packetInvocationId = packet.packetInvocationId;
    }

    if (!approvalRequired) {
      const job = await createQueuedJobLocked(repoRoot, jobsState, request.prompt, nowIso, request.remoteRequestId);
      request.approvedAt = nowIso;
      request.jobId = job.jobId;
      request.runId = job.runId;
    }

    remoteState.requests.push(request);
    await saveRemoteState(repoRoot, remoteState);
    await appendRemoteEvent(repoRoot, approvalRequired ? 'remote.enqueued' : 'remote.auto_approved', {
      remoteRequestId: request.remoteRequestId,
      prompt: request.prompt,
      kind: request.kind,
      requestedBy: request.requestedBy,
      jobId: request.jobId,
      packetPath: request.packetPath,
    });
    await appendNotification(repoRoot, {
      at: nowIso,
      type: approvalRequired ? 'remote.awaiting_approval' : 'remote.queued',
      title: approvalRequired ? `Remote approval needed ${request.remoteRequestId}` : `Remote queued ${request.remoteRequestId}`,
      body: approvalRequired ? request.prompt : `Queued remote request.${request.jobId ? ` Job ${request.jobId}.` : ''}`,
      level: approvalRequired ? 'warn' : 'info',
      remoteRequestId: request.remoteRequestId,
      jobId: request.jobId,
    });

    const enriched = enrichRemoteRequest(repoRoot, request, jobsState, config, authState, nowIso);
    if (options.notifyTelegram !== false) {
      await sendTelegramRemoteMessage(repoRoot, config, buildTelegramEnqueueMessage(enriched));
    }

    return enriched;
  });
}

export async function remoteApprove(remoteRequestId, options = {}) {
  const trimmedRequestId = remoteRequestId.trim();
  if (!trimmedRequestId) {
    throw new Error('A remote request id is required for /remote approve.');
  }

  const repoRoot = await prepareRepo(options.cwd);
  const nowIso = toIso(options.now);

  return withRepoLock(repoRoot, async () => {
    const config = await loadConfig(repoRoot);
    const authState = await ensureRemoteAuthState(repoRoot);
    assertRepoAllowed(config, repoRoot);

    const remoteState = await loadRemoteState(repoRoot);
    const request = remoteState.requests.find((entry) => entry.remoteRequestId === trimmedRequestId);
    if (!request) {
      throw new Error(`Remote request not found: ${trimmedRequestId}`);
    }
    if (request.status === 'revoked') {
      throw new Error(`Remote request ${trimmedRequestId} has been revoked.`);
    }

    const jobsState = await loadJobsState(repoRoot);
    if (!request.jobId) {
      const job = await createQueuedJobLocked(repoRoot, jobsState, request.prompt, nowIso, request.remoteRequestId);
      request.status = 'queued';
      request.updatedAt = nowIso;
      request.approvedAt = nowIso;
      request.jobId = job.jobId;
      request.runId = job.runId;
      await saveRemoteState(repoRoot, remoteState);
      await appendRemoteEvent(repoRoot, 'remote.approved', {
        remoteRequestId: request.remoteRequestId,
        jobId: job.jobId,
        runId: job.runId,
      });
      await appendNotification(repoRoot, {
        at: nowIso,
        type: 'remote.approved',
        title: `Remote approved ${request.remoteRequestId}`,
        body: `Queued job ${job.jobId}.`,
        level: 'info',
        remoteRequestId: request.remoteRequestId,
        jobId: job.jobId,
      });
    }

    const enriched = enrichRemoteRequest(repoRoot, request, jobsState, config, authState, nowIso);
    if (options.notifyTelegram !== false) {
      await sendTelegramRemoteMessage(repoRoot, config, buildTelegramApproveMessage(enriched));
    }

    return enriched;
  });
}

export async function remoteRevoke(remoteRequestId = '', options = {}) {
  const repoRoot = await prepareRepo(options.cwd);
  const nowIso = toIso(options.now);
  const trimmedRequestId = typeof remoteRequestId === 'string' ? remoteRequestId.trim() : '';

  return withRepoLock(repoRoot, async () => {
    const config = await loadConfig(repoRoot);
    const authState = await ensureRemoteAuthState(repoRoot);
    assertRepoAllowed(config, repoRoot);

    const remoteState = await loadRemoteState(repoRoot);
    const jobsState = await loadJobsState(repoRoot);
    const targets = trimmedRequestId
      ? remoteState.requests.filter((entry) => entry.remoteRequestId === trimmedRequestId)
      : remoteState.requests.filter((entry) => entry.status !== 'revoked');

    if (trimmedRequestId && targets.length === 0) {
      throw new Error(`Remote request not found: ${trimmedRequestId}`);
    }

    const revoked = [];
    const skipped = [];
    let jobsChanged = false;
    let requestsChanged = false;

    for (const request of targets) {
      const job = request.jobId ? jobsState.jobs.find((entry) => entry.jobId === request.jobId) ?? null : null;
      if (request.status === 'awaiting_approval') {
        request.status = 'revoked';
        request.revokedAt = nowIso;
        request.updatedAt = nowIso;
        requestsChanged = true;
        revoked.push(request.remoteRequestId);
        await appendRemoteEvent(repoRoot, 'remote.revoked', { remoteRequestId: request.remoteRequestId, reason: 'approval_revoked' });
        continue;
      }

      if (job && job.status === 'queued') {
        job.status = 'cancelled';
        job.updatedAt = nowIso;
        request.status = 'revoked';
        request.revokedAt = nowIso;
        request.updatedAt = nowIso;
        jobsChanged = true;
        requestsChanged = true;
        revoked.push(request.remoteRequestId);
        await appendRunEvent(repoRoot, job.runId, 'job.cancelled', {
          jobId: job.jobId,
          remoteRequestId: request.remoteRequestId,
          source: 'remote.revoke',
        });
        await appendRemoteEvent(repoRoot, 'remote.revoked', {
          remoteRequestId: request.remoteRequestId,
          jobId: job.jobId,
          reason: 'queued_job_cancelled',
        });
        continue;
      }

      skipped.push({
        remoteRequestId: request.remoteRequestId,
        reason: job ? `job_${job.status}` : request.status,
      });
    }

    if (jobsChanged) {
      await saveJobsState(repoRoot, jobsState);
    }
    if (requestsChanged) {
      await saveRemoteState(repoRoot, remoteState);
    }
    if (revoked.length > 0) {
      await appendNotification(repoRoot, {
        at: nowIso,
        type: 'remote.revoked',
        title: revoked.length === 1 ? `Remote revoked ${revoked[0]}` : `Remote revoked ${revoked.length} requests`,
        body: revoked.join(', '),
        level: 'warn',
      });
      if (options.notifyTelegram !== false) {
        await sendTelegramRemoteMessage(repoRoot, config, buildTelegramRevokeMessage({ revoked, skipped }));
      }
    }

    return {
      repoRoot,
      revoked,
      skipped,
      authEnabled: Boolean(getDefaultBridgeToken(authState)?.token),
    };
  });
}

export async function remoteAuth(options = {}) {
  const repoRoot = await prepareRepo(options.cwd);
  const config = await loadConfig(repoRoot);
  const authState = await ensureRemoteAuthState(repoRoot);
  const defaultToken = getDefaultBridgeToken(authState);

  return {
    repoRoot,
    apiToken: defaultToken?.token ?? null,
    defaultTokenId: defaultToken?.tokenId ?? null,
    tokens: authState.tokens.map(summarizeBridgeToken),
    publicBaseUrl: config.remote.publicBaseUrl,
    approvalTokenTtlSeconds: config.remote.approvalTokenTtlSeconds,
    telegram: {
      configured: Boolean(config.remote.telegram.botToken),
      allowedUserIds: config.remote.telegram.allowedUserIds,
      apiBaseUrl: config.remote.telegram.apiBaseUrl,
      webhookSecret: config.remote.telegram.webhookSecret,
    },
    authPath: getRemotePaths(repoRoot).auth,
  };
}

export async function remoteAuthCreate(name, options = {}) {
  const trimmedName = String(name ?? '').trim();
  if (!trimmedName) {
    throw new Error('A token name is required for /remote auth create.');
  }

  const repoRoot = await prepareRepo(options.cwd);
  const nowIso = toIso(options.now);

  return withRepoLock(repoRoot, async () => {
    const authState = await ensureRemoteAuthState(repoRoot);
    const expiresAt = Number.isInteger(options.expiresInSeconds) && options.expiresInSeconds > 0
      ? new Date(new Date(nowIso).getTime() + (options.expiresInSeconds * 1000)).toISOString()
      : null;
    const token = createBridgeTokenRecord(trimmedName, options.session ? 'session' : 'client', nowIso, expiresAt);
    authState.tokens.push(token);
    await saveRemoteAuthState(repoRoot, authState);
    return {
      repoRoot,
      tokenId: token.tokenId,
      token: token.token,
      kind: token.kind,
      name: token.name,
      expiresAt: token.expiresAt,
    };
  });
}

export async function remoteAuthRevoke(tokenId, options = {}) {
  const trimmedTokenId = String(tokenId ?? '').trim();
  if (!trimmedTokenId) {
    throw new Error('A token id is required for /remote auth revoke.');
  }

  const repoRoot = await prepareRepo(options.cwd);
  const nowIso = toIso(options.now);

  return withRepoLock(repoRoot, async () => {
    const authState = await ensureRemoteAuthState(repoRoot);
    const token = authState.tokens.find((entry) => entry.tokenId === trimmedTokenId);
    if (!token) {
      throw new Error(`Remote auth token not found: ${trimmedTokenId}`);
    }
    if (token.role === 'default') {
      throw new Error('Use /remote auth rotate-default to replace the default token instead of revoking it directly.');
    }
    token.revokedAt = nowIso;
    await saveRemoteAuthState(repoRoot, authState);
    return {
      repoRoot,
      tokenId: token.tokenId,
      revokedAt: token.revokedAt,
    };
  });
}

export async function remoteAuthRotateDefault(options = {}) {
  const repoRoot = await prepareRepo(options.cwd);
  const nowIso = toIso(options.now);

  return withRepoLock(repoRoot, async () => {
    const authState = await ensureRemoteAuthState(repoRoot);
    const current = getDefaultBridgeToken(authState);
    if (current) {
      current.revokedAt = nowIso;
    }
    const replacement = createBridgeTokenRecord('default', 'client', nowIso, null, { role: 'default' });
    authState.tokens.push(replacement);
    await saveRemoteAuthState(repoRoot, authState);
    return {
      repoRoot,
      tokenId: replacement.tokenId,
      token: replacement.token,
      rotatedFromTokenId: current?.tokenId ?? null,
    };
  });
}

export async function bridgeServe(options = {}) {
  const repoRoot = await prepareRepo(options.cwd);
  const authState = await ensureRemoteAuthState(repoRoot);
  const host = typeof options.host === 'string' && options.host.trim() ? options.host.trim() : '127.0.0.1';
  const port = Number.isInteger(options.port) ? options.port : Number.parseInt(String(options.port ?? '0'), 10) || 0;

  const server = http.createServer((request, response) => {
    handleBridgeHttpRequest(repoRoot, request, response).catch((error) => {
      if (!response.headersSent) {
        writeJsonResponse(response, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const effectivePort = typeof address === 'object' && address ? address.port : port;
  const baseUrl = `http://${host}:${effectivePort}`;

  return {
    repoRoot,
    host,
    port: effectivePort,
    baseUrl,
    apiToken: getDefaultBridgeToken(authState)?.token ?? null,
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
    server,
  };
}

export async function telegramSync(options = {}) {
  const repoRoot = await prepareRepo(options.cwd);
  const config = await loadConfig(repoRoot);
  const authState = await ensureRemoteAuthState(repoRoot);
  const telegram = config.remote.telegram;
  if (!telegram.botToken) {
    throw new Error('remote.telegram.botToken must be configured to use bridge telegram sync.');
  }

  const state = await loadTelegramState(repoRoot);
  const updates = await telegramApiRequest(telegram, 'getUpdates', {
    offset: state.lastUpdateId + 1,
    limit: Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 20,
    timeout: 0,
  });

  let processed = 0;
  let sent = 0;
  for (const update of updates.result ?? []) {
    processed += 1;
    state.lastUpdateId = Math.max(state.lastUpdateId, update.update_id ?? 0);
    sent += await handleTelegramUpdate(repoRoot, config, authState, telegram, update, options.now);
  }

  await saveTelegramState(repoRoot, state);
  return {
    repoRoot,
    updatesProcessed: processed,
    messagesSent: sent,
    lastUpdateId: state.lastUpdateId,
  };
}

async function createQueuedJobLocked(repoRoot, jobsState, prompt, nowIso, remoteRequestId) {
  const job = createJobRecord({
    jobId: createStableId('job'),
    runId: createStableId('run'),
    source: 'queue',
    prompt,
    createdAt: nowIso,
    updatedAt: nowIso,
    scheduleId: null,
    scheduledForAt: null,
    runnerPid: null,
    heartbeatAt: null,
    retriedFromJobId: null,
    repoRoot,
  });

  jobsState.jobs.push(job);
  await saveJobsState(repoRoot, jobsState);
  await appendRunEvent(repoRoot, job.runId, 'job.enqueued', {
    jobId: job.jobId,
    source: job.source,
    scheduleId: null,
    prompt: job.prompt,
    remoteRequestId,
  });

  return job;
}

function enrichRemoteRequest(repoRoot, request, jobsState, config, authState, now) {
  const job = request.jobId ? jobsState.jobs.find((entry) => entry.jobId === request.jobId) ?? null : null;
  const effectiveStatus = request.status === 'revoked'
    ? 'revoked'
    : job?.status ?? request.status;
  const runDir = request.runId ? path.join(getOpencodePaths(repoRoot).runsDir, request.runId) : null;
  const approvalLinks = request.status === 'awaiting_approval'
    ? buildApprovalLinks(repoRoot, request, config, authState, now)
    : null;

  return {
    ...request,
    effectiveStatus,
    jobStatus: job?.status ?? null,
    job,
    approvalLinks,
    packetPath: request.packetPath ? fromRemoteRelative(repoRoot, request.packetPath) : null,
    packetPack: request.packetPack,
    packetInvocationId: request.packetInvocationId,
    runLogPath: request.runId ? path.join(runDir, 'events.ndjson') : null,
    stdoutPath: request.runId ? path.join(runDir, 'stdout.txt') : null,
    stderrPath: request.runId ? path.join(runDir, 'stderr.txt') : null,
    resultPath: request.runId ? path.join(runDir, 'result.json') : null,
  };
}

async function writeRemoteReviewPacket(repoRoot, request, nowIso) {
  const paths = getRemotePaths(repoRoot);
  const packetDir = path.join(paths.remoteDir, 'packets');
  await fs.mkdir(packetDir, { recursive: true });

  const normalizedRequest = stripReviewCommand(request.prompt);
  const invocation = await executePack('review-remote', {
    request: normalizedRequest,
  }, {
    cwd: repoRoot,
    channel: 'remote',
    now: nowIso,
  });
  const packetPath = path.join(packetDir, `${request.remoteRequestId}.json`);
  await writeJsonAtomic(packetPath, {
    remoteRequestId: request.remoteRequestId,
    createdAt: nowIso,
    kind: request.kind,
    requestedBy: request.requestedBy,
    prompt: request.prompt,
    packetInvocationId: invocation.invocationId,
    invocationPath: toRemoteRelative(repoRoot, invocation.invocationPath),
    rendered: {
      pack: invocation.pack,
      input: invocation.input,
      prompt: invocation.prompt,
      outputContract: invocation.outputContract,
    },
    handoff: invocation.handoff,
  });

  return {
    packetPath: toRemoteRelative(repoRoot, packetPath),
    packetPack: 'review-remote',
    packetInvocationId: invocation.invocationId,
  };
}

function countRemoteStatuses(requests) {
  const counts = {
    awaiting_approval: 0,
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    revoked: 0,
  };

  for (const request of requests) {
    if (counts[request.effectiveStatus] !== undefined) {
      counts[request.effectiveStatus] += 1;
    }
  }

  return counts;
}

function buildApprovalLinks(repoRoot, request, config, authState, now) {
  if (!config.remote.publicBaseUrl) {
    return null;
  }

  const baseUrl = stripTrailingSlash(config.remote.publicBaseUrl);
  const expiresAt = new Date(new Date(now ?? Date.now()).getTime() + (config.remote.approvalTokenTtlSeconds * 1000)).toISOString();
  return {
    approveUrl: `${baseUrl}/v1/remote/action/${request.remoteRequestId}/approve?token=${encodeURIComponent(signRemoteActionToken(authState, request.remoteRequestId, 'approve', expiresAt))}`,
    revokeUrl: `${baseUrl}/v1/remote/action/${request.remoteRequestId}/revoke?token=${encodeURIComponent(signRemoteActionToken(authState, request.remoteRequestId, 'revoke', expiresAt))}`,
    expiresAt,
  };
}

function signRemoteActionToken(authState, remoteRequestId, action, expiresAt) {
  const payload = base64urlEncode(JSON.stringify({ remoteRequestId, action, expiresAt }));
  const signature = crypto.createHmac('sha256', authState.signingSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyRemoteActionToken(authState, token, remoteRequestId, action, now) {
  const [payload, signature] = String(token ?? '').split('.');
  if (!payload || !signature) {
    return false;
  }

  const expected = crypto.createHmac('sha256', authState.signingSecret).update(payload).digest('base64url');
  if (!timingSafeEqual(expected, signature)) {
    return false;
  }

  let parsed;
  try {
    parsed = JSON.parse(base64urlDecode(payload));
  } catch {
    return false;
  }

  if (parsed.remoteRequestId !== remoteRequestId || parsed.action !== action) {
    return false;
  }

  return new Date(parsed.expiresAt).getTime() >= new Date(now ?? Date.now()).getTime();
}

async function handleBridgeHttpRequest(repoRoot, request, response) {
  const authState = await ensureRemoteAuthState(repoRoot);
  const config = await loadConfig(repoRoot);
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'GET' && url.pathname === '/health') {
    writeJsonResponse(response, 200, { ok: true });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/telegram/webhook') {
    if (!config.remote.telegram.botToken) {
      writeJsonResponse(response, 503, { error: 'Telegram bridge is not configured.' });
      return;
    }
    if (!isTelegramWebhookAuthorized(request, config.remote.telegram.webhookSecret)) {
      writeJsonResponse(response, 401, { error: 'Invalid Telegram webhook secret.' });
      return;
    }
    const update = await readJsonRequestBody(request);
    const sent = await handleTelegramUpdate(repoRoot, config, authState, config.remote.telegram, update, new Date().toISOString());
    writeJsonResponse(response, 200, { ok: true, messagesSent: sent });
    return;
  }

  const actionMatch = url.pathname.match(/^\/v1\/remote\/action\/([^/]+)\/(approve|revoke)$/);
  if (actionMatch) {
    const [, remoteRequestId, action] = actionMatch;
    const token = url.searchParams.get('token') ?? '';
    if (!verifyRemoteActionToken(authState, token, remoteRequestId, action, new Date().toISOString())) {
      writeJsonResponse(response, 401, { error: 'Invalid or expired signed token.' });
      return;
    }

    const result = action === 'approve'
      ? await remoteApprove(remoteRequestId, { cwd: repoRoot })
      : await remoteRevoke(remoteRequestId, { cwd: repoRoot });
    writeJsonResponse(response, 200, { ok: true, result });
    return;
  }

  const tokenRecord = await authorizeBridgeRequest(repoRoot, authState, request, new Date().toISOString());
  if (!tokenRecord) {
    writeJsonResponse(response, 401, { error: 'Missing or invalid bearer token.' });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/v1/remote/events') {
    await streamRemoteEvents(repoRoot, request, response, {
      tokenId: tokenRecord.tokenId,
      now: new Date().toISOString(),
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/v1/remote/status') {
    writeJsonResponse(response, 200, await remoteStatus('', {
      cwd: repoRoot,
      limit: parseOptionalInt(url.searchParams.get('limit')),
      now: new Date().toISOString(),
    }));
    return;
  }

  const statusMatch = url.pathname.match(/^\/v1\/remote\/status\/([^/]+)$/);
  if (request.method === 'GET' && statusMatch) {
    writeJsonResponse(response, 200, await remoteStatus(statusMatch[1], { cwd: repoRoot, now: new Date().toISOString() }));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/remote/enqueue') {
    const body = await readJsonRequestBody(request);
    writeJsonResponse(response, 200, await remoteEnqueue(String(body.prompt ?? ''), {
      cwd: repoRoot,
      requestedBy: typeof body.requestedBy === 'string' ? body.requestedBy : 'remote-api',
      kind: typeof body.kind === 'string' ? body.kind : '',
      now: new Date().toISOString(),
    }));
    return;
  }

  const approveMatch = url.pathname.match(/^\/v1\/remote\/approve\/([^/]+)$/);
  if (request.method === 'POST' && approveMatch) {
    writeJsonResponse(response, 200, await remoteApprove(approveMatch[1], { cwd: repoRoot, now: new Date().toISOString() }));
    return;
  }

  const revokeMatch = url.pathname.match(/^\/v1\/remote\/revoke(?:\/([^/]+))?$/);
  if (request.method === 'POST' && revokeMatch) {
    writeJsonResponse(response, 200, await remoteRevoke(revokeMatch[1] ?? '', { cwd: repoRoot, now: new Date().toISOString() }));
    return;
  }

  writeJsonResponse(response, 404, { error: 'Not found.' });
}

async function handleTelegramUpdate(repoRoot, config, authState, telegram, update, now) {
  const message = update.message ?? null;
  if (!message?.chat?.id || typeof message.text !== 'string') {
    return 0;
  }

  const userId = String(message.from?.id ?? '');
  const chatId = message.chat.id;
  if (config.remote.telegram.allowedUserIds.length > 0 && !config.remote.telegram.allowedUserIds.includes(userId)) {
    await telegramSendMessage(telegram, chatId, 'This Telegram user is not allowed to control the bridge.');
    return 1;
  }

  const text = message.text.trim();
  if (!text) {
    return 0;
  }

  if (text === '/start' || text === '/help') {
    await telegramSendMessage(telegram, chatId, buildTelegramHelpText());
    return 1;
  }

  if (text === '/status' || text.startsWith('/status ')) {
    const requestId = text.replace(/^\/status\s*/, '').trim();
    const status = requestId
      ? await remoteStatus(requestId, { cwd: repoRoot, now })
      : await remoteStatus('', { cwd: repoRoot, now });
    await telegramSendMessage(telegram, chatId, formatTelegramStatus(status));
    return 1;
  }

  if (text === '/pending') {
    const status = await remoteStatus('', { cwd: repoRoot, now });
    const pending = status.requests.filter((entry) => entry.effectiveStatus === 'awaiting_approval');
    await telegramSendMessage(telegram, chatId, pending.length === 0
      ? 'No pending remote approvals.'
      : pending.map((entry) => `- ${entry.remoteRequestId}: ${entry.prompt}`).join('\n'));
    return 1;
  }

  if (text.startsWith('/approve ')) {
    const remoteRequestId = text.replace(/^\/approve\s+/, '').trim();
    const approved = await remoteApprove(remoteRequestId, { cwd: repoRoot, now, notifyTelegram: false });
    await telegramSendMessage(telegram, chatId, `Approved ${approved.remoteRequestId}${approved.jobId ? ` -> job ${approved.jobId}` : ''}`);
    return 1;
  }

  if (text === '/revoke' || text.startsWith('/revoke ')) {
    const remoteRequestId = text.replace(/^\/revoke\s*/, '').trim();
    const revoked = await remoteRevoke(remoteRequestId, { cwd: repoRoot, now, notifyTelegram: false });
    await telegramSendMessage(telegram, chatId, revoked.revoked.length === 0 ? 'No remote requests revoked.' : `Revoked: ${revoked.revoked.join(', ')}`);
    return 1;
  }

  const prompt = text.startsWith('/enqueue ') ? text.replace(/^\/enqueue\s+/, '').trim() : text;
  const queued = await remoteEnqueue(prompt, {
    cwd: repoRoot,
    now,
    requestedBy: `telegram:${userId}`,
    notifyTelegram: false,
  });
  await telegramSendMessage(telegram, chatId, buildTelegramEnqueueMessage(queued));
  return 1;
}

async function sendTelegramRemoteMessage(repoRoot, config, text) {
  if (!text || !config.remote.telegram.botToken || config.remote.telegram.allowedUserIds.length === 0) {
    return 0;
  }

  let sent = 0;
  for (const userId of config.remote.telegram.allowedUserIds) {
    await telegramSendMessage(config.remote.telegram, userId, text);
    sent += 1;
  }
  return sent;
}

async function telegramSendMessage(telegram, chatId, text) {
  await telegramApiRequest(telegram, 'sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  });
}

async function telegramApiRequest(telegram, method, payload) {
  const base = stripTrailingSlash(telegram.apiBaseUrl || 'https://api.telegram.org');
  const response = await fetch(`${base}/bot${telegram.botToken}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok || body?.ok === false) {
    throw new Error(`Telegram API ${method} failed: ${body?.description ?? response.statusText}`);
  }
  return body;
}

function buildTelegramHelpText() {
  return [
    'OpenCode bridge Telegram commands:',
    '/status [id]',
    '/pending',
    '/enqueue <prompt>',
    '/approve <remote-id>',
    '/revoke [remote-id]',
    'Any non-command text is treated as /enqueue.',
  ].join('\n');
}

function formatTelegramStatus(status) {
  if (status.request) {
    const request = status.request;
    return [
      `Remote ${request.remoteRequestId}`,
      `kind: ${request.kind}`,
      `status: ${request.effectiveStatus}`,
      `requested by: ${request.requestedBy}`,
      ...(request.jobId ? [`job: ${request.jobId}`] : []),
      ...(request.approvalLinks ? [`approve: ${request.approvalLinks.approveUrl}`, `revoke: ${request.approvalLinks.revokeUrl}`] : []),
      `prompt: ${request.prompt}`,
    ].join('\n');
  }

  const lines = [
    `approval required: ${status.approvalRequired}`,
    `requests: ${status.totalRequests}`,
  ];
  for (const request of status.requests) {
    lines.push(`- ${request.remoteRequestId} ${request.effectiveStatus}: ${request.prompt}`);
  }
  return lines.join('\n');
}

function buildTelegramEnqueueMessage(request) {
  return [
    `Remote ${request.remoteRequestId}`,
    `kind: ${request.kind}`,
    `status: ${request.effectiveStatus}`,
    ...(request.packetPath ? [`packet: ${request.packetPath}`] : []),
    ...(request.approvalLinks ? [`approve: ${request.approvalLinks.approveUrl}`, `revoke: ${request.approvalLinks.revokeUrl}`] : []),
    `prompt: ${request.prompt}`,
  ].join('\n');
}

function buildTelegramApproveMessage(request) {
  return [
    `Approved ${request.remoteRequestId}`,
    ...(request.jobId ? [`job: ${request.jobId}`] : []),
    ...(request.runId ? [`run: ${request.runId}`] : []),
  ].join('\n');
}

function buildTelegramRevokeMessage(result) {
  return result.revoked.length === 0
    ? 'No remote requests were revoked.'
    : `Revoked remote requests: ${result.revoked.join(', ')}`;
}

async function authorizeBridgeRequest(repoRoot, authState, request, now) {
  const header = request.headers.authorization ?? request.headers.Authorization ?? '';
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    return null;
  }

  const tokenValue = header.slice('Bearer '.length);
  const tokenRecord = findAuthorizedBridgeToken(authState, tokenValue, now);
  if (!tokenRecord) {
    return null;
  }

  tokenRecord.lastUsedAt = now;
  await saveRemoteAuthState(repoRoot, authState);
  return summarizeBridgeToken(tokenRecord);
}

function isTelegramWebhookAuthorized(request, expectedSecret) {
  if (!expectedSecret) {
    return false;
  }

  const header = request.headers['x-telegram-bot-api-secret-token'] ?? request.headers['X-Telegram-Bot-Api-Secret-Token'] ?? '';
  return typeof header === 'string' && timingSafeEqual(header, expectedSecret);
}

async function readJsonRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function writeJsonResponse(response, statusCode, value) {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

async function streamRemoteEvents(repoRoot, request, response, context) {
  const remotePaths = getRemotePaths(repoRoot);
  response.statusCode = 200;
  response.setHeader('content-type', 'text/event-stream; charset=utf-8');
  response.setHeader('cache-control', 'no-cache, no-transform');
  response.setHeader('connection', 'keep-alive');
  response.flushHeaders?.();

  const initial = await remoteStatus('', { cwd: repoRoot, now: context.now });
  writeSseEvent(response, 'snapshot', {
    tokenId: context.tokenId,
    counts: initial.counts,
    totalRequests: initial.totalRequests,
  });

  let position = await getFileSize(remotePaths.events);
  const interval = setInterval(async () => {
    try {
      const nextSize = await getFileSize(remotePaths.events);
      if (nextSize <= position) {
        return;
      }
      const handle = await fs.open(remotePaths.events, 'r');
      try {
        const buffer = Buffer.alloc(nextSize - position);
        await handle.read(buffer, 0, buffer.length, position);
        position = nextSize;
        const lines = buffer.toString('utf8').split('\n').filter(Boolean);
        for (const line of lines) {
          writeSseEvent(response, 'remote', JSON.parse(line));
        }
      } finally {
        await handle.close();
      }
    } catch {
      // Drop file read errors; the connection will stay alive and retry.
    }
  }, 250);

  const heartbeat = setInterval(() => {
    response.write(': keepalive\n\n');
  }, 15000);

  const cleanup = () => {
    clearInterval(interval);
    clearInterval(heartbeat);
    response.end();
  };
  request.on('close', cleanup);
  response.on('close', cleanup);
}

function writeSseEvent(response, event, payload) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function getFileSize(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.size;
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return 0;
    }
    throw error;
  }
}

function parseOptionalInt(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function stripTrailingSlash(value) {
  return String(value ?? '').replace(/\/+$/, '');
}

function base64urlEncode(value) {
  return Buffer.from(String(value), 'utf8').toString('base64url');
}

function base64urlDecode(value) {
  return Buffer.from(String(value), 'base64url').toString('utf8');
}

function timingSafeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function createSecretToken() {
  return crypto.randomBytes(24).toString('base64url');
}

async function prepareRepo(cwd) {
  const repoRoot = await findRepoRoot(cwd ?? process.cwd());
  await ensureRemoteLayout(repoRoot);
  return repoRoot;
}

async function ensureRemoteLayout(repoRoot) {
  const paths = await ensureStateLayout(repoRoot);
  const remotePaths = getRemotePaths(repoRoot);
  await fs.mkdir(remotePaths.packetsDir, { recursive: true });
  await ensureJsonFile(remotePaths.requests, defaultRemoteState());
  await ensureJsonFile(remotePaths.auth, defaultRemoteAuthState());
  await ensureJsonFile(remotePaths.telegramState, defaultTelegramState());
  await ensureTextFile(remotePaths.events, '');
  return paths;
}

function getRemotePaths(repoRoot) {
  const remoteDir = getOpencodePaths(repoRoot).remoteDir;
  return {
    remoteDir,
    requests: path.join(remoteDir, 'requests.json'),
    events: path.join(remoteDir, 'events.ndjson'),
    auth: path.join(remoteDir, 'auth.json'),
    packetsDir: path.join(remoteDir, 'packets'),
    telegramState: path.join(remoteDir, 'telegram.json'),
  };
}

function toRemoteRelative(repoRoot, filePath) {
  return path.relative(repoRoot, filePath) || '.';
}

function fromRemoteRelative(repoRoot, relativePath) {
  return path.resolve(repoRoot, relativePath);
}

async function loadRemoteState(repoRoot) {
  const paths = getRemotePaths(repoRoot);
  const raw = await readJson(paths.requests, defaultRemoteState());
  return parseRemoteState(raw);
}

async function saveRemoteState(repoRoot, remoteState) {
  const paths = getRemotePaths(repoRoot);
  await writeJsonAtomic(paths.requests, parseRemoteState(remoteState));
}

async function ensureRemoteAuthState(repoRoot) {
  const authState = await loadRemoteAuthState(repoRoot);
  let changed = false;
  if (!authState.signingSecret) {
    authState.signingSecret = createSecretToken();
    changed = true;
  }
  if (!getDefaultBridgeToken(authState)) {
    authState.tokens.push(createBridgeTokenRecord('default', 'client', new Date().toISOString(), null, { role: 'default' }));
    changed = true;
  }
  if (changed) {
    await saveRemoteAuthState(repoRoot, authState);
  }
  return authState;
}

async function loadRemoteAuthState(repoRoot) {
  const paths = getRemotePaths(repoRoot);
  const raw = await readJson(paths.auth, defaultRemoteAuthState());
  const parsedTokens = Array.isArray(raw.tokens) ? raw.tokens.map(parseBridgeTokenRecord).filter(Boolean) : [];
  if (parsedTokens.length === 0 && typeof raw.apiToken === 'string' && raw.apiToken.trim()) {
    parsedTokens.push(createBridgeTokenRecord('default', 'client', new Date().toISOString(), null, {
      role: 'default',
      token: raw.apiToken.trim(),
    }));
  }
  return {
    version: REMOTE_AUTH_VERSION,
    signingSecret: typeof raw.signingSecret === 'string' && raw.signingSecret.trim() ? raw.signingSecret.trim() : '',
    tokens: parsedTokens,
  };
}

async function saveRemoteAuthState(repoRoot, authState) {
  const paths = getRemotePaths(repoRoot);
  await writeJsonAtomic(paths.auth, {
    version: REMOTE_AUTH_VERSION,
    signingSecret: authState.signingSecret,
    tokens: authState.tokens.map((entry) => ({
      tokenId: entry.tokenId,
      name: entry.name,
      role: entry.role,
      kind: entry.kind,
      token: entry.token,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      revokedAt: entry.revokedAt,
      lastUsedAt: entry.lastUsedAt,
    })),
  });
}

async function loadTelegramState(repoRoot) {
  const paths = getRemotePaths(repoRoot);
  const raw = await readJson(paths.telegramState, defaultTelegramState());
  return {
    version: TELEGRAM_STATE_VERSION,
    lastUpdateId: typeof raw.lastUpdateId === 'number' && Number.isInteger(raw.lastUpdateId) ? raw.lastUpdateId : 0,
  };
}

async function saveTelegramState(repoRoot, telegramState) {
  const paths = getRemotePaths(repoRoot);
  await writeJsonAtomic(paths.telegramState, {
    version: TELEGRAM_STATE_VERSION,
    lastUpdateId: telegramState.lastUpdateId,
  });
}

async function appendRemoteEvent(repoRoot, eventType, payload) {
  const paths = getRemotePaths(repoRoot);
  await fs.appendFile(paths.events, `${JSON.stringify({ at: new Date().toISOString(), event: eventType, payload })}\n`, 'utf8');
  return paths.events;
}

function defaultRemoteState() {
  return {
    version: REMOTE_STATE_VERSION,
    requests: [],
  };
}

function defaultRemoteAuthState() {
  return {
    version: REMOTE_AUTH_VERSION,
    signingSecret: createSecretToken(),
    tokens: [createBridgeTokenRecord('default', 'client', new Date().toISOString(), null, { role: 'default' })],
  };
}

function defaultTelegramState() {
  return {
    version: TELEGRAM_STATE_VERSION,
    lastUpdateId: 0,
  };
}

function createBridgeTokenRecord(name, kind, createdAt, expiresAt = null, options = {}) {
  return {
    tokenId: createStableId('bridge_token'),
    name,
    role: options.role ?? 'named',
    kind,
    token: options.token ?? createSecretToken(),
    createdAt,
    expiresAt,
    revokedAt: null,
    lastUsedAt: null,
  };
}

function parseBridgeTokenRecord(value) {
  if (!isPlainObject(value)) {
    return null;
  }
  const tokenId = typeof value.tokenId === 'string' && value.tokenId.trim() ? value.tokenId.trim() : createStableId('bridge_token');
  const token = typeof value.token === 'string' && value.token.trim() ? value.token.trim() : null;
  if (!token) {
    return null;
  }

  return {
    tokenId,
    name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : tokenId,
    role: value.role === 'default' ? 'default' : 'named',
    kind: value.kind === 'session' ? 'session' : 'client',
    token,
    createdAt: normalizeIso(value.createdAt),
    expiresAt: normalizeNullableIso(value.expiresAt),
    revokedAt: normalizeNullableIso(value.revokedAt),
    lastUsedAt: normalizeNullableIso(value.lastUsedAt),
  };
}

function summarizeBridgeToken(entry) {
  return {
    tokenId: entry.tokenId,
    name: entry.name,
    role: entry.role,
    kind: entry.kind,
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
    revokedAt: entry.revokedAt,
    lastUsedAt: entry.lastUsedAt,
  };
}

function getDefaultBridgeToken(authState) {
  return authState.tokens.find((entry) => entry.role === 'default' && !entry.revokedAt && !isExpiredToken(entry, new Date().toISOString())) ?? null;
}

function findAuthorizedBridgeToken(authState, tokenValue, now) {
  return authState.tokens.find((entry) => (
    !entry.revokedAt &&
    !isExpiredToken(entry, now) &&
    timingSafeEqual(entry.token, tokenValue)
  )) ?? null;
}

function isExpiredToken(entry, now) {
  return Boolean(entry.expiresAt) && new Date(entry.expiresAt).getTime() < new Date(now).getTime();
}

function parseRemoteState(value) {
  const input = isPlainObject(value) ? value : defaultRemoteState();
  const requests = Array.isArray(input.requests) ? input.requests.map(parseRemoteRequest) : [];

  return {
    version: REMOTE_STATE_VERSION,
    requests,
  };
}

function parseRemoteRequest(value) {
  if (!isPlainObject(value)) {
    throw new Error('Invalid remote request record: expected object.');
  }

  const status = typeof value.status === 'string' && REMOTE_REQUEST_STATUSES.has(value.status)
    ? value.status
    : 'awaiting_approval';

  return {
    ...createRemoteRequest({
      remoteRequestId: typeof value.remoteRequestId === 'string' && value.remoteRequestId.trim() ? value.remoteRequestId : undefined,
      status,
      createdAt: normalizeIso(value.createdAt),
      prompt: typeof value.prompt === 'string' ? value.prompt.trim() : '',
    }),
    updatedAt: normalizeIso(value.updatedAt ?? value.createdAt),
    kind: typeof value.kind === 'string' && value.kind.trim() ? value.kind.trim() : 'job',
    requestedBy: typeof value.requestedBy === 'string' && value.requestedBy.trim() ? value.requestedBy.trim() : 'remote',
    approvalRequired: value.approvalRequired !== false,
    approvedAt: normalizeNullableIso(value.approvedAt),
    revokedAt: normalizeNullableIso(value.revokedAt),
    jobId: typeof value.jobId === 'string' && value.jobId.trim() ? value.jobId.trim() : null,
    runId: typeof value.runId === 'string' && value.runId.trim() ? value.runId.trim() : null,
    packetPath: typeof value.packetPath === 'string' && value.packetPath.trim() ? value.packetPath.trim() : null,
    packetPack: typeof value.packetPack === 'string' && value.packetPack.trim() ? value.packetPack.trim() : null,
    packetInvocationId: typeof value.packetInvocationId === 'string' && value.packetInvocationId.trim() ? value.packetInvocationId.trim() : null,
  };
}

function detectRemoteKind(prompt, explicitKind) {
  if (typeof explicitKind === 'string' && explicitKind.trim()) {
    return explicitKind.trim();
  }

  const trimmed = prompt.trim();
  if (trimmed.startsWith('/review ') || trimmed === '/review' || trimmed.startsWith('/review-remote ') || trimmed === '/review-remote') {
    return 'review';
  }

  return 'job';
}

function stripReviewCommand(prompt) {
  return prompt
    .replace(/^\/review-remote\s+/, '')
    .replace(/^\/review\s+/, '')
    .trim() || prompt.trim();
}

function sortByNewest(left, right) {
  return right.createdAt.localeCompare(left.createdAt);
}

function normalizeIso(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();
}

function normalizeNullableIso(value) {
  if (!value) {
    return null;
  }
  return normalizeIso(value);
}

function toIso(value) {
  return normalizeIso(value ?? new Date().toISOString());
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function ensureJsonFile(filePath, value) {
  try {
    await fs.access(filePath);
  } catch {
    await writeJsonAtomic(filePath, value);
  }
}

async function ensureTextFile(filePath, value) {
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, value, 'utf8');
  }
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.tmp.${process.pid}`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, filePath);
}
