import crypto from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { NdjsonLogger } from "../logger";
import { PrescriptionReadRepoError } from "./prescriptionReadMapper";

let prismaSingleton: PrismaClient | null = null;

const ROW_REV_HASH_LENGTH = 24;
const COLLECTION_HASH_LENGTH = 32;

export interface PatientPulseRepoConfig {
  logger?: NdjsonLogger;
}

export interface PatientPulseActorInput {
  role: "PATIENT";
  wpUserId: number;
}

export interface PatientPrescriptionsPulseInput {
  actor: PatientPulseActorInput;
  knownCollectionHash?: string | null;
}

export interface PatientPrescriptionPulseItem {
  id: string;
  uid: string;
  row_rev: string;
  status: string;
  processing_status: string;
  updated_at: string;
  last_activity_at: string;
  message_count: number;
  last_message_seq: number;
  unread_count_patient: number;
  has_proof: boolean;
  proof_count: number;
  pdf_ready: boolean;
}

export interface PatientPrescriptionsPulseResult {
  count: number;
  max_updated_at: string | null;
  collection_hash: string;
  unchanged: boolean;
  items: PatientPrescriptionPulseItem[];
}

const patientPulseSelect = Prisma.validator<Prisma.PrescriptionSelect>()({
  id: true,
  uid: true,
  status: true,
  processingStatus: true,
  updatedAt: true,
  lastMessageAt: true,
  messageCount: true,
  lastMessageSeq: true,
  unreadCountPatient: true,
  hasProof: true,
  proofCount: true,
  s3PdfKey: true,
});

type PatientPulseRecord = Prisma.PrescriptionGetPayload<{ select: typeof patientPulseSelect }>;

type HydratedPatientPulseItem = PatientPrescriptionPulseItem & {
  __updatedAtMs: number;
  __lastActivityAtMs: number;
};

export class PatientPulseRepo {
  private readonly prisma: PrismaClient;
  private readonly logger?: NdjsonLogger;

  constructor(cfg: PatientPulseRepoConfig = {}) {
    this.prisma = getPrismaClient();
    this.logger = cfg.logger;
  }

  async queryPulse(input: PatientPrescriptionsPulseInput): Promise<PatientPrescriptionsPulseResult> {
    const normalized = normalizePatientPulseInput(input);

    try {
      const rows = await this.prisma.prescription.findMany({
        where: buildPatientPrescriptionsWhere(normalized.actor.wpUserId),
        select: patientPulseSelect,
        orderBy: [
          { updatedAt: "desc" },
          { id: "desc" },
        ],
      });

      const items = rows
        .map(mapPatientPulseRow)
        .sort(compareHydratedPatientPulseItems)
        .map(stripHydratedPatientPulseItem);

      const maxUpdatedAt = resolveMaxUpdatedAt(items);
      const collectionHash = buildCollectionHash(items, maxUpdatedAt);
      const unchanged = normalized.knownCollectionHash !== null && normalized.knownCollectionHash === collectionHash;

      return {
        count: items.length,
        max_updated_at: maxUpdatedAt,
        collection_hash: collectionHash,
        unchanged,
        items,
      };
    } catch (err: unknown) {
      if (err instanceof PrescriptionReadRepoError) {
        throw err;
      }

      this.logger?.error(
        "patient.pulse.repo_failed",
        {
          actor_wp_user_id: normalized.actor.wpUserId,
          known_collection_hash_present: normalized.knownCollectionHash !== null,
          reason: err instanceof Error ? err.message : "patient_pulse_failed",
        },
        undefined,
        err,
      );

      throw new PrescriptionReadRepoError("ML_PATIENT_PULSE_FAILED", 500, "patient_pulse_failed");
    }
  }
}

function getPrismaClient(): PrismaClient {
  if (!prismaSingleton) {
    prismaSingleton = new PrismaClient();
  }

  return prismaSingleton;
}

function normalizePatientPulseInput(input: PatientPrescriptionsPulseInput): {
  actor: PatientPulseActorInput;
  knownCollectionHash: string | null;
} {
  if (!input || typeof input !== "object") {
    throw new PrescriptionReadRepoError("ML_READ_BAD_REQUEST", 400, "patient_pulse_input_required");
  }

  return {
    actor: normalizePatientActor(input.actor),
    knownCollectionHash: normalizeKnownCollectionHash(input.knownCollectionHash),
  };
}

function normalizePatientActor(actor: PatientPulseActorInput): PatientPulseActorInput {
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

function normalizeKnownCollectionHash(value: unknown): string | null {
  if (value == null || value === "") {
    return null;
  }

  if (typeof value !== "string") {
    throw new PrescriptionReadRepoError("ML_READ_BAD_REQUEST", 400, "known_collection_hash_invalid");
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "" || normalized.length > 128 || !/^[a-f0-9]{12,128}$/.test(normalized)) {
    throw new PrescriptionReadRepoError("ML_READ_BAD_REQUEST", 400, "known_collection_hash_invalid");
  }

  return normalized;
}

function normalizePositiveInt(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!globalThis.Number.isFinite(parsed) || parsed <= 0) {
    throw new PrescriptionReadRepoError("ML_READ_BAD_REQUEST", 400, `${field}_invalid`);
  }

  return Math.trunc(parsed);
}

