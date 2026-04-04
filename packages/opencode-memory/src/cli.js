#!/usr/bin/env node

import {
  getMemoryPaths,
  memoryAdd,
  memoryCompact,
  memoryRebuild,
  memorySearch,
  memoryShow,
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
    case 'memory':
      await runMemory(subcommand, args.slice(2));
      return;
    case 'paths':
      await runPaths(args.slice(1));
      return;
    case 'help':
      printHelp();
      return;
    default:
      throw new Error(`Unknown command: ${args[0]}`);
  }
}

async function runMemory(subcommand, args) {
  const parsedCommon = extractTeamFlag(args);
  const teamOptions = { teamId: parsedCommon.teamId };

  switch (subcommand) {
    case 'show': {
      const topic = parsedCommon.args[0] ?? '';
      const result = await memoryShow(topic, teamOptions);
      if (result.scope === 'index') {
        printHeader(result.namespace === 'team' ? `Memory index team/${result.teamId}` : 'Memory index');
        printKeyValue('index', result.indexPath);
        printKeyValue('topics', result.topics.length);
        for (const topicSummary of result.topics) {
          console.log(`- ${topicSummary.topic} active=${topicSummary.activeCount} stale=${topicSummary.staleCount} updated=${topicSummary.updatedAt}`);
        }
        return;
      }

      printHeader(result.namespace === 'team' ? `Memory topic ${result.topic} team/${result.teamId}` : `Memory topic ${result.topic}`);
      printKeyValue('file', result.topicPath);
      printKeyValue('entries', result.summary.entryCount);
      printKeyValue('active', result.summary.activeCount);
      printKeyValue('stale', result.summary.staleCount);
      for (const entry of result.entries) {
        const flags = [];
        if (entry.entryType === 'consolidated') {
          flags.push('consolidated');
        }
        if (entry.stale) {
          flags.push(`stale:${entry.staleReason}`);
        }
        console.log(`- ${entry.memoryId}${flags.length > 0 ? ` [${flags.join(', ')}]` : ''}`);
        console.log(`  ${entry.summary}`);
        if (entry.replacedByMemoryId) {
          console.log(`  replaced by: ${entry.replacedByMemoryId}`);
        }
        for (const evidence of entry.evidence) {
          if (evidence.kind === 'run' && evidence.runId) {
            console.log(`  evidence run: ${evidence.runId}`);
          }
        }
      }
      return;
    }
    case 'search': {
      const query = parsedCommon.args.join(' ').trim();
      const result = await memorySearch(query, teamOptions);
      printHeader(result.namespace === 'team' ? `Memory search team/${result.teamId}: ${result.query}` : `Memory search: ${result.query}`);
      printKeyValue('matches', result.count);
      for (const match of result.matches) {
        console.log(`- ${match.topic} ${match.memoryId}${match.stale ? ` [stale:${match.staleReason}]` : ''}`);
        console.log(`  ${match.summary}`);
      }
      return;
    }
    case 'add': {
      const parsed = parseAddArgs(parsedCommon.args);
      const result = await memoryAdd(parsed.note, {
        topic: parsed.topic,
        runId: parsed.runId,
        teamId: parsed.teamId ?? parsedCommon.teamId,
      });
      printHeader(`Added ${result.entry.memoryId}`);
      if (result.teamId) {
        printKeyValue('team', result.teamId);
      }
      printKeyValue('topic', result.topic);
      printKeyValue('file', result.topicPath);
      printKeyValue('index', result.indexPath);
      printKeyValue('run', parsed.runId);
      printKeyValue('summary', result.entry.summary);
      return;
    }
    case 'rebuild': {
      const result = await memoryRebuild(teamOptions);
      printHeader(result.namespace === 'team' ? `Memory index rebuilt team/${result.teamId}` : 'Memory index rebuilt');
      printKeyValue('index', result.indexPath);
      printKeyValue('topics', result.topics.length);
      return;
    }
    case 'compact': {
      const result = await memoryCompact(teamOptions);
      printHeader(result.namespace === 'team' ? `Memory compact complete team/${result.teamId}` : 'Memory compact complete');
      printKeyValue('topics updated', result.topicsUpdated);
      printKeyValue('entries checked', result.entriesChecked);
      printKeyValue('stale marked', result.staleMarked);
      printKeyValue('duplicates compacted', result.duplicatesCompacted);
      printKeyValue('consolidated created', result.consolidatedCreated);
      printKeyValue('entries consolidated', result.entriesConsolidated);
      printKeyValue('index', result.indexPath);
      return;
    }
    default:
      throw new Error('Usage: /memory show [topic] [--team <teamId>] | /memory search <query> [--team <teamId>] | /memory add <note> --run <runId> [--topic <topic>] [--team <teamId>] | /memory rebuild [--team <teamId>] | /memory compact [--team <teamId>]');
  }
}

async function runPaths(args) {
  const parsed = extractTeamFlag(args);
  const paths = await getMemoryPaths({ teamId: parsed.teamId });
  printHeader('Memory paths');
  printKeyValue('namespace', paths.namespace);
  if (paths.teamId) {
    printKeyValue('team', paths.teamId);
  }
  printKeyValue('repo', paths.repoRoot);
  printKeyValue('memory dir', paths.memoryDir);
  printKeyValue('index', paths.memoryIndex);
  printKeyValue('topics', paths.memoryTopicsDir);
  printKeyValue('team', paths.memoryTeamDir);
}

function parseAddArgs(args) {
  const noteParts = [];
  let topic = 'general';
  let runId = '';
  let teamId = null;

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--topic') {
      topic = args[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (value === '--run') {
      runId = args[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (value === '--team') {
      teamId = args[index + 1] ?? '';
      index += 1;
      continue;
    }
    noteParts.push(value);
  }

  return {
    note: noteParts.join(' ').trim(),
    topic,
    runId,
    teamId,
  };
}

function extractTeamFlag(args) {
  const filtered = [];
  let teamId = null;

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--team') {
      teamId = args[index + 1] ?? '';
      index += 1;
      continue;
    }
    filtered.push(value);
  }

  return {
    teamId,
    args: filtered,
  };
}

function stripSlash(value) {
  return value.startsWith('/') ? value.slice(1) : value;
}

function printHeader(value) {
  console.log(`\n${value}`);
}

function printKeyValue(key, value) {
  console.log(`${key}: ${value}`);
}

function printHelp() {
  console.log('Usage:');
  console.log('  pnpm run memory -- /memory show [topic] [--team <teamId>]');
  console.log('  pnpm run memory -- /memory search <query> [--team <teamId>]');
  console.log('  pnpm run memory -- /memory add <note> --run <runId> [--topic <topic>] [--team <teamId>]');
  console.log('  pnpm run memory -- /memory rebuild [--team <teamId>]');
  console.log('  pnpm run memory -- /memory compact [--team <teamId>]');
  console.log('  pnpm run memory -- paths [--team <teamId>]');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
