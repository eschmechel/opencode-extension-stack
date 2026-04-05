#!/usr/bin/env node
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { cpSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const PLUGIN_PKG = resolve(ROOT, 'packages/opencode-opencode-plugin');
const PLUGIN_DEST = resolve(process.env.HOME, '.config/opencode/plugins/opencode-opencode-plugin');
const CONFIG_PATH = resolve(process.env.HOME, '.config/opencode/opencode.jsonc');
const GLOBAL_MODULES = resolve(process.env.HOME, '.config/opencode/node_modules');

console.log('Installing opencode-opencode-plugin...');

mkdirSync(PLUGIN_DEST, { recursive: true });
cpSync(resolve(PLUGIN_PKG, 'src'), PLUGIN_DEST, { recursive: true });
writeFileSync(resolve(PLUGIN_DEST, 'package.json'), JSON.stringify({
  name: 'opencode-opencode-plugin',
  version: '0.1.0',
  type: 'module',
  main: './index.js',
  exports: './index.js',
}, null, 2) + '\n');
console.log(`  Copied plugin to ${PLUGIN_DEST}`);

mkdirSync(resolve(PLUGIN_DEST, 'node_modules/@opencode-ai'), { recursive: true });
try {
  symlinkSync(resolve(GLOBAL_MODULES, '@opencode-ai/plugin'), resolve(PLUGIN_DEST, 'node_modules/@opencode-ai/plugin'));
  symlinkSync(resolve(GLOBAL_MODULES, '@opencode-ai/sdk'), resolve(PLUGIN_DEST, 'node_modules/@opencode-ai/sdk'));
  symlinkSync(resolve(GLOBAL_MODULES, 'zod'), resolve(PLUGIN_DEST, 'node_modules/zod'));
  console.log('  Linked dependencies');
} catch (err) {
  if (err.code !== 'EEXIST') console.error('  Warning:', err.message);
}

let config;
try {
  const raw = readFileSync(CONFIG_PATH, 'utf8');
  const cleaned = raw
    .replace(/^\/\/.*$/gm, '')
    .replace(/,\s*}/g, '}')
    .replace(/,\s*]/g, ']');
  config = JSON.parse(cleaned);
} catch {
  config = { $schema: 'https://opencode.ai/config.json', plugin: [], mcp: {} };
}

const pluginEntry = 'opencode-opencode-plugin';
const plugins = Array.isArray(config.plugin) ? config.plugin : (config.plugin ? [config.plugin] : []);
if (!plugins.includes(pluginEntry)) {
  plugins.push(pluginEntry);
  config.plugin = plugins;
}

const newContent = JSON.stringify(config, null, 2);
writeFileSync(CONFIG_PATH, `${newContent}\n`);
console.log(`  Added "${pluginEntry}" to ${CONFIG_PATH}`);

console.log('\nDone! Restart OpenCode to load the plugin.');
console.log('\nOptional: set EXTENSION_STACK_PATH if your extension stack is not at the default location:');
console.log(`  export EXTENSION_STACK_PATH=/path/to/your/opencode-extension-stack`);
console.log(`  Default: /mnt/GOONDRIVE/Repos/opencode-extension-stack`);
