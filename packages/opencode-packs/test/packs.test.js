import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ensureStateLayout, getOpencodePaths } from '../../opencode-core/src/index.js';
import {
  completePackInvocation,
  executePack,
  getPack,
  listPacks,
  listPackHistory,
  renderPack,
  showPack,
  showPackInvocation,
  validatePackOutput,
} from '../src/index.js';
import { servePacksUi } from '../src/ui-server.js';

async function createTempRepo() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-packs-'));
  await fs.mkdir(path.join(repoRoot, '.git'));
  await ensureStateLayout(repoRoot);
  return repoRoot;
}

test('listPacks returns the expanded reusable pack set', () => {
  const packs = listPacks();

  assert.deepEqual(
    packs.map((pack) => pack.name),
    ['ultraplan', 'review', 'review-remote', 'triage', 'handoff'],
  );
  assert.equal(packs.every((pack) => typeof pack.exampleCount === 'number' && pack.exampleCount >= 1), true);
});

test('getPack resolves slash aliases including new polish packs', () => {
  assert.equal(getPack('/ultraplan').name, 'ultraplan');
  assert.equal(getPack('/review').name, 'review');
  assert.equal(getPack('/review-remote').name, 'review-remote');
  assert.equal(getPack('/triage').name, 'triage');
  assert.equal(getPack('/handoff').name, 'handoff');
});

test('showPack exposes model defaults, contracts, and examples', () => {
  const pack = showPack('review');

  assert.equal(pack.agentPreset.preferredAgent, 'CodeReviewer');
  assert.equal(pack.modelDefaults.reasoning, 'high');
  assert.equal(pack.outputContract.schema.required.includes('findings'), true);
  assert.equal(pack.examples.length >= 1, true);
});

test('renderPack returns prompt, presets, output contract, and examples', () => {
  const rendered = renderPack('ultraplan', {
    request: 'Design a safe rollout plan',
    context: 'The repo has unattended jobs and skeptical memory already.',
    constraints: ['No breaking changes', 'Keep commits small'],
  });

  assert.equal(rendered.pack.agentPreset.preferredAgent, 'general');
  assert.match(rendered.prompt, /Design a safe rollout plan/);
  assert.match(rendered.prompt, /No breaking changes/);
  assert.equal(rendered.outputContract.format, 'json');
  assert.equal(rendered.examples.length >= 1, true);
});

test('validatePackOutput accepts valid output and rejects stricter schema violations', () => {
  const valid = validatePackOutput('review', {
    findings: [
      {
        severity: 'high',
        title: 'Missing guard',
        location: 'src/index.js:12',
        issue: 'The path is used without validation.',
        risk: 'Could break on malformed input.',
      },
    ],
    openQuestions: [],
    summary: 'One high-severity finding.',
  });

  const invalidExtraField = validatePackOutput('review-remote', {
    approval: 'approved',
    blockingFindings: [],
    nonBlockingFindings: [],
    handoff: {
      summary: 'Looks good.',
      nextActions: ['Approve it'],
      extraField: true,
    },
  });

  const invalidMinItems = validatePackOutput('ultraplan', {
    goal: 'Plan a rollout.',
    constraints: [],
    assumptions: [],
    plan: [],
    validation: [],
  });

  assert.equal(valid.valid, true);
  assert.equal(invalidExtraField.valid, false);
  assert.match(invalidExtraField.errors[0], /unexpected field extraField/);
  assert.equal(invalidMinItems.valid, false);
  assert.match(invalidMinItems.errors[0], /at least 1 items/);
});

test('executePack records durable invocation packets and history', async () => {
  const repoRoot = await createTempRepo();
  const invocation = await executePack('triage', {
    request: 'Workers stopped after the latest runtime change.',
  }, {
    cwd: repoRoot,
    channel: 'remote',
    now: '2026-04-04T15:00:00.000Z',
  });

  const paths = getOpencodePaths(repoRoot);
  const invocationFile = await fs.readFile(invocation.invocationPath, 'utf8');
  const history = await listPackHistory({ cwd: repoRoot, limit: 5 });

  assert.match(invocationFile, /Workers stopped after the latest runtime change/);
  assert.equal(invocation.channel, 'remote');
  assert.match(invocation.handoff.suggestedCommand, /--channel remote/);
  assert.equal(history.count, 1);
  assert.equal(history.entries[0].action, 'execute');
  assert.equal(history.entries[0].packName, 'triage');
  assert.equal(paths.packHistory.endsWith('history.ndjson'), true);
});

test('completePackInvocation validates output and updates history', async () => {
  const repoRoot = await createTempRepo();
  const invocation = await executePack('handoff', {
    request: 'Hand off the remaining Phase 5 bridge work.',
    context: 'Bridge file is currently being edited in another instance.',
  }, {
    cwd: repoRoot,
    now: '2026-04-04T15:10:00.000Z',
  });

  const completed = await completePackInvocation(invocation.invocationId, {
    summary: 'Bridge work is mid-flight and needs coordinated follow-up.',
    currentState: ['Phase 4 is done', 'Bridge work is still changing'],
    risks: ['Concurrent bridge edits may invalidate assumptions quickly.'],
    nextActions: ['Sync with the bridge owner before editing shared files'],
    blockers: [],
  }, {
    cwd: repoRoot,
    now: '2026-04-04T15:11:00.000Z',
  });

  const shown = await showPackInvocation(invocation.invocationId, { cwd: repoRoot });
  const history = await listPackHistory({ cwd: repoRoot, limit: 5, packName: 'handoff' });

  assert.equal(completed.status, 'completed');
  assert.equal(shown.completion.valid, true);
  assert.equal(history.entries.length, 2);
  assert.equal(history.entries[0].action, 'complete');
  assert.equal(history.entries[1].action, 'execute');
});

test('servePacksUi serves the pack studio and API endpoints', async () => {
  const repoRoot = await createTempRepo();
  const server = await servePacksUi({ cwd: repoRoot, port: 0 });

  try {
    const html = await fetch(`${server.baseUrl}/`).then((response) => response.text());
    const packs = await fetch(`${server.baseUrl}/api/packs`).then((response) => response.json());
    const rendered = await fetch(`${server.baseUrl}/api/render`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        packName: 'review',
        request: 'Review the latest change set.',
        context: 'Focus on queue/job lifecycle.',
        constraints: ['Findings first'],
      }),
    }).then((response) => response.json());
    const invocation = await fetch(`${server.baseUrl}/api/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        packName: 'review-remote',
        request: 'Review remote branch changes.',
        channel: 'remote',
      }),
    }).then((response) => response.json());
    const history = await fetch(`${server.baseUrl}/api/history?limit=5`).then((response) => response.json());
    const validation = await fetch(`${server.baseUrl}/api/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        packName: 'triage',
        output: {
          category: 'bug',
          priority: 'p1',
          ownerRole: 'runtime maintainer',
          summary: 'Looks like a regression.',
          nextActions: ['Reproduce it'],
        },
      }),
    }).then((response) => response.json());
    const shown = await fetch(`${server.baseUrl}/api/invocations/${encodeURIComponent(invocation.invocationId)}`).then((response) => response.json());

    assert.match(html, /Pack Studio/);
    assert.equal(packs.packs.length >= 5, true);
    assert.match(rendered.prompt, /Review the latest change set/);
    assert.equal(invocation.channel, 'remote');
    assert.match(invocation.handoff.suggestedCommand, /--channel remote/);
    assert.equal(history.count, 1);
    assert.equal(validation.valid, true);
    assert.equal(shown.invocationId, invocation.invocationId);
  } finally {
    await server.close();
  }
});
