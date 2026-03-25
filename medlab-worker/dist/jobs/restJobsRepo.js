"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RestJobsRepo = void 0;
// src/jobs/restJobsRepo.ts
const node_crypto_1 = require("node:crypto");
const node_url_1 = require("node:url");
const mls1_1 = require("../security/mls1");
const BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const BROWSER_ACCEPT_LANGUAGE = "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7";
const BROWSER_ACCEPT_ENCODING = "gzip, deflate, br";
const API_ACCEPT = "application/json, text/plain, */*";
class RestJobsRepo {
    mode = "rest";
    siteId;
    wpBaseUrl;
    claimPath;
    callbackPathTemplate;
    hmacSecretActive;
    requestTimeoutMs;
    logger;
    constructor(cfg) {
        this.siteId = cfg.siteId;
        this.wpBaseUrl = normalizeBaseUrl(cfg.wpBaseUrl);
        this.claimPath = normalizeApiPath(cfg.claimPath);
        this.callbackPathTemplate = normalizeApiPath(cfg.callbackPathTemplate);
        this.hmacSecretActive = cfg.hmacSecretActive;
        this.requestTimeoutMs = Math.max(1_000, cfg.requestTimeoutMs);
        this.logger = cfg.logger;
    }
    getTableName() {
        return `REST:${this.claimPath}`;
    }
    async claimNextPendingJob(opts) {
        const url = this.buildAbsoluteUrl(this.claimPath);
        const body = this.buildClaimBody(opts);
        const rawBody = Buffer.from(JSON.stringify(body));
        const res = await this.fetchJson(url, {
            method: "POST",
            headers: {
                accept: API_ACCEPT,
                "content-type": "application/json; charset=utf-8",
                "x-medlab-signature": (0, mls1_1.buildMls1Token)(rawBody, this.hmacSecretActive),
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
        const rawJob = res.data.job;
        if (rawJob == null) {
            return null;
        }
        const job = this.normalizeJobRow(rawJob);
        if (job.site_id !== opts.siteId) {
            throw new Error("Claimed job site_id mismatch");
        }
        return job;
    }
    async markDone(opts) {
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
    async markFailed(opts) {
        await this.updateJobStatus({
            jobId: opts.jobId,
            reqId: opts.reqId,
            workerRef: opts.workerRef,
            status: "FAILED",
            errorCode: opts.errorCode,
            lastErrorMessageSafe: opts.messageSafe,
        });
    }
    async requeueWithBackoff(opts) {
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
    async getQueueMetrics(_siteId) {
        return { pending: 0, claimed: 0 };
    }
    async sweepZombies(_siteId, _limit = 50) {
        return { requeued: 0, failed: 0 };
    }
    async ingestPrescription(_input) {
        throw new Error("Ingress is not available when QUEUE_MODE=rest");
    }
    async approvePrescription(_prescriptionId, _input) {
        throw new Error("Approval is not available when QUEUE_MODE=rest");
    }
    async rejectPrescription(_prescriptionId, _input) {
        throw new Error("Rejection is not available when QUEUE_MODE=rest");
    }
    async close() {
        // no-op
    }
    async updateJobStatus(input) {
        const url = this.buildAbsoluteUrl(this.renderCallbackPath(input.jobId));
        const body = this.buildCallbackBody(input);
        const rawBody = Buffer.from(JSON.stringify(body));
        const res = await this.fetchJson(url, {
            method: "POST",
            headers: {
                accept: API_ACCEPT,
                "content-type": "application/json; charset=utf-8",
                "x-medlab-signature": (0, mls1_1.buildMls1Token)(rawBody, this.hmacSecretActive),
            },
            body: rawBody,
        });
        if (res.status < 200 || res.status >= 300) {
            throw new Error(`Callback failed with HTTP ${res.status}${res.errorMessage ? `: ${res.errorMessage}` : ""}`);
        }
    }
    buildClaimBody(opts) {
        const tsMs = Date.now();
        const nonce = (0, mls1_1.base64UrlEncode)((0, node_crypto_1.randomBytes)(16));
        return {
            schema_version: "2026.5",
            site_id: opts.siteId,
            ts_ms: tsMs,
            nonce,
            worker_ref: opts.workerId,
            lease_seconds: Math.max(30, opts.leaseMinutes * 60),
        };
    }
    buildCallbackBody(input) {
        const tsMs = Date.now();
        const nonce = (0, mls1_1.base64UrlEncode)((0, node_crypto_1.randomBytes)(16));
        const job = {
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
    renderCallbackPath(jobId) {
        return this.callbackPathTemplate.replace("{job_id}", encodeURIComponent(jobId));
    }
    buildAbsoluteUrl(path) {
        return new node_url_1.URL(path, `${this.wpBaseUrl}/`);
    }
    buildBrowserLikeHeaders(acceptValue = API_ACCEPT) {
        return {
            accept: acceptValue,
            "accept-language": BROWSER_ACCEPT_LANGUAGE,
            "accept-encoding": BROWSER_ACCEPT_ENCODING,
            "cache-control": "no-cache",
            pragma: "no-cache",
            "user-agent": BROWSER_USER_AGENT,
        };
    }
    async fetchJson(url, init) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
        timer.unref?.();
        try {
            const headers = {
                ...this.buildBrowserLikeHeaders(API_ACCEPT),
                ...init.headers,
            };
            const response = await fetch(url, {
                method: init.method,
                headers,
                body: init.body ? new Uint8Array(init.body) : undefined,
                signal: controller.signal,
            });
            const text = response.status === 204 ? "" : await response.text();
            const data = text !== "" ? safeJsonParse(text) : null;
            const errorMessage = extractErrorMessage(data, text);
            if (!response.ok && this.logger) {
                this.logger.warning("rest.bridge.http_error", {
                    method: init.method,
                    path: url.pathname,
                    status: response.status,
                    error_message: errorMessage ?? undefined,
                }, undefined);
            }
            return {
                status: response.status,
                data,
                text,
                errorMessage,
            };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(`HTTP ${init.method} ${url.pathname} failed: ${message}`);
        }
        finally {
            clearTimeout(timer);
        }
    }
    normalizeJobRow(raw) {
        if (!raw || typeof raw !== "object") {
            throw new Error("Claim endpoint returned a malformed job object");
        }
        const rec = raw;
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
exports.RestJobsRepo = RestJobsRepo;
function normalizeBaseUrl(baseUrl) {
    return baseUrl.trim().replace(/\/+$/g, "");
}
function normalizeApiPath(path) {
    const trimmed = path.trim();
    const withoutLeading = trimmed.replace(/^\/+/, "");
    const normalized = withoutLeading.replace(/\/+/g, "/");
    return `/${normalized}`;
}
function safeJsonParse(text) {
    try {
        return JSON.parse(text);
    }
    catch (_err) {
        return null;
    }
}
function extractErrorMessage(data, text) {
    if (data && typeof data === "object") {
        const rec = data;
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
function requireString(value, field) {
    if (typeof value === "string" && value.trim() !== "") {
        return value;
    }
    throw new Error(`Claim endpoint returned an invalid ${field}`);
}
function stringOrNull(value) {
    return typeof value === "string" && value !== "" ? value : null;
}
function stringOrDefault(value, fallback) {
    return typeof value === "string" && value !== "" ? value : fallback;
}
function toOptionalInt(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return Math.trunc(value);
    }
    if (typeof value === "string" && value.trim() !== "" && /^-?\d+$/.test(value.trim())) {
        return Number.parseInt(value, 10);
    }
    return undefined;
}
function toInt(value, fallback) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return Math.trunc(value);
    }
    if (typeof value === "string" && value.trim() !== "" && /^-?\d+$/.test(value.trim())) {
        return Number.parseInt(value, 10);
    }
    return fallback;
}
function normalizeStatus(value) {
    const v = typeof value === "string" ? value.toUpperCase() : "";
    if (v === "WAITING_APPROVAL" || v === "PENDING" || v === "CLAIMED" || v === "DONE" || v === "FAILED") {
        return v;
    }
    return "PENDING";
}
