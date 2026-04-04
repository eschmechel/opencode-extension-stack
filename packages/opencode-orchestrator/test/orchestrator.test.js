import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { getOpencodePaths, loadConfig, saveConfig } from '../../opencode-core/src/index.js';

import {
  parallelStart,
  retentionApply,
  retentionStatus,
  runWorkerLoop,
  teamArchive,
  teamCreate,
  teamDelete,
  teamList,
  teamMemoryCompact,
  teamMemoryContradictions,
  teamMemoryRebuild,
  teamMemorySearch,
  teamMemoryShow,
  teamMemoryStale,
  teamPrune,
  teamRerunFailed,
  teamShow,
  teamTemplateDelete,
  teamTemplateList,
  teamTemplateSave,
  teamTemplateShow,
  workerArchive,
  workerList,
  workerPrune,
  workerRestart,
  workerShow,
  workerStart,
  workerSteer,
  workerStop,
} from '../src/index.js';

async function createTempRepo() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-orchestrator-'));
  await fs.mkdir(path.join(repoRoot, '.git'));
  return repoRoot;
}

test.after(async () => {
  const entries = await fs.readdir(os.tmpdir()).catch(() => []);
  for (const entry of entries) {
    if (entry.startsWith('opencode-orchestrator-')) {
      await fs.rm(path.join(os.tmpdir(), entry), { recursive: true, force: true }).catch(() => {});
    }
  }
});

test('workerStart creates inspectable worker state', async () => {
  const repoRoot = await createTempRepo();
  const now = new Date().toISOString();
  const worker = await workerStart('investigate repo status', {
    cwd: repoRoot,
    now,
    spawnWorkerProcess: () => ({ pid: 4242 }),
  });

  const list = await workerList({ cwd: repoRoot, now });
  const shown = await workerShow(worker.workerId, { cwd: repoRoot, now });

  assert.equal(list.length, 1);
  assert.equal(shown.workerId, worker.workerId);
  assert.equal(shown.pid, 4242);
  assert.equal(shown.status, 'starting');
});

test('teamCreate and parallelStart create grouped workers', async () => {
  const repoRoot = await createTempRepo();
  const now = new Date().toISOString();
  const team = await teamCreate(2, 'investigate repo status', {
    cwd: repoRoot,
    now,
    maxConcurrentWorkers: 1,
    spawnWorkerProcess: () => ({ pid: process.pid }),
  });

  const parallel = await parallelStart(1, 'secondary task', {
    cwd: repoRoot,
    now,
    spawnWorkerProcess: () => ({ pid: process.pid }),
  });

  const teams = await teamList({ cwd: repoRoot, now });
  assert.equal(team.workerIds.length, 2);
  assert.equal(parallel.workerIds.length, 1);
  assert.equal(teams.length, 2);

  const shown = await teamShow(team.teamId, { cwd: repoRoot, now });
  assert.equal(shown.workers.length, 2);
  assert.equal(shown.maxConcurrentWorkers, 1);
  assert.equal(shown.counts.blocked >= 1, true);
});

test('team templates can be saved, listed, shown, used, and deleted', async () => {
  const repoRoot = await createTempRepo();
  const now = new Date().toISOString();

  const saved = await teamTemplateSave('review-template', {
    cwd: repoRoot,
    now,
    count: 2,
    prompt: 'review current branch changes',
    name: 'Review Template',
    description: 'default review fanout',
    maxConcurrentWorkers: 1,
    maxTotalRuns: 3,
  });

  const shownTemplate = await teamTemplateShow('review-template', { cwd: repoRoot });
  const listedTemplates = await teamTemplateList({ cwd: repoRoot });
  assert.equal(saved.templateName, 'review-template');
  assert.equal(shownTemplate.requestedCount, 2);
  assert.equal(listedTemplates.length, 1);

  const team = await teamCreate(undefined, '', {
    cwd: repoRoot,
    now,
    templateName: 'review-template',
    spawnWorkerProcess: () => ({ pid: process.pid }),
  });

  assert.equal(team.templateName, 'review-template');
  assert.equal(team.workerIds.length, 2);
  assert.equal(team.maxConcurrentWorkers, 1);
  assert.equal(team.maxTotalRuns, 3);
  assert.equal(team.prompt, 'review current branch changes');

  const deleted = await teamTemplateDelete('review-template', { cwd: repoRoot });
  assert.equal(deleted.templateName, 'review-template');
  assert.equal((await teamTemplateList({ cwd: repoRoot })).length, 0);
});

