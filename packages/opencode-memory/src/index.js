import fs from 'node:fs/promises';
import path from 'node:path';

import {
  createMemoryEntry,
  ensureStateLayout,
  findRepoRoot,
  getOpencodePaths,
  withRepoLock,
} from '../../opencode-core/src/index.js';
import { teamShow } from '../../opencode-orchestrator/src/index.js';

const MEMORY_TOPIC_VERSION = 1;
const TOPIC_CONSOLIDATION_MIN_ACTIVE = 3;
const TOPIC_CONSOLIDATION_SUMMARY_LIMIT = 6;

export async function getMemoryPaths(options = {}) {
  const repoRoot = await prepareRepo(options.cwd);
  const paths = getOpencodePaths(repoRoot);
  const namespacePaths = getNamespacePaths(repoRoot, options);
  await ensureNamespaceLayout(namespacePaths);
  return {
    repoRoot,
    namespace: namespacePaths.namespace,
    teamId: namespacePaths.teamId,
    memoryDir: namespacePaths.memoryDir,
    memoryIndex: namespacePaths.indexPath,
    memoryTopicsDir: namespacePaths.topicsDir,
    memoryTeamDir: paths.memoryTeamDir,
  };
}

export async function memoryShow(topic, options = {}) {
  const repoRoot = await prepareRepo(options.cwd);
  const namespacePaths = getNamespacePaths(repoRoot, options);
  await ensureNamespaceLayout(namespacePaths);

  if (topic && topic.trim()) {
    const slug = slugifyTopic(topic);
    const topicPath = getTopicPath(namespacePaths, slug);
    const topicFile = await loadTopicFile(namespacePaths, slug);
    const summary = buildTopicSummary(namespacePaths, topicFile);

    return {
      repoRoot,
      namespace: namespacePaths.namespace,
      teamId: namespacePaths.teamId,
      scope: 'topic',
      topic: slug,
      topicPath,
      summary,
      entries: sortEntriesNewestFirst(topicFile.entries),
    };
  }

  const summaries = await loadTopicSummaries(namespacePaths);
  const markdown = await fs.readFile(namespacePaths.indexPath, 'utf8').catch(() => buildIndexMarkdown(namespacePaths, summaries, toIso(options.now)));

  return {
    repoRoot,
    namespace: namespacePaths.namespace,
    teamId: namespacePaths.teamId,
    scope: 'index',
    indexPath: namespacePaths.indexPath,
    markdown,
    topics: summaries,
  };
}

export async function memorySearch(query, options = {}) {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    throw new Error('A search query is required for /memory search.');
  }

  const repoRoot = await prepareRepo(options.cwd);
  const namespacePaths = getNamespacePaths(repoRoot, options);
  await ensureNamespaceLayout(namespacePaths);
  const topicFiles = await loadAllTopicFiles(namespacePaths);
  const loweredQuery = normalizeSearchText(trimmedQuery);
  const matches = [];

  for (const topicFile of topicFiles) {
    for (const entry of topicFile.entries) {
      const haystack = normalizeSearchText([
        topicFile.topic,
        entry.summary,
        ...entry.evidence.map((evidence) => evidence.runId ?? evidence.workerId ?? evidence.teamId ?? ''),
      ].join(' '));

      if (!haystack.includes(loweredQuery)) {
        continue;
      }

      if (options.staleOnly && !entry.stale) {
        continue;
      }
      if (options.repairableOnly && !isRepairableStaleEntry(entry)) {
        continue;
      }

      matches.push({
        memoryId: entry.memoryId,
        namespace: namespacePaths.namespace,
        teamId: namespacePaths.teamId,
        topic: topicFile.topic,
        summary: entry.summary,
        stale: entry.stale,
        staleReason: entry.staleReason,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        evidence: entry.evidence,
        topicPath: getTopicPath(namespacePaths, topicFile.topic),
      });
    }
  }

  return {
    repoRoot,
    namespace: namespacePaths.namespace,
    teamId: namespacePaths.teamId,
    query: trimmedQuery,
    count: matches.length,
    matches: matches.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
  };
}

