import fs from 'node:fs/promises';
import path from 'node:path';

import {
  createStableId,
  ensureStateLayout,
  findRepoRoot,
  getOpencodePaths,
} from '@opencode-extension-stack/opencode-core';

const PACK_CHANNELS = new Set(['local', 'remote']);

const PACK_DEFINITIONS = [
  createPackDefinition({
    name: 'ultraplan',
    aliases: ['/ultraplan'],
    title: 'Ultraplan',
    description: 'Turn a request into an execution-ready plan with assumptions, risks, and validation.',
    agentPreset: {
      preferredAgent: 'general',
      mode: 'analysis',
      writeAccess: 'none',
    },
    modelDefaults: {
      reasoning: 'high',
      verbosity: 'medium',
      temperature: 0.2,
    },
    inputContract: {
      type: 'object',
      required: ['request'],
      additionalProperties: false,
      properties: {
        request: { type: 'string', minLength: 1, description: 'The user goal or request to plan.' },
        context: { type: 'string', description: 'Optional extra context or repo findings.' },
        constraints: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          description: 'Explicit constraints to preserve.',
        },
      },
    },
    outputContract: {
      format: 'json',
      schema: {
        type: 'object',
        required: ['goal', 'constraints', 'assumptions', 'plan', 'validation'],
        additionalProperties: false,
        properties: {
          goal: { type: 'string', minLength: 1 },
          constraints: { type: 'array', items: { type: 'string', minLength: 1 } },
          assumptions: { type: 'array', items: { type: 'string', minLength: 1 } },
          plan: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['step', 'why', 'validation'],
              additionalProperties: false,
              properties: {
                step: { type: 'string', minLength: 1 },
                why: { type: 'string', minLength: 1 },
                validation: { type: 'string', minLength: 1 },
              },
            },
          },
          validation: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
          risks: { type: 'array', items: { type: 'string', minLength: 1 } },
        },
      },
    },
    examples: [
      {
        description: 'Plan a safe rollout for a new background worker feature.',
        input: {
          request: 'Design a safe rollout plan for a new background worker feature.',
          context: 'Phase 1 queueing and Phase 3 memory are already implemented.',
          constraints: ['Keep commits small', 'Preserve existing CLI commands'],
        },
        output: {
          goal: 'Roll out the worker feature safely without breaking existing CLI workflows.',
          constraints: ['Keep commits small', 'Preserve existing CLI commands'],
          assumptions: ['Existing worker state files are stable enough to extend.'],
          plan: [
            {
              step: 'Add the smallest worker state changes behind existing command paths.',
              why: 'This limits review scope and avoids command-surface churn.',
              validation: 'Run worker lifecycle tests and a CLI smoke check.',
            },
          ],
          validation: ['Run the targeted worker tests and the full repository test suite.'],
          risks: ['Concurrent work on orchestrator state could cause schema drift.'],
        },
      },
    ],
    render(input) {
      return [
        'You are executing the /ultraplan pack.',
        'Produce an execution-ready plan, not code.',
        'Prefer explicit assumptions and concrete validation over generic advice.',
        '',
        `Request: ${input.request}`,
        ...(input.context ? ['', 'Context:', input.context] : []),
        ...(input.constraints.length > 0 ? ['', 'Constraints:', ...input.constraints.map((entry) => `- ${entry}`)] : []),
        '',
        'Return JSON matching the output contract exactly.',
      ].join('\n');
    },
  }),
  createPackDefinition({
    name: 'review',
    aliases: ['/review'],
    title: 'Review',
    description: 'Produce a code-review style report with findings first and concrete risks.',
    agentPreset: {
      preferredAgent: 'CodeReviewer',
      mode: 'review',
      writeAccess: 'none',
    },
    modelDefaults: {
      reasoning: 'high',
      verbosity: 'medium',
      temperature: 0.1,
    },
    inputContract: {
      type: 'object',
      required: ['request'],
      additionalProperties: false,
      properties: {
        request: { type: 'string', minLength: 1, description: 'What to review: diff, feature, PR, or file set.' },
        context: { type: 'string', description: 'Optional additional implementation context.' },
        constraints: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          description: 'Extra review instructions or focus areas.',
        },
      },
    },
    outputContract: {
      format: 'json',
      schema: {
        type: 'object',
        required: ['findings', 'openQuestions', 'summary'],
        additionalProperties: false,
        properties: {
          findings: {
            type: 'array',
            items: {
              type: 'object',
              required: ['severity', 'title', 'location', 'issue', 'risk'],
              additionalProperties: false,
              properties: {
                severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
                title: { type: 'string', minLength: 1 },
                location: { type: 'string', minLength: 1 },
                issue: { type: 'string', minLength: 1 },
                risk: { type: 'string', minLength: 1 },
                recommendation: { type: 'string', minLength: 1 },
              },
            },
          },
          openQuestions: { type: 'array', items: { type: 'string', minLength: 1 } },
          summary: { type: 'string', minLength: 1 },
        },
      },
    },
    examples: [
      {
        description: 'Review a config schema change.',
        input: {
          request: 'Review the config schema update for retention and memory policies.',
          constraints: ['Findings first'],
        },
        output: {
          findings: [
            {
              severity: 'high',
              title: 'Missing default migration path',
              location: 'packages/opencode-core/src/schemas.js:42',
              issue: 'Older config files are not normalized before validation.',
              risk: 'Existing repos may fail to load config after upgrade.',
              recommendation: 'Normalize missing fields through defaultConfig before validating.',
            },
          ],
          openQuestions: ['Should older repos be auto-migrated or just defaulted in memory?'],
          summary: 'One high-severity migration risk needs to be addressed.',
        },
      },
    ],
    render(input) {
      return [
        'You are executing the /review pack.',
        'Review with a skeptical code-review mindset.',
        'List findings first, ordered by severity, with concrete file/line references when available.',
        'Keep overviews brief and secondary to findings.',
        '',
        `Review target: ${input.request}`,
        ...(input.context ? ['', 'Context:', input.context] : []),
        ...(input.constraints.length > 0 ? ['', 'Focus areas:', ...input.constraints.map((entry) => `- ${entry}`)] : []),
        '',
        'Return JSON matching the output contract exactly.',
      ].join('\n');
    },
  }),
  createPackDefinition({
    name: 'review-remote',
    aliases: ['/review-remote'],
    title: 'Review Remote',
    description: 'Prepare a remote-friendly review packet with approval status and handoff guidance.',
    agentPreset: {
      preferredAgent: 'CodeReviewer',
      mode: 'remote_review',
      writeAccess: 'none',
    },
    modelDefaults: {
      reasoning: 'high',
      verbosity: 'medium',
      temperature: 0.1,
    },
    inputContract: {
      type: 'object',
      required: ['request'],
      additionalProperties: false,
      properties: {
        request: { type: 'string', minLength: 1, description: 'Remote review scope or review request.' },
        context: { type: 'string', description: 'Optional snapshot, summary, or diff context.' },
        constraints: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          description: 'Remote handoff requirements.',
        },
      },
    },
    outputContract: {
      format: 'json',
      schema: {
        type: 'object',
        required: ['approval', 'blockingFindings', 'nonBlockingFindings', 'handoff'],
        additionalProperties: false,
        properties: {
          approval: { type: 'string', enum: ['approved', 'changes_requested', 'needs_clarification'] },
          blockingFindings: { type: 'array', items: { type: 'string', minLength: 1 } },
          nonBlockingFindings: { type: 'array', items: { type: 'string', minLength: 1 } },
          handoff: {
            type: 'object',
            required: ['summary', 'nextActions'],
            additionalProperties: false,
            properties: {
              summary: { type: 'string', minLength: 1 },
              nextActions: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
              remoteNotes: { type: 'array', items: { type: 'string', minLength: 1 } },
            },
          },
        },
      },
    },
    examples: [
      {
        description: 'Create an async approval packet for remote review.',
        input: {
          request: 'Review the queued remote changes for the release branch.',
          context: 'Snapshot and diff summary already uploaded.',
        },
        output: {
          approval: 'changes_requested',
          blockingFindings: ['Release branch lacks rollback notes.'],
          nonBlockingFindings: ['Add a clearer summary for remote approvers.'],
          handoff: {
            summary: 'Remote review found one blocking issue before approval.',
            nextActions: ['Add rollback notes', 'Refresh the remote review packet'],
            remoteNotes: ['Keep the approval thread linked to the refreshed diff.'],
          },
        },
      },
    ],
    render(input) {
      return [
        'You are executing the /review-remote pack.',
        'Produce a remote-review packet suitable for asynchronous approval or rejection.',
        'Call out blocking issues separately from non-blocking issues and end with concrete handoff actions.',
        '',
        `Remote review target: ${input.request}`,
        ...(input.context ? ['', 'Context:', input.context] : []),
        ...(input.constraints.length > 0 ? ['', 'Remote constraints:', ...input.constraints.map((entry) => `- ${entry}`)] : []),
        '',
        'Return JSON matching the output contract exactly.',
      ].join('\n');
    },
  }),
  createPackDefinition({
    name: 'triage',
    aliases: ['/triage'],
    title: 'Triage',
    description: 'Classify a request, assign urgency, and produce immediate next actions.',
    agentPreset: {
      preferredAgent: 'general',
      mode: 'triage',
      writeAccess: 'none',
    },
    modelDefaults: {
      reasoning: 'medium',
      verbosity: 'low',
      temperature: 0.1,
    },
    inputContract: {
      type: 'object',
      required: ['request'],
      additionalProperties: false,
      properties: {
        request: { type: 'string', minLength: 1, description: 'Issue, incident, or incoming request to classify.' },
        context: { type: 'string', description: 'Optional supporting detail.' },
        constraints: { type: 'array', items: { type: 'string', minLength: 1 } },
      },
    },
    outputContract: {
      format: 'json',
      schema: {
        type: 'object',
        required: ['category', 'priority', 'ownerRole', 'summary', 'nextActions'],
        additionalProperties: false,
        properties: {
          category: { type: 'string', enum: ['bug', 'feature', 'ops', 'docs', 'question'] },
          priority: { type: 'string', enum: ['p0', 'p1', 'p2', 'p3'] },
          ownerRole: { type: 'string', minLength: 1 },
          summary: { type: 'string', minLength: 1 },
          nextActions: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
        },
      },
    },
    examples: [
      {
        description: 'Triage an urgent regression report.',
        input: {
          request: 'Background workers stopped processing after the latest retention change.',
        },
        output: {
          category: 'bug',
          priority: 'p1',
          ownerRole: 'runtime maintainer',
          summary: 'The report looks like a runtime regression in worker lifecycle handling.',
          nextActions: ['Reproduce on the current branch', 'Inspect recent worker lifecycle changes'],
        },
      },
    ],
    render(input) {
      return [
        'You are executing the /triage pack.',
        'Classify the request, set urgency, and recommend immediate next actions.',
        '',
        `Request: ${input.request}`,
        ...(input.context ? ['', 'Context:', input.context] : []),
        ...(input.constraints.length > 0 ? ['', 'Constraints:', ...input.constraints.map((entry) => `- ${entry}`)] : []),
        '',
        'Return JSON matching the output contract exactly.',
      ].join('\n');
    },
  }),
  createPackDefinition({
    name: 'handoff',
    aliases: ['/handoff'],
    title: 'Handoff',
    description: 'Prepare a clean handoff summary with current state, risks, and next actions.',
    agentPreset: {
      preferredAgent: 'general',
      mode: 'handoff',
      writeAccess: 'none',
    },
    modelDefaults: {
      reasoning: 'medium',
      verbosity: 'medium',
      temperature: 0.1,
    },
    inputContract: {
      type: 'object',
      required: ['request'],
      additionalProperties: false,
      properties: {
        request: { type: 'string', minLength: 1, description: 'What needs to be handed off.' },
        context: { type: 'string', description: 'Current implementation status or branch context.' },
        constraints: { type: 'array', items: { type: 'string', minLength: 1 } },
      },
    },
    outputContract: {
      format: 'json',
      schema: {
        type: 'object',
        required: ['summary', 'currentState', 'risks', 'nextActions'],
        additionalProperties: false,
        properties: {
          summary: { type: 'string', minLength: 1 },
          currentState: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
          risks: { type: 'array', items: { type: 'string', minLength: 1 } },
          nextActions: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
          blockers: { type: 'array', items: { type: 'string', minLength: 1 } },
        },
      },
    },
    examples: [
      {
        description: 'Hand off a partially completed runtime feature.',
        input: {
          request: 'Hand off the remaining work on prompt packs and remote bridge integration.',
          context: 'The pack registry and CLI are implemented, but remote bridge work is still in progress.',
        },
        output: {
          summary: 'Prompt packs are implemented and the remaining work is in remote bridge integration.',
          currentState: ['Pack registry exists', 'CLI exists', 'Remote bridge work is still active in a separate slice'],
          risks: ['Concurrent bridge changes may shift assumptions for remote handoff commands.'],
          nextActions: ['Sync with the bridge slice', 'Decide how remote pack execution packets should be consumed'],
          blockers: [],
        },
      },
    ],
    render(input) {
      return [
        'You are executing the /handoff pack.',
        'Summarize the current state clearly for another human or agent to continue safely.',
        '',
        `Handoff target: ${input.request}`,
        ...(input.context ? ['', 'Context:', input.context] : []),
        ...(input.constraints.length > 0 ? ['', 'Constraints:', ...input.constraints.map((entry) => `- ${entry}`)] : []),
        '',
        'Return JSON matching the output contract exactly.',
      ].join('\n');
    },
  }),
];

