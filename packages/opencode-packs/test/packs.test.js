import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getPack,
  listPacks,
  renderPack,
  showPack,
  validatePackOutput,
} from '../src/index.js';

test('listPacks returns the initial reusable pack set', () => {
  const packs = listPacks();

  assert.deepEqual(
    packs.map((pack) => pack.name),
    ['ultraplan', 'review', 'review-remote'],
  );
});

test('getPack resolves slash aliases', () => {
  assert.equal(getPack('/ultraplan').name, 'ultraplan');
  assert.equal(getPack('/review').name, 'review');
  assert.equal(getPack('/review-remote').name, 'review-remote');
});

test('renderPack returns prompt, presets, and output contract', () => {
  const rendered = renderPack('ultraplan', {
    request: 'Design a safe rollout plan',
    context: 'The repo has unattended jobs and skeptical memory already.',
    constraints: ['No breaking changes', 'Keep commits small'],
  });

  assert.equal(rendered.pack.agentPreset.preferredAgent, 'general');
  assert.match(rendered.prompt, /Design a safe rollout plan/);
  assert.match(rendered.prompt, /No breaking changes/);
  assert.equal(rendered.outputContract.format, 'json');
});

test('showPack exposes model defaults and contracts', () => {
  const pack = showPack('review');

  assert.equal(pack.agentPreset.preferredAgent, 'CodeReviewer');
  assert.equal(pack.modelDefaults.reasoning, 'high');
  assert.equal(pack.outputContract.schema.required.includes('findings'), true);
});

test('validatePackOutput accepts valid review output and rejects malformed output', () => {
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

  const invalid = validatePackOutput('review-remote', {
    approval: 'approved',
    blockingFindings: [],
  });

  assert.equal(valid.valid, true);
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors[0], /missing required field nonBlockingFindings/);
});
