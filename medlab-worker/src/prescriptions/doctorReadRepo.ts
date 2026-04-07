import { Prisma, PrismaClient } from "@prisma/client";
import { NdjsonLogger } from "../logger";
import {
  PrescriptionReadRepoError,
  mapPrescriptionDetail,
  mapPrescriptionListRow,
  prescriptionDetailInclude,
  prescriptionListInclude,
  type LegacyPrescriptionDetail,
  type LegacyPrescriptionListRow,
  type PrescriptionDetailRecord,
} from "./prescriptionReadMapper";

let prismaSingleton: PrismaClient | null = null;

export interface DoctorReadRepoConfig {
  logger?: NdjsonLogger;
}

export interface DoctorReadActorInput {
  role: "DOCTOR";
  wpUserId: number;
}

export interface DoctorInboxQueryInput {
  actor: DoctorReadActorInput;
  status?: string | null;
  limit?: number;
  offset?: number;
}

export interface DoctorPrescriptionDetailInput {
  actor: DoctorReadActorInput;
  prescriptionId: string;
}

export class DoctorReadRepo {
  private readonly prisma: PrismaClient;
  private readonly logger?: NdjsonLogger;

  constructor(cfg: DoctorReadRepoConfig = {}) {
    this.prisma = getPrismaClient();
    this.logger = cfg.logger;
  }

  async queryInbox(input: DoctorInboxQueryInput): Promise<LegacyPrescriptionListRow[]> {
    const normalized = normalizeDoctorInboxQueryInput(input);

    try {
      const rows = await this.prisma.prescription.findMany({
        where: buildDoctorInboxWhere(normalized.actor.wpUserId, normalized.status),
        include: prescriptionListInclude,
        orderBy: [
          { createdAt: "desc" },
          { id: "desc" },
        ],
        take: normalized.limit,
        skip: normalized.offset,
      });

      return rows.map(mapPrescriptionListRow);
    } catch (err: unknown) {
      if (err instanceof PrescriptionReadRepoError) {
        throw err;
      }

      this.logger?.error(
        "doctor.inbox.repo_failed",
        {
          actor_wp_user_id: normalized.actor.wpUserId,
          status: normalized.status,
          limit: normalized.limit,
          offset: normalized.offset,
          reason: err instanceof Error ? err.message : "doctor_inbox_failed",
        },
        undefined,
        err,
      );

      throw new PrescriptionReadRepoError("ML_DOCTOR_INBOX_FAILED", 500, "doctor_inbox_failed");
    }
  }

  async getPrescriptionDetail(input: DoctorPrescriptionDetailInput): Promise<LegacyPrescriptionDetail> {
    const normalized = normalizeDoctorPrescriptionDetailInput(input);

    try {
      const record = await this.prisma.prescription.findFirst({
        where: {
          OR: [
            { id: normalized.prescriptionId },
            { uid: normalized.prescriptionId },
          ],
        },
        include: prescriptionDetailInclude,
      });

      if (!record) {
        throw new PrescriptionReadRepoError("ML_PRESCRIPTION_NOT_FOUND", 404, "prescription_not_found");
      }

      if (!canDoctorAccessPrescription(record, normalized.actor.wpUserId)) {
        throw new PrescriptionReadRepoError("ML_READ_FORBIDDEN", 403, "prescription_forbidden");
      }

      return mapPrescriptionDetail(record);
    } catch (err: unknown) {
      if (err instanceof PrescriptionReadRepoError) {
        throw err;
      }

      this.logger?.error(
        "doctor.prescription.repo_failed",
        {
          actor_wp_user_id: normalized.actor.wpUserId,
          prescription_id: normalized.prescriptionId,
          reason: err instanceof Error ? err.message : "doctor_prescription_get_failed",
        },
        undefined,
        err,
      );

      throw new PrescriptionReadRepoError("ML_PRESCRIPTION_GET_FAILED", 500, "doctor_prescription_get_failed");
    }
  }
}

function getPrismaClient(): PrismaClient {
  if (!prismaSingleton) {
    prismaSingleton = new PrismaClient();
  }

  return prismaSingleton;
}

