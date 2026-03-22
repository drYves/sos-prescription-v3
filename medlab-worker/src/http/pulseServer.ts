// src/http/pulseServer.ts
import crypto from "node:crypto";
import http from "node:http";
import { URL } from "node:url";
import { MemoryGuard } from "../admission/memoryGuard";
import { NdjsonLogger } from "../logger";
import type {
  ApprovePrescriptionRequest,
  IngestPrescriptionRequest,
  JobsRepo,
  QueueMetrics,
  RejectPrescriptionRequest,
} from "../jobs/jobsRepo";
import { buildMls1Token, parseCanonicalGet, parseMls1Token, verifyMls1Payload } from "../security/mls1";
import { NonceCache } from "../security/nonceCache";

const MAX_INGEST_BODY_BYTES = 512 * 1024;
const CURRENT_SCHEMA_VERSION = "2026.6";

export interface PulseServerDeps {
  port: number;
  siteId: string;
  workerId: string;
  jobsRepo: JobsRepo;
  memGuard: MemoryGuard;
  nonceCache: NonceCache;
  secrets: string[];
  skewWindowMs: number;
  logger: NdjsonLogger;
}

export function startPulseServer(deps: PulseServerDeps): http.Server {
  const signingSecret = deps.secrets[0];

  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const matchedAction = matchPrescriptionActionPath(path);

      if (method === "GET" && path === "/pulse") {
        return await handlePulse(req, res, deps, signingSecret);
      }

      if (method === "POST" && path === "/api/v1/prescriptions") {
        return await handlePrescriptionIngress(req, res, deps, signingSecret);
      }

      if (method === "POST" && matchedAction?.action === "approve") {
        return await handlePrescriptionApprove(req, res, deps, signingSecret, matchedAction.prescriptionId);
      }

      if (method === "POST" && matchedAction?.action === "reject") {
        return await handlePrescriptionReject(req, res, deps, signingSecret, matchedAction.prescriptionId);
      }

      return sendJson(res, 404, { ok: false, code: "NOT_FOUND" }, signingSecret);
    } catch (err: unknown) {
      deps.logger.error(
        "pulse.unhandled_error",
        { message: err instanceof Error ? err.message : "Unhandled server error" },
        undefined,
      );
      return sendJson(res, 500, { ok: false, code: "INTERNAL_ERROR" }, signingSecret);
    }
  });

  server.listen(deps.port, () => {
    deps.logger.info(
      "system.pulse_server.listening",
      {
        port: deps.port,
        worker_id: deps.workerId,
        queue_mode: deps.jobsRepo.mode,
      },
      undefined,
    );
  });

  return server;
}

async function handlePulse(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: PulseServerDeps,
  signingSecret: string,
): Promise<void> {
  const path = "/pulse";
  const parsed = validateSignedRequestHeader(req, deps.secrets);
  if (!parsed.ok) {
    if (parsed.logReason) {
      deps.logger.warning("security.mls1.rejected", { reason: parsed.logReason, path }, undefined);
    }
    return sendJson(res, parsed.statusCode, { ok: false, code: parsed.code }, signingSecret);
  }

  const canon = parseCanonicalGet(parsed.token.payloadBytes);
  if (!canon) {
    return sendJson(res, 400, { ok: false, code: "ML_AUTH_BAD_PAYLOAD" }, signingSecret);
  }

  if (canon.method !== "GET" || canon.path !== "/pulse") {
    return sendJson(res, 403, { ok: false, code: "ML_AUTH_SCOPE_DENIED" }, signingSecret);
  }

  const now = Date.now();
  const skew = Math.abs(now - canon.tsMs);
  if (skew > deps.skewWindowMs) {
    deps.logger.warning("security.mls1.rejected", { reason: "ts_ms_skew", skew_ms: skew }, undefined);
    return sendJson(res, 401, { ok: false, code: "ML_AUTH_EXPIRED" }, signingSecret);
  }

  const isNew = deps.nonceCache.checkAndStore(canon.nonce, now);
  if (!isNew) {
    deps.logger.warning("security.mls1.rejected", { reason: "replay", nonce: "[REDACTED]" }, undefined);
    return sendJson(res, 409, { ok: false, code: "ML_AUTH_REPLAY" }, signingSecret);
  }

  deps.memGuard.tick();
  const rssMb = deps.memGuard.rssMb();
  const state = deps.memGuard.getState();
  let queue: QueueMetrics = { pending: 0, claimed: 0 };
  try {
    queue = await deps.jobsRepo.getQueueMetrics(deps.siteId);
  } catch {
    queue = { pending: 0, claimed: 0 };
  }

  return sendJson(
    res,
    200,
    {
      ok: true,
      schema_version: CURRENT_SCHEMA_VERSION,
      server_time_ms: now,
      worker_id: deps.workerId,
      queue_mode: deps.jobsRepo.mode,
      state,
      rss_mb: rssMb,
      queue,
    },
    signingSecret,
  );
}

