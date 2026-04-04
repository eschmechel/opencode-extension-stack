import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ensureStateLayout, getOpencodePaths, loadConfig, saveConfig } from '../../opencode-core/src/index.js';

import {
  memoryAdd,
  memoryCompact,
  memoryMergeApply,
  memoryRepair,
  memoryRebuild,
  memorySearch,
  memoryStale,
  memoryShow,
} from '../src/index.js';

async function createTempRepo() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-memory-'));
  await fs.mkdir(path.join(repoRoot, '.git'));
  await ensureStateLayout(repoRoot);
  return repoRoot;
}

async function writeRunArtifact(repoRoot, runId, options = {}) {
  const paths = getOpencodePaths(repoRoot);
  const runDir = path.join(paths.runsDir, runId);
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, 'stdout.txt'), options.stdout ?? '', 'utf8');
  await fs.writeFile(path.join(runDir, 'stderr.txt'), options.stderr ?? '', 'utf8');
  await fs.writeFile(path.join(runDir, 'events.ndjson'), '', 'utf8');
  await fs.writeFile(
    path.join(runDir, 'result.json'),
    `${JSON.stringify({
      finishedAt: options.finishedAt ?? '2026-04-04T12:00:00.000Z',
      exitCode: options.exitCode ?? 0,
      costUsd: options.costUsd ?? null,
      command: 'opencode',
      args: ['run', 'test'],
    }, null, 2)}\n`,
    'utf8',
  );
}

async function writeWorkerArtifact(repoRoot, workerId, options = {}) {
  const paths = getOpencodePaths(repoRoot);
  const workerDir = path.join(paths.workersDir, workerId);
  const nowIso = new Date().toISOString();
  await fs.mkdir(workerDir, { recursive: true });
  await fs.writeFile(path.join(workerDir, 'current.stdout.txt'), options.stdout ?? 'worker output', 'utf8');
  await fs.writeFile(path.join(workerDir, 'current.stderr.txt'), options.stderr ?? '', 'utf8');
  await fs.writeFile(
    path.join(workerDir, 'worker.json'),
    `${JSON.stringify({
      workerId,
      workerToken: `${workerId}-token`,
      status: options.status ?? 'idle',
      createdAt: options.createdAt ?? '2026-04-04T12:00:00.000Z',
      updatedAt: options.updatedAt ?? nowIso,
      repoRoot,
      teamId: options.teamId ?? null,
      pid: options.pid ?? process.pid,
      heartbeatAt: options.heartbeatAt ?? nowIso,
      startedAt: options.startedAt ?? '2026-04-04T12:01:00.000Z',
      stoppedAt: options.stoppedAt ?? null,
      lastPrompt: options.lastPrompt ?? 'worker prompt',
      lastRunId: options.lastRunId ?? 'worker-run',
      lastRunStartedAt: options.lastRunStartedAt ?? '2026-04-04T12:01:00.000Z',
      lastRunCompletedAt: options.lastRunCompletedAt ?? '2026-04-04T12:02:00.000Z',
      lastExitCode: options.lastExitCode ?? 0,
      lastError: options.lastError ?? null,
      trustGateState: options.trustGateState ?? 'clear',
      trustGateMessage: options.trustGateMessage ?? null,
      stopRequested: false,
      nextControlIndex: 0,
      runCount: options.runCount ?? 1,
      archiveCount: 0,
      lastArchivePath: null,
      prunedAt: null,
      model: null,
    }, null, 2)}\n`,
    'utf8',
  );
}

async function writeTeamArtifact(repoRoot, teamId, options = {}) {
  const paths = getOpencodePaths(repoRoot);
  await fs.writeFile(
    path.join(paths.teamsDir, `${teamId}.json`),
    `${JSON.stringify({
      teamId,
      name: options.name ?? null,
      prompt: options.prompt ?? 'team prompt',
      requestedCount: options.requestedCount ?? options.workerIds.length,
      maxConcurrentWorkers: options.maxConcurrentWorkers ?? options.workerIds.length,
      maxTotalRuns: options.maxTotalRuns ?? null,
      workerIds: options.workerIds,
      status: options.status ?? 'active',
      createdAt: options.createdAt ?? '2026-04-04T12:00:00.000Z',
      updatedAt: options.updatedAt ?? '2026-04-04T12:10:00.000Z',
      archiveCount: 0,
      lastArchivePath: null,
      prunedAt: null,
    }, null, 2)}\n`,
    'utf8',
  );
}