export async function memoryStale(options = {}) {
  const repoRoot = await prepareRepo(options.cwd);
  const namespacePaths = getNamespacePaths(repoRoot, options);
  await ensureNamespaceLayout(namespacePaths);
  const topicFiles = await loadAllTopicFiles(namespacePaths);
  const entries = [];

  for (const topicFile of topicFiles) {
    for (const entry of topicFile.entries) {
      if (!entry.stale) {
        continue;
      }
      if (options.repairableOnly && !isRepairableStaleEntry(entry)) {
        continue;
      }

      entries.push({
        memoryId: entry.memoryId,
        namespace: namespacePaths.namespace,
        teamId: namespacePaths.teamId,
        topic: topicFile.topic,
        summary: entry.summary,
        staleReason: entry.staleReason,
        repairable: isRepairableStaleEntry(entry),
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        replacedByMemoryId: entry.replacedByMemoryId,
        repairedFromMemoryId: entry.repairedFromMemoryId,
        evidence: entry.evidence,
        topicPath: getTopicPath(namespacePaths, topicFile.topic),
      });
    }
  }

  return {
    repoRoot,
    namespace: namespacePaths.namespace,
    teamId: namespacePaths.teamId,
    count: entries.length,
    repairableOnly: Boolean(options.repairableOnly),
    entries: entries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
  };
}

export async function memoryAdd(note, options = {}) {
  const trimmedNote = note.trim();
  if (!trimmedNote) {
    throw new Error('A note is required for /memory add.');
  }

  const repoRoot = await prepareRepo(options.cwd);
  const nowIso = toIso(options.now);
  const namespacePaths = getNamespacePaths(repoRoot, options);
  await ensureNamespaceLayout(namespacePaths);
  const topic = slugifyTopic(options.topic ?? 'general');
  const evidence = await resolveEvidenceFromOptions(repoRoot, options, nowIso, 'memory add');

  return withRepoLock(repoRoot, async () => {
    const topicFile = await loadTopicFile(namespacePaths, topic);
    const entry = {
      ...createMemoryEntry({
        topic,
        createdAt: nowIso,
        evidence: [evidence],
        summary: trimmedNote,
      }),
      updatedAt: nowIso,
      stale: false,
      staleReason: null,
      lastValidatedAt: nowIso,
      entryType: 'note',
      sourceMemoryIds: [],
      replacedByMemoryId: null,
    };

    topicFile.entries.push(entry);
    topicFile.updatedAt = nowIso;

    const topicPath = getTopicPath(namespacePaths, topic);
    await saveTopicFile(topicPath, topicFile);
    const rebuilt = await rebuildIndexLocked(repoRoot, namespacePaths, nowIso);

    return {
      repoRoot,
      namespace: namespacePaths.namespace,
      teamId: namespacePaths.teamId,
      topic,
      topicPath,
      indexPath: rebuilt.indexPath,
      entry,
    };
  });
}

export async function memoryRepair(memoryId, options = {}) {
  const trimmedMemoryId = memoryId.trim();
  if (!trimmedMemoryId) {
    throw new Error('A memory id is required for /memory repair.');
  }

  const repoRoot = await prepareRepo(options.cwd);
  const nowIso = toIso(options.now);
  const namespacePaths = getNamespacePaths(repoRoot, options);
  await ensureNamespaceLayout(namespacePaths);
  const evidence = await resolveEvidenceFromOptions(repoRoot, options, nowIso, 'memory repair');

  return withRepoLock(repoRoot, async () => {
    const located = await findEntryByMemoryId(namespacePaths, trimmedMemoryId);
    if (!located) {
      throw new Error(`Memory entry not found: ${trimmedMemoryId}`);
    }

    const { topicFile, entry } = located;
    if (!entry.stale) {
      throw new Error(`Memory entry ${trimmedMemoryId} is not stale.`);
    }
    if (!isRepairableStaleEntry(entry)) {
      throw new Error(`Memory entry ${trimmedMemoryId} is not repairable; repair is only for evidence-backed stale entries.`);
    }

    const repairedEntry = {
      ...createMemoryEntry({
        topic: entry.topic,
        createdAt: nowIso,
        evidence: [evidence],
        summary: typeof options.summary === 'string' && options.summary.trim() ? options.summary.trim() : entry.summary,
      }),
      updatedAt: nowIso,
      stale: false,
      staleReason: null,
      lastValidatedAt: nowIso,
      entryType: 'note',
      sourceMemoryIds: [],
      replacedByMemoryId: null,
      repairedFromMemoryId: entry.memoryId,
    };

    entry.stale = true;
    entry.staleReason = 'repaired';
    entry.replacedByMemoryId = repairedEntry.memoryId;
    entry.lastValidatedAt = nowIso;
    entry.updatedAt = nowIso;

    topicFile.entries.push(repairedEntry);
    topicFile.updatedAt = nowIso;
    const topicPath = getTopicPath(namespacePaths, topicFile.topic);
    await saveTopicFile(topicPath, topicFile);
    const rebuilt = await rebuildIndexLocked(repoRoot, namespacePaths, nowIso);

    return {
      repoRoot,
      namespace: namespacePaths.namespace,
      teamId: namespacePaths.teamId,
      topic: topicFile.topic,
      topicPath,
      indexPath: rebuilt.indexPath,
      repaired: repairedEntry,
      superseded: entry,
    };
  });
}