async function handlePrescriptionIngress(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: PulseServerDeps,
  signingSecret: string,
): Promise<void> {
  if (deps.jobsRepo.mode !== "postgres") {
    deps.logger.warning(
      "ingest.rejected",
      { reason: "queue_mode_disabled", queue_mode: deps.jobsRepo.mode },
      undefined,
    );
    return sendJson(res, 503, { ok: false, code: "ML_INGEST_DISABLED" }, signingSecret);
  }

  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req, MAX_INGEST_BODY_BYTES);
  } catch (err: unknown) {
    const code = err instanceof Error ? err.message : "ML_BODY_READ_FAILED";
    const status = code === "ML_BODY_TOO_LARGE" ? 413 : 400;
    deps.logger.warning("ingest.rejected", { reason: code }, undefined);
    return sendJson(res, status, { ok: false, code }, signingSecret);
  }

  const parsed = validateSignedJsonBody(req, rawBody, deps.secrets);
  if (!parsed.ok) {
    if (parsed.logReason) {
      deps.logger.warning("security.mls1.rejected", { reason: parsed.logReason, path: "/api/v1/prescriptions" }, undefined);
    }
    return sendJson(res, parsed.statusCode, { ok: false, code: parsed.code }, signingSecret);
  }

  let body: IngestPrescriptionRequest;
  try {
    body = JSON.parse(rawBody.toString("utf8")) as IngestPrescriptionRequest;
  } catch {
    deps.logger.warning("ingest.rejected", { reason: "bad_json" }, undefined);
    return sendJson(res, 400, { ok: false, code: "ML_INGEST_BAD_JSON" }, signingSecret);
  }

  const auth = validateSignedRequestPayload(body, deps, undefined, "ingest");
  if (!auth.ok) {
    return sendJson(res, auth.statusCode, { ok: false, code: auth.code }, signingSecret);
  }

  try {
    const result = await deps.jobsRepo.ingestPrescription(body);
    return sendJson(
      res,
      result.mode === "created" ? 202 : 200,
      {
        ok: true,
        schema_version: CURRENT_SCHEMA_VERSION,
        mode: result.mode,
        queue_mode: deps.jobsRepo.mode,
        job_id: result.job_id,
        prescription_id: result.prescription_id,
        uid: result.uid,
        verify_token: result.verify_token,
        verify_code: result.verify_code,
        processing_status: result.processing_status,
        status: result.status,
        source_req_id: result.source_req_id,
      },
      signingSecret,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "ingest_failed";
    const statusCode = isClientRequestError(message) ? 400 : 500;
    const code = isClientRequestError(message) ? "ML_INGEST_BAD_REQUEST" : "ML_INGEST_FAILED";

    deps.logger.error(
      "ingest.failed",
      {
        reason: message,
        status_code: statusCode,
      },
      auth.reqId,
    );
    return sendJson(res, statusCode, { ok: false, code }, signingSecret);
  }
}

