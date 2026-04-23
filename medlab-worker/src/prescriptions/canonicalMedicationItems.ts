export type MedicationSourceStage =
  | "submission_finalize"
  | "approval_override"
  | "worker_ingest"
  | "legacy"
  | "unknown";

export interface CanonicalMedicationItemOptions {
  flowKey?: string | null;
  sourceStage?: MedicationSourceStage | string | null;
}

export interface CanonicalMedicationItemRecord extends Record<string, unknown> {
  canonical_schema: "medication_line_v1";
  line_no: number;
  cis: string | null;
  cip13: string | null;
  cip7: string | null;
  label: string;
  denomination: string;
  sublabel: string | null;
  quantite: string | null;
  posologie: string | null;
  instructions: string | null;
  scheduleText: string | null;
  duration_label: string | null;
  durationLabel: string | null;
  schedule: Record<string, unknown>;
  validation_code: string;
  validation_reason: string | null;
  match_code: string | null;
  flow_key: string | null;
  source_stage: string;
  raw: Record<string, unknown>;
}

export function canonicalizeMedicationItems(
  items: unknown[],
  options: CanonicalMedicationItemOptions = {},
): CanonicalMedicationItemRecord[] {
  return items.map((item, index) => canonicalizeMedicationItem(item, index, options));
}

