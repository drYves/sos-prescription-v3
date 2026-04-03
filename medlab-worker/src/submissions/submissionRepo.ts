// src/submissions/submissionRepo.ts
import crypto from "node:crypto";
import { ActorRole, Prisma, PrismaClient, SubmissionStatus } from "@prisma/client";
import { NdjsonLogger } from "../logger";

const DEFAULT_SUBMISSION_TTL_MS = 2 * 60 * 60 * 1000;
const RANDOM_PUBLIC_REF_PREFIX = "sub_";
const RANDOM_PUBLIC_REF_BYTES = 16;
const IDEMPOTENT_PUBLIC_REF_HEX_LENGTH = 32;
const MAX_CREATE_ATTEMPTS = 6;

let prismaSingleton: PrismaClient | null = null;

export interface SubmissionRepoConfig {
  logger?: NdjsonLogger;
  ttlMs?: number;
}

export interface SubmissionActorInput {
  role: ActorRole;
  wpUserId?: number | null;
}

export interface CreateSubmissionInput {
  actor: SubmissionActorInput;
  flowKey: string;
  priority: string;
  idempotencyKey?: string | null;
}

export interface SubmissionRecord {
  id: string;
  publicRef: string;
  ownerRole: ActorRole;
  ownerWpUserId: number | null;
  status: SubmissionStatus;
  flowKey: string;
  priority: string;
  expiresAt: Date;
  finalizedPrescriptionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateSubmissionResult {
  mode: "created" | "replayed";
  submission: SubmissionRecord;
}

export class SubmissionRepoError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(code: string, statusCode: number, message: string) {
    super(message);
    this.name = "SubmissionRepoError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class SubmissionRepo {
  private readonly prisma: PrismaClient;
  private readonly logger?: NdjsonLogger;
  private readonly ttlMs: number;

  constructor(cfg: SubmissionRepoConfig = {}) {
    this.prisma = getPrismaClient();
    this.logger = cfg.logger;
    this.ttlMs = normalizeTtlMs(cfg.ttlMs);
  }

  async createSubmission(input: CreateSubmissionInput): Promise<CreateSubmissionResult> {
    const normalized = normalizeCreateSubmissionInput(input);
    const expiresAt = new Date(Date.now() + this.ttlMs);
    const deterministicPublicRef = normalized.idempotencyKey
      ? buildIdempotentPublicRef(normalized)
      : null;

    if (deterministicPublicRef) {
      const existing = await this.prisma.submission.findUnique({
        where: { publicRef: deterministicPublicRef },
        select: submissionSelect(),
      });

      if (existing) {
        return {
          mode: "replayed",
          submission: mapSubmission(existing),
        };
      }
    }

    let publicRef = deterministicPublicRef ?? generateRandomPublicRef();

    for (let attempt = 1; attempt <= MAX_CREATE_ATTEMPTS; attempt += 1) {
      try {
        const created = await this.prisma.submission.create({
          data: {
            publicRef,
            ownerRole: normalized.actor.role,
            ownerWpUserId: normalized.actor.wpUserId,
            status: SubmissionStatus.OPEN,
            flowKey: normalized.flowKey,
            priority: normalized.priority,
            expiresAt,
            finalizedPrescriptionId: null,
          },
          select: submissionSelect(),
        });

        return {
          mode: "created",
          submission: mapSubmission(created),
        };
      } catch (err: unknown) {
        if (isUniquePublicRefError(err)) {
          if (deterministicPublicRef) {
            const existing = await this.prisma.submission.findUnique({
              where: { publicRef: deterministicPublicRef },
              select: submissionSelect(),
            });

            if (existing) {
              return {
                mode: "replayed",
                submission: mapSubmission(existing),
              };
            }
          } else {
            publicRef = generateRandomPublicRef();
            continue;
          }
        }

        this.logger?.error(
          "submission.repo_create_failed",
          {
            reason: err instanceof Error ? err.message : "submission_repo_create_failed",
          },
          undefined,
          err,
        );

        throw wrapSubmissionRepoError(err);
      }
    }

    throw new SubmissionRepoError(
      "ML_SUBMISSION_CREATE_FAILED",
      500,
      "Unable to allocate a unique submission reference",
    );
  }
}

function getPrismaClient(): PrismaClient {
  if (!prismaSingleton) {
    prismaSingleton = new PrismaClient();
  }

  return prismaSingleton;
}

function submissionSelect() {
  return {
    id: true,
    publicRef: true,
    ownerRole: true,
    ownerWpUserId: true,
    status: true,
    flowKey: true,
    priority: true,
    expiresAt: true,
    finalizedPrescriptionId: true,
    createdAt: true,
    updatedAt: true,
  } satisfies Prisma.SubmissionSelect;
}

function mapSubmission(
  row: Prisma.SubmissionGetPayload<{ select: ReturnType<typeof submissionSelect> }>,
): SubmissionRecord {
  return {
    id: row.id,
    publicRef: row.publicRef,
    ownerRole: row.ownerRole,
    ownerWpUserId: row.ownerWpUserId,
    status: row.status,
    flowKey: row.flowKey,
    priority: row.priority,
    expiresAt: row.expiresAt,
    finalizedPrescriptionId: row.finalizedPrescriptionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizeCreateSubmissionInput(input: CreateSubmissionInput): {
  actor: { role: ActorRole; wpUserId: number | null };
  flowKey: string;
  priority: string;
  idempotencyKey: string | null;
} {
  if (!input || typeof input !== "object") {
    throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, "submission input is required");
  }

  return {
    actor: normalizeActor(input.actor),
    flowKey: normalizeSlug(input.flowKey, "flowKey", 64),
    priority: normalizeSlug(input.priority, "priority", 32),
    idempotencyKey: normalizeIdempotencyKey(input.idempotencyKey),
  };
}

function normalizeActor(input: SubmissionActorInput): { role: ActorRole; wpUserId: number | null } {
  if (!input || typeof input !== "object") {
    throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, "actor is required");
  }

  if (![ActorRole.PATIENT, ActorRole.DOCTOR, ActorRole.SYSTEM].includes(input.role)) {
    throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, "actor.role is invalid");
  }