async function handlePrescriptionApprove(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: PulseServerDeps,
  signingSecret: string,
  prescriptionId: string,
): Promise<void> {
  if (deps.jobsRepo.mode !== "postgres") {
    return sendJson(res, 503, { ok: false, code: "ML_APPROVAL_DISABLED" }, signingSecret);
  }

  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req, MAX_INGEST_BODY_BYTES);
  } catch (err: unknown) {
    const code = err instanceof Error ? err.message : "ML_BODY_READ_FAILED";
    const status = code === "ML_BODY_TOO_LARGE" ? 413 : 400;
    deps.logger.warning("approval.rejected", { reason: code, prescription_id: prescriptionId }, undefined);
    return sendJson(res, status, { ok: false, code }, signingSecret);
  }

  const parsed = validateSignedJsonBody(req, rawBody, deps.secrets);
  if (!parsed.ok) {
    if (parsed.logReason) {
      deps.logger.warning("security.mls1.rejected", { reason: parsed.logReason, path: `/api/v1/prescriptions/${prescriptionId}/approve` }, undefined);
    }
    return sendJson(res, parsed.statusCode, { ok: false, code: parsed.code }, signingSecret);
  }

  let body: ApprovePrescriptionRequest;
  try {
    body = JSON.parse(rawBody.toString("utf8")) as ApprovePrescriptionRequest;
  } catch {
    deps.logger.warning("approval.rejected", { reason: "bad_json", prescription_id: prescriptionId }, undefined);
    return sendJson(res, 400, { ok: false, code: "ML_APPROVAL_BAD_JSON" }, signingSecret);
  }

  const auth = validateSignedRequestPayload(body, deps, prescriptionId, "approval");
  if (!auth.ok) {
    return sendJson(res, auth.statusCode, { ok: false, code: auth.code }, signingSecret);
  }

  try {
    const result = await deps.jobsRepo.approvePrescription(prescriptionId, body);
    return sendJson(
      res,
      result.mode === "approved" ? 202 : 200,
      {
        ok: true,
        schema_version: CURRENT_SCHEMA_VERSION,
        mode: result.mode,
        queue_mode: deps.jobsRepo.mode,
        job_id: result.job_id,
        prescription_id: result.prescription_id,
        uid: result.uid,
        verify_token: result.verify_token,
        verify_code: result.verify_code,
        processing_status: result.processing_status,
        status: result.status,
        source_req_id: result.source_req_id,
      },
      signingSecret,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "approval_failed";
    const statusCode = isClientRequestError(message) ? 400 : 500;
    const code = isClientRequestError(message) ? "ML_APPROVAL_BAD_REQUEST" : "ML_APPROVAL_FAILED";

    deps.logger.error(
      "approval.failed",
      {
        reason: message,
        prescription_id: prescriptionId,
        status_code: statusCode,
      },
      auth.reqId,
    );
    return sendJson(res, statusCode, { ok: false, code }, signingSecret);
  }
}

