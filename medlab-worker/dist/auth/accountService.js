"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AccountService = exports.AccountServiceError = void 0;
const client_1 = require("@prisma/client");
let prismaSingleton = null;
class AccountServiceError extends Error {
    code;
    statusCode;
    constructor(code, statusCode, message, options) {
        super(message, options);
        this.name = "AccountServiceError";
        this.code = code;
        this.statusCode = statusCode;
    }
}
exports.AccountServiceError = AccountServiceError;
class AccountService {
    prisma;
    logger;
    constructor(cfg = {}) {
        this.prisma = getPrismaClient();
        this.logger = cfg.logger;
    }
    async deleteAccount(actor, wpUserId, reqId) {
        const actorRole = normalizeActorRole(actor);
        const normalizedWpUserId = normalizePositiveInt(wpUserId, "wpUserId");
        try {
            const result = actorRole === client_1.ActorRole.DOCTOR
                ? await this.deleteDoctor(normalizedWpUserId)
                : await this.deletePatient(normalizedWpUserId);
            this.logger?.info("account.delete.completed", {
                actor_role: actorRole,
                owner_wp_user_id: normalizedWpUserId,
                account_id: result.accountId,
                deleted: result.deleted,
                not_found: result.notFound,
                auth_tokens_revoked: result.authTokensRevoked,
            }, reqId);
            return result;
        }
        catch (err) {
            if (err instanceof AccountServiceError) {
                throw err;
            }
            this.logger?.error("account.delete.failed", {
                actor_role: actorRole,
                owner_wp_user_id: normalizedWpUserId,
                reason: err instanceof Error ? err.message : "account_delete_failed",
            }, reqId, err);
            throw new AccountServiceError("ML_ACCOUNT_DELETE_FAILED", 500, "account_delete_failed", { cause: err instanceof Error ? err : undefined });
        }
    }
    async deletePatient(wpUserId) {
        return this.prisma.$transaction(async (tx) => {
            const patient = await tx.patient.findUnique({
                where: { wpUserId },
                select: {
                    id: true,
                    email: true,
                    deletedAt: true,
                },
            });
            const authTokensRevoked = await revokeAuthTokens(tx, wpUserId, patient?.email ?? null);
            if (!patient) {
                return {
                    deleted: true,
                    actorRole: client_1.ActorRole.PATIENT,
                    accountId: null,
                    authTokensRevoked,
                    notFound: true,
                };
            }
            const now = new Date();
            await tx.patient.update({
                where: { id: patient.id },
                data: {
                    deletedAt: now,
                    email: buildDeletedEmail(patient.id),
                    phone: null,
                    weightKg: null,
                    heightCm: null,
                    note: null,
                    wpUserId: null,
                },
            });
            return {
                deleted: true,
                actorRole: client_1.ActorRole.PATIENT,
                accountId: patient.id,
                authTokensRevoked,
                notFound: false,
            };
        });
    }
    async deleteDoctor(wpUserId) {
        return this.prisma.$transaction(async (tx) => {
            const doctor = await tx.doctor.findUnique({
                where: { wpUserId },
                select: {
                    id: true,
                    email: true,
                    deletedAt: true,
                },
            });
            const authTokensRevoked = await revokeAuthTokens(tx, wpUserId, doctor?.email ?? null);
            if (!doctor) {
                return {
                    deleted: true,
                    actorRole: client_1.ActorRole.DOCTOR,
                    accountId: null,
                    authTokensRevoked,
                    notFound: true,
                };
            }
            const now = new Date();
            await tx.doctor.update({
                where: { id: doctor.id },
                data: {
                    deletedAt: now,
                    email: buildDeletedEmail(doctor.id),
                    phone: null,
                    address: null,
                    city: null,
                    zipCode: null,
                    wpUserId: null,
                },
            });
            return {
                deleted: true,
                actorRole: client_1.ActorRole.DOCTOR,
                accountId: doctor.id,
                authTokensRevoked,
                notFound: false,
            };
        });
    }
}
exports.AccountService = AccountService;
function getPrismaClient() {
    if (!prismaSingleton) {
        prismaSingleton = new client_1.PrismaClient();
    }
    return prismaSingleton;
}
async function revokeAuthTokens(tx, wpUserId, email) {
    const clauses = [{ ownerWpUserId: wpUserId }];
    const normalizedEmail = normalizeEmail(email);
    if (normalizedEmail !== "") {
        clauses.push({
            email: {
                equals: normalizedEmail,
                mode: "insensitive",
            },
        });
    }
    const result = await tx.authToken.updateMany({
        where: { OR: clauses },
        data: { used: true },
    });
    return result.count;
}
function normalizeActorRole(value) {
    if (value === client_1.ActorRole.DOCTOR || value === client_1.ActorRole.PATIENT) {
        return value;
    }
    throw new AccountServiceError("ML_ACCOUNT_DELETE_BAD_REQUEST", 400, "account_actor_invalid");
}
function normalizePositiveInt(value, field) {
    if (!Number.isFinite(value) || value <= 0) {
        throw new AccountServiceError("ML_ACCOUNT_DELETE_BAD_REQUEST", 400, `${field} is invalid`);
    }
    return Math.trunc(value);
}
function normalizeEmail(value) {
    if (typeof value !== "string") {
        return "";
    }
    const normalized = value.trim().toLowerCase();
    return normalized === "" ? "" : normalized;
}
function buildDeletedEmail(accountId) {
    const normalizedId = String(accountId || "").trim().toLowerCase();
    if (normalizedId === "") {
        throw new AccountServiceError("ML_ACCOUNT_DELETE_FAILED", 500, "account_id_missing");
    }
    return `deleted_${normalizedId}@sosprescription.local`;
}
