import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ensureStateLayout, getOpencodePaths } from '../packages/opencode-core/src/index.js';
import { remoteApprove, remoteEnqueue, remoteStatus } from '../packages/opencode-bridge/src/index.js';
import { jobsShow, queueAdd, runnerOnce } from '../packages/opencode-kairos/src/index.js';
import { memoryAdd, memoryRepair, memoryShow } from '../packages/opencode-memory/src/index.js';
import {
  runWorkerLoop,
  teamCreate,
  teamMemoryCompact,
  teamMemoryContradictions,
  teamMemorySearch,
  teamMemoryShow,
  teamMemoryStale,
  teamTemplateSave,
  workerShow,
  workerStop,
} from '../packages/opencode-orchestrator/src/index.js';
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

test('template-launched teams can produce worker-backed team memory and contradiction checks', async () => {
  const repoRoot = await createTempRepo();
  await teamTemplateSave('policy-template', {
    cwd: repoRoot,
    now: '2026-04-04T16:20:00.000Z',
    count: 2,
    prompt: 'investigate protected branch policy',
    maxConcurrentWorkers: 2,
  });

  const team = await teamCreate(undefined, '', {
    cwd: repoRoot,
    now: '2026-04-04T16:21:00.000Z',
    templateName: 'policy-template',
    spawnWorkerProcess: () => ({ pid: process.pid }),
  });

  const outputs = new Map([
    [team.workers[0].workerId, 'allow protected branch unattended edits after approval'],
    [team.workers[1].workerId, 'deny protected branch unattended edits after approval'],
  ]);

  const loops = team.workers.map((worker) => runWorkerLoop({
    repoRoot,
    workerId: worker.workerId,
    workerToken: worker.workerToken,
    executePrompt: async () => ({
      exitCode: 0,
      stdout: outputs.get(worker.workerId),
      stderr: '',
    }),
  }));

  for (const worker of team.workers) {
    await waitFor(async () => {
      const shown = await workerShow(worker.workerId, { cwd: repoRoot });
      return shown.runCount >= 1;
    });
    await workerStop(worker.workerId, { cwd: repoRoot, now: '2026-04-04T16:22:00.000Z' });
  }
  await Promise.all(loops);

  await memoryAdd('Allow protected branch unattended edits after approval.', {
    cwd: repoRoot,
    teamId: team.teamId,
    topic: 'Protected Branch Policy',
    workerId: team.workers[0].workerId,
    now: '2026-04-04T16:23:00.000Z',
  });
  await memoryAdd('Deny protected branch unattended edits after approval.', {
    cwd: repoRoot,
    teamId: team.teamId,
    topic: 'Protected Branch Policy',
    workerId: team.workers[1].workerId,
    now: '2026-04-04T16:24:00.000Z',
  });

  const shown = await teamMemoryShow(team.teamId, 'Protected Branch Policy', { cwd: repoRoot });
  const search = await teamMemorySearch(team.teamId, 'protected branch', { cwd: repoRoot });
  const contradictions = await teamMemoryContradictions(team.teamId, { cwd: repoRoot });

  assert.equal(team.templateName, 'policy-template');
  assert.equal(shown.summary.entryCount, 2);
  assert.equal(search.count, 2);
  assert.equal(contradictions.count, 1);
  assert.equal(contradictions.contradictionAlerts[0].topic, 'protected-branch-policy');
});

test('stale team memory can be repaired from a real worker run after a Kairos-backed note goes stale', async () => {
  const repoRoot = await createTempRepo();
  const team = await teamCreate(1, 'repair stale incident memory', {
    cwd: repoRoot,
    now: '2026-04-04T16:30:00.000Z',
    spawnWorkerProcess: () => ({ pid: process.pid }),
  });

  const queued = await queueAdd('capture incident memory seed', {
    cwd: repoRoot,
    now: '2026-04-04T16:31:00.000Z',
  });
  await runnerOnce({
    cwd: repoRoot,
    now: '2026-04-04T16:32:00.000Z',
    executeJob: async () => ({
      command: 'opencode',
      args: ['run', queued.prompt],
      exitCode: 0,
      stdout: 'initial incident note',
      stderr: '',
    }),
  });

  const added = await memoryAdd('Incident note captured from unattended queue execution.', {
    cwd: repoRoot,
    teamId: team.teamId,
    topic: 'Incident Memory',
    runId: queued.runId,
    now: '2026-04-04T16:33:00.000Z',
  });

  const paths = getOpencodePaths(repoRoot);
  await fs.rm(path.join(paths.runsDir, queued.runId, 'result.json'));
  await teamMemoryCompact(team.teamId, { cwd: repoRoot, now: '2026-04-04T16:33:30.000Z' });

  let stale = await teamMemoryStale(team.teamId, { cwd: repoRoot, repairableOnly: true });
  assert.equal(stale.count, 1);
  assert.equal(stale.entries[0].memoryId, added.entry.memoryId);

  const worker = team.workers[0];
  const loop = runWorkerLoop({
    repoRoot,
    workerId: worker.workerId,
    workerToken: worker.workerToken,
    executePrompt: async () => ({
      exitCode: 0,
      stdout: 'fresh repaired worker-backed incident note',
      stderr: '',
    }),
  });
  await waitFor(async () => {
    const shown = await workerShow(worker.workerId, { cwd: repoRoot });
    return shown.runCount >= 1;
  });
  await workerStop(worker.workerId, { cwd: repoRoot, now: '2026-04-04T16:34:00.000Z' });
  await loop;

  const repaired = await memoryRepair(added.entry.memoryId, {
    cwd: repoRoot,
    teamId: team.teamId,
    workerId: worker.workerId,
    summary: 'Incident note refreshed from team worker evidence.',
    now: '2026-04-04T16:35:00.000Z',
  });

  const shown = await teamMemoryShow(team.teamId, 'Incident Memory', { cwd: repoRoot });
  stale = await teamMemoryStale(team.teamId, { cwd: repoRoot, repairableOnly: true });

  assert.equal(repaired.repaired.repairedFromMemoryId, added.entry.memoryId);
  assert.equal(shown.summary.entryCount, 2);
  assert.equal(shown.summary.activeCount, 1);
  assert.equal(shown.entries.some((entry) => entry.summary === 'Incident note refreshed from team worker evidence.'), true);
  assert.equal(stale.count, 0);
});

async function waitFor(check, timeoutMs = 5_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for condition.');
}
