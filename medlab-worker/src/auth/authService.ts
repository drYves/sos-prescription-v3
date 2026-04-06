import crypto from "node:crypto";
import { ActorRole, Prisma, PrismaClient } from "@prisma/client";
import { NdjsonLogger } from "../logger";

const DEFAULT_MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
const MIN_MAGIC_LINK_TTL_MS = 60 * 1000;
const MAX_MAGIC_LINK_TTL_MS = 24 * 60 * 60 * 1000;
const MAGIC_LINK_TOKEN_BYTES = 32;
const MAX_TOKEN_GENERATION_ATTEMPTS = 5;

let prismaSingleton: PrismaClient | null = null;

export interface AuthServiceConfig {
  logger?: NdjsonLogger;
  ttlMs?: number;
}

export interface AuthOwnerCandidate {
  email: string;
  ownerRole: ActorRole.DOCTOR | ActorRole.PATIENT;
  ownerWpUserId: number;
}

export interface AuthOwnerLookupResult {
  status: "matched" | "not_found" | "ambiguous";
  candidate?: AuthOwnerCandidate;
}

export interface IssueMagicLinkInput {
  email: string;
  ownerRole: ActorRole.DOCTOR | ActorRole.PATIENT;
  ownerWpUserId: number;
}

export interface IssueMagicLinkResult {
  token: string;
  expiresAt: Date;
  expiresIn: number;
}

export interface ConsumeMagicLinkResult {
  valid: boolean;
  email: string;
  ownerRole: ActorRole.DOCTOR | ActorRole.PATIENT | null;
  ownerWpUserId: number | null;
}

