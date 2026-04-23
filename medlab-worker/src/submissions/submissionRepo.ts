// src/submissions/submissionRepo.ts
import crypto from "node:crypto";
import { ActorRole, ArtifactKind, ArtifactStatus, Prisma, PrismaClient, SubmissionStatus } from "@prisma/client";
import { NdjsonLogger } from "../logger";
import { canonicalizeMedicationItems } from "../prescriptions/canonicalMedicationItems";

const DEFAULT_SUBMISSION_TTL_MS = 2 * 60 * 60 * 1000;
const RANDOM_PUBLIC_REF_PREFIX = "sub_";
const RANDOM_PUBLIC_REF_BYTES = 16;
const IDEMPOTENT_PUBLIC_REF_HEX_LENGTH = 32;
const MAX_CREATE_ATTEMPTS = 6;
const MAX_FINALIZE_ATTEMPTS = 6;
const TX_MAX_WAIT_MS = 5_000;
const TX_TIMEOUT_MS = 15_000;
const UID_LENGTH = 10;
const VERIFY_TOKEN_BYTES = 24;
const MAX_PRIVATE_NOTES_LENGTH = 4_000;
const SUBMISSION_STATUS_DRAFT = "DRAFT" as SubmissionStatus;

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
  reqId?: string | null;
  idempotencyKey?: string | null;
}

export interface CreateDraftSubmissionInput {
  email: string;
  flowKey: string;
  priority: string;
  reqId?: string | null;
  idempotencyKey?: string | null;
}

export interface FinalizeSubmissionInput {
  submissionRef: string;
  actor: SubmissionActorInput;
  reqId?: string | null;
  idempotencyKey?: string | null;
  patient: Record<string, unknown>;
  items: unknown[];
  privateNotes?: string | null;
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

export interface FinalizedPrescriptionRecord {
  id: string;
  uid: string;
  status: string;
  processingStatus: string;
  flowKey: string | null;
  priority: string;
  hasProof: boolean;
  proofCount: number;
  verifyCode: string | null;
  verifyToken: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FinalizeSubmissionResult {
  mode: "created" | "replayed";
  submission: SubmissionRecord;
  prescription: FinalizedPrescriptionRecord;
  prescription_id: string;
  uid: string;
  status: string;
  processing_status: string;
  has_proof: boolean;
  proof_count: number;
}

interface NormalizedFinalizePatientInput {
  firstName: string;
  lastName: string;
  birthDate: string;
  gender: string | null | undefined;
  email: string | null | undefined;
  phone: string | null | undefined;
  weightKg: string | null | undefined;
  heightCm: string | null | undefined;
  note: string | null | undefined;
}

interface LockedSubmissionRow {
  id: string;
  publicRef: string;
  ownerRole: ActorRole;
  ownerWpUserId: number | null;
  email: string | null;
  status: SubmissionStatus;
  flowKey: string;
  priority: string;
  expiresAt: Date;
  finalizedPrescriptionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface FinalizeTransactionOutcome {
  mode: "created" | "replayed";
  submissionId: string;
  prescriptionId: string;
}

type SubmissionRepoErrorOptions = {
  cause?: unknown;
};

export class SubmissionRepoError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(code: string, statusCode: number, message: string, options: SubmissionRepoErrorOptions = {}) {
    super(message);
    this.name = "SubmissionRepoError";
    this.code = code;
    this.statusCode = statusCode;

    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
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
        return await resolveExistingCreateSubmission(this.prisma, existing, this.logger, normalized.reqId);
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
              return await resolveExistingCreateSubmission(this.prisma, existing, this.logger, normalized.reqId);
            }
          } else {
            publicRef = generateRandomPublicRef();
            continue;
          }
        }

        this.logger?.error(
          "submission.finalize.rejected",
          {
            phase: "create",
            code: "ML_SUBMISSION_CREATE_FAILED",
            reason: err instanceof Error ? err.message : "submission_create_failed",
          },
          normalized.reqId ?? undefined,
          err,
        );