test('teamShow exposes per-team memory namespace summary', async () => {
  const repoRoot = await createTempRepo();
  const now = new Date().toISOString();
  const team = await teamCreate(1, 'memory aware task', {
    cwd: repoRoot,
    now,
    spawnWorkerProcess: () => ({ pid: process.pid }),
  });

  const paths = getOpencodePaths(repoRoot);
  const memoryDir = path.join(paths.memoryTeamDir, team.teamId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''));
  await fs.mkdir(path.join(memoryDir, 'topics'), { recursive: true });
  await fs.writeFile(path.join(memoryDir, 'MEMORY.md'), '# MEMORY\n', 'utf8');
  await fs.writeFile(
    path.join(memoryDir, 'topics', 'queue.json'),
    `${JSON.stringify({
      version: 1,
      topic: 'queue',
      createdAt: now,
      updatedAt: now,
      entries: [
        { memoryId: 'memory_one', topic: 'queue', summary: 'active note', createdAt: now, updatedAt: now, stale: false, staleReason: null, evidence: [] },
        { memoryId: 'memory_two', topic: 'queue', summary: 'stale note', createdAt: now, updatedAt: now, stale: true, staleReason: 'missing_run_result', evidence: [] },
      ],
    }, null, 2)}\n`,
    'utf8',
  );

  const shown = await teamShow(team.teamId, { cwd: repoRoot, now });
  assert.equal(shown.memory.namespace, team.teamId);
  assert.match(shown.memory.indexPath, /memory\/team\/.*\/MEMORY\.md$/);
  assert.equal(shown.memory.topicCount, 1);
  assert.equal(shown.memory.entryCount, 2);
  assert.equal(shown.memory.activeCount, 1);
  assert.equal(shown.memory.staleCount, 1);
});

test('team memory helpers expose team-scoped memory workflows', async () => {
  const repoRoot = await createTempRepo();
  const now = new Date().toISOString();
  const team = await teamCreate(1, 'memory team task', {
    cwd: repoRoot,
    now,
    spawnWorkerProcess: () => ({ pid: process.pid }),
  });

  const { memoryAdd } = await import('../../opencode-memory/src/index.js');
  const paths = getOpencodePaths(repoRoot);

  const runIds = ['team_memory_one', 'team_memory_two'];
  for (const runId of runIds) {
    const runDir = path.join(paths.runsDir, runId);
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, 'stdout.txt'), '', 'utf8');
    await fs.writeFile(path.join(runDir, 'stderr.txt'), '', 'utf8');
    await fs.writeFile(path.join(runDir, 'events.ndjson'), '', 'utf8');
    await fs.writeFile(path.join(runDir, 'result.json'), `${JSON.stringify({ exitCode: 0 }, null, 2)}\n`, 'utf8');
  }

  await memoryAdd('Allow unattended edits in protected branch workflows.', {
    cwd: repoRoot,
    teamId: team.teamId,
    topic: 'Policy',
    runId: 'team_memory_one',
  });
  await memoryAdd('Deny unattended edits in protected branch workflows.', {
    cwd: repoRoot,
    teamId: team.teamId,
    topic: 'Policy',
    runId: 'team_memory_two',
  });

  const shown = await teamMemoryShow(team.teamId, '', { cwd: repoRoot, now });
  const search = await teamMemorySearch(team.teamId, 'protected branch', { cwd: repoRoot, now });
  const contradictions = await teamMemoryContradictions(team.teamId, { cwd: repoRoot, now });
  const rebuilt = await teamMemoryRebuild(team.teamId, { cwd: repoRoot, now });
  const compacted = await teamMemoryCompact(team.teamId, { cwd: repoRoot, now });
  const stale = await teamMemoryStale(team.teamId, { cwd: repoRoot, now });

  assert.equal(shown.scope, 'index');
  assert.equal(search.count, 2);
  assert.equal(contradictions.count, 1);
  assert.equal(rebuilt.contradictionAlerts.length, 1);
  assert.match(compacted.indexPath, /memory\/team\/.*\/MEMORY\.md$/);
  assert.equal(stale.count, 0);
});