  const wpUserId = normalizeNullablePositiveInt(input.wpUserId);
  if (input.role !== ActorRole.SYSTEM && wpUserId == null) {
    throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, "actor.wpUserId is required");
  }

  return {
    role: input.role,
    wpUserId,
  };
}

function normalizeSlug(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, `${field} is required`);
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "" || normalized.length > maxLength || !/^[a-z0-9][a-z0-9_-]*$/.test(normalized)) {
    throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, `${field} is invalid`);
  }

  return normalized;
}

function normalizeIdempotencyKey(value: unknown): string | null {
  if (value == null || value === "") {
    return null;
  }

  if (typeof value !== "string") {
    throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, "idempotencyKey is invalid");
  }

  const normalized = value.trim();
  if (normalized === "" || normalized.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, "idempotencyKey is invalid");
  }

  return normalized;
}

function normalizeNullablePositiveInt(value: unknown): number | null {
  if (value == null || value === "") {
    return null;
  }

  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, "actor.wpUserId is invalid");
  }

  return Math.trunc(parsed);
}

function normalizeTtlMs(value: unknown): number {
  if (value == null || value === "") {
    return DEFAULT_SUBMISSION_TTL_MS;
  }

  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SUBMISSION_TTL_MS;
  }

  return Math.max(60_000, Math.trunc(parsed));
}

function buildIdempotentPublicRef(input: {
  actor: { role: ActorRole; wpUserId: number | null };
  flowKey: string;
  priority: string;
  idempotencyKey: string | null;
}): string {
  const hash = crypto.createHash("sha256");
  hash.update(input.actor.role);
  hash.update(":");
  hash.update(String(input.actor.wpUserId ?? 0));
  hash.update(":");
  hash.update(input.flowKey);
  hash.update(":");
  hash.update(input.priority);
  hash.update(":");
  hash.update(String(input.idempotencyKey ?? ""));
  return `${RANDOM_PUBLIC_REF_PREFIX}${hash.digest("hex").slice(0, IDEMPOTENT_PUBLIC_REF_HEX_LENGTH)}`;
}

function generateRandomPublicRef(): string {
  return `${RANDOM_PUBLIC_REF_PREFIX}${crypto.randomBytes(RANDOM_PUBLIC_REF_BYTES).toString("hex")}`;
}

function isUniquePublicRefError(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) {
    return false;
  }

  if (err.code !== "P2002") {
    return false;
  }

  const target = extractUniqueTargetFields(err.meta?.target);
  return target.includes("publicRef");
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

function wrapSubmissionRepoError(err: unknown): SubmissionRepoError {
  if (err instanceof SubmissionRepoError) {
    return err;
  }

  return new SubmissionRepoError(
    "ML_SUBMISSION_CREATE_FAILED",
    500,
    err instanceof Error ? err.message : "submission_create_failed",
  );
}
