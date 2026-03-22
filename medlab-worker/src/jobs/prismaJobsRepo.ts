// src/jobs/prismaJobsRepo.ts
import { randomBytes, randomInt } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { NdjsonLogger } from "../logger";
import { base64UrlEncode, buildMls1Token } from "../security/mls1";
import type {
  ApprovePrescriptionRequest,
  ApprovePrescriptionResult,
  ClaimJobOptions,
  IngestDoctorInput,
  IngestPatientInput,
  IngestPrescriptionRequest,
  IngestPrescriptionResult,
  JobRow,
  JobStatus,
  JobsRepo,
  MarkDoneOptions,
  MarkFailedOptions,
  QueueMetrics,
  RejectPrescriptionRequest,
  RejectPrescriptionResult,
  RequeueWithBackoffOptions,
  SweepZombiesResult,
} from "./jobsRepo";

const CURRENT_INGEST_SCHEMA_VERSION = "2026.6";
const COMPAT_JOB_SCHEMA_VERSION = "2026.5";
const JOB_TYPE = "PDF_GEN";
const DEFAULT_PRIORITY = 50;
const DEFAULT_MAX_ATTEMPTS = 5;
const TX_MAX_WAIT_MS = 2_000;
const TX_TIMEOUT_MS = 5_000;
const UID_LENGTH = 10;
const VERIFY_TOKEN_BYTES = 24;
const WAITING_APPROVAL = "WAITING_APPROVAL";

interface PrismaJobsRepoConfig {
  siteId: string;
  workerId: string;
  hmacSecretActive: string;
  logger?: NdjsonLogger;
}

interface ClaimedPrescriptionRow {
  id: string;
  uid: string;
  status: string;
  processingStatus: string;
  availableAt: Date | null;
  claimedAt: Date | null;
  lockExpiresAt: Date | null;
  workerRef: string | null;
  attempts: number;
  maxAttempts: number;
  verifyToken: string | null;
  doctorId: string | null;
  patientId: string;
  sourceReqId: string | null;
  s3PdfKey: string | null;
}

interface IngestSelectRow {
  id: string;
  uid: string;
  status: string;
  processingStatus: string;
  verifyToken: string | null;
  verifyCode: string | null;
  sourceReqId: string | null;
}

interface DecisionSelectRow extends IngestSelectRow {}

export class PrismaJobsRepo implements JobsRepo {
  readonly mode = "postgres" as const;

  private readonly prisma: PrismaClient;
  private readonly siteId: string;
  private readonly workerId: string;
  private readonly hmacSecretActive: string;
  private readonly logger?: NdjsonLogger;
  private lastSweepAtMs = 0;

  constructor(cfg: PrismaJobsRepoConfig) {
    this.prisma = new PrismaClient();
    this.siteId = cfg.siteId;
    this.workerId = cfg.workerId;
    this.hmacSecretActive = cfg.hmacSecretActive;
    this.logger = cfg.logger;
  }

  getTableName(): string {
    return "Prescription";
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }

  async ingestPrescription(input: IngestPrescriptionRequest): Promise<IngestPrescriptionResult> {
    assertIngestRequest(input, this.siteId);

    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const created = await this.prisma.$transaction<IngestPrescriptionResult>(async (tx) => {
          const replay = await tx.prescription.findUnique({
            where: { sourceReqId: input.req_id },
            select: ingestSelect(),
          });

          if (replay) {
            return mapIngestResult(replay, "replay", input.req_id);
          }

          let doctorId: string | null = null;
          if (hasDoctorIdentity(input.doctor)) {
            const doctor = await tx.doctor.upsert({
              where: { wpUserId: normalizeRequiredInt(input.doctor!.wpUserId, "doctor.wpUserId") },
              create: buildDoctorCreate(input.doctor!),
              update: buildDoctorUpdate(input.doctor!),
              select: { id: true },
            });
            doctorId = doctor.id;
          }

          const patient = await tx.patient.create({
            data: buildPatientCreate(input.patient),
            select: { id: true },
          });

          const createdPrescription = await tx.prescription.create({
            data: {
              uid: generatePublicUid(),
              doctorId,
              patientId: patient.id,
              status: "PENDING",
              items: toInputJsonArray(input.prescription.items),
              privateNotes: normalizeNullableString(input.prescription.privateNotes),
              s3PdfKey: null,
              verifyCode: generateVerifyCode(),
              verifyToken: generateVerifyToken(),
              processingStatus: "PENDING",
              availableAt: new Date(),
              claimedAt: null,
              lockExpiresAt: null,
              workerRef: null,
              attempts: 0,
              maxAttempts: DEFAULT_MAX_ATTEMPTS,
              lastErrorCode: null,
              lastErrorMessageSafe: null,
              sourceReqId: input.req_id,
            },
            select: ingestSelect(),
          });

          return mapIngestResult(createdPrescription, "created", input.req_id);
        }, {
          maxWait: TX_MAX_WAIT_MS,
          timeout: TX_TIMEOUT_MS,
        });

        if (created.mode === "created") {
          this.logger?.info(
            "ingest.accepted",
            {
              job_id: created.job_id,
              prescription_uid: created.uid,
              processing_status: created.processing_status,
              source_req_id: created.source_req_id,
              doctor_wp_user_id: hasDoctorIdentity(input.doctor) ? input.doctor?.wpUserId : undefined,
            },
            input.req_id,
          );
        } else {
          this.logger?.info(
            "ingest.replayed",
            {
              job_id: created.job_id,
              prescription_uid: created.uid,
              processing_status: created.processing_status,
              source_req_id: created.source_req_id,
            },
            input.req_id,
          );
        }

        return created;
      } catch (err: unknown) {
        if (extractPrismaCode(err) !== "P2002") {
          throw err;
        }

        const existing = await this.prisma.prescription.findUnique({
          where: { sourceReqId: input.req_id },
          select: ingestSelect(),
        });

        if (existing) {
          const replay = mapIngestResult(existing, "replay", input.req_id);
          this.logger?.info(
            "ingest.replayed",
            {
              job_id: replay.job_id,
              prescription_uid: replay.uid,
              processing_status: replay.processing_status,
              source_req_id: replay.source_req_id,
            },
            input.req_id,
          );
          return replay;
        }

        if (attempt >= 5) {
          throw new Error("Failed to generate unique identifiers for prescription ingestion");
        }
      }
    }

    throw new Error("Unreachable ingestion state");
  }

  async approvePrescription(prescriptionId: string, input: ApprovePrescriptionRequest): Promise<ApprovePrescriptionResult> {
    assertDecisionRequest(input, this.siteId, "approve");
    const normalizedPrescriptionId = normalizeRequiredString(prescriptionId, "prescription_id");

    const result = await this.prisma.$transaction<ApprovePrescriptionResult>(async (tx) => {
      const existing = await tx.prescription.findUnique({
        where: { id: normalizedPrescriptionId },
        select: {
          ...ingestSelect(),
          doctorId: true,
        },
      });

      if (!existing) {
        throw new Error("prescription_id not found");
      }

      if (existing.status.toUpperCase() === "REJECTED") {
        throw new Error("prescription is rejected");
      }

      const doctor = await tx.doctor.upsert({
        where: { wpUserId: normalizeRequiredInt(input.doctor.wpUserId, "doctor.wpUserId") },
        create: buildDoctorCreate(input.doctor),
        update: buildDoctorUpdate(input.doctor),
        select: { id: true },
      });

      if (existing.status.toUpperCase() !== "APPROVED") {
        const updated = await tx.prescription.update({
          where: { id: normalizedPrescriptionId },
          data: {
            doctorId: doctor.id,
            status: "APPROVED",
            processingStatus: existing.processingStatus === WAITING_APPROVAL ? "PENDING" : normalizeDecisionProcessingStatus(existing.processingStatus),
            availableAt: new Date(),
            claimedAt: null,
            lockExpiresAt: null,
            workerRef: null,
            lastErrorCode: null,
            lastErrorMessageSafe: null,
          },
          select: ingestSelect(),
        });

        return mapApproveResult(updated, "approved", input.req_id);
      }

      const replay = await tx.prescription.update({
        where: { id: normalizedPrescriptionId },
        data: {
          doctorId: doctor.id,
        },
        select: ingestSelect(),
      });

      return mapApproveResult(replay, "replay", input.req_id);
    }, {
      maxWait: TX_MAX_WAIT_MS,
      timeout: TX_TIMEOUT_MS,
    });

    this.logger?.info(
      result.mode === "approved" ? "ingest.approved" : "ingest.approve_replayed",
      {
        job_id: result.job_id,
        prescription_uid: result.uid,
        processing_status: result.processing_status,
        source_req_id: result.source_req_id,
        doctor_wp_user_id: input.doctor.wpUserId,
      },
      input.req_id,
    );

    return result;
  }

  async rejectPrescription(prescriptionId: string, input: RejectPrescriptionRequest): Promise<RejectPrescriptionResult> {
    assertDecisionRequest(input, this.siteId, "reject");
    const normalizedPrescriptionId = normalizeRequiredString(prescriptionId, "prescription_id");
    const safeReason = normalizeNonEmptyString(input.reason, "Prescription rejected before rendering");

    const result = await this.prisma.$transaction<RejectPrescriptionResult>(async (tx) => {
      const existing = await tx.prescription.findUnique({
        where: { id: normalizedPrescriptionId },
        select: ingestSelect(),
      });

      if (!existing) {
        throw new Error("prescription_id not found");
      }

      if (existing.status.toUpperCase() === "REJECTED") {
        return mapRejectResult(existing, "replay", input.req_id);
      }

      const updated = await tx.prescription.update({
        where: { id: normalizedPrescriptionId },
        data: {
          status: "REJECTED",
          processingStatus: "FAILED",
          claimedAt: null,
          lockExpiresAt: null,
          workerRef: null,
          lastErrorCode: "ML_PRESCRIPTION_REJECTED",
          lastErrorMessageSafe: safeReason,
        },
        select: ingestSelect(),
      });

      return mapRejectResult(updated, "rejected", input.req_id);
    }, {
      maxWait: TX_MAX_WAIT_MS,
      timeout: TX_TIMEOUT_MS,
    });

    this.logger?.info(
      result.mode === "rejected" ? "ingest.rejected" : "ingest.reject_replayed",
      {
        job_id: result.job_id,
        prescription_uid: result.uid,
        processing_status: result.processing_status,
        source_req_id: result.source_req_id,
      },
      input.req_id,
    );

    return result;
  }

  async claimNextPendingJob(opts: ClaimJobOptions): Promise<JobRow | null> {
    if (opts.siteId !== this.siteId) {
      throw new Error("Claim siteId mismatch");
    }

    const nowMs = Date.now();
    if (nowMs - this.lastSweepAtMs >= 30_000) {
      this.lastSweepAtMs = nowMs;
      try {
        await this.sweepZombies(this.siteId, 100);
      } catch (err: unknown) {
        this.logger?.warning(
          "db.job.sweep_failed",
          { message: err instanceof Error ? err.message : "sweep_failed" },
          undefined,
        );
      }
    }

    const leaseSeconds = Math.max(30, Math.floor(opts.leaseMinutes * 60));

    const rows = await this.prisma.$transaction<Array<ClaimedPrescriptionRow>>(async (tx) => {
      return tx.$queryRaw<Array<ClaimedPrescriptionRow>>`
        WITH next_job AS (
          SELECT id
          FROM "Prescription"
          WHERE "processingStatus" = 'PENDING'
            AND "status" = 'APPROVED'
            AND "doctorId" IS NOT NULL
            AND COALESCE("availableAt", NOW()) <= NOW()
            AND ("lockExpiresAt" IS NULL OR "lockExpiresAt" <= NOW())
          ORDER BY COALESCE("availableAt", NOW()) ASC, "createdAt" ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE "Prescription" p
        SET
          "processingStatus" = 'CLAIMED',
          "workerRef" = ${opts.workerId},
          "claimedAt" = NOW(),
          "lockExpiresAt" = NOW() + (${leaseSeconds}::int * INTERVAL '1 second'),
          "attempts" = p."attempts" + 1,
          "updatedAt" = NOW()
        FROM next_job
        WHERE p.id = next_job.id
        RETURNING
          p.id,
          p.uid,
          p.status,
          p."processingStatus",
          p."availableAt",
          p."claimedAt",
          p."lockExpiresAt",
          p."workerRef",
          p."attempts",
          p."maxAttempts",
          p."verifyToken",
          p."doctorId",
          p."patientId",
          p."sourceReqId",
          p."s3PdfKey";
      `;
    }, {
      maxWait: 1_000,
      timeout: 3_000,
    });

    if (rows.length < 1) {
      return null;
    }

    const job = this.mapClaimedRowToJob(rows[0]);
    this.logger?.info(
      "db.job.claimed",
      {
        job_id: job.job_id,
        worker_ref: opts.workerId,
        attempts: job.attempts,
        max_attempts: job.max_attempts,
      },
      job.req_id ?? undefined,
    );

    return job;
  }

  async markDone(opts: MarkDoneOptions): Promise<void> {
    const updated = await this.prisma.prescription.updateMany({
      where: {
        id: opts.jobId,
        processingStatus: "CLAIMED",
        workerRef: opts.workerRef ?? this.workerId,
      },
      data: {
        processingStatus: "DONE",
        s3PdfKey: opts.s3KeyRef,
        claimedAt: null,
        lockExpiresAt: null,
        workerRef: null,
        lastErrorCode: null,
        lastErrorMessageSafe: null,
      },
    });

    if (updated.count !== 1) {
      throw new Error(`markDone lost job ownership for ${opts.jobId}`);
    }

    this.logger?.info(
      "db.job.done",
      {
        job_id: opts.jobId,
        worker_ref: opts.workerRef ?? this.workerId,
        s3_key_ref: opts.s3KeyRef,
        artifact_size_bytes: opts.artifactSizeBytes,
      },
      opts.reqId,
    );
  }

  async markFailed(opts: MarkFailedOptions): Promise<void> {
    const updated = await this.prisma.prescription.updateMany({
      where: {
        id: opts.jobId,
        processingStatus: "CLAIMED",
        workerRef: opts.workerRef ?? this.workerId,
      },
      data: {
        processingStatus: "FAILED",
        claimedAt: null,
        lockExpiresAt: null,
        workerRef: null,
        lastErrorCode: normalizeNonEmptyString(opts.errorCode, "ML_WORKER_FAILED"),
        lastErrorMessageSafe: normalizeNonEmptyString(opts.messageSafe, "Worker reported failure"),
      },
    });

    if (updated.count !== 1) {
      throw new Error(`markFailed lost job ownership for ${opts.jobId}`);
    }

    this.logger?.warning(
      "db.job.failed",
      {
        job_id: opts.jobId,
        worker_ref: opts.workerRef ?? this.workerId,
        error_code: opts.errorCode,
      },
      opts.reqId,
    );
  }

  async requeueWithBackoff(opts: RequeueWithBackoffOptions): Promise<void> {
    const delaySeconds = clampDelaySeconds(opts.delaySeconds);

    const rows = await this.prisma.$executeRaw`
      UPDATE "Prescription"
      SET
        "processingStatus" = 'PENDING',
        "claimedAt" = NULL,
        "lockExpiresAt" = NULL,
        "workerRef" = NULL,
        "availableAt" = NOW() + (${delaySeconds}::int * INTERVAL '1 second'),
        "lastErrorCode" = ${normalizeNonEmptyString(opts.errorCode, "ML_WORKER_RETRY")},
        "lastErrorMessageSafe" = ${normalizeNonEmptyString(opts.messageSafe, "Worker requested retry")},
        "updatedAt" = NOW()
      WHERE id = ${opts.jobId}
        AND "processingStatus" = 'CLAIMED'
        AND "workerRef" = ${opts.workerRef ?? this.workerId};
    `;

    if (Number(rows ?? 0) !== 1) {
      throw new Error(`requeueWithBackoff lost job ownership for ${opts.jobId}`);
    }

    this.logger?.warning(
      "db.job.requeued",
      {
        job_id: opts.jobId,
        worker_ref: opts.workerRef ?? this.workerId,
        delay_seconds: delaySeconds,
        error_code: opts.errorCode,
      },
      opts.reqId,
    );
  }

  async getQueueMetrics(siteId: string): Promise<QueueMetrics> {
    if (siteId !== this.siteId) {
      throw new Error("Queue metrics siteId mismatch");
    }

    const grouped = await this.prisma.prescription.groupBy({
      by: ["processingStatus"],
      _count: { _all: true },
      where: {
        OR: [
          { processingStatus: "PENDING", status: "APPROVED" },
          { processingStatus: "CLAIMED" },
        ],
      },
    });

    let pending = 0;
    let claimed = 0;
    for (const row of grouped) {
      if (row.processingStatus === "PENDING") {
        pending += row._count._all;
      } else if (row.processingStatus === "CLAIMED") {
        claimed += row._count._all;
      }
    }

    return { pending, claimed };
  }

  async sweepZombies(siteId: string, limit = 50): Promise<SweepZombiesResult> {
    if (siteId !== this.siteId) {
      throw new Error("Sweep siteId mismatch");
    }

    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));

    const failed = await this.prisma.$executeRaw<number>`
      WITH expired AS (
        SELECT id
        FROM "Prescription"
        WHERE "processingStatus" = 'CLAIMED'
          AND "lockExpiresAt" IS NOT NULL
          AND "lockExpiresAt" <= NOW()
          AND "attempts" >= "maxAttempts"
        ORDER BY "lockExpiresAt" ASC
        LIMIT ${safeLimit}
      )
      UPDATE "Prescription" p
      SET
        "processingStatus" = 'FAILED',
        "workerRef" = NULL,
        "claimedAt" = NULL,
        "lockExpiresAt" = NULL,
        "lastErrorCode" = 'ML_JOB_LEASE_EXPIRED',
        "lastErrorMessageSafe" = 'Claim lease expired after max attempts',
        "updatedAt" = NOW()
      FROM expired
      WHERE p.id = expired.id;
    `;

    const requeued = await this.prisma.$executeRaw<number>`
      WITH expired AS (
        SELECT id
        FROM "Prescription"
        WHERE "processingStatus" = 'CLAIMED'
          AND "lockExpiresAt" IS NOT NULL
          AND "lockExpiresAt" <= NOW()
          AND "attempts" < "maxAttempts"
        ORDER BY "lockExpiresAt" ASC
        LIMIT ${safeLimit}
      )
      UPDATE "Prescription" p
      SET
        "processingStatus" = 'PENDING',
        "workerRef" = NULL,
        "claimedAt" = NULL,
        "lockExpiresAt" = NULL,
        "availableAt" = NOW(),
        "lastErrorCode" = 'ML_JOB_LEASE_EXPIRED',
        "lastErrorMessageSafe" = 'Claim lease expired and job was requeued',
        "updatedAt" = NOW()
      FROM expired
      WHERE p.id = expired.id;
    `;

    const result = {
      requeued: Number(requeued ?? 0),
      failed: Number(failed ?? 0),
    };

    if (result.requeued > 0 || result.failed > 0) {
      this.logger?.warning("db.job.swept_zombies", result, undefined);
    }

    return result;
  }

  private mapClaimedRowToJob(row: ClaimedPrescriptionRow): JobRow {
    const payload = {
      schema_version: COMPAT_JOB_SCHEMA_VERSION,
      site_id: this.siteId,
      job: {
        job_id: row.id,
        prescription_id: row.id,
        prescription_uid: row.uid,
        doctor_id: row.doctorId,
        patient_id: row.patientId,
      },
    };

    const payloadJson = JSON.stringify(payload);
    const mls1Token = buildMls1Token(Buffer.from(payloadJson, "utf8"), this.hmacSecretActive);

    return {
      id: row.id,
      job_id: row.id,
      site_id: this.siteId,
      req_id: row.sourceReqId,
      job_type: JOB_TYPE,
      status: normalizeJobStatus(row.processingStatus),
      priority: DEFAULT_PRIORITY,
      available_at: toIsoOrNull(row.availableAt),
      rx_id: 0,
      nonce: "",
      kid: null,
      exp_ms: String(row.lockExpiresAt ? row.lockExpiresAt.getTime() : 0),
      payload,
      payload_json: payloadJson,
      mls1_token: mls1Token,
      s3_key_ref: row.s3PdfKey,
      attempts: row.attempts,
      max_attempts: row.maxAttempts,
      locked_at: toIsoOrNull(row.claimedAt),
      lock_expires_at: toIsoOrNull(row.lockExpiresAt),
      locked_by: row.workerRef,
      worker_ref: row.workerRef,
      verify_token: row.verifyToken,
      doctor_id: row.doctorId,
      patient_id: row.patientId,
      source_req_id: row.sourceReqId,
    };
  }
}

