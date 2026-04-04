import crypto from 'node:crypto';

export const STATE_VERSION = 1;

const JOB_SOURCES = new Set(['queue', 'cron']);
const JOB_STATUSES = new Set(['queued', 'running', 'completed', 'failed', 'cancelled']);

export function createStableId(prefix) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const suffix = crypto.randomBytes(4).toString('hex');
  return `${prefix}_${stamp}_${suffix}`;
}

export function defaultConfig() {
  return {
    version: STATE_VERSION,
    budgets: {
      perRunUsd: null,
      perDayUsd: null,
    },
    repos: {
      allowUnattended: ['.'],
    },
    idle: {
      dispatchWhenIdle: true,
      minIdleSeconds: 300,
    },
    models: {
      default: null,
    },
    notifications: {
      console: true,
    },
  };
}

export function defaultJobsState() {
  return {
    version: STATE_VERSION,
    jobs: [],
  };
}

export function defaultSchedulesState() {
  return {
    version: STATE_VERSION,
    schedules: [],
  };
}

export function createJobRecord(input) {
  return parseJobRecord({
    jobId: input.jobId,
    runId: input.runId,
    source: input.source,
    status: input.status ?? 'queued',
    prompt: input.prompt,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt ?? input.createdAt,
    startedAt: input.startedAt ?? null,
    completedAt: input.completedAt ?? null,
    exitCode: input.exitCode ?? null,
    errorMessage: input.errorMessage ?? null,
    scheduleId: input.scheduleId ?? null,
    retriedFromJobId: input.retriedFromJobId ?? null,
    attempt: input.attempt ?? 1,
    maxAttempts: input.maxAttempts ?? 1,
    repoRoot: input.repoRoot,
  });
}

export function createScheduleRecord(input) {
  return parseScheduleRecord({
    cronId: input.cronId,
    schedule: input.schedule,
    prompt: input.prompt,
    description: input.description ?? null,
    enabled: input.enabled ?? true,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt ?? input.createdAt,
    lastRunAt: input.lastRunAt ?? null,
    nextRunAt: input.nextRunAt,
    runCount: input.runCount ?? 0,
  });
}

export function createWorkerRecord(input = {}) {
  return {
    workerId: input.workerId ?? createStableId('worker'),
    status: input.status ?? 'planned',
    createdAt: input.createdAt ?? new Date().toISOString(),
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    repoRoot: input.repoRoot ?? null,
  };
}

export function createTeamRunRecord(input = {}) {
  return {
    teamRunId: input.teamRunId ?? createStableId('team'),
    status: input.status ?? 'planned',
    createdAt: input.createdAt ?? new Date().toISOString(),
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    workerIds: input.workerIds ?? [],
  };
}

export function createMemoryEntry(input = {}) {
  return {
    memoryId: input.memoryId ?? createStableId('memory'),
    topic: input.topic ?? 'general',
    createdAt: input.createdAt ?? new Date().toISOString(),
    evidence: input.evidence ?? [],
    summary: input.summary ?? '',
  };
}

export function createRemoteRequest(input = {}) {
  return {
    remoteRequestId: input.remoteRequestId ?? createStableId('remote'),
    status: input.status ?? 'planned',
    createdAt: input.createdAt ?? new Date().toISOString(),
    prompt: input.prompt ?? '',
  };
}

export function parseConfig(value) {
  const defaults = defaultConfig();
  const input = isPlainObject(value) ? value : {};

  return {
    version: STATE_VERSION,
    budgets: {
      perRunUsd: readNullableNumber(input.budgets?.perRunUsd, defaults.budgets.perRunUsd, 'budgets.perRunUsd'),
      perDayUsd: readNullableNumber(input.budgets?.perDayUsd, defaults.budgets.perDayUsd, 'budgets.perDayUsd'),
    },
    repos: {
      allowUnattended: readStringArray(input.repos?.allowUnattended, defaults.repos.allowUnattended, 'repos.allowUnattended'),
    },
    idle: {
      dispatchWhenIdle: readBoolean(input.idle?.dispatchWhenIdle, defaults.idle.dispatchWhenIdle, 'idle.dispatchWhenIdle'),
      minIdleSeconds: readInteger(input.idle?.minIdleSeconds, defaults.idle.minIdleSeconds, 'idle.minIdleSeconds', 0),
    },
    models: {
      default: readNullableString(input.models?.default, defaults.models.default, 'models.default'),
    },
    notifications: {
      console: readBoolean(input.notifications?.console, defaults.notifications.console, 'notifications.console'),
    },
  };
}

export function parseJobsState(value) {
  const input = isPlainObject(value) ? value : defaultJobsState();
  const jobs = Array.isArray(input.jobs) ? input.jobs.map(parseJobRecord) : [];

  return {
    version: STATE_VERSION,
    jobs,
  };
}