export async function memoryRebuild(options = {}) {
  const repoRoot = await prepareRepo(options.cwd);
  const nowIso = toIso(options.now);
  const namespacePaths = getNamespacePaths(repoRoot, options);
  await ensureNamespaceLayout(namespacePaths);
  return withRepoLock(repoRoot, async () => rebuildIndexLocked(repoRoot, namespacePaths, nowIso));
}

export async function memoryCompact(options = {}) {
  const repoRoot = await prepareRepo(options.cwd);
  const nowIso = toIso(options.now);
  const namespacePaths = getNamespacePaths(repoRoot, options);
  await ensureNamespaceLayout(namespacePaths);

  return withRepoLock(repoRoot, async () => {
    const topicFiles = await loadAllTopicFiles(namespacePaths);
    let topicsUpdated = 0;
    let entriesChecked = 0;
    let staleMarked = 0;
    let duplicatesCompacted = 0;
    let consolidatedCreated = 0;
    let entriesConsolidated = 0;

    for (const topicFile of topicFiles) {
      let changed = false;
      const entries = sortEntriesNewestFirst(topicFile.entries);

      for (const entry of entries) {
        entriesChecked += 1;
        const staleState = await evaluateEntryStaleState(repoRoot, entry, nowIso);
        if (
          entry.stale !== staleState.stale ||
          entry.staleReason !== staleState.staleReason ||
          entry.lastValidatedAt !== staleState.lastValidatedAt
        ) {
          if (!entry.stale && staleState.stale) {
            staleMarked += 1;
          }
          entry.stale = staleState.stale;
          entry.staleReason = staleState.staleReason;
          entry.lastValidatedAt = staleState.lastValidatedAt;
          entry.updatedAt = staleState.updatedAt;
          changed = true;
        }
      }

      const activeKeys = new Set();
      for (const entry of entries) {
        if (entry.stale) {
          continue;
        }

        const compactKey = buildCompactKey(entry);
        if (activeKeys.has(compactKey)) {
          entry.stale = true;
          entry.staleReason = 'compacted_duplicate';
          entry.lastValidatedAt = nowIso;
          entry.updatedAt = nowIso;
          duplicatesCompacted += 1;
          staleMarked += 1;
          changed = true;
          continue;
        }

        activeKeys.add(compactKey);
      }

      const consolidation = consolidateActiveTopicEntries(topicFile.topic, entries, nowIso);
      if (consolidation.changed) {
        changed = true;
        staleMarked += consolidation.staleMarked;
        consolidatedCreated += consolidation.consolidatedCreated;
        entriesConsolidated += consolidation.entriesConsolidated;
      }

      if (!changed) {
        continue;
      }

      topicFile.entries = entries;
      topicFile.updatedAt = nowIso;
      await saveTopicFile(getTopicPath(namespacePaths, topicFile.topic), topicFile);
      topicsUpdated += 1;
    }

    const rebuilt = await rebuildIndexLocked(repoRoot, namespacePaths, nowIso);
    return {
      repoRoot,
      namespace: namespacePaths.namespace,
      teamId: namespacePaths.teamId,
      indexPath: rebuilt.indexPath,
      topics: rebuilt.topics,
      topicsUpdated,
      entriesChecked,
      staleMarked,
      duplicatesCompacted,
      consolidatedCreated,
      entriesConsolidated,
    };
  });
}

async function rebuildIndexLocked(repoRoot, namespacePaths, nowIso) {
  const topics = await loadTopicSummaries(namespacePaths);
  const markdown = buildIndexMarkdown(namespacePaths, topics, nowIso);
  await writeFileAtomic(namespacePaths.indexPath, markdown);
  return {
    repoRoot,
    namespace: namespacePaths.namespace,
    teamId: namespacePaths.teamId,
    indexPath: namespacePaths.indexPath,
    generatedAt: nowIso,
    topics,
    markdown,
  };
}

async function loadTopicSummaries(namespacePaths) {
  const topicFiles = await loadAllTopicFiles(namespacePaths);
  return topicFiles
    .map((topicFile) => buildTopicSummary(namespacePaths, topicFile))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

async function loadAllTopicFiles(namespacePaths) {
  const entries = await fs.readdir(namespacePaths.topicsDir, { withFileTypes: true }).catch(() => []);
  const topicFiles = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }

    const topic = entry.name.slice(0, -'.json'.length);
    topicFiles.push(await loadTopicFile(namespacePaths, topic));
  }

  return topicFiles;
}