const PACK_INDEX = new Map();
for (const definition of PACK_DEFINITIONS) {
  PACK_INDEX.set(definition.name, definition);
  PACK_INDEX.set(normalizePackName(definition.name), definition);
  for (const alias of definition.aliases) {
    PACK_INDEX.set(normalizePackName(alias), definition);
  }
}

export function listPacks() {
  return PACK_DEFINITIONS.map((definition) => summarizePack(definition));
}

export function getPack(name) {
  const normalized = normalizePackName(name);
  const pack = PACK_INDEX.get(normalized);
  if (!pack) {
    throw new Error(`Unknown pack: ${name}`);
  }
  return pack;
}

export function showPack(name) {
  const pack = getPack(name);
  return {
    ...summarizePack(pack),
    inputContract: pack.inputContract,
    outputContract: pack.outputContract,
    examples: pack.examples,
  };
}

export function renderPack(name, input = {}) {
  const pack = getPack(name);
  const normalizedInput = normalizePackInput(input);
  validateAgainstSchema(pack.inputContract, normalizedInput, 'input');

  return {
    pack: summarizePack(pack),
    input: normalizedInput,
    prompt: pack.render(normalizedInput),
    outputContract: pack.outputContract,
    examples: pack.examples,
  };
}

export async function executePack(name, input = {}, options = {}) {
  const pack = getPack(name);
  const rendered = renderPack(pack.name, input);
  const repoRoot = await prepareRepo(options.cwd);
  const nowIso = toIso(options.now);
  const channel = normalizeChannel(options.channel);
  const invocationId = createStableId('pack');
  const invocationPath = getInvocationPath(repoRoot, invocationId);

  const invocation = {
    invocationId,
    packName: pack.name,
    createdAt: nowIso,
    updatedAt: nowIso,
    status: 'prepared',
    channel,
    pack: summarizePack(pack),
    input: rendered.input,
    prompt: rendered.prompt,
    outputContract: rendered.outputContract,
    handoff: buildHandoffPacket(pack, rendered, channel, invocationId),
    completion: null,
  };

  await saveInvocation(invocationPath, invocation);
  await appendPackHistory(repoRoot, {
    at: nowIso,
    invocationId,
    action: 'execute',
    packName: pack.name,
    channel,
    status: invocation.status,
    request: rendered.input.request,
  });

  return {
    ...invocation,
    repoRoot,
    invocationPath,
  };
}

