import { ActorRole, Prisma, PrismaClient } from "@prisma/client";
import { NdjsonLogger } from "../logger";
import { CopilotService, type GenerateSmartRepliesResult, type SmartReplyOption } from "./copilotService";

const TX_MAX_WAIT_MS = 5_000;
const TX_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ATTEMPTS = 4;
const JOB_TABLE = "SmartReplyJob";
const RESULT_TABLE = "SmartReplySuggestion";

export interface SmartReplyServiceConfig {
  siteId: string;
  copilot: CopilotService;
  prisma?: PrismaClient;
  logger?: NdjsonLogger;
}

export interface EnqueueSmartReplyJobInput {
  prescriptionId: string;
  messageId: string;
  reqId?: string;
}

export interface ClaimSmartReplyJobOptions {
  workerId: string;
  leaseMinutes: number;
}

export interface SmartReplyJobRecord {
  id: string;
  siteId: string;
  prescriptionId: string;
  messageId: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  availableAt: Date | null;
  claimedAt: Date | null;
  lockExpiresAt: Date | null;
  workerRef: string | null;
  reqId: string | null;
  payload: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  lastErrorCode: string | null;
  lastErrorMessageSafe: string | null;
}

export interface LatestSmartReplyRecord {
  prescriptionId: string;
  messageId: string;
  replies: SmartReplyOption[];
  riskFlags: string[];
  provider: string | null;
  model: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface SmartReplyJobDbRow {
  id: string;
  siteId: string;
  prescriptionId: string;
  messageId: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  availableAt: Date | null;
  claimedAt: Date | null;
  lockExpiresAt: Date | null;
  workerRef: string | null;
  reqId: string | null;
  payload: unknown;
  result: unknown;
  lastErrorCode: string | null;
  lastErrorMessageSafe: string | null;
}

interface SmartReplySuggestionDbRow {
  prescriptionId: string;
  messageId: string;
  replies: unknown;
  riskFlags: unknown;
  provider: string | null;
  model: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface LoadedReplyContext {
  prescriptionId: string;
  messageId: string;
  patientMessage: string;
  cisList: string[];
  medicationLabels: string[];
  threadPreview: Array<{
    authorRole: "PATIENT" | "DOCTOR" | "SYSTEM";
    body: string;
  }>;
}

export class SmartReplyService {
  private readonly prisma: PrismaClient;
  private readonly siteId: string;
  private readonly copilot: CopilotService;
  private readonly logger?: NdjsonLogger;
  private readonly ownsClient: boolean;
  private schemaReadyPromise: Promise<void> | null = null;

  constructor(cfg: SmartReplyServiceConfig) {
    this.prisma = cfg.prisma ?? new PrismaClient();
    this.siteId = normalizeRequiredString(cfg.siteId, "siteId");
    this.copilot = cfg.copilot;
    this.logger = cfg.logger;
    this.ownsClient = !cfg.prisma;
  }

  async close(): Promise<void> {
    if (!this.ownsClient) {
      return;
    }

    await this.prisma.$disconnect();
  }

  async ensureSchema(): Promise<void> {
    if (this.schemaReadyPromise) {
      await this.schemaReadyPromise;
      return;
    }

    this.schemaReadyPromise = this.createSchema().catch((err: unknown) => {
      this.schemaReadyPromise = null;
      throw err;
    });
    await this.schemaReadyPromise;
  }

