"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startPulseServer = startPulseServer;
// src/http/pulseServer.ts
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_http_1 = __importDefault(require("node:http"));
const node_url_1 = require("node:url");
const mls1_1 = require("../security/mls1");
const MAX_INGEST_BODY_BYTES = 512 * 1024;
const CURRENT_SCHEMA_VERSION = "2026.6";
function startPulseServer(deps) {
    const signingSecret = deps.secrets[0];
    const server = node_http_1.default.createServer(async (req, res) => {
        try {
            const method = req.method ?? "GET";
            const url = new node_url_1.URL(req.url ?? "/", "http://localhost");
            const path = url.pathname;
            if (method === "GET" && path === "/pulse") {
                return await handlePulse(req, res, deps, signingSecret);
            }
            if (method === "POST" && path === "/api/v1/prescriptions") {
                return await handlePrescriptionIngress(req, res, deps, signingSecret);
            }
            const approveMatch = method === "POST" ? path.match(/^\/api\/v1\/prescriptions\/([^/]+)\/approve$/) : null;
            if (approveMatch) {
                return await handlePrescriptionApprove(req, res, deps, signingSecret, decodeURIComponent(approveMatch[1]));
            }
            const rejectMatch = method === "POST" ? path.match(/^\/api\/v1\/prescriptions\/([^/]+)\/reject$/) : null;
            if (rejectMatch) {
                return await handlePrescriptionReject(req, res, deps, signingSecret, decodeURIComponent(rejectMatch[1]));
            }
            return sendJson(res, 404, { ok: false, code: "NOT_FOUND" }, signingSecret);
        }
        catch (err) {
            deps.logger.error("pulse.unhandled_error", { message: err instanceof Error ? err.message : "Unhandled server error" }, undefined);
            return sendJson(res, 500, { ok: false, code: "INTERNAL_ERROR" }, signingSecret);
        }
    });
    server.listen(deps.port, () => {
        deps.logger.info("system.pulse_server.listening", {
            port: deps.port,
            worker_id: deps.workerId,
            queue_mode: deps.jobsRepo.mode,
        }, undefined);
    });
    return server;
}
async function handlePulse(req, res, deps, signingSecret) {
    const path = "/pulse";
    const parsed = validateSignedRequestHeader(req, deps.secrets);
    if (parsed.ok !== true) {
        if (parsed.logReason) {
            deps.logger.warning("security.mls1.rejected", { reason: parsed.logReason, path }, undefined);
        }
        return sendJson(res, parsed.statusCode, { ok: false, code: parsed.code }, signingSecret);
    }
    const canon = (0, mls1_1.parseCanonicalGet)(parsed.token.payloadBytes);
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
    let queue = { pending: 0, claimed: 0 };
    try {
        queue = await deps.jobsRepo.getQueueMetrics(deps.siteId);
    }
    catch {
        queue = { pending: 0, claimed: 0 };
    }
    return sendJson(res, 200, {
        ok: true,
        schema_version: CURRENT_SCHEMA_VERSION,
        server_time_ms: now,
        worker_id: deps.workerId,
        queue_mode: deps.jobsRepo.mode,
        state,
        rss_mb: rssMb,
        queue,
    }, signingSecret);
}
async function handlePrescriptionIngress(req, res, deps, signingSecret) {
    if (deps.jobsRepo.mode !== "postgres") {
        deps.logger.warning("ingest.rejected", { reason: "queue_mode_disabled", queue_mode: deps.jobsRepo.mode }, undefined);
        return sendJson(res, 503, { ok: false, code: "ML_INGEST_DISABLED" }, signingSecret);
    }
    let rawBody;
    try {
        rawBody = await readRawBody(req, MAX_INGEST_BODY_BYTES);
    }
    catch (err) {
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
    let body;
    try {
        body = JSON.parse(rawBody.toString("utf8"));
    }
    catch {
        deps.logger.warning("ingest.rejected", { reason: "bad_json" }, undefined);
        return sendJson(res, 400, { ok: false, code: "ML_INGEST_BAD_JSON" }, signingSecret);
    }
    let reqId;
    try {
        reqId = normalizeRequiredString(body.req_id, "req_id");
        validateSignedEnvelope(body, deps, reqId);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : "ML_INGEST_BAD_REQUEST";
        deps.logger.warning("ingest.rejected", { reason: message }, undefined);
        return sendJson(res, 400, { ok: false, code: "ML_INGEST_BAD_REQUEST" }, signingSecret);
    }
    try {
        const result = await deps.jobsRepo.ingestPrescription(body);
        return sendJson(res, result.mode === "created" ? 202 : 200, {
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
        }, signingSecret);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : "ingest_failed";
        const statusCode = isClientIngestError(message) ? 400 : 500;
        const code = isClientIngestError(message) ? "ML_INGEST_BAD_REQUEST" : "ML_INGEST_FAILED";
        deps.logger.error("ingest.failed", {
            reason: message,
            status_code: statusCode,
        }, reqId);
        return sendJson(res, statusCode, { ok: false, code }, signingSecret);
    }
}
async function handlePrescriptionApprove(req, res, deps, signingSecret, prescriptionId) {
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
        const doctor = body.doctor && typeof body.doctor === "object" ? body.doctor : null;
        if (!doctor) {
            throw new Error("doctor block is required");
        }
        const input = {
            schema_version: CURRENT_SCHEMA_VERSION,
            site_id: deps.siteId,
            ts_ms: Date.now(),
            nonce: node_crypto_1.default.randomBytes(12).toString("hex"),
            req_id: reqId,
            doctor,
        };
        const result = normalizeActionResult(await repo.approvePrescription(prescriptionId, input));
        return sendJson(res, 200, {
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
        }, signingSecret);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : "approve_failed";
        deps.logger.error("ingest.approve_failed", { reason: message }, reqId);
        return sendJson(res, 500, { ok: false, code: "ML_APPROVE_FAILED" }, signingSecret);
    }
}
async function handlePrescriptionReject(req, res, deps, signingSecret, prescriptionId) {
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
        const input = {
            schema_version: CURRENT_SCHEMA_VERSION,
            site_id: deps.siteId,
            ts_ms: Date.now(),
            nonce: node_crypto_1.default.randomBytes(12).toString("hex"),
            req_id: reqId,
            reason,
        };
        const result = normalizeActionResult(await repo.rejectPrescription(prescriptionId, input));
        return sendJson(res, 200, {
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
        }, signingSecret);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : "reject_failed";
        deps.logger.error("ingest.reject_failed", { reason: message }, reqId);
        return sendJson(res, 500, { ok: false, code: "ML_REJECT_FAILED" }, signingSecret);
    }
}
function asApprovalRepo(jobsRepo) {
    const candidate = jobsRepo;
    if (typeof candidate.approvePrescription === "function"
        && typeof candidate.rejectPrescription === "function") {
        return jobsRepo;
    }
    return null;
}
async function parseSignedActionBody(req, deps, pathSuffix) {
    let rawBody;
    try {
        rawBody = await readRawBody(req, MAX_INGEST_BODY_BYTES);
    }
    catch (err) {
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
    let body;
    try {
        const candidate = JSON.parse(rawBody.toString("utf8"));
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
            throw new Error("bad_json");
        }
        body = candidate;
    }
    catch {
        return { ok: false, statusCode: 400, code: "ML_INGEST_BAD_JSON" };
    }
    try {
        const reqId = normalizeRequiredString(body.req_id, "req_id");
        validateSignedEnvelope(body, deps, reqId);
        return { ok: true, body, reqId };
    }
    catch {
        return { ok: false, statusCode: 400, code: "ML_INGEST_BAD_REQUEST" };
    }
}
function normalizeActionResult(value) {
    if (!value || typeof value !== "object") {
        throw new Error("Invalid action result");
    }
    const row = value;
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
function validateSignedRequestHeader(req, secrets) {
    const rawSig = req.headers["x-medlab-signature"];
    const sigHeader = Array.isArray(rawSig) ? rawSig[0] ?? "" : rawSig ?? "";
    const parsed = (0, mls1_1.parseMls1Token)(sigHeader);
    if (!parsed) {
        return { ok: false, statusCode: 401, code: "ML_AUTH_MISSING" };
    }
    const okSig = (0, mls1_1.verifyMls1Payload)(parsed.payloadBytes, parsed.sigHex, secrets);
    if (!okSig) {
        return { ok: false, statusCode: 401, code: "ML_AUTH_INVALID_SIG", logReason: "bad_signature" };
    }
    return { ok: true, token: parsed };
}
function validateSignedJsonBody(req, rawBody, secrets) {
    const rawSig = req.headers["x-medlab-signature"];
    const sigHeader = Array.isArray(rawSig) ? rawSig[0] ?? "" : rawSig ?? "";
    const parsed = (0, mls1_1.parseMls1Token)(sigHeader);
    if (!parsed) {
        return { ok: false, statusCode: 401, code: "ML_AUTH_MISSING" };
    }
    if (!timingSafeEqualBuffers(parsed.payloadBytes, rawBody)) {
        return { ok: false, statusCode: 401, code: "ML_AUTH_BODY_MISMATCH", logReason: "body_mismatch" };
    }
    const okSig = (0, mls1_1.verifyMls1Payload)(parsed.payloadBytes, parsed.sigHex, secrets);
    if (!okSig) {
        return { ok: false, statusCode: 401, code: "ML_AUTH_INVALID_SIG", logReason: "bad_signature" };
    }
    return { ok: true, token: parsed };
}
function validateSignedEnvelope(body, deps, reqId) {
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
function timingSafeEqualBuffers(a, b) {
    if (a.length !== b.length) {
        return false;
    }
    return node_crypto_1.default.timingSafeEqual(a, b);
}
function readRawBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        req.on("data", (chunk) => {
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
function normalizeRequiredString(value, field) {
    if (typeof value !== "string" || value.trim() === "") {
        throw new Error(`${field} is required`);
    }
    return value.trim();
}
function normalizeFiniteNumber(value, field) {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`${field} must be a positive number`);
    }
    return Math.trunc(n);
}
function sendJson(res, status, body, signingSecret) {
    const data = Buffer.from(JSON.stringify(body));
    const token = (0, mls1_1.buildMls1Token)(data, signingSecret);
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Length", data.length);
    res.setHeader("X-MedLab-Signature", token);
    res.end(data);
}
function isClientIngestError(message) {
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