export async function completePackInvocation(invocationId, output, options = {}) {
  const trimmedInvocationId = String(invocationId ?? '').trim();
  if (!trimmedInvocationId) {
    throw new Error('A pack invocation id is required.');
  }

  const repoRoot = await prepareRepo(options.cwd);
  const invocationPath = getInvocationPath(repoRoot, trimmedInvocationId);
  const invocation = await readInvocation(invocationPath);
  const validation = validatePackOutput(invocation.packName, output);
  const nowIso = toIso(options.now);

  const updatedInvocation = {
    ...invocation,
    updatedAt: nowIso,
    status: validation.valid ? 'completed' : 'invalid_output',
    completion: {
      validatedAt: nowIso,
      valid: validation.valid,
      errors: validation.errors,
      output: validation.parsed,
    },
  };

  await saveInvocation(invocationPath, updatedInvocation);
  await appendPackHistory(repoRoot, {
    at: nowIso,
    invocationId: trimmedInvocationId,
    action: 'complete',
    packName: invocation.packName,
    channel: invocation.channel,
    status: updatedInvocation.status,
    request: invocation.input.request,
  });

  return {
    ...updatedInvocation,
    repoRoot,
    invocationPath,
  };
}

export async function showPackInvocation(invocationId, options = {}) {
  const trimmedInvocationId = String(invocationId ?? '').trim();
  if (!trimmedInvocationId) {
    throw new Error('A pack invocation id is required.');
  }

  const repoRoot = await prepareRepo(options.cwd);
  const invocationPath = getInvocationPath(repoRoot, trimmedInvocationId);
  return {
    ...(await readInvocation(invocationPath)),
    repoRoot,
    invocationPath,
  };
}