test('memoryAdd stores evidence-backed entries and updates MEMORY.md', async () => {
  const repoRoot = await createTempRepo();
  await writeRunArtifact(repoRoot, 'run_ok');

  const added = await memoryAdd('Repo-local state lives under .opencode.', {
    cwd: repoRoot,
    topic: 'Repo Layout',
    runId: 'run_ok',
    now: '2026-04-04T12:05:00.000Z',
  });

  assert.equal(added.topic, 'repo-layout');
  assert.equal(added.entry.evidence[0].runId, 'run_ok');

  const topicView = await memoryShow('Repo Layout', { cwd: repoRoot });
  assert.equal(topicView.entries.length, 1);
  assert.equal(topicView.entries[0].summary, 'Repo-local state lives under .opencode.');

  const indexView = await memoryShow('', { cwd: repoRoot });
  assert.equal(indexView.topics.length, 1);
  assert.match(indexView.markdown, /repo-layout/);
  assert.match(indexView.markdown, /Repo-local state lives under \.opencode\./);
});

test('memorySearch returns targeted matches by topic and summary text', async () => {
  const repoRoot = await createTempRepo();
  await writeRunArtifact(repoRoot, 'run_one');
  await writeRunArtifact(repoRoot, 'run_two');

  await memoryAdd('The queue persists jobs in .opencode/jobs.json.', {
    cwd: repoRoot,
    topic: 'Queue',
    runId: 'run_one',
  });
  await memoryAdd('Workers persist supervision state under .opencode/workers/.', {
    cwd: repoRoot,
    topic: 'Workers',
    runId: 'run_two',
  });

  const byTopic = await memorySearch('workers', { cwd: repoRoot });
  assert.equal(byTopic.count, 1);
  assert.equal(byTopic.matches[0].topic, 'workers');

  const byText = await memorySearch('jobs.json', { cwd: repoRoot });
  assert.equal(byText.count, 1);
  assert.match(byText.matches[0].summary, /jobs\.json/);
});

test('team memory namespaces stay isolated from repo memory', async () => {
  const repoRoot = await createTempRepo();
  await writeRunArtifact(repoRoot, 'run_global');
  await writeRunArtifact(repoRoot, 'run_team');

  await memoryAdd('Global queue memory.', {
    cwd: repoRoot,
    topic: 'Queue',
    runId: 'run_global',
  });
  const teamAdded = await memoryAdd('Team-specific worker memory.', {
    cwd: repoRoot,
    teamId: 'release-team',
    topic: 'Workers',
    runId: 'run_team',
  });

  assert.match(teamAdded.indexPath, /memory\/team\/release-team\/MEMORY\.md$/);
  assert.match(teamAdded.topicPath, /memory\/team\/release-team\/topics\/workers\.json$/);

  const globalIndex = await memoryShow('', { cwd: repoRoot });
  const teamIndex = await memoryShow('', { cwd: repoRoot, teamId: 'release-team' });
  assert.equal(globalIndex.topics.length, 1);
  assert.equal(globalIndex.topics[0].topic, 'queue');
  assert.equal(teamIndex.topics.length, 1);
  assert.equal(teamIndex.topics[0].topic, 'workers');

  const globalSearch = await memorySearch('team-specific', { cwd: repoRoot });
  const teamSearch = await memorySearch('team-specific', { cwd: repoRoot, teamId: 'release-team' });
  assert.equal(globalSearch.count, 0);
  assert.equal(teamSearch.count, 1);
  assert.equal(teamSearch.matches[0].teamId, 'release-team');
});

test('memoryAdd rejects failed run evidence', async () => {
  const repoRoot = await createTempRepo();
  await writeRunArtifact(repoRoot, 'run_failed', { exitCode: 1 });

  await assert.rejects(
    () => memoryAdd('This should not be accepted.', {
      cwd: repoRoot,
      topic: 'Invalid',
      runId: 'run_failed',
    }),
    /did not complete successfully/,
  );
});

