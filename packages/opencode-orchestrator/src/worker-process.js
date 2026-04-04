#!/usr/bin/env node

import { runWorkerLoop } from './index.js';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await runWorkerLoop({
    repoRoot: args['repo-root'],
    workerId: args['worker-id'],
    workerToken: args['worker-token'],
  });
}

function parseArgs(args) {
  const parsed = {};

  for (let index = 0; index < args.length; index += 2) {
    parsed[args[index].replace(/^--/, '')] = args[index + 1];
  }

  return parsed;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