async function loadTopicFile(namespacePaths, topic) {
  const topicPath = getTopicPath(namespacePaths, topic);
  try {
    const raw = JSON.parse(await fs.readFile(topicPath, 'utf8'));
    return parseTopicFile(raw, topic);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return createEmptyTopicFile(topic, new Date().toISOString());
    }

    throw new Error(`Failed to read topic file ${topicPath}: ${error.message}`);
  }
}

async function saveTopicFile(topicPath, topicFile) {
  await writeFileAtomic(topicPath, `${JSON.stringify(topicFile, null, 2)}\n`);
}

function parseTopicFile(value, fallbackTopic) {
  if (!isPlainObject(value)) {
    throw new Error('Topic file must be a JSON object.');
  }

  const topic = slugifyTopic(typeof value.topic === 'string' ? value.topic : fallbackTopic);
  const createdAt = normalizeIso(value.createdAt);
  const updatedAt = normalizeIso(value.updatedAt ?? value.createdAt);
  const entries = Array.isArray(value.entries)
    ? value.entries.map((entry) => parseTopicEntry(entry, topic)).filter(Boolean)
    : [];

  return {
    version: MEMORY_TOPIC_VERSION,
    topic,
    createdAt,
    updatedAt,
    entries,
  };
}

function parseTopicEntry(value, topic) {
  if (!isPlainObject(value) || typeof value.summary !== 'string' || !value.summary.trim()) {
    return null;
  }

  const evidence = Array.isArray(value.evidence)
    ? value.evidence.map((entry) => parseEvidence(entry)).filter(Boolean)
    : [];

  return {
    memoryId: typeof value.memoryId === 'string' && value.memoryId.trim() ? value.memoryId : createMemoryEntry({ topic }).memoryId,
    topic,
    summary: value.summary.trim(),
    createdAt: normalizeIso(value.createdAt),
    updatedAt: normalizeIso(value.updatedAt ?? value.createdAt),
    stale: Boolean(value.stale),
    staleReason: typeof value.staleReason === 'string' ? value.staleReason : null,
    lastValidatedAt: normalizeNullableIso(value.lastValidatedAt),
    entryType: value.entryType === 'consolidated' ? 'consolidated' : 'note',
    sourceMemoryIds: Array.isArray(value.sourceMemoryIds)
      ? value.sourceMemoryIds.filter((entry) => typeof entry === 'string' && entry.trim())
      : [],
    replacedByMemoryId: typeof value.replacedByMemoryId === 'string' ? value.replacedByMemoryId : null,
    repairedFromMemoryId: typeof value.repairedFromMemoryId === 'string' ? value.repairedFromMemoryId : null,
    evidence,
  };
}

function parseEvidence(value) {
  if (!isPlainObject(value) || typeof value.kind !== 'string') {
    return null;
  }

  if (value.kind === 'run') {
    return {
      kind: 'run',
      runId: typeof value.runId === 'string' ? value.runId : null,
      resultPath: typeof value.resultPath === 'string' ? value.resultPath : null,
      stdoutPath: typeof value.stdoutPath === 'string' ? value.stdoutPath : null,
      stderrPath: typeof value.stderrPath === 'string' ? value.stderrPath : null,
      eventPath: typeof value.eventPath === 'string' ? value.eventPath : null,
      exitCode: typeof value.exitCode === 'number' ? value.exitCode : null,
      capturedAt: normalizeNullableIso(value.capturedAt),
    };
  }

  if (value.kind === 'worker') {
    return {
      kind: 'worker',
      workerId: typeof value.workerId === 'string' ? value.workerId : null,
      statePath: typeof value.statePath === 'string' ? value.statePath : null,
      stdoutPath: typeof value.stdoutPath === 'string' ? value.stdoutPath : null,
      stderrPath: typeof value.stderrPath === 'string' ? value.stderrPath : null,
      exitCode: typeof value.exitCode === 'number' ? value.exitCode : null,
      runCount: typeof value.runCount === 'number' ? value.runCount : null,
      capturedAt: normalizeNullableIso(value.capturedAt),
    };
  }

  if (value.kind === 'team') {
    return {
      kind: 'team',
      teamId: typeof value.teamId === 'string' ? value.teamId : null,
      teamPath: typeof value.teamPath === 'string' ? value.teamPath : null,
      summaryText: typeof value.summaryText === 'string' ? value.summaryText : null,
      previewCount: typeof value.previewCount === 'number' ? value.previewCount : null,
      completedCount: typeof value.completedCount === 'number' ? value.completedCount : null,
      capturedAt: normalizeNullableIso(value.capturedAt),
    };
  }

  return null;
}