function ingestSelect() {
  return {
    id: true,
    uid: true,
    status: true,
    processingStatus: true,
    verifyToken: true,
    verifyCode: true,
    sourceReqId: true,
  } as const;
}

function mapIngestResult(row: IngestSelectRow, mode: "created" | "replay", reqId: string): IngestPrescriptionResult {
  return {
    mode,
    job_id: row.id,
    prescription_id: row.id,
    uid: row.uid,
    verify_token: row.verifyToken,
    verify_code: row.verifyCode,
    processing_status: normalizeJobStatus(row.processingStatus),
    status: typeof row.status === "string" && row.status !== "" ? row.status : "PENDING",
    source_req_id: row.sourceReqId ?? reqId,
  };
}

function mapApproveResult(row: DecisionSelectRow, mode: "approved" | "replay", reqId: string): ApprovePrescriptionResult {
  return {
    mode,
    job_id: row.id,
    prescription_id: row.id,
    uid: row.uid,
    verify_token: row.verifyToken,
    verify_code: row.verifyCode,
    processing_status: normalizeJobStatus(row.processingStatus),
    status: typeof row.status === "string" && row.status !== "" ? row.status : "APPROVED",
    source_req_id: row.sourceReqId ?? reqId,
  };
}

function mapRejectResult(row: DecisionSelectRow, mode: "rejected" | "replay", reqId: string): RejectPrescriptionResult {
  return {
    mode,
    job_id: row.id,
    prescription_id: row.id,
    uid: row.uid,
    verify_token: row.verifyToken,
    verify_code: row.verifyCode,
    processing_status: normalizeJobStatus(row.processingStatus),
    status: typeof row.status === "string" && row.status !== "" ? row.status : "REJECTED",
    source_req_id: row.sourceReqId ?? reqId,
  };
}

