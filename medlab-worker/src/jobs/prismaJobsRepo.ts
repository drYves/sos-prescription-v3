// src/jobs/prismaJobsRepo.ts
import { randomBytes, randomInt } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
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
  JobsRepo,
  MarkDoneOptions,
  MarkFailedOptions,
  QueueMetrics,
  RequeueWithBackoffOptions,
  RejectPrescriptionRequest,
  RejectPrescriptionResult,
  SweepZombiesResult,
} from "./jobsRepo";

const CURRENT_INGEST_SCHEMA_VERSION = "2026.6";
const COMPAT_JOB_SCHEMA_VERSION = "2026.5";
const JOB_TYPE = "PDF_GEN";
const DEFAULT_PRIORITY = 50;
const DEFAULT_MAX_ATTEMPTS = 5;
const TX_MAX_WAIT_MS = 5_000;
const TX_TIMEOUT_MS = 15_000;
const UID_LENGTH = 10;
const VERIFY_TOKEN_BYTES = 24;
const DEFAULT_WP_CALLBACK_PATH_TEMPLATE = "/wp-json/sosprescription/v1/prescriptions/worker/{job_id}/callback";
const DEFAULT_CALLBACK_TIMEOUT_MS = 15_000;
const DEFAULT_CALLBACK_RETRIES = 3;

interface PrismaJobsRepoConfig {
  siteId: string;
  workerId: string;
  hmacSecretActive: string;
  wpBaseUrl?: string;
  wpCallbackPathTemplate?: string;
  requestTimeoutMs?: number;
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

interface CallbackJobPayload {
  job_id: string;
  prescription_id: string;
  status: "DONE" | "FAILED" | "PENDING";
  processing_status: string;
  worker_ref: string;
  source_req_id: string | null;
  s3_key_ref?: string;
  s3_bucket?: string;
  s3_region?: string;
  artifact_sha256_hex?: string;
  artifact_size_bytes?: number;
  artifact_content_type?: string;
  retry_after_seconds?: number;
  last_error_code?: string;
  last_error_message_safe?: string;
}

interface CallbackEnvelope {
  schema_version: string;
  site_id: string;
  ts_ms: number;
  nonce: string;
  req_id: string;
  job: CallbackJobPayload;
}

export class PrismaJobsRepo implements JobsRepo {
  readonly mode = "postgres" as const;

  private readonly prisma: PrismaClient;
  private readonly siteId: string;
  private readonly workerId: string;
  private readonly hmacSecretActive: string;
  private readonly logger?: NdjsonLogger;
  private readonly wpBaseUrl: string;
  private readonly wpCallbackPathTemplate: string;
  private readonly requestTimeoutMs: number;
  private lastSweepAtMs = 0;

  constructor(cfg: PrismaJobsRepoConfig) {
    this.prisma = new PrismaClient();
    this.siteId = cfg.siteId;
    this.workerId = cfg.workerId;
    this.hmacSecretActive = cfg.hmacSecretActive;
    this.logger = cfg.logger;
    this.wpBaseUrl = normalizeBaseUrl(cfg.wpBaseUrl ?? process.env.ML_WP_BASE_URL ?? "");
    this.wpCallbackPathTemplate = normalizePathTemplate(
      cfg.wpCallbackPathTemplate ?? process.env.WP_SHADOW_CALLBACK_PATH_TEMPLATE ?? DEFAULT_WP_CALLBACK_PATH_TEMPLATE,
      DEFAULT_WP_CALLBACK_PATH_TEMPLATE,
    );
    this.requestTimeoutMs = Math.max(1_000, Math.floor(cfg.requestTimeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS));
  }

  getTableName(): string {
    return "Prescription";
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }

  async ingestPrescription(input: IngestPrescriptionRequest): Promise<IngestPrescriptionResult> {
    assertIngestRequest(input, this.siteId);
    const doctorInput = normalizeOptionalDoctorInput(input.doctor);
    const canonicalItems = canonicalizePrescriptionItems(input.prescription.items);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        const created = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          const replay = await tx.prescription.findUnique({
            where: { sourceReqId: input.req_id },
            select: ingestSelect(),
          });

          if (replay) {
            return mapIngestResult(replay, "replay", input.req_id);
          }

          let finalDoctorId: string | null = null;

          if (doctorInput?.wpUserId != null && doctorInput.wpUserId > 0) {
            const doctor = await tx.doctor.upsert({
              where: { wpUserId: normalizeRequiredInt(doctorInput.wpUserId, "doctor.wpUserId") },
              create: buildDoctorCreate(doctorInput),
              update: buildDoctorUpdate(doctorInput),
              select: { id: true },
            });
            finalDoctorId = doctor.id;
          }

          const patient = await tx.patient.create({
            data: buildPatientCreate(input.patient),
            select: { id: true },
          });

          const createdPrescription = await tx.prescription.create({
            data: {
              uid: generatePublicUid(),
              doctorId: finalDoctorId,
              patientId: patient.id,
              status: "PENDING",
              items: toInputJsonArray(canonicalItems),
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
              doctor_wp_user_id: doctorInput?.wpUserId ?? null,
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

  async approvePrescription(
    prescriptionId: string,
    input: ApprovePrescriptionRequest,
  ): Promise<ApprovePrescriptionResult> {
    const safePrescriptionId = normalizeRequiredString(prescriptionId, "prescriptionId");
    const doctor = input.doctor;
    const reqId = input.req_id;
    const canonicalItems = Array.isArray(input.items) && input.items.length > 0
      ? canonicalizePrescriptionItems(input.items)
      : null;

    const updated = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const existing = await tx.prescription.findUnique({
        where: { id: safePrescriptionId },
        select: {
          ...ingestSelect(),
          doctorId: true,
        },
      });

      if (!existing) {
        throw new Error("Prescription not found");
      }

      let finalDoctorId = existing.doctorId;

      if (doctor && doctor.wpUserId != null && normalizeRequiredInt(doctor.wpUserId, "doctor.wpUserId") > 0) {
        const upsertedDoctor = await tx.doctor.upsert({
          where: { wpUserId: normalizeRequiredInt(doctor.wpUserId, "doctor.wpUserId") },
          create: buildDoctorCreate(doctor),
          update: buildDoctorUpdate(doctor),
          select: { id: true },
        });
        finalDoctorId = upsertedDoctor.id;
      }

      return tx.prescription.update({
        where: { id: safePrescriptionId },
        data: {
          status: "APPROVED",
          doctorId: finalDoctorId,
          items: canonicalItems ? toInputJsonArray(canonicalItems) : undefined,
          updatedAt: new Date(),
        },
        select: ingestSelect(),
      });
    }, {
      maxWait: TX_MAX_WAIT_MS,
      timeout: TX_TIMEOUT_MS,
    });

    const result = mapApproveResult(updated, reqId ?? updated.sourceReqId ?? safePrescriptionId);
    this.logger?.info(
      "ingest.approved",
      {
        job_id: result.job_id,
        prescription_uid: result.uid,
        processing_status: result.processing_status,
        source_req_id: result.source_req_id,
        doctor_wp_user_id: doctor?.wpUserId ?? null,
        items_count: canonicalItems ? canonicalItems.length : null,
      },
      reqId ?? updated.sourceReqId ?? undefined,
    );

    return result;
  }

  async rejectPrescription(
    prescriptionId: string,
    input: RejectPrescriptionRequest,
  ): Promise<RejectPrescriptionResult> {
    const safePrescriptionId = normalizeRequiredString(prescriptionId, "prescriptionId");
    const reason = input.reason;
    const reqId = input.req_id;

    const updated = await this.prisma.prescription.update({
      where: { id: safePrescriptionId },
      data: {
        status: "REJECTED",
        processingStatus: "FAILED",
        lastErrorCode: "ML_REJECTED_BY_DOCTOR",
        lastErrorMessageSafe: normalizeNullableString(reason) ?? "Prescription rejected by doctor",
        claimedAt: null,
        lockExpiresAt: null,
        workerRef: null,
      },
      select: ingestSelect(),
    });

    const result = mapRejectResult(updated, reqId ?? updated.sourceReqId ?? safePrescriptionId);
    this.logger?.warning(
      "ingest.rejected",
      {
        job_id: result.job_id,
        prescription_uid: result.uid,
        processing_status: result.processing_status,
        source_req_id: result.source_req_id,
      },
      reqId ?? updated.sourceReqId ?? undefined,
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

    const rows = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      return tx.$queryRaw<Array<ClaimedPrescriptionRow>>`
        WITH next_job AS (
          SELECT id
          FROM "Prescription"
          WHERE "status" = 'APPROVED'
            AND "processingStatus" = 'PENDING'
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
      maxWait: TX_MAX_WAIT_MS,
      timeout: TX_TIMEOUT_MS,
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
    const workerRef = opts.workerRef ?? this.workerId;
    const updated = await this.prisma.prescription.updateMany({
      where: {
        id: opts.jobId,
        processingStatus: "CLAIMED",
        workerRef,
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
        worker_ref: workerRef,
        s3_key_ref: opts.s3KeyRef,
        artifact_size_bytes: opts.artifactSizeBytes,
      },
      opts.reqId,
    );

    await this.notifyWordPressShadow(
      this.buildCallbackEnvelope({
        reqId: opts.reqId,
        job: {
          job_id: opts.jobId,
          prescription_id: opts.jobId,
          status: "DONE",
          processing_status: "DONE",
          worker_ref: workerRef,
          source_req_id: opts.reqId ?? null,
          s3_key_ref: opts.s3KeyRef,
          s3_bucket: opts.s3Bucket ?? "",
          s3_region: opts.s3Region ?? "",
          artifact_sha256_hex: opts.artifactSha256Hex,
          artifact_size_bytes: opts.artifactSizeBytes,
          artifact_content_type: opts.contentType,
        },
      }),
      opts.jobId,
      opts.reqId,
      "done",
    );
  }

  async markFailed(opts: MarkFailedOptions): Promise<void> {
    const workerRef = opts.workerRef ?? this.workerId;
    const errorCode = normalizeNonEmptyString(opts.errorCode, "ML_WORKER_FAILED");
    const messageSafe = normalizeNonEmptyString(opts.messageSafe, "Worker reported failure");

    const updated = await this.prisma.prescription.updateMany({
      where: {
        id: opts.jobId,
        processingStatus: "CLAIMED",
        workerRef,
      },
      data: {
        processingStatus: "FAILED",
        claimedAt: null,
        lockExpiresAt: null,
        workerRef: null,
        lastErrorCode: errorCode,
        lastErrorMessageSafe: messageSafe,
      },
    });

    if (updated.count !== 1) {
      throw new Error(`markFailed lost job ownership for ${opts.jobId}`);
    }

    this.logger?.error(
      "db.job.failed",
      {
        job_id: opts.jobId,
        worker_ref: workerRef,
        error_code: errorCode,
      },
      opts.reqId,
    );

    await this.notifyWordPressShadow(
      this.buildCallbackEnvelope({
        reqId: opts.reqId,
        job: {
          job_id: opts.jobId,
          prescription_id: opts.jobId,
          status: "FAILED",
          processing_status: "FAILED",
          worker_ref: workerRef,
          source_req_id: opts.reqId ?? null,
          last_error_code: errorCode,
          last_error_message_safe: messageSafe,
        },
      }),
      opts.jobId,
      opts.reqId,
      "failed",
    );
  }

  async requeueWithBackoff(opts: RequeueWithBackoffOptions): Promise<void> {
    const workerRef = opts.workerRef ?? this.workerId;
    const delaySeconds = clampDelaySeconds(opts.delaySeconds);
    const errorCode = normalizeNonEmptyString(opts.errorCode, "ML_WORKER_RETRY");
    const messageSafe = normalizeNonEmptyString(opts.messageSafe, "Worker retry scheduled");

    const updated = await this.prisma.prescription.updateMany({
      where: {
        id: opts.jobId,
        processingStatus: "CLAIMED",
        workerRef,
      },
      data: {
        processingStatus: "PENDING",
        availableAt: new Date(Date.now() + delaySeconds * 1_000),
        claimedAt: null,
        lockExpiresAt: null,
        workerRef: null,
        lastErrorCode: errorCode,
        lastErrorMessageSafe: messageSafe,
      },
    });

    if (updated.count !== 1) {
      throw new Error(`requeueWithBackoff lost job ownership for ${opts.jobId}`);
    }

    this.logger?.warning(
      "db.job.requeued",
      {
        job_id: opts.jobId,
        worker_ref: workerRef,
        delay_seconds: delaySeconds,
        error_code: errorCode,
      },
      opts.reqId,
    );

    await this.notifyWordPressShadow(
      this.buildCallbackEnvelope({
        reqId: opts.reqId,
        job: {
          job_id: opts.jobId,
          prescription_id: opts.jobId,
          status: "PENDING",
          processing_status: "PENDING",
          worker_ref: workerRef,
          source_req_id: opts.reqId ?? null,
          retry_after_seconds: delaySeconds,
          last_error_code: errorCode,
          last_error_message_safe: messageSafe,
        },
      }),
      opts.jobId,
      opts.reqId,
      "requeued",
    );
  }

  async getQueueMetrics(siteId: string): Promise<QueueMetrics> {
    if (siteId !== this.siteId) {
      throw new Error("Queue metrics siteId mismatch");
    }

    const [pending, claimed] = await Promise.all([
      this.prisma.prescription.count({ where: { status: "APPROVED", processingStatus: "PENDING" } }),
      this.prisma.prescription.count({ where: { status: "APPROVED", processingStatus: "CLAIMED" } }),
    ]);

    return {
      pending: Number(pending ?? 0),
      claimed: Number(claimed ?? 0),
    };
  }

  async sweepZombies(siteId: string, limit = 50): Promise<SweepZombiesResult> {
    if (siteId !== this.siteId) {
      throw new Error("Sweep siteId mismatch");
    }

    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));

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

  private buildCallbackEnvelope(input: { reqId?: string; job: CallbackJobPayload }): CallbackEnvelope {
    return {
      schema_version: CURRENT_INGEST_SCHEMA_VERSION,
      site_id: this.siteId,
      ts_ms: Date.now(),
      nonce: base64UrlEncode(randomBytes(16)),
      req_id: normalizeNonEmptyString(input.reqId, generateReqId()),
      job: input.job,
    };
  }

  private async notifyWordPressShadow(
    body: CallbackEnvelope,
    jobId: string,
    reqId: string | undefined,
    scope: "done" | "failed" | "requeued",
  ): Promise<void> {
    if (this.wpBaseUrl === "") {
      this.logger?.warning(
        "wp.shadow_callback.skipped",
        { job_id: jobId, reason: "wp_base_url_missing", scope },
        reqId,
      );
      return;
    }

    const path = renderPathTemplate(this.wpCallbackPathTemplate, jobId);
    const url = `${this.wpBaseUrl}${path}`;
    const rawJson = JSON.stringify(body);
    const token = buildMls1Token(Buffer.from(rawJson, "utf8"), this.hmacSecretActive);

    for (let attempt = 1; attempt <= DEFAULT_CALLBACK_RETRIES; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      timeout.unref?.();

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json; charset=utf-8",
            "X-MedLab-Signature": token,
          },
          body: rawJson,
          signal: controller.signal,
        });

        const responseText = await response.text();
        let decoded: Record<string, unknown> | null = null;
        try {
          decoded = JSON.parse(responseText) as Record<string, unknown>;
        } catch {
          decoded = null;
        }

        if (!response.ok || (decoded && decoded.ok === false)) {
          const code = decoded && typeof decoded.code === "string" ? decoded.code : `HTTP_${response.status}`;
          const message = decoded && typeof decoded.message === "string" ? decoded.message : response.statusText || "Callback rejected";
          throw new Error(`${code}: ${message}`);
        }

        this.logger?.info(
          "wp.shadow_callback.accepted",
          {
            job_id: jobId,
            scope,
            http_status: response.status,
            attempt,
          },
          reqId,
        );
        return;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "callback_failed";

        if (attempt >= DEFAULT_CALLBACK_RETRIES) {
          this.logger?.error(
            "wp.shadow_callback.failed",
            {
              job_id: jobId,
              scope,
              path,
              attempts: attempt,
              error: message,
            },
            reqId,
          );
          return;
        }

        this.logger?.warning(
          "wp.shadow_callback.retry",
          {
            job_id: jobId,
            scope,
            attempt,
            error: message,
          },
          reqId,
        );

        await sleep(attempt * 500);
      } finally {
        clearTimeout(timeout);
      }
    }
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

function mapApproveResult(row: IngestSelectRow, reqId: string): ApprovePrescriptionResult {
  return {
    mode: "approved",
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

function mapRejectResult(row: IngestSelectRow, reqId: string): RejectPrescriptionResult {
  return {
    mode: "rejected",
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
    weightKg: normalizeNullableString(input.weightKg ?? input.weight_kg),
  };
}



function canonicalizePrescriptionItems(items: unknown[]): Array<Record<string, unknown>> {
  return items.map((item, index) => canonicalizePrescriptionItem(item, index));
}

function canonicalizePrescriptionItem(item: unknown, index: number): Record<string, unknown> {
  const obj = asRecord(item);
  const raw = asRecord(obj.raw);
  const schedule = normalizeSchedulePayload(raw.schedule ?? obj.schedule);

  const label = firstNonEmptyString([
    obj.denomination,
    obj.label,
    obj.name,
    obj.medication,
    obj.drug,
    raw.label,
    raw.name,
  ]) || `Médicament ${index + 1}`;

  const quantite = normalizeNullableString(firstNonEmptyString([
    obj.quantite,
    obj.quantity,
    raw.quantite,
    raw.quantity,
  ]));

  const posologie = normalizeNullableString(firstNonEmptyString([
    obj.posologie,
    obj.instructions,
    obj.instruction,
    obj.dosage,
    obj.scheduleText,
    raw.posologie,
    raw.instructions,
    raw.scheduleText,
  ])) ?? normalizeNullableString(scheduleToCanonicalText(schedule));

  const durationLabel = normalizeNullableString(firstNonEmptyString([
    obj.duration_label,
    obj.durationLabel,
    obj.durationText,
    obj.duree,
    raw.duration_label,
    raw.durationLabel,
    raw.durationText,
  ])) ?? normalizeNullableString(scheduleToDurationLabel(schedule));

  const cis = sanitizeDigitsString(firstNonEmptyString([obj.cis, raw.cis]));
  const cip13 = sanitizeDigitsString(firstNonEmptyString([obj.cip13, raw.cip13]));
  const cip7 = sanitizeDigitsString(firstNonEmptyString([obj.cip7, raw.cip7]));

  const canonicalRaw: Record<string, unknown> = {
    ...raw,
    schedule,
  };
  if (posologie) {
    canonicalRaw.posologie = posologie;
    canonicalRaw.instructions = posologie;
    canonicalRaw.scheduleText = posologie;
  }
  if (durationLabel) {
    canonicalRaw.duration_label = durationLabel;
    canonicalRaw.durationLabel = durationLabel;
  }
  if (quantite) {
    canonicalRaw.quantite = quantite;
  }

  return {
    ...obj,
    line_no: toPositiveInt(obj.line_no ?? obj.lineNo ?? index + 1) || index + 1,
    cis: cis !== "" ? cis : null,
    cip13: cip13 !== "" ? cip13 : null,
    cip7: cip7 !== "" ? cip7 : null,
    label,
    denomination: firstNonEmptyString([obj.denomination, label]) || label,
    quantite,
    posologie,
    instructions: posologie,
    scheduleText: posologie,
    duration_label: durationLabel,
    durationLabel,
    schedule,
    raw: canonicalRaw,
  };
}

function normalizeSchedulePayload(value: unknown): Record<string, unknown> {
  const row = asRecord(value);
  if (Object.keys(row).length < 1) {
    return {};
  }

  const normalized: Record<string, unknown> = {};
  const nb = toPositiveInt(row.nb ?? row.timesPerDay);
  if (nb > 0) {
    normalized.nb = Math.min(nb, 12);
  }

  const freqUnit = normalizeFrequencyUnit(row.freqUnit ?? row.frequencyUnit ?? row.freq);
  if (freqUnit !== "") {
    normalized.freqUnit = freqUnit;
  }

  const durationVal = toPositiveInt(row.durationVal ?? row.durationValue ?? row.duration);
  if (durationVal > 0) {
    normalized.durationVal = Math.min(durationVal, 3650);
  }

  const durationUnit = normalizeFrequencyUnit(row.durationUnit ?? row.unit, true);
  if (durationUnit !== "") {
    normalized.durationUnit = durationUnit;
  }

  const times = coerceStringArray(row.times);
  if (times.length > 0) {
    normalized.times = times;
  }

  const doses = coerceStringArray(row.doses);
  if (doses.length > 0) {
    normalized.doses = doses;
  }

  const note = normalizeNullableString(row.note ?? row.text ?? row.label);
  if (note) {
    normalized.note = note;
  }

  const start = normalizeNullableString(row.start);
  if (start) {
    normalized.start = start;
  }

  const end = normalizeNullableString(row.end);
  if (end) {
    normalized.end = end;
  }

  const rounding = toPositiveInt(row.rounding);
  if (rounding > 0) {
    normalized.rounding = rounding;
  }

  if (typeof row.autoTimesEnabled === "boolean") {
    normalized.autoTimesEnabled = row.autoTimesEnabled;
  }

  const legacyMoments = ["morning", "noon", "evening", "bedtime", "everyHours", "timesPerDay", "asNeeded"];
  for (const key of legacyMoments) {
    if (!(key in normalized) && row[key] !== undefined) {
      normalized[key] = row[key];
    }
  }

  return normalized;
}

function scheduleToCanonicalText(schedule: Record<string, unknown>): string {
  const note = normalizeNullableString(schedule.note ?? schedule.text ?? schedule.label);
  const nb = toPositiveInt(schedule.nb ?? schedule.timesPerDay);
  const freqUnit = normalizeFrequencyUnit(schedule.freqUnit ?? schedule.frequencyUnit ?? schedule.freq);
  const times = coerceStringArray(schedule.times);
  const doses = coerceStringArray(schedule.doses);
  const inferredCount = Math.max(nb, times.length, doses.length);

  if (inferredCount > 0) {
    const baseUnit = freqUnit !== "" ? freqUnit : "jour";
    const details: string[] = [];
    for (let i = 0; i < inferredCount; i += 1) {
      const time = normalizeNullableString(times[i]);
      const dose = normalizeNullableString(doses[i]);
      if (!time && !dose) {
        continue;
      }
      details.push(`${dose ?? "1"}@${time ?? "--:--"}`);
    }

    let out = `${inferredCount > 1 ? `${inferredCount} fois` : "1 fois"} par ${baseUnit}`;
    if (details.length > 0) {
      out += ` (${details.join(", ")})`;
    }
    if (note) {
      out += `. ${note}`;
    }
    return out;
  }

  const parts: string[] = [];
  const legacyMomentMap: Array<[string, string]> = [
    ["morning", "matin"],
    ["noon", "midi"],
    ["evening", "soir"],
    ["bedtime", "coucher"],
  ];

  for (const [key, label] of legacyMomentMap) {
    const value = toPositiveInt(schedule[key]);
    if (value > 0) {
      parts.push(`${label}: ${value}`);
    }
  }

  const everyHours = toPositiveInt(schedule.everyHours);
  if (everyHours > 0) {
    parts.push(`Toutes les ${everyHours} h`);
  }

  const asNeeded = normalizeNullableString(schedule.asNeeded);
  if (asNeeded && ["1", "true", "yes", "oui"].includes(asNeeded.toLowerCase())) {
    parts.push("si besoin");
  }

  if (note) {
    parts.push(note);
  }

  return parts.join(" — ");
}

function scheduleToDurationLabel(schedule: Record<string, unknown>): string {
  const durationVal = toPositiveInt(schedule.durationVal ?? schedule.durationValue ?? schedule.duration);
  const durationUnit = normalizeFrequencyUnit(schedule.durationUnit ?? schedule.unit, true);
  if (durationVal < 1 || durationUnit === "") {
    return "";
  }
  return `${durationVal} ${pluralizeUnit(durationUnit, durationVal)}`;
}

function pluralizeUnit(unit: string, value: number): string {
  if (unit === "") {
    return "";
  }
  if (value <= 1 || unit === "mois") {
    return unit;
  }
  return `${unit}s`;
}

function normalizeFrequencyUnit(value: unknown, allowMonth = true): string {
  const raw = normalizeNullableString(value);
  if (!raw) {
    return "";
  }

  const normalized = raw.toLowerCase();
  if (["jour", "jours", "j", "day", "days"].includes(normalized)) {
    return "jour";
  }
  if (["semaine", "semaines", "sem", "week", "weeks"].includes(normalized)) {
    return "semaine";
  }
  if (allowMonth && ["mois", "month", "months"].includes(normalized)) {
    return "mois";
  }
  return "";
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => normalizeNullableString(entry) ?? "")
    .filter((entry) => entry !== "");
}

function firstNonEmptyString(values: unknown[]): string {
  for (const value of values) {
    const normalized = normalizeNullableString(value);
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function sanitizeDigitsString(value: string): string {
  return value.replace(/\D+/g, "");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toPositiveInt(value: unknown): number {
  const raw = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 0;
  }
  return Math.trunc(raw);
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
  for (let i = 0; i < UID_LENGTH; i += 1) {
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

function generateReqId(): string {
  return `req_${base64UrlEncode(randomBytes(8))}`;
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

function parsePositiveIntOrNull(value: unknown): number | null {
  if (value == null) {
    return null;
  }

  const raw = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return null;
  }

  return Math.trunc(raw);
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

function normalizeJobStatus(value: unknown): JobRow["status"] {
  const raw = typeof value === "string" ? value.toUpperCase() : "";
  if (raw === "PENDING" || raw === "CLAIMED" || raw === "DONE" || raw === "FAILED") {
    return raw;
  }
  return "PENDING";
}

function toIsoOrNull(value: Date | null | undefined): string | null {
  return value instanceof Date ? value.toISOString() : null;
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

  const doctor = normalizeOptionalDoctorInput(input.doctor);
  if (doctor?.wpUserId != null) {
    normalizeRequiredInt(doctor.wpUserId, "doctor.wpUserId");
  }

  if (!input.patient || typeof input.patient !== "object") {
    throw new Error("patient block is required");
  }
  if (!input.prescription || typeof input.prescription !== "object") {
    throw new Error("prescription block is required");
  }

  normalizeRequiredString(input.patient.firstName, "patient.firstName");
  normalizeRequiredString(input.patient.lastName, "patient.lastName");
  normalizeRequiredString(input.patient.birthDate, "patient.birthDate");

  if (!Array.isArray(input.prescription.items)) {
    throw new Error("prescription.items must be an array");
  }
}

function normalizeOptionalDoctorInput(value: unknown): IngestDoctorInput | null {
  if (value == null) {
    return null;
  }

  if (Array.isArray(value) || typeof value !== "object") {
    return null;
  }

  const row = value as Record<string, unknown>;
  const normalized: IngestDoctorInput = {
    wpUserId: parsePositiveIntOrNull(row.wpUserId),
    firstName: normalizeNullableString(row.firstName),
    lastName: normalizeNullableString(row.lastName),
    email: normalizeNullableString(row.email),
    phone: normalizeNullableString(row.phone),
    title: normalizeNullableString(row.title),
    specialty: normalizeNullableString(row.specialty),
    rpps: normalizeNullableString(row.rpps),
    amNumber: normalizeNullableString(row.amNumber),
    address: normalizeNullableString(row.address),
    city: normalizeNullableString(row.city),
    zipCode: normalizeNullableString(row.zipCode),
    signatureS3Key: normalizeNullableString(row.signatureS3Key),
  };

  const hasAnyValue = Object.values(normalized).some((entry) => entry != null && entry !== "");
  return hasAnyValue ? normalized : null;
}

function extractPrismaCode(err: unknown): string | null {
  if (!err || typeof err !== "object") {
    return null;
  }

  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && code !== "" ? code : null;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/g, "");
}

function normalizePathTemplate(value: string, fallback: string): string {
  const raw = value.trim();
  if (raw === "") {
    return fallback;
  }
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function renderPathTemplate(template: string, jobId: string): string {
  return template
    .replace(/\{job_id\}/g, encodeURIComponent(jobId))
    .replace(/\{prescription_id\}/g, encodeURIComponent(jobId));
}