test('runWorkerLoop processes initial and steered prompts then stops cleanly', async () => {
  const repoRoot = await createTempRepo();
  const worker = await workerStart('first task', {
    cwd: repoRoot,
    now: '2026-04-04T09:00:00.000Z',
    spawnWorkerProcess: () => ({ pid: 7777 }),
  });

  const seenPrompts = [];
  const loopPromise = runWorkerLoop({
    repoRoot,
    workerId: worker.workerId,
    workerToken: worker.workerToken,
    executePrompt: async ({ prompt }) => {
      seenPrompts.push(prompt);
      return {
        exitCode: 0,
        stdout: `handled ${prompt}`,
        stderr: '',
      };
    },
  });

  await waitFor(async () => {
    const shown = await workerShow(worker.workerId, { cwd: repoRoot });
    return shown.runCount >= 1;
  });

  await workerSteer(worker.workerId, 'second task', { cwd: repoRoot });

  await waitFor(async () => {
    const shown = await workerShow(worker.workerId, { cwd: repoRoot });
    return shown.runCount >= 2;
  });

  await workerStop(worker.workerId, { cwd: repoRoot });
  await loopPromise;

  const shown = await workerShow(worker.workerId, { cwd: repoRoot });
  assert.deepEqual(seenPrompts, ['first task', 'second task']);
  assert.equal(shown.status, 'stopped');
  assert.equal(shown.runCount, 2);
});

test('workerRestart respawns a failed worker safely', async () => {
  const repoRoot = await createTempRepo();
  const worker = await workerStart('restartable task', {
    cwd: repoRoot,
    now: '2026-04-04T09:00:00.000Z',
    spawnWorkerProcess: () => ({ pid: 3333 }),
  });

  const failingLoop = runWorkerLoop({
    repoRoot,
    workerId: worker.workerId,
    workerToken: worker.workerToken,
    executePrompt: async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'worker failed',
    }),
  });

  await failingLoop;
  const failed = await workerShow(worker.workerId, { cwd: repoRoot });
  assert.equal(failed.status, 'failed');

  const restarted = await workerRestart(worker.workerId, {
    cwd: repoRoot,
    now: '2026-04-04T09:05:00.000Z',
    spawnWorkerProcess: () => ({ pid: 4444 }),
  });

  assert.equal(restarted.status, 'starting');
  assert.equal(restarted.pid, 4444);
  assert.notEqual(restarted.workerToken, worker.workerToken);
});

