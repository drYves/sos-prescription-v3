// src/jobs/restJobsRepo.ts
import { randomBytes } from "node:crypto";
import { URL } from "node:url";
import { NdjsonLogger } from "../logger";
import { base64UrlEncode, buildMls1Token } from "../security/mls1";
import type {
  ClaimJobOptions,
  IngestPrescriptionRequest,
  IngestPrescriptionResult,
  JobRow,
  JobStatus,
  JobsRepo,
  MarkDoneOptions,
  MarkFailedOptions,
  QueueMetrics,
  RequeueWithBackoffOptions,
  SweepZombiesResult,
  UpdateJobStatusInput,
} from "./jobsRepo";

export type {
  ClaimJobOptions,
  IngestPrescriptionRequest,
  IngestPrescriptionResult,
  JobRow,
  JobStatus,
  JobsRepo,
  MarkDoneOptions,
  MarkFailedOptions,
  QueueMetrics,
  RequeueWithBackoffOptions,
  SweepZombiesResult,
  UpdateJobStatusInput,
} from "./jobsRepo";

const BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const BROWSER_ACCEPT_LANGUAGE = "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7";
const BROWSER_ACCEPT_ENCODING = "gzip, deflate, br";
const API_ACCEPT = "application/json, text/plain, */*";

export interface RestJobsRepoConfig {
  siteId: string;
  wpBaseUrl: string;
  claimPath: string;
  callbackPathTemplate: string;
  hmacSecretActive: string;
  requestTimeoutMs: number;
  logger?: NdjsonLogger;
}

export class RestJobsRepo implements JobsRepo {
  readonly mode = "rest" as const;

  private readonly siteId: string;
  private readonly wpBaseUrl: string;
  private readonly claimPath: string;
  private readonly callbackPathTemplate: string;
  private readonly hmacSecretActive: string;
  private readonly requestTimeoutMs: number;
  private readonly logger?: NdjsonLogger;

  constructor(cfg: RestJobsRepoConfig) {
    this.siteId = cfg.siteId;
    this.wpBaseUrl = normalizeBaseUrl(cfg.wpBaseUrl);
    this.claimPath = normalizeApiPath(cfg.claimPath);
    this.callbackPathTemplate = normalizeApiPath(cfg.callbackPathTemplate);
    this.hmacSecretActive = cfg.hmacSecretActive;
    this.requestTimeoutMs = Math.max(1_000, cfg.requestTimeoutMs);
    this.logger = cfg.logger;
  }

  getTableName(): string {
    return `REST:${this.claimPath}`;
  }

