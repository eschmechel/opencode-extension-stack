import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ensureStateLayout, getOpencodePaths } from '../packages/opencode-core/src/index.js';
import { remoteApprove, remoteEnqueue, remoteStatus } from '../packages/opencode-bridge/src/index.js';
import { jobsShow, runnerOnce } from '../packages/opencode-kairos/src/index.js';
import { memoryAdd, memoryShow } from '../packages/opencode-memory/src/index.js';
import {
  completePackInvocation,
  executePack,
  listPackHistory,
  showPackInvocation,
} from '../packages/opencode-packs/src/index.js';

async function createTempRepo() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-integration-'));
  await fs.mkdir(path.join(repoRoot, '.git'));
  await ensureStateLayout(repoRoot);
  return repoRoot;
}

test('review-remote pack execution and completion persist a durable handoff lifecycle', async () => {
  const repoRoot = await createTempRepo();

  const invocation = await executePack('review-remote', {
    request: 'Review release branch changes before remote approval.',
    context: 'This should produce a packet suitable for async approval.',
    constraints: ['Find blocking issues first'],
  }, {
    cwd: repoRoot,
    channel: 'remote',
    now: '2026-04-04T16:00:00.000Z',
  });

  const completed = await completePackInvocation(invocation.invocationId, {
    approval: 'changes_requested',
    blockingFindings: ['Rollback notes are missing from the release review packet.'],
    nonBlockingFindings: ['Clarify which diff snapshot the approver should inspect.'],
    handoff: {
      summary: 'One blocking issue must be resolved before remote approval.',
      nextActions: ['Add rollback notes', 'Refresh the remote review packet'],
      remoteNotes: ['Keep the updated packet linked to the approval thread.'],
    },
  }, {
    cwd: repoRoot,
    now: '2026-04-04T16:01:00.000Z',
  });

  const shown = await showPackInvocation(invocation.invocationId, { cwd: repoRoot });
  const history = await listPackHistory({ cwd: repoRoot, limit: 10, packName: 'review-remote' });
  const invocationJson = JSON.parse(await fs.readFile(invocation.invocationPath, 'utf8'));

  assert.equal(invocation.channel, 'remote');
  assert.match(invocation.handoff.suggestedCommand, /--channel remote/);
  assert.equal(completed.status, 'completed');
  assert.equal(shown.completion.valid, true);
  assert.equal(shown.completion.output.approval, 'changes_requested');
  assert.equal(history.entries.length, 2);
  assert.equal(history.entries[0].action, 'complete');
  assert.equal(history.entries[1].action, 'execute');
  assert.equal(invocationJson.packName, 'review-remote');
});

test('remote review can be approved, executed by Kairos, and captured into skeptical memory', async () => {
  const repoRoot = await createTempRepo();
  const request = await remoteEnqueue('/review inspect current diff for release readiness', {
    cwd: repoRoot,
    requestedBy: 'integration-suite',
    now: '2026-04-04T16:10:00.000Z',
  });

  assert.equal(request.effectiveStatus, 'awaiting_approval');
  assert.equal(request.kind, 'review');
  assert.equal(request.packetPack, 'review-remote');
  assert.notEqual(request.packetPath, null);

  const packet = JSON.parse(await fs.readFile(request.packetPath, 'utf8'));
  assert.equal(packet.remoteRequestId, request.remoteRequestId);
  assert.equal(packet.rendered.pack.name, 'review-remote');

  const approved = await remoteApprove(request.remoteRequestId, {
    cwd: repoRoot,
    now: '2026-04-04T16:11:00.000Z',
  });

  assert.equal(approved.effectiveStatus, 'queued');
  assert.notEqual(approved.jobId, null);
  assert.notEqual(approved.runId, null);

  await runnerOnce({
    cwd: repoRoot,
    now: '2026-04-04T16:12:00.000Z',
    executeJob: async () => ({
      command: 'opencode',
      args: ['run', approved.prompt],
      exitCode: 0,
      stdout: 'review completed with one blocking finding',
      stderr: '',
    }),
  });

  const remote = await remoteStatus(request.remoteRequestId, { cwd: repoRoot });
  const job = await jobsShow(approved.jobId, { cwd: repoRoot });

  assert.equal(remote.request.effectiveStatus, 'completed');
  assert.equal(job.status, 'completed');
  assert.equal(remote.request.runId, approved.runId);
  assert.equal(typeof remote.request.resultPath, 'string');

  const memory = await memoryAdd('Remote review completed after approval and produced a durable run artifact.', {
    cwd: repoRoot,
    topic: 'Remote Review',
    runId: approved.runId,
    now: '2026-04-04T16:13:00.000Z',
  });

  const topicView = await memoryShow('Remote Review', { cwd: repoRoot });
  const paths = getOpencodePaths(repoRoot);

  assert.equal(memory.entry.evidence[0].kind, 'run');
  assert.equal(memory.entry.evidence[0].runId, approved.runId);
  assert.equal(topicView.entries.length, 1);
  assert.equal(topicView.entries[0].summary, 'Remote review completed after approval and produced a durable run artifact.');
  assert.match(topicView.topicPath, /remote-review\.json$/);
  assert.equal(typeof (await fs.readFile(path.join(paths.runsDir, approved.runId, 'result.json'), 'utf8')), 'string');
});