        throw wrapSubmissionRepoError(err, "ML_SUBMISSION_CREATE_FAILED", 500, "submission_create_failed");
      }
    }

    throw new SubmissionRepoError(
      "ML_SUBMISSION_CREATE_FAILED",
      500,
      "Unable to allocate a unique submission reference",
    );
  }

  async createDraftSubmission(input: CreateDraftSubmissionInput): Promise<CreateSubmissionResult> {
    const normalized = normalizeCreateDraftSubmissionInput(input);
    const expiresAt = new Date(Date.now() + this.ttlMs);
    const deterministicPublicRef = normalized.idempotencyKey
      ? buildDraftPublicRef(normalized)
      : null;

    if (deterministicPublicRef) {
      const existing = await this.prisma.submission.findUnique({
        where: { publicRef: deterministicPublicRef },
        select: submissionSelect(),
      });

      if (existing) {
        return await resolveExistingDraftSubmission(this.prisma, existing, normalized.email, this.logger, normalized.reqId);
      }
    }

    let publicRef = deterministicPublicRef ?? generateRandomPublicRef();

    for (let attempt = 1; attempt <= MAX_CREATE_ATTEMPTS; attempt += 1) {
      try {
        const created = await this.prisma.submission.create({
          data: {
            publicRef,
            ownerRole: ActorRole.PATIENT,
            ownerWpUserId: null,
            email: normalized.email,
            status: SUBMISSION_STATUS_DRAFT,
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
              return await resolveExistingDraftSubmission(this.prisma, existing, normalized.email, this.logger, normalized.reqId);
            }
          } else {
            publicRef = generateRandomPublicRef();
            continue;
          }
        }

        this.logger?.error(
          "submission.finalize.rejected",
          {
            phase: "create_draft",
            code: "ML_SUBMISSION_CREATE_FAILED",
            reason: err instanceof Error ? err.message : "submission_create_failed",
          },
          normalized.reqId ?? undefined,
          err,
        );

        throw wrapSubmissionRepoError(err, "ML_SUBMISSION_CREATE_FAILED", 500, "submission_create_failed");
      }
    }

    throw new SubmissionRepoError(
      "ML_SUBMISSION_CREATE_FAILED",
      500,
      "Unable to allocate a unique submission reference",
    );
  }

  async finalizeSubmission(input: FinalizeSubmissionInput): Promise<FinalizeSubmissionResult> {
    const normalized = normalizeFinalizeSubmissionInput(input);

    for (let attempt = 1; attempt <= MAX_FINALIZE_ATTEMPTS; attempt += 1) {
      try {
        const outcome = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          let submission = await lockSubmissionByPublicRef(tx, normalized.submissionRef);
          if (!submission) {
            throw new SubmissionRepoError("ML_SUBMISSION_NOT_FOUND", 404, "submission not found");
          }

          if (submission.status === SubmissionStatus.FINALIZED) {
            return replayFinalizedSubmissionOutcome(submission);
          }

          if (submission.status === SubmissionStatus.EXPIRED || submission.expiresAt.getTime() <= Date.now()) {
            if (submission.status === SubmissionStatus.OPEN || submission.status === SUBMISSION_STATUS_DRAFT) {
              await tx.submission.update({
                where: { id: submission.id },
                data: { status: SubmissionStatus.EXPIRED },
              });
            }

            this.logger?.warning(
              "submission.expired",
              {
                phase: "finalize",
                submission_ref: normalized.submissionRef,
                submission_id: submission.id,
                owner_role: submission.ownerRole,
                owner_wp_user_id: submission.ownerWpUserId,
              },
              normalized.reqId ?? undefined,
            );

            throw new SubmissionRepoError("ML_SUBMISSION_EXPIRED", 410, "submission expired");
          }

          if (submission.status !== SubmissionStatus.OPEN && submission.status !== SUBMISSION_STATUS_DRAFT) {
            throw new SubmissionRepoError("ML_SUBMISSION_NOT_OPEN", 409, "submission is not open");
          }

          if (canClaimAnonymousDraft(submission, normalized.actor)) {
            await tx.submission.update({
              where: { id: submission.id },
              data: {
                ownerWpUserId: normalized.actor.wpUserId,
              },
            });

            submission = {
              ...submission,
              ownerWpUserId: normalized.actor.wpUserId,
            };
          }

          assertSubmissionOwnership(submission, normalized.actor);

          const patientWpUserId = normalized.actor.role === ActorRole.PATIENT
            ? normalized.actor.wpUserId
            : null;
          const submissionEmail = normalizeOptionalEmail(submission.email);
          const sealedPatientEmail = normalized.patient.email == null
            ? (submissionEmail ?? null)
            : normalized.patient.email;
          const effectivePatient = {
            ...normalized.patient,
            email: sealedPatientEmail ?? undefined,
          } satisfies NormalizedFinalizePatientInput;

          const patient = await ensurePatientForFinalize(tx, {
            wpUserId: patientWpUserId,
            patient: effectivePatient,
          });

          const canonicalItems = canonicalizeMedicationItems(normalized.items, {
            flowKey: submission.flowKey,
            sourceStage: "submission_finalize",
          });

          const createdPrescription = await tx.prescription.create({
            data: {
              uid: generatePublicUid(),
              doctorId: null,
              patientId: patient.id,
              status: "PENDING",
              items: toInputJsonValue(canonicalItems),
              privateNotes: normalized.privateNotes,
              s3PdfKey: null,
              verifyCode: generateVerifyCode(),
              verifyToken: generateVerifyToken(),
              processingStatus: "PENDING",
              availableAt: new Date(),
              claimedAt: null,
              lockExpiresAt: null,
              workerRef: null,
              attempts: 0,
              maxAttempts: 5,
              lastErrorCode: null,
              lastErrorMessageSafe: null,
              sourceReqId: null,
              flowKey: submission.flowKey,
              priority: submission.priority,
              hasProof: false,
              proofCount: 0,
              messageCount: 0,
              lastMessageSeq: 0,
              lastMessageAt: null,
              lastMessageRole: null,
              doctorLastReadSeq: 0,
              patientLastReadSeq: 0,
              unreadCountDoctor: 0,
              unreadCountPatient: 0,
            },
            select: { id: true },
          });

          await tx.submission.update({
            where: { id: submission.id },
            data: {
              ownerWpUserId: patientWpUserId ?? submission.ownerWpUserId ?? null,
              email: sealedPatientEmail,
              status: SubmissionStatus.FINALIZED,
              finalizedPrescriptionId: createdPrescription.id,
            },
          });

          await sealPatientIdentityAfterFinalize(tx, {
            patientId: patient.id,
            submissionId: submission.id,
            wpUserId: patientWpUserId,
            email: sealedPatientEmail,
            patient: effectivePatient,
          });

          return {
            mode: "created" as const,
            submissionId: submission.id,
            prescriptionId: createdPrescription.id,
          };
        }, {
          maxWait: TX_MAX_WAIT_MS,
          timeout: TX_TIMEOUT_MS,
        });

        await syncSubmissionArtifactsToPrescription(this.prisma, outcome.submissionId, outcome.prescriptionId);
        return await readFinalizeSubmissionResult(this.prisma, outcome.mode, outcome.submissionId, outcome.prescriptionId);
      } catch (err: unknown) {
        if (isFinalizeRetryableUniqueError(err)) {
          continue;
        }

        if (err instanceof SubmissionRepoError) {
          throw err;
        }

        this.logger?.error(
          "submission.finalize.rejected",
          {
            phase: "finalize",
            code: "ML_SUBMISSION_FINALIZE_FAILED",
            submission_ref: normalized.submissionRef,
            reason: err instanceof Error ? err.message : "submission_finalize_failed",
          },
          normalized.reqId ?? undefined,
          err,
        );

        throw wrapSubmissionRepoError(err, "ML_SUBMISSION_FINALIZE_FAILED", 500, "submission_finalize_failed");
      }
    }

    throw new SubmissionRepoError(
      "ML_SUBMISSION_FINALIZE_FAILED",
      500,
      "Unable to allocate unique prescription references",
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
    email: true,
    status: true,
    flowKey: true,
    priority: true,
    expiresAt: true,
    finalizedPrescriptionId: true,
    createdAt: true,
    updatedAt: true,
  } satisfies Prisma.SubmissionSelect;
}

