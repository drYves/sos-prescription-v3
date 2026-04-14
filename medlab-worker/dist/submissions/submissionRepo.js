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
const SUBMISSION_STATUS_DRAFT = "DRAFT";
let prismaSingleton = null;
class SubmissionRepoError extends Error {
    code;
    statusCode;
    constructor(code, statusCode, message, options = {}) {
        super(message);
        this.name = "SubmissionRepoError";
        this.code = code;
        this.statusCode = statusCode;
        if (options.cause !== undefined) {
            this.cause = options.cause;
        }
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
    async createDraftSubmission(input) {
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
                        ownerRole: client_1.ActorRole.PATIENT,
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
            }
            catch (err) {
                if (isUniquePublicRefError(err)) {
                    if (deterministicPublicRef) {
                        const existing = await this.prisma.submission.findUnique({
                            where: { publicRef: deterministicPublicRef },
                            select: submissionSelect(),
                        });
                        if (existing) {
                            return await resolveExistingDraftSubmission(this.prisma, existing, normalized.email, this.logger, normalized.reqId);
                        }
                    }
                    else {
                        publicRef = generateRandomPublicRef();
                        continue;
                    }
                }
                this.logger?.error("submission.finalize.rejected", {
                    phase: "create_draft",
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
                const outcome = await this.prisma.$transaction(async (tx) => {
                    let submission = await lockSubmissionByPublicRef(tx, normalized.submissionRef);
                    if (!submission) {
                        throw new SubmissionRepoError("ML_SUBMISSION_NOT_FOUND", 404, "submission not found");
                    }
                    if (submission.status === client_1.SubmissionStatus.FINALIZED) {
                        return replayFinalizedSubmissionOutcome(submission);
                    }
                    if (submission.status === client_1.SubmissionStatus.EXPIRED || submission.expiresAt.getTime() <= Date.now()) {
                        if (submission.status === client_1.SubmissionStatus.OPEN || submission.status === SUBMISSION_STATUS_DRAFT) {
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
                    if (submission.status !== client_1.SubmissionStatus.OPEN && submission.status !== SUBMISSION_STATUS_DRAFT) {
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
                    const patientWpUserId = normalized.actor.role === client_1.ActorRole.PATIENT
                        ? normalized.actor.wpUserId
                        : null;
                    const submissionEmail = normalizeOptionalEmail(submission.email);
                    const sealedPatientEmail = normalized.patient.email == null
                        ? (submissionEmail ?? null)
                        : normalized.patient.email;
                    const effectivePatient = {
                        ...normalized.patient,
                        email: sealedPatientEmail ?? undefined,
                    };
                    const patient = await ensurePatientForFinalize(tx, {
                        wpUserId: patientWpUserId,
                        patient: effectivePatient,
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
                        select: { id: true },
                    });
                    await tx.submission.update({
                        where: { id: submission.id },
                        data: {
                            ownerWpUserId: patientWpUserId ?? submission.ownerWpUserId ?? null,
                            email: sealedPatientEmail,
                            status: client_1.SubmissionStatus.FINALIZED,
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
                        mode: "created",
                        submissionId: submission.id,
                        prescriptionId: createdPrescription.id,
                    };
                }, {
                    maxWait: TX_MAX_WAIT_MS,
                    timeout: TX_TIMEOUT_MS,
                });
                await syncSubmissionArtifactsToPrescription(this.prisma, outcome.submissionId, outcome.prescriptionId);
                return await readFinalizeSubmissionResult(this.prisma, outcome.mode, outcome.submissionId, outcome.prescriptionId);
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
        email: true,
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
async function syncSubmissionArtifactsToPrescription(prisma, submissionId, prescriptionId) {
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
            kind: client_1.ArtifactKind.PROOF,
            status: client_1.ArtifactStatus.READY,
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
async function readFinalizeSubmissionResult(prisma, mode, submissionId, prescriptionId) {
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
        throw new SubmissionRepoError("ML_SUBMISSION_FINALIZE_FAILED", 500, "finalized prescription is missing");
    }
    return buildFinalizeResult(mode, submission, prescription);
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
async function resolveExistingDraftSubmission(prisma, existing, email, logger, reqId) {
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
    if (existing.status === client_1.SubmissionStatus.EXPIRED || existing.expiresAt.getTime() <= Date.now()) {
        if (existing.status === SUBMISSION_STATUS_DRAFT) {
            await prisma.submission.updateMany({
                where: {
                    id: existing.id,
                    status: SUBMISSION_STATUS_DRAFT,
                },
                data: {
                    status: client_1.SubmissionStatus.EXPIRED,
                },
            });
        }
        logger?.warning("submission.expired", {
            phase: "create_draft",
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
function normalizeCreateDraftSubmissionInput(input) {
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
        gender: normalizeOptionalPlainTextUpdate(pickFirstDefined(value.gender), 32),
        email: normalizeOptionalEmailUpdate(pickFirstDefined(value.email)),
        phone: normalizeOptionalPhoneUpdate(pickFirstDefined(value.phone)),
        weightKg: normalizeOptionalMetricUpdate(pickFirstDefined(value.weightKg, value.weight_kg), "patient.weightKg", 1, 500),
        heightCm: normalizeOptionalMetricUpdate(pickFirstDefined(value.heightCm, value.height_cm), "patient.heightCm", 30, 300),
        note: normalizeOptionalNotesUpdate(pickFirstDefined(value.note, value.medical_notes, value.medicalNotes)),
    };
}
function buildPatientCreateData(patient) {
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
function buildPatientUpdateData(patient) {
    const data = {
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
async function sealPatientIdentityAfterFinalize(tx, input) {
    const normalizedPatient = {
        ...input.patient,
        email: input.email ?? input.patient.email ?? undefined,
    };
    const data = {
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
    }
    else {
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
        }
        else if (input.email) {
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
            }
            else {
                await tx.patient.create({
                    data: {
                        wpUserId: input.wpUserId,
                        ...buildPatientCreateData(normalizedPatient),
                    },
                    select: { id: true },
                });
            }
        }
        else {
            await tx.patient.create({
                data: {
                    wpUserId: input.wpUserId,
                    ...buildPatientCreateData(normalizedPatient),
                },
                select: { id: true },
            });
        }
    }
    const submissionIdentityData = {};
    if (input.wpUserId != null) {
        submissionIdentityData.ownerWpUserId = input.wpUserId;
    }
    if (input.email) {
        submissionIdentityData.email = input.email;
    }
    if (Object.keys(submissionIdentityData).length > 0) {
        const submissionIdentityClauses = [
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
                ownerRole: client_1.ActorRole.PATIENT,
                OR: submissionIdentityClauses,
            },
            data: submissionIdentityData,
        });
    }
}
async function ensurePatientForFinalize(tx, input) {
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
            const data = {
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
async function lockSubmissionByPublicRef(tx, submissionRef) {
    const rows = await tx.$queryRaw(client_1.Prisma.sql `
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
function mapLockedSubmissionRow(row) {
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
function replayFinalizedSubmissionOutcome(submission) {
    const prescriptionId = normalizeNullableString(submission.finalizedPrescriptionId);
    if (!prescriptionId) {
        throw new SubmissionRepoError("ML_SUBMISSION_FINALIZE_FAILED", 500, "submission finalized without prescription");
    }
    return {
        mode: "replayed",
        submissionId: submission.id,
        prescriptionId,
    };
}
function canClaimAnonymousDraft(submission, actor) {
    return (submission.status === SUBMISSION_STATUS_DRAFT
        && submission.ownerRole === client_1.ActorRole.PATIENT
        && submission.ownerWpUserId == null
        && actor.role === client_1.ActorRole.PATIENT
        && actor.wpUserId != null
        && actor.wpUserId > 0);
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
function buildDraftPublicRef(input) {
    const hash = node_crypto_1.default.createHash("sha256");
    hash.update(client_1.ActorRole.PATIENT);
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
    if (value === SUBMISSION_STATUS_DRAFT
        || value === client_1.SubmissionStatus.OPEN
        || value === client_1.SubmissionStatus.FINALIZED
        || value === client_1.SubmissionStatus.EXPIRED
        || value === client_1.SubmissionStatus.CANCELLED) {
        return value;
    }
    if (typeof value === "string") {
        const normalized = value.trim().toUpperCase();
        if (normalized === SUBMISSION_STATUS_DRAFT
            || normalized === client_1.SubmissionStatus.OPEN
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
function normalizeOptionalPlainTextUpdate(value, maxLength) {
    if (value === undefined) {
        return undefined;
    }
    return normalizeOptionalPlainText(value, maxLength);
}
function normalizeRequiredEmail(value, field) {
    const normalized = normalizeOptionalEmail(value);
    if (normalized == null || normalized === "") {
        throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, `${field} is required`);
    }
    return normalized;
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
function normalizeOptionalEmailUpdate(value) {
    if (value === undefined) {
        return undefined;
    }
    return normalizeOptionalEmail(value);
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
function normalizeOptionalPhoneUpdate(value) {
    if (value === undefined) {
        return undefined;
    }
    return normalizeOptionalPhone(value);
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
function normalizeOptionalMetricUpdate(value, field, min, max) {
    if (value === undefined) {
        return undefined;
    }
    return normalizeOptionalMetric(value, field, min, max);
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
function normalizeOptionalNotesUpdate(value) {
    if (value === undefined) {
        return undefined;
    }
    return normalizeNullableNotes(value);
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
    return new SubmissionRepoError(code, statusCode, err instanceof Error ? err.message : fallbackMessage, { cause: err instanceof Error ? err : undefined });
}