test('worker trust gate blocks readiness until supervised steering clears it', async () => {
  const repoRoot = await createTempRepo();
  const worker = await workerStart('needs approval', {
    cwd: repoRoot,
    now: '2026-04-04T09:00:00.000Z',
    spawnWorkerProcess: () => ({ pid: 9999 }),
  });

  let callCount = 0;
  const loopPromise = runWorkerLoop({
    repoRoot,
    workerId: worker.workerId,
    workerToken: worker.workerToken,
    executePrompt: async ({ prompt }) => {
      callCount += 1;
      if (callCount === 1) {
        return {
          exitCode: 0,
          stdout: '',
          stderr: '',
          trustGate: { state: 'required', message: `Review ${prompt}` },
        };
      }

      return {
        exitCode: 0,
        stdout: `handled ${prompt}`,
        stderr: '',
      };
    },
  });

  await waitFor(async () => {
    const shown = await workerShow(worker.workerId, { cwd: repoRoot });
    return shown.status === 'blocked';
  });

  const blocked = await workerShow(worker.workerId, { cwd: repoRoot });
  assert.equal(blocked.readyForPrompt, false);
  assert.equal(blocked.trustGateState, 'required');

  await workerSteer(worker.workerId, 'approved continuation', { cwd: repoRoot, now: '2026-04-04T09:01:00.000Z' });

  await waitFor(async () => {
    const shown = await workerShow(worker.workerId, { cwd: repoRoot });
    return shown.runCount >= 2;
  });

  await workerStop(worker.workerId, { cwd: repoRoot, now: '2026-04-04T09:02:00.000Z' });
  await loopPromise;

  const finished = await workerShow(worker.workerId, { cwd: repoRoot });
  assert.equal(finished.trustGateState, 'clear');
});

test('workerList recovers stale workers before reporting status', async () => {
  const repoRoot = await createTempRepo();
  const worker = await workerStart('stale worker', {
    cwd: repoRoot,
    now: '2026-04-04T09:00:00.000Z',
    spawnWorkerProcess: () => ({ pid: 8888 }),
  });

  const workerPath = path.join(repoRoot, '.opencode', 'workers', worker.workerId, 'worker.json');
  const content = JSON.parse(await fs.readFile(workerPath, 'utf8'));
  content.status = 'running';
  content.pid = 999999;
  content.heartbeatAt = '2026-04-04T09:00:00.000Z';
  await fs.writeFile(workerPath, `${JSON.stringify(content, null, 2)}\n`, 'utf8');

  const workers = await workerList({ cwd: repoRoot, now: '2026-04-04T09:02:00.000Z' });
  const stale = workers.find((entry) => entry.workerId === worker.workerId);
  assert.equal(stale.status, 'failed');
});

test('teamDelete marks team deleted and requests member shutdown', async () => {
  const repoRoot = await createTempRepo();
  const team = await teamCreate(2, 'cleanup team', {
    cwd: repoRoot,
    now: '2026-04-04T09:00:00.000Z',
    spawnWorkerProcess: () => ({ pid: 5555 }),
  });

  await teamDelete(team.teamId, { cwd: repoRoot, now: '2026-04-04T09:05:00.000Z' });
  const teams = await teamList({ cwd: repoRoot });
  const shown = teams.find((entry) => entry.teamId === team.teamId);
  assert.equal(shown.status, 'deleted');

  for (const workerId of team.workerIds) {
    const worker = await workerShow(workerId, { cwd: repoRoot });
    assert.equal(worker.stopRequested, true);
  }
});

test('teamRerunFailed restarts failed branches and requeues their prompt', async () => {
  const repoRoot = await createTempRepo();
  const team = await teamCreate(1, 'repair branch', {
    cwd: repoRoot,
    now: '2026-04-04T09:00:00.000Z',
    spawnWorkerProcess: () => ({ pid: 1212 }),
  });

  const worker = await workerShow(team.workerIds[0], { cwd: repoRoot, now: '2026-04-04T09:00:00.000Z' });
  await runWorkerLoop({
    repoRoot,
    workerId: worker.workerId,
    workerToken: worker.workerToken,
    executePrompt: async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'branch failed',
    }),
  });

  const rerun = await teamRerunFailed(team.teamId, {
    cwd: repoRoot,
    now: '2026-04-04T09:05:00.000Z',
    spawnWorkerProcess: () => ({ pid: 1313 }),
  });

  const restarted = await workerShow(worker.workerId, { cwd: repoRoot, now: '2026-04-04T09:05:00.000Z' });
  assert.equal(rerun.rerunWorkers.length, 1);
  assert.equal(restarted.status, 'starting');
  assert.equal(restarted.pendingPromptCount >= 1, true);
});

