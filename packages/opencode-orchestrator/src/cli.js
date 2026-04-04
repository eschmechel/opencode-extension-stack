#!/usr/bin/env node

import {
  parallelStart,
  retentionApply,
  retentionStatus,
  teamArchive,
  teamCreate,
  teamDelete,
  teamList,
  teamPrune,
  teamRerunFailed,
  teamShow,
  workerArchive,
  workerList,
  workerPrune,
  workerRestart,
  workerShow,
  workerStart,
  workerSteer,
  workerStop,
} from './index.js';

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === '--') {
    args.shift();
  }

  if (args.length === 0) {
    printHelp();
    return;
  }

  const command = stripSlash(args[0]);
  const subcommand = args[1];

  switch (command) {
    case 'retention':
      await runRetention(subcommand, args.slice(2));
      return;
    case 'team':
      await runTeam(subcommand, args.slice(2));
      return;
    case 'parallel':
      await runParallel(args.slice(1));
      return;
    case 'worker':
      await runWorker(subcommand, args.slice(2));
      return;
    case 'help':
      printHelp();
      return;
    default:
      throw new Error(`Unknown command: ${args[0]}`);
  }
}

async function runWorker(subcommand, args) {
  switch (subcommand) {
    case 'start': {
      const prompt = args.join(' ').trim();
      const worker = await workerStart(prompt);
      printHeader(`Started ${worker.workerId}`);
      printKeyValue('status', worker.status);
      printKeyValue('pid', worker.pid);
      printKeyValue('prompt queued', '1');
      return;
    }
    case 'list': {
      const workers = await workerList();
      printHeader(`Workers (${workers.length})`);
      if (workers.length === 0) {
        console.log('None.');
        return;
      }

      for (const worker of workers) {
        console.log(`- ${worker.workerId} [${worker.status}] ${worker.updatedAt}`);
        console.log(`  ready: ${worker.readyForPrompt ? 'yes' : 'no'}`);
        console.log(`  pending prompts: ${worker.pendingPromptCount}`);
        if (worker.teamId) {
          console.log(`  team: ${worker.teamId}`);
        }
        if (worker.trustGateState === 'required') {
          console.log(`  trust gate: ${worker.trustGateMessage ?? 'required'}`);
        }
        if (worker.lastPrompt) {
          console.log(`  last prompt: ${worker.lastPrompt}`);
        }
      }
      return;
    }
    case 'show': {
      const workerId = args[0] ?? '';
      const worker = await workerShow(workerId);
      printHeader(`Worker ${worker.workerId}`);
      printKeyValue('status', worker.status);
      printKeyValue('pid', worker.pid);
      printKeyValue('created', worker.createdAt);
      printKeyValue('updated', worker.updatedAt);
      printKeyValue('run count', worker.runCount);
      printKeyValue('archive count', worker.archiveCount);
      printKeyValue('ready', worker.readyForPrompt);
      printKeyValue('pending prompts', worker.pendingPromptCount);
      printKeyValue('control', worker.controlPath);
      printKeyValue('stdout', worker.currentStdoutPath);
      printKeyValue('stderr', worker.currentStderrPath);
      printKeyValue('events', worker.eventsPath);
      if (worker.teamId) {
        printKeyValue('team', worker.teamId);
      }
      if (worker.trustGateState === 'required') {
        printKeyValue('trust gate', worker.trustGateMessage ?? 'required');
      }
      if (worker.lastPrompt) {
        printKeyValue('last prompt', worker.lastPrompt);
      }
      if (worker.lastError) {
        printKeyValue('last error', worker.lastError);
      }
      if (worker.lastArchivePath) {
        printKeyValue('last archive', worker.lastArchivePath);
      }
      if (worker.prunedAt) {
        printKeyValue('pruned at', worker.prunedAt);
      }
      if (worker.recentControls.length > 0) {
        printHeader('Recent controls');
        for (const entry of worker.recentControls) {
          console.log(`- ${entry.type} ${entry.createdAt}`);
        }
      }
      if (worker.recentEvents.length > 0) {
        printHeader('Recent events');
        for (const entry of worker.recentEvents) {
          console.log(`- ${entry.event} ${entry.at}`);
        }
      }
      return;
    }
    case 'archive': {
      const workerId = args[0] ?? '';
      const worker = await workerArchive(workerId);
      printHeader(`Archived ${worker.workerId}`);
      printKeyValue('archive count', worker.archiveCount);
      printKeyValue('last archive', worker.lastArchivePath);
      return;
    }
    case 'prune': {
      const workerId = args[0] ?? '';
      const worker = await workerPrune(workerId);
      printHeader(`Pruned ${worker.workerId}`);
      printKeyValue('archive count', worker.archiveCount);
      printKeyValue('last archive', worker.lastArchivePath);
      printKeyValue('pruned at', worker.prunedAt);
      return;
    }
    case 'stop': {
      const workerId = args[0] ?? '';
      const worker = await workerStop(workerId);
      printHeader(`Stop requested for ${worker.workerId}`);
      printKeyValue('status', worker.status);
      return;
    }
    case 'restart': {
      const workerId = args[0] ?? '';
      const worker = await workerRestart(workerId);
      printHeader(`Restarted ${worker.workerId}`);
      printKeyValue('status', worker.status);
      printKeyValue('pid', worker.pid);
      return;
    }
    case 'steer': {
      const [workerId, ...messageParts] = args;
      const worker = await workerSteer(workerId ?? '', messageParts.join(' '));
      printHeader(`Queued steer message for ${worker.workerId}`);
      printKeyValue('status', worker.status);
      return;
    }
    default:
      throw new Error('Usage: /worker start <prompt> | /worker list | /worker show <id> | /worker stop <id> | /worker restart <id> | /worker steer <id> <message>');
  }
}

