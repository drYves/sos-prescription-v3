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

export interface PatientReadRepoConfig {
  logger?: NdjsonLogger;
}

export interface PatientReadActorInput {
  role: "PATIENT";
  wpUserId: number;
}

export interface PatientPrescriptionsQueryInput {
  actor: PatientReadActorInput;
  status?: string | null;
  limit?: number;
  offset?: number;
}

export interface PatientPrescriptionDetailInput {
  actor: PatientReadActorInput;
  prescriptionId: string;
}

export class PatientReadRepo {
  private readonly prisma: PrismaClient;
  private readonly logger?: NdjsonLogger;

  constructor(cfg: PatientReadRepoConfig = {}) {
    this.prisma = getPrismaClient();
    this.logger = cfg.logger;
  }

  async queryPrescriptions(input: PatientPrescriptionsQueryInput): Promise<LegacyPrescriptionListRow[]> {
    const normalized = normalizePatientPrescriptionsQueryInput(input);

    try {
      const rows = await this.prisma.prescription.findMany({
        where: buildPatientPrescriptionsWhere(normalized.actor.wpUserId, normalized.status),
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
        "patient.prescriptions.repo_failed",
        {
          actor_wp_user_id: normalized.actor.wpUserId,
          status: normalized.status,
          limit: normalized.limit,
          offset: normalized.offset,
          reason: err instanceof Error ? err.message : "patient_prescriptions_failed",
        },
        undefined,
        err,
      );

      throw new PrescriptionReadRepoError("ML_PATIENT_PRESCRIPTIONS_FAILED", 500, "patient_prescriptions_failed");
    }
  }

  async getPrescriptionDetail(input: PatientPrescriptionDetailInput): Promise<LegacyPrescriptionDetail> {
    const normalized = normalizePatientPrescriptionDetailInput(input);

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

      if (!canPatientAccessPrescription(record, normalized.actor.wpUserId)) {
        throw new PrescriptionReadRepoError("ML_READ_FORBIDDEN", 403, "prescription_forbidden");
      }

      return mapPrescriptionDetail(record);
    } catch (err: unknown) {
      if (err instanceof PrescriptionReadRepoError) {
        throw err;
      }

      this.logger?.error(
        "patient.prescription.repo_failed",
        {
          actor_wp_user_id: normalized.actor.wpUserId,
          prescription_id: normalized.prescriptionId,
          reason: err instanceof Error ? err.message : "patient_prescription_get_failed",
        },
        undefined,
        err,
      );

      throw new PrescriptionReadRepoError("ML_PRESCRIPTION_GET_FAILED", 500, "patient_prescription_get_failed");
    }
  }
}

function getPrismaClient(): PrismaClient {
  if (!prismaSingleton) {
    prismaSingleton = new PrismaClient();
  }

  return prismaSingleton;
}

function normalizePatientPrescriptionsQueryInput(input: PatientPrescriptionsQueryInput): {
  actor: PatientReadActorInput;
  status: string | null;
  limit: number;
  offset: number;
} {
  if (!input || typeof input !== "object") {
    throw new PrescriptionReadRepoError("ML_READ_BAD_REQUEST", 400, "patient_query_input_required");
  }

  return {
    actor: normalizePatientActor(input.actor),
    status: normalizeStatusFilter(input.status),
    limit: normalizeLimit(input.limit),
    offset: normalizeOffset(input.offset),
  };
}

function normalizePatientPrescriptionDetailInput(input: PatientPrescriptionDetailInput): {
  actor: PatientReadActorInput;
  prescriptionId: string;
} {
  if (!input || typeof input !== "object") {
    throw new PrescriptionReadRepoError("ML_READ_BAD_REQUEST", 400, "patient_detail_input_required");
  }

  return {
    actor: normalizePatientActor(input.actor),
    prescriptionId: normalizePrescriptionId(input.prescriptionId),
  };
}

function normalizePatientActor(actor: PatientReadActorInput): PatientReadActorInput {
  if (!actor || typeof actor !== "object") {
    throw new PrescriptionReadRepoError("ML_READ_BAD_REQUEST", 400, "actor_required");
  }

  if (actor.role !== "PATIENT") {
    throw new PrescriptionReadRepoError("ML_READ_FORBIDDEN", 403, "patient_actor_required");
  }

  const wpUserId = normalizePositiveInt(actor.wpUserId, "actor.wpUserId");
  return {
    role: "PATIENT",
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

function buildPatientPrescriptionsWhere(patientWpUserId: number, status: string | null): Prisma.PrescriptionWhereInput {
  const where: Prisma.PrescriptionWhereInput = {
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

function canPatientAccessPrescription(record: PrescriptionDetailRecord, patientWpUserId: number): boolean {
  return record.patient.wpUserId === patientWpUserId;
}
