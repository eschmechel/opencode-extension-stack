#!/usr/bin/env node

import fs from 'node:fs/promises';

import {
  completePackInvocation,
  executePack,
  listPacks,
  listPackHistory,
  renderPack,
  showPack,
  showPackInvocation,
  validatePackOutput,
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

  if (['ultraplan', 'review', 'review-remote', 'triage', 'handoff'].includes(command)) {
    const rendered = renderPack(command, { request: args.slice(1).join(' ') });
    printRenderedPack(rendered);
    return;
  }

  if (command === 'packs') {
    await runPacks(args.slice(1));
    return;
  }

  if (command === 'help') {
    printHelp();
    return;
  }

  throw new Error(`Unknown command: ${args[0]}`);
}

async function runPacks(args) {
  const subcommand = args[0];
  switch (subcommand) {
    case 'list': {
      const packs = listPacks();
      printHeader(`Packs (${packs.length})`);
      for (const pack of packs) {
        console.log(`- ${pack.name} (${pack.aliases.join(', ')})`);
        console.log(`  ${pack.description}`);
        console.log(`  examples: ${pack.exampleCount}`);
      }
      return;
    }
    case 'show': {
      const pack = showPack(args[1] ?? '');
      printHeader(`Pack ${pack.name}`);
      printKeyValue('title', pack.title);
      printKeyValue('aliases', pack.aliases.join(', '));
      printKeyValue('preferred agent', pack.agentPreset.preferredAgent);
      printKeyValue('mode', pack.agentPreset.mode);
      printKeyValue('reasoning', pack.modelDefaults.reasoning);
      printKeyValue('verbosity', pack.modelDefaults.verbosity);
      printKeyValue('description', pack.description);
      printKeyValue('examples', pack.examples.length);
      if (pack.examples.length > 0) {
        printHeader('Example descriptions');
        for (const example of pack.examples) {
          console.log(`- ${example.description}`);
        }
      }
      printHeader('Output contract');
      console.log(JSON.stringify(pack.outputContract, null, 2));
      return;
    }
    case 'examples': {
      const pack = showPack(args[1] ?? '');
      printHeader(`Examples for ${pack.name}`);
      console.log(JSON.stringify(pack.examples, null, 2));
      return;
    }
    case 'contract': {
      const pack = showPack(args[1] ?? '');
      console.log(JSON.stringify(pack.outputContract, null, 2));
      return;
    }
    case 'render': {
      const parsed = parsePackInputArgs(args.slice(1));
      const rendered = renderPack(parsed.packName, {
        request: parsed.request,
        context: parsed.context,
        constraints: parsed.constraints,
      });
      if (parsed.json) {
        console.log(JSON.stringify(rendered, null, 2));
        return;
      }
      printRenderedPack(rendered);
      return;
    }
    case 'execute': {
      const parsed = parsePackInputArgs(args.slice(1));
      const invocation = await executePack(parsed.packName, {
        request: parsed.request,
        context: parsed.context,
        constraints: parsed.constraints,
      }, {
        channel: parsed.channel,
      });
      if (parsed.json) {
        console.log(JSON.stringify(invocation, null, 2));
        return;
      }
      printHeader(`Prepared ${invocation.invocationId}`);
      printKeyValue('pack', invocation.packName);
      printKeyValue('status', invocation.status);
      printKeyValue('channel', invocation.channel);
      printKeyValue('path', invocation.invocationPath);
      printHeader('Handoff');
      console.log(JSON.stringify(invocation.handoff, null, 2));
      return;
    }
    case 'complete': {
      const parsed = await parseCompletionArgs(args.slice(1));
      const invocation = await completePackInvocation(parsed.invocationId, parsed.output);
      if (parsed.json) {
        console.log(JSON.stringify(invocation, null, 2));
        return;
      }
      printHeader(`Completed ${invocation.invocationId}`);
      printKeyValue('pack', invocation.packName);
      printKeyValue('status', invocation.status);
      printKeyValue('path', invocation.invocationPath);
      if (invocation.completion && invocation.completion.errors.length > 0) {
        printHeader('Errors');
        for (const error of invocation.completion.errors) {
          console.log(`- ${error}`);
        }
      }
      return;
    }
    case 'invocation': {
      const invocation = await showPackInvocation(args[1] ?? '');
      console.log(JSON.stringify(invocation, null, 2));
      return;
    }
    case 'history': {
      const parsed = parseHistoryArgs(args.slice(1));
      const history = await listPackHistory(parsed);
      printHeader(`Pack history (${history.count})`);
      for (const entry of history.entries) {
        console.log(`- ${entry.invocationId} ${entry.packName} ${entry.action} ${entry.status} ${entry.at}`);
      }
      return;
    }
    case 'validate': {
      const packName = args[1] ?? '';
      const output = args.slice(2).join(' ').trim();
      const result = validatePackOutput(packName, output);
      printHeader(`Validation ${result.valid ? 'passed' : 'failed'}`);
      if (!result.valid) {
        for (const error of result.errors) {
          console.log(`- ${error}`);
        }
      }
      return;
    }
    default:
      throw new Error('Usage: /packs list | /packs show <pack> | /packs examples <pack> | /packs contract <pack> | /packs render <pack> <request> [--context <text>] [--constraint <text>] [--json] | /packs execute <pack> <request> [--context <text>] [--constraint <text>] [--channel <local|remote>] [--json] | /packs complete <invocationId> (--output-json <json> | --output-file <path>) [--json] | /packs invocation <invocationId> | /packs history [limit] [--pack <pack>] [--action <action>] | /packs validate <pack> <json>');
  }
}