export async function listPackHistory(options = {}) {
  const repoRoot = await prepareRepo(options.cwd);
  const paths = getOpencodePaths(repoRoot);
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 20;
  const history = await readLastJsonLines(paths.packHistory, limit * 5);
  const packName = options.packName ? normalizePackName(options.packName) : null;
  const action = options.action ? String(options.action).trim() : null;

  const filtered = history.filter((entry) => {
    if (packName && entry.packName !== packName) {
      return false;
    }
    if (action && entry.action !== action) {
      return false;
    }
    return true;
  }).slice(0, limit);

  return {
    repoRoot,
    count: filtered.length,
    entries: filtered,
  };
}

export function validatePackOutput(name, output) {
  const pack = getPack(name);
  let parsed;

  try {
    parsed = typeof output === 'string' ? JSON.parse(output) : output;
  } catch (error) {
    return {
      valid: false,
      errors: [error instanceof Error ? error.message : String(error)],
      parsed: null,
    };
  }

  try {
    validateAgainstSchema(pack.outputContract.schema, parsed, 'output');
    return {
      valid: true,
      errors: [],
      parsed,
    };
  } catch (error) {
    return {
      valid: false,
      errors: [error instanceof Error ? error.message : String(error)],
      parsed,
    };
  }
}

function createPackDefinition(definition) {
  const normalized = {
    ...definition,
    aliases: definition.aliases.map((alias) => normalizeAlias(alias)),
    examples: (definition.examples ?? []).map((example) => ({
      description: String(example.description ?? '').trim(),
      input: normalizePackInput(example.input ?? {}),
      output: example.output,
    })),
  };

  for (const example of normalized.examples) {
    validateAgainstSchema(normalized.inputContract, example.input, `${normalized.name}.example.input`);
    validateAgainstSchema(normalized.outputContract.schema, example.output, `${normalized.name}.example.output`);
  }

  return normalized;
}

