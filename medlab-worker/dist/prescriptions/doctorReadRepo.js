"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DoctorReadRepo = void 0;
const client_1 = require("@prisma/client");
const prescriptionReadMapper_1 = require("./prescriptionReadMapper");
let prismaSingleton = null;
class DoctorReadRepo {
    prisma;
    logger;
    constructor(cfg = {}) {
        this.prisma = getPrismaClient();
        this.logger = cfg.logger;
    }
    async queryInbox(input) {
        const normalized = normalizeDoctorInboxQueryInput(input);
        try {
            const rows = await this.prisma.prescription.findMany({
                where: buildDoctorInboxWhere(normalized.actor.wpUserId, normalized.status),
                include: prescriptionReadMapper_1.prescriptionListInclude,
                orderBy: [
                    { createdAt: "desc" },
                    { id: "desc" },
                ],
                take: normalized.limit,
                skip: normalized.offset,
            });
            return rows.map(prescriptionReadMapper_1.mapPrescriptionListRow);
        }
        catch (err) {
            if (err instanceof prescriptionReadMapper_1.PrescriptionReadRepoError) {
                throw err;
            }
            this.logger?.error("doctor.inbox.repo_failed", {
                actor_wp_user_id: normalized.actor.wpUserId,
                status: normalized.status,
                limit: normalized.limit,
                offset: normalized.offset,
                reason: err instanceof Error ? err.message : "doctor_inbox_failed",
            }, undefined, err);
            throw new prescriptionReadMapper_1.PrescriptionReadRepoError("ML_DOCTOR_INBOX_FAILED", 500, "doctor_inbox_failed");
        }
    }
    async getPrescriptionDetail(input) {
        const normalized = normalizeDoctorPrescriptionDetailInput(input);
        try {
            const record = await this.prisma.prescription.findUnique({
                where: { id: normalized.prescriptionId },
                include: prescriptionReadMapper_1.prescriptionDetailInclude,
            });
            if (!record) {
                throw new prescriptionReadMapper_1.PrescriptionReadRepoError("ML_PRESCRIPTION_NOT_FOUND", 404, "prescription_not_found");
            }
            if (!canDoctorAccessPrescription(record, normalized.actor.wpUserId)) {
                throw new prescriptionReadMapper_1.PrescriptionReadRepoError("ML_READ_FORBIDDEN", 403, "prescription_forbidden");
            }
            return (0, prescriptionReadMapper_1.mapPrescriptionDetail)(record);
        }
        catch (err) {
            if (err instanceof prescriptionReadMapper_1.PrescriptionReadRepoError) {
                throw err;
            }
            this.logger?.error("doctor.prescription.repo_failed", {
                actor_wp_user_id: normalized.actor.wpUserId,
                prescription_id: normalized.prescriptionId,
                reason: err instanceof Error ? err.message : "doctor_prescription_get_failed",
            }, undefined, err);
            throw new prescriptionReadMapper_1.PrescriptionReadRepoError("ML_PRESCRIPTION_GET_FAILED", 500, "doctor_prescription_get_failed");
        }
    }
}
exports.DoctorReadRepo = DoctorReadRepo;
function getPrismaClient() {
    if (!prismaSingleton) {
        prismaSingleton = new client_1.PrismaClient();
    }
    return prismaSingleton;
}
function normalizeDoctorInboxQueryInput(input) {
    if (!input || typeof input !== "object") {
        throw new prescriptionReadMapper_1.PrescriptionReadRepoError("ML_READ_BAD_REQUEST", 400, "doctor_inbox_input_required");
    }
    return {
        actor: normalizeDoctorActor(input.actor),
        status: normalizeStatusFilter(input.status),
        limit: normalizeLimit(input.limit),
        offset: normalizeOffset(input.offset),
    };
}
function normalizeDoctorPrescriptionDetailInput(input) {
    if (!input || typeof input !== "object") {
        throw new prescriptionReadMapper_1.PrescriptionReadRepoError("ML_READ_BAD_REQUEST", 400, "doctor_detail_input_required");
    }
    return {
        actor: normalizeDoctorActor(input.actor),
        prescriptionId: normalizePrescriptionId(input.prescriptionId),
    };
}
function normalizeDoctorActor(actor) {
    if (!actor || typeof actor !== "object") {
        throw new prescriptionReadMapper_1.PrescriptionReadRepoError("ML_READ_BAD_REQUEST", 400, "actor_required");
    }
    if (actor.role !== "DOCTOR") {
        throw new prescriptionReadMapper_1.PrescriptionReadRepoError("ML_READ_FORBIDDEN", 403, "doctor_actor_required");
    }
    const wpUserId = normalizePositiveInt(actor.wpUserId, "actor.wpUserId");
    return {
        role: "DOCTOR",
        wpUserId,
    };
}
function normalizePrescriptionId(value) {
    if (typeof value !== "string") {
        throw new prescriptionReadMapper_1.PrescriptionReadRepoError("ML_READ_BAD_REQUEST", 400, "prescription_id_required");
    }
    const normalized = value.trim();
    if (normalized === "" || normalized.length > 191) {
        throw new prescriptionReadMapper_1.PrescriptionReadRepoError("ML_READ_BAD_REQUEST", 400, "prescription_id_invalid");
    }
    return normalized;
}
function normalizeStatusFilter(value) {
    if (value == null || value === "") {
        return null;
    }
    if (typeof value !== "string") {
        throw new prescriptionReadMapper_1.PrescriptionReadRepoError("ML_READ_BAD_REQUEST", 400, "status_invalid");
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === "" || normalized === "all") {
        return null;
    }
    if (!["pending", "payment_pending", "approved", "rejected"].includes(normalized)) {
        throw new prescriptionReadMapper_1.PrescriptionReadRepoError("ML_READ_BAD_REQUEST", 400, "status_invalid");
    }
    return normalized;
}
function normalizeLimit(value) {
    if (value == null || value === "") {
        return 100;
    }
    const parsed = typeof value === "number" ? value : Number(value);
    if (!globalThis.Number.isFinite(parsed) || parsed <= 0) {
        throw new prescriptionReadMapper_1.PrescriptionReadRepoError("ML_READ_BAD_REQUEST", 400, "limit_invalid");
    }
    return Math.min(200, Math.trunc(parsed));
}
function normalizeOffset(value) {
    if (value == null || value === "") {
        return 0;
    }
    const parsed = typeof value === "number" ? value : Number(value);
    if (!globalThis.Number.isFinite(parsed) || parsed < 0) {
        throw new prescriptionReadMapper_1.PrescriptionReadRepoError("ML_READ_BAD_REQUEST", 400, "offset_invalid");
    }
    return Math.trunc(parsed);
}
function normalizePositiveInt(value, field) {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!globalThis.Number.isFinite(parsed) || parsed <= 0) {
        throw new prescriptionReadMapper_1.PrescriptionReadRepoError("ML_READ_BAD_REQUEST", 400, `${field}_invalid`);
    }
    return Math.trunc(parsed);
}
function buildDoctorInboxWhere(doctorWpUserId, status) {
    const where = {
        OR: [
            { doctorId: null },
            { doctor: { is: { wpUserId: doctorWpUserId } } },
        ],
    };
    const workerStatuses = mapStatusFilterToWorkerStatuses(status);
    if (workerStatuses) {
        where.status = { in: workerStatuses };
    }
    return where;
}
function mapStatusFilterToWorkerStatuses(status) {
    if (status == null) {
        return null;
    }
    switch (status) {
        case "pending":
        case "payment_pending":
            return ["PENDING"];
        case "approved":
            return ["APPROVED"];
        case "rejected":
            return ["REJECTED"];
        default:
            return null;
    }
}
function canDoctorAccessPrescription(record, doctorWpUserId) {
    if (record.doctor == null) {
        return true;
    }
    return record.doctor.wpUserId === doctorWpUserId;
}
