"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ArtifactRepo = void 0;
// src/artifacts/artifactRepo.ts
const node_crypto_1 = require("node:crypto");
const client_1 = require("@prisma/client");
const DEFAULT_TICKET_BYTES = 24;
class ArtifactRepo {
    prisma;
    logger;
    constructor(cfg = {}) {
        this.prisma = new client_1.PrismaClient();
        this.logger = cfg.logger;
    }
    async close() {
        await this.prisma.$disconnect();
    }
    async initUpload(input) {
        return this.createStagedArtifact(input);
    }
    async createStagedArtifact(input) {
        const ownerWpUserId = normalizeNullablePositiveInt(input.ownerWpUserId);
        const uploadedByDoctorId = await this.resolveUploadedByDoctorId(input.ownerRole, ownerWpUserId);
        const draftKey = generateDraftKey();
        const created = await this.prisma.artifact.create({
            data: {
                prescriptionId: normalizeNullableString(input.prescriptionId),
                messageId: null,
                kind: input.kind,
                status: client_1.ArtifactStatus.STAGED,
                ownerRole: input.ownerRole,
                ownerWpUserId,
                uploadedByDoctorId,
                draftKey,
                originalName: normalizeRequiredString(input.originalName, "originalName"),
                mimeType: normalizeRequiredString(input.mimeType, "mimeType"),
                sizeBytes: normalizePositiveInt(input.sizeBytes, "sizeBytes"),
                sha256Hex: null,
                s3Bucket: null,
                s3Region: null,
                s3Key: null,
                meta: input.meta ?? undefined,
                linkedAt: null,
                deletedAt: null,
            },
            select: artifactSelect(),
        });
        this.logger?.info("artifact.staged", {
            artifact_id: created.id,
            kind: created.kind,
            prescription_id: created.prescriptionId,
            owner_role: created.ownerRole,
            size_bytes: created.sizeBytes,
        }, undefined);
        return created;
    }
    async verifyAndConsumeTicket(ticket, maxAgeMs) {
        const normalizedTicket = normalizeRequiredString(ticket, "ticket");
        const ttlMs = Math.max(1_000, Math.floor(maxAgeMs));
        return this.prisma.$transaction(async (tx) => {
            const artifact = await tx.artifact.findUnique({
                where: { draftKey: normalizedTicket },
                select: artifactSelect(),
            });
            if (!artifact) {
                return { ok: false, code: "NOT_FOUND" };
            }
            if (artifact.status !== client_1.ArtifactStatus.STAGED) {
                return { ok: false, code: "ALREADY_CONSUMED" };
            }
            if (artifact.deletedAt) {
                return { ok: false, code: "NOT_FOUND" };
            }
            const ageMs = Date.now() - artifact.createdAt.getTime();
            if (ageMs > ttlMs) {
                await tx.artifact.update({
                    where: { id: artifact.id },
                    data: {
                        status: client_1.ArtifactStatus.FAILED,
                        draftKey: null,
                    },
                });
                return { ok: false, code: "EXPIRED" };
            }
            const consumed = await tx.artifact.updateMany({
                where: {
                    id: artifact.id,
                    status: client_1.ArtifactStatus.STAGED,
                    draftKey: normalizedTicket,
                },
                data: {
                    draftKey: null,
                },
            });
            if (consumed.count !== 1) {
                return { ok: false, code: "ALREADY_CONSUMED" };
            }
            return {
                ok: true,
                artifact: {
                    ...artifact,
                    draftKey: null,
                },
            };
        });
    }
    async markReady(id, input) {
        return this.markArtifactReady(id, input);
    }
    async markArtifactReady(id, input) {
        const artifactId = normalizeRequiredString(id, "id");
        return this.prisma.$transaction(async (tx) => {
            const existing = await tx.artifact.findUnique({
                where: { id: artifactId },
                select: {
                    id: true,
                    kind: true,
                    prescriptionId: true,
                    messageId: true,
                    status: true,
                    linkedAt: true,
                },
            });
            if (!existing) {
                return null;
            }
            const now = new Date();
            const becameReady = existing.status !== client_1.ArtifactStatus.READY;
            const updated = await tx.artifact.update({
                where: { id: artifactId },
                data: {
                    status: client_1.ArtifactStatus.READY,
                    sizeBytes: normalizePositiveInt(input.sizeBytes, "sizeBytes"),
                    sha256Hex: normalizeRequiredString(input.sha256Hex, "sha256Hex"),
                    s3Bucket: normalizeRequiredString(input.s3Bucket, "s3Bucket"),
                    s3Region: normalizeRequiredString(input.s3Region, "s3Region"),
                    s3Key: normalizeRequiredString(input.s3Key, "s3Key"),
                    linkedAt: existing.prescriptionId || existing.messageId ? (existing.linkedAt ?? now) : existing.linkedAt,
                },
                select: artifactSelect(),
            });
            if (becameReady && existing.kind === client_1.ArtifactKind.PROOF && existing.prescriptionId) {
                await tx.prescription.update({
                    where: { id: existing.prescriptionId },
                    data: {
                        hasProof: true,
                        proofCount: { increment: 1 },
                    },
                });
            }
            this.logger?.info("artifact.ready", {
                artifact_id: updated.id,
                kind: updated.kind,
                prescription_id: updated.prescriptionId,
                s3_key: updated.s3Key,
                size_bytes: updated.sizeBytes,
            }, undefined);
            return updated;
        });
    }
    async markArtifactFailed(id) {
        const artifactId = normalizeRequiredString(id, "id");
        await this.prisma.artifact.updateMany({
            where: {
                id: artifactId,
                status: { not: client_1.ArtifactStatus.READY },
            },
            data: {
                status: client_1.ArtifactStatus.FAILED,
            },
        });
        this.logger?.warning("artifact.failed", {
            artifact_id: artifactId,
        }, undefined);
    }
    async resolveUploadedByDoctorId(ownerRole, ownerWpUserId) {
        if (ownerRole !== client_1.ActorRole.DOCTOR || ownerWpUserId == null) {
            return null;
        }
        const doctor = await this.prisma.doctor.findUnique({
            where: { wpUserId: ownerWpUserId },
            select: { id: true },
        });
        return doctor?.id ?? null;
    }
}
exports.ArtifactRepo = ArtifactRepo;
function artifactSelect() {
    return {
        id: true,
        prescriptionId: true,
        messageId: true,
        kind: true,
        status: true,
        ownerRole: true,
        ownerWpUserId: true,
        uploadedByDoctorId: true,
        draftKey: true,
        originalName: true,
        mimeType: true,
        sizeBytes: true,
        sha256Hex: true,
        s3Bucket: true,
        s3Region: true,
        s3Key: true,
        linkedAt: true,
        createdAt: true,
        updatedAt: true,
        deletedAt: true,
    };
}
function generateDraftKey() {
    return (0, node_crypto_1.randomBytes)(DEFAULT_TICKET_BYTES).toString("hex");
}
function normalizeRequiredString(value, field) {
    if (typeof value !== "string" || value.trim() === "") {
        throw new Error(`${field} is required`);
    }
    return value.trim();
}
function normalizeNullableString(value) {
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
function normalizePositiveInt(value, field) {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`${field} must be a positive number`);
    }
    return Math.trunc(n);
}
function normalizeNullablePositiveInt(value) {
    if (value == null || value === "") {
        return null;
    }
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n) || n <= 0) {
        return null;
    }
    return Math.trunc(n);
}