  async enqueueGenerateSmartReplies(input: EnqueueSmartReplyJobInput): Promise<void> {
    await this.ensureSchema();

    const prescriptionId = normalizeRequiredString(input.prescriptionId, "prescriptionId");
    const messageId = normalizeRequiredString(input.messageId, "messageId");
    const reqId = normalizeOptionalString(input.reqId) ?? null;
    const payloadJson = JSON.stringify({ kind: "generate_smart_replies" });

    await this.prisma.$executeRaw`
      INSERT INTO "SmartReplyJob" (
        "id",
        "siteId",
        "prescriptionId",
        "messageId",
        "status",
        "attempts",
        "maxAttempts",
        "availableAt",
        "claimedAt",
        "lockExpiresAt",
        "workerRef",
        "reqId",
        "payload",
        "result",
        "lastErrorCode",
        "lastErrorMessageSafe",
        "createdAt",
        "updatedAt"
      ) VALUES (
        ${randomId()},
        ${this.siteId},
        ${prescriptionId},
        ${messageId},
        'PENDING',
        0,
        ${DEFAULT_MAX_ATTEMPTS},
        NOW(),
        NULL,
        NULL,
        NULL,
        ${reqId},
        CAST(${payloadJson} AS jsonb),
        NULL,
        NULL,
        NULL,
        NOW(),
        NOW()
      )
      ON CONFLICT ("siteId", "messageId")
      DO UPDATE SET
        "reqId" = EXCLUDED."reqId",
        "payload" = EXCLUDED."payload",
        "status" = CASE
          WHEN "SmartReplyJob"."status" = 'FAILED' THEN 'PENDING'
          ELSE "SmartReplyJob"."status"
        END,
        "availableAt" = CASE
          WHEN "SmartReplyJob"."status" = 'FAILED' THEN NOW()
          ELSE "SmartReplyJob"."availableAt"
        END,
        "claimedAt" = CASE
          WHEN "SmartReplyJob"."status" = 'FAILED' THEN NULL
          ELSE "SmartReplyJob"."claimedAt"
        END,
        "lockExpiresAt" = CASE
          WHEN "SmartReplyJob"."status" = 'FAILED' THEN NULL
          ELSE "SmartReplyJob"."lockExpiresAt"
        END,
        "workerRef" = CASE
          WHEN "SmartReplyJob"."status" = 'FAILED' THEN NULL
          ELSE "SmartReplyJob"."workerRef"
        END,
        "lastErrorCode" = CASE
          WHEN "SmartReplyJob"."status" = 'FAILED' THEN NULL
          ELSE "SmartReplyJob"."lastErrorCode"
        END,
        "lastErrorMessageSafe" = CASE
          WHEN "SmartReplyJob"."status" = 'FAILED' THEN NULL
          ELSE "SmartReplyJob"."lastErrorMessageSafe"
        END,
        "updatedAt" = NOW()
    `;
  }

  async claimNextPendingJob(opts: ClaimSmartReplyJobOptions): Promise<SmartReplyJobRecord | null> {
    await this.ensureSchema();

    const workerId = normalizeRequiredString(opts.workerId, "workerId");
    const leaseSeconds = Math.max(30, Math.floor(opts.leaseMinutes * 60));

    const rows = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      return tx.$queryRaw<Array<SmartReplyJobDbRow>>`
        WITH next_job AS (
          SELECT "id"
          FROM "SmartReplyJob"
          WHERE "siteId" = ${this.siteId}
            AND "status" = 'PENDING'
            AND COALESCE("availableAt", NOW()) <= NOW()
            AND ("lockExpiresAt" IS NULL OR "lockExpiresAt" <= NOW())
          ORDER BY COALESCE("availableAt", NOW()) ASC, "createdAt" ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE "SmartReplyJob" j
        SET
          "status" = 'CLAIMED',
          "workerRef" = ${workerId},
          "claimedAt" = NOW(),
          "lockExpiresAt" = NOW() + (${leaseSeconds}::int * INTERVAL '1 second'),
          "attempts" = j."attempts" + 1,
          "updatedAt" = NOW()
        FROM next_job
        WHERE j."id" = next_job."id"
        RETURNING
          j."id",
          j."siteId",
          j."prescriptionId",
          j."messageId",
          j."status",
          j."attempts",
          j."maxAttempts",
          j."availableAt",
          j."claimedAt",
          j."lockExpiresAt",
          j."workerRef",
          j."reqId",
          j."payload",
          j."result",
          j."lastErrorCode",
          j."lastErrorMessageSafe";
      `;
    }, {
      maxWait: TX_MAX_WAIT_MS,
      timeout: TX_TIMEOUT_MS,
    });