function normalizeDoctorInboxQueryInput(input: DoctorInboxQueryInput): {
  actor: DoctorReadActorInput;
  status: string | null;
  limit: number;
  offset: number;
} {
  if (!input || typeof input !== "object") {
    throw new PrescriptionReadRepoError("ML_READ_BAD_REQUEST", 400, "doctor_inbox_input_required");
  }

  return {
    actor: normalizeDoctorActor(input.actor),
    status: normalizeStatusFilter(input.status),
    limit: normalizeLimit(input.limit),
    offset: normalizeOffset(input.offset),
  };
}

function normalizeDoctorPrescriptionDetailInput(input: DoctorPrescriptionDetailInput): {
  actor: DoctorReadActorInput;
  prescriptionId: string;
} {
  if (!input || typeof input !== "object") {
    throw new PrescriptionReadRepoError("ML_READ_BAD_REQUEST", 400, "doctor_detail_input_required");
  }

  return {
    actor: normalizeDoctorActor(input.actor),
    prescriptionId: normalizePrescriptionId(input.prescriptionId),
  };
}

function normalizeDoctorActor(actor: DoctorReadActorInput): DoctorReadActorInput {
  if (!actor || typeof actor !== "object") {
    throw new PrescriptionReadRepoError("ML_READ_BAD_REQUEST", 400, "actor_required");
  }

  if (actor.role !== "DOCTOR") {
    throw new PrescriptionReadRepoError("ML_READ_FORBIDDEN", 403, "doctor_actor_required");
  }

  const wpUserId = normalizePositiveInt(actor.wpUserId, "actor.wpUserId");
  return {
    role: "DOCTOR",
    wpUserId,
  };
}

function normalizePrescriptionId(value: unknown): string {
  if (typeof value !== "string") {
    throw new PrescriptionReadRepoError("ML_READ_BAD_REQUEST", 400, "prescription_id_required");
  }

  const normalized = value.trim();
  if (normalized === "" || normalized.length > 191) {
    throw new PrescriptionReadRepoError("ML_READ_BAD_REQUEST", 400, "prescription_id_invalid");
  }

  return normalized;
}

function normalizeStatusFilter(value: unknown): string | null {
  if (value == null || value === "") {
    return null;
  }

  if (typeof value !== "string") {
    throw new PrescriptionReadRepoError("ML_READ_BAD_REQUEST", 400, "status_invalid");
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "" || normalized === "all") {
    return null;
  }

  if (!["pending", "payment_pending", "approved", "rejected"].includes(normalized)) {
    throw new PrescriptionReadRepoError("ML_READ_BAD_REQUEST", 400, "status_invalid");
  }

  return normalized;
}

function normalizeLimit(value: unknown): number {
  if (value == null || value === "") {
    return 100;
  }

  const parsed = typeof value === "number" ? value : Number(value);
  if (!globalThis.Number.isFinite(parsed) || parsed <= 0) {
    throw new PrescriptionReadRepoError("ML_READ_BAD_REQUEST", 400, "limit_invalid");
  }

  return Math.min(200, Math.trunc(parsed));
}

function normalizeOffset(value: unknown): number {
  if (value == null || value === "") {
    return 0;
  }

  const parsed = typeof value === "number" ? value : Number(value);
  if (!globalThis.Number.isFinite(parsed) || parsed < 0) {
    throw new PrescriptionReadRepoError("ML_READ_BAD_REQUEST", 400, "offset_invalid");
  }

  return Math.trunc(parsed);
}

function normalizePositiveInt(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!globalThis.Number.isFinite(parsed) || parsed <= 0) {
    throw new PrescriptionReadRepoError("ML_READ_BAD_REQUEST", 400, `${field}_invalid`);
  }

  return Math.trunc(parsed);
}

function buildDoctorInboxWhere(doctorWpUserId: number, status: string | null): Prisma.PrescriptionWhereInput {
  const where: Prisma.PrescriptionWhereInput = {
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

function mapStatusFilterToWorkerStatuses(status: string | null): string[] | null {
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

function canDoctorAccessPrescription(record: PrescriptionDetailRecord, doctorWpUserId: number): boolean {
  if (record.doctor == null) {
    return true;
  }

  return record.doctor.wpUserId === doctorWpUserId;
}
