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
      properties: {
        request: { type: 'string', description: 'The user goal or request to plan.' },
        context: { type: 'string', description: 'Optional extra context or repo findings.' },
        constraints: { type: 'array', items: { type: 'string' }, description: 'Explicit constraints to preserve.' },
      },
    },
    outputContract: {
      format: 'json',
      schema: {
        type: 'object',
        required: ['goal', 'constraints', 'assumptions', 'plan', 'validation'],
        properties: {
          goal: { type: 'string' },
          constraints: { type: 'array', items: { type: 'string' } },
          assumptions: { type: 'array', items: { type: 'string' } },
          plan: {
            type: 'array',
            items: {
              type: 'object',
              required: ['step', 'why', 'validation'],
              properties: {
                step: { type: 'string' },
                why: { type: 'string' },
                validation: { type: 'string' },
              },
            },
          },
          validation: { type: 'array', items: { type: 'string' } },
          risks: { type: 'array', items: { type: 'string' } },
        },
      },
    },
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
      properties: {
        request: { type: 'string', description: 'What to review: diff, feature, PR, or file set.' },
        context: { type: 'string', description: 'Optional additional implementation context.' },
        constraints: { type: 'array', items: { type: 'string' }, description: 'Extra review instructions or focus areas.' },
      },
    },
    outputContract: {
      format: 'json',
      schema: {
        type: 'object',
        required: ['findings', 'openQuestions', 'summary'],
        properties: {
          findings: {
            type: 'array',
            items: {
              type: 'object',
              required: ['severity', 'title', 'location', 'issue', 'risk'],
              properties: {
                severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
                title: { type: 'string' },
                location: { type: 'string' },
                issue: { type: 'string' },
                risk: { type: 'string' },
                recommendation: { type: 'string' },
              },
            },
          },
          openQuestions: { type: 'array', items: { type: 'string' } },
          summary: { type: 'string' },
        },
      },
    },
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
      properties: {
        request: { type: 'string', description: 'Remote review scope or review request.' },
        context: { type: 'string', description: 'Optional snapshot, summary, or diff context.' },
        constraints: { type: 'array', items: { type: 'string' }, description: 'Remote handoff requirements.' },
      },
    },
    outputContract: {
      format: 'json',
      schema: {
        type: 'object',
        required: ['approval', 'blockingFindings', 'nonBlockingFindings', 'handoff'],
        properties: {
          approval: { type: 'string', enum: ['approved', 'changes_requested', 'needs_clarification'] },
          blockingFindings: { type: 'array', items: { type: 'string' } },
          nonBlockingFindings: { type: 'array', items: { type: 'string' } },
          handoff: {
            type: 'object',
            required: ['summary', 'nextActions'],
            properties: {
              summary: { type: 'string' },
              nextActions: { type: 'array', items: { type: 'string' } },
              remoteNotes: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
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
];

const PACK_INDEX = new Map();
for (const definition of PACK_DEFINITIONS) {
  PACK_INDEX.set(definition.name, definition);
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
  };
}

export function validatePackOutput(name, output) {
  const pack = getPack(name);
  const parsed = typeof output === 'string' ? JSON.parse(output) : output;

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
  return {
    ...definition,
    aliases: definition.aliases.map((alias) => normalizeAlias(alias)),
  };
}

function summarizePack(pack) {
  return {
    name: pack.name,
    aliases: pack.aliases,
    title: pack.title,
    description: pack.description,
    agentPreset: pack.agentPreset,
    modelDefaults: pack.modelDefaults,
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
      for (let index = 0; index < value.length; index += 1) {
        validateAgainstSchema(schema.items, value[index], `${path}[${index}]`);
      }
      return;
    }
    case 'string': {
      if (typeof value !== 'string') {
        throw new Error(`Invalid ${path}: expected string.`);
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
