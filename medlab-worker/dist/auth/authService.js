"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthService = exports.AuthServiceError = void 0;
const node_crypto_1 = __importDefault(require("node:crypto"));
const client_1 = require("@prisma/client");
const DEFAULT_MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
const MIN_MAGIC_LINK_TTL_MS = 60 * 1000;
const MAX_MAGIC_LINK_TTL_MS = 24 * 60 * 60 * 1000;
const MAGIC_LINK_TOKEN_BYTES = 32;
const MAX_TOKEN_GENERATION_ATTEMPTS = 5;
const MAX_META_JSON_BYTES = 4_096;
let prismaSingleton = null;
class AuthServiceError extends Error {
    code;
    statusCode;
    constructor(code, statusCode, message, options) {
        super(message, options);
        this.name = "AuthServiceError";
        this.code = code;
        this.statusCode = statusCode;
    }
}
exports.AuthServiceError = AuthServiceError;
class AuthService {
    prisma;
    logger;
    ttlMs;
    constructor(cfg = {}) {
        this.prisma = getPrismaClient();
        this.logger = cfg.logger;
        this.ttlMs = clampPositiveInt(cfg.ttlMs ?? DEFAULT_MAGIC_LINK_TTL_MS, MIN_MAGIC_LINK_TTL_MS, MAX_MAGIC_LINK_TTL_MS);
    }
    async lookupOwnerByEmail(input, reqId) {
        const email = normalizeEmail(input);
        if (email === "") {
            throw new AuthServiceError("ML_MAGIC_LINK_BAD_REQUEST", 400, "email is invalid");
        }
        try {
            const [doctor, patientRows, submissionRows] = await Promise.all([
                this.prisma.doctor.findFirst({
                    where: {
                        email: { equals: email, mode: "insensitive" },
                        deletedAt: null,
                        wpUserId: { not: null },
                    },
                    select: {
                        wpUserId: true,
                    },
                }),
                this.prisma.patient.findMany({
                    where: {
                        email: { equals: email, mode: "insensitive" },
                        deletedAt: null,
                    },
                    select: {
                        id: true,
                        wpUserId: true,
                    },
                    orderBy: {
                        updatedAt: "desc",
                    },
                    take: 10,
                }),
                this.prisma.submission.findMany({
                    where: {
                        ownerRole: client_1.ActorRole.PATIENT,
                        email: { equals: email, mode: "insensitive" },
                    },
                    orderBy: {
                        createdAt: "desc",
                    },
                    take: 10,
                    select: {
                        publicRef: true,
                        ownerWpUserId: true,
                        status: true,
                        createdAt: true,
                        expiresAt: true,
                        finalizedPrescriptionId: true,
                    },
                }),
            ]);
            const doctorWpUserId = doctor?.wpUserId ?? null;
            const patientWpUserIds = uniquePositiveInts(patientRows.map((row) => row.wpUserId));
            const hasPendingPatientMatch = patientRows.some((row) => normalizeNullablePositiveInt(row.wpUserId) == null);
            const submissionWpUserIds = uniquePositiveInts(submissionRows.map((row) => row.ownerWpUserId));
            const latestSubmission = submissionRows[0] ?? null;
            const latestOwnedSubmission = submissionRows.find((row) => normalizeNullablePositiveInt(row.ownerWpUserId) != null) ?? null;
            const activeDraftSubmission = submissionRows.find((row) => (row.status === client_1.SubmissionStatus.DRAFT
                && row.finalizedPrescriptionId == null
                && row.expiresAt.getTime() > Date.now())) ?? null;
            const activeDraftMetadata = activeDraftSubmission
                ? { draft_ref: activeDraftSubmission.publicRef }
                : null;
            const resolvedSubmissionOwnerWpUserId = latestOwnedSubmission
                ? normalizeNullablePositiveInt(latestOwnedSubmission.ownerWpUserId)
                : null;
            if (patientWpUserIds.length > 1) {
                this.logger?.warning("auth.magic_link.lookup_ambiguous", {
                    email_fp: fingerprint(email),
                    match_type: "multiple_patients",
                    patient_match_count: patientWpUserIds.length,
                }, reqId);
                return { status: "ambiguous" };
            }
            if (submissionWpUserIds.length > 1) {
                this.logger?.warning("auth.magic_link.lookup_ambiguous", {
                    email_fp: fingerprint(email),
                    match_type: "multiple_submission_owners",
                    submission_match_count: submissionRows.length,
                    submission_owner_match_count: submissionWpUserIds.length,
                }, reqId);
                return { status: "ambiguous" };
            }
            if (doctorWpUserId != null && doctorWpUserId > 0) {
                const conflictingPatientWpUserIds = patientWpUserIds.filter((wpUserId) => wpUserId !== doctorWpUserId);
                const conflictingSubmissionWpUserIds = submissionWpUserIds.filter((wpUserId) => wpUserId !== doctorWpUserId);
                if (conflictingPatientWpUserIds.length > 0 || conflictingSubmissionWpUserIds.length > 0 || hasPendingPatientMatch || submissionRows.length > 0) {
                    this.logger?.warning("auth.magic_link.lookup_ambiguous", {
                        email_fp: fingerprint(email),
                        match_type: "doctor_and_patient_conflict",
                        doctor_wp_user_id: doctorWpUserId,
                        patient_match_count: patientRows.length,
                        submission_match_count: submissionRows.length,
                    }, reqId);
                    return { status: "ambiguous" };
                }
            }
            if (patientWpUserIds.length === 1) {
                return {
                    status: "matched",
                    candidate: {
                        email,
                        ownerRole: client_1.ActorRole.PATIENT,
                        ownerWpUserId: patientWpUserIds[0],
                        metadata: activeDraftMetadata,
                    },
                };
            }
            if (submissionRows.length > 0) {
                this.logger?.info(activeDraftSubmission
                    ? "auth.magic_link.lookup_matched_draft"
                    : "auth.magic_link.lookup_matched_submission", {
                    email_fp: fingerprint(email),
                    owner_wp_user_id: resolvedSubmissionOwnerWpUserId,
                    submission_ref: activeDraftSubmission?.publicRef ?? latestSubmission?.publicRef ?? null,
                    has_active_draft: activeDraftSubmission != null,
                }, reqId);
                return {
                    status: "matched",
                    candidate: {
                        email,
                        ownerRole: client_1.ActorRole.PATIENT,
                        ownerWpUserId: resolvedSubmissionOwnerWpUserId,
                        metadata: activeDraftMetadata,
                    },
                };
            }
            if (hasPendingPatientMatch) {
                return {
                    status: "matched",
                    candidate: {
                        email,
                        ownerRole: client_1.ActorRole.PATIENT,
                        ownerWpUserId: null,
                        metadata: null,
                    },
                };
            }
            if (doctorWpUserId != null && doctorWpUserId > 0) {
                return {
                    status: "matched",
                    candidate: {
                        email,
                        ownerRole: client_1.ActorRole.DOCTOR,
                        ownerWpUserId: doctorWpUserId,
                    },
                };
            }
            return { status: "not_found" };
        }
        catch (err) {
            this.logger?.error("auth.magic_link.lookup_failed", {
                email_fp: fingerprint(email),
                reason: err instanceof Error ? err.message : "auth_lookup_failed",
            }, reqId, err);
            throw new AuthServiceError("ML_MAGIC_LINK_LOOKUP_FAILED", 500, "magic_link_lookup_failed", { cause: err instanceof Error ? err : undefined });
        }
    }
    async issueMagicLink(input, reqId) {
        const email = normalizeEmail(input.email);
        const ownerRole = normalizeOwnerRole(input.ownerRole);
        const ownerWpUserId = normalizeOwnerWpUserId(input.ownerWpUserId ?? null, ownerRole);
        const metadata = normalizeMagicLinkMetadata(input.metadata ?? null);
        if (email === "") {
            throw new AuthServiceError("ML_MAGIC_LINK_BAD_REQUEST", 400, "email is invalid");
        }
        let lastError = null;
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
                            meta: metadata ? toInputJsonValue(metadata) : undefined,
                            expiresAt,
                            used: false,
                        },
                    });
                });
                this.logger?.info("auth.magic_link.issued", {
                    email_fp: fingerprint(email),
                    owner_role: ownerRole,
                    owner_wp_user_id: ownerWpUserId,
                    ttl_ms: this.ttlMs,
                    has_draft_ref: typeof metadata?.draft_ref === "string" && metadata.draft_ref !== "",
                }, reqId);
                return {
                    token,
                    expiresAt,
                    expiresIn: Math.max(1, Math.trunc((expiresAt.getTime() - issuedAt) / 1000)),
                };
            }
            catch (err) {
                lastError = err;
                if (isUniqueTokenError(err)) {
                    continue;
                }
                this.logger?.error("auth.magic_link.issue_failed", {
                    email_fp: fingerprint(email),
                    owner_role: ownerRole,
                    owner_wp_user_id: ownerWpUserId,
                    reason: err instanceof Error ? err.message : "auth_issue_failed",
                }, reqId, err);
                throw new AuthServiceError("ML_MAGIC_LINK_ISSUE_FAILED", 500, "magic_link_issue_failed", { cause: err instanceof Error ? err : undefined });
            }
        }
        this.logger?.error("auth.magic_link.issue_failed", {
            email_fp: fingerprint(email),
            owner_role: ownerRole,
            owner_wp_user_id: ownerWpUserId,
            reason: "token_collision_exhausted",
        }, reqId, lastError ?? undefined);
        throw new AuthServiceError("ML_MAGIC_LINK_ISSUE_FAILED", 500, "magic_link_issue_failed");
    }
    async consumeMagicLink(input, reqId) {
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
                        meta: true,
                        expiresAt: true,
                        used: true,
                    },
                });
                if (!row) {
                    return buildInvalidConsumeResult();
                }
                const now = new Date();
                const ownerWpUserId = normalizeNullablePositiveInt(row.ownerWpUserId);
                const allowsPendingPatient = row.ownerRole === client_1.ActorRole.PATIENT && ownerWpUserId == null;
                if (row.used || row.expiresAt.getTime() <= now.getTime()) {
                    return buildInvalidConsumeResult(row.email, normalizeMagicLinkMetadata(row.meta));
                }
                if (!allowsPendingPatient) {
                    if (ownerWpUserId == null || ownerWpUserId <= 0) {
                        return buildInvalidConsumeResult(row.email, normalizeMagicLinkMetadata(row.meta));
                    }
                    const ownerIsActive = await doesAuthTokenOwnerStillExist(tx, row.ownerRole, ownerWpUserId);
                    if (!ownerIsActive) {
                        return buildInvalidConsumeResult(row.email, normalizeMagicLinkMetadata(row.meta));
                    }
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
                    return buildInvalidConsumeResult(row.email, normalizeMagicLinkMetadata(row.meta));
                }
                const ownerRole = row.ownerRole === client_1.ActorRole.DOCTOR ? client_1.ActorRole.DOCTOR : client_1.ActorRole.PATIENT;
                return {
                    valid: true,
                    email: normalizeEmail(row.email),
                    ownerRole,
                    ownerWpUserId,
                    metadata: normalizeMagicLinkMetadata(row.meta),
                };
            });
            this.logger?.info(result.valid ? "auth.magic_link.consumed" : "auth.magic_link.rejected", {
                token_fp: fingerprint(token),
                email_fp: result.email !== "" ? fingerprint(result.email) : "",
                valid: result.valid,
                owner_role: result.ownerRole,
                owner_wp_user_id: result.ownerWpUserId,
                has_draft_ref: typeof result.metadata?.draft_ref === "string" && result.metadata.draft_ref !== "",
            }, reqId);
            return result;
        }
        catch (err) {
            this.logger?.error("auth.magic_link.consume_failed", {
                token_fp: fingerprint(token),
                reason: err instanceof Error ? err.message : "auth_consume_failed",
            }, reqId, err);
            throw new AuthServiceError("ML_MAGIC_LINK_VERIFY_FAILED", 500, "magic_link_verify_failed", { cause: err instanceof Error ? err : undefined });
        }
    }
}
exports.AuthService = AuthService;
function getPrismaClient() {
    if (!prismaSingleton) {
        prismaSingleton = new client_1.PrismaClient();
    }
    return prismaSingleton;
}
function normalizeEmail(value) {
    const normalized = String(value || "").trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : "";
}
function normalizeToken(value) {
    const normalized = String(value || "").trim();
    if (normalized.length < 32 || normalized.length > 256) {
        return "";
    }
    if (!/^[A-Za-z0-9_-]+$/.test(normalized)) {
        return "";
    }
    return normalized;
}
function normalizeOwnerRole(value) {
    if (value === client_1.ActorRole.DOCTOR || value === client_1.ActorRole.PATIENT) {
        return value;
    }
    throw new AuthServiceError("ML_MAGIC_LINK_BAD_REQUEST", 400, "ownerRole is invalid");
}
function normalizeOwnerWpUserId(value, ownerRole) {
    const normalized = normalizeNullablePositiveInt(value);
    if (ownerRole === client_1.ActorRole.DOCTOR) {
        if (normalized == null || normalized <= 0) {
            throw new AuthServiceError("ML_MAGIC_LINK_BAD_REQUEST", 400, "ownerWpUserId is invalid");
        }
        return normalized;
    }
    return normalized;
}
function normalizeNullablePositiveInt(value) {
    if (value == null || value === "") {
        return null;
    }
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return null;
    }
    return Math.trunc(parsed);
}
function normalizeMagicLinkMetadata(value) {
    if (value == null) {
        return null;
    }
    if (typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    const raw = JSON.parse(JSON.stringify(value));
    const out = {};
    const draftRef = normalizeDraftRef(raw.draft_ref);
    if (draftRef) {
        out.draft_ref = draftRef;
    }
    const redirectTo = normalizeRedirectTo(raw.redirect_to);
    if (redirectTo) {
        out.redirect_to = redirectTo;
    }
    for (const [key, candidate] of Object.entries(raw)) {
        if (key === "draft_ref" || key === "redirect_to") {
            continue;
        }
        if (!isSafeMetaKey(key)) {
            continue;
        }
        const sanitized = sanitizeMetaValue(candidate);
        if (sanitized !== undefined) {
            out[key] = sanitized;
        }
    }
    if (Object.keys(out).length === 0) {
        return null;
    }
    const encoded = JSON.stringify(out);
    if (Buffer.byteLength(encoded, "utf8") > MAX_META_JSON_BYTES) {
        throw new AuthServiceError("ML_MAGIC_LINK_BAD_REQUEST", 400, "metadata is too large");
    }
    return out;
}
function normalizeDraftRef(value) {
    if (typeof value !== "string") {
        return "";
    }
    const normalized = value.trim();
    if (normalized === "" || normalized.length > 128 || !/^[A-Za-z0-9_-]{8,128}$/.test(normalized)) {
        return "";
    }
    return normalized;
}
function normalizeRedirectTo(value) {
    if (typeof value !== "string") {
        return "";
    }
    const normalized = value.trim();
    if (normalized === "" || normalized.length > 1024) {
        return "";
    }
    return normalized;
}
function isSafeMetaKey(value) {
    return /^[a-z][a-z0-9_]{1,63}$/i.test(value);
}
function sanitizeMetaValue(value) {
    if (value == null
        || typeof value === "string"
        || typeof value === "number"
        || typeof value === "boolean") {
        return value;
    }
    if (Array.isArray(value)) {
        const next = value
            .map((entry) => sanitizeMetaValue(entry))
            .filter((entry) => entry !== undefined);
        return next;
    }
    if (typeof value === "object") {
        const next = {};
        for (const [key, entry] of Object.entries(value)) {
            if (!isSafeMetaKey(key)) {
                continue;
            }
            const sanitized = sanitizeMetaValue(entry);
            if (sanitized !== undefined) {
                next[key] = sanitized;
            }
        }
        return next;
    }
    return undefined;
}
function toInputJsonValue(value) {
    return JSON.parse(JSON.stringify(value));
}
function uniquePositiveInts(values) {
    const out = new Set();
    for (const value of values) {
        if (typeof value === "number" && Number.isFinite(value) && value > 0) {
            out.add(Math.trunc(value));
        }
    }
    return Array.from(out.values());
}
function generateToken() {
    return node_crypto_1.default.randomBytes(MAGIC_LINK_TOKEN_BYTES).toString("base64url");
}
function clampPositiveInt(value, min, max) {
    if (!Number.isFinite(value) || value <= 0) {
        return DEFAULT_MAGIC_LINK_TTL_MS;
    }
    return Math.min(max, Math.max(min, Math.trunc(value)));
}
function fingerprint(value) {
    return node_crypto_1.default.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 12);
}
function buildInvalidConsumeResult(email = "", metadata = null) {
    return {
        valid: false,
        email: normalizeEmail(email),
        ownerRole: null,
        ownerWpUserId: null,
        metadata,
    };
}
async function doesAuthTokenOwnerStillExist(tx, ownerRole, ownerWpUserId) {
    if (ownerRole === client_1.ActorRole.DOCTOR) {
        const doctor = await tx.doctor.findFirst({
            where: {
                wpUserId: ownerWpUserId,
                deletedAt: null,
            },
            select: {
                id: true,
            },
        });
        return doctor != null;
    }
    if (ownerRole === client_1.ActorRole.PATIENT) {
        const patient = await tx.patient.findFirst({
            where: {
                wpUserId: ownerWpUserId,
                deletedAt: null,
            },
            select: {
                id: true,
            },
        });
        return patient != null;
    }
    return false;
}
function isUniqueTokenError(err) {
    if (!(err instanceof client_1.Prisma.PrismaClientKnownRequestError)) {
        return false;
    }
    if (err.code !== "P2002") {
        return false;
    }
    const fields = extractUniqueTargetFields(err.meta?.target);
    return fields.includes("token");
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
