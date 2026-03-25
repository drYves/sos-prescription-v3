"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrismaPrescriptionStore = void 0;
// src/prescriptions/prismaPrescriptionStore.ts
const client_1 = require("@prisma/client");
const errors_1 = require("../jobs/errors");
class PrismaPrescriptionStore {
    prisma;
    ownsClient;
    logger;
    constructor(cfg = {}) {
        this.prisma = cfg.prisma ?? new client_1.PrismaClient();
        this.ownsClient = !cfg.prisma;
        this.logger = cfg.logger;
    }
    async getRenderablePrescription(prescriptionId) {
        const id = String(prescriptionId ?? "").trim();
        if (id === "") {
            throw new errors_1.HardError("ML_PRESCRIPTION_NOT_FOUND", "Prescription not found");
        }
        const row = await this.prisma.prescription.findUnique({
            where: { id },
            include: {
                doctor: true,
                patient: true,
            },
        });
        if (!row) {
            this.logger?.warning("db.prescription.not_found", { prescription_id: id }, undefined);
            throw new errors_1.HardError("ML_PRESCRIPTION_NOT_FOUND", "Prescription not found");
        }
        if (!row.doctor) {
            this.logger?.warning("db.prescription.doctor_missing", { prescription_id: id }, undefined);
            throw new errors_1.HardError("ML_PRESCRIPTION_DOCTOR_MISSING", "Prescription doctor not assigned");
        }
        return {
            doctor: {
                id: row.doctor.id,
                wpUserId: row.doctor.wpUserId,
                firstName: row.doctor.firstName,
                lastName: row.doctor.lastName,
                email: row.doctor.email,
                phone: row.doctor.phone,
                title: row.doctor.title,
                specialty: row.doctor.specialty,
                rpps: row.doctor.rpps,
                amNumber: row.doctor.amNumber,
                address: row.doctor.address,
                city: row.doctor.city,
                zipCode: row.doctor.zipCode,
                signatureS3Key: row.doctor.signatureS3Key,
                createdAt: row.doctor.createdAt,
                updatedAt: row.doctor.updatedAt,
            },
            patient: {
                id: row.patient.id,
                firstName: row.patient.firstName,
                lastName: row.patient.lastName,
                birthDate: row.patient.birthDate,
                gender: row.patient.gender,
                email: row.patient.email,
                phone: row.patient.phone,
                weightKg: row.patient.weightKg,
                weight_kg: row.patient.weightKg,
                createdAt: row.patient.createdAt,
                updatedAt: row.patient.updatedAt,
            },
            prescription: {
                id: row.id,
                uid: row.uid,
                status: row.status,
                items: row.items,
                privateNotes: row.privateNotes,
                s3PdfKey: row.s3PdfKey,
                verifyCode: row.verifyCode,
                verifyToken: row.verifyToken,
                processingStatus: row.processingStatus,
                availableAt: row.availableAt,
                claimedAt: row.claimedAt,
                lockExpiresAt: row.lockExpiresAt,
                workerRef: row.workerRef,
                attempts: row.attempts,
                maxAttempts: row.maxAttempts,
                lastErrorCode: row.lastErrorCode,
                lastErrorMessageSafe: row.lastErrorMessageSafe,
                sourceReqId: row.sourceReqId,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
            },
        };
    }
    async close() {
        if (!this.ownsClient) {
            return;
        }
        await this.prisma.$disconnect();
    }
}
exports.PrismaPrescriptionStore = PrismaPrescriptionStore;