async function runTeam(subcommand, args) {
  switch (subcommand) {
    case 'create': {
      const parsed = parseTeamArgs(args);
      const team = await teamCreate(parsed.count, parsed.prompt, {
        maxConcurrentWorkers: parsed.maxConcurrentWorkers,
        maxTotalRuns: parsed.maxTotalRuns,
      });
      printHeader(`Created ${team.teamId}`);
      printKeyValue('workers', team.workerIds.length);
      printKeyValue('status', team.status);
      return;
    }
    case 'list': {
      const teams = await teamList();
      printHeader(`Teams (${teams.length})`);
      if (teams.length === 0) {
        console.log('None.');
        return;
      }

      for (const team of teams) {
        console.log(`- ${team.teamId} [${team.status}] workers=${team.workerCount}`);
        console.log(`  prompt: ${team.prompt}`);
        console.log(`  running: ${team.counts.running} idle: ${team.counts.idle} blocked: ${team.counts.blocked} failed: ${team.counts.failed}`);
      }
      return;
    }
    case 'show': {
      const teamId = args[0] ?? '';
      const team = await teamShow(teamId);
      printHeader(`Team ${team.teamId}`);
      printKeyValue('status', team.status);
      printKeyValue('requested workers', team.requestedCount);
      printKeyValue('max concurrency', team.maxConcurrentWorkers);
      printKeyValue('max total runs', team.maxTotalRuns);
      printKeyValue('worker count', team.workerCount);
      printKeyValue('archive count', team.archiveCount);
      printKeyValue('prompt', team.prompt);
      printKeyValue('running', team.counts.running);
      printKeyValue('idle', team.counts.idle);
      printKeyValue('blocked', team.counts.blocked);
      printKeyValue('failed', team.counts.failed);
      printKeyValue('summary', team.synthesis.summaryText);
      if (team.lastArchivePath) {
        printKeyValue('last archive', team.lastArchivePath);
      }
      if (team.prunedAt) {
        printKeyValue('pruned at', team.prunedAt);
      }
      if (team.workers.length > 0) {
        printHeader('Workers');
        for (const worker of team.workers) {
          console.log(`- ${worker.workerId} [${worker.status}] ready=${worker.readyForPrompt} pending=${worker.pendingPromptCount}`);
          if (worker.lastPrompt) {
            console.log(`  last prompt: ${worker.lastPrompt}`);
          }
          if (worker.trustGateState === 'required') {
            console.log(`  trust gate: ${worker.trustGateMessage ?? 'required'}`);
          }
          if (worker.lastError) {
            console.log(`  last error: ${worker.lastError}`);
          }
        }
      }
      return;
    }
    case 'archive': {
      const teamId = args[0] ?? '';
      const team = await teamArchive(teamId);
      printHeader(`Archived ${team.teamId}`);
      printKeyValue('archive count', team.archiveCount);
      printKeyValue('last archive', team.lastArchivePath);
      return;
    }
    case 'prune': {
      const teamId = args[0] ?? '';
      const team = await teamPrune(teamId);
      printHeader(`Pruned ${team.teamId}`);
      printKeyValue('archive count', team.archiveCount);
      printKeyValue('last archive', team.lastArchivePath);
      printKeyValue('pruned at', team.prunedAt);
      return;
    }
    case 'delete': {
      const teamId = args[0] ?? '';
      const team = await teamDelete(teamId);
      printHeader(`Deleted ${team.teamId}`);
      printKeyValue('status', team.status);
      return;
    }
    case 'rerun-failed': {
      const teamId = args[0] ?? '';
      const result = await teamRerunFailed(teamId);
      printHeader(`Reran failed workers for ${result.teamId}`);
      printKeyValue('rerun count', result.rerunWorkers.length);
      return;
    }
    default:
      throw new Error('Usage: /team create <count> <prompt> [--max-concurrency N] [--max-total-runs N] | /team list | /team show <id> | /team archive <id> | /team prune <id> | /team delete <id> | /team rerun-failed <id>');
  }
}