function parsePackInputArgs(args) {
  const packName = args[0] ?? '';
  const requestParts = [];
  const constraints = [];
  let context = '';
  let channel = 'local';
  let json = false;

  for (let index = 1; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--context') {
      context = args[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (value === '--constraint') {
      constraints.push(args[index + 1] ?? '');
      index += 1;
      continue;
    }
    if (value === '--channel') {
      channel = args[index + 1] ?? 'local';
      index += 1;
      continue;
    }
    if (value === '--json') {
      json = true;
      continue;
    }
    requestParts.push(value);
  }

  return {
    packName,
    request: requestParts.join(' ').trim(),
    context,
    constraints: constraints.filter(Boolean),
    channel,
    json,
  };
}

async function parseCompletionArgs(args) {
  const invocationId = args[0] ?? '';
  let output = null;
  let json = false;

  for (let index = 1; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--output-json') {
      output = args[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (value === '--output-file') {
      output = await fs.readFile(args[index + 1] ?? '', 'utf8');
      index += 1;
      continue;
    }
    if (value === '--json') {
      json = true;
    }
  }

  if (output === null) {
    throw new Error('packs complete requires --output-json <json> or --output-file <path>.');
  }

  return {
    invocationId,
    output,
    json,
  };
}

function parseHistoryArgs(args) {
  let limit = 20;
  let packName = null;
  let action = null;

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (/^\d+$/.test(value)) {
      limit = Number(value);
      continue;
    }
    if (value === '--pack') {
      packName = args[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (value === '--action') {
      action = args[index + 1] ?? null;
      index += 1;
    }
  }

  return {
    limit,
    packName,
    action,
  };
}

function printRenderedPack(rendered) {
  printHeader(`Pack ${rendered.pack.name}`);
  printKeyValue('title', rendered.pack.title);
  printKeyValue('preferred agent', rendered.pack.agentPreset.preferredAgent);
  printKeyValue('mode', rendered.pack.agentPreset.mode);
  printKeyValue('reasoning', rendered.pack.modelDefaults.reasoning);
  printKeyValue('examples', rendered.examples.length);
  printHeader('Prompt');
  console.log(rendered.prompt);
  printHeader('Output contract');
  console.log(JSON.stringify(rendered.outputContract, null, 2));
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
  console.log('  pnpm run packs -- /packs list');
  console.log('  pnpm run packs -- /packs show <pack>');
  console.log('  pnpm run packs -- /packs examples <pack>');
  console.log('  pnpm run packs -- /packs contract <pack>');
  console.log('  pnpm run packs -- /packs render <pack> <request> [--context <text>] [--constraint <text>] [--json]');
  console.log('  pnpm run packs -- /packs execute <pack> <request> [--context <text>] [--constraint <text>] [--channel <local|remote>] [--json]');
  console.log('  pnpm run packs -- /packs complete <invocationId> (--output-json <json> | --output-file <path>) [--json]');
  console.log('  pnpm run packs -- /packs invocation <invocationId>');
  console.log('  pnpm run packs -- /packs history [limit] [--pack <pack>] [--action <action>]');
  console.log('  pnpm run packs -- /packs validate <pack> <json>');
  console.log('  pnpm run packs -- /ultraplan <request>');
  console.log('  pnpm run packs -- /review <request>');
  console.log('  pnpm run packs -- /review-remote <request>');
  console.log('  pnpm run packs -- /triage <request>');
  console.log('  pnpm run packs -- /handoff <request>');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
