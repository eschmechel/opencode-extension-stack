import { tool } from '@opencode-ai/plugin';
import { runCli } from './cli.js';

export const memoryShow = tool({
  description: 'Show memory entries for a topic, or all topics if no topic is specified.',
  args: {
    topic: tool.schema.string().optional(),
    team: tool.schema.string().optional(),
  },
  async execute({ topic, team }) {
    const args = topic ? ['/memory', 'show', topic] : ['/memory', 'show'];
    if (team) args.push('--team', team);
    const output = await runCli('memory', args);
    return output;
  },
});

export const memorySearch = tool({
  description: 'Search memory notes across all topics or a team namespace.',
  args: {
    query: tool.schema.string(),
    stale: tool.schema.boolean().optional(),
    repairable: tool.schema.boolean().optional(),
    team: tool.schema.string().optional(),
  },
  async execute({ query, stale, repairable, team }) {
    const args = ['/memory', 'search', query];
    if (stale) args.push('--stale');
    if (repairable) args.push('--repairable');
    if (team) { args.push('--team', team); }
    const output = await runCli('memory', args);
    return output;
  },
});

export const memoryStale = tool({
  description: 'List stale memory entries — notes whose backing evidence is no longer valid.',
  args: {
    repairable: tool.schema.boolean().optional(),
    team: tool.schema.string().optional(),
  },
  async execute({ repairable, team }) {
    const args = ['/memory', 'stale'];
    if (repairable) args.push('--repairable');
    if (team) { args.push('--team', team); }
    const output = await runCli('memory', args);
    return output;
  },
});

export const memoryContradictions = tool({
  description: 'Surface likely opposing claims within a topic — entries with high term overlap but opposing conclusions.',
  args: {
    team: tool.schema.string().optional(),
  },
  async execute({ team }) {
    const args = team ? ['/memory', 'contradictions', '--team', team] : ['/memory', 'contradictions'];
    const output = await runCli('memory', args);
    return output;
  },
});

export const memoryAdd = tool({
  description: 'Add a memory note backed by a successful run, worker, or team result. Requires evidence of success.',
  args: {
    note: tool.schema.string(),
    run: tool.schema.string().optional(),
    worker: tool.schema.string().optional(),
    teamResult: tool.schema.string().optional(),
    topic: tool.schema.string().optional(),
    team: tool.schema.string().optional(),
  },
  async execute({ note, run, worker, teamResult, topic, team }) {
    const args = ['/memory', 'add', note];
    if (run) { args.push('--run', run); }
    if (worker) { args.push('--worker', worker); }
    if (teamResult) { args.push('--team-result', teamResult); }
    if (topic) { args.push('--topic', topic); }
    if (team) { args.push('--team', team); }
    const output = await runCli('memory', args);
    return output;
  },
});

export const memoryRepair = tool({
  description: 'Repair a stale memory note by rebinding it to fresh evidence from a recent successful run.',
  args: {
    memoryId: tool.schema.string(),
    run: tool.schema.string().optional(),
    worker: tool.schema.string().optional(),
    teamResult: tool.schema.string().optional(),
    summary: tool.schema.string().optional(),
    team: tool.schema.string().optional(),
  },
  async execute({ memoryId, run, worker, teamResult, summary, team }) {
    const args = ['/memory', 'repair', memoryId];
    if (run) { args.push('--run', run); }
    if (worker) { args.push('--worker', worker); }
    if (teamResult) { args.push('--team-result', teamResult); }
    if (summary) { args.push('--summary', summary); }
    if (team) { args.push('--team', team); }
    const output = await runCli('memory', args);
    return output;
  },
});

export const memoryMerge = tool({
  description: 'Merge two topics into a target topic. Keeps audit links to source notes.',
  args: {
    topicA: tool.schema.string(),
    topicB: tool.schema.string(),
    target: tool.schema.string().optional(),
    force: tool.schema.boolean().optional(),
    team: tool.schema.string().optional(),
  },
  async execute({ topicA, topicB, target, force, team }) {
    const args = ['/memory', 'merge', topicA, topicB];
    if (target) { args.push('--target', target); }
    if (force) { args.push('--force'); }
    if (team) { args.push('--team', team); }
    const output = await runCli('memory', args);
    return output;
  },
});

export const memoryCompact = tool({
  description: 'Compact memory: refresh stale markers, deduplicate entries, consolidate busy topics.',
  args: {
    team: tool.schema.string().optional(),
  },
  async execute({ team }) {
    const args = team ? ['/memory', 'compact', '--team', team] : ['/memory', 'compact'];
    const output = await runCli('memory', args);
    return output;
  },
});

export const memoryRebuild = tool({
  description: 'Rebuild the MEMORY.md pointer index from all topic files.',
  args: {
    team: tool.schema.string().optional(),
  },
  async execute({ team }) {
    const args = team ? ['/memory', 'rebuild', '--team', team] : ['/memory', 'rebuild'];
    const output = await runCli('memory', args);
    return output;
  },
});