export class AuthServiceError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(code: string, statusCode: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AuthServiceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class AuthService {
  private readonly prisma: PrismaClient;
  private readonly logger?: NdjsonLogger;
  private readonly ttlMs: number;

  constructor(cfg: AuthServiceConfig = {}) {
    this.prisma = getPrismaClient();
    this.logger = cfg.logger;
    this.ttlMs = clampPositiveInt(cfg.ttlMs ?? DEFAULT_MAGIC_LINK_TTL_MS, MIN_MAGIC_LINK_TTL_MS, MAX_MAGIC_LINK_TTL_MS);
  }

  async lookupOwnerByEmail(input: string, reqId?: string): Promise<AuthOwnerLookupResult> {
    const email = normalizeEmail(input);
    if (email === "") {
      throw new AuthServiceError("ML_MAGIC_LINK_BAD_REQUEST", 400, "email is invalid");
    }

    try {
      const [doctor, patientRows] = await Promise.all([
        this.prisma.doctor.findFirst({
          where: {
            email: { equals: email, mode: "insensitive" },
            wpUserId: { not: null },
          },
          select: {
            wpUserId: true,
          },
        }),
        this.prisma.patient.findMany({
          where: {
            email: { equals: email, mode: "insensitive" },
            wpUserId: { not: null },
          },
          select: {
            wpUserId: true,
          },
          take: 5,
        }),
      ]);

      const patientWpUserIds = uniquePositiveInts(patientRows.map((row) => row.wpUserId));
      const doctorWpUserId = doctor?.wpUserId ?? null;

      if (doctorWpUserId != null && doctorWpUserId > 0) {
        const conflictingPatients = patientWpUserIds.filter((wpUserId) => wpUserId !== doctorWpUserId);
        if (conflictingPatients.length > 0) {
          this.logger?.warning(
            "auth.magic_link.lookup_ambiguous",
            {
              email_fp: fingerprint(email),
              match_type: "doctor_and_patient_conflict",
              doctor_wp_user_id: doctorWpUserId,
              patient_match_count: patientWpUserIds.length,
            },
            reqId,
          );
          return { status: "ambiguous" };
        }

        return {
          status: "matched",
          candidate: {
            email,
            ownerRole: ActorRole.DOCTOR,
            ownerWpUserId: doctorWpUserId,
          },
        };
      }

      if (patientWpUserIds.length === 1) {
        return {
          status: "matched",
          candidate: {
            email,
            ownerRole: ActorRole.PATIENT,
            ownerWpUserId: patientWpUserIds[0],
          },
        };
      }

      if (patientWpUserIds.length > 1) {
        this.logger?.warning(
          "auth.magic_link.lookup_ambiguous",
          {
            email_fp: fingerprint(email),
            match_type: "multiple_patients",
            patient_match_count: patientWpUserIds.length,
          },
          reqId,
        );
        return { status: "ambiguous" };
      }

      return { status: "not_found" };
    } catch (err: unknown) {
      this.logger?.error(
        "auth.magic_link.lookup_failed",
        {
          email_fp: fingerprint(email),
          reason: err instanceof Error ? err.message : "auth_lookup_failed",
        },
        reqId,
        err,
      );

      throw new AuthServiceError("ML_MAGIC_LINK_LOOKUP_FAILED", 500, "magic_link_lookup_failed", { cause: err instanceof Error ? err : undefined });
    }
  }

  async issueMagicLink(input: IssueMagicLinkInput, reqId?: string): Promise<IssueMagicLinkResult> {
    const email = normalizeEmail(input.email);
    const ownerRole = normalizeOwnerRole(input.ownerRole);
    const ownerWpUserId = normalizePositiveInt(input.ownerWpUserId, "ownerWpUserId");

    if (email === "") {
      throw new AuthServiceError("ML_MAGIC_LINK_BAD_REQUEST", 400, "email is invalid");
    }

    let lastError: unknown = null;
    for (let attempt = 0; attempt < MAX_TOKEN_GENERATION_ATTEMPTS; attempt += 1) {
      const token = generateToken();
      const issuedAt = Date.now();
      const expiresAt = new Date(issuedAt + this.ttlMs);

      try {
        await this.prisma.$transaction(async (tx) => {
          await tx.authToken.updateMany({
            where: {
              email,
              ownerRole,
              ownerWpUserId,
              used: false,
              expiresAt: { gt: new Date(issuedAt) },
            },
            data: { used: true },
          });

          await tx.authToken.create({
            data: {
              token,
              email,
              ownerRole,
              ownerWpUserId,
              expiresAt,
              used: false,
            },
          });
        });

        this.logger?.info(
          "auth.magic_link.issued",
          {
            email_fp: fingerprint(email),
            owner_role: ownerRole,
            owner_wp_user_id: ownerWpUserId,
            ttl_ms: this.ttlMs,
          },
          reqId,
        );

        return {
          token,
          expiresAt,
          expiresIn: Math.max(1, Math.trunc((expiresAt.getTime() - issuedAt) / 1000)),
        };
      } catch (err: unknown) {
        lastError = err;
        if (isUniqueTokenError(err)) {
          continue;
        }

        this.logger?.error(
          "auth.magic_link.issue_failed",
          {
            email_fp: fingerprint(email),
            owner_role: ownerRole,
            owner_wp_user_id: ownerWpUserId,
            reason: err instanceof Error ? err.message : "auth_issue_failed",
          },
          reqId,
          err,
        );

        throw new AuthServiceError("ML_MAGIC_LINK_ISSUE_FAILED", 500, "magic_link_issue_failed", { cause: err instanceof Error ? err : undefined });
      }
    }

    this.logger?.error(
      "auth.magic_link.issue_failed",
      {
        email_fp: fingerprint(email),
        owner_role: ownerRole,
        owner_wp_user_id: ownerWpUserId,
        reason: "token_collision_exhausted",
      },
      reqId,
      lastError ?? undefined,
    );

    throw new AuthServiceError("ML_MAGIC_LINK_ISSUE_FAILED", 500, "magic_link_issue_failed");
  }

  async consumeMagicLink(input: string, reqId?: string): Promise<ConsumeMagicLinkResult> {
    const token = normalizeToken(input);
    if (token === "") {
      return buildInvalidConsumeResult();
    }

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const row = await tx.authToken.findUnique({
          where: { token },
          select: {
            id: true,
            email: true,
            ownerRole: true,
            ownerWpUserId: true,
            expiresAt: true,
            used: true,
          },
        });

        if (!row) {
          return buildInvalidConsumeResult();
        }

        const now = new Date();
        if (row.used || row.expiresAt.getTime() <= now.getTime() || row.ownerWpUserId == null || row.ownerWpUserId <= 0) {
          return buildInvalidConsumeResult(row.email);
        }

        const updated = await tx.authToken.updateMany({
          where: {
            id: row.id,
            used: false,
            expiresAt: { gt: now },
          },
          data: {
            used: true,
          },
        });

        if (updated.count !== 1) {
          return buildInvalidConsumeResult(row.email);
        }

        const ownerRole = row.ownerRole === ActorRole.DOCTOR ? ActorRole.DOCTOR : ActorRole.PATIENT;
        return {
          valid: true,
          email: normalizeEmail(row.email),
          ownerRole,
          ownerWpUserId: row.ownerWpUserId,
        } satisfies ConsumeMagicLinkResult;
      });

      this.logger?.info(
        result.valid ? "auth.magic_link.consumed" : "auth.magic_link.rejected",
        {
          token_fp: fingerprint(token),
          email_fp: result.email !== "" ? fingerprint(result.email) : "",
          valid: result.valid,
          owner_role: result.ownerRole,
          owner_wp_user_id: result.ownerWpUserId,
        },
        reqId,
      );

      return result;
    } catch (err: unknown) {
      this.logger?.error(
        "auth.magic_link.consume_failed",
        {
          token_fp: fingerprint(token),
          reason: err instanceof Error ? err.message : "auth_consume_failed",
        },
        reqId,
        err,
      );

      throw new AuthServiceError("ML_MAGIC_LINK_VERIFY_FAILED", 500, "magic_link_verify_failed", { cause: err instanceof Error ? err : undefined });
    }
  }
}