  async claimNextPendingJob(opts: ClaimJobOptions): Promise<JobRow | null> {
    const url = this.buildAbsoluteUrl(this.claimPath);
    const body = this.buildClaimBody(opts);
    const rawBody = Buffer.from(JSON.stringify(body));

    const res = await this.fetchJson(url, {
      method: "POST",
      headers: {
        accept: API_ACCEPT,
        "content-type": "application/json; charset=utf-8",
        "x-medlab-signature": buildMls1Token(rawBody, this.hmacSecretActive),
      },
      body: rawBody,
    });

    if (res.status === 204) {
      return null;
    }

    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Claim failed with HTTP ${res.status}${res.errorMessage ? `: ${res.errorMessage}` : ""}`);
    }

    if (!res.data || typeof res.data !== "object") {
      throw new Error("Claim endpoint returned an invalid payload");
    }

    const rawJob = (res.data as { job?: unknown }).job;
    if (rawJob == null) {
      return null;
    }

    const job = this.normalizeJobRow(rawJob);
    if (job.site_id !== opts.siteId) {
      throw new Error("Claimed job site_id mismatch");
    }

    return job;
  }

  async markDone(opts: MarkDoneOptions): Promise<void> {
    await this.updateJobStatus({
      jobId: opts.jobId,
      reqId: opts.reqId,
      workerRef: opts.workerRef,
      status: "DONE",
      s3KeyRef: opts.s3KeyRef,
      s3Bucket: opts.s3Bucket,
      s3Region: opts.s3Region,
      artifactSha256Hex: opts.artifactSha256Hex,
      artifactSizeBytes: opts.artifactSizeBytes,
      artifactContentType: opts.contentType,
    });
  }

  async markFailed(opts: MarkFailedOptions): Promise<void> {
    await this.updateJobStatus({
      jobId: opts.jobId,
      reqId: opts.reqId,
      workerRef: opts.workerRef,
      status: "FAILED",
      errorCode: opts.errorCode,
      lastErrorMessageSafe: opts.messageSafe,
    });
  }

  async requeueWithBackoff(opts: RequeueWithBackoffOptions): Promise<void> {
    await this.updateJobStatus({
      jobId: opts.jobId,
      reqId: opts.reqId,
      workerRef: opts.workerRef,
      status: "PENDING",
      retryAfterSeconds: opts.delaySeconds,
      errorCode: opts.errorCode,
      lastErrorMessageSafe: opts.messageSafe,
    });
  }

  async getQueueMetrics(_siteId: string): Promise<QueueMetrics> {
    return { pending: 0, claimed: 0 };
  }

  async sweepZombies(_siteId: string, _limit = 50): Promise<SweepZombiesResult> {
    return { requeued: 0, failed: 0 };
  }

  async ingestPrescription(_input: IngestPrescriptionRequest): Promise<IngestPrescriptionResult> {
    throw new Error("Ingress is not available when QUEUE_MODE=rest");
  }

  async close(): Promise<void> {
    // no-op
  }

  private async updateJobStatus(input: UpdateJobStatusInput): Promise<void> {
    const url = this.buildAbsoluteUrl(this.renderCallbackPath(input.jobId));
    const body = this.buildCallbackBody(input);
    const rawBody = Buffer.from(JSON.stringify(body));

    const res = await this.fetchJson(url, {
      method: "POST",
      headers: {
        accept: API_ACCEPT,
        "content-type": "application/json; charset=utf-8",
        "x-medlab-signature": buildMls1Token(rawBody, this.hmacSecretActive),
      },
      body: rawBody,
    });

    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Callback failed with HTTP ${res.status}${res.errorMessage ? `: ${res.errorMessage}` : ""}`);
    }
  }

  private buildClaimBody(opts: ClaimJobOptions): Record<string, unknown> {
    const tsMs = Date.now();
    const nonce = base64UrlEncode(randomBytes(16));

    return {
      schema_version: "2026.5",
      site_id: opts.siteId,
      ts_ms: tsMs,
      nonce,
      worker_ref: opts.workerId,
      lease_seconds: Math.max(30, opts.leaseMinutes * 60),
    };
  }

  private buildCallbackBody(input: UpdateJobStatusInput): Record<string, unknown> {
    const tsMs = Date.now();
    const nonce = base64UrlEncode(randomBytes(16));

    const job: Record<string, unknown> = {
      job_id: input.jobId,
      status: input.status,
    };

    if (input.workerRef) {
      job.worker_ref = input.workerRef;
    }

    if (input.status === "DONE") {
      job.s3_key_ref = input.s3KeyRef ?? "";
      job.s3_bucket = input.s3Bucket ?? "";
      job.s3_region = input.s3Region ?? "";
      job.artifact_sha256_hex = input.artifactSha256Hex ?? "";
      job.artifact_size_bytes = input.artifactSizeBytes ?? 0;
      job.artifact_content_type = input.artifactContentType ?? "application/pdf";
      job.artifact = {
        s3_key_ref: input.s3KeyRef ?? "",
        s3_bucket: input.s3Bucket ?? "",
        s3_region: input.s3Region ?? "",
        sha256_hex: input.artifactSha256Hex ?? "",
        size_bytes: input.artifactSizeBytes ?? 0,
        content_type: input.artifactContentType ?? "application/pdf",
      };
    }

    if (input.status === "FAILED" || input.status === "PENDING") {
      job.last_error_code = input.errorCode ?? "ML_WORKER_FAILED";
      job.last_error_message_safe = input.lastErrorMessageSafe ?? "Worker reported failure";
      job.error = {
        code: input.errorCode ?? "ML_WORKER_FAILED",
        message_safe: input.lastErrorMessageSafe ?? "Worker reported failure",
      };
    }

    if (input.status === "PENDING") {
      job.retry_after_seconds = Math.max(1, Math.min(900, Math.floor(input.retryAfterSeconds ?? 30)));
    }

    return {
      schema_version: "2026.5",
      site_id: this.siteId,
      ts_ms: tsMs,
      nonce,
      req_id: input.reqId ?? null,
      worker_ref: input.workerRef ?? null,
      job,
    };
  }

  private renderCallbackPath(jobId: string): string {
    return this.callbackPathTemplate.replace("{job_id}", encodeURIComponent(jobId));
  }

  private buildAbsoluteUrl(path: string): URL {
    return new URL(path, `${this.wpBaseUrl}/`);
  }

  private buildBrowserLikeHeaders(acceptValue = API_ACCEPT): Record<string, string> {
    return {
      accept: acceptValue,
      "accept-language": BROWSER_ACCEPT_LANGUAGE,
      "accept-encoding": BROWSER_ACCEPT_ENCODING,
      "cache-control": "no-cache",
      pragma: "no-cache",
      "user-agent": BROWSER_USER_AGENT,
    };
  }

  private async fetchJson(
    url: URL,
    init: { method: string; headers: Record<string, string>; body?: Buffer },
  ): Promise<{ status: number; data: unknown; text: string; errorMessage: string | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    (timer as NodeJS.Timeout).unref?.();

    try {
      const headers: Record<string, string> = {
        ...this.buildBrowserLikeHeaders(API_ACCEPT),
        ...init.headers,
      };

      const response = await fetch(url, {
        method: init.method,
        headers,
        body: init.body,
        signal: controller.signal,
      });

      const text = response.status === 204 ? "" : await response.text();
      const data = text !== "" ? safeJsonParse(text) : null;
      const errorMessage = extractErrorMessage(data, text);

      if (!response.ok && this.logger) {
        this.logger.warning(
          "rest.bridge.http_error",
          {
            method: init.method,
            path: url.pathname,
            status: response.status,
            error_message: errorMessage ?? undefined,
          },
          undefined,
        );
      }

      return {
        status: response.status,
        data,
        text,
        errorMessage,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`HTTP ${init.method} ${url.pathname} failed: ${message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private normalizeJobRow(raw: unknown): JobRow {
    if (!raw || typeof raw !== "object") {
      throw new Error("Claim endpoint returned a malformed job object");
    }

    const rec = raw as Record<string, unknown>;
    const jobId = requireString(rec.job_id, "job_id");
    const mls1Token = requireString(rec.mls1_token, "mls1_token");

    return {
      id: toOptionalInt(rec.id),
      job_id: jobId,
      site_id: stringOrDefault(rec.site_id, this.siteId),
      req_id: stringOrNull(rec.req_id),
      job_type: stringOrDefault(rec.job_type, "PDF_GEN"),
      status: normalizeStatus(rec.status),
      priority: toInt(rec.priority, 50),
      available_at: stringOrNull(rec.available_at),
      rx_id: toInt(rec.rx_id, 0),
      nonce: stringOrDefault(rec.nonce, ""),
      kid: stringOrNull(rec.kid),
      exp_ms: String(rec.exp_ms ?? "0"),
      payload: rec.payload,
      payload_json: stringOrNull(rec.payload_json) ?? undefined,
      mls1_token: mls1Token,
      s3_key_ref: stringOrNull(rec.s3_key_ref),
      attempts: toInt(rec.attempts, 0),
      max_attempts: toInt(rec.max_attempts, 5),
      locked_at: stringOrNull(rec.locked_at),
      lock_expires_at: stringOrNull(rec.lock_expires_at),
      locked_by: stringOrNull(rec.locked_by),
      worker_ref: stringOrNull(rec.worker_ref),
    };
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/g, "");
}

function normalizeApiPath(path: string): string {
  const trimmed = path.trim();
  const withoutLeading = trimmed.replace(/^\/+/, "");
  const normalized = withoutLeading.replace(/\/+/g, "/");
  return `/${normalized}`;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (_err) {
    return null;
  }
}

function extractErrorMessage(data: unknown, text: string): string | null {
  if (data && typeof data === "object") {
    const rec = data as Record<string, unknown>;
    if (typeof rec.message === "string" && rec.message.trim() !== "") {
      return rec.message;
    }
    if (typeof rec.code === "string" && rec.code.trim() !== "") {
      return rec.code;
    }
  }

  const trimmed = text.trim();
  return trimmed !== "" ? trimmed.slice(0, 240) : null;
}

function requireString(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }
  throw new Error(`Claim endpoint returned an invalid ${field}`);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

function toOptionalInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim() !== "" && /^-?\d+$/.test(value.trim())) {
    return Number.parseInt(value, 10);
  }
  return undefined;
}

function toInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim() !== "" && /^-?\d+$/.test(value.trim())) {
    return Number.parseInt(value, 10);
  }
  return fallback;
}

function normalizeStatus(value: unknown): JobStatus {
  const v = typeof value === "string" ? value.toUpperCase() : "";
  if (v === "PENDING" || v === "CLAIMED" || v === "DONE" || v === "FAILED") {
    return v;
  }
  return "PENDING";
}