function finalizedPrescriptionSelect() {
  return {
    id: true,
    uid: true,
    status: true,
    processingStatus: true,
    flowKey: true,
    priority: true,
    hasProof: true,
    proofCount: true,
    verifyCode: true,
    verifyToken: true,
    createdAt: true,
    updatedAt: true,
  } satisfies Prisma.PrescriptionSelect;
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

function mapFinalizedPrescription(
  row: Prisma.PrescriptionGetPayload<{ select: ReturnType<typeof finalizedPrescriptionSelect> }>,
): FinalizedPrescriptionRecord {
  return {
    id: row.id,
    uid: row.uid,
    status: row.status,
    processingStatus: row.processingStatus,
    flowKey: row.flowKey,
    priority: row.priority,
    hasProof: row.hasProof,
    proofCount: row.proofCount,
    verifyCode: row.verifyCode,
    verifyToken: row.verifyToken,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function buildFinalizeResult(
  mode: "created" | "replayed",
  submission: Prisma.SubmissionGetPayload<{ select: ReturnType<typeof submissionSelect> }>,
  prescription: Prisma.PrescriptionGetPayload<{ select: ReturnType<typeof finalizedPrescriptionSelect> }>,
): FinalizeSubmissionResult {
  const mappedSubmission = mapSubmission(submission);
  const mappedPrescription = mapFinalizedPrescription(prescription);

  return {
    mode,
    submission: mappedSubmission,
    prescription: mappedPrescription,
    prescription_id: mappedPrescription.id,
    uid: mappedPrescription.uid,
    status: mappedPrescription.status,
    processing_status: mappedPrescription.processingStatus,
    has_proof: mappedPrescription.hasProof,
    proof_count: mappedPrescription.proofCount,
  };
}

async function syncSubmissionArtifactsToPrescription(
  prisma: PrismaClient,
  submissionId: string,
  prescriptionId: string,
): Promise<void> {
  await prisma.artifact.updateMany({
    where: {
      submissionId,
      deletedAt: null,
    },
    data: {
      prescriptionId,
      linkedAt: new Date(),
    },
  });

  const proofCount = await prisma.artifact.count({
    where: {
      prescriptionId,
      kind: ArtifactKind.PROOF,
      status: ArtifactStatus.READY,
      deletedAt: null,
    },
  });

  await prisma.prescription.update({
    where: { id: prescriptionId },
    data: {
      hasProof: proofCount > 0,
      proofCount,
    },
  });
}

async function readFinalizeSubmissionResult(
  prisma: PrismaClient,
  mode: "created" | "replayed",
  submissionId: string,
  prescriptionId: string,
): Promise<FinalizeSubmissionResult> {
  const [submission, prescription] = await Promise.all([
    prisma.submission.findUnique({
      where: { id: submissionId },
      select: submissionSelect(),
    }),
    prisma.prescription.findUnique({
      where: { id: prescriptionId },
      select: finalizedPrescriptionSelect(),
    }),
  ]);

  if (!submission) {
    throw new SubmissionRepoError("ML_SUBMISSION_NOT_FOUND", 404, "submission not found");
  }

  if (!prescription) {
    throw new SubmissionRepoError(
      "ML_SUBMISSION_FINALIZE_FAILED",
      500,
      "finalized prescription is missing",
    );
  }

  return buildFinalizeResult(mode, submission, prescription);
}

async function resolveExistingCreateSubmission(
  prisma: PrismaClient,
  existing: Prisma.SubmissionGetPayload<{ select: ReturnType<typeof submissionSelect> }>,
  logger?: NdjsonLogger,
  reqId?: string | null,
): Promise<CreateSubmissionResult> {
  if (existing.status === SubmissionStatus.OPEN && existing.expiresAt.getTime() > Date.now()) {
    return {
      mode: "replayed",
      submission: mapSubmission(existing),
    };
  }

  if (existing.status === SubmissionStatus.EXPIRED || existing.expiresAt.getTime() <= Date.now()) {
    if (existing.status === SubmissionStatus.OPEN) {
      await prisma.submission.updateMany({
        where: {
          id: existing.id,
          status: SubmissionStatus.OPEN,
        },
        data: {
          status: SubmissionStatus.EXPIRED,
        },
      });
    }

    logger?.warning(
      "submission.expired",
      {
        phase: "create",
        submission_ref: existing.publicRef,
        submission_id: existing.id,
        owner_role: existing.ownerRole,
        owner_wp_user_id: existing.ownerWpUserId,
      },
      reqId ?? undefined,
    );

    throw new SubmissionRepoError("ML_SUBMISSION_EXPIRED", 410, "submission expired");
  }

  throw new SubmissionRepoError("ML_SUBMISSION_NOT_OPEN", 409, "submission is not open");
}

async function resolveExistingDraftSubmission(
  prisma: PrismaClient,
  existing: Prisma.SubmissionGetPayload<{ select: ReturnType<typeof submissionSelect> }>,
  email: string,
  logger?: NdjsonLogger,
  reqId?: string | null,
): Promise<CreateSubmissionResult> {
  if (existing.status === SUBMISSION_STATUS_DRAFT && existing.expiresAt.getTime() > Date.now()) {
    if (existing.email !== email) {
      await prisma.submission.updateMany({
        where: {
          id: existing.id,
          status: SUBMISSION_STATUS_DRAFT,
        },
        data: {
          email,
        },
      });
    }

    return {
      mode: "replayed",
      submission: mapSubmission(existing),
    };
  }

  if (existing.status === SubmissionStatus.EXPIRED || existing.expiresAt.getTime() <= Date.now()) {
    if (existing.status === SUBMISSION_STATUS_DRAFT) {
      await prisma.submission.updateMany({
        where: {
          id: existing.id,
          status: SUBMISSION_STATUS_DRAFT,
        },
        data: {
          status: SubmissionStatus.EXPIRED,
        },
      });
    }

    logger?.warning(
      "submission.expired",
      {
        phase: "create_draft",
        submission_ref: existing.publicRef,
        submission_id: existing.id,
        owner_role: existing.ownerRole,
        owner_wp_user_id: existing.ownerWpUserId,
      },
      reqId ?? undefined,
    );

    throw new SubmissionRepoError("ML_SUBMISSION_EXPIRED", 410, "submission expired");
  }

  throw new SubmissionRepoError("ML_SUBMISSION_NOT_OPEN", 409, "submission is not open");
}

function normalizeCreateSubmissionInput(input: CreateSubmissionInput): {
  actor: { role: ActorRole; wpUserId: number | null };
  flowKey: string;
  priority: string;
  reqId: string | null;
  idempotencyKey: string | null;
} {
  if (!input || typeof input !== "object") {
    throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, "submission input is required");
  }

  return {
    actor: normalizeActor(input.actor),
    flowKey: normalizeSlug(input.flowKey, "flowKey", 64),
    priority: normalizeSlug(input.priority, "priority", 32),
    reqId: normalizeOptionalRequestId(input.reqId),
    idempotencyKey: normalizeIdempotencyKey(input.idempotencyKey),
  };
}

function normalizeCreateDraftSubmissionInput(input: CreateDraftSubmissionInput): {
  email: string;
  flowKey: string;
  priority: string;
  reqId: string | null;
  idempotencyKey: string | null;
} {
  if (!input || typeof input !== "object") {
    throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, "submission input is required");
  }

  return {
    email: normalizeRequiredEmail(input.email, "email"),
    flowKey: normalizeSlug(input.flowKey, "flowKey", 64),
    priority: normalizeSlug(input.priority, "priority", 32),
    reqId: normalizeOptionalRequestId(input.reqId),
    idempotencyKey: normalizeIdempotencyKey(input.idempotencyKey),
  };
}

function normalizeFinalizeSubmissionInput(input: FinalizeSubmissionInput): {
  submissionRef: string;
  actor: { role: ActorRole; wpUserId: number | null };
  reqId: string | null;
  idempotencyKey: string | null;
  patient: NormalizedFinalizePatientInput;
  items: unknown[];
  privateNotes: string | null;
} {
  if (!input || typeof input !== "object") {
    throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, "submission input is required");
  }

  if (!Array.isArray(input.items)) {
    throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, "items must be an array");
  }

  return {
    submissionRef: normalizeSubmissionRef(input.submissionRef),
    actor: normalizeActor(input.actor),
    reqId: normalizeOptionalRequestId(input.reqId),
    idempotencyKey: normalizeIdempotencyKey(input.idempotencyKey),
    patient: normalizeFinalizePatientInput(input.patient),
    items: input.items,
    privateNotes: normalizeNullableNotes(input.privateNotes),
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

function normalizeFinalizePatientInput(value: Record<string, unknown>): NormalizedFinalizePatientInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, "patient is required");
  }

  return {
    firstName: normalizeNameRequired(pickFirstDefined(value.firstName, value.first_name), "patient.firstName", 100),
    lastName: normalizeNameRequired(pickFirstDefined(value.lastName, value.last_name), "patient.lastName", 120),
    birthDate: normalizeBirthDateRequired(pickFirstDefined(value.birthDate, value.birthdate), "patient.birthDate"),
    gender: normalizeOptionalPlainTextUpdate(pickFirstDefined(value.gender), 32),
    email: normalizeOptionalEmailUpdate(pickFirstDefined(value.email)),
    phone: normalizeOptionalPhoneUpdate(pickFirstDefined(value.phone)),
    weightKg: normalizeOptionalMetricUpdate(pickFirstDefined(value.weightKg, value.weight_kg), "patient.weightKg", 1, 500),
    heightCm: normalizeOptionalMetricUpdate(pickFirstDefined(value.heightCm, value.height_cm), "patient.heightCm", 30, 300),
    note: normalizeOptionalNotesUpdate(pickFirstDefined(value.note, value.medical_notes, value.medicalNotes)),
  };
}

