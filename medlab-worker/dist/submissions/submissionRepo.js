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
                            return {
                                mode: "replayed",
                                submission: mapSubmission(existing),
                            };
                        }
                    }
                    else {
                        publicRef = generateRandomPublicRef();
                        continue;
                    }
                }
                this.logger?.error("submission.repo_create_failed", {
                    reason: err instanceof Error ? err.message : "submission_repo_create_failed",
                }, undefined, err);
                throw wrapSubmissionRepoError(err);
            }
        }
        throw new SubmissionRepoError("ML_SUBMISSION_CREATE_FAILED", 500, "Unable to allocate a unique submission reference");
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
function normalizeCreateSubmissionInput(input) {
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
function wrapSubmissionRepoError(err) {
    if (err instanceof SubmissionRepoError) {
        return err;
    }
    return new SubmissionRepoError("ML_SUBMISSION_CREATE_FAILED", 500, err instanceof Error ? err.message : "submission_create_failed");
}
