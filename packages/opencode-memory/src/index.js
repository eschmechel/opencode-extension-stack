import fs from 'node:fs/promises';
import path from 'node:path';

import {
  createMemoryEntry,
  ensureStateLayout,
  findRepoRoot,
  getOpencodePaths,
  withRepoLock,
} from '../../opencode-core/src/index.js';

const MEMORY_TOPIC_VERSION = 1;

export async function getMemoryPaths(options = {}) {
  const repoRoot = await prepareRepo(options.cwd);
  const paths = getOpencodePaths(repoRoot);
  return {
    repoRoot,
    memoryDir: paths.memoryDir,
    memoryIndex: paths.memoryIndex,
    memoryTopicsDir: paths.memoryTopicsDir,
    memoryTeamDir: paths.memoryTeamDir,
  };
}

export async function memoryShow(topic, options = {}) {
  const repoRoot = await prepareRepo(options.cwd);
  const paths = getOpencodePaths(repoRoot);

  if (topic && topic.trim()) {
    const slug = slugifyTopic(topic);
    const topicPath = getTopicPath(repoRoot, slug);
    const topicFile = await loadTopicFile(repoRoot, slug);
    const summary = buildTopicSummary(topicFile);

    return {
      repoRoot,
      scope: 'topic',
      topic: slug,
      topicPath,
      summary,
      entries: sortEntriesNewestFirst(topicFile.entries),
    };
  }

  const summaries = await loadTopicSummaries(repoRoot);
  const markdown = await fs.readFile(paths.memoryIndex, 'utf8').catch(() => buildIndexMarkdown(summaries, toIso(options.now)));

  return {
    repoRoot,
    scope: 'index',
    indexPath: paths.memoryIndex,
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
  const topicFiles = await loadAllTopicFiles(repoRoot);
  const loweredQuery = normalizeSearchText(trimmedQuery);
  const matches = [];

  for (const topicFile of topicFiles) {
    for (const entry of topicFile.entries) {
      const haystack = normalizeSearchText([
        topicFile.topic,
        entry.summary,
        ...entry.evidence.map((evidence) => evidence.runId ?? ''),
      ].join(' '));

      if (!haystack.includes(loweredQuery)) {
        continue;
      }

      matches.push({
        memoryId: entry.memoryId,
        topic: topicFile.topic,
        summary: entry.summary,
        stale: entry.stale,
        staleReason: entry.staleReason,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        evidence: entry.evidence,
        topicPath: getTopicPath(repoRoot, topicFile.topic),
      });
    }
  }

  return {
    repoRoot,
    query: trimmedQuery,
    count: matches.length,
    matches: matches.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
  };
}

export async function memoryAdd(note, options = {}) {
  const trimmedNote = note.trim();
  if (!trimmedNote) {
    throw new Error('A note is required for /memory add.');
  }

  const runId = typeof options.runId === 'string' ? options.runId.trim() : '';
  if (!runId) {
    throw new Error('memory add requires --run <runId> so the note is evidence-backed.');
  }

  const repoRoot = await prepareRepo(options.cwd);
  const nowIso = toIso(options.now);
  const topic = slugifyTopic(options.topic ?? 'general');
  const evidence = await resolveRunEvidence(repoRoot, runId, nowIso);

  return withRepoLock(repoRoot, async () => {
    const topicFile = await loadTopicFile(repoRoot, topic);
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
    };

    topicFile.entries.push(entry);
    topicFile.updatedAt = nowIso;

    const topicPath = getTopicPath(repoRoot, topic);
    await saveTopicFile(topicPath, topicFile);
    const rebuilt = await rebuildIndexLocked(repoRoot, nowIso);

    return {
      repoRoot,
      topic,
      topicPath,
      indexPath: rebuilt.indexPath,
      entry,
    };
  });
}

export async function memoryRebuild(options = {}) {
  const repoRoot = await prepareRepo(options.cwd);
  const nowIso = toIso(options.now);
  return withRepoLock(repoRoot, async () => rebuildIndexLocked(repoRoot, nowIso));
}

