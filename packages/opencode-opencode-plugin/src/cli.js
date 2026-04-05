const EXTENSION_STACK_PATH = process.env.EXTENSION_STACK_PATH ?? '/mnt/GOONDRIVE/Repos/opencode-extension-stack';

const PKG_BIN = {
  kairos: `${EXTENSION_STACK_PATH}/packages/opencode-kairos/src/cli.js`,
  memory: `${EXTENSION_STACK_PATH}/packages/opencode-memory/src/cli.js`,
  orchestrator: `${EXTENSION_STACK_PATH}/packages/opencode-orchestrator/src/cli.js`,
  packs: `${EXTENSION_STACK_PATH}/packages/opencode-packs/src/cli.js`,
  bridge: `${EXTENSION_STACK_PATH}/packages/opencode-bridge/src/cli.js`,
};

export async function runCli(pkg, args, options = {}) {
  const cliPath = PKG_BIN[pkg];
  if (!cliPath) {
    throw new Error(`Unknown package: ${pkg}`);
  }

  const fullArgs = args.map((a) => String(a));
  const result = await Bun.$`node ${cliPath} ${fullArgs}`.text();

  if (options.throwOnStderr) {
    // no-op for now
  }

  return result.trim();
}

export function buildArgs(scheme, args) {
  const out = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const v of value) {
        out.push(`--${key}`, String(v));
      }
    } else if (typeof value === 'boolean') {
      if (value) out.push(`--${key}`);
    } else {
      out.push(`--${key}`, String(value));
    }
  }
  return out;
}