function buildDoctorCreate(input: IngestDoctorInput) {
  return {
    wpUserId: normalizeRequiredInt(input.wpUserId, "doctor.wpUserId"),
    firstName: normalizeNullableString(input.firstName),
    lastName: normalizeNullableString(input.lastName),
    email: normalizeNullableString(input.email),
    phone: normalizeNullableString(input.phone),
    title: normalizeNullableString(input.title),
    specialty: normalizeNullableString(input.specialty),
    rpps: normalizeNullableString(input.rpps),
    amNumber: normalizeNullableString(input.amNumber),
    address: normalizeNullableString(input.address),
    city: normalizeNullableString(input.city),
    zipCode: normalizeNullableString(input.zipCode),
    signatureS3Key: normalizeNullableString(input.signatureS3Key),
  };
}

function buildDoctorUpdate(input: IngestDoctorInput) {
  return {
    firstName: normalizeNullableString(input.firstName),
    lastName: normalizeNullableString(input.lastName),
    email: normalizeNullableString(input.email),
    phone: normalizeNullableString(input.phone),
    title: normalizeNullableString(input.title),
    specialty: normalizeNullableString(input.specialty),
    rpps: normalizeNullableString(input.rpps),
    amNumber: normalizeNullableString(input.amNumber),
    address: normalizeNullableString(input.address),
    city: normalizeNullableString(input.city),
    zipCode: normalizeNullableString(input.zipCode),
    signatureS3Key: normalizeNullableString(input.signatureS3Key),
  };
}