test('teamRerunFailed respects max total runs budget', async () => {
  const repoRoot = await createTempRepo();
  const team = await teamCreate(1, 'budgeted branch', {
    cwd: repoRoot,
    now: '2026-04-04T09:00:00.000Z',
    maxTotalRuns: 1,
    spawnWorkerProcess: () => ({ pid: 1212 }),
  });

  const worker = await workerShow(team.workerIds[0], { cwd: repoRoot, now: '2026-04-04T09:00:00.000Z' });
  await runWorkerLoop({
    repoRoot,
    workerId: worker.workerId,
    workerToken: worker.workerToken,
    executePrompt: async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'branch failed',
    }),
  });

  const rerun = await teamRerunFailed(team.teamId, {
    cwd: repoRoot,
    now: '2026-04-04T09:05:00.000Z',
    spawnWorkerProcess: () => ({ pid: 1313 }),
  });

  assert.equal(rerun.rerunWorkers.length, 0);
});

test('workerArchive and workerPrune preserve artifacts before pruning', async () => {
  const repoRoot = await createTempRepo();
  const worker = await workerStart('archive worker', {
    cwd: repoRoot,
    now: '2026-04-04T09:00:00.000Z',
    spawnWorkerProcess: () => ({ pid: 2323 }),
  });

  await runWorkerLoop({
    repoRoot,
    workerId: worker.workerId,
    workerToken: worker.workerToken,
    executePrompt: async () => ({
      exitCode: 1,
      stdout: 'failed output',
      stderr: 'worker failed',
    }),
  });

  const archived = await workerArchive(worker.workerId, { cwd: repoRoot, now: '2026-04-04T09:10:00.000Z' });
  const pruned = await workerPrune(worker.workerId, { cwd: repoRoot, now: '2026-04-04T09:11:00.000Z' });

  assert.equal(archived.archiveCount >= 1, true);
  assert.equal(pruned.prunedAt !== null, true);
  assert.equal(await exists(path.join(pruned.lastArchivePath, 'worker.json')), true);
});

test('workerShow and teamShow expose supervision output previews', async () => {
  const repoRoot = await createTempRepo();
  const team = await teamCreate(1, 'preview team', {
    cwd: repoRoot,
    now: '2026-04-04T09:00:00.000Z',
    spawnWorkerProcess: () => ({ pid: 7878 }),
  });

  const worker = await workerShow(team.workerIds[0], { cwd: repoRoot, now: '2026-04-04T09:00:00.000Z' });
  const loopPromise = runWorkerLoop({
    repoRoot,
    workerId: worker.workerId,
    workerToken: worker.workerToken,
    executePrompt: async () => ({
      exitCode: 0,
      stdout: 'preview output line',
      stderr: '',
    }),
  });

  await waitFor(async () => {
    const shown = await workerShow(worker.workerId, { cwd: repoRoot });
    return shown.runCount >= 1;
  });

  await workerStop(worker.workerId, { cwd: repoRoot });
  await loopPromise;

  const shownWorker = await workerShow(worker.workerId, { cwd: repoRoot, now: '2026-04-04T09:01:00.000Z' });
  const shownTeam = await teamShow(team.teamId, { cwd: repoRoot, now: '2026-04-04T09:01:00.000Z' });

  assert.match(shownWorker.stdoutTail, /preview output line/);
  assert.equal(shownTeam.synthesis.previews.length >= 1, true);
});