function buildPatientCreateData(patient: NormalizedFinalizePatientInput): {
  firstName: string;
  lastName: string;
  birthDate: string;
  gender: string | null;
  email: string | null;
  phone: string | null;
  weightKg: string | null;
  heightCm: string | null;
  note: string | null;
} {
  return {
    firstName: patient.firstName,
    lastName: patient.lastName,
    birthDate: patient.birthDate,
    gender: patient.gender ?? null,
    email: patient.email ?? null,
    phone: patient.phone ?? null,
    weightKg: patient.weightKg ?? null,
    heightCm: patient.heightCm ?? null,
    note: patient.note ?? null,
  };
}

function buildPatientUpdateData(patient: NormalizedFinalizePatientInput): Prisma.PatientUpdateInput {
  const data: Prisma.PatientUpdateInput = {
    firstName: patient.firstName,
    lastName: patient.lastName,
    birthDate: patient.birthDate,
  };

  if (patient.gender !== undefined) {
    data.gender = patient.gender;
  }
  if (patient.email !== undefined) {
    data.email = patient.email;
  }
  if (patient.phone !== undefined) {
    data.phone = patient.phone;
  }
  if (patient.weightKg !== undefined) {
    data.weightKg = patient.weightKg;
  }
  if (patient.heightCm !== undefined) {
    data.heightCm = patient.heightCm;
  }
  if (patient.note !== undefined) {
    data.note = patient.note;
  }

  return data;
}

