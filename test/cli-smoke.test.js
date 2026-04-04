import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

const repoRoot = '/mnt/GOONDRIVE/Repos/opencode-extension-stack';

const CLI_CASES = [
  {
    name: 'kairos',
    file: 'packages/opencode-kairos/src/cli.js',
    args: ['help'],
    pattern: /Usage:/,
  },
  {
    name: 'memory',
    file: 'packages/opencode-memory/src/cli.js',
    args: ['help'],
    pattern: /Usage:/,
  },
  {
    name: 'orchestrator',
    file: 'packages/opencode-orchestrator/src/cli.js',
    args: ['help'],
    pattern: /Usage:/,
  },
  {
    name: 'packs',
    file: 'packages/opencode-packs/src/cli.js',
    args: ['help'],
    pattern: /Usage:/,
  },
  {
    name: 'bridge',
    file: 'packages/opencode-bridge/src/cli.js',
    args: ['help'],
    pattern: /Usage:/,
  },
];

for (const cliCase of CLI_CASES) {
  test(`${cliCase.name} CLI help exits cleanly`, async () => {
    const result = await runCli(cliCase.file, cliCase.args);
    assert.equal(result.exitCode, 0, result.stderr || `${cliCase.name} CLI exited non-zero`);
    assert.match(result.stdout, cliCase.pattern);
  });
}

function runCli(relativeFile, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repoRoot, relativeFile), ...args], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });
  });
}