function buildPatientCreate(input: IngestPatientInput) {
  return {
    firstName: normalizeRequiredString(input.firstName, "patient.firstName"),
    lastName: normalizeRequiredString(input.lastName, "patient.lastName"),
    birthDate: normalizeRequiredString(input.birthDate, "patient.birthDate"),
    gender: normalizeNullableString(input.gender),
    email: normalizeNullableString(input.email),
    phone: normalizeNullableString(input.phone),
  };
}

function toInputJsonArray(value: unknown): Prisma.InputJsonValue {
  if (!Array.isArray(value)) {
    throw new Error("prescription.items must be an array");
  }

  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function generatePublicUid(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(UID_LENGTH);
  let out = "";
  for (let i = 0; i < UID_LENGTH; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

function generateVerifyCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function generateVerifyToken(): string {
  return base64UrlEncode(randomBytes(VERIFY_TOKEN_BYTES));
}

function clampDelaySeconds(value: number): number {
  return Math.max(1, Math.min(900, Math.floor(Number.isFinite(value) ? value : 30)));
}

function normalizeRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function normalizeRequiredInt(value: unknown, field: string): number {
  const n = typeof value === "number" ? Math.trunc(value) : Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return n;
}

function normalizeNullableString(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  const s = String(value).trim();
  return s === "" ? null : s;
}

function normalizeNonEmptyString(value: unknown, fallback: string): string {
  const s = normalizeNullableString(value);
  return s ?? fallback;
}

function normalizeDecisionProcessingStatus(value: unknown): "PENDING" | "CLAIMED" | "DONE" | "FAILED" {
  const raw = typeof value === "string" ? value.toUpperCase() : "";
  if (raw === "CLAIMED" || raw === "DONE" || raw === "FAILED") {
    return raw;
  }
  return "PENDING";
}

function normalizeJobStatus(value: unknown): JobStatus {
  const raw = typeof value === "string" ? value.toUpperCase() : "";
  if (raw === WAITING_APPROVAL || raw === "PENDING" || raw === "CLAIMED" || raw === "DONE" || raw === "FAILED") {
    return raw as JobStatus;
  }
  return "PENDING";
}

function toIsoOrNull(value: Date | null | undefined): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

function hasDoctorIdentity(value: IngestDoctorInput | null | undefined): value is IngestDoctorInput {
  if (!value || typeof value !== "object") {
    return false;
  }

  const n = typeof value.wpUserId === "number"
    ? Math.trunc(value.wpUserId)
    : Number.parseInt(String(value.wpUserId ?? ""), 10);

  return Number.isFinite(n) && n > 0;
}

function assertIngestRequest(input: IngestPrescriptionRequest, siteId: string): void {
  if (!input || typeof input !== "object") {
    throw new Error("Ingress payload is missing");
  }

  const acceptedSchemaVersions = new Set([CURRENT_INGEST_SCHEMA_VERSION, COMPAT_JOB_SCHEMA_VERSION]);
  if (!acceptedSchemaVersions.has(String(input.schema_version ?? ""))) {
    throw new Error("schema_version mismatch");
  }

  if (String(input.site_id ?? "") !== siteId) {
    throw new Error("site_id mismatch");
  }

  normalizeRequiredString(input.req_id, "req_id");
  normalizeRequiredString(input.nonce, "nonce");
  normalizeRequiredInt(input.ts_ms, "ts_ms");

  if (!input.patient || typeof input.patient !== "object") {
    throw new Error("patient block is required");
  }
  if (!input.prescription || typeof input.prescription !== "object") {
    throw new Error("prescription block is required");
  }

  if (input.doctor != null && typeof input.doctor !== "object") {
    throw new Error("doctor block must be an object when provided");
  }
  if (hasDoctorIdentity(input.doctor)) {
    normalizeRequiredInt(input.doctor.wpUserId, "doctor.wpUserId");
  }

  normalizeRequiredString(input.patient.firstName, "patient.firstName");
  normalizeRequiredString(input.patient.lastName, "patient.lastName");
  normalizeRequiredString(input.patient.birthDate, "patient.birthDate");

  if (!Array.isArray(input.prescription.items)) {
    throw new Error("prescription.items must be an array");
  }
}

function assertDecisionRequest(input: ApprovePrescriptionRequest | RejectPrescriptionRequest, siteId: string, mode: "approve" | "reject"): void {
  if (!input || typeof input !== "object") {
    throw new Error(`${mode} payload is missing`);
  }

  const acceptedSchemaVersions = new Set([CURRENT_INGEST_SCHEMA_VERSION, COMPAT_JOB_SCHEMA_VERSION]);
  if (!acceptedSchemaVersions.has(String(input.schema_version ?? ""))) {
    throw new Error("schema_version mismatch");
  }

  if (String(input.site_id ?? "") !== siteId) {
    throw new Error("site_id mismatch");
  }

  normalizeRequiredString(input.req_id, "req_id");
  normalizeRequiredString(input.nonce, "nonce");
  normalizeRequiredInt(input.ts_ms, "ts_ms");

  if (mode === "approve") {
    const approveInput = input as ApprovePrescriptionRequest;
    if (!approveInput.doctor || typeof approveInput.doctor !== "object") {
      throw new Error("doctor block is required");
    }
    normalizeRequiredInt(approveInput.doctor.wpUserId, "doctor.wpUserId");
  }
}

function extractPrismaCode(err: unknown): string | null {
  if (!err || typeof err !== "object") {
    return null;
  }

  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && code !== "" ? code : null;
}
