"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PatientReadRepo = void 0;
const client_1 = require("@prisma/client");
const prescriptionReadMapper_1 = require("./prescriptionReadMapper");
let prismaSingleton = null;
class PatientReadRepo {
    prisma;
    logger;
    constructor(cfg = {}) {
        this.prisma = getPrismaClient();
        this.logger = cfg.logger;
    }
    async queryPrescriptions(input) {
        const normalized = normalizePatientPrescriptionsQueryInput(input);
        try {
            const rows = await this.prisma.prescription.findMany({
                where: buildPatientPrescriptionsWhere(normalized.actor.wpUserId, normalized.status),
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
            this.logger?.error("patient.prescriptions.repo_failed", {
                actor_wp_user_id: normalized.actor.wpUserId,
                status: normalized.status,
                limit: normalized.limit,
                offset: normalized.offset,
                reason: err instanceof Error ? err.message : "patient_prescriptions_failed",
            }, undefined, err);
            throw new prescriptionReadMapper_1.PrescriptionReadRepoError("ML_PATIENT_PRESCRIPTIONS_FAILED", 500, "patient_prescriptions_failed");
        }
    }
    async getPrescriptionDetail(input) {
        const normalized = normalizePatientPrescriptionDetailInput(input);
        try {
            const record = await this.prisma.prescription.findUnique({
                where: { id: normalized.prescriptionId },
                include: prescriptionReadMapper_1.prescriptionDetailInclude,
            });
            if (!record) {
                throw new prescriptionReadMapper_1.PrescriptionReadRepoError("ML_PRESCRIPTION_NOT_FOUND", 404, "prescription_not_found");
            }
            if (!canPatientAccessPrescription(record, normalized.actor.wpUserId)) {
                throw new prescriptionReadMapper_1.PrescriptionReadRepoError("ML_READ_FORBIDDEN", 403, "prescription_forbidden");
            }
            return (0, prescriptionReadMapper_1.mapPrescriptionDetail)(record);
        }
        catch (err) {
            if (err instanceof prescriptionReadMapper_1.PrescriptionReadRepoError) {
                throw err;
            }
            this.logger?.error("patient.prescription.repo_failed", {
                actor_wp_user_id: normalized.actor.wpUserId,
                prescription_id: normalized.prescriptionId,
                reason: err instanceof Error ? err.message : "patient_prescription_get_failed",
            }, undefined, err);
            throw new prescriptionReadMapper_1.PrescriptionReadRepoError("ML_PRESCRIPTION_GET_FAILED", 500, "patient_prescription_get_failed");
        }
    }
}
exports.PatientReadRepo = PatientReadRepo;
function getPrismaClient() {
    if (!prismaSingleton) {
        prismaSingleton = new client_1.PrismaClient();
    }
    return prismaSingleton;
}
function normalizePatientPrescriptionsQueryInput(input) {
    if (!input || typeof input !== "object") {
        throw new prescriptionReadMapper_1.PrescriptionReadRepoError("ML_READ_BAD_REQUEST", 400, "patient_query_input_required");
    }
    return {
        actor: normalizePatientActor(input.actor),
        status: normalizeStatusFilter(input.status),
        limit: normalizeLimit(input.limit),
        offset: normalizeOffset(input.offset),
    };
}
function normalizePatientPrescriptionDetailInput(input) {
    if (!input || typeof input !== "object") {
        throw new prescriptionReadMapper_1.PrescriptionReadRepoError("ML_READ_BAD_REQUEST", 400, "patient_detail_input_required");
    }
    return {
        actor: normalizePatientActor(input.actor),
        prescriptionId: normalizePrescriptionId(input.prescriptionId),
    };
}
function normalizePatientActor(actor) {
    if (!actor || typeof actor !== "object") {
        throw new prescriptionReadMapper_1.PrescriptionReadRepoError("ML_READ_BAD_REQUEST", 400, "actor_required");
    }
    if (actor.role !== "PATIENT") {
        throw new prescriptionReadMapper_1.PrescriptionReadRepoError("ML_READ_FORBIDDEN", 403, "patient_actor_required");
    }
    const wpUserId = normalizePositiveInt(actor.wpUserId, "actor.wpUserId");
    return {
        role: "PATIENT",
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
function buildPatientPrescriptionsWhere(patientWpUserId, status) {
    const where = {
        patient: {
            is: {
                wpUserId: patientWpUserId,
            },
        },
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
function canPatientAccessPrescription(record, patientWpUserId) {
    return record.patient.wpUserId === patientWpUserId;
}
