const CRON_ALIASES = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
};

export function normalizeCronExpression(schedule) {
  const value = schedule.trim();
  const expanded = CRON_ALIASES[value] ?? value;
  const fields = expanded.split(/\s+/);

  if (fields.length !== 5) {
    throw new Error('Cron schedules must use five fields or a supported alias like @hourly.');
  }

  return fields;
}

export function getNextCronOccurrence(schedule, fromDate = new Date()) {
  const [minuteField, hourField, dayField, monthField, weekdayField] = normalizeCronExpression(schedule);
  const minutes = parseField(minuteField, 0, 59, 'minute');
  const hours = parseField(hourField, 0, 23, 'hour');
  const days = parseField(dayField, 1, 31, 'day of month');
  const months = parseField(monthField, 1, 12, 'month');
  const weekdays = parseField(weekdayField, 0, 7, 'day of week').map((value) => (value === 7 ? 0 : value));
  const dayMatchesAsWildcard = dayField === '*';
  const weekdayMatchesAsWildcard = weekdayField === '*';

  const start = new Date(fromDate);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  const maxIterations = 60 * 24 * 366 * 5;
  for (let offset = 0; offset < maxIterations; offset += 1) {
    const candidate = new Date(start.getTime() + offset * 60_000);

    if (
      minutes.includes(candidate.getMinutes()) &&
      hours.includes(candidate.getHours()) &&
      months.includes(candidate.getMonth() + 1) &&
      matchesCalendarDay(candidate, days, weekdays, dayMatchesAsWildcard, weekdayMatchesAsWildcard)
    ) {
      return candidate.toISOString();
    }
  }

  throw new Error(`Could not resolve a future occurrence for schedule: ${schedule}`);
}

function matchesCalendarDay(candidate, days, weekdays, dayMatchesAsWildcard, weekdayMatchesAsWildcard) {
  const dayMatches = days.includes(candidate.getDate());
  const weekdayMatches = weekdays.includes(candidate.getDay());

  if (dayMatchesAsWildcard) {
    return weekdayMatches;
  }

  if (weekdayMatchesAsWildcard) {
    return dayMatches;
  }

  return dayMatches || weekdayMatches;
}

function parseField(field, min, max, label) {
  const values = new Set();

  for (const part of field.split(',')) {
    if (part === '*') {
      addRange(values, min, max, 1, min, max);
      continue;
    }

    const stepMatch = part.match(/^\*\/(\d+)$/);
    if (stepMatch) {
      addRange(values, min, max, Number(stepMatch[1]), min, max);
      continue;
    }

    const rangeMatch = part.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
    if (rangeMatch) {
      addRange(values, min, max, Number(rangeMatch[3] ?? '1'), Number(rangeMatch[1]), Number(rangeMatch[2]));
      continue;
    }

    const exact = Number(part);
    if (Number.isInteger(exact)) {
      addRange(values, min, max, 1, exact, exact);
      continue;
    }

    throw new Error(`Invalid ${label} field: ${field}`);
  }

  return [...values].sort((left, right) => left - right);
}

function addRange(values, min, max, step, start, end) {
  if (!Number.isInteger(step) || step <= 0) {
    throw new Error(`Invalid cron step value: ${step}`);
  }

  if (start < min || end > max || start > end) {
    throw new Error(`Invalid cron range: ${start}-${end}`);
  }

  for (let current = start; current <= end; current += step) {
    values.add(current);
  }
}