function createEmptyTopicFile(topic, nowIso) {
  return {
    version: MEMORY_TOPIC_VERSION,
    topic,
    createdAt: nowIso,
    updatedAt: nowIso,
    entries: [],
  };
}

function buildTopicSummary(namespacePaths, topicFile) {
  const sortedEntries = sortEntriesNewestFirst(topicFile.entries);
  const activeCount = sortedEntries.filter((entry) => !entry.stale).length;
  const staleCount = sortedEntries.length - activeCount;
  const latestEntry = sortedEntries[0] ?? null;
  const latestActiveEntry = sortedEntries.find((entry) => !entry.stale) ?? latestEntry;

  return {
    topic: topicFile.topic,
    topicPath: toDisplayRelative(namespacePaths.memoryDir, getTopicPath(namespacePaths, topicFile.topic)),
    entryCount: sortedEntries.length,
    activeCount,
    staleCount,
    updatedAt: topicFile.updatedAt,
    latestSummary: latestActiveEntry ? limitText(latestActiveEntry.summary, 120) : null,
  };
}

async function evaluateEntryStaleState(repoRoot, entry, nowIso) {
  if (entry.stale && ['compacted_duplicate', 'compacted_consolidated', 'repaired'].includes(entry.staleReason)) {
    return {
      stale: true,
      staleReason: entry.staleReason,
      lastValidatedAt: nowIso,
      updatedAt: entry.updatedAt,
    };
  }

  if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) {
    return {
      stale: true,
      staleReason: 'missing_evidence',
      lastValidatedAt: nowIso,
      updatedAt: nowIso,
    };
  }

  for (const evidence of entry.evidence) {
    const validation = await validateEvidence(repoRoot, evidence);
    if (validation.stale) {
      return {
        stale: true,
        staleReason: validation.reason,
        lastValidatedAt: nowIso,
        updatedAt: nowIso,
      };
    }
  }

  return {
    stale: false,
    staleReason: null,
    lastValidatedAt: nowIso,
    updatedAt: entry.updatedAt,
  };
}

async function validateEvidence(repoRoot, evidence) {
  if (evidence.kind === 'run') {
    return validateRunEvidence(repoRoot, evidence);
  }

  if (evidence.kind === 'worker') {
    return validateWorkerEvidence(repoRoot, evidence);
  }

  if (evidence.kind === 'team') {
    return validateTeamEvidence(repoRoot, evidence);
  }

  return { stale: true, reason: 'missing_evidence' };
}

async function validateRunEvidence(repoRoot, evidence) {
  if (!evidence.resultPath) {
    return { stale: true, reason: 'missing_evidence' };
  }
  const resultPath = fromRepoRelative(repoRoot, evidence.resultPath);
  let result;
  try {
    result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { stale: true, reason: 'missing_run_result' };
    }
    return { stale: true, reason: 'invalid_run_result' };
  }

  if (typeof result.exitCode !== 'number' || result.exitCode !== 0) {
    return { stale: true, reason: 'run_not_successful' };
  }

  return { stale: false, reason: null };
}