test('memoryAdd accepts successful worker evidence', async () => {
  const repoRoot = await createTempRepo();
  await writeWorkerArtifact(repoRoot, 'worker_ok', {
    status: 'idle',
    lastExitCode: 0,
    runCount: 2,
  });

  const added = await memoryAdd('Detached worker completed useful background investigation.', {
    cwd: repoRoot,
    topic: 'Workers',
    workerId: 'worker_ok',
  });

  assert.equal(added.entry.evidence[0].kind, 'worker');
  assert.equal(added.entry.evidence[0].workerId, 'worker_ok');

  const search = await memorySearch('worker_ok', { cwd: repoRoot });
  assert.equal(search.count, 1);
  assert.equal(search.matches[0].topic, 'workers');
});

test('memoryAdd accepts successful team synthesis evidence', async () => {
  const repoRoot = await createTempRepo();
  await writeWorkerArtifact(repoRoot, 'worker_team_ok', {
    status: 'idle',
    lastExitCode: 0,
    runCount: 1,
    stdout: 'team branch result',
  });
  await writeTeamArtifact(repoRoot, 'team_ok', {
    workerIds: ['worker_team_ok'],
  });

  const added = await memoryAdd('Team synthesis captured a useful merged conclusion.', {
    cwd: repoRoot,
    topic: 'Teams',
    teamResultId: 'team_ok',
  });

  assert.equal(added.entry.evidence[0].kind, 'team');
  assert.equal(added.entry.evidence[0].teamId, 'team_ok');

  const search = await memorySearch('team_ok', { cwd: repoRoot });
  assert.equal(search.count, 1);
  assert.equal(search.matches[0].topic, 'teams');
});

