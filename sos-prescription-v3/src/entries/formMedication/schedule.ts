import type { FrequencyUnit, DurationUnit, Schedule } from '../formTunnel/types';

const AUTO_SCHEDULE_STEP_MINUTES = 5;

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = Number.parseInt(String(value ?? ''), 10);
  if (Number.isNaN(numeric)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, numeric));
}

export function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

export function isTimeString(value: string): boolean {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(value);
}

export function parseTimeToMinutes(value: string): number | null {
  if (!isTimeString(value)) {
    return null;
  }

  const [hours, minutes] = value.split(':');
  return Number.parseInt(hours, 10) * 60 + Number.parseInt(minutes, 10);
}

export function formatMinutesToTime(value: number): string {
  let minutes = Math.round(value);
  if (!Number.isFinite(minutes)) {
    minutes = 0;
  }
  minutes = Math.max(0, Math.min(23 * 60 + 59, minutes));

  const hours = Math.floor(minutes / 60);
  const remain = minutes % 60;
  return `${pad2(hours)}:${pad2(remain)}`;
}

export function roundToStep(value: number, step: number): number {
  const normalizedStep = Math.max(1, Math.floor(step));
  return Math.round(value / normalizedStep) * normalizedStep;
}

export function fillArray(values: string[] | undefined, size: number, fallback: string): string[] {
  const next = Array.isArray(values) ? values.map((value) => String(value ?? '')) : [];
  if (next.length > size) {
    return next.slice(0, size);
  }
  while (next.length < size) {
    next.push(fallback);
  }
  return next;
}

export function distributeTimes(count: number, start: string, end: string): {
  times: string[];
  start: string;
  end: string;
  warnings: string[];
  collisionResolved: boolean;
} {
  const warnings: string[] = [];
  const step = AUTO_SCHEDULE_STEP_MINUTES;
  const startMinutes = parseTimeToMinutes(start) ?? 8 * 60;
  let endMinutes = parseTimeToMinutes(end) ?? 20 * 60;

  if (endMinutes <= startMinutes) {
    endMinutes = Math.min(startMinutes + 60, 23 * 60 + 55);
    warnings.push('Fenêtre de prise invalide : heure de fin ajustée.');
  }

  const windowDuration = endMinutes - startMinutes;
  if (count <= 1) {
    const only = formatMinutesToTime(roundToStep(startMinutes, step));
    const finalEnd = formatMinutesToTime(roundToStep(endMinutes, step));
    return {
      times: [only],
      start: only,
      end: finalEnd,
      warnings,
      collisionResolved: false,
    };
  }

  if (windowDuration < (count - 1) * step) {
    warnings.push('Fenêtre trop courte pour répartir correctement.');
  }
  if (startMinutes > 18 * 60 && count > 1) {
    warnings.push('Première prise tardive : prises rapprochées.');
  }

  let collisionResolved = false;
  const gap = windowDuration / (count - 1);
  const points: number[] = [];
  for (let index = 0; index < count; index += 1) {
    let point = startMinutes + index * gap;
    if (index === 0) {
      point = startMinutes;
    }
    if (index === count - 1) {
      point = endMinutes;
    }
    let rounded = roundToStep(point, step);
    rounded = Math.max(startMinutes, Math.min(endMinutes, rounded));
    points.push(rounded);
  }

  for (let index = 1; index < count; index += 1) {
    if (points[index] <= points[index - 1]) {
      collisionResolved = true;
      points[index] = points[index - 1] + step;
    }
  }

  if (points[count - 1] > endMinutes) {
    collisionResolved = true;
    points[count - 1] = roundToStep(endMinutes, step);
    for (let index = count - 2; index >= 0; index -= 1) {
      if (points[index] >= points[index + 1]) {
        points[index] = points[index + 1] - step;
      }
    }
    if (points[0] < startMinutes) {
      warnings.push('Horaires trop rapprochés : vérifier la posologie.');
      points[0] = roundToStep(startMinutes, step);
      for (let index = 1; index < count; index += 1) {
        points[index] = Math.max(points[index], points[index - 1]);
      }
    }
  }

  let minGap = Number.POSITIVE_INFINITY;
  for (let index = 1; index < count; index += 1) {
    minGap = Math.min(minGap, points[index] - points[index - 1]);
  }
  if (count >= 4 && Number.isFinite(minGap) && minGap < 60) {
    warnings.push('Horaires rapprochés : vérifier la posologie.');
  }

  const times = points.map(formatMinutesToTime);
  return {
    times,
    start: times[0],
    end: times[times.length - 1],
    warnings,
    collisionResolved,
  };
}

export function normalizeSchedule(value: Partial<Schedule> | null | undefined): Schedule {
  const freqUnit: FrequencyUnit = value?.freqUnit === 'semaine' ? 'semaine' : 'jour';
  const maxCount = freqUnit === 'jour' ? 6 : 12;
  const nb = clampInt(value?.nb, 1, maxCount, 1);
  const durationVal = clampInt(value?.durationVal, 1, 3650, 5);
  const durationUnit: DurationUnit = value?.durationUnit === 'mois'
    ? 'mois'
    : value?.durationUnit === 'semaine'
      ? 'semaine'
      : 'jour';
  const autoTimesEnabled = value?.autoTimesEnabled !== false;
  const start = typeof value?.start === 'string' ? value.start : typeof value?.times?.[0] === 'string' ? value.times[0] : '08:00';
  const end = typeof value?.end === 'string' ? value.end : typeof value?.times?.[value?.times?.length ? value.times.length - 1 : 0] === 'string' ? value.times[value.times.length - 1] : '20:00';
  const safeStart = isTimeString(start) ? start : '08:00';
  const safeEnd = isTimeString(end) ? end : '20:00';

  let times = fillArray(value?.times, nb, '');
  const doses = fillArray(value?.doses, nb, '1');

  if (autoTimesEnabled && freqUnit === 'jour') {
    const auto = distributeTimes(nb, safeStart, safeEnd);
    times = auto.times;
    return {
      nb,
      freqUnit,
      durationVal,
      durationUnit,
      times,
      doses,
      note: typeof value?.note === 'string' ? value.note : '',
      autoTimesEnabled: true,
      start: auto.start,
      end: auto.end,
    };
  }

  return {
    nb,
    freqUnit,
    durationVal,
    durationUnit,
    times,
    doses,
    note: typeof value?.note === 'string' ? value.note : '',
    autoTimesEnabled: autoTimesEnabled && freqUnit === 'jour',
    start: safeStart,
    end: safeEnd,
  };
}