async function sealPatientIdentityAfterFinalize(
  tx: Prisma.TransactionClient,
  input: {
    patientId: string;
    submissionId: string;
    wpUserId: number | null;
    email: string | null;
    patient: NormalizedFinalizePatientInput;
  },
): Promise<void> {
  const normalizedPatient = {
    ...input.patient,
    email: input.email ?? input.patient.email ?? undefined,
  } satisfies NormalizedFinalizePatientInput;

  const data: Prisma.PatientUpdateInput = {
    ...buildPatientUpdateData(normalizedPatient),
  };

  if (input.wpUserId != null) {
    data.wpUserId = input.wpUserId;
  }
  if (input.email !== null) {
    data.email = input.email;
  }

  const existingById = await tx.patient.findUnique({
    where: { id: input.patientId },
    select: { id: true },
  });

  if (existingById) {
    await tx.patient.update({
      where: { id: existingById.id },
      data,
      select: { id: true },
    });
  } else {
    const existingByWpUserId = input.wpUserId != null
      ? await tx.patient.findFirst({
        where: {
          wpUserId: input.wpUserId,
          deletedAt: null,
        },
        select: { id: true },
      })
      : null;

    if (existingByWpUserId) {
      await tx.patient.update({
        where: { id: existingByWpUserId.id },
        data,
        select: { id: true },
      });
    } else if (input.email) {
      const existingByEmail = await tx.patient.findFirst({
        where: {
          email: { equals: input.email, mode: "insensitive" },
          deletedAt: null,
        },
        orderBy: { updatedAt: "desc" },
        select: { id: true },
      });

      if (existingByEmail) {
        await tx.patient.update({
          where: { id: existingByEmail.id },
          data,
          select: { id: true },
        });
      } else {
        await tx.patient.create({
          data: {
            wpUserId: input.wpUserId,
            ...buildPatientCreateData(normalizedPatient),
          },
          select: { id: true },
        });
      }
    } else {
      await tx.patient.create({
        data: {
          wpUserId: input.wpUserId,
          ...buildPatientCreateData(normalizedPatient),
        },
        select: { id: true },
      });
    }
  }

  const submissionIdentityData: Prisma.SubmissionUpdateManyMutationInput = {};
  if (input.wpUserId != null) {
    submissionIdentityData.ownerWpUserId = input.wpUserId;
  }
  if (input.email) {
    submissionIdentityData.email = input.email;
  }

  if (Object.keys(submissionIdentityData).length > 0) {
    const submissionIdentityClauses: Prisma.SubmissionWhereInput[] = [
      { id: input.submissionId },
    ];

    if (input.wpUserId != null) {
      submissionIdentityClauses.push({ ownerWpUserId: input.wpUserId });
    }
    if (input.email) {
      submissionIdentityClauses.push({ email: { equals: input.email, mode: "insensitive" } });
    }

    await tx.submission.updateMany({
      where: {
        ownerRole: ActorRole.PATIENT,
        OR: submissionIdentityClauses,
      },
      data: submissionIdentityData,
    });
  }
}

