// src/http/pulseServer.ts
import crypto from "node:crypto";
import http from "node:http";
import { URL } from "node:url";
import { MemoryGuard } from "../admission/memoryGuard";
import type {
  ApprovePrescriptionRequest,
  IngestDoctorInput,
  IngestPrescriptionRequest,
  JobsRepo,
  QueueMetrics,
  RejectPrescriptionRequest,
} from "../jobs/jobsRepo";
import { NdjsonLogger } from "../logger";
import { buildMls1Token, parseCanonicalGet, parseMls1Token, verifyMls1Payload } from "../security/mls1";
import { NonceCache } from "../security/nonceCache";

const MAX_INGEST_BODY_BYTES = 512 * 1024;
const CURRENT_SCHEMA_VERSION = "2026.6";

type PostgresApprovalRepo = JobsRepo;

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

      if (method === "GET" && path === "/pulse") {
        return await handlePulse(req, res, deps, signingSecret);
      }

      if (method === "POST" && path === "/api/v1/prescriptions") {
        return await handlePrescriptionIngress(req, res, deps, signingSecret);
      }

      const approveMatch = method === "POST" ? path.match(/^\/api\/v1\/prescriptions\/([^/]+)\/approve$/) : null;
      if (approveMatch) {
        return await handlePrescriptionApprove(
          req,
          res,
          deps,
          signingSecret,
          decodeURIComponent(approveMatch[1]),
        );
      }

      const rejectMatch = method === "POST" ? path.match(/^\/api\/v1\/prescriptions\/([^/]+)\/reject$/) : null;
      if (rejectMatch) {
        return await handlePrescriptionReject(
          req,
          res,
          deps,
          signingSecret,
          decodeURIComponent(rejectMatch[1]),
        );
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
  if (parsed.ok !== true) {
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
  if (parsed.ok !== true) {
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

  let reqId: string;
  try {
    reqId = normalizeRequiredString((body as { req_id?: unknown }).req_id, "req_id");
    validateSignedEnvelope(body as unknown as Record<string, unknown>, deps, reqId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "ML_INGEST_BAD_REQUEST";
    deps.logger.warning("ingest.rejected", { reason: message }, undefined);
    return sendJson(res, 400, { ok: false, code: "ML_INGEST_BAD_REQUEST" }, signingSecret);
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
        processing_status: result.processing_status,
        status: result.status,
        source_req_id: result.source_req_id,
      },
      signingSecret,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "ingest_failed";
    const statusCode = isClientIngestError(message) ? 400 : 500;
    const code = isClientIngestError(message) ? "ML_INGEST_BAD_REQUEST" : "ML_INGEST_FAILED";

    deps.logger.error(
      "ingest.failed",
      {
        reason: message,
        status_code: statusCode,
      },
      reqId,
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
  const repo = asApprovalRepo(deps.jobsRepo);
  if (!repo) {
    return sendJson(res, 503, { ok: false, code: "ML_INGEST_DISABLED" }, signingSecret);
  }

  const parsedBody = await parseSignedActionBody(req, deps, "/approve");
  if (parsedBody.ok !== true) {
    return sendJson(res, parsedBody.statusCode, { ok: false, code: parsedBody.code }, signingSecret);
  }

  const reqId = parsedBody.reqId;
  try {
    const body = parsedBody.body;
    const doctor = body.doctor && typeof body.doctor === "object" ? (body.doctor as IngestDoctorInput) : null;
    if (!doctor) {
      throw new Error("doctor block is required");
    }

    const input: ApprovePrescriptionRequest = {
      schema_version: CURRENT_SCHEMA_VERSION,
      site_id: deps.siteId,
      ts_ms: Date.now(),
      nonce: crypto.randomBytes(12).toString("hex"),
      req_id: reqId,
      doctor,
    };

    const result = normalizeActionResult(await repo.approvePrescription(prescriptionId, input));

    return sendJson(
      res,
      200,
      {
        ok: true,
        schema_version: CURRENT_SCHEMA_VERSION,
        prescription_id: result.prescription_id,
        job_id: result.job_id,
        uid: result.uid,
        verify_token: result.verify_token,
        verify_code: result.verify_code,
        processing_status: result.processing_status,
        status: "APPROVED",
        source_req_id: result.source_req_id,
      },
      signingSecret,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "approve_failed";
    deps.logger.error("ingest.approve_failed", { reason: message }, reqId);
    return sendJson(res, 500, { ok: false, code: "ML_APPROVE_FAILED" }, signingSecret);
  }
}

async function handlePrescriptionReject(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: PulseServerDeps,
  signingSecret: string,
  prescriptionId: string,
): Promise<void> {
  const repo = asApprovalRepo(deps.jobsRepo);
  if (!repo) {
    return sendJson(res, 503, { ok: false, code: "ML_INGEST_DISABLED" }, signingSecret);
  }

  const parsedBody = await parseSignedActionBody(req, deps, "/reject");
  if (parsedBody.ok !== true) {
    return sendJson(res, parsedBody.statusCode, { ok: false, code: parsedBody.code }, signingSecret);
  }

  const reqId = parsedBody.reqId;
  try {
    const body = parsedBody.body;
    const reason = typeof body.reason === "string" ? body.reason : null;
    const input: RejectPrescriptionRequest = {
      schema_version: CURRENT_SCHEMA_VERSION,
      site_id: deps.siteId,
      ts_ms: Date.now(),
      nonce: crypto.randomBytes(12).toString("hex"),
      req_id: reqId,
      reason,
    };
    const result = normalizeActionResult(await repo.rejectPrescription(prescriptionId, input));

    return sendJson(
      res,
      200,
      {
        ok: true,
        schema_version: CURRENT_SCHEMA_VERSION,
        prescription_id: result.prescription_id,
        job_id: result.job_id,
        uid: result.uid,
        verify_token: result.verify_token,
        verify_code: result.verify_code,
        processing_status: result.processing_status,
        status: "REJECTED",
        source_req_id: result.source_req_id,
      },
      signingSecret,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "reject_failed";
    deps.logger.error("ingest.reject_failed", { reason: message }, reqId);
    return sendJson(res, 500, { ok: false, code: "ML_REJECT_FAILED" }, signingSecret);
  }
}

function asApprovalRepo(jobsRepo: JobsRepo): PostgresApprovalRepo | null {
  const candidate = jobsRepo as Partial<PostgresApprovalRepo>;
  if (
    typeof candidate.approvePrescription === "function"
    && typeof candidate.rejectPrescription === "function"
  ) {
    return jobsRepo as PostgresApprovalRepo;
  }

  return null;
}

async function parseSignedActionBody(
  req: http.IncomingMessage,
  deps: PulseServerDeps,
  pathSuffix: string,
): Promise<
  | { ok: true; body: Record<string, unknown>; reqId: string }
  | { ok: false; statusCode: number; code: string }
> {
  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req, MAX_INGEST_BODY_BYTES);
  } catch (err: unknown) {
    const code = err instanceof Error ? err.message : "ML_BODY_READ_FAILED";
    return { ok: false, statusCode: code === "ML_BODY_TOO_LARGE" ? 413 : 400, code };
  }

  const parsed = validateSignedJsonBody(req, rawBody, deps.secrets);
  if (parsed.ok !== true) {
    if (parsed.logReason) {
      deps.logger.warning("security.mls1.rejected", { reason: parsed.logReason, path: pathSuffix }, undefined);
    }
    return { ok: false, statusCode: parsed.statusCode, code: parsed.code };
  }

  let body: Record<string, unknown>;
  try {
    const candidate = JSON.parse(rawBody.toString("utf8")) as unknown;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("bad_json");
    }
    body = candidate as Record<string, unknown>;
  } catch {
    return { ok: false, statusCode: 400, code: "ML_INGEST_BAD_JSON" };
  }

  try {
    const reqId = normalizeRequiredString(body.req_id, "req_id");
    validateSignedEnvelope(body as unknown as Record<string, unknown>, deps, reqId);
    return { ok: true, body, reqId };
  } catch {
    return { ok: false, statusCode: 400, code: "ML_INGEST_BAD_REQUEST" };
  }
}

function normalizeActionResult(value: unknown): {
  prescription_id: string;
  job_id: string;
  uid: string;
  verify_token: string | null;
  verify_code: string | null;
  processing_status: string;
  source_req_id: string;
} {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid action result");
  }

  const row = value as Record<string, unknown>;
  return {
    prescription_id: normalizeRequiredString(row.prescription_id, "prescription_id"),
    job_id: normalizeRequiredString(row.job_id, "job_id"),
    uid: normalizeRequiredString(row.uid, "uid"),
    verify_token: typeof row.verify_token === "string" && row.verify_token.trim() !== "" ? row.verify_token.trim() : null,
    verify_code: typeof row.verify_code === "string" && row.verify_code.trim() !== "" ? row.verify_code.trim() : null,
    processing_status: typeof row.processing_status === "string" && row.processing_status.trim() !== "" ? row.processing_status.trim() : "PENDING",
    source_req_id: typeof row.source_req_id === "string" && row.source_req_id.trim() !== "" ? row.source_req_id.trim() : "",
  };
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

function validateSignedEnvelope(body: Record<string, unknown>, deps: PulseServerDeps, reqId: string): void {
  const now = Date.now();
  const tsMs = normalizeFiniteNumber(body.ts_ms, "ts_ms");
  const skew = Math.abs(now - tsMs);
  if (skew > deps.skewWindowMs) {
    deps.logger.warning("security.mls1.rejected", { reason: "ts_ms_skew", skew_ms: skew }, reqId);
    throw new Error("Expired signature");
  }

  const siteId = normalizeRequiredString(body.site_id, "site_id");
  if (siteId !== deps.siteId) {
    deps.logger.warning("ingest.rejected", { reason: "site_id_mismatch" }, reqId);
    throw new Error("site_id mismatch");
  }

  const nonce = normalizeRequiredString(body.nonce, "nonce");
  const isNew = deps.nonceCache.checkAndStore(nonce, now);
  if (!isNew) {
    deps.logger.warning("security.mls1.rejected", { reason: "replay", nonce: "[REDACTED]" }, reqId);
    throw new Error("Replay detected");
  }
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

    req.on("data", (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        reject(new Error("ML_BODY_TOO_LARGE"));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });

    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
    req.on("aborted", () => reject(new Error("ML_BODY_ABORTED")));
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

function isClientIngestError(message: string): boolean {
  const haystack = String(message || "").toLowerCase();

  return [
    "required",
    "must be",
    "schema_version mismatch",
    "site_id mismatch",
    "doctor block is required",
    "doctor block must be an object if provided",
    "patient block is required",
    "prescription block is required",
    "prescription.items must be an array",
    "ingress payload is missing",
  ].some((needle) => haystack.includes(needle.toLowerCase()));
}