export async function memoryCompact(options = {}) {
  const repoRoot = await prepareRepo(options.cwd);
  const nowIso = toIso(options.now);

  return withRepoLock(repoRoot, async () => {
    const topicFiles = await loadAllTopicFiles(repoRoot);
    let topicsUpdated = 0;
    let entriesChecked = 0;
    let staleMarked = 0;
    let duplicatesCompacted = 0;

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

      if (!changed) {
        continue;
      }

      topicFile.entries = entries;
      topicFile.updatedAt = nowIso;
      await saveTopicFile(getTopicPath(repoRoot, topicFile.topic), topicFile);
      topicsUpdated += 1;
    }

    const rebuilt = await rebuildIndexLocked(repoRoot, nowIso);
    return {
      repoRoot,
      indexPath: rebuilt.indexPath,
      topics: rebuilt.topics,
      topicsUpdated,
      entriesChecked,
      staleMarked,
      duplicatesCompacted,
    };
  });
}

async function rebuildIndexLocked(repoRoot, nowIso) {
  const paths = getOpencodePaths(repoRoot);
  const topics = await loadTopicSummaries(repoRoot);
  const markdown = buildIndexMarkdown(topics, nowIso);
  await writeFileAtomic(paths.memoryIndex, markdown);
  return {
    repoRoot,
    indexPath: paths.memoryIndex,
    generatedAt: nowIso,
    topics,
    markdown,
  };
}

async function loadTopicSummaries(repoRoot) {
  const topicFiles = await loadAllTopicFiles(repoRoot);
  return topicFiles
    .map(buildTopicSummary)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

async function loadAllTopicFiles(repoRoot) {
  const paths = getOpencodePaths(repoRoot);
  const entries = await fs.readdir(paths.memoryTopicsDir, { withFileTypes: true }).catch(() => []);
  const topicFiles = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }

    const topic = entry.name.slice(0, -'.json'.length);
    topicFiles.push(await loadTopicFile(repoRoot, topic));
  }

  return topicFiles;
}

async function loadTopicFile(repoRoot, topic) {
  const topicPath = getTopicPath(repoRoot, topic);
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
    evidence,
  };
}

function parseEvidence(value) {
  if (!isPlainObject(value) || typeof value.kind !== 'string') {
    return null;
  }

  if (value.kind !== 'run') {
    return null;
  }

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

function createEmptyTopicFile(topic, nowIso) {
  return {
    version: MEMORY_TOPIC_VERSION,
    topic,
    createdAt: nowIso,
    updatedAt: nowIso,
    entries: [],
  };
}

function buildTopicSummary(topicFile) {
  const sortedEntries = sortEntriesNewestFirst(topicFile.entries);
  const activeCount = sortedEntries.filter((entry) => !entry.stale).length;
  const staleCount = sortedEntries.length - activeCount;
  const latestEntry = sortedEntries[0] ?? null;
  const latestActiveEntry = sortedEntries.find((entry) => !entry.stale) ?? latestEntry;

  return {
    topic: topicFile.topic,
    topicPath: `topics/${topicFile.topic}.json`,
    entryCount: sortedEntries.length,
    activeCount,
    staleCount,
    updatedAt: topicFile.updatedAt,
    latestSummary: latestActiveEntry ? limitText(latestActiveEntry.summary, 120) : null,
  };
}

async function evaluateEntryStaleState(repoRoot, entry, nowIso) {
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
  if (evidence.kind !== 'run' || !evidence.resultPath) {
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

function buildIndexMarkdown(topics, nowIso) {
  const lines = [
    '# MEMORY',
    '',
    'Evidence-backed memory pointer index.',
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

function getTopicPath(repoRoot, topic) {
  return path.join(getOpencodePaths(repoRoot).memoryTopicsDir, `${slugifyTopic(topic)}.json`);
}

function toRepoRelative(repoRoot, filePath) {
  return path.relative(repoRoot, filePath) || '.';
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

function buildCompactKey(entry) {
  const evidenceKey = entry.evidence
    .map((evidence) => `${evidence.kind}:${evidence.runId ?? evidence.resultPath ?? 'unknown'}`)
    .sort()
    .join('|');
  return `${normalizeSearchText(entry.summary)}::${evidenceKey}`;
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