async function runParallel(args) {
  const parsed = parseTeamArgs(args);
  const team = await parallelStart(parsed.count, parsed.prompt, {
    maxConcurrentWorkers: parsed.maxConcurrentWorkers,
    maxTotalRuns: parsed.maxTotalRuns,
  });
  printHeader(`Parallel started ${team.teamId}`);
  printKeyValue('workers', team.workerIds.length);
  printKeyValue('status', team.status);
}

async function runRetention(subcommand, args) {
  switch (subcommand) {
    case 'status': {
      const report = await retentionStatus();
      printRetentionReport('Retention status', report);
      return;
    }
    case 'apply': {
      const dryRun = args.includes('--dry-run');
      const result = await retentionApply({ dryRun });
      printHeader(dryRun ? 'Retention dry run' : 'Retention applied');
      printKeyValue('workers pruned', result.actions.workersPruned);
      printKeyValue('teams pruned', result.actions.teamsPruned);
      printKeyValue('worker archives compacted', result.actions.workerArchivesCompacted);
      printKeyValue('team archives compacted', result.actions.teamArchivesCompacted);
      printKeyValue('worker archives deleted', result.actions.workerArchivesDeleted);
      printKeyValue('team archives deleted', result.actions.teamArchivesDeleted);
      printRetentionReport('Retention after', result.after);
      return;
    }
    default:
      throw new Error('Usage: retention status | retention apply [--dry-run]');
  }
}

function printRetentionReport(title, report) {
  printHeader(title);
  printKeyValue('worker archives', report.workers.archiveEntries);
  printKeyValue('worker archive bytes', report.workers.archiveBytes);
  printKeyValue('workers eligible to prune', report.workers.eligibleToPrune);
  printKeyValue('workers deletable archives', report.workers.deletableArchives);
  printKeyValue('team archives', report.teams.archiveEntries);
  printKeyValue('team archive bytes', report.teams.archiveBytes);
  printKeyValue('teams eligible to prune', report.teams.eligibleToPrune);
  printKeyValue('team deletable archives', report.teams.deletableArchives);
}

function parseTeamArgs(args) {
  const maxConcurrencyIndex = args.indexOf('--max-concurrency');
  const maxTotalRunsIndex = args.indexOf('--max-total-runs');
  const maxConcurrentWorkers = maxConcurrencyIndex >= 0 ? Number(args[maxConcurrencyIndex + 1]) : undefined;
  const maxTotalRuns = maxTotalRunsIndex >= 0 ? Number(args[maxTotalRunsIndex + 1]) : undefined;
  const filtered = args.filter((value, index) => {
    if (index === maxConcurrencyIndex || index === maxConcurrencyIndex + 1) {
      return false;
    }
    if (index === maxTotalRunsIndex || index === maxTotalRunsIndex + 1) {
      return false;
    }
    return true;
  });

  return {
    count: Number(filtered[0]),
    prompt: filtered.slice(1).join(' '),
    maxConcurrentWorkers,
    maxTotalRuns,
  };
}

function stripSlash(value) {
  return value.startsWith('/') ? value.slice(1) : value;
}

function printHeader(value) {
  console.log(value);
}

function printKeyValue(key, value) {
  console.log(`${key}: ${value}`);
}

function printHelp() {
  console.log('OpenCode Orchestrator');
  console.log('');
  console.log('Commands:');
  console.log('  retention status');
  console.log('  retention apply [--dry-run]');
  console.log('  /team create <count> <prompt> [--max-concurrency N] [--max-total-runs N]');
  console.log('  /team list');
  console.log('  /team show <id>');
  console.log('  /team archive <id>');
  console.log('  /team prune <id>');
  console.log('  /team delete <id>');
  console.log('  /team rerun-failed <id>');
  console.log('  /parallel <count> <prompt> [--max-concurrency N] [--max-total-runs N]');
  console.log('  /worker start <prompt>');
  console.log('  /worker list');
  console.log('  /worker show <id>');
  console.log('  /worker archive <id>');
  console.log('  /worker prune <id>');
  console.log('  /worker stop <id>');
  console.log('  /worker restart <id>');
  console.log('  /worker steer <id> <message>');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
