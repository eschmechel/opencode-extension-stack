#!/usr/bin/env node
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { cpSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const PLUGIN_SRC = resolve(ROOT, 'packages/opencode-opencode-plugin/src');
const PLUGIN_DEST = resolve(process.env.HOME, '.config/opencode/plugins/opencode-opencode-plugin');
const CONFIG_PATH = resolve(process.env.HOME, '.config/opencode/opencode.jsonc');

console.log('Installing opencode-opencode-plugin...');

mkdirSync(PLUGIN_DEST, { recursive: true });
cpSync(PLUGIN_SRC, PLUGIN_DEST, { recursive: true });
console.log(`  Copied plugin to ${PLUGIN_DEST}`);

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
