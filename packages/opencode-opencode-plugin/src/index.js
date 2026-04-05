import { tool } from '@opencode-ai/plugin';

import * as kairos from './kairos-tools.js';
import * as memory from './memory-tools.js';
import * as orchestrator from './orchestrator-tools.js';
import * as packs from './pack-tools.js';
import * as bridge from './bridge-tools.js';

const EXTENSION_STACK_PATH = process.env.EXTENSION_STACK_PATH ?? '/mnt/GOONDRIVE/Repos/opencode-extension-stack';

async function triggerDaemon() {
  try {
    const cliPath = `${EXTENSION_STACK_PATH}/packages/opencode-kairos/src/cli.js`;
    await Bun.$`node ${cliPath} runner once`.text();
  } catch {
    // Non-fatal — daemon may be stopped or no jobs available
  }
}

export const OpencodeExtensionPlugin = async (ctx) => {
  return {
    tool: {
      ...kairos,
      ...memory,
      ...orchestrator,
      ...packs,
      ...bridge,
    },
    event: async ({ event }) => {
      if (event.type === 'session.idle') {
        await triggerDaemon();
      }
    },
  };
};