async function ensurePatientForFinalize(
  tx: Prisma.TransactionClient,
  input: {
    wpUserId: number | null;
    patient: NormalizedFinalizePatientInput;
  },
): Promise<{ id: string }> {
  const updateData = buildPatientUpdateData(input.patient);

  if (input.wpUserId != null) {
    const existingByWpUserId = await tx.patient.findFirst({
      where: {
        wpUserId: input.wpUserId,
        deletedAt: null,
      },
      select: {
        id: true,
      },
    });

    if (existingByWpUserId) {
      return tx.patient.update({
        where: { id: existingByWpUserId.id },
        data: updateData,
        select: { id: true },
      });
    }
  }

  const patientEmail = input.patient.email ?? null;
  if (patientEmail) {
    const existingByEmail = await tx.patient.findFirst({
      where: {
        email: { equals: patientEmail, mode: "insensitive" },
        deletedAt: null,
      },
      orderBy: {
        updatedAt: "desc",
      },
      select: {
        id: true,
        wpUserId: true,
      },
    });

    if (existingByEmail) {
      const data: Prisma.PatientUpdateInput = {
        ...updateData,
      };

      if (input.wpUserId != null && existingByEmail.wpUserId !== input.wpUserId) {
        data.wpUserId = input.wpUserId;
      }

      return tx.patient.update({
        where: { id: existingByEmail.id },
        data,
        select: { id: true },
      });
    }
  }

  return tx.patient.create({
    data: {
      wpUserId: input.wpUserId,
      ...buildPatientCreateData(input.patient),
    },
    select: { id: true },
  });
}