async function validateWorkerEvidence(repoRoot, evidence) {
  if (!evidence.statePath) {
    return { stale: true, reason: 'missing_evidence' };
  }

  const statePath = fromRepoRelative(repoRoot, evidence.statePath);
  let worker;
  try {
    worker = JSON.parse(await fs.readFile(statePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { stale: true, reason: 'missing_worker_state' };
    }
    return { stale: true, reason: 'invalid_worker_state' };
  }

  if (!isSuccessfulWorkerState(worker)) {
    return { stale: true, reason: 'worker_not_successful' };
  }

  return { stale: false, reason: null };
}

async function validateTeamEvidence(repoRoot, evidence) {
  if (!evidence.teamPath || !evidence.teamId) {
    return { stale: true, reason: 'missing_evidence' };
  }

  const teamPath = fromRepoRelative(repoRoot, evidence.teamPath);
  try {
    await fs.access(teamPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { stale: true, reason: 'missing_team_state' };
    }
    return { stale: true, reason: 'invalid_team_state' };
  }

  try {
    const current = await resolveTeamEvidence(repoRoot, evidence.teamId, evidence.capturedAt ?? new Date().toISOString());
    if (!current.summaryText || current.completedCount < 1) {
      return { stale: true, reason: 'team_not_successful' };
    }
  } catch (error) {
    if (String(error?.message ?? '').includes('not in a successful synthesized state')) {
      return { stale: true, reason: 'team_not_successful' };
    }
    if (String(error?.message ?? '').includes('Team evidence not found')) {
      return { stale: true, reason: 'missing_team_state' };
    }
    return { stale: true, reason: 'invalid_team_state' };
  }

  return { stale: false, reason: null };
}

async function resolveRunEvidence(repoRoot, runId, capturedAt) {
  const paths = getOpencodePaths(repoRoot);
  const runDir = path.join(paths.runsDir, runId);
  const resultPath = path.join(runDir, 'result.json');
  const stdoutPath = path.join(runDir, 'stdout.txt');
  const stderrPath = path.join(runDir, 'stderr.txt');
  const eventPath = path.join(runDir, 'events.ndjson');

  let result;
  try {
    result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new Error(`Run evidence not found: ${runId}`);
    }

    throw new Error(`Failed to read run result for ${runId}: ${error.message}`);
  }

  if (typeof result.exitCode !== 'number' || result.exitCode !== 0) {
    throw new Error(`Run ${runId} did not complete successfully and cannot back a memory entry.`);
  }

  return {
    kind: 'run',
    runId,
    resultPath: toRepoRelative(repoRoot, resultPath),
    stdoutPath: toRepoRelative(repoRoot, stdoutPath),
    stderrPath: toRepoRelative(repoRoot, stderrPath),
    eventPath: toRepoRelative(repoRoot, eventPath),
    exitCode: result.exitCode,
    capturedAt,
  };
}

