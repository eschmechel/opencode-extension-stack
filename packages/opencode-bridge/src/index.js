import fs from 'node:fs/promises';
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
import { renderPack } from '../../opencode-packs/src/index.js';

const REMOTE_STATE_VERSION = 1;
const REMOTE_REQUEST_STATUSES = new Set(['awaiting_approval', 'queued', 'revoked']);

export async function remoteStatus(remoteRequestId = '', options = {}) {
  const repoRoot = await prepareRepo(options.cwd);
  const config = await loadConfig(repoRoot);
  const remoteState = await loadRemoteState(repoRoot);
  const jobsState = await loadJobsState(repoRoot);
  const requests = remoteState.requests
    .sort(sortByNewest)
    .map((request) => enrichRemoteRequest(repoRoot, request, jobsState));

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
    };

    if (request.kind === 'review') {
      const packet = await writeRemoteReviewPacket(repoRoot, request, nowIso);
      request.packetPath = packet.packetPath;
      request.packetPack = packet.packetPack;
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

    return enrichRemoteRequest(repoRoot, request, jobsState);
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

    return enrichRemoteRequest(repoRoot, request, jobsState);
  });
}

export async function remoteRevoke(remoteRequestId = '', options = {}) {
  const repoRoot = await prepareRepo(options.cwd);
  const nowIso = toIso(options.now);
  const trimmedRequestId = typeof remoteRequestId === 'string' ? remoteRequestId.trim() : '';

  return withRepoLock(repoRoot, async () => {
    const config = await loadConfig(repoRoot);
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
    }

    return {
      repoRoot,
      revoked,
      skipped,
    };
  });
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

function enrichRemoteRequest(repoRoot, request, jobsState) {
  const job = request.jobId ? jobsState.jobs.find((entry) => entry.jobId === request.jobId) ?? null : null;
  const effectiveStatus = request.status === 'revoked'
    ? 'revoked'
    : job?.status ?? request.status;
  const runDir = request.runId ? path.join(getOpencodePaths(repoRoot).runsDir, request.runId) : null;

  return {
    ...request,
    effectiveStatus,
    jobStatus: job?.status ?? null,
    job,
    packetPath: request.packetPath ? fromRemoteRelative(repoRoot, request.packetPath) : null,
    packetPack: request.packetPack,
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
  const rendered = renderPack('review-remote', { request: normalizedRequest });
  const packetPath = path.join(packetDir, `${request.remoteRequestId}.json`);
  await writeJsonAtomic(packetPath, {
    remoteRequestId: request.remoteRequestId,
    createdAt: nowIso,
    kind: request.kind,
    requestedBy: request.requestedBy,
    prompt: request.prompt,
    rendered,
  });

  return {
    packetPath: toRemoteRelative(repoRoot, packetPath),
    packetPack: 'review-remote',
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

async function prepareRepo(cwd) {
  const repoRoot = await findRepoRoot(cwd ?? process.cwd());
  await ensureRemoteLayout(repoRoot);
  return repoRoot;
}

async function ensureRemoteLayout(repoRoot) {
  const paths = await ensureStateLayout(repoRoot);
  await ensureJsonFile(getRemotePaths(repoRoot).requests, defaultRemoteState());
  await ensureTextFile(getRemotePaths(repoRoot).events, '');
  return paths;
}

function getRemotePaths(repoRoot) {
  const remoteDir = getOpencodePaths(repoRoot).remoteDir;
  return {
    remoteDir,
    requests: path.join(remoteDir, 'requests.json'),
    events: path.join(remoteDir, 'events.ndjson'),
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