async function lockSubmissionByPublicRef(
  tx: Prisma.TransactionClient,
  submissionRef: string,
): Promise<LockedSubmissionRow | null> {
  const rows = await tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT
      "id",
      "publicRef",
      "ownerRole",
      "ownerWpUserId",
      "email",
      "status",
      "flowKey",
      "priority",
      "expiresAt",
      "finalizedPrescriptionId",
      "createdAt",
      "updatedAt"
    FROM "Submission"
    WHERE "publicRef" = ${submissionRef}
    LIMIT 1
    FOR UPDATE
  `);

  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }

  return mapLockedSubmissionRow(rows[0]);
}

function mapLockedSubmissionRow(row: Record<string, unknown>): LockedSubmissionRow {
  const ownerRole = normalizeActorRoleValue(row.ownerRole);
  const status = normalizeSubmissionStatusValue(row.status);

  return {
    id: normalizeRequiredString(row.id, "submission.id"),
    publicRef: normalizeRequiredString(row.publicRef, "submission.publicRef"),
    ownerRole,
    ownerWpUserId: normalizeNullablePositiveInt(row.ownerWpUserId),
    email: normalizeOptionalEmail(row.email),
    status,
    flowKey: normalizeRequiredString(row.flowKey, "submission.flowKey"),
    priority: normalizeRequiredString(row.priority, "submission.priority"),
    expiresAt: normalizeDateValue(row.expiresAt, "submission.expiresAt"),
    finalizedPrescriptionId: normalizeNullableString(row.finalizedPrescriptionId),
    createdAt: normalizeDateValue(row.createdAt, "submission.createdAt"),
    updatedAt: normalizeDateValue(row.updatedAt, "submission.updatedAt"),
  };
}

function replayFinalizedSubmissionOutcome(submission: LockedSubmissionRow): FinalizeTransactionOutcome {
  const prescriptionId = normalizeNullableString(submission.finalizedPrescriptionId);
  if (!prescriptionId) {
    throw new SubmissionRepoError(
      "ML_SUBMISSION_FINALIZE_FAILED",
      500,
      "submission finalized without prescription",
    );
  }

  return {
    mode: "replayed",
    submissionId: submission.id,
    prescriptionId,
  };
}

function canClaimAnonymousDraft(
  submission: LockedSubmissionRow,
  actor: { role: ActorRole; wpUserId: number | null },
): boolean {
  return (
    submission.status === SUBMISSION_STATUS_DRAFT
    && submission.ownerRole === ActorRole.PATIENT
    && submission.ownerWpUserId == null
    && actor.role === ActorRole.PATIENT
    && actor.wpUserId != null
    && actor.wpUserId > 0
  );
}

function assertSubmissionOwnership(
  submission: LockedSubmissionRow,
  actor: { role: ActorRole; wpUserId: number | null },
): void {
  if (submission.ownerRole !== actor.role) {
    throw new SubmissionRepoError("ML_SUBMISSION_NOT_FOUND", 404, "submission not found");
  }

  if ((submission.ownerWpUserId ?? null) !== (actor.wpUserId ?? null)) {
    throw new SubmissionRepoError("ML_SUBMISSION_NOT_FOUND", 404, "submission not found");
  }
}

function normalizeSubmissionRef(value: unknown): string {
  if (typeof value !== "string") {
    throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, "submissionRef is required");
  }

  const normalized = value.trim();
  if (normalized === "" || normalized.length > 128 || !/^[A-Za-z0-9_-]{8,128}$/.test(normalized)) {
    throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, "submissionRef is invalid");
  }

  return normalized;
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

function normalizeOptionalRequestId(value: unknown): string | null {
  if (value == null || value === "") {
    return null;
  }

  if (typeof value !== "string") {
    throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, "reqId is invalid");
  }

  const normalized = value.trim();
  if (normalized === "" || normalized.length > 200) {
    throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, "reqId is invalid");
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

function buildDraftPublicRef(input: {
  flowKey: string;
  priority: string;
  idempotencyKey: string | null;
}): string {
  const hash = crypto.createHash("sha256");
  hash.update(ActorRole.PATIENT);
  hash.update(":");
  hash.update("draft");
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

function generatePublicUid(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(UID_LENGTH);
  let out = "";
  for (let i = 0; i < UID_LENGTH; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

function generateVerifyCode(): string {
  return String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
}

function generateVerifyToken(): string {
  return crypto.randomBytes(VERIFY_TOKEN_BYTES).toString("base64url");
}

function normalizeRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, `${field} is required`);
  }

  return value.trim();
}

function normalizeNullableString(value: unknown): string | null {
  if (value == null) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized === "" ? null : normalized;
}

function normalizeDateValue(value: unknown, field: string): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  const parsed = new Date(String(value ?? ""));
  if (Number.isNaN(parsed.getTime())) {
    throw new SubmissionRepoError("ML_SUBMISSION_FINALIZE_FAILED", 500, `${field} is invalid`);
  }

  return parsed;
}

function normalizeActorRoleValue(value: unknown): ActorRole {
  if (value === ActorRole.PATIENT || value === ActorRole.DOCTOR || value === ActorRole.SYSTEM) {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toUpperCase();
    if (normalized === ActorRole.PATIENT || normalized === ActorRole.DOCTOR || normalized === ActorRole.SYSTEM) {
      return normalized as ActorRole;
    }
  }

  throw new SubmissionRepoError("ML_SUBMISSION_FINALIZE_FAILED", 500, "submission ownerRole is invalid");
}

function normalizeSubmissionStatusValue(value: unknown): SubmissionStatus {
  if (
    value === SUBMISSION_STATUS_DRAFT
    || value === SubmissionStatus.OPEN
    || value === SubmissionStatus.FINALIZED
    || value === SubmissionStatus.EXPIRED
    || value === SubmissionStatus.CANCELLED
  ) {
    return value as SubmissionStatus;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toUpperCase();
    if (
      normalized === SUBMISSION_STATUS_DRAFT
      || normalized === SubmissionStatus.OPEN
      || normalized === SubmissionStatus.FINALIZED
      || normalized === SubmissionStatus.EXPIRED
      || normalized === SubmissionStatus.CANCELLED
    ) {
      return normalized as SubmissionStatus;
    }
  }

  throw new SubmissionRepoError("ML_SUBMISSION_FINALIZE_FAILED", 500, "submission status is invalid");
}

function normalizeNameRequired(value: unknown, field: string, maxLength: number): string {
  const normalized = normalizeCollapsedText(value, field, maxLength, false);
  if (looksLikeEmail(normalized)) {
    throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, `${field} must not be an email`);
  }
  return normalized;
}

function normalizeBirthDateRequired(value: unknown, field: string): string {
  if (value == null) {
    throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, `${field} is required`);
  }

  const raw = String(value).trim();
  if (raw === "") {
    throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, `${field} is required`);
  }

  const iso = parseBirthDateToIso(raw);
  if (!iso) {
    throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, `${field} is invalid`);
  }

  return iso;
}

function normalizeOptionalPlainText(value: unknown, maxLength: number): string | null {
  if (value == null) {
    return null;
  }

  const normalized = normalizeCollapsedText(value, "text", maxLength, true);
  return normalized === "" ? null : normalized;
}

function normalizeOptionalPlainTextUpdate(value: unknown, maxLength: number): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  return normalizeOptionalPlainText(value, maxLength);
}

function normalizeRequiredEmail(value: unknown, field: string): string {
  const normalized = normalizeOptionalEmail(value);
  if (normalized == null || normalized === "") {
    throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, `${field} is required`);
  }

  return normalized;
}

function normalizeOptionalEmail(value: unknown): string | null {
  if (value == null) {
    return null;
  }

  const raw = String(value).trim().toLowerCase();
  if (raw === "") {
    return null;
  }

  if (!looksLikeEmail(raw)) {
    throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, "patient.email is invalid");
  }

  return raw;
}

function normalizeOptionalEmailUpdate(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  return normalizeOptionalEmail(value);
}

function normalizeOptionalPhone(value: unknown): string | null {
  if (value == null) {
    return null;
  }

  const raw = String(value).replace(/\s+/gu, " ").trim();
  if (raw === "") {
    return null;
  }

  const sanitized = raw.replace(/[^0-9+().\-\s]/g, "").replace(/\s+/gu, " ").trim().slice(0, 40);
  return sanitized === "" ? null : sanitized;
}

function normalizeOptionalPhoneUpdate(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  return normalizeOptionalPhone(value);
}

function normalizeOptionalMetric(value: unknown, field: string, min: number, max: number): string | null {
  if (value == null) {
    return null;
  }

  const raw = String(value).trim();
  if (raw === "") {
    return null;
  }

  const normalized = raw.replace(/,/g, ".").replace(/[^0-9.]/g, "");
  if (normalized === "") {
    throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, `${field} is invalid`);
  }

  const parts = normalized.split(".");
  const collapsed = parts.length <= 1 ? normalized : `${parts.shift() ?? ""}.${parts.join("")}`;
  const parsed = Number(collapsed);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, `${field} is invalid`);
  }

  let stringified = parsed.toFixed(1);
  if (stringified.endsWith(".0")) {
    stringified = stringified.slice(0, -2);
  }

  return stringified;
}

function normalizeOptionalMetricUpdate(value: unknown, field: string, min: number, max: number): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  return normalizeOptionalMetric(value, field, min, max);
}

function normalizeCollapsedText(value: unknown, field: string, maxLength: number, allowEmpty: boolean): string {
  const normalized = String(value == null ? "" : value)
    .replace(/\s+/gu, " ")
    .trim();

  if (normalized === "") {
    if (allowEmpty) {
      return "";
    }
    throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, `${field} is required`);
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

function normalizeNullableNotes(value: unknown): string | null {
  if (value == null) {
    return null;
  }

  const normalized = String(value)
    .replace(/\s+/gu, " ")
    .trim();

  return normalized === "" ? null : normalized.slice(0, MAX_PRIVATE_NOTES_LENGTH);
}

function normalizeOptionalNotesUpdate(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  return normalizeNullableNotes(value);
}

function pickFirstDefined<T>(...values: T[]): T | undefined {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function toInputJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
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

function isFinalizeRetryableUniqueError(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) {
    return false;
  }

  if (err.code !== "P2002") {
    return false;
  }

  const target = extractUniqueTargetFields(err.meta?.target);
  return target.includes("uid") || target.includes("verifyToken");
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

function wrapSubmissionRepoError(
  err: unknown,
  code: string,
  statusCode: number,
  fallbackMessage: string,
): SubmissionRepoError {
  if (err instanceof SubmissionRepoError) {
    return err;
  }

  return new SubmissionRepoError(
    code,
    statusCode,
    err instanceof Error ? err.message : fallbackMessage,
    { cause: err instanceof Error ? err : undefined },
  );
}
