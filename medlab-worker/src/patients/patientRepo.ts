// src/patients/patientRepo.ts
import { ActorRole, Prisma, PrismaClient } from "@prisma/client";
import { NdjsonLogger } from "../logger";

let prismaSingleton: PrismaClient | null = null;

export interface PatientRepoConfig {
  logger?: NdjsonLogger;
}

export interface PatientActorInput {
  role: ActorRole;
  wpUserId?: number | null;
}

export interface PatientProfileRecord {
  id: string;
  wpUserId: number | null;
  firstName: string;
  lastName: string;
  birthDate: string;
  gender: string | null;
  email: string | null;
  phone: string | null;
  weightKg: string | null;
  heightCm: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertPatientProfileInput {
  actor: PatientActorInput;
  firstName?: unknown;
  lastName?: unknown;
  birthDate?: unknown;
  gender?: unknown;
  email?: unknown;
  phone?: unknown;
  weightKg?: unknown;
  heightCm?: unknown;
}

export class PatientRepoError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(code: string, statusCode: number, message: string) {
    super(message);
    this.name = "PatientRepoError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class PatientRepo {
  private readonly prisma: PrismaClient;
  private readonly logger?: NdjsonLogger;

  constructor(cfg: PatientRepoConfig = {}) {
    this.prisma = getPrismaClient();
    this.logger = cfg.logger;
  }

  async getProfileByActor(actor: PatientActorInput): Promise<PatientProfileRecord | null> {
    const normalizedActor = normalizePatientActor(actor);

    try {
      const row = await this.prisma.patient.findUnique({
        where: { wpUserId: normalizedActor.wpUserId },
        select: patientSelect(),
      });

      return row ? mapPatient(row) : null;
    } catch (err: unknown) {
      this.logger?.error(
        "patient_profile.repo_get_failed",
        {
          wp_user_id: normalizedActor.wpUserId,
          reason: err instanceof Error ? err.message : "patient_profile_get_failed",
        },
        undefined,
        err,
      );

      throw wrapPatientRepoError(err, "ML_PATIENT_PROFILE_GET_FAILED", 500, "patient_profile_get_failed");
    }
  }

