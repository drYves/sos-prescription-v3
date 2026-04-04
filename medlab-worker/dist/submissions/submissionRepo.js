"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SubmissionRepo = exports.SubmissionRepoError = void 0;
// src/submissions/submissionRepo.ts
const node_crypto_1 = __importDefault(require("node:crypto"));
const client_1 = require("@prisma/client");
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
let prismaSingleton = null;
class SubmissionRepoError extends Error {
    code;
    statusCode;
    constructor(code, statusCode, message) {
        super(message);
        this.name = "SubmissionRepoError";
        this.code = code;
        this.statusCode = statusCode;
    }
}
exports.SubmissionRepoError = SubmissionRepoError;
class SubmissionRepo {
    prisma;
    logger;
    ttlMs;
    constructor(cfg = {}) {
        this.prisma = getPrismaClient();
        this.logger = cfg.logger;
        this.ttlMs = normalizeTtlMs(cfg.ttlMs);
    }
    async createSubmission(input) {
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
                        status: client_1.SubmissionStatus.OPEN,
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
            }
            catch (err) {
                if (isUniquePublicRefError(err)) {
                    if (deterministicPublicRef) {
                        const existing = await this.prisma.submission.findUnique({
                            where: { publicRef: deterministicPublicRef },
                            select: submissionSelect(),
                        });
                        if (existing) {
                            return await resolveExistingCreateSubmission(this.prisma, existing, this.logger, normalized.reqId);
                        }
                    }
                    else {
                        publicRef = generateRandomPublicRef();
                        continue;
                    }
                }
                this.logger?.error("submission.finalize.rejected", {
                    phase: "create",
                    code: "ML_SUBMISSION_CREATE_FAILED",
                    reason: err instanceof Error ? err.message : "submission_create_failed",
                }, normalized.reqId ?? undefined, err);
                throw wrapSubmissionRepoError(err, "ML_SUBMISSION_CREATE_FAILED", 500, "submission_create_failed");
            }
        }
        throw new SubmissionRepoError("ML_SUBMISSION_CREATE_FAILED", 500, "Unable to allocate a unique submission reference");
    }
    async finalizeSubmission(input) {
        const normalized = normalizeFinalizeSubmissionInput(input);
        for (let attempt = 1; attempt <= MAX_FINALIZE_ATTEMPTS; attempt += 1) {
            try {
                const result = await this.prisma.$transaction(async (tx) => {
                    const submission = await lockSubmissionByPublicRef(tx, normalized.submissionRef);
                    if (!submission) {
                        throw new SubmissionRepoError("ML_SUBMISSION_NOT_FOUND", 404, "submission not found");
                    }
                    assertSubmissionOwnership(submission, normalized.actor);
                    if (submission.status === client_1.SubmissionStatus.FINALIZED) {
                        return replayFinalizedSubmission(tx, submission);
                    }
                    if (submission.status === client_1.SubmissionStatus.EXPIRED || submission.expiresAt.getTime() <= Date.now()) {
                        if (submission.status === client_1.SubmissionStatus.OPEN) {
                            await tx.submission.update({
                                where: { id: submission.id },
                                data: { status: client_1.SubmissionStatus.EXPIRED },
                            });
                        }
                        this.logger?.warning("submission.expired", {
                            phase: "finalize",
                            submission_ref: normalized.submissionRef,
                            submission_id: submission.id,
                            owner_role: submission.ownerRole,
                            owner_wp_user_id: submission.ownerWpUserId,
                        }, normalized.reqId ?? undefined);
                        throw new SubmissionRepoError("ML_SUBMISSION_EXPIRED", 410, "submission expired");
                    }
                    if (submission.status !== client_1.SubmissionStatus.OPEN) {
                        throw new SubmissionRepoError("ML_SUBMISSION_NOT_OPEN", 409, "submission is not open");
                    }
                    const patientWpUserId = normalized.actor.role === client_1.ActorRole.PATIENT
                        ? normalized.actor.wpUserId
                        : null;
                    const patient = patientWpUserId != null
                        ? await tx.patient.upsert({
                            where: { wpUserId: patientWpUserId },
                            update: buildPatientWriteData(normalized.patient),
                            create: {
                                wpUserId: patientWpUserId,
                                ...buildPatientWriteData(normalized.patient),
                            },
                            select: { id: true },
                        })
                        : await tx.patient.create({
                            data: {
                                wpUserId: null,
                                ...buildPatientWriteData(normalized.patient),
                            },
                            select: { id: true },
                        });
                    const createdPrescription = await tx.prescription.create({
                        data: {
                            uid: generatePublicUid(),
                            doctorId: null,
                            patientId: patient.id,
                            status: "PENDING",
                            items: toInputJsonValue(normalized.items),
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
                        select: finalizedPrescriptionSelect(),
                    });
                    await tx.artifact.updateMany({
                        where: {
                            submissionId: submission.id,
                            deletedAt: null,
                        },
                        data: {
                            prescriptionId: createdPrescription.id,
                            linkedAt: new Date(),
                        },
                    });
                    const proofCount = await tx.artifact.count({
                        where: {
                            prescriptionId: createdPrescription.id,
                            kind: client_1.ArtifactKind.PROOF,
                            status: client_1.ArtifactStatus.READY,
                            deletedAt: null,
                        },
                    });
                    const updatedPrescription = await tx.prescription.update({
                        where: { id: createdPrescription.id },
                        data: {
                            hasProof: proofCount > 0,
                            proofCount,
                        },
                        select: finalizedPrescriptionSelect(),
                    });
                    const updatedSubmission = await tx.submission.update({
                        where: { id: submission.id },
                        data: {
                            status: client_1.SubmissionStatus.FINALIZED,
                            finalizedPrescriptionId: updatedPrescription.id,
                        },
                        select: submissionSelect(),
                    });
                    return buildFinalizeResult("created", updatedSubmission, updatedPrescription);
                }, {
                    maxWait: TX_MAX_WAIT_MS,
                    timeout: TX_TIMEOUT_MS,
                });
                return result;
            }
            catch (err) {
                if (isFinalizeRetryableUniqueError(err)) {
                    continue;
                }
                if (err instanceof SubmissionRepoError) {
                    throw err;
                }
                this.logger?.error("submission.finalize.rejected", {
                    phase: "finalize",
                    code: "ML_SUBMISSION_FINALIZE_FAILED",
                    submission_ref: normalized.submissionRef,
                    reason: err instanceof Error ? err.message : "submission_finalize_failed",
                }, normalized.reqId ?? undefined, err);
                throw wrapSubmissionRepoError(err, "ML_SUBMISSION_FINALIZE_FAILED", 500, "submission_finalize_failed");
            }
        }
        throw new SubmissionRepoError("ML_SUBMISSION_FINALIZE_FAILED", 500, "Unable to allocate unique prescription references");
    }
}
exports.SubmissionRepo = SubmissionRepo;
function getPrismaClient() {
    if (!prismaSingleton) {
        prismaSingleton = new client_1.PrismaClient();
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
    };
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
    };
}
function mapSubmission(row) {
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
function mapFinalizedPrescription(row) {
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
function buildFinalizeResult(mode, submission, prescription) {
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
async function resolveExistingCreateSubmission(prisma, existing, logger, reqId) {
    if (existing.status === client_1.SubmissionStatus.OPEN && existing.expiresAt.getTime() > Date.now()) {
        return {
            mode: "replayed",
            submission: mapSubmission(existing),
        };
    }
    if (existing.status === client_1.SubmissionStatus.EXPIRED || existing.expiresAt.getTime() <= Date.now()) {
        if (existing.status === client_1.SubmissionStatus.OPEN) {
            await prisma.submission.updateMany({
                where: {
                    id: existing.id,
                    status: client_1.SubmissionStatus.OPEN,
                },
                data: {
                    status: client_1.SubmissionStatus.EXPIRED,
                },
            });
        }
        logger?.warning("submission.expired", {
            phase: "create",
            submission_ref: existing.publicRef,
            submission_id: existing.id,
            owner_role: existing.ownerRole,
            owner_wp_user_id: existing.ownerWpUserId,
        }, reqId ?? undefined);
        throw new SubmissionRepoError("ML_SUBMISSION_EXPIRED", 410, "submission expired");
    }
    throw new SubmissionRepoError("ML_SUBMISSION_NOT_OPEN", 409, "submission is not open");
}
function normalizeCreateSubmissionInput(input) {
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
function normalizeFinalizeSubmissionInput(input) {
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
function normalizeActor(input) {
    if (!input || typeof input !== "object") {
        throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, "actor is required");
    }
    if (![client_1.ActorRole.PATIENT, client_1.ActorRole.DOCTOR, client_1.ActorRole.SYSTEM].includes(input.role)) {
        throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, "actor.role is invalid");
    }
    const wpUserId = normalizeNullablePositiveInt(input.wpUserId);
    if (input.role !== client_1.ActorRole.SYSTEM && wpUserId == null) {
        throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, "actor.wpUserId is required");
    }
    return {
        role: input.role,
        wpUserId,
    };
}
function normalizeFinalizePatientInput(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, "patient is required");
    }
    return {
        firstName: normalizeNameRequired(pickFirstDefined(value.firstName, value.first_name), "patient.firstName", 100),
        lastName: normalizeNameRequired(pickFirstDefined(value.lastName, value.last_name), "patient.lastName", 120),
        birthDate: normalizeBirthDateRequired(pickFirstDefined(value.birthDate, value.birthdate), "patient.birthDate"),
        gender: normalizeOptionalPlainText(pickFirstDefined(value.gender), 32),
        email: normalizeOptionalEmail(pickFirstDefined(value.email)),
        phone: normalizeOptionalPhone(pickFirstDefined(value.phone)),
        weightKg: normalizeOptionalMetric(pickFirstDefined(value.weightKg, value.weight_kg), "patient.weightKg", 1, 500),
        heightCm: normalizeOptionalMetric(pickFirstDefined(value.heightCm, value.height_cm), "patient.heightCm", 30, 300),
    };
}
function buildPatientWriteData(patient) {
    return {
        firstName: patient.firstName,
        lastName: patient.lastName,
        birthDate: patient.birthDate,
        gender: patient.gender,
        email: patient.email,
        phone: patient.phone,
        weightKg: patient.weightKg,
        heightCm: patient.heightCm,
    };
}
async function lockSubmissionByPublicRef(tx, submissionRef) {
    const rows = await tx.$queryRaw(client_1.Prisma.sql `
    SELECT
      "id",
      "publicRef",
      "ownerRole",
      "ownerWpUserId",
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
function mapLockedSubmissionRow(row) {
    const ownerRole = normalizeActorRoleValue(row.ownerRole);
    const status = normalizeSubmissionStatusValue(row.status);
    return {
        id: normalizeRequiredString(row.id, "submission.id"),
        publicRef: normalizeRequiredString(row.publicRef, "submission.publicRef"),
        ownerRole,
        ownerWpUserId: normalizeNullablePositiveInt(row.ownerWpUserId),
        status,
        flowKey: normalizeRequiredString(row.flowKey, "submission.flowKey"),
        priority: normalizeRequiredString(row.priority, "submission.priority"),
        expiresAt: normalizeDateValue(row.expiresAt, "submission.expiresAt"),
        finalizedPrescriptionId: normalizeNullableString(row.finalizedPrescriptionId),
        createdAt: normalizeDateValue(row.createdAt, "submission.createdAt"),
        updatedAt: normalizeDateValue(row.updatedAt, "submission.updatedAt"),
    };
}
async function replayFinalizedSubmission(tx, submission) {
    const prescriptionId = normalizeNullableString(submission.finalizedPrescriptionId);
    if (!prescriptionId) {
        throw new SubmissionRepoError("ML_SUBMISSION_FINALIZE_FAILED", 500, "submission finalized without prescription");
    }
    const prescription = await tx.prescription.findUnique({
        where: { id: prescriptionId },
        select: finalizedPrescriptionSelect(),
    });
    if (!prescription) {
        throw new SubmissionRepoError("ML_SUBMISSION_FINALIZE_FAILED", 500, "finalized prescription is missing");
    }
    const replayedSubmission = await tx.submission.findUnique({
        where: { id: submission.id },
        select: submissionSelect(),
    });
    if (!replayedSubmission) {
        throw new SubmissionRepoError("ML_SUBMISSION_NOT_FOUND", 404, "submission not found");
    }
    return buildFinalizeResult("replayed", replayedSubmission, prescription);
}
function assertSubmissionOwnership(submission, actor) {
    if (submission.ownerRole !== actor.role) {
        throw new SubmissionRepoError("ML_SUBMISSION_NOT_FOUND", 404, "submission not found");
    }
    if ((submission.ownerWpUserId ?? null) !== (actor.wpUserId ?? null)) {
        throw new SubmissionRepoError("ML_SUBMISSION_NOT_FOUND", 404, "submission not found");
    }
}
function normalizeSubmissionRef(value) {
    if (typeof value !== "string") {
        throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, "submissionRef is required");
    }
    const normalized = value.trim();
    if (normalized === "" || normalized.length > 128 || !/^[A-Za-z0-9_-]{8,128}$/.test(normalized)) {
        throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, "submissionRef is invalid");
    }
    return normalized;
}
function normalizeSlug(value, field, maxLength) {
    if (typeof value !== "string") {
        throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, `${field} is required`);
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === "" || normalized.length > maxLength || !/^[a-z0-9][a-z0-9_-]*$/.test(normalized)) {
        throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, `${field} is invalid`);
    }
    return normalized;
}
function normalizeIdempotencyKey(value) {
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
function normalizeOptionalRequestId(value) {
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
function normalizeNullablePositiveInt(value) {
    if (value == null || value === "") {
        return null;
    }
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, "actor.wpUserId is invalid");
    }
    return Math.trunc(parsed);
}
function normalizeTtlMs(value) {
    if (value == null || value === "") {
        return DEFAULT_SUBMISSION_TTL_MS;
    }
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return DEFAULT_SUBMISSION_TTL_MS;
    }
    return Math.max(60_000, Math.trunc(parsed));
}
function buildIdempotentPublicRef(input) {
    const hash = node_crypto_1.default.createHash("sha256");
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
function generateRandomPublicRef() {
    return `${RANDOM_PUBLIC_REF_PREFIX}${node_crypto_1.default.randomBytes(RANDOM_PUBLIC_REF_BYTES).toString("hex")}`;
}
function generatePublicUid() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = node_crypto_1.default.randomBytes(UID_LENGTH);
    let out = "";
    for (let i = 0; i < UID_LENGTH; i += 1) {
        out += alphabet[bytes[i] % alphabet.length];
    }
    return out;
}
function generateVerifyCode() {
    return String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
}
function generateVerifyToken() {
    return node_crypto_1.default.randomBytes(VERIFY_TOKEN_BYTES).toString("base64url");
}
function normalizeRequiredString(value, field) {
    if (typeof value !== "string" || value.trim() === "") {
        throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, `${field} is required`);
    }
    return value.trim();
}
function normalizeNullableString(value) {
    if (value == null) {
        return null;
    }
    const normalized = String(value).trim();
    return normalized === "" ? null : normalized;
}
function normalizeDateValue(value, field) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value;
    }
    const parsed = new Date(String(value ?? ""));
    if (Number.isNaN(parsed.getTime())) {
        throw new SubmissionRepoError("ML_SUBMISSION_FINALIZE_FAILED", 500, `${field} is invalid`);
    }
    return parsed;
}
function normalizeActorRoleValue(value) {
    if (value === client_1.ActorRole.PATIENT || value === client_1.ActorRole.DOCTOR || value === client_1.ActorRole.SYSTEM) {
        return value;
    }
    if (typeof value === "string") {
        const normalized = value.trim().toUpperCase();
        if (normalized === client_1.ActorRole.PATIENT || normalized === client_1.ActorRole.DOCTOR || normalized === client_1.ActorRole.SYSTEM) {
            return normalized;
        }
    }
    throw new SubmissionRepoError("ML_SUBMISSION_FINALIZE_FAILED", 500, "submission ownerRole is invalid");
}
function normalizeSubmissionStatusValue(value) {
    if (value === client_1.SubmissionStatus.OPEN
        || value === client_1.SubmissionStatus.FINALIZED
        || value === client_1.SubmissionStatus.EXPIRED
        || value === client_1.SubmissionStatus.CANCELLED) {
        return value;
    }
    if (typeof value === "string") {
        const normalized = value.trim().toUpperCase();
        if (normalized === client_1.SubmissionStatus.OPEN
            || normalized === client_1.SubmissionStatus.FINALIZED
            || normalized === client_1.SubmissionStatus.EXPIRED
            || normalized === client_1.SubmissionStatus.CANCELLED) {
            return normalized;
        }
    }
    throw new SubmissionRepoError("ML_SUBMISSION_FINALIZE_FAILED", 500, "submission status is invalid");
}
function normalizeNameRequired(value, field, maxLength) {
    const normalized = normalizeCollapsedText(value, field, maxLength, false);
    if (looksLikeEmail(normalized)) {
        throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, `${field} must not be an email`);
    }
    return normalized;
}
function normalizeBirthDateRequired(value, field) {
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
function normalizeOptionalPlainText(value, maxLength) {
    if (value == null) {
        return null;
    }
    const normalized = normalizeCollapsedText(value, "text", maxLength, true);
    return normalized === "" ? null : normalized;
}
function normalizeOptionalEmail(value) {
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
function normalizeOptionalPhone(value) {
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
function normalizeOptionalMetric(value, field, min, max) {
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
function normalizeCollapsedText(value, field, maxLength, allowEmpty) {
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
function looksLikeEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).trim());
}
function parseBirthDateToIso(value) {
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
function isValidIsoDateParts(year, month, day) {
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
function normalizeNullableNotes(value) {
    if (value == null) {
        return null;
    }
    const normalized = String(value)
        .replace(/\s+/gu, " ")
        .trim();
    return normalized === "" ? null : normalized.slice(0, MAX_PRIVATE_NOTES_LENGTH);
}
function pickFirstDefined(...values) {
    for (const value of values) {
        if (value !== undefined) {
            return value;
        }
    }
    return undefined;
}
function toInputJsonValue(value) {
    return JSON.parse(JSON.stringify(value));
}
function isUniquePublicRefError(err) {
    if (!(err instanceof client_1.Prisma.PrismaClientKnownRequestError)) {
        return false;
    }
    if (err.code !== "P2002") {
        return false;
    }
    const target = extractUniqueTargetFields(err.meta?.target);
    return target.includes("publicRef");
}
function isFinalizeRetryableUniqueError(err) {
    if (!(err instanceof client_1.Prisma.PrismaClientKnownRequestError)) {
        return false;
    }
    if (err.code !== "P2002") {
        return false;
    }
    const target = extractUniqueTargetFields(err.meta?.target);
    return target.includes("uid") || target.includes("verifyToken");
}
function extractUniqueTargetFields(target) {
    if (Array.isArray(target)) {
        return target
            .filter((value) => typeof value === "string" && value.trim() !== "")
            .map((value) => value.trim());
    }
    if (typeof target === "string" && target.trim() !== "") {
        return [target.trim()];
    }
    return [];
}
function wrapSubmissionRepoError(err, code, statusCode, fallbackMessage) {
    if (err instanceof SubmissionRepoError) {
        return err;
    }
    return new SubmissionRepoError(code, statusCode, err instanceof Error ? err.message : fallbackMessage);
}