    if (rows.length < 1) {
      return null;
    }

    return mapSmartReplyJob(rows[0]);
  }

  async processJob(job: SmartReplyJobRecord): Promise<void> {
    const reqId = job.reqId ?? undefined;

    try {
      const context = await this.loadContext(job);
      if (!context) {
        await this.markDone({
          jobId: job.id,
          workerRef: job.workerRef ?? undefined,
          reqId,
          result: {
            skipped: "message_not_found_or_not_patient",
          },
        });
        return;
      }

      const generated = await this.copilot.generateSmartReplies({
        patientMessage: context.patientMessage,
        cisList: context.cisList,
        medicationLabels: context.medicationLabels,
        threadPreview: context.threadPreview,
      });

      await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await this.persistSuggestionsTx(tx, context, generated);
        await this.markDoneTx(tx, {
          jobId: job.id,
          workerRef: job.workerRef ?? undefined,
          result: {
            replies_count: generated.replies.length,
            risk_flags: generated.risk_flags,
            provider: generated.provider ?? null,
            model: generated.model ?? null,
          },
        });
      }, {
        maxWait: TX_MAX_WAIT_MS,
        timeout: TX_TIMEOUT_MS,
      });

      this.logger?.info(
        "smart_replies.generated",
        {
          job_id: job.id,
          prescription_id: job.prescriptionId,
          message_id: job.messageId,
          replies_count: generated.replies.length,
          risk_flags: generated.risk_flags,
        },
        reqId,
      );
    } catch (err: unknown) {
      const classification = classifyProcessingError(err, job);
      if (classification.retryable) {
        await this.requeue({
          jobId: job.id,
          workerRef: job.workerRef ?? undefined,
          reqId,
          delaySeconds: classification.delaySeconds,
          errorCode: classification.code,
          messageSafe: classification.message,
        });
        this.logger?.warning(
          "smart_replies.requeued",
          {
            job_id: job.id,
            prescription_id: job.prescriptionId,
            message_id: job.messageId,
            code: classification.code,
            delay_seconds: classification.delaySeconds,
          },
          reqId,
          err instanceof Error ? err : undefined,
        );
        return;
      }

      await this.markFailed({
        jobId: job.id,
        workerRef: job.workerRef ?? undefined,
        reqId,
        errorCode: classification.code,
        messageSafe: classification.message,
      });
      this.logger?.error(
        "smart_replies.failed",
        {
          job_id: job.id,
          prescription_id: job.prescriptionId,
          message_id: job.messageId,
          code: classification.code,
        },
        reqId,
        err instanceof Error ? err : undefined,
      );
    }
  }

  async getLatestReplies(prescriptionId: string): Promise<LatestSmartReplyRecord | null> {
    await this.ensureSchema();
    const safePrescriptionId = normalizeRequiredString(prescriptionId, "prescriptionId");

    const rows = await this.prisma.$queryRaw<Array<SmartReplySuggestionDbRow>>`
      SELECT
        s."prescriptionId",
        s."messageId",
        s."replies",
        s."riskFlags",
        s."provider",
        s."model",
        s."createdAt",
        s."updatedAt"
      FROM "SmartReplySuggestion" s
      WHERE s."prescriptionId" = ${safePrescriptionId}
      ORDER BY s."createdAt" DESC
      LIMIT 1
    `;

    if (rows.length < 1) {
      return null;
    }

    const row = rows[0];
    return {
      prescriptionId: row.prescriptionId,
      messageId: row.messageId,
      replies: normalizeRepliesJson(row.replies),
      riskFlags: normalizeStringArray(row.riskFlags),
      provider: row.provider,
      model: row.model,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private async createSchema(): Promise<void> {
    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "${JOB_TABLE}" (
        "id" TEXT PRIMARY KEY,
        "siteId" TEXT NOT NULL,
        "prescriptionId" TEXT NOT NULL,
        "messageId" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'PENDING',
        "attempts" INTEGER NOT NULL DEFAULT 0,
        "maxAttempts" INTEGER NOT NULL DEFAULT ${DEFAULT_MAX_ATTEMPTS},
        "availableAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "claimedAt" TIMESTAMPTZ NULL,
        "lockExpiresAt" TIMESTAMPTZ NULL,
        "workerRef" TEXT NULL,
        "reqId" TEXT NULL,
        "payload" JSONB NULL,
        "result" JSONB NULL,
        "lastErrorCode" TEXT NULL,
        "lastErrorMessageSafe" TEXT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "${JOB_TABLE}_unique_message" ON "${JOB_TABLE}" ("siteId", "messageId")`);
    await this.prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "${JOB_TABLE}_claim_idx" ON "${JOB_TABLE}" ("siteId", "status", "availableAt", "lockExpiresAt")`);
    await this.prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "${JOB_TABLE}_prescription_idx" ON "${JOB_TABLE}" ("prescriptionId")`);

    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "${RESULT_TABLE}" (
        "id" TEXT PRIMARY KEY,
        "prescriptionId" TEXT NOT NULL,
        "messageId" TEXT NOT NULL,
        "replies" JSONB NOT NULL,
        "riskFlags" JSONB NOT NULL DEFAULT '[]'::jsonb,
        "provider" TEXT NULL,
        "model" TEXT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "${RESULT_TABLE}_message_idx" ON "${RESULT_TABLE}" ("messageId")`);
    await this.prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "${RESULT_TABLE}_prescription_idx" ON "${RESULT_TABLE}" ("prescriptionId", "createdAt")`);
  }

  private async loadContext(job: SmartReplyJobRecord): Promise<LoadedReplyContext | null> {
    const message = await this.prisma.prescriptionMessage.findUnique({
      where: { id: job.messageId },
      select: {
        id: true,
        prescriptionId: true,
        seq: true,
        authorRole: true,
        body: true,
      },
    });

    if (!message || message.authorRole !== ActorRole.PATIENT) {
      return null;
    }

    const prescription = await this.prisma.prescription.findUnique({
      where: { id: job.prescriptionId },
      select: {
        id: true,
        items: true,
      },
    });

    if (!prescription) {
      throw new Error("ML_SMART_REPLY_PRESCRIPTION_NOT_FOUND");
    }

    const threadRows = await this.prisma.prescriptionMessage.findMany({
      where: {
        prescriptionId: job.prescriptionId,
        seq: {
          lte: message.seq,
        },
      },
      orderBy: {
        seq: "desc",
      },
      take: 6,
      select: {
        authorRole: true,
        body: true,
      },
    });

    const medicationContext = extractMedicationContext(prescription.items);

    return {
      prescriptionId: prescription.id,
      messageId: message.id,
      patientMessage: message.body,
      cisList: medicationContext.cisList,
      medicationLabels: medicationContext.medicationLabels,
      threadPreview: threadRows
        .reverse()
        .map((row: { authorRole: ActorRole; body: string }) => ({
          authorRole: row.authorRole,
          body: row.body,
        })),
    };
  }

  private async persistSuggestionsTx(
    tx: Prisma.TransactionClient,
    context: LoadedReplyContext,
    generated: GenerateSmartRepliesResult,
  ): Promise<void> {
    const repliesJson = JSON.stringify(generated.replies);
    const riskFlagsJson = JSON.stringify(generated.risk_flags);

    await tx.$executeRaw`
      INSERT INTO "SmartReplySuggestion" (
        "id",
        "prescriptionId",
        "messageId",
        "replies",
        "riskFlags",
        "provider",
        "model",
        "createdAt",
        "updatedAt"
      ) VALUES (
        ${randomId()},
        ${context.prescriptionId},
        ${context.messageId},
        CAST(${repliesJson} AS jsonb),
        CAST(${riskFlagsJson} AS jsonb),
        ${generated.provider ?? null},
        ${generated.model ?? null},
        NOW(),
        NOW()
      )
      ON CONFLICT ("messageId")
      DO UPDATE SET
        "replies" = EXCLUDED."replies",
        "riskFlags" = EXCLUDED."riskFlags",
        "provider" = EXCLUDED."provider",
        "model" = EXCLUDED."model",
        "updatedAt" = NOW()
    `;
  }

  private async markDone(opts: {
    jobId: string;
    workerRef?: string;
    reqId?: string;
    result?: Record<string, unknown>;
  }): Promise<void> {
    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await this.markDoneTx(tx, opts);
    }, {
      maxWait: TX_MAX_WAIT_MS,
      timeout: TX_TIMEOUT_MS,
    });
  }

  private async markDoneTx(
    tx: Prisma.TransactionClient,
    opts: {
      jobId: string;
      workerRef?: string;
      result?: Record<string, unknown>;
    },
  ): Promise<void> {
    const workerRef = opts.workerRef ?? null;
    const resultJson = opts.result ? JSON.stringify(opts.result) : null;
    const updated = await tx.$executeRaw`
      UPDATE "SmartReplyJob"
      SET
        "status" = 'DONE',
        "claimedAt" = NULL,
        "lockExpiresAt" = NULL,
        "workerRef" = NULL,
        "lastErrorCode" = NULL,
        "lastErrorMessageSafe" = NULL,
        "result" = CASE
          WHEN ${resultJson} IS NULL THEN "result"
          ELSE CAST(${resultJson} AS jsonb)
        END,
        "updatedAt" = NOW()
      WHERE "id" = ${opts.jobId}
        AND "status" = 'CLAIMED'
        AND COALESCE("workerRef", '') = COALESCE(${workerRef}, '')
    `;

    if (updated !== 1) {
      throw new Error(`markSmartReplyDone lost job ownership for ${opts.jobId}`);
    }
  }

  private async markFailed(opts: {
    jobId: string;
    workerRef?: string;
    reqId?: string;
    errorCode: string;
    messageSafe: string;
  }): Promise<void> {
    const workerRef = opts.workerRef ?? null;
    const updated = await this.prisma.$executeRaw`
      UPDATE "SmartReplyJob"
      SET
        "status" = 'FAILED',
        "claimedAt" = NULL,
        "lockExpiresAt" = NULL,
        "workerRef" = NULL,
        "lastErrorCode" = ${opts.errorCode},
        "lastErrorMessageSafe" = ${opts.messageSafe},
        "updatedAt" = NOW()
      WHERE "id" = ${opts.jobId}
        AND "status" = 'CLAIMED'
        AND COALESCE("workerRef", '') = COALESCE(${workerRef}, '')
    `;

    if (updated !== 1) {
      throw new Error(`markSmartReplyFailed lost job ownership for ${opts.jobId}`);
    }
  }

  private async requeue(opts: {
    jobId: string;
    workerRef?: string;
    reqId?: string;
    delaySeconds: number;
    errorCode: string;
    messageSafe: string;
  }): Promise<void> {
    const workerRef = opts.workerRef ?? null;
    const delaySeconds = Math.max(5, Math.floor(opts.delaySeconds));
    const updated = await this.prisma.$executeRaw`
      UPDATE "SmartReplyJob"
      SET
        "status" = 'PENDING',
        "claimedAt" = NULL,
        "lockExpiresAt" = NULL,
        "workerRef" = NULL,
        "availableAt" = NOW() + (${delaySeconds}::int * INTERVAL '1 second'),
        "lastErrorCode" = ${opts.errorCode},
        "lastErrorMessageSafe" = ${opts.messageSafe},
        "updatedAt" = NOW()
      WHERE "id" = ${opts.jobId}
        AND "status" = 'CLAIMED'
        AND COALESCE("workerRef", '') = COALESCE(${workerRef}, '')
    `;

    if (updated !== 1) {
      throw new Error(`requeueSmartReplyJob lost job ownership for ${opts.jobId}`);
    }
  }
}

function classifyProcessingError(
  err: unknown,
  job: SmartReplyJobRecord,
): { retryable: boolean; code: string; message: string; delaySeconds: number } {
  const attempts = Math.max(1, job.attempts);
  const delaySeconds = Math.min(300, Math.max(15, attempts * 30));
  const message = err instanceof Error ? err.message : "smart replies failed";
  const normalized = String(message).toLowerCase();

  const retryable = (
    normalized === "ml_ai_timeout"
    || normalized === "ml_ai_bad_json"
    || normalized.startsWith("ml_ai_upstream_failed:")
    || normalized.includes("fetch failed")
    || normalized.includes("network")
  ) && job.attempts < job.maxAttempts;

  const code = normalized.startsWith("ml_")
    ? String(message).split(":")[0].toUpperCase()
    : "ML_SMART_REPLY_FAILED";

  return {
    retryable,
    code,
    message: safeMessage(message),
    delaySeconds,
  };
}

function mapSmartReplyJob(row: SmartReplyJobDbRow): SmartReplyJobRecord {
  return {
    id: row.id,
    siteId: row.siteId,
    prescriptionId: row.prescriptionId,
    messageId: row.messageId,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    availableAt: row.availableAt,
    claimedAt: row.claimedAt,
    lockExpiresAt: row.lockExpiresAt,
    workerRef: row.workerRef,
    reqId: row.reqId,
    payload: asNullableRecord(row.payload),
    result: asNullableRecord(row.result),
    lastErrorCode: row.lastErrorCode,
    lastErrorMessageSafe: row.lastErrorMessageSafe,
  };
}

function extractMedicationContext(value: unknown): { cisList: string[]; medicationLabels: string[] } {
  if (!Array.isArray(value)) {
    return { cisList: [], medicationLabels: [] };
  }

  const cisSet = new Set<string>();
  const labelSet = new Set<string>();

  for (const entry of value) {
    const row = asRecord(entry);
    const raw = asRecord(row.raw);
    const cis = sanitizeDigitsString(firstNonEmptyString([row.cis, raw.cis]));
    const label = normalizeOptionalString(firstNonEmptyString([
      row.label,
      row.denomination,
      row.name,
      raw.label,
      raw.name,
    ]));

    if (cis !== "") {
      cisSet.add(cis);
    }
    if (label) {
      labelSet.add(label);
    }
  }

  return {
    cisList: Array.from(cisSet).slice(0, 20),
    medicationLabels: Array.from(labelSet).slice(0, 20),
  };
}

function normalizeRepliesJson(value: unknown): SmartReplyOption[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const out: SmartReplyOption[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const row = entry as Record<string, unknown>;
    const type = normalizeOptionalString(row.type);
    const title = normalizeOptionalString(row.title);
    const body = normalizeOptionalString(row.body);
    if (!type || !title || !body) {
      continue;
    }
    if (type !== "clarification" && type !== "confirmation" && type !== "refus_poli") {
      continue;
    }
    out.push({ type, title, body });
  }

  return out;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => normalizeOptionalString(entry) ?? "")
    .filter((entry) => entry !== "");
}

function normalizeRequiredString(value: unknown, field: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new Error(`${field} is required`);
  }
  return normalized;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
}

function safeMessage(message: string): string {
  const normalized = String(message ?? "").trim() || "smart replies failed";
  return normalized.length > 300 ? `${normalized.slice(0, 300)}…` : normalized;
}

function firstNonEmptyString(values: unknown[]): string {
  for (const value of values) {
    const normalized = normalizeOptionalString(value);
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
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function asNullableRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}