export function parseSchedulesState(value) {
  const input = isPlainObject(value) ? value : defaultSchedulesState();
  const schedules = Array.isArray(input.schedules) ? input.schedules.map(parseScheduleRecord) : [];

  return {
    version: STATE_VERSION,
    schedules,
  };
}

export function parseJobRecord(value) {
  if (!isPlainObject(value)) {
    throw new Error('Invalid job record: expected object.');
  }

  const source = readString(value.source, undefined, 'job.source');
  const status = readString(value.status, undefined, 'job.status');

  if (!JOB_SOURCES.has(source)) {
    throw new Error(`Invalid job source: ${source}`);
  }

  if (!JOB_STATUSES.has(status)) {
    throw new Error(`Invalid job status: ${status}`);
  }

  return {
    jobId: readString(value.jobId, undefined, 'job.jobId'),
    runId: readString(value.runId, undefined, 'job.runId'),
    source,
    status,
    prompt: readString(value.prompt, undefined, 'job.prompt'),
    createdAt: readIsoString(value.createdAt, 'job.createdAt'),
    updatedAt: readIsoString(value.updatedAt, 'job.updatedAt'),
    startedAt: readNullableIsoString(value.startedAt, null, 'job.startedAt'),
    completedAt: readNullableIsoString(value.completedAt, null, 'job.completedAt'),
    exitCode: readNullableInteger(value.exitCode, null, 'job.exitCode', 0),
    errorMessage: readNullableString(value.errorMessage, null, 'job.errorMessage'),
    scheduleId: readNullableString(value.scheduleId, null, 'job.scheduleId'),
    retriedFromJobId: readNullableString(value.retriedFromJobId, null, 'job.retriedFromJobId'),
    attempt: readInteger(value.attempt, 1, 'job.attempt', 1),
    maxAttempts: readInteger(value.maxAttempts, 1, 'job.maxAttempts', 1),
    repoRoot: readString(value.repoRoot, undefined, 'job.repoRoot'),
  };
}

export function parseScheduleRecord(value) {
  if (!isPlainObject(value)) {
    throw new Error('Invalid schedule record: expected object.');
  }

  return {
    cronId: readString(value.cronId, undefined, 'schedule.cronId'),
    schedule: readString(value.schedule, undefined, 'schedule.schedule'),
    prompt: readString(value.prompt, undefined, 'schedule.prompt'),
    description: readNullableString(value.description, null, 'schedule.description'),
    enabled: readBoolean(value.enabled, true, 'schedule.enabled'),
    createdAt: readIsoString(value.createdAt, 'schedule.createdAt'),
    updatedAt: readIsoString(value.updatedAt, 'schedule.updatedAt'),
    lastRunAt: readNullableIsoString(value.lastRunAt, null, 'schedule.lastRunAt'),
    nextRunAt: readIsoString(value.nextRunAt, 'schedule.nextRunAt'),
    runCount: readInteger(value.runCount, 0, 'schedule.runCount', 0),
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value, fallback, fieldName) {
  if (typeof value === 'string' && value.trim()) {
    return value;
  }

  if (fallback !== undefined) {
    return fallback;
  }

  throw new Error(`Invalid ${fieldName}: expected non-empty string.`);
}

function readNullableString(value, fallback, fieldName) {
  if (value === null || value === undefined) {
    return fallback;
  }

  return readString(value, fallback, fieldName);
}

function readBoolean(value, fallback, fieldName) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (fallback !== undefined) {
    return fallback;
  }

  throw new Error(`Invalid ${fieldName}: expected boolean.`);
}

function readNullableNumber(value, fallback, fieldName) {
  if (value === null || value === undefined) {
    return fallback;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  throw new Error(`Invalid ${fieldName}: expected finite number or null.`);
}

function readInteger(value, fallback, fieldName, minValue) {
  if (value === undefined || value === null) {
    return fallback;
  }

  if (typeof value === 'number' && Number.isInteger(value) && value >= minValue) {
    return value;
  }

  throw new Error(`Invalid ${fieldName}: expected integer >= ${minValue}.`);
}

function readNullableInteger(value, fallback, fieldName, minValue) {
  if (value === undefined || value === null) {
    return fallback;
  }

  return readInteger(value, fallback, fieldName, minValue);
}

function readStringArray(value, fallback, fieldName) {
  if (value === undefined || value === null) {
    return fallback;
  }

  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw new Error(`Invalid ${fieldName}: expected array of non-empty strings.`);
  }

  return value;
}

function readIsoString(value, fieldName) {
  const raw = readString(value, undefined, fieldName);

  if (Number.isNaN(Date.parse(raw))) {
    throw new Error(`Invalid ${fieldName}: expected ISO date string.`);
  }

  return new Date(raw).toISOString();
}

function readNullableIsoString(value, fallback, fieldName) {
  if (value === null || value === undefined) {
    return fallback;
  }

  return readIsoString(value, fieldName);
}