async function handlePrescriptionReject(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: PulseServerDeps,
  signingSecret: string,
  prescriptionId: string,
): Promise<void> {
  if (deps.jobsRepo.mode !== "postgres") {
    return sendJson(res, 503, { ok: false, code: "ML_REJECTION_DISABLED" }, signingSecret);
  }

  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req, MAX_INGEST_BODY_BYTES);
  } catch (err: unknown) {
    const code = err instanceof Error ? err.message : "ML_BODY_READ_FAILED";
    const status = code === "ML_BODY_TOO_LARGE" ? 413 : 400;
    deps.logger.warning("rejection.rejected", { reason: code, prescription_id: prescriptionId }, undefined);
    return sendJson(res, status, { ok: false, code }, signingSecret);
  }

  const parsed = validateSignedJsonBody(req, rawBody, deps.secrets);
  if (!parsed.ok) {
    if (parsed.logReason) {
      deps.logger.warning("security.mls1.rejected", { reason: parsed.logReason, path: `/api/v1/prescriptions/${prescriptionId}/reject` }, undefined);
    }
    return sendJson(res, parsed.statusCode, { ok: false, code: parsed.code }, signingSecret);
  }

  let body: RejectPrescriptionRequest;
  try {
    body = JSON.parse(rawBody.toString("utf8")) as RejectPrescriptionRequest;
  } catch {
    deps.logger.warning("rejection.rejected", { reason: "bad_json", prescription_id: prescriptionId }, undefined);
    return sendJson(res, 400, { ok: false, code: "ML_REJECTION_BAD_JSON" }, signingSecret);
  }

  const auth = validateSignedRequestPayload(body, deps, prescriptionId, "rejection");
  if (!auth.ok) {
    return sendJson(res, auth.statusCode, { ok: false, code: auth.code }, signingSecret);
  }

  try {
    const result = await deps.jobsRepo.rejectPrescription(prescriptionId, body);
    return sendJson(
      res,
      result.mode === "rejected" ? 202 : 200,
      {
        ok: true,
        schema_version: CURRENT_SCHEMA_VERSION,
        mode: result.mode,
        queue_mode: deps.jobsRepo.mode,
        job_id: result.job_id,
        prescription_id: result.prescription_id,
        uid: result.uid,
        verify_token: result.verify_token,
        verify_code: result.verify_code,
        processing_status: result.processing_status,
        status: result.status,
        source_req_id: result.source_req_id,
      },
      signingSecret,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "rejection_failed";
    const statusCode = isClientRequestError(message) ? 400 : 500;
    const code = isClientRequestError(message) ? "ML_REJECTION_BAD_REQUEST" : "ML_REJECTION_FAILED";

    deps.logger.error(
      "rejection.failed",
      {
        reason: message,
        prescription_id: prescriptionId,
        status_code: statusCode,
      },
      auth.reqId,
    );
    return sendJson(res, statusCode, { ok: false, code }, signingSecret);
  }
}

function validateSignedRequestHeader(
  req: http.IncomingMessage,
  secrets: string[],
):
  | { ok: true; token: NonNullable<ReturnType<typeof parseMls1Token>> }
  | { ok: false; statusCode: number; code: string; logReason?: string } {
  const rawSig = req.headers["x-medlab-signature"];
  const sigHeader = Array.isArray(rawSig) ? rawSig[0] ?? "" : rawSig ?? "";
  const parsed = parseMls1Token(sigHeader);
  if (!parsed) {
    return { ok: false, statusCode: 401, code: "ML_AUTH_MISSING" };
  }

  const okSig = verifyMls1Payload(parsed.payloadBytes, parsed.sigHex, secrets);
  if (!okSig) {
    return { ok: false, statusCode: 401, code: "ML_AUTH_INVALID_SIG", logReason: "bad_signature" };
  }

  return { ok: true, token: parsed };
}

function validateSignedJsonBody(
  req: http.IncomingMessage,
  rawBody: Buffer,
  secrets: string[],
):
  | { ok: true; token: NonNullable<ReturnType<typeof parseMls1Token>> }
  | { ok: false; statusCode: number; code: string; logReason?: string } {
  const rawSig = req.headers["x-medlab-signature"];
  const sigHeader = Array.isArray(rawSig) ? rawSig[0] ?? "" : rawSig ?? "";
  const parsed = parseMls1Token(sigHeader);
  if (!parsed) {
    return { ok: false, statusCode: 401, code: "ML_AUTH_MISSING" };
  }

  if (!timingSafeEqualBuffers(parsed.payloadBytes, rawBody)) {
    return { ok: false, statusCode: 401, code: "ML_AUTH_BODY_MISMATCH", logReason: "body_mismatch" };
  }

  const okSig = verifyMls1Payload(parsed.payloadBytes, parsed.sigHex, secrets);
  if (!okSig) {
    return { ok: false, statusCode: 401, code: "ML_AUTH_INVALID_SIG", logReason: "bad_signature" };
  }

  return { ok: true, token: parsed };
}