function summarizePack(pack) {
  return {
    name: pack.name,
    aliases: pack.aliases,
    title: pack.title,
    description: pack.description,
    agentPreset: pack.agentPreset,
    modelDefaults: pack.modelDefaults,
    exampleCount: pack.examples.length,
  };
}

function normalizePackInput(input) {
  return {
    request: String(input.request ?? '').trim(),
    context: typeof input.context === 'string' && input.context.trim() ? input.context.trim() : '',
    constraints: Array.isArray(input.constraints)
      ? input.constraints.map((entry) => String(entry).trim()).filter(Boolean)
      : [],
  };
}

function normalizePackName(name) {
  return String(name ?? '').trim().toLowerCase().replace(/^\//, '');
}

function normalizeAlias(alias) {
  return alias.startsWith('/') ? alias : `/${alias}`;
}

function normalizeChannel(channel) {
  const normalized = String(channel ?? 'local').trim().toLowerCase();
  if (!PACK_CHANNELS.has(normalized)) {
    throw new Error(`Invalid pack channel: ${channel}`);
  }
  return normalized;
}

function buildHandoffPacket(pack, rendered, channel, invocationId) {
  return {
    packetVersion: 1,
    invocationId,
    channel,
    preferredAgent: pack.agentPreset.preferredAgent,
    mode: pack.agentPreset.mode,
    modelDefaults: pack.modelDefaults,
    prompt: rendered.prompt,
    outputContract: rendered.outputContract,
    suggestedCommand: channel === 'remote'
      ? `pnpm run packs -- /packs execute ${pack.name} "${rendered.input.request}" --channel remote`
      : `pnpm run packs -- /packs execute ${pack.name} "${rendered.input.request}"`,
  };
}

function validateAgainstSchema(schema, value, path) {
  if (!schema || typeof schema !== 'object') {
    throw new Error(`Invalid schema at ${path}.`);
  }

  switch (schema.type) {
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Invalid ${path}: expected object.`);
      }
      for (const key of schema.required ?? []) {
        if (!(key in value)) {
          throw new Error(`Invalid ${path}: missing required field ${key}.`);
        }
      }
      if (schema.additionalProperties === false) {
        const allowedKeys = new Set(Object.keys(schema.properties ?? {}));
        for (const key of Object.keys(value)) {
          if (!allowedKeys.has(key)) {
            throw new Error(`Invalid ${path}: unexpected field ${key}.`);
          }
        }
      }
      for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
        if (value[key] === undefined) {
          continue;
        }
        validateAgainstSchema(propertySchema, value[key], `${path}.${key}`);
      }
      return;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        throw new Error(`Invalid ${path}: expected array.`);
      }
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        throw new Error(`Invalid ${path}: expected at least ${schema.minItems} items.`);
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        throw new Error(`Invalid ${path}: expected at most ${schema.maxItems} items.`);
      }
      for (let index = 0; index < value.length; index += 1) {
        validateAgainstSchema(schema.items, value[index], `${path}[${index}]`);
      }
      return;
    }
    case 'string': {
      if (typeof value !== 'string') {
        throw new Error(`Invalid ${path}: expected string.`);
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        throw new Error(`Invalid ${path}: expected string length >= ${schema.minLength}.`);
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        throw new Error(`Invalid ${path}: expected string length <= ${schema.maxLength}.`);
      }
      if (schema.enum && !schema.enum.includes(value)) {
        throw new Error(`Invalid ${path}: expected one of ${schema.enum.join(', ')}.`);
      }
      return;
    }
    case 'number': {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        throw new Error(`Invalid ${path}: expected number.`);
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        throw new Error(`Invalid ${path}: expected number >= ${schema.minimum}.`);
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        throw new Error(`Invalid ${path}: expected number <= ${schema.maximum}.`);
      }
      return;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        throw new Error(`Invalid ${path}: expected boolean.`);
      }
      return;
    }
    default:
      throw new Error(`Unsupported schema type at ${path}: ${schema.type}`);
  }
}

async function prepareRepo(cwd) {
  const repoRoot = await findRepoRoot(cwd ?? process.cwd());
  await ensureStateLayout(repoRoot);
  return repoRoot;
}

function getInvocationPath(repoRoot, invocationId) {
  return path.join(getOpencodePaths(repoRoot).packInvocationsDir, `${invocationId}.json`);
}

async function saveInvocation(filePath, invocation) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(invocation, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, filePath);
}

async function readInvocation(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function appendPackHistory(repoRoot, entry) {
  const historyPath = getOpencodePaths(repoRoot).packHistory;
  await fs.appendFile(historyPath, `${JSON.stringify(entry)}\n`, 'utf8');
  return historyPath;
}

async function readLastJsonLines(filePath, limit) {
  if (limit <= 0) {
    return [];
  }

  let content = '';
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  return content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-limit)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    })
    .reverse();
}

function toIso(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();
}