function getPrismaClient(): PrismaClient {
  if (!prismaSingleton) {
    prismaSingleton = new PrismaClient();
  }

  return prismaSingleton;
}

function normalizeEmail(value: string): string {
  const normalized = String(value || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : "";
}

function normalizeToken(value: string): string {
  const normalized = String(value || "").trim();
  if (normalized.length < 32 || normalized.length > 256) {
    return "";
  }
  if (!/^[A-Za-z0-9_-]+$/.test(normalized)) {
    return "";
  }
  return normalized;
}

function normalizeOwnerRole(value: ActorRole): ActorRole.DOCTOR | ActorRole.PATIENT {
  if (value === ActorRole.DOCTOR || value === ActorRole.PATIENT) {
    return value;
  }
  throw new AuthServiceError("ML_MAGIC_LINK_BAD_REQUEST", 400, "ownerRole is invalid");
}

function normalizePositiveInt(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new AuthServiceError("ML_MAGIC_LINK_BAD_REQUEST", 400, `${field} is invalid`);
  }
  return Math.trunc(value);
}

function uniquePositiveInts(values: Array<number | null>): number[] {
  const out = new Set<number>();
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      out.add(Math.trunc(value));
    }
  }
  return Array.from(out.values());
}

function generateToken(): string {
  return crypto.randomBytes(MAGIC_LINK_TOKEN_BYTES).toString("base64url");
}

function clampPositiveInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_MAGIC_LINK_TTL_MS;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function fingerprint(value: string): string {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 12);
}

function buildInvalidConsumeResult(email = ""): ConsumeMagicLinkResult {
  return {
    valid: false,
    email: normalizeEmail(email),
    ownerRole: null,
    ownerWpUserId: null,
  };
}

function isUniqueTokenError(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) {
    return false;
  }
  if (err.code !== "P2002") {
    return false;
  }

  const fields = extractUniqueTargetFields(err.meta?.target);
  return fields.includes("token");
}

function extractUniqueTargetFields(target: unknown): string[] {
  if (Array.isArray(target)) {
    return target
      .filter((value): value is string => typeof value === "string" && value.trim() !== "")
      .map((value) => value.trim());
  }

  if (typeof target === "string" && target.trim() !== "") {
    return [target.trim()];
  }

  return [];
}
