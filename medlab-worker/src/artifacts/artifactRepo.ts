// src/artifacts/artifactRepo.ts
import { randomBytes } from "node:crypto";
import { ActorRole, ArtifactKind, ArtifactStatus, Prisma, PrismaClient } from "@prisma/client";
import { NdjsonLogger } from "../logger";

const DEFAULT_TICKET_BYTES = 24;

export interface ArtifactRepoConfig {
  logger?: NdjsonLogger;
}

export interface CreateStagedArtifactInput {
  kind: ArtifactKind;
  ownerRole: ActorRole;
  ownerWpUserId?: number | null;
  prescriptionId?: string | null;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  meta?: Prisma.InputJsonValue | null;
}

export interface ArtifactRecord {
  id: string;
  prescriptionId: string | null;
  messageId: string | null;
  kind: ArtifactKind;
  status: ArtifactStatus;
  ownerRole: ActorRole;
  ownerWpUserId: number | null;
  uploadedByDoctorId: string | null;
  draftKey: string | null;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  sha256Hex: string | null;
  s3Bucket: string | null;
  s3Region: string | null;
  s3Key: string | null;
  linkedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export type VerifyTicketResult =
  | { ok: true; artifact: ArtifactRecord }
  | { ok: false; code: "NOT_FOUND" | "EXPIRED" | "ALREADY_CONSUMED" };

export interface MarkArtifactReadyInput {
  sizeBytes: number;
  sha256Hex: string;
  s3Bucket: string;
  s3Region: string;
  s3Key: string;
}

export class ArtifactRepo {
  private readonly prisma: PrismaClient;
  private readonly logger?: NdjsonLogger;

  constructor(cfg: ArtifactRepoConfig = {}) {
    this.prisma = new PrismaClient();
    this.logger = cfg.logger;
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }

  async createStagedArtifact(input: CreateStagedArtifactInput): Promise<ArtifactRecord> {
    const ownerWpUserId = normalizeNullablePositiveInt(input.ownerWpUserId);
    const uploadedByDoctorId = await this.resolveUploadedByDoctorId(input.ownerRole, ownerWpUserId);
    const draftKey = generateDraftKey();

    const created = await this.prisma.artifact.create({
      data: {
        prescriptionId: normalizeNullableString(input.prescriptionId),
        messageId: null,
        kind: input.kind,
        status: ArtifactStatus.STAGED,
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

    this.logger?.info(
      "artifact.staged",
      {
        artifact_id: created.id,
        kind: created.kind,
        prescription_id: created.prescriptionId,
        owner_role: created.ownerRole,
        size_bytes: created.sizeBytes,
      },
      undefined,
    );

    return created;
  }

  async verifyAndConsumeTicket(ticket: string, maxAgeMs: number): Promise<VerifyTicketResult> {
    const normalizedTicket = normalizeRequiredString(ticket, "ticket");
    const ttlMs = Math.max(1_000, Math.floor(maxAgeMs));

    return this.prisma.$transaction(async (tx) => {
      const artifact = await tx.artifact.findUnique({
        where: { draftKey: normalizedTicket },
        select: artifactSelect(),
      });

      if (!artifact) {
        return { ok: false, code: "NOT_FOUND" } as const;
      }

      if (artifact.status !== ArtifactStatus.STAGED) {
        return { ok: false, code: "ALREADY_CONSUMED" } as const;
      }

      if (artifact.deletedAt) {
        return { ok: false, code: "NOT_FOUND" } as const;
      }

      const ageMs = Date.now() - artifact.createdAt.getTime();
      if (ageMs > ttlMs) {
        await tx.artifact.update({
          where: { id: artifact.id },
          data: {
            status: ArtifactStatus.FAILED,
            draftKey: null,
          },
        });
        return { ok: false, code: "EXPIRED" } as const;
      }

      const consumed = await tx.artifact.updateMany({
        where: {
          id: artifact.id,
          status: ArtifactStatus.STAGED,
          draftKey: normalizedTicket,
        },
        data: {
          draftKey: null,
        },
      });

      if (consumed.count !== 1) {
        return { ok: false, code: "ALREADY_CONSUMED" } as const;
      }

      return {
        ok: true,
        artifact: {
          ...artifact,
          draftKey: null,
        },
      } as const;
    });
  }

  async markArtifactReady(id: string, input: MarkArtifactReadyInput): Promise<ArtifactRecord | null> {
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
      const becameReady = existing.status !== ArtifactStatus.READY;

      const updated = await tx.artifact.update({
        where: { id: artifactId },
        data: {
          status: ArtifactStatus.READY,
          sizeBytes: normalizePositiveInt(input.sizeBytes, "sizeBytes"),
          sha256Hex: normalizeRequiredString(input.sha256Hex, "sha256Hex"),
          s3Bucket: normalizeRequiredString(input.s3Bucket, "s3Bucket"),
          s3Region: normalizeRequiredString(input.s3Region, "s3Region"),
          s3Key: normalizeRequiredString(input.s3Key, "s3Key"),
          linkedAt: existing.prescriptionId || existing.messageId ? (existing.linkedAt ?? now) : existing.linkedAt,
        },
        select: artifactSelect(),
      });

      if (becameReady && existing.kind === ArtifactKind.PROOF && existing.prescriptionId) {
        await tx.prescription.update({
          where: { id: existing.prescriptionId },
          data: {
            hasProof: true,
            proofCount: { increment: 1 },
          },
        });
      }

      this.logger?.info(
        "artifact.ready",
        {
          artifact_id: updated.id,
          kind: updated.kind,
          prescription_id: updated.prescriptionId,
          s3_key: updated.s3Key,
          size_bytes: updated.sizeBytes,
        },
        undefined,
      );

      return updated;
    });
  }

  async markArtifactFailed(id: string): Promise<void> {
    const artifactId = normalizeRequiredString(id, "id");
    await this.prisma.artifact.updateMany({
      where: {
        id: artifactId,
        status: { not: ArtifactStatus.READY },
      },
      data: {
        status: ArtifactStatus.FAILED,
      },
    });

    this.logger?.warning(
      "artifact.failed",
      {
        artifact_id: artifactId,
      },
      undefined,
    );
  }

  private async resolveUploadedByDoctorId(ownerRole: ActorRole, ownerWpUserId: number | null): Promise<string | null> {
    if (ownerRole !== ActorRole.DOCTOR || ownerWpUserId == null) {
      return null;
    }

    const doctor = await this.prisma.doctor.findUnique({
      where: { wpUserId: ownerWpUserId },
      select: { id: true },
    });

    return doctor?.id ?? null;
  }
}

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
  } satisfies Prisma.ArtifactSelect;
}

function generateDraftKey(): string {
  return randomBytes(DEFAULT_TICKET_BYTES).toString("hex");
}

function normalizeRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function normalizePositiveInt(value: unknown, field: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${field} must be a positive number`);
  }
  return Math.trunc(n);
}

function normalizeNullablePositiveInt(value: unknown): number | null {
  if (value == null || value === "") {
    return null;
  }
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  return Math.trunc(n);
}