test('teamArchive and teamPrune preserve synthesized state and prune terminal workers', async () => {
  const repoRoot = await createTempRepo();
  const team = await teamCreate(1, 'archive team', {
    cwd: repoRoot,
    now: '2026-04-04T09:00:00.000Z',
    spawnWorkerProcess: () => ({ pid: 4545 }),
  });

  const worker = await workerShow(team.workerIds[0], { cwd: repoRoot, now: '2026-04-04T09:00:00.000Z' });
  await runWorkerLoop({
    repoRoot,
    workerId: worker.workerId,
    workerToken: worker.workerToken,
    executePrompt: async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'worker failed',
    }),
  });

  const archived = await teamArchive(team.teamId, { cwd: repoRoot, now: '2026-04-04T09:20:00.000Z' });
  const pruned = await teamPrune(team.teamId, { cwd: repoRoot, now: '2026-04-04T09:21:00.000Z' });

  assert.equal(archived.archiveCount >= 1, true);
  assert.equal(pruned.prunedAt !== null, true);
  assert.equal(await exists(pruned.lastArchivePath), true);
});

test('retentionApply auto-prunes and compacts terminal worker and team artifacts from config', async () => {
  const repoRoot = await createTempRepo();
  const team = await teamCreate(1, 'retention team', {
    cwd: repoRoot,
    now: '2026-04-04T09:00:00.000Z',
    spawnWorkerProcess: () => ({ pid: 5656 }),
  });

  const worker = await workerShow(team.workerIds[0], { cwd: repoRoot, now: '2026-04-04T09:00:00.000Z' });
  await runWorkerLoop({
    repoRoot,
    workerId: worker.workerId,
    workerToken: worker.workerToken,
    executePrompt: async () => ({
      exitCode: 1,
      stdout: 'failed output',
      stderr: 'worker failed',
    }),
  });

  const config = await loadConfig(repoRoot);
  config.retention.workers.autoPruneAfterDays = 0;
  config.retention.teams.autoPruneAfterDays = 0;
  await saveConfig(repoRoot, config);

  const result = await retentionApply({ cwd: repoRoot, now: '2026-04-04T09:10:00.000Z' });
  assert.equal(result.actions.teamsPruned >= 1, true);

  const prunedWorker = await workerShow(worker.workerId, { cwd: repoRoot, now: '2026-04-04T09:10:00.000Z' });
  const prunedTeam = await teamShow(team.teamId, { cwd: repoRoot, now: '2026-04-04T09:10:00.000Z' });
  assert.equal(prunedWorker.prunedAt !== null, true);
  assert.equal(prunedTeam.prunedAt !== null, true);
  assert.equal((await fs.readdir(prunedWorker.lastArchivePath)).some((name) => name.endsWith('.gz')), true);
  assert.equal(prunedTeam.lastArchivePath.endsWith('.gz'), true);
});

test('retentionApply rotates old worker archives only when deletion is policy-approved', async () => {
  const repoRoot = await createTempRepo();
  const worker = await workerStart('rotate worker', {
    cwd: repoRoot,
    now: '2026-04-04T09:00:00.000Z',
    spawnWorkerProcess: () => ({ pid: 6767 }),
  });

  await runWorkerLoop({
    repoRoot,
    workerId: worker.workerId,
    workerToken: worker.workerToken,
    executePrompt: async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'worker failed',
    }),
  });

  await workerArchive(worker.workerId, { cwd: repoRoot, now: '2026-04-04T09:10:00.000Z' });
  await workerArchive(worker.workerId, { cwd: repoRoot, now: '2026-04-04T09:11:00.000Z' });

  const config = await loadConfig(repoRoot);
  config.retention.workers.maxArchiveEntries = 1;
  config.retention.workers.allowDeleteArchived = true;
  await saveConfig(repoRoot, config);

  const before = await retentionStatus({ cwd: repoRoot, now: '2026-04-04T09:12:00.000Z' });
  assert.equal(before.workers.deletableArchives >= 1, true);

  const applied = await retentionApply({ cwd: repoRoot, now: '2026-04-04T09:12:00.000Z' });
  assert.equal(applied.actions.workerArchivesDeleted >= 1, true);
});

async function waitFor(check) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await check()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error('Timed out waiting for worker condition.');
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