  async upsertProfile(input: UpsertPatientProfileInput): Promise<PatientProfileRecord> {
    const normalizedActor = normalizePatientActor(input.actor);

    try {
      const existing = await this.prisma.patient.findUnique({
        where: { wpUserId: normalizedActor.wpUserId },
        select: patientSelect(),
      });

      const next = buildMergedPatientProfile(existing, input);

      const row = await this.prisma.patient.upsert({
        where: { wpUserId: normalizedActor.wpUserId },
        update: {
          firstName: next.firstName,
          lastName: next.lastName,
          birthDate: next.birthDate,
          gender: next.gender,
          email: next.email,
          phone: next.phone,
          weightKg: next.weightKg,
          heightCm: next.heightCm,
        },
        create: {
          wpUserId: normalizedActor.wpUserId,
          firstName: next.firstName,
          lastName: next.lastName,
          birthDate: next.birthDate,
          gender: next.gender,
          email: next.email,
          phone: next.phone,
          weightKg: next.weightKg,
          heightCm: next.heightCm,
        },
        select: patientSelect(),
      });

      return mapPatient(row);
    } catch (err: unknown) {
      if (err instanceof PatientRepoError) {
        throw err;
      }

      this.logger?.error(
        "patient_profile.repo_save_failed",
        {
          wp_user_id: normalizedActor.wpUserId,
          reason: err instanceof Error ? err.message : "patient_profile_save_failed",
        },
        undefined,
        err,
      );

      throw wrapPatientRepoError(err, "ML_PATIENT_PROFILE_SAVE_FAILED", 500, "patient_profile_save_failed");
    }
  }
}

function getPrismaClient(): PrismaClient {
  if (!prismaSingleton) {
    prismaSingleton = new PrismaClient();
  }

  return prismaSingleton;
}

function patientSelect() {
  return {
    id: true,
    wpUserId: true,
    firstName: true,
    lastName: true,
    birthDate: true,
    gender: true,
    email: true,
    phone: true,
    weightKg: true,
    heightCm: true,
    createdAt: true,
    updatedAt: true,
  } satisfies Prisma.PatientSelect;
}

function mapPatient(
  row: Prisma.PatientGetPayload<{ select: ReturnType<typeof patientSelect> }>,
): PatientProfileRecord {
  return {
    id: row.id,
    wpUserId: row.wpUserId,
    firstName: row.firstName,
    lastName: row.lastName,
    birthDate: row.birthDate,
    gender: row.gender,
    email: row.email,
    phone: row.phone,
    weightKg: row.weightKg,
    heightCm: row.heightCm,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizePatientActor(actor: PatientActorInput): { role: "PATIENT"; wpUserId: number } {
  if (!actor || typeof actor !== "object") {
    throw new PatientRepoError("ML_PATIENT_PROFILE_BAD_REQUEST", 400, "actor is required");
  }

  if (actor.role !== "PATIENT") {
    throw new PatientRepoError("ML_PATIENT_PROFILE_BAD_REQUEST", 400, "actor.role must be PATIENT");
  }

  const wpUserId = normalizePositiveInt(actor.wpUserId, "actor.wpUserId");
  return {
    role: "PATIENT",
    wpUserId,
  };
}

function buildMergedPatientProfile(
  existing: PatientProfileRecord | null,
  input: UpsertPatientProfileInput,
): {
  firstName: string;
  lastName: string;
  birthDate: string;
  gender: string | null;
  email: string | null;
  phone: string | null;
  weightKg: string | null;
  heightCm: string | null;
} {
  return {
    firstName: normalizeNameUpdate(input.firstName, "firstName", 100, existing?.firstName ?? ""),
    lastName: normalizeNameUpdate(input.lastName, "lastName", 120, existing?.lastName ?? ""),
    birthDate: normalizeBirthDateUpdate(input.birthDate, existing?.birthDate ?? ""),
    gender: normalizeOptionalPlainTextUpdate(input.gender, 32, existing?.gender ?? null),
    email: normalizeEmailUpdate(input.email, existing?.email ?? null),
    phone: normalizePhoneUpdate(input.phone, existing?.phone ?? null),
    weightKg: normalizeMetricUpdate(input.weightKg, "weightKg", 1, 500, existing?.weightKg ?? null),
    heightCm: normalizeMetricUpdate(input.heightCm, "heightCm", 30, 300, existing?.heightCm ?? null),
  };
}

function normalizePositiveInt(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new PatientRepoError("ML_PATIENT_PROFILE_BAD_REQUEST", 400, `${field} is invalid`);
  }

  return Math.trunc(parsed);
}

function normalizeNameUpdate(value: unknown, field: string, maxLength: number, fallback: string): string {
  if (value === undefined) {
    return fallback;
  }

  const normalized = normalizeCollapsedText(value, field, maxLength, true);
  if (looksLikeEmail(normalized)) {
    throw new PatientRepoError("ML_PATIENT_PROFILE_BAD_REQUEST", 400, `${field} must not be an email`);
  }

  return normalized;
}

function normalizeBirthDateUpdate(value: unknown, fallback: string): string {
  if (value === undefined) {
    return fallback;
  }

  if (value === null) {
    return "";
  }

  const raw = String(value).trim();
  if (raw === "") {
    return "";
  }

  const iso = parseBirthDateToIso(raw);
  if (!iso) {
    throw new PatientRepoError("ML_PATIENT_PROFILE_BAD_REQUEST", 400, "birthDate is invalid");
  }

  return iso;
}

function normalizeOptionalPlainTextUpdate(value: unknown, maxLength: number, fallback: string | null): string | null {
  if (value === undefined) {
    return fallback;
  }

  if (value === null) {
    return null;
  }

  const normalized = normalizeCollapsedText(value, "text", maxLength, true);
  return normalized === "" ? null : normalized;
}

function normalizeEmailUpdate(value: unknown, fallback: string | null): string | null {
  if (value === undefined) {
    return fallback;
  }

  if (value === null) {
    return null;
  }

  const raw = String(value).trim().toLowerCase();
  if (raw === "") {
    return null;
  }

  if (!looksLikeEmail(raw)) {
    throw new PatientRepoError("ML_PATIENT_PROFILE_BAD_REQUEST", 400, "email is invalid");
  }

  return raw;
}

function normalizePhoneUpdate(value: unknown, fallback: string | null): string | null {
  if (value === undefined) {
    return fallback;
  }

  if (value === null) {
    return null;
  }

  const raw = String(value).replace(/\s+/gu, " ").trim();
  if (raw === "") {
    return null;
  }

  const sanitized = raw.replace(/[^0-9+().\-\s]/g, "").replace(/\s+/gu, " ").trim().slice(0, 40);
  return sanitized === "" ? null : sanitized;
}

function normalizeMetricUpdate(
  value: unknown,
  field: string,
  min: number,
  max: number,
  fallback: string | null,
): string | null {
  if (value === undefined) {
    return fallback;
  }

  if (value === null) {
    return null;
  }

  const raw = String(value).trim();
  if (raw === "") {
    return null;
  }

  const normalized = raw.replace(/,/g, ".").replace(/[^0-9.]/g, "");
  if (normalized === "") {
    throw new PatientRepoError("ML_PATIENT_PROFILE_BAD_REQUEST", 400, `${field} is invalid`);
  }

  const parts = normalized.split(".");
  const collapsed = parts.length <= 1 ? normalized : `${parts.shift() ?? ""}.${parts.join("")}`;
  const parsed = Number(collapsed);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new PatientRepoError("ML_PATIENT_PROFILE_BAD_REQUEST", 400, `${field} is invalid`);
  }

  let stringified = parsed.toFixed(1);
  if (stringified.endsWith(".0")) {
    stringified = stringified.slice(0, -2);
  }

  return stringified;
}

function normalizeCollapsedText(value: unknown, field: string, maxLength: number, allowEmpty: boolean): string {
  const normalized = String(value == null ? "" : value)
    .replace(/\s+/gu, " ")
    .trim();

  if (normalized === "") {
    if (allowEmpty) {
      return "";
    }
    throw new PatientRepoError("ML_PATIENT_PROFILE_BAD_REQUEST", 400, `${field} is required`);
  }

  return normalized.slice(0, maxLength);
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).trim());
}

function parseBirthDateToIso(value: string): string | null {
  const clean = value.trim();
  if (clean === "") {
    return null;
  }

  const isoMatch = clean.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    return isValidIsoDateParts(isoMatch[1], isoMatch[2], isoMatch[3])
      ? `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`
      : null;
  }

  const frMatch = clean.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (frMatch) {
    return isValidIsoDateParts(frMatch[3], frMatch[2], frMatch[1])
      ? `${frMatch[3]}-${frMatch[2]}-${frMatch[1]}`
      : null;
  }

  return null;
}

function isValidIsoDateParts(year: string, month: string, day: string): boolean {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) {
    return false;
  }

  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) {
    return false;
  }

  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function wrapPatientRepoError(
  err: unknown,
  code: string,
  statusCode: number,
  fallbackMessage: string,
): PatientRepoError {
  if (err instanceof PatientRepoError) {
    return err;
  }

  return new PatientRepoError(
    code,
    statusCode,
    err instanceof Error ? err.message : fallbackMessage,
  );
}