export function canonicalizeMedicationItem(
  item: unknown,
  index: number,
  options: CanonicalMedicationItemOptions = {},
): CanonicalMedicationItemRecord {
  const obj = asRecord(item);
  const raw = asRecord(obj.raw);
  const schedule = normalizeSchedulePayload(raw.schedule ?? obj.schedule);

  const lineNo = toPositiveInt(obj.line_no ?? obj.lineNo ?? index + 1) || index + 1;
  const cis = sanitizeDigitsString(firstNonEmptyString([obj.cis, raw.cis]));
  const cip13 = sanitizeDigitsString(firstNonEmptyString([obj.cip13, raw.cip13]));
  const cip7 = sanitizeDigitsString(firstNonEmptyString([obj.cip7, raw.cip7]));

  const label = firstNonEmptyString([
    obj.label,
    obj.denomination,
    obj.name,
    obj.medication,
    obj.drug,
    raw.label,
    raw.denomination,
    raw.name,
  ]) || `Médicament ${lineNo}`;

  const denomination = firstNonEmptyString([
    obj.denomination,
    obj.label,
    raw.denomination,
    raw.label,
    label,
  ]) || label;

  const sublabel = normalizeNullableString(firstNonEmptyString([
    obj.sublabel,
    obj.presentation,
    raw.sublabel,
    raw.presentation,
  ]));

  const quantite = normalizeNullableString(firstNonEmptyString([
    obj.quantite,
    obj.quantity,
    raw.quantite,
    raw.quantity,
  ]));

  const posologie = normalizeNullableString(firstNonEmptyString([
    obj.posologie,
    obj.instructions,
    obj.instruction,
    obj.dosage,
    obj.scheduleText,
    raw.posologie,
    raw.instructions,
    raw.scheduleText,
  ])) ?? normalizeNullableString(scheduleToCanonicalText(schedule));

  const durationLabel = normalizeNullableString(firstNonEmptyString([
    obj.duration_label,
    obj.durationLabel,
    obj.durationText,
    obj.duree,
    raw.duration_label,
    raw.durationLabel,
    raw.durationText,
  ])) ?? normalizeNullableString(scheduleToDurationLabel(schedule));

  const flowKey = normalizeNullableString(firstNonEmptyString([
    options.flowKey,
    obj.flow_key,
    obj.flowKey,
    raw.flow_key,
    raw.flowKey,
  ]));

  const sourceStage = normalizeNullableString(firstNonEmptyString([
    options.sourceStage,
    obj.source_stage,
    obj.sourceStage,
    raw.source_stage,
    raw.sourceStage,
  ])) ?? "unknown";

  const validationCode = normalizeNullableString(firstNonEmptyString([
    obj.validation_code,
    obj.validationCode,
    raw.validation_code,
    raw.validationCode,
  ])) ?? defaultValidationCodeForStage(sourceStage);

  const validationReason = normalizeNullableString(firstNonEmptyString([
    obj.validation_reason,
    obj.validationReason,
    raw.validation_reason,
    raw.validationReason,
  ]));

  const matchCode = normalizeNullableString(firstNonEmptyString([
    obj.match_code,
    obj.matchCode,
    raw.match_code,
    raw.matchCode,
  ]));

  const canonicalRaw: Record<string, unknown> = {
    ...raw,
    line_no: lineNo,
    schedule,
    validation_code: validationCode,
    source_stage: sourceStage,
  };

  if (flowKey) {
    canonicalRaw.flow_key = flowKey;
  }
  if (cis !== "") {
    canonicalRaw.cis = cis;
  }
  if (cip13 !== "") {
    canonicalRaw.cip13 = cip13;
  }
  if (cip7 !== "") {
    canonicalRaw.cip7 = cip7;
  }
  canonicalRaw.label = label;
  canonicalRaw.denomination = denomination;
  if (sublabel) {
    canonicalRaw.sublabel = sublabel;
  }
  if (posologie) {
    canonicalRaw.posologie = posologie;
    canonicalRaw.instructions = posologie;
    canonicalRaw.scheduleText = posologie;
  }
  if (durationLabel) {
    canonicalRaw.duration_label = durationLabel;
    canonicalRaw.durationLabel = durationLabel;
  }
  if (quantite) {
    canonicalRaw.quantite = quantite;
  }
  if (validationReason) {
    canonicalRaw.validation_reason = validationReason;
  }
  if (matchCode) {
    canonicalRaw.match_code = matchCode;
  }

  return {
    canonical_schema: "medication_line_v1",
    line_no: lineNo,
    cis: cis !== "" ? cis : null,
    cip13: cip13 !== "" ? cip13 : null,
    cip7: cip7 !== "" ? cip7 : null,
    label,
    denomination,
    sublabel,
    quantite,
    posologie,
    instructions: posologie,
    scheduleText: posologie,
    duration_label: durationLabel,
    durationLabel,
    schedule,
    validation_code: validationCode,
    validation_reason: validationReason,
    match_code: matchCode,
    flow_key: flowKey,
    source_stage: sourceStage,
    raw: canonicalRaw,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function normalizeSchedulePayload(value: unknown): Record<string, unknown> {
  const row = asRecord(value);
  if (Object.keys(row).length < 1) {
    return {};
  }

  const normalized: Record<string, unknown> = {};
  const nb = toPositiveInt(row.nb ?? row.timesPerDay);
  if (nb > 0) {
    normalized.nb = Math.min(nb, 12);
  }

  const freqUnit = normalizeFrequencyUnit(row.freqUnit ?? row.frequencyUnit ?? row.freq);
  if (freqUnit !== "") {
    normalized.freqUnit = freqUnit;
  }

  const durationVal = toPositiveInt(row.durationVal ?? row.durationValue ?? row.duration);
  if (durationVal > 0) {
    normalized.durationVal = Math.min(durationVal, 3650);
  }

  const durationUnit = normalizeFrequencyUnit(row.durationUnit ?? row.unit, true);
  if (durationUnit !== "") {
    normalized.durationUnit = durationUnit;
  }

  const times = coerceStringArray(row.times);
  if (times.length > 0) {
    normalized.times = times;
  }

  const doses = coerceStringArray(row.doses);
  if (doses.length > 0) {
    normalized.doses = doses;
  }

  const note = normalizeNullableString(row.note ?? row.text ?? row.label);
  if (note) {
    normalized.note = note;
  }

  const start = normalizeNullableString(row.start);
  if (start) {
    normalized.start = start;
  }

  const end = normalizeNullableString(row.end);
  if (end) {
    normalized.end = end;
  }

  const rounding = toPositiveInt(row.rounding);
  if (rounding > 0) {
    normalized.rounding = rounding;
  }

  if (typeof row.autoTimesEnabled === "boolean") {
    normalized.autoTimesEnabled = row.autoTimesEnabled;
  }

  const legacyMoments = ["morning", "noon", "evening", "bedtime", "everyHours", "timesPerDay", "asNeeded"];
  for (const key of legacyMoments) {
    if (!(key in normalized) && row[key] !== undefined) {
      normalized[key] = row[key];
    }
  }

  return normalized;
}

function scheduleToCanonicalText(schedule: Record<string, unknown>): string {
  const note = normalizeNullableString(schedule.note ?? schedule.text ?? schedule.label);
  const nb = toPositiveInt(schedule.nb ?? schedule.timesPerDay);
  const freqUnit = normalizeFrequencyUnit(schedule.freqUnit ?? schedule.frequencyUnit ?? schedule.freq);
  const times = coerceStringArray(schedule.times);
  const doses = coerceStringArray(schedule.doses);
  const inferredCount = Math.max(nb, times.length, doses.length);

  if (inferredCount > 0) {
    const baseUnit = freqUnit !== "" ? freqUnit : "jour";
    const details: string[] = [];
    for (let i = 0; i < inferredCount; i += 1) {
      const time = normalizeNullableString(times[i]);
      const dose = normalizeNullableString(doses[i]);
      if (!time && !dose) {
        continue;
      }
      details.push(`${dose ?? "1"}@${time ?? "--:--"}`);
    }

    let out = `${inferredCount > 1 ? `${inferredCount} fois` : "1 fois"} par ${baseUnit}`;
    if (details.length > 0) {
      out += ` (${details.join(", ")})`;
    }
    if (note) {
      out += `. ${note}`;
    }
    return out;
  }

  const parts: string[] = [];
  const legacyMomentMap: Array<[string, string]> = [
    ["morning", "matin"],
    ["noon", "midi"],
    ["evening", "soir"],
    ["bedtime", "coucher"],
  ];

  for (const [key, label] of legacyMomentMap) {
    const value = toPositiveInt(schedule[key]);
    if (value > 0) {
      parts.push(`${label}: ${value}`);
    }
  }

  const everyHours = toPositiveInt(schedule.everyHours);
  if (everyHours > 0) {
    parts.push(`Toutes les ${everyHours} h`);
  }

  const asNeeded = normalizeNullableString(schedule.asNeeded);
  if (asNeeded && ["1", "true", "yes", "oui"].includes(asNeeded.toLowerCase())) {
    parts.push("Si besoin");
  }

  if (parts.length > 0) {
    let out = parts.join(" • ");
    if (note) {
      out += ` • ${note}`;
    }
    return out;
  }

  return note ?? "";
}

function scheduleToDurationLabel(schedule: Record<string, unknown>): string {
  const durationVal = toPositiveInt(schedule.durationVal ?? schedule.durationValue ?? schedule.duration);
  const durationUnit = normalizeFrequencyUnit(schedule.durationUnit ?? schedule.unit, true);

  if (durationVal > 0 && durationUnit !== "") {
    return `${durationVal} ${durationUnit}`;
  }

  return "";
}

function normalizeFrequencyUnit(value: unknown, allowMonth = true): string {
  const raw = normalizeNullableString(value);
  if (!raw) {
    return "";
  }

  const normalized = raw.toLowerCase();
  if (["jour", "jours", "j", "day", "days"].includes(normalized)) {
    return "jour";
  }
  if (["semaine", "semaines", "week", "weeks"].includes(normalized)) {
    return "semaine";
  }
  if (allowMonth && ["mois", "month", "months"].includes(normalized)) {
    return "mois";
  }
  if (["heure", "heures", "h", "hour", "hours"].includes(normalized)) {
    return "heure";
  }

  return normalized;
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => normalizeNullableString(entry) ?? "")
    .filter((entry) => entry !== "")
    .slice(0, 12);
}

function firstNonEmptyString(values: unknown[]): string {
  for (const value of values) {
    const normalized = normalizeNullableString(value);
    if (normalized) {
      return normalized;
    }
  }

  return "";
}

function sanitizeDigitsString(value: string): string {
  return value.replace(/\D+/gu, "").trim();
}

function toPositiveInt(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!globalThis.Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }

  return Math.trunc(parsed);
}

function normalizeNullableString(value: unknown): string | null {
  if (value == null) {
    return null;
  }

  const normalized = String(value).replace(/\s+/gu, " ").trim();
  return normalized !== "" ? normalized : null;
}

function defaultValidationCodeForStage(sourceStage: string): string {
  switch (sourceStage) {
    case "submission_finalize":
    case "approval_override":
      return "legacy_unvalidated";
    case "worker_ingest":
      return "ingest_passthrough";
    default:
      return "legacy_unvalidated";
  }
}
