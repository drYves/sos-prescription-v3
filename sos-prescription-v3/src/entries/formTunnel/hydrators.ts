import type {
  DraftHydrationResult,
  DurationUnit,
  FlowType,
  FrequencyUnit,
  LocalUpload,
  MedicationItem,
  Schedule,
  StoredDraftPayload,
} from './types';

const AUTO_SCHEDULE_STEP_MINUTES = 5;

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed !== '') {
        return trimmed;
      }
      continue;
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }
  return '';
}

function normalizeKnownEmailValue(value: unknown): string | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : null;
}

function isEmailLikeValue(value: unknown): boolean {
  const normalized = String(value ?? '').trim();
  return normalized !== '' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
}

function safePatientNameValue(value: unknown): string {
  const normalized = String(value ?? '').trim();
  return normalized !== '' && !isEmailLikeValue(normalized) ? normalized : '';
}

function createPlaceholderFile(name: string, mimeType: string): File {
  const safeName = name || 'document';
  const safeMimeType = mimeType || 'application/octet-stream';

  try {
    if (typeof File !== 'undefined') {
      return new File([''], safeName, { type: safeMimeType });
    }
  } catch {
    // noop
  }

  try {
    if (typeof Blob !== 'undefined') {
      const fallbackBlob = new Blob([''], { type: safeMimeType }) as File & { name?: string };
      try {
        Object.defineProperty(fallbackBlob, 'name', { value: safeName });
      } catch {
        // noop
      }
      return fallbackBlob as File;
    }
  } catch {
    // noop
  }

  return {
    name: safeName,
    type: safeMimeType,
    size: 0,
  } as File;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = Number.parseInt(String(value ?? ''), 10);
  if (Number.isNaN(numeric)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, numeric));
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function isTimeString(value: string): boolean {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(value);
}

function parseTimeToMinutes(value: string): number | null {
  if (!isTimeString(value)) {
    return null;
  }

  const [hours, minutes] = value.split(':');
  return Number.parseInt(hours, 10) * 60 + Number.parseInt(minutes, 10);
}

function formatMinutesToTime(value: number): string {
  let minutes = Math.round(value);
  if (!Number.isFinite(minutes)) {
    minutes = 0;
  }
  minutes = Math.max(0, Math.min(23 * 60 + 59, minutes));

  const hours = Math.floor(minutes / 60);
  const remain = minutes % 60;
  return `${pad2(hours)}:${pad2(remain)}`;
}

function roundToStep(value: number, step: number): number {
  const normalizedStep = Math.max(1, Math.floor(step));
  return Math.round(value / normalizedStep) * normalizedStep;
}

function fillArray(values: string[] | undefined, size: number, fallback: string): string[] {
  const next = Array.isArray(values) ? values.map((value) => String(value ?? '')) : [];
  if (next.length > size) {
    return next.slice(0, size);
  }
  while (next.length < size) {
    next.push(fallback);
  }
  return next;
}

function distributeTimes(count: number, start: string, end: string): {
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

function normalizeSchedule(value: Partial<Schedule> | null | undefined): Schedule {
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

export function normalizeStoredDraftItems(value: unknown): MedicationItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry): MedicationItem | null => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return null;
      }

      const item = entry as Record<string, unknown>;
      const label = typeof item.label === 'string' ? item.label.trim() : '';
      if (!label) {
        return null;
      }

      return {
        cis: typeof item.cis === 'string' && item.cis.trim() !== '' ? item.cis.trim() : undefined,
        cip13: typeof item.cip13 === 'string' && item.cip13.trim() !== '' ? item.cip13.trim() : null,
        label,
        schedule: normalizeSchedule(item.schedule && typeof item.schedule === 'object' ? item.schedule as Partial<Schedule> : {}),
        quantite: typeof item.quantite === 'string' && item.quantite.trim() !== '' ? item.quantite.trim() : undefined,
      } as MedicationItem;
    })
    .filter((entry): entry is MedicationItem => Boolean(entry));
}

export function normalizeStoredDraftFiles(value: unknown): LocalUpload[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry, index): LocalUpload | null => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return null;
      }

      const file = entry as Record<string, unknown>;
      const originalName = typeof file.original_name === 'string' && file.original_name.trim() !== ''
        ? file.original_name.trim()
        : `document-${index + 1}.pdf`;
      const mimeType = typeof file.mime_type === 'string' && file.mime_type.trim() !== ''
        ? file.mime_type.trim()
        : 'application/octet-stream';
      const sizeBytes = Number(file.size_bytes || 0);
      const normalizedStatus = typeof file.status === 'string' && file.status.trim().toUpperCase() === 'READY'
        ? 'READY'
        : 'QUEUED';

      return {
        id: typeof file.id === 'string' && file.id.trim() !== '' ? file.id.trim() : `restored_${index}`,
        file: createPlaceholderFile(originalName, mimeType),
        original_name: originalName,
        mime: mimeType,
        mime_type: mimeType,
        size_bytes: Number.isFinite(sizeBytes) ? sizeBytes : 0,
        kind: 'PROOF',
        status: normalizedStatus,
      } as LocalUpload;
    })
    .filter((entry): entry is LocalUpload => Boolean(entry));
}

export function hydrateStoredDraftPayload(input: {
  payload: StoredDraftPayload;
  fallbackEmail?: string | null;
}): DraftHydrationResult {
  const payload = input.payload;
  const patient = payload.patient && typeof payload.patient === 'object' && !Array.isArray(payload.patient)
    ? payload.patient as Record<string, unknown>
    : {};
  const joinedName = [
    firstNonEmptyString(patient.firstName, patient.first_name),
    firstNonEmptyString(patient.lastName, patient.last_name),
  ].filter(Boolean).join(' ');
  const nextFullName = safePatientNameValue(firstNonEmptyString(patient.fullname, patient.fullName, joinedName));
  const nextBirthdate = firstNonEmptyString(patient.birthdate, patient.birthDate);
  const nextNotes = firstNonEmptyString(
    payload.private_notes,
    patient.note,
    patient.medical_notes,
    patient.medicalNotes,
  );

  const nextFlow: FlowType | null = payload.flow === 'ro_proof' || payload.flow === 'depannage_no_proof'
    ? payload.flow
    : null;

  const resumedEmail = normalizeKnownEmailValue(
    typeof payload.email === 'string'
      ? payload.email
      : firstNonEmptyString(patient.email, patient.email_address),
  ) || normalizeKnownEmailValue(input.fallbackEmail || '') || '';

  const storedConsent = payload.consent;
  const consent = storedConsent && typeof storedConsent === 'object' && !Array.isArray(storedConsent)
    ? storedConsent as Record<string, unknown>
    : null;

  return {
    flow: nextFlow,
    priority: payload.priority === 'express' ? 'express' : 'standard',
    fullName: nextFullName,
    birthdate: nextBirthdate,
    medicalNotes: nextNotes,
    items: normalizeStoredDraftItems(payload.items),
    files: normalizeStoredDraftFiles(payload.files),
    draftEmail: resumedEmail,
    draftEmailLocked: Boolean(resumedEmail),
    attestationNoProof: Boolean(payload.attestation_no_proof),
    consentTelemedicine: Boolean(consent?.telemedicine),
    consentTruth: Boolean(consent?.truth),
    consentCgu: Boolean(consent?.cgu),
    consentPrivacy: Boolean(consent?.privacy),
  };
}