test('memoryRebuild reports cross-topic merge candidates and drift alerts', async () => {
  const repoRoot = await createTempRepo();
  await writeRunArtifact(repoRoot, 'run_merge_one');
  await writeRunArtifact(repoRoot, 'run_merge_two');
  await writeRunArtifact(repoRoot, 'run_drift_one');
  await writeRunArtifact(repoRoot, 'run_drift_two');

  await memoryAdd('Queue retry policy uses exponential backoff.', {
    cwd: repoRoot,
    topic: 'Queue Retry Policy',
    runId: 'run_merge_one',
  });
  await memoryAdd('Retry queue policy uses exponential backoff.', {
    cwd: repoRoot,
    topic: 'Retry Queue Policy',
    runId: 'run_merge_two',
  });
  await memoryAdd('Budget alerts page operators quickly.', {
    cwd: repoRoot,
    topic: 'Execution',
    runId: 'run_drift_one',
  });
  await memoryAdd('Workers archive stdout after task completion.', {
    cwd: repoRoot,
    topic: 'Execution',
    runId: 'run_drift_two',
  });

  const rebuilt = await memoryRebuild({ cwd: repoRoot, now: '2026-04-04T14:00:00.000Z' });

  assert.equal(rebuilt.mergeCandidates.length >= 1, true);
  assert.equal(rebuilt.mergeCandidates.some((candidate) => candidate.topics.includes('queue-retry-policy') && candidate.topics.includes('retry-queue-policy')), true);
  assert.equal(rebuilt.driftAlerts.some((alert) => alert.topic === 'execution'), true);
  assert.match(rebuilt.markdown, /## Merge Candidates/);
  assert.match(rebuilt.markdown, /## Drift Alerts/);
});

test('memoryMergeApply creates one merged entry and marks source notes stale', async () => {
  const repoRoot = await createTempRepo();
  await writeRunArtifact(repoRoot, 'run_merge_apply_one');
  await writeRunArtifact(repoRoot, 'run_merge_apply_two');

  await memoryAdd('Queue retry policy uses exponential backoff.', {
    cwd: repoRoot,
    topic: 'Queue Retry Policy',
    runId: 'run_merge_apply_one',
  });
  await memoryAdd('Retry queue policy uses exponential backoff.', {
    cwd: repoRoot,
    topic: 'Retry Queue Policy',
    runId: 'run_merge_apply_two',
  });

  const merged = await memoryMergeApply('Queue Retry Policy', 'Retry Queue Policy', {
    cwd: repoRoot,
    targetTopic: 'Queue Retry Policy',
    now: '2026-04-04T14:05:00.000Z',
  });

  assert.equal(merged.reusedExisting, false);
  assert.equal(merged.merged.entryType, 'merged');
  assert.deepEqual(merged.merged.sourceTopics, ['queue-retry-policy', 'retry-queue-policy']);

  const targetView = await memoryShow('Queue Retry Policy', { cwd: repoRoot });
  const rightView = await memoryShow('Retry Queue Policy', { cwd: repoRoot });
  assert.equal(targetView.entries.some((entry) => entry.entryType === 'merged'), true);
  assert.equal(targetView.entries.some((entry) => entry.staleReason === 'merged_into_topic'), true);
  assert.equal(rightView.entries[0].staleReason, 'merged_into_topic');

  const second = await memoryMergeApply('Queue Retry Policy', 'Retry Queue Policy', {
    cwd: repoRoot,
    targetTopic: 'Queue Retry Policy',
    now: '2026-04-04T14:06:00.000Z',
    force: true,
  });
  assert.equal(second.reusedExisting, true);
});

test('memoryCompact marks entries stale when run evidence disappears', async () => {
  const repoRoot = await createTempRepo();
  const paths = getOpencodePaths(repoRoot);
  await writeRunArtifact(repoRoot, 'run_stale');

  await memoryAdd('A note that will lose its run evidence.', {
    cwd: repoRoot,
    topic: 'Stale Memory',
    runId: 'run_stale',
  });

  await fs.rm(path.join(paths.runsDir, 'run_stale', 'result.json'));
  const compacted = await memoryCompact({ cwd: repoRoot, now: '2026-04-04T13:00:00.000Z' });

  assert.equal(compacted.staleMarked, 1);

  const topicView = await memoryShow('Stale Memory', { cwd: repoRoot });
  assert.equal(topicView.entries[0].stale, true);
  assert.equal(topicView.entries[0].staleReason, 'missing_run_result');
});

test('memoryCompact marks older duplicate memories stale without deleting them', async () => {
  const repoRoot = await createTempRepo();
  await writeRunArtifact(repoRoot, 'run_duplicate');

  await memoryAdd('Queue retries are delayed by retryAt.', {
    cwd: repoRoot,
    topic: 'Queue Retry',
    runId: 'run_duplicate',
    now: '2026-04-04T12:01:00.000Z',
  });
  await memoryAdd('Queue retries are delayed by retryAt.', {
    cwd: repoRoot,
    topic: 'Queue Retry',
    runId: 'run_duplicate',
    now: '2026-04-04T12:02:00.000Z',
  });

  const compacted = await memoryCompact({ cwd: repoRoot, now: '2026-04-04T12:10:00.000Z' });
  assert.equal(compacted.duplicatesCompacted, 1);

  const topicView = await memoryShow('Queue Retry', { cwd: repoRoot });
  assert.equal(topicView.entries.length, 2);
  assert.equal(topicView.summary.activeCount, 1);
  assert.equal(topicView.summary.staleCount, 1);
  assert.equal(topicView.entries.some((entry) => entry.staleReason === 'compacted_duplicate'), true);
});

test('memoryCompact creates one consolidated entry for busy topics and stays idempotent', async () => {
  const repoRoot = await createTempRepo();
  await writeRunArtifact(repoRoot, 'run_consolidate_one');
  await writeRunArtifact(repoRoot, 'run_consolidate_two');
  await writeRunArtifact(repoRoot, 'run_consolidate_three');

  await memoryAdd('The queue stores jobs in jobs.json.', {
    cwd: repoRoot,
    topic: 'Queue',
    runId: 'run_consolidate_one',
    now: '2026-04-04T12:01:00.000Z',
  });
  await memoryAdd('Retries are delayed by retryAt.', {
    cwd: repoRoot,
    topic: 'Queue',
    runId: 'run_consolidate_two',
    now: '2026-04-04T12:02:00.000Z',
  });
  await memoryAdd('Queue execution respects budget and idle policy.', {
    cwd: repoRoot,
    topic: 'Queue',
    runId: 'run_consolidate_three',
    now: '2026-04-04T12:03:00.000Z',
  });

  const firstCompact = await memoryCompact({ cwd: repoRoot, now: '2026-04-04T12:10:00.000Z' });
  assert.equal(firstCompact.consolidatedCreated, 1);
  assert.equal(firstCompact.entriesConsolidated, 3);

  const firstView = await memoryShow('Queue', { cwd: repoRoot });
  const consolidated = firstView.entries.find((entry) => entry.entryType === 'consolidated');
  const staleSources = firstView.entries.filter((entry) => entry.staleReason === 'compacted_consolidated');

  assert.notEqual(consolidated, undefined);
  assert.match(consolidated.summary, /Consolidated topic memory from 3 entries:/);
  assert.equal(consolidated.sourceMemoryIds.length, 3);
  assert.equal(staleSources.length, 3);
  assert.equal(staleSources.every((entry) => entry.replacedByMemoryId === consolidated.memoryId), true);
  assert.equal(firstView.summary.activeCount, 1);

  const secondCompact = await memoryCompact({ cwd: repoRoot, now: '2026-04-04T12:20:00.000Z' });
  assert.equal(secondCompact.consolidatedCreated, 0);
  assert.equal(secondCompact.entriesConsolidated, 0);

  const secondView = await memoryShow('Queue', { cwd: repoRoot });
  assert.equal(secondView.entries.filter((entry) => entry.entryType === 'consolidated').length, 1);
});

test('memoryRepair replaces stale evidence with new worker evidence', async () => {
  const repoRoot = await createTempRepo();
  const paths = getOpencodePaths(repoRoot);
  await writeRunArtifact(repoRoot, 'run_to_repair');
  await writeWorkerArtifact(repoRoot, 'worker_repair', {
    status: 'blocked',
    lastExitCode: 0,
    runCount: 3,
  });

  const added = await memoryAdd('This memory should be repaired with fresher worker evidence.', {
    cwd: repoRoot,
    topic: 'Repair',
    runId: 'run_to_repair',
  });

  await fs.rm(path.join(paths.runsDir, 'run_to_repair', 'result.json'));
  await memoryCompact({ cwd: repoRoot, now: '2026-04-04T13:00:00.000Z' });

  const staleView = await memoryShow('Repair', { cwd: repoRoot });
  const staleEntry = staleView.entries.find((entry) => entry.memoryId === added.entry.memoryId);
  assert.equal(staleEntry.stale, true);
  assert.equal(staleEntry.staleReason, 'missing_run_result');

  const repaired = await memoryRepair(added.entry.memoryId, {
    cwd: repoRoot,
    workerId: 'worker_repair',
    summary: 'Repair now points at successful detached worker evidence.',
    now: '2026-04-04T13:05:00.000Z',
  });

  assert.equal(repaired.superseded.memoryId, added.entry.memoryId);
  assert.equal(repaired.repaired.repairedFromMemoryId, added.entry.memoryId);
  assert.equal(repaired.repaired.evidence[0].kind, 'worker');
  assert.equal(repaired.repaired.evidence[0].workerId, 'worker_repair');

  const repairedView = await memoryShow('Repair', { cwd: repoRoot });
  const original = repairedView.entries.find((entry) => entry.memoryId === added.entry.memoryId);
  const replacement = repairedView.entries.find((entry) => entry.memoryId === repaired.repaired.memoryId);
  assert.equal(original.staleReason, 'repaired');
  assert.equal(original.replacedByMemoryId, replacement.memoryId);
  assert.equal(replacement.stale, false);
  assert.equal(replacement.summary, 'Repair now points at successful detached worker evidence.');
});

test('memory search and stale views can filter to repairable stale entries', async () => {
  const repoRoot = await createTempRepo();
  const paths = getOpencodePaths(repoRoot);
  await writeRunArtifact(repoRoot, 'run_dup');
  await writeRunArtifact(repoRoot, 'run_repairable');

  await memoryAdd('Queue retry guidance duplicate.', {
    cwd: repoRoot,
    topic: 'Queue',
    runId: 'run_dup',
    now: '2026-04-04T12:01:00.000Z',
  });
  await memoryAdd('Queue retry guidance duplicate.', {
    cwd: repoRoot,
    topic: 'Queue',
    runId: 'run_dup',
    now: '2026-04-04T12:02:00.000Z',
  });
  const repairable = await memoryAdd('Queue repair target entry.', {
    cwd: repoRoot,
    topic: 'Queue',
    runId: 'run_repairable',
    now: '2026-04-04T12:03:00.000Z',
  });

  await fs.rm(path.join(paths.runsDir, 'run_repairable', 'result.json'));
  await memoryCompact({ cwd: repoRoot, now: '2026-04-04T12:10:00.000Z' });

  const staleOnly = await memoryStale({ cwd: repoRoot, repairableOnly: true });
  assert.equal(staleOnly.count, 1);
  assert.equal(staleOnly.entries[0].memoryId, repairable.entry.memoryId);
  assert.equal(staleOnly.entries[0].repairable, true);

  const search = await memorySearch('queue', {
    cwd: repoRoot,
    staleOnly: true,
    repairableOnly: true,
  });
  assert.equal(search.count, 1);
  assert.equal(search.matches[0].memoryId, repairable.entry.memoryId);
  assert.equal(search.matches[0].staleReason, 'missing_run_result');
});

test('memory policy config changes compaction and repair discovery thresholds', async () => {
  const repoRoot = await createTempRepo();
  const paths = getOpencodePaths(repoRoot);
  const config = await loadConfig(repoRoot);
  config.memory.compact.topicConsolidationMinActive = 4;
  config.memory.repair.maxListedEntries = 1;
  await saveConfig(repoRoot, config);

  await writeRunArtifact(repoRoot, 'run_threshold_one');
  await writeRunArtifact(repoRoot, 'run_threshold_two');
  await writeRunArtifact(repoRoot, 'run_threshold_three');
  await writeRunArtifact(repoRoot, 'run_threshold_four');
  await writeRunArtifact(repoRoot, 'run_threshold_five');

  await memoryAdd('Queue note one.', {
    cwd: repoRoot,
    topic: 'Queue Threshold',
    runId: 'run_threshold_one',
    now: '2026-04-04T12:01:00.000Z',
  });
  await memoryAdd('Queue note two.', {
    cwd: repoRoot,
    topic: 'Queue Threshold',
    runId: 'run_threshold_two',
    now: '2026-04-04T12:02:00.000Z',
  });
  await memoryAdd('Queue note three.', {
    cwd: repoRoot,
    topic: 'Queue Threshold',
    runId: 'run_threshold_three',
    now: '2026-04-04T12:03:00.000Z',
  });

  const compacted = await memoryCompact({ cwd: repoRoot, now: '2026-04-04T12:10:00.000Z' });
  assert.equal(compacted.consolidatedCreated, 0);

  const queueView = await memoryShow('Queue Threshold', { cwd: repoRoot });
  assert.equal(queueView.summary.activeCount, 3);

  await memoryAdd('Repair threshold first.', {
    cwd: repoRoot,
    topic: 'Repair Threshold',
    runId: 'run_threshold_four',
    now: '2026-04-04T12:04:00.000Z',
  });
  await memoryAdd('Repair threshold second.', {
    cwd: repoRoot,
    topic: 'Repair Threshold',
    runId: 'run_threshold_five',
    now: '2026-04-04T12:05:00.000Z',
  });

  await fs.rm(path.join(paths.runsDir, 'run_threshold_four', 'result.json'));
  await fs.rm(path.join(paths.runsDir, 'run_threshold_five', 'result.json'));
  const staleCompacted = await memoryCompact({ cwd: repoRoot, now: '2026-04-04T12:20:00.000Z' });
  assert.equal(staleCompacted.staleMarked >= 2, true);

  const stale = await memoryStale({ cwd: repoRoot, repairableOnly: true });
  assert.equal(stale.totalCount, 2);
  assert.equal(stale.count, 1);
  assert.equal(stale.truncated, true);
});

test('memoryRebuild restores MEMORY.md from topic files', async () => {
  const repoRoot = await createTempRepo();
  const paths = getOpencodePaths(repoRoot);
  await writeRunArtifact(repoRoot, 'run_rebuild');

  await memoryAdd('MEMORY.md should be derivable from topic files.', {
    cwd: repoRoot,
    topic: 'Index',
    runId: 'run_rebuild',
  });

  await fs.writeFile(paths.memoryIndex, '# broken\n', 'utf8');
  const rebuilt = await memoryRebuild({ cwd: repoRoot, now: '2026-04-04T14:00:00.000Z' });

  assert.match(rebuilt.markdown, /index/);
  assert.match(rebuilt.markdown, /MEMORY\.md should be derivable from topic files\./);
});
