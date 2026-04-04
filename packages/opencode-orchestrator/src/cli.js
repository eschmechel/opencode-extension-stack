#!/usr/bin/env node

import {
  parallelStart,
  retentionApply,
  retentionStatus,
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
      if (worker.stdoutTail) {
        printHeader('Stdout tail');
        console.log(worker.stdoutTail);
      }
      if (worker.stderrTail) {
        printHeader('Stderr tail');
        console.log(worker.stderrTail);
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
        templateName: parsed.templateName,
        name: parsed.name,
        maxConcurrentWorkers: parsed.maxConcurrentWorkers,
        maxTotalRuns: parsed.maxTotalRuns,
      });
      printHeader(`Created ${team.teamId}`);
      if (team.templateName) {
        printKeyValue('template', team.templateName);
      }
      printKeyValue('workers', team.workerIds.length);
      printKeyValue('status', team.status);
      printKeyValue('memory index', team.memory.indexPath);
      return;
    }
    case 'template': {
      await runTeamTemplate(args);
      return;
    }
    case 'memory': {
      await runTeamMemory(args.slice(1));
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
          if (team.templateName) {
            console.log(`  template: ${team.templateName}`);
          }
          console.log(`  prompt: ${team.prompt}`);
          console.log(`  running: ${team.counts.running} idle: ${team.counts.idle} blocked: ${team.counts.blocked} failed: ${team.counts.failed}`);
          console.log(`  memory: topics=${team.memory.topicCount} active=${team.memory.activeCount} stale=${team.memory.staleCount}`);
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
      if (team.templateName) {
        printKeyValue('template', team.templateName);
      }
      printKeyValue('running', team.counts.running);
      printKeyValue('idle', team.counts.idle);
      printKeyValue('blocked', team.counts.blocked);
      printKeyValue('failed', team.counts.failed);
      printKeyValue('summary', team.synthesis.summaryText);
      printKeyValue('memory index', team.memory.indexPath);
      printKeyValue('memory topics', team.memory.topicCount);
      printKeyValue('memory active', team.memory.activeCount);
      printKeyValue('memory stale', team.memory.staleCount);
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
      if (team.synthesis.previews.length > 0) {
        printHeader('Previews');
        for (const preview of team.synthesis.previews) {
          console.log(`- ${preview.workerId}`);
          console.log(preview.output);
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
      throw new Error('Usage: /team create <count> <prompt> [--name <display-name>] [--max-concurrency N] [--max-total-runs N] | /team create --template <name> [prompt override] [--name <display-name>] [--max-concurrency N] [--max-total-runs N] | /team template save <name> <count> <prompt> | /team template list | /team template show <name> | /team template delete <name> | /team memory <teamId> [show [topic] | search <query> [--stale] [--repairable] | stale [--repairable] | contradictions | rebuild | compact] | /team list | /team show <id> | /team archive <id> | /team prune <id> | /team delete <id> | /team rerun-failed <id>');
  }
}

async function runParallel(args) {
  const parsed = parseTeamArgs(args);
  const team = await parallelStart(parsed.count, parsed.prompt, {
    templateName: parsed.templateName,
    name: parsed.name,
    maxConcurrentWorkers: parsed.maxConcurrentWorkers,
    maxTotalRuns: parsed.maxTotalRuns,
  });
  printHeader(`Parallel started ${team.teamId}`);
  if (team.templateName) {
    printKeyValue('template', team.templateName);
  }
  printKeyValue('workers', team.workerIds.length);
  printKeyValue('status', team.status);
  printKeyValue('memory index', team.memory.indexPath);
}

async function runTeamTemplate(args) {
  const subcommand = args[0] ?? '';
  switch (subcommand) {
    case 'save': {
      const parsed = parseTeamTemplateSaveArgs(args.slice(1));
      const template = await teamTemplateSave(parsed.templateName, parsed);
      printHeader(`Saved template ${template.templateName}`);
      printKeyValue('workers', template.requestedCount);
      printKeyValue('max concurrency', template.maxConcurrentWorkers);
      printKeyValue('max total runs', template.maxTotalRuns);
      return;
    }
    case 'list': {
      const templates = await teamTemplateList();
      printHeader(`Team templates (${templates.length})`);
      if (templates.length === 0) {
        console.log('None.');
        return;
      }
      for (const template of templates) {
        console.log(`- ${template.templateName} workers=${template.requestedCount} maxConcurrency=${template.maxConcurrentWorkers}`);
        console.log(`  prompt: ${template.prompt}`);
      }
      return;
    }
    case 'show': {
      const templateName = args[1] ?? '';
      const template = await teamTemplateShow(templateName);
      printHeader(`Team template ${template.templateName}`);
      if (template.name) {
        printKeyValue('name', template.name);
      }
      if (template.description) {
        printKeyValue('description', template.description);
      }
      printKeyValue('workers', template.requestedCount);
      printKeyValue('max concurrency', template.maxConcurrentWorkers);
      printKeyValue('max total runs', template.maxTotalRuns);
      printKeyValue('prompt', template.prompt);
      return;
    }
    case 'delete': {
      const templateName = args[1] ?? '';
      const template = await teamTemplateDelete(templateName);
      printHeader(`Deleted template ${template.templateName}`);
      return;
    }
    default:
      throw new Error('Usage: /team template save <name> <count> <prompt> [--max-concurrency N] [--max-total-runs N] [--description <text>] [--name <display-name>] | /team template save <name> --from-team <teamId> [--description <text>] | /team template list | /team template show <name> | /team template delete <name>');
  }
}

async function runTeamMemory(args) {
  const teamId = args[0] ?? '';
  const subcommand = args[1] ?? 'show';
  const rest = args.slice(2);

  switch (subcommand) {
    case 'show': {
      const topic = rest.join(' ').trim();
      const result = await teamMemoryShow(teamId, topic);
      if (result.scope === 'index') {
        printHeader(`Team memory ${teamId}`);
        printKeyValue('index', result.indexPath);
        printKeyValue('topics', result.topics.length);
        printKeyValue('merge candidates', result.mergeCandidates.length);
        printKeyValue('contradiction alerts', result.contradictionAlerts.length);
        printKeyValue('drift alerts', result.driftAlerts.length);
        return;
      }

      printHeader(`Team memory ${teamId} topic ${result.topic}`);
      printKeyValue('file', result.topicPath);
      printKeyValue('entries', result.summary.entryCount);
      printKeyValue('active', result.summary.activeCount);
      printKeyValue('stale', result.summary.staleCount);
      return;
    }
    case 'search': {
      const parsed = parseMemorySearchArgs(rest);
      const result = await teamMemorySearch(teamId, parsed.query, parsed);
      printHeader(`Team memory search ${teamId}: ${result.query}`);
      printKeyValue('matches', result.count);
      if (result.truncated) {
        printKeyValue('total matches', result.totalCount);
      }
      return;
    }
    case 'stale': {
      const repairableOnly = rest.includes('--repairable');
      const result = await teamMemoryStale(teamId, { repairableOnly });
      printHeader(`Team stale memory ${teamId}`);
      printKeyValue('entries', result.count);
      if (result.truncated) {
        printKeyValue('total entries', result.totalCount);
      }
      return;
    }
    case 'contradictions': {
      const result = await teamMemoryContradictions(teamId);
      printHeader(`Team memory contradictions ${teamId}`);
      printKeyValue('alerts', result.count);
      return;
    }
    case 'rebuild': {
      const result = await teamMemoryRebuild(teamId);
      printHeader(`Team memory rebuilt ${teamId}`);
      printKeyValue('index', result.indexPath);
      printKeyValue('topics', result.topics.length);
      return;
    }
    case 'compact': {
      const result = await teamMemoryCompact(teamId);
      printHeader(`Team memory compacted ${teamId}`);
      printKeyValue('topics updated', result.topicsUpdated);
      printKeyValue('entries checked', result.entriesChecked);
      printKeyValue('stale marked', result.staleMarked);
      return;
    }
    default:
      throw new Error('Usage: /team memory <teamId> [show [topic] | search <query> [--stale] [--repairable] | stale [--repairable] | contradictions | rebuild | compact]');
  }
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
  const templateIndex = args.indexOf('--template');
  const nameIndex = args.indexOf('--name');
  const maxConcurrentWorkers = maxConcurrencyIndex >= 0 ? Number(args[maxConcurrencyIndex + 1]) : undefined;
  const maxTotalRuns = maxTotalRunsIndex >= 0 ? Number(args[maxTotalRunsIndex + 1]) : undefined;
  const templateName = templateIndex >= 0 ? args[templateIndex + 1] : undefined;
  const name = nameIndex >= 0 ? args[nameIndex + 1] : undefined;
  const filtered = args.filter((value, index) => {
    if (index === maxConcurrencyIndex || index === maxConcurrencyIndex + 1) {
      return false;
    }
    if (index === maxTotalRunsIndex || index === maxTotalRunsIndex + 1) {
      return false;
    }
    if (index === templateIndex || index === templateIndex + 1) {
      return false;
    }
    if (index === nameIndex || index === nameIndex + 1) {
      return false;
    }
    return true;
  });

  if (templateName) {
    return {
      count: undefined,
      prompt: filtered.join(' ').trim(),
      templateName,
      name,
      maxConcurrentWorkers,
      maxTotalRuns,
    };
  }

  return {
    count: Number(filtered[0]),
    prompt: filtered.slice(1).join(' '),
    templateName,
    name,
    maxConcurrentWorkers,
    maxTotalRuns,
  };
}

function parseTeamTemplateSaveArgs(args) {
  const templateName = args[0] ?? '';
  const fromTeamIndex = args.indexOf('--from-team');
  const maxConcurrencyIndex = args.indexOf('--max-concurrency');
  const maxTotalRunsIndex = args.indexOf('--max-total-runs');
  const descriptionIndex = args.indexOf('--description');
  const nameIndex = args.indexOf('--name');

  const maxConcurrentWorkers = maxConcurrencyIndex >= 0 ? Number(args[maxConcurrencyIndex + 1]) : undefined;
  const maxTotalRuns = maxTotalRunsIndex >= 0 ? Number(args[maxTotalRunsIndex + 1]) : undefined;
  const fromTeamId = fromTeamIndex >= 0 ? args[fromTeamIndex + 1] : undefined;
  const description = descriptionIndex >= 0 ? args[descriptionIndex + 1] : undefined;
  const name = nameIndex >= 0 ? args[nameIndex + 1] : undefined;

  const filtered = args.filter((value, index) => {
    if (index === 0) {
      return false;
    }
    if (index === fromTeamIndex || index === fromTeamIndex + 1) {
      return false;
    }
    if (index === maxConcurrencyIndex || index === maxConcurrencyIndex + 1) {
      return false;
    }
    if (index === maxTotalRunsIndex || index === maxTotalRunsIndex + 1) {
      return false;
    }
    if (index === descriptionIndex || index === descriptionIndex + 1) {
      return false;
    }
    if (index === nameIndex || index === nameIndex + 1) {
      return false;
    }
    return true;
  });

  return {
    templateName,
    fromTeamId,
    count: fromTeamId ? undefined : Number(filtered[0]),
    prompt: fromTeamId ? '' : filtered.slice(1).join(' '),
    name,
    description,
    maxConcurrentWorkers,
    maxTotalRuns,
  };
}

function parseMemorySearchArgs(args) {
  const queryParts = [];
  let staleOnly = false;
  let repairableOnly = false;

  for (const value of args) {
    if (value === '--stale') {
      staleOnly = true;
      continue;
    }
    if (value === '--repairable') {
      staleOnly = true;
      repairableOnly = true;
      continue;
    }
    queryParts.push(value);
  }

  return {
    query: queryParts.join(' ').trim(),
    staleOnly,
    repairableOnly,
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
  console.log('Usage:');
  console.log('  pnpm run orchestrator -- retention status');
  console.log('  pnpm run orchestrator -- retention apply [--dry-run]');
  console.log('  pnpm run orchestrator -- /team create <count> <prompt> [--name <display-name>] [--max-concurrency N] [--max-total-runs N]');
  console.log('  pnpm run orchestrator -- /team create --template <name> [prompt override] [--name <display-name>] [--max-concurrency N] [--max-total-runs N]');
  console.log('  pnpm run orchestrator -- /team template save <name> <count> <prompt> [--name <display-name>] [--description <text>] [--max-concurrency N] [--max-total-runs N]');
  console.log('  pnpm run orchestrator -- /team template save <name> --from-team <teamId> [--description <text>]');
  console.log('  pnpm run orchestrator -- /team template list');
  console.log('  pnpm run orchestrator -- /team template show <name>');
  console.log('  pnpm run orchestrator -- /team template delete <name>');
  console.log('  pnpm run orchestrator -- /team memory <teamId> [show [topic] | search <query> [--stale] [--repairable] | stale [--repairable] | contradictions | rebuild | compact]');
  console.log('  pnpm run orchestrator -- /team list');
  console.log('  pnpm run orchestrator -- /team show <id>');
  console.log('  pnpm run orchestrator -- /team archive <id>');
  console.log('  pnpm run orchestrator -- /team prune <id>');
  console.log('  pnpm run orchestrator -- /team delete <id>');
  console.log('  pnpm run orchestrator -- /team rerun-failed <id>');
  console.log('  pnpm run orchestrator -- /parallel <count> <prompt> [--name <display-name>] [--max-concurrency N] [--max-total-runs N]');
  console.log('  pnpm run orchestrator -- /parallel --template <name> [prompt override] [--name <display-name>] [--max-concurrency N] [--max-total-runs N]');
  console.log('  pnpm run orchestrator -- /worker start <prompt>');
  console.log('  pnpm run orchestrator -- /worker list');
  console.log('  pnpm run orchestrator -- /worker show <id>');
  console.log('  pnpm run orchestrator -- /worker archive <id>');
  console.log('  pnpm run orchestrator -- /worker prune <id>');
  console.log('  pnpm run orchestrator -- /worker stop <id>');
  console.log('  pnpm run orchestrator -- /worker restart <id>');
  console.log('  pnpm run orchestrator -- /worker steer <id> <message>');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
