#!/usr/bin/env node

import {
  listPacks,
  renderPack,
  showPack,
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

  if (['ultraplan', 'review', 'review-remote'].includes(command)) {
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
      printHeader('Output contract');
      console.log(JSON.stringify(pack.outputContract, null, 2));
      return;
    }
    case 'contract': {
      const pack = showPack(args[1] ?? '');
      console.log(JSON.stringify(pack.outputContract, null, 2));
      return;
    }
    case 'render': {
      const parsed = parseRenderArgs(args.slice(1));
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
      throw new Error('Usage: /packs list | /packs show <pack> | /packs contract <pack> | /packs render <pack> <request> [--context <text>] [--constraint <text>] [--json] | /packs validate <pack> <json>');
  }
}

function parseRenderArgs(args) {
  const packName = args[0] ?? '';
  const requestParts = [];
  const constraints = [];
  let context = '';
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
    json,
  };
}

function printRenderedPack(rendered) {
  printHeader(`Pack ${rendered.pack.name}`);
  printKeyValue('title', rendered.pack.title);
  printKeyValue('preferred agent', rendered.pack.agentPreset.preferredAgent);
  printKeyValue('mode', rendered.pack.agentPreset.mode);
  printKeyValue('reasoning', rendered.pack.modelDefaults.reasoning);
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
  console.log('  pnpm run packs -- /packs contract <pack>');
  console.log('  pnpm run packs -- /packs render <pack> <request> [--context <text>] [--constraint <text>] [--json]');
  console.log('  pnpm run packs -- /packs validate <pack> <json>');
  console.log('  pnpm run packs -- /ultraplan <request>');
  console.log('  pnpm run packs -- /review <request>');
  console.log('  pnpm run packs -- /review-remote <request>');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
