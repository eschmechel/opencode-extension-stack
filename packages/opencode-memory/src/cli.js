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
      await runPaths();
      return;
    case 'help':
      printHelp();
      return;
    default:
      throw new Error(`Unknown command: ${args[0]}`);
  }
}

async function runMemory(subcommand, args) {
  switch (subcommand) {
    case 'show': {
      const topic = args[0] ?? '';
      const result = await memoryShow(topic);
      if (result.scope === 'index') {
        printHeader('Memory index');
        printKeyValue('index', result.indexPath);
        printKeyValue('topics', result.topics.length);
        for (const topicSummary of result.topics) {
          console.log(`- ${topicSummary.topic} active=${topicSummary.activeCount} stale=${topicSummary.staleCount} updated=${topicSummary.updatedAt}`);
        }
        return;
      }

      printHeader(`Memory topic ${result.topic}`);
      printKeyValue('file', result.topicPath);
      printKeyValue('entries', result.summary.entryCount);
      printKeyValue('active', result.summary.activeCount);
      printKeyValue('stale', result.summary.staleCount);
      for (const entry of result.entries) {
        console.log(`- ${entry.memoryId}${entry.stale ? ` [stale:${entry.staleReason}]` : ''}`);
        console.log(`  ${entry.summary}`);
        for (const evidence of entry.evidence) {
          if (evidence.kind === 'run' && evidence.runId) {
            console.log(`  evidence run: ${evidence.runId}`);
          }
        }
      }
      return;
    }
    case 'search': {
      const query = args.join(' ').trim();
      const result = await memorySearch(query);
      printHeader(`Memory search: ${result.query}`);
      printKeyValue('matches', result.count);
      for (const match of result.matches) {
        console.log(`- ${match.topic} ${match.memoryId}${match.stale ? ` [stale:${match.staleReason}]` : ''}`);
        console.log(`  ${match.summary}`);
      }
      return;
    }
    case 'add': {
      const parsed = parseAddArgs(args);
      const result = await memoryAdd(parsed.note, {
        topic: parsed.topic,
        runId: parsed.runId,
      });
      printHeader(`Added ${result.entry.memoryId}`);
      printKeyValue('topic', result.topic);
      printKeyValue('file', result.topicPath);
      printKeyValue('index', result.indexPath);
      printKeyValue('run', parsed.runId);
      printKeyValue('summary', result.entry.summary);
      return;
    }
    case 'rebuild': {
      const result = await memoryRebuild();
      printHeader('Memory index rebuilt');
      printKeyValue('index', result.indexPath);
      printKeyValue('topics', result.topics.length);
      return;
    }
    case 'compact': {
      const result = await memoryCompact();
      printHeader('Memory compact complete');
      printKeyValue('topics updated', result.topicsUpdated);
      printKeyValue('entries checked', result.entriesChecked);
      printKeyValue('stale marked', result.staleMarked);
      printKeyValue('duplicates compacted', result.duplicatesCompacted);
      printKeyValue('index', result.indexPath);
      return;
    }
    default:
      throw new Error('Usage: /memory show [topic] | /memory search <query> | /memory add <note> --run <runId> [--topic <topic>] | /memory rebuild | /memory compact');
  }
}

async function runPaths() {
  const paths = await getMemoryPaths();
  printHeader('Memory paths');
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
    noteParts.push(value);
  }

  return {
    note: noteParts.join(' ').trim(),
    topic,
    runId,
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
  console.log('  pnpm run memory -- /memory show [topic]');
  console.log('  pnpm run memory -- /memory search <query>');
  console.log('  pnpm run memory -- /memory add <note> --run <runId> [--topic <topic>]');
  console.log('  pnpm run memory -- /memory rebuild');
  console.log('  pnpm run memory -- /memory compact');
  console.log('  pnpm run memory -- paths');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