function validateSignedRequestPayload(
  body: { site_id?: unknown; ts_ms?: unknown; nonce?: unknown; req_id?: unknown },
  deps: PulseServerDeps,
  prescriptionId: string | undefined,
  kind: "ingest" | "approval" | "rejection",
): { ok: true; reqId: string } | { ok: false; statusCode: number; code: string } {
  try {
    const reqId = normalizeRequiredString(body.req_id, "req_id");
    const now = Date.now();
    const tsMs = normalizeFiniteNumber(body.ts_ms, "ts_ms");
    const skew = Math.abs(now - tsMs);
    if (skew > deps.skewWindowMs) {
      deps.logger.warning("security.mls1.rejected", { reason: "ts_ms_skew", skew_ms: skew }, reqId);
      return { ok: false, statusCode: 401, code: "ML_AUTH_EXPIRED" };
    }

    const siteId = normalizeRequiredString(body.site_id, "site_id");
    if (siteId !== deps.siteId) {
      deps.logger.warning(`${kind}.rejected`, { reason: "site_id_mismatch", prescription_id: prescriptionId }, reqId);
      return { ok: false, statusCode: 403, code: `ML_${kind.toUpperCase()}_SITE_MISMATCH` };
    }

    const nonce = normalizeRequiredString(body.nonce, "nonce");
    const isNew = deps.nonceCache.checkAndStore(nonce, now);
    if (!isNew) {
      deps.logger.warning("security.mls1.rejected", { reason: "replay", nonce: "[REDACTED]" }, reqId);
      return { ok: false, statusCode: 409, code: "ML_AUTH_REPLAY" };
    }

    return { ok: true, reqId };
  } catch (err: unknown) {
    deps.logger.warning(`${kind}.rejected`, {
      reason: err instanceof Error ? err.message : `${kind}_bad_request`,
      prescription_id: prescriptionId,
    }, undefined);
    return { ok: false, statusCode: 400, code: `ML_${kind.toUpperCase()}_BAD_REQUEST` };
  }
}

function matchPrescriptionActionPath(path: string): { prescriptionId: string; action: "approve" | "reject" } | null {
  const match = /^\/api\/v1\/prescriptions\/([^/]+)\/(approve|reject)$/.exec(path);
  if (!match) {
    return null;
  }

  return {
    prescriptionId: decodeURIComponent(match[1]),
    action: match[2] as "approve" | "reject",
  };
}

function timingSafeEqualBuffers(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function readRawBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    req.on("data", (chunk: Buffer | string) => {
      if (settled) {
        return;
      }
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        settled = true;
        reject(new Error("ML_BODY_TOO_LARGE"));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });

    req.on("end", () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(err);
    });
    req.on("aborted", () => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new Error("ML_BODY_ABORTED"));
    });
  });
}

function normalizeRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function normalizeFiniteNumber(value: unknown, field: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${field} must be a positive number`);
  }
  return Math.trunc(n);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, signingSecret: string): void {
  const data = Buffer.from(JSON.stringify(body));
  const token = buildMls1Token(data, signingSecret);

  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", data.length);
  res.setHeader("X-MedLab-Signature", token);
  res.end(data);
}

function isClientRequestError(message: string): boolean {
  return [
    "required",
    "must be",
    "schema_version mismatch",
    "site_id mismatch",
    "patient block is required",
    "doctor block is required",
    "doctor block must be an object when provided",
    "prescription block is required",
    "prescription.items must be an array",
    "prescription_id not found",
  ].some((needle) => message.includes(needle));
}