async function resolveWorkerEvidence(repoRoot, workerId, capturedAt) {
  const workerPaths = getWorkerEvidencePaths(repoRoot, workerId);

  let worker;
  try {
    worker = JSON.parse(await fs.readFile(workerPaths.statePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new Error(`Worker evidence not found: ${workerId}`);
    }

    throw new Error(`Failed to read worker state for ${workerId}: ${error.message}`);
  }

  if (!isSuccessfulWorkerState(worker)) {
    throw new Error(`Worker ${workerId} is not in a successful completed state and cannot back a memory entry.`);
  }

  return {
    kind: 'worker',
    workerId,
    statePath: toRepoRelative(repoRoot, workerPaths.statePath),
    stdoutPath: toRepoRelative(repoRoot, workerPaths.stdoutPath),
    stderrPath: toRepoRelative(repoRoot, workerPaths.stderrPath),
    exitCode: typeof worker.lastExitCode === 'number' ? worker.lastExitCode : 0,
    runCount: typeof worker.runCount === 'number' ? worker.runCount : 0,
    capturedAt,
  };
}

async function resolveTeamEvidence(repoRoot, teamId, capturedAt) {
  let team;
  try {
    team = await teamShow(teamId, { cwd: repoRoot });
  } catch (error) {
    throw new Error(`Team evidence not found: ${teamId}${error instanceof Error && error.message ? ` (${error.message})` : ''}`);
  }

  if (!team?.synthesis?.summaryText || !Array.isArray(team.synthesis.completed) || team.synthesis.completed.length < 1) {
    throw new Error(`Team ${teamId} is not in a successful synthesized state and cannot back a memory entry.`);
  }

  return {
    kind: 'team',
    teamId,
    teamPath: toRepoRelative(repoRoot, getTeamEvidencePath(repoRoot, teamId)),
    summaryText: team.synthesis.summaryText,
    previewCount: Array.isArray(team.synthesis.previews) ? team.synthesis.previews.length : 0,
    completedCount: Array.isArray(team.synthesis.completed) ? team.synthesis.completed.length : 0,
    capturedAt,
  };
}

async function resolveEvidenceFromOptions(repoRoot, options, capturedAt, actionName) {
  const runId = typeof options.runId === 'string' ? options.runId.trim() : '';
  const workerId = typeof options.workerId === 'string' ? options.workerId.trim() : '';
  const teamResultId = typeof options.teamResultId === 'string' ? options.teamResultId.trim() : '';

  const provided = [runId, workerId, teamResultId].filter(Boolean);
  if (provided.length === 0) {
    throw new Error(`${actionName} requires --run <runId>, --worker <workerId>, or --team-result <teamId> so the note is evidence-backed.`);
  }
  if (provided.length > 1) {
    throw new Error(`${actionName} accepts exactly one evidence source: --run <runId>, --worker <workerId>, or --team-result <teamId>.`);
  }

  if (runId) {
    return resolveRunEvidence(repoRoot, runId, capturedAt);
  }

  if (workerId) {
    return resolveWorkerEvidence(repoRoot, workerId, capturedAt);
  }

  return resolveTeamEvidence(repoRoot, teamResultId, capturedAt);
}

function buildIndexMarkdown(namespacePaths, topics, nowIso) {
  const lines = [
    '# MEMORY',
    '',
    'Evidence-backed memory pointer index.',
    '',
    `Namespace: ${namespacePaths.namespace === 'team' ? `team/${namespacePaths.teamId}` : 'repo'}`,
    '',
    `Generated at: ${nowIso}`,
    '',
  ];

  if (topics.length === 0) {
    lines.push('No topic files yet. Add a memory entry with `/memory add ... --run <runId>`.');
    lines.push('');
    return `${lines.join('\n')}\n`;
  }

  lines.push('## Topics', '');

  for (const topic of topics) {
    lines.push(`### ${topic.topic}`);
    lines.push(`- file: \`${topic.topicPath}\``);
    lines.push(`- active entries: ${topic.activeCount}`);
    lines.push(`- stale entries: ${topic.staleCount}`);
    lines.push(`- updated: ${topic.updatedAt}`);
    if (topic.latestSummary) {
      lines.push(`- latest: ${topic.latestSummary}`);
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

async function prepareRepo(cwd) {
  const repoRoot = await findRepoRoot(cwd ?? process.cwd());
  await ensureStateLayout(repoRoot);
  return repoRoot;
}

async function findEntryByMemoryId(namespacePaths, memoryId) {
  const topicFiles = await loadAllTopicFiles(namespacePaths);
  for (const topicFile of topicFiles) {
    const entry = topicFile.entries.find((candidate) => candidate.memoryId === memoryId);
    if (entry) {
      return { topicFile, entry };
    }
  }

  return null;
}

function getNamespacePaths(repoRoot, options = {}) {
  const paths = getOpencodePaths(repoRoot);
  if (!options.teamId) {
    return {
      namespace: 'repo',
      teamId: null,
      memoryDir: paths.memoryDir,
      indexPath: paths.memoryIndex,
      topicsDir: paths.memoryTopicsDir,
    };
  }

  const teamId = slugifyRequired(options.teamId, 'teamId');
  const memoryDir = path.join(paths.memoryTeamDir, teamId);
  return {
    namespace: 'team',
    teamId,
    memoryDir,
    indexPath: path.join(memoryDir, 'MEMORY.md'),
    topicsDir: path.join(memoryDir, 'topics'),
  };
}

async function ensureNamespaceLayout(namespacePaths) {
  await fs.mkdir(namespacePaths.memoryDir, { recursive: true });
  await fs.mkdir(namespacePaths.topicsDir, { recursive: true });
}

function getTopicPath(namespacePaths, topic) {
  return path.join(namespacePaths.topicsDir, `${slugifyTopic(topic)}.json`);
}

function getWorkerEvidencePaths(repoRoot, workerId) {
  const workersDir = getOpencodePaths(repoRoot).workersDir;
  const rootDir = path.join(workersDir, workerId);
  return {
    rootDir,
    statePath: path.join(rootDir, 'worker.json'),
    stdoutPath: path.join(rootDir, 'current.stdout.txt'),
    stderrPath: path.join(rootDir, 'current.stderr.txt'),
  };
}

function getTeamEvidencePath(repoRoot, teamId) {
  return path.join(getOpencodePaths(repoRoot).teamsDir, `${teamId}.json`);
}

function toRepoRelative(repoRoot, filePath) {
  return path.relative(repoRoot, filePath) || '.';
}

function toDisplayRelative(rootDir, filePath) {
  return path.relative(rootDir, filePath).split(path.sep).join('/') || '.';
}

function fromRepoRelative(repoRoot, relativePath) {
  return path.resolve(repoRoot, relativePath);
}

function slugifyTopic(topic) {
  const slug = String(topic ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'general';
}

function slugifyRequired(value, fieldName) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) {
    throw new Error(`A non-empty ${fieldName} is required.`);
  }

  const slug = slugifyTopic(value);
  return slug;
}

function isSuccessfulWorkerState(worker) {
  if (!isPlainObject(worker)) {
    return false;
  }

  const status = typeof worker.status === 'string' ? worker.status : '';
  const runCount = typeof worker.runCount === 'number' ? worker.runCount : 0;
  const lastExitCode = typeof worker.lastExitCode === 'number' ? worker.lastExitCode : null;

  return runCount > 0 && lastExitCode === 0 && ['idle', 'blocked', 'stopped'].includes(status);
}

function isRepairableStaleEntry(entry) {
  return Boolean(entry?.stale) && !['compacted_duplicate', 'compacted_consolidated', 'repaired'].includes(entry.staleReason);
}

function buildCompactKey(entry) {
  const evidenceKey = entry.evidence
    .map(getEvidenceIdentity)
    .sort()
    .join('|');
  return `${normalizeSearchText(entry.summary)}::${evidenceKey}`;
}

function consolidateActiveTopicEntries(topic, entries, nowIso) {
  const activeNotes = entries.filter((entry) => !entry.stale && entry.entryType !== 'consolidated');
  if (activeNotes.length < TOPIC_CONSOLIDATION_MIN_ACTIVE) {
    return {
      changed: false,
      staleMarked: 0,
      consolidatedCreated: 0,
      entriesConsolidated: 0,
    };
  }

  const sourceMemoryIds = activeNotes.map((entry) => entry.memoryId).sort();
  let consolidatedEntry = entries.find((entry) => (
    !entry.stale &&
    entry.entryType === 'consolidated' &&
    sameStringArray(entry.sourceMemoryIds, sourceMemoryIds)
  )) ?? null;

  let changed = false;
  let staleMarked = 0;
  let consolidatedCreated = 0;
  let entriesConsolidated = 0;

  if (!consolidatedEntry) {
    consolidatedEntry = createConsolidatedEntry(topic, activeNotes, nowIso);
    entries.push(consolidatedEntry);
    changed = true;
    consolidatedCreated += 1;
  }

  for (const entry of activeNotes) {
    entry.stale = true;
    entry.staleReason = 'compacted_consolidated';
    entry.replacedByMemoryId = consolidatedEntry.memoryId;
    entry.lastValidatedAt = nowIso;
    entry.updatedAt = nowIso;
    changed = true;
    staleMarked += 1;
    entriesConsolidated += 1;
  }

  return {
    changed,
    staleMarked,
    consolidatedCreated,
    entriesConsolidated,
  };
}

function createConsolidatedEntry(topic, sourceEntries, nowIso) {
  const sortedEntries = sortEntriesNewestFirst(sourceEntries);
  const summaryLines = sortedEntries
    .slice(0, TOPIC_CONSOLIDATION_SUMMARY_LIMIT)
    .map((entry) => `- ${entry.summary}`);
  const remainingCount = Math.max(0, sortedEntries.length - TOPIC_CONSOLIDATION_SUMMARY_LIMIT);
  const summary = [
    `Consolidated topic memory from ${sortedEntries.length} entries:`,
    ...summaryLines,
    ...(remainingCount > 0 ? [`- ...and ${remainingCount} more entries`] : []),
  ].join('\n');

  return {
    ...createMemoryEntry({
      topic,
      createdAt: nowIso,
      evidence: dedupeEvidence(sortedEntries.flatMap((entry) => entry.evidence)),
      summary,
    }),
    updatedAt: nowIso,
    stale: false,
    staleReason: null,
    lastValidatedAt: nowIso,
    entryType: 'consolidated',
    sourceMemoryIds: sortedEntries.map((entry) => entry.memoryId).sort(),
    replacedByMemoryId: null,
  };
}

function dedupeEvidence(evidence) {
  const seen = new Set();
  const deduped = [];

  for (const entry of evidence) {
    const key = getEvidenceIdentity(entry);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(entry);
  }

  return deduped;
}

function getEvidenceIdentity(evidence) {
  if (evidence.kind === 'run') {
    return `${evidence.kind}:${evidence.runId ?? evidence.resultPath ?? 'unknown'}`;
  }
  if (evidence.kind === 'worker') {
    return `${evidence.kind}:${evidence.workerId ?? evidence.statePath ?? 'unknown'}`;
  }
  if (evidence.kind === 'team') {
    return `${evidence.kind}:${evidence.teamId ?? evidence.teamPath ?? 'unknown'}`;
  }
  return `${evidence.kind}:unknown`;
}

function sameStringArray(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

function sortEntriesNewestFirst(entries) {
  return [...entries].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function normalizeSearchText(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function limitText(value, maxLength) {
  const trimmed = String(value ?? '').trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function normalizeIso(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();
}

function normalizeNullableIso(value) {
  if (!value) {
    return null;
  }
  return normalizeIso(value);
}

function toIso(value) {
  return normalizeIso(value ?? new Date().toISOString());
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function writeFileAtomic(filePath, content) {
  const tempPath = `${filePath}.tmp.${process.pid}`;
  await fs.writeFile(tempPath, content, 'utf8');
  await fs.rename(tempPath, filePath);
}
