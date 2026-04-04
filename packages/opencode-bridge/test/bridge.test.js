import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ensureStateLayout, loadConfig, loadNotifications, saveConfig } from '../../opencode-core/src/index.js';
import { jobsShow, runnerOnce } from '../../opencode-kairos/src/index.js';

import {
  remoteApprove,
  remoteEnqueue,
  remoteRevoke,
  remoteStatus,
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