function buildPatientPrescriptionsWhere(patientWpUserId: number): Prisma.PrescriptionWhereInput {
  return {
    patient: {
      is: {
        wpUserId: patientWpUserId,
      },
    },
  };
}

function mapPatientPulseRow(record: PatientPulseRecord): HydratedPatientPulseItem {
  const updatedAtIso = record.updatedAt.toISOString();
  const lastActivityAt = record.lastMessageAt ?? record.updatedAt;
  const lastActivityAtIso = lastActivityAt.toISOString();
  const proofCount = Math.max(0, record.proofCount, record.hasProof ? 1 : 0);
  const itemBase = {
    id: record.id,
    uid: record.uid,
    status: mapBusinessStatus(record.status),
    processing_status: normalizeProcessingStatus(record.processingStatus),
    updated_at: updatedAtIso,
    last_activity_at: lastActivityAtIso,
    message_count: Math.max(0, record.messageCount),
    last_message_seq: Math.max(0, record.lastMessageSeq),
    unread_count_patient: Math.max(0, record.unreadCountPatient),
    has_proof: record.hasProof || proofCount > 0,
    proof_count: proofCount,
    pdf_ready: normalizeNullableString(record.s3PdfKey) !== null,
  } satisfies Omit<PatientPrescriptionPulseItem, "row_rev">;

  return {
    ...itemBase,
    row_rev: buildRowRevision(itemBase),
    __updatedAtMs: record.updatedAt.getTime(),
    __lastActivityAtMs: lastActivityAt.getTime(),
  };
}

function compareHydratedPatientPulseItems(a: HydratedPatientPulseItem, b: HydratedPatientPulseItem): number {
  if (a.__lastActivityAtMs !== b.__lastActivityAtMs) {
    return b.__lastActivityAtMs - a.__lastActivityAtMs;
  }
  if (a.__updatedAtMs !== b.__updatedAtMs) {
    return b.__updatedAtMs - a.__updatedAtMs;
  }
  return b.id.localeCompare(a.id);
}

function stripHydratedPatientPulseItem(item: HydratedPatientPulseItem): PatientPrescriptionPulseItem {
  return {
    id: item.id,
    uid: item.uid,
    row_rev: item.row_rev,
    status: item.status,
    processing_status: item.processing_status,
    updated_at: item.updated_at,
    last_activity_at: item.last_activity_at,
    message_count: item.message_count,
    last_message_seq: item.last_message_seq,
    unread_count_patient: item.unread_count_patient,
    has_proof: item.has_proof,
    proof_count: item.proof_count,
    pdf_ready: item.pdf_ready,
  };
}

function resolveMaxUpdatedAt(items: PatientPrescriptionPulseItem[]): string | null {
  let maxValue: string | null = null;
  for (const item of items) {
    if (maxValue == null || item.updated_at > maxValue) {
      maxValue = item.updated_at;
    }
  }
  return maxValue;
}

function buildRowRevision(item: Omit<PatientPrescriptionPulseItem, "row_rev">): string {
  const material = [
    `id=${item.id}`,
    `uid=${item.uid}`,
    `status=${item.status}`,
    `processing_status=${item.processing_status}`,
    `updated_at=${item.updated_at}`,
    `last_activity_at=${item.last_activity_at}`,
    `message_count=${item.message_count}`,
    `last_message_seq=${item.last_message_seq}`,
    `unread_count_patient=${item.unread_count_patient}`,
    `has_proof=${item.has_proof ? "1" : "0"}`,
    `proof_count=${item.proof_count}`,
    `pdf_ready=${item.pdf_ready ? "1" : "0"}`,
  ].join("|");

  return hashHex(material, ROW_REV_HASH_LENGTH);
}

function buildCollectionHash(items: PatientPrescriptionPulseItem[], maxUpdatedAt: string | null): string {
  const material = [
    `count=${items.length}`,
    `max_updated_at=${maxUpdatedAt ?? ""}`,
    `items=${items.map((item) => `${item.id}:${item.row_rev}`).sort().join(",")}`,
  ].join("|");

  return hashHex(material, COLLECTION_HASH_LENGTH);
}

function hashHex(value: string, length: number): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, length).toLowerCase();
}

function mapBusinessStatus(value: string): string {
  const normalized = String(value ?? "").trim().toUpperCase();
  switch (normalized) {
    case "PENDING":
      return "pending";
    case "APPROVED":
      return "approved";
    case "REJECTED":
      return "rejected";
    default:
      return normalized !== "" ? normalized.toLowerCase() : "pending";
  }
}

function normalizeProcessingStatus(value: string): string {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (normalized === "PENDING" || normalized === "CLAIMED" || normalized === "DONE" || normalized === "FAILED") {
    return normalized;
  }

  return normalized !== "" ? normalized : "PENDING";
}

function normalizeNullableString(value: unknown): string | null {
  if (value == null) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized === "" ? null : normalized;
}
