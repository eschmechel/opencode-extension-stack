import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ensureStateLayout, getOpencodePaths } from '../../opencode-core/src/index.js';

import {
  memoryAdd,
  memoryCompact,
  memoryRebuild,
  memorySearch,
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
