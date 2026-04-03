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
const client_1 = require("@prisma/client");
const messagesRepo_1 = require("../messages/messagesRepo");
const mls1_1 = require("../security/mls1");
const submissionRepo_1 = require("../submissions/submissionRepo");
const patientRepo_1 = require("../patients/patientRepo");
const MAX_INGEST_BODY_BYTES = 512 * 1024;
const ARTIFACT_ACCESS_TTL_SECONDS = 60;
const CURRENT_SCHEMA_VERSION = "2026.6";
const RESPONSE_REQ_ID_SYMBOL = Symbol("sosprescription.response_req_id");
function startPulseServer(deps) {
    const signingSecret = deps.secrets[0];
    const submissionRepo = new submissionRepo_1.SubmissionRepo({ logger: deps.logger });
    const patientRepo = new patientRepo_1.PatientRepo({ logger: deps.logger });
    const server = node_http_1.default.createServer(async (req, res) => {
        setResponseReqId(res, buildRequestId());
        try {
            const method = req.method ?? "GET";
            const url = new node_url_1.URL(req.url ?? "/", "http://localhost");
            const path = url.pathname;
            if (method === "GET" && path === "/pulse") {
                return await handlePulse(req, res, deps, signingSecret);
            }
            if (method === "POST" && path === "/api/v2/submissions") {
                return await handleSubmissionCreate(req, res, deps, signingSecret, submissionRepo);
            }
            const submissionFinalizeMatch = method === "POST" ? path.match(/^\/api\/v2\/submissions\/([^/]+)\/finalize$/) : null;
            if (submissionFinalizeMatch) {
                return await handleSubmissionFinalize(req, res, deps, signingSecret, submissionRepo, decodeURIComponent(submissionFinalizeMatch[1]));
            }
            if (method === "GET" && path === "/api/v2/patient/profile") {
                return await handlePatientProfileGet(req, res, deps, signingSecret, patientRepo, url);
            }
            if (method === "PUT" && path === "/api/v2/patient/profile") {
                return await handlePatientProfilePut(req, res, deps, signingSecret, patientRepo);
            }
            if (method === "POST" && path === "/api/v1/prescriptions") {
                return await handlePrescriptionIngress(req, res, deps, signingSecret);
            }
            if (method === "POST" && path === "/api/v1/artifacts/upload/init") {
                return await handleArtifactUploadInit(req, res, deps, signingSecret);
            }
            if (method === "OPTIONS" && path === "/api/v1/artifacts/upload/direct") {
                return handleArtifactUploadDirectOptions(req, res, deps);
            }
            if (method === "PUT" && path === "/api/v1/artifacts/upload/direct") {
                return await handleArtifactUploadDirect(req, res, deps, signingSecret, url);
            }
            const artifactAccessMatch = method === "POST" ? path.match(/^\/api\/v1\/artifacts\/([^/]+)\/access$/) : null;
            if (artifactAccessMatch) {
                return await handleArtifactAccess(req, res, deps, signingSecret, decodeURIComponent(artifactAccessMatch[1]));
            }
            const artifactAnalyzeMatch = method === "POST" ? path.match(/^\/api\/v1\/artifacts\/([^/]+)\/analyze$/) : null;
            if (artifactAnalyzeMatch) {
                return await handleArtifactAnalyze(req, res, deps, signingSecret, decodeURIComponent(artifactAnalyzeMatch[1]));
            }
            const messagesReadMatch = method === "POST" ? path.match(/^\/api\/v1\/prescriptions\/([^/]+)\/messages\/read$/) : null;
            if (messagesReadMatch) {
                return await handlePrescriptionMessagesRead(req, res, deps, signingSecret, decodeURIComponent(messagesReadMatch[1]));
            }
            const messagesPostMatch = method === "POST" ? path.match(/^\/api\/v1\/prescriptions\/([^/]+)\/messages$/) : null;
            if (messagesPostMatch) {
                return await handlePrescriptionMessagesCreate(req, res, deps, signingSecret, decodeURIComponent(messagesPostMatch[1]));
            }
            const messagesGetMatch = method === "GET" ? path.match(/^\/api\/v1\/prescriptions\/([^/]+)\/messages$/) : null;
            if (messagesGetMatch) {
                return await handlePrescriptionMessagesGet(req, res, deps, signingSecret, url, decodeURIComponent(messagesGetMatch[1]));
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
            const reqId = getResponseReqId(res);
            deps.logger.error("pulse.unhandled_error", {
                method: req.method ?? "GET",
                path: req.url ?? "/",
            }, reqId, err);
            return sendJson(res, 500, { ok: false, code: "INTERNAL_ERROR", req_id: reqId }, signingSecret);
        }
    });
    server.listen(deps.port, () => {
        deps.logger.info("system.pulse_server.listening", {
            port: deps.port,
            worker_id: deps.workerId,
            queue_mode: deps.jobsRepo.mode,
        });
    });
    return server;
}
async function handlePulse(req, res, deps, signingSecret) {
    const path = "/pulse";
    const parsed = validateSignedRequestHeader(req, deps.secrets);
    if (parsed.ok !== true) {
        if (parsed.logReason) {
            deps.logger.warning("security.mls1.rejected", { reason: parsed.logReason, path }, getResponseReqId(res));
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
        deps.logger.warning("security.mls1.rejected", { reason: "ts_ms_skew", skew_ms: skew }, getResponseReqId(res));
        return sendJson(res, 401, { ok: false, code: "ML_AUTH_EXPIRED" }, signingSecret);
    }
    const isNew = deps.nonceCache.checkAndStore(canon.nonce, now);
    if (!isNew) {
        deps.logger.warning("security.mls1.rejected", { reason: "replay", nonce: "[REDACTED]" }, getResponseReqId(res));
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
async function handleSubmissionCreate(req, res, deps, signingSecret, submissionRepo) {
    let rawBody;
    try {
        rawBody = await readRawBody(req, MAX_INGEST_BODY_BYTES);
    }
    catch (err) {
        const code = err instanceof Error ? err.message : "ML_BODY_READ_FAILED";
        const status = code === "ML_BODY_TOO_LARGE" ? 413 : 400;
        deps.logger.warning("submission.init.rejected", { reason: code }, getResponseReqId(res));
        return sendJson(res, status, { ok: false, code }, signingSecret);
    }
    const parsed = validateSignedJsonBody(req, rawBody, deps.secrets);
    if (parsed.ok !== true) {
        if (parsed.logReason) {
            deps.logger.warning("security.mls1.rejected", { reason: parsed.logReason, path: "/api/v2/submissions" }, getResponseReqId(res));
        }
        return sendJson(res, parsed.statusCode, { ok: false, code: parsed.code }, signingSecret);
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
        return sendJson(res, 400, { ok: false, code: "ML_SUBMISSION_BAD_JSON" }, signingSecret);
    }
    const reqId = typeof body.req_id === "string" && body.req_id.trim() !== ""
        ? setResponseReqId(res, body.req_id)
        : getResponseReqId(res);
    if (hasSubmissionSignedEnvelope(body)) {
        try {
            if (typeof body.req_id !== "string" || body.req_id.trim() === "") {
                throw new submissionRepo_1.SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, "req_id is required");
            }
            validateSignedEnvelope(body, deps, reqId);
        }
        catch (err) {
            if (err instanceof submissionRepo_1.SubmissionRepoError) {
                deps.logger.warning("submission.init.rejected", { code: err.code, reason: err.message }, reqId, err);
            }
            else {
                const message = err instanceof Error ? err.message : "submission_envelope_invalid";
                deps.logger.warning("submission.init.rejected", { reason: message }, reqId, err);
            }
            return sendJson(res, 400, { ok: false, code: "ML_SUBMISSION_BAD_REQUEST", req_id: reqId }, signingSecret);
        }
    }
    try {
        const actor = normalizeSubmissionActorInput(body.actor);
        const flowKey = normalizeSubmissionFlow(body.flow);
        const priority = normalizeSubmissionPriority(body.priority);
        const idempotencyKey = normalizeSubmissionIdempotencyKey(body.idempotency_key);
        const result = await submissionRepo.createSubmission({
            actor,
            flowKey,
            priority,
            idempotencyKey,
        });
        deps.logger.info(result.mode === "replayed" ? "submission.init.replayed" : "submission.init.accepted", {
            submission_ref: result.submission.publicRef,
            owner_role: result.submission.ownerRole,
            owner_wp_user_id: result.submission.ownerWpUserId,
            flow_key: result.submission.flowKey,
            priority: result.submission.priority,
            expires_at: result.submission.expiresAt.toISOString(),
            idempotency_key_present: Boolean(idempotencyKey),
        }, reqId);
        return sendJson(res, result.mode === "replayed" ? 200 : 201, {
            ok: true,
            schema_version: CURRENT_SCHEMA_VERSION,
            submission_ref: result.submission.publicRef,
            expires_at: result.submission.expiresAt.toISOString(),
            status: result.submission.status,
        }, signingSecret);
    }
    catch (err) {
        if (err instanceof submissionRepo_1.SubmissionRepoError) {
            deps.logger.warning("submission.init.rejected", { code: err.code, reason: err.message }, reqId, err);
            return sendJson(res, err.statusCode, { ok: false, code: err.code, req_id: reqId }, signingSecret);
        }
        const message = err instanceof Error ? err.message : "submission_create_failed";
        deps.logger.error("submission.init.failed", { reason: message }, reqId, err);
        return sendJson(res, 500, { ok: false, code: "ML_SUBMISSION_CREATE_FAILED", req_id: reqId }, signingSecret);
    }
}
async function handleSubmissionFinalize(req, res, deps, signingSecret, submissionRepo, submissionRef) {
    let rawBody;
    try {
        rawBody = await readRawBody(req, MAX_INGEST_BODY_BYTES);
    }
    catch (err) {
        const code = err instanceof Error ? err.message : "ML_BODY_READ_FAILED";
        const status = code === "ML_BODY_TOO_LARGE" ? 413 : 400;
        deps.logger.warning("submission.finalize.rejected", { reason: code, submission_ref: submissionRef }, getResponseReqId(res));
        return sendJson(res, status, { ok: false, code }, signingSecret);
    }
    const parsed = validateSignedJsonBody(req, rawBody, deps.secrets);
    if (parsed.ok !== true) {
        if (parsed.logReason) {
            deps.logger.warning("security.mls1.rejected", { reason: parsed.logReason, path: `/api/v2/submissions/${submissionRef}/finalize` }, getResponseReqId(res));
        }
        return sendJson(res, parsed.statusCode, { ok: false, code: parsed.code }, signingSecret);
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
        return sendJson(res, 400, { ok: false, code: "ML_SUBMISSION_BAD_JSON" }, signingSecret);
    }
    const reqId = typeof body.req_id === "string" && body.req_id.trim() !== ""
        ? setResponseReqId(res, body.req_id)
        : getResponseReqId(res);
    if (hasSignedEnvelopeFields(body)) {
        try {
            if (typeof body.req_id !== "string" || body.req_id.trim() === "") {
                throw new submissionRepo_1.SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, "req_id is required");
            }
            validateSignedEnvelope(body, deps, reqId);
        }
        catch (err) {
            if (err instanceof submissionRepo_1.SubmissionRepoError) {
                deps.logger.warning("submission.finalize.rejected", { code: err.code, reason: err.message, submission_ref: submissionRef }, reqId, err);
            }
            else {
                const message = err instanceof Error ? err.message : "submission_finalize_envelope_invalid";
                deps.logger.warning("submission.finalize.rejected", { reason: message, submission_ref: submissionRef }, reqId, err);
            }
            return sendJson(res, 400, { ok: false, code: "ML_SUBMISSION_BAD_REQUEST", req_id: reqId }, signingSecret);
        }
    }
    try {
        const normalized = normalizeSubmissionFinalizeRequestInput(body);
        const finalizeRepo = submissionRepo;
        const result = await finalizeRepo.finalizeSubmission({
            submissionRef,
            submission_ref: submissionRef,
            actor: normalized.actor,
            reqId,
            req_id: reqId,
            idempotencyKey: normalized.idempotencyKey,
            idempotency_key: normalized.idempotencyKey,
            patient: normalized.patient,
            patient_profile: normalized.patient,
            profile: normalized.patient,
            items: normalized.items,
            privateNotes: normalized.privateNotes,
            private_notes: normalized.privateNotes,
            prescription: {
                items: normalized.items,
                privateNotes: normalized.privateNotes,
                private_notes: normalized.privateNotes,
            },
            rawBody: body,
            raw_body: body,
        });
        const final = normalizeSubmissionFinalizeResult(result);
        deps.logger.info("submission.finalize.accepted", {
            submission_ref: submissionRef,
            prescription_id: final.prescriptionId,
            uid: final.uid,
            status: final.status,
            processing_status: final.processingStatus,
            item_count: normalized.items.length,
        }, reqId);
        return sendJson(res, 201, {
            ok: true,
            schema_version: CURRENT_SCHEMA_VERSION,
            prescription_id: final.prescriptionId,
            uid: final.uid,
            status: final.status,
            processing_status: final.processingStatus,
        }, signingSecret);
    }
    catch (err) {
        if (err instanceof submissionRepo_1.SubmissionRepoError) {
            deps.logger.warning("submission.finalize.rejected", { code: err.code, reason: err.message, submission_ref: submissionRef }, reqId, err);
            return sendJson(res, err.statusCode, { ok: false, code: err.code, req_id: reqId }, signingSecret);
        }
        const message = err instanceof Error ? err.message : "submission_finalize_failed";
        deps.logger.error("submission.finalize.failed", { reason: message, submission_ref: submissionRef }, reqId, err);
        return sendJson(res, 500, { ok: false, code: "ML_SUBMISSION_FINALIZE_FAILED", req_id: reqId }, signingSecret);
    }
}
async function handlePatientProfileGet(req, res, deps, signingSecret, patientRepo, url) {
    const parsed = validateSignedRequestHeader(req, deps.secrets);
    if (parsed.ok !== true) {
        if (parsed.logReason) {
            deps.logger.warning("security.mls1.rejected", { reason: parsed.logReason, path: "/api/v2/patient/profile" }, getResponseReqId(res));
        }
        return sendJson(res, parsed.statusCode, { ok: false, code: parsed.code }, signingSecret);
    }
    let actor;
    try {
        actor = normalizePatientProfileActorFromQuery(url);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : "patient_profile_bad_request";
        deps.logger.warning("patient_profile.get.rejected", { reason: message }, getResponseReqId(res), err);
        return sendJson(res, 400, { ok: false, code: "ML_PATIENT_PROFILE_BAD_REQUEST" }, signingSecret);
    }
    const canon = (0, mls1_1.parseCanonicalGet)(parsed.token.payloadBytes);
    if (!canon) {
        return sendJson(res, 400, { ok: false, code: "ML_AUTH_BAD_PAYLOAD" }, signingSecret);
    }
    const expectedPath = buildPatientProfileCanonicalGetPath(actor);
    if (canon.method !== "GET" || canon.path !== expectedPath) {
        deps.logger.warning("security.mls1.rejected", {
            reason: "scope_denied",
            expected_path: expectedPath,
            received_path: canon.path,
        }, getResponseReqId(res));
        return sendJson(res, 403, { ok: false, code: "ML_AUTH_SCOPE_DENIED" }, signingSecret);
    }
    const now = Date.now();
    const skew = Math.abs(now - canon.tsMs);
    if (skew > deps.skewWindowMs) {
        deps.logger.warning("security.mls1.rejected", { reason: "ts_ms_skew", skew_ms: skew }, getResponseReqId(res));
        return sendJson(res, 401, { ok: false, code: "ML_AUTH_EXPIRED" }, signingSecret);
    }
    const isNew = deps.nonceCache.checkAndStore(canon.nonce, now);
    if (!isNew) {
        deps.logger.warning("security.mls1.rejected", { reason: "replay", nonce: "[REDACTED]" }, getResponseReqId(res));
        return sendJson(res, 409, { ok: false, code: "ML_AUTH_REPLAY" }, signingSecret);
    }
    try {
        const profile = await patientRepo.getProfileByActor(actor);
        return sendJson(res, 200, buildPatientProfileApiPayload(actor.wpUserId, profile, "Profil chargé."), signingSecret);
    }
    catch (err) {
        if (err instanceof patientRepo_1.PatientRepoError) {
            deps.logger.warning("patient_profile.get.rejected", { code: err.code, reason: err.message, wp_user_id: actor.wpUserId }, getResponseReqId(res), err);
            return sendJson(res, err.statusCode, { ok: false, code: err.code }, signingSecret);
        }
        const message = err instanceof Error ? err.message : "patient_profile_get_failed";
        deps.logger.error("patient_profile.get.failed", { reason: message, wp_user_id: actor.wpUserId }, getResponseReqId(res), err);
        return sendJson(res, 500, { ok: false, code: "ML_PATIENT_PROFILE_GET_FAILED" }, signingSecret);
    }
}
async function handlePatientProfilePut(req, res, deps, signingSecret, patientRepo) {
    let rawBody;
    try {
        rawBody = await readRawBody(req, MAX_INGEST_BODY_BYTES);
    }
    catch (err) {
        const code = err instanceof Error ? err.message : "ML_BODY_READ_FAILED";
        const status = code === "ML_BODY_TOO_LARGE" ? 413 : 400;
        deps.logger.warning("patient_profile.put.rejected", { reason: code }, getResponseReqId(res));
        return sendJson(res, status, { ok: false, code }, signingSecret);
    }
    const parsed = validateSignedJsonBody(req, rawBody, deps.secrets);
    if (parsed.ok !== true) {
        if (parsed.logReason) {
            deps.logger.warning("security.mls1.rejected", { reason: parsed.logReason, path: "/api/v2/patient/profile" }, getResponseReqId(res));
        }
        return sendJson(res, parsed.statusCode, { ok: false, code: parsed.code }, signingSecret);
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
        return sendJson(res, 400, { ok: false, code: "ML_PATIENT_PROFILE_BAD_REQUEST" }, signingSecret);
    }
    const reqId = typeof body.req_id === "string" && body.req_id.trim() !== ""
        ? setResponseReqId(res, body.req_id)
        : getResponseReqId(res);
    if (hasPatientProfileSignedEnvelope(body)) {
        try {
            if (typeof body.req_id !== "string" || body.req_id.trim() === "") {
                throw new patientRepo_1.PatientRepoError("ML_PATIENT_PROFILE_BAD_REQUEST", 400, "req_id is required");
            }
            validateSignedEnvelope(body, deps, reqId);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : "patient_profile_envelope_invalid";
            deps.logger.warning("patient_profile.put.rejected", { reason: message }, reqId, err);
            return sendJson(res, 400, { ok: false, code: "ML_PATIENT_PROFILE_BAD_REQUEST", req_id: reqId }, signingSecret);
        }
    }
    try {
        const normalized = normalizePatientProfileRequestInput(body);
        const profile = await patientRepo.upsertProfile({
            actor: normalized.actor,
            firstName: normalized.firstName,
            lastName: normalized.lastName,
            birthDate: normalized.birthDate,
            gender: normalized.gender,
            email: normalized.email,
            phone: normalized.phone,
            weightKg: normalized.weightKg,
            heightCm: normalized.heightCm,
        });
        deps.logger.info("patient_profile.put.accepted", {
            wp_user_id: normalized.actor.wpUserId,
            has_birthdate: profile.birthDate !== "",
            has_email: Boolean(profile.email),
            has_phone: Boolean(profile.phone),
            has_weight: Boolean(profile.weightKg),
            has_height: Boolean(profile.heightCm),
        }, reqId);
        return sendJson(res, 200, buildPatientProfileApiPayload(normalized.actor.wpUserId, profile, "Profil enregistré."), signingSecret);
    }
    catch (err) {
        if (err instanceof patientRepo_1.PatientRepoError) {
            deps.logger.warning("patient_profile.put.rejected", { code: err.code, reason: err.message }, reqId, err);
            return sendJson(res, err.statusCode, { ok: false, code: err.code, req_id: reqId }, signingSecret);
        }
        const message = err instanceof Error ? err.message : "patient_profile_save_failed";
        deps.logger.error("patient_profile.put.failed", { reason: message }, reqId, err);
        return sendJson(res, 500, { ok: false, code: "ML_PATIENT_PROFILE_SAVE_FAILED", req_id: reqId }, signingSecret);
    }
}
async function handlePrescriptionIngress(req, res, deps, signingSecret) {
    if (deps.jobsRepo.mode !== "postgres") {
        deps.logger.warning("ingest.rejected", { reason: "queue_mode_disabled", queue_mode: deps.jobsRepo.mode }, getResponseReqId(res));
        return sendJson(res, 503, { ok: false, code: "ML_INGEST_DISABLED" }, signingSecret);
    }
    let rawBody;
    try {
        rawBody = await readRawBody(req, MAX_INGEST_BODY_BYTES);
    }
    catch (err) {
        const code = err instanceof Error ? err.message : "ML_BODY_READ_FAILED";
        const status = code === "ML_BODY_TOO_LARGE" ? 413 : 400;
        deps.logger.warning("ingest.rejected", { reason: code }, getResponseReqId(res));
        return sendJson(res, status, { ok: false, code }, signingSecret);
    }
    const parsed = validateSignedJsonBody(req, rawBody, deps.secrets);
    if (parsed.ok !== true) {
        if (parsed.logReason) {
            deps.logger.warning("security.mls1.rejected", { reason: parsed.logReason, path: "/api/v1/prescriptions" }, getResponseReqId(res));
        }
        return sendJson(res, parsed.statusCode, { ok: false, code: parsed.code }, signingSecret);
    }
    let body;
    try {
        body = JSON.parse(rawBody.toString("utf8"));
    }
    catch {
        deps.logger.warning("ingest.rejected", { reason: "bad_json" }, getResponseReqId(res));
        return sendJson(res, 400, { ok: false, code: "ML_INGEST_BAD_JSON" }, signingSecret);
    }
    let reqId;
    try {
        reqId = normalizeRequiredString(body.req_id, "req_id");
        validateSignedEnvelope(body, deps, reqId);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : "ML_INGEST_BAD_REQUEST";
        deps.logger.warning("ingest.rejected", { reason: message }, getResponseReqId(res), err);
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
        }, reqId, err);
        return sendJson(res, statusCode, { ok: false, code }, signingSecret);
    }
}
async function handleArtifactUploadInit(req, res, deps, signingSecret) {
    const parsedBody = await parseSignedActionBody(req, res, deps, "/api/v1/artifacts/upload/init");
    if (parsedBody.ok !== true) {
        return sendJson(res, parsedBody.statusCode, { ok: false, code: parsedBody.code }, signingSecret);
    }
    const reqId = parsedBody.reqId;
    try {
        const payload = parsedBody.body;
        const actor = normalizeActorInput(payload.actor);
        const artifactInput = normalizeArtifactInitInput(payload.artifact, deps.artifactUploadMaxBytes);
        const created = await deps.artifactRepo.initUpload({
            kind: artifactInput.kind,
            ownerRole: actor.role,
            ownerWpUserId: actor.wpUserId,
            prescriptionId: artifactInput.prescriptionId,
            originalName: artifactInput.originalName,
            mimeType: artifactInput.mimeType,
            sizeBytes: artifactInput.sizeBytes,
            meta: artifactInput.meta,
        });
        const publicBaseUrl = resolvePublicBaseUrl(req, deps.workerPublicBaseUrl);
        const ticket = created.draftKey;
        if (!ticket) {
            throw new Error("Artifact ticket generation failed");
        }
        const uploadUrl = `${publicBaseUrl}/api/v1/artifacts/upload/direct?ticket=${encodeURIComponent(ticket)}`;
        deps.logger.info("artifact.upload_init.accepted", {
            artifact_id: created.id,
            kind: created.kind,
            owner_role: created.ownerRole,
            prescription_id: created.prescriptionId,
            size_bytes: created.sizeBytes,
        }, reqId);
        return sendJson(res, 201, {
            ok: true,
            schema_version: CURRENT_SCHEMA_VERSION,
            artifact: serializeArtifact(created),
            upload: {
                mode: "worker_direct",
                method: "PUT",
                url: uploadUrl,
                expires_in: Math.floor(deps.artifactUploadTicketTtlMs / 1000),
                headers: {
                    "Content-Type": created.mimeType,
                },
                max_size_bytes: deps.artifactUploadMaxBytes,
            },
        }, signingSecret);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : "artifact_upload_init_failed";
        const statusCode = isClientArtifactError(message) ? 400 : 500;
        const code = isClientArtifactError(message) ? "ML_ARTIFACT_BAD_REQUEST" : "ML_ARTIFACT_INIT_FAILED";
        deps.logger.error("artifact.upload_init.failed", { reason: message }, reqId, err);
        return sendJson(res, statusCode, { ok: false, code }, signingSecret);
    }
}
function handleArtifactUploadDirectOptions(req, res, deps) {
    const corsOrigin = resolveCorsOrigin(req, deps.uploadAllowedOrigins);
    if (!corsOrigin) {
        res.statusCode = 403;
        applyApiResponseHeaders(res);
        res.end();
        return;
    }
    res.statusCode = 204;
    applyUploadCorsHeaders(res, corsOrigin);
    res.setHeader("Access-Control-Allow-Methods", "PUT, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "600");
    applyApiResponseHeaders(res);
    res.end();
}
async function handleArtifactUploadDirect(req, res, deps, signingSecret, url) {
    const corsOrigin = resolveCorsOrigin(req, deps.uploadAllowedOrigins);
    if (!corsOrigin) {
        return sendJson(res, 403, { ok: false, code: "CORS_FORBIDDEN" }, signingSecret);
    }
    const ticket = normalizeOptionalString(url.searchParams.get("ticket"));
    if (!ticket) {
        return sendJson(res, 400, { ok: false, code: "ML_ARTIFACT_TICKET_MISSING" }, signingSecret, buildUploadCorsHeaders(corsOrigin));
    }
    const verified = await deps.artifactRepo.verifyAndConsumeTicket(ticket, deps.artifactUploadTicketTtlMs);
    if (!verified.ok) {
        const statusCode = verified.code === "EXPIRED" ? 410 : 404;
        const code = verified.code === "EXPIRED" ? "ML_ARTIFACT_TICKET_EXPIRED" : "ML_ARTIFACT_TICKET_INVALID";
        return sendJson(res, statusCode, { ok: false, code }, signingSecret, buildUploadCorsHeaders(corsOrigin));
    }
    const artifact = verified.artifact;
    const expectedSize = artifact.sizeBytes;
    const declaredContentLength = parseContentLength(req.headers["content-length"]);
    if (declaredContentLength != null && declaredContentLength > deps.artifactUploadMaxBytes) {
        await deps.artifactRepo.markArtifactFailed(artifact.id);
        return sendJson(res, 413, { ok: false, code: "ML_ARTIFACT_TOO_LARGE" }, signingSecret, buildUploadCorsHeaders(corsOrigin));
    }
    if (expectedSize > deps.artifactUploadMaxBytes) {
        await deps.artifactRepo.markArtifactFailed(artifact.id);
        return sendJson(res, 413, { ok: false, code: "ML_ARTIFACT_TOO_LARGE" }, signingSecret, buildUploadCorsHeaders(corsOrigin));
    }
    if (declaredContentLength != null && declaredContentLength !== expectedSize) {
        await deps.artifactRepo.markArtifactFailed(artifact.id);
        return sendJson(res, 400, { ok: false, code: "ML_ARTIFACT_SIZE_MISMATCH" }, signingSecret, buildUploadCorsHeaders(corsOrigin));
    }
    const requestContentType = normalizeOptionalString(getHeaderValue(req.headers["content-type"]));
    if (requestContentType && !isCompatibleContentType(requestContentType, artifact.mimeType)) {
        await deps.artifactRepo.markArtifactFailed(artifact.id);
        return sendJson(res, 415, { ok: false, code: "ML_ARTIFACT_CONTENT_TYPE_MISMATCH" }, signingSecret, buildUploadCorsHeaders(corsOrigin));
    }
    const s3Key = buildArtifactS3Key(deps.siteId, artifact.kind, artifact.id, artifact.originalName, artifact.createdAt);
    try {
        const upload = await deps.s3.uploadDirect({
            bucket: deps.artifactsBucket,
            key: s3Key,
            body: req,
            contentType: artifact.mimeType,
            contentLength: declaredContentLength ?? expectedSize,
            metadata: {
                site_id: deps.siteId,
                artifact_id: artifact.id,
                artifact_kind: artifact.kind,
                owner_role: artifact.ownerRole,
                prescription_id: artifact.prescriptionId ?? "",
            },
        });
        if (upload.sizeBytes !== expectedSize) {
            throw new Error(`Uploaded size mismatch: expected ${expectedSize} bytes, got ${upload.sizeBytes}`);
        }
        const ready = await deps.artifactRepo.markReady(artifact.id, {
            sizeBytes: upload.sizeBytes,
            sha256Hex: upload.sha256Hex,
            s3Bucket: deps.artifactsBucket,
            s3Region: deps.artifactsRegion,
            s3Key,
        });
        if (!ready) {
            throw new Error("Artifact vanished before ready confirmation");
        }
        deps.logger.info("artifact.upload.completed", {
            artifact_id: ready.id,
            kind: ready.kind,
            prescription_id: ready.prescriptionId,
            size_bytes: ready.sizeBytes,
            s3_key: ready.s3Key,
        }, getResponseReqId(res));
        return sendJson(res, 200, {
            ok: true,
            schema_version: CURRENT_SCHEMA_VERSION,
            artifact: serializeArtifact(ready),
        }, signingSecret, buildUploadCorsHeaders(corsOrigin));
    }
    catch (err) {
        const message = err instanceof Error ? err.message : "artifact_upload_failed";
        await deps.artifactRepo.markArtifactFailed(artifact.id);
        deps.logger.error("artifact.upload.failed", {
            artifact_id: artifact.id,
            kind: artifact.kind,
            reason: message,
        }, getResponseReqId(res), err);
        return sendJson(res, 500, { ok: false, code: "ML_ARTIFACT_UPLOAD_FAILED" }, signingSecret, buildUploadCorsHeaders(corsOrigin));
    }
}
async function handleArtifactAccess(req, res, deps, signingSecret, artifactId) {
    const parsedBody = await parseSignedActionBody(req, res, deps, `/api/v1/artifacts/${artifactId}/access`);
    if (parsedBody.ok !== true) {
        return sendJson(res, parsedBody.statusCode, { ok: false, code: parsedBody.code }, signingSecret);
    }
    const reqId = parsedBody.reqId;
    try {
        const body = parsedBody.body;
        const actor = normalizeActorInput(body.actor);
        const disposition = normalizeArtifactAccessDisposition(body.disposition);
        const artifact = await deps.artifactRepo.getReadyArtifactForActor(artifactId, actor);
        if (!artifact) {
            return sendJson(res, 404, { ok: false, code: "ML_ARTIFACT_NOT_FOUND" }, signingSecret);
        }
        if (!artifact.s3Key) {
            return sendJson(res, 409, { ok: false, code: "ML_ARTIFACT_NOT_READY" }, signingSecret);
        }
        const bucket = artifact.s3Bucket && artifact.s3Bucket.trim() !== "" ? artifact.s3Bucket : deps.artifactsBucket;
        const accessUrl = await deps.s3.createPresignedAccessUrl({
            bucket,
            key: artifact.s3Key,
            expiresInSeconds: ARTIFACT_ACCESS_TTL_SECONDS,
            contentDisposition: buildArtifactContentDisposition(disposition, artifact.originalName),
            contentType: artifact.mimeType,
        });
        deps.logger.info("artifact.access.generated", {
            artifact_id: artifact.id,
            kind: artifact.kind,
            actor_role: actor.role,
            owner_role: artifact.ownerRole,
            disposition,
            expires_in: ARTIFACT_ACCESS_TTL_SECONDS,
        }, reqId);
        return sendJson(res, 200, {
            ok: true,
            schema_version: CURRENT_SCHEMA_VERSION,
            artifact: serializeArtifact(artifact),
            access: {
                url: accessUrl,
                disposition,
                expires_in: ARTIFACT_ACCESS_TTL_SECONDS,
                mime_type: artifact.mimeType,
            },
        }, signingSecret);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : "artifact_access_failed";
        deps.logger.error("artifact.access.failed", {
            artifact_id: artifactId,
            reason: message,
        }, reqId, err);
        return sendJson(res, 500, { ok: false, code: "ML_ARTIFACT_ACCESS_FAILED" }, signingSecret);
    }
}
async function handleArtifactAnalyze(req, res, deps, signingSecret, artifactId) {
    const parsedBody = await parseSignedActionBody(req, res, deps, `/api/v1/artifacts/${artifactId}/analyze`);
    if (parsedBody.ok !== true) {
        return sendJson(res, parsedBody.statusCode, { ok: false, code: parsedBody.code }, signingSecret);
    }
    const reqId = parsedBody.reqId;
    try {
        const body = parsedBody.body;
        const actor = normalizeActorInput(body.actor);
        const artifact = await deps.artifactRepo.getReadyArtifactForActor(artifactId, actor);
        if (!artifact) {
            return sendJson(res, 404, { ok: false, code: "ML_ARTIFACT_NOT_FOUND" }, signingSecret);
        }
        if (!artifact.s3Key) {
            return sendJson(res, 409, { ok: false, code: "ML_ARTIFACT_NOT_READY" }, signingSecret);
        }
        const bucket = artifact.s3Bucket && artifact.s3Bucket.trim() !== "" ? artifact.s3Bucket : deps.artifactsBucket;
        let fileBuffer;
        try {
            fileBuffer = await deps.s3.downloadBuffer({
                bucket,
                key: artifact.s3Key,
                maxBytes: Math.max(deps.artifactUploadMaxBytes, 12 * 1024 * 1024),
            });
        }
        catch (err) {
            const failure = normalizeAnalyzeFailure(err, "ML_AI_S3_READ_FAILED");
            deps.logger.error("artifact.analyze.failed", {
                artifact_id: artifact.id,
                reason: failure.reason,
                reason_code: failure.code,
            }, reqId, err);
            return sendJson(res, 200, buildAnalyzeFailurePayload(artifact.id, failure.code, failure.message), signingSecret);
        }
        try {
            const analysis = await deps.openRouter.analyzeArtifact({
                artifactId: artifact.id,
                mimeType: artifact.mimeType,
                originalName: artifact.originalName,
                data: fileBuffer,
            });
            deps.logger.info("artifact.analyze.completed", {
                artifact_id: artifact.id,
                kind: artifact.kind,
                owner_role: artifact.ownerRole,
                actor_role: actor.role,
                is_prescription: analysis.is_prescription,
                medications_count: analysis.medications.length,
            }, reqId);
            return sendJson(res, 200, {
                ok: true,
                schema_version: CURRENT_SCHEMA_VERSION,
                artifact_id: artifact.id,
                analysis,
            }, signingSecret);
        }
        catch (err) {
            const failure = normalizeAnalyzeFailure(err);
            deps.logger.error("artifact.analyze.failed", {
                artifact_id: artifact.id,
                reason: failure.reason,
                reason_code: failure.code,
            }, reqId, err);
            return sendJson(res, 200, buildAnalyzeFailurePayload(artifact.id, failure.code, failure.message), signingSecret);
        }
    }
    catch (err) {
        const failure = normalizeAnalyzeFailure(err);
        deps.logger.error("artifact.analyze.failed", {
            artifact_id: artifactId,
            reason: failure.reason,
            reason_code: failure.code,
        }, reqId, err);
        return sendJson(res, 200, buildAnalyzeFailurePayload(artifactId, failure.code, failure.message), signingSecret);
    }
}
function normalizeArtifactAccessDisposition(value) {
    return typeof value === "string" && value.trim().toLowerCase() === "attachment" ? "attachment" : "inline";
}
function buildArtifactContentDisposition(disposition, originalName) {
    const fallbackName = sanitizeDispositionFilename(originalName) || "document";
    const encoded = encodeURIComponent(fallbackName).replace(/['()]/g, escape).replace(/\*/g, "%2A");
    return `${disposition}; filename="${fallbackName}"; filename*=UTF-8''${encoded}`;
}
function sanitizeDispositionFilename(value) {
    return String(value || "")
        .replace(/[\r\n]+/g, " ")
        .replace(/[\/]+/g, "-")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160);
}
function buildAnalyzeFailurePayload(artifactId, code, message) {
    return {
        ok: false,
        schema_version: CURRENT_SCHEMA_VERSION,
        artifact_id: artifactId,
        is_prescription: false,
        reasoning: "",
        medications: [],
        code,
        message,
    };
}
function normalizeAnalyzeFailure(err, fallbackCode = "ML_AI_FAILED") {
    const reason = err instanceof Error ? err.message : fallbackCode;
    if (reason === "ML_AI_DISABLED") {
        return {
            code: "ML_AI_DISABLED",
            reason,
            message: "L'analyse automatique du document est temporairement indisponible. Veuillez réessayer plus tard.",
        };
    }
    if (reason === "ML_AI_TIMEOUT") {
        return {
            code: "ML_AI_TIMEOUT",
            reason,
            message: "L'analyse automatique du document a expiré. Veuillez réessayer ou fournir un document plus net.",
        };
    }
    if (reason === "ML_AI_UNSUPPORTED_MIME") {
        return {
            code: "ML_AI_UNSUPPORTED_MIME",
            reason,
            message: "Ce type de document n'est pas pris en charge pour l'analyse automatique.",
        };
    }
    if (reason.startsWith("ML_AI_UPSTREAM_FAILED:")) {
        return {
            code: "ML_AI_UPSTREAM_FAILED",
            reason,
            message: "L'analyse automatique du document a échoué. Veuillez réessayer ou fournir un document plus net.",
        };
    }
    if (reason.startsWith("ML_AI_S3_READ_FAILED:")) {
        return {
            code: "ML_AI_S3_READ_FAILED",
            reason,
            message: "Le document n'a pas pu être relu pour l'analyse automatique. Veuillez réimporter le fichier.",
        };
    }
    return {
        code: fallbackCode,
        reason,
        message: "L'analyse automatique du document a échoué. Veuillez réessayer ou fournir un document plus net.",
    };
}
async function handlePrescriptionMessagesGet(req, res, deps, signingSecret, url, prescriptionId) {
    const parsed = validateSignedRequestHeader(req, deps.secrets);
    if (parsed.ok !== true) {
        if (parsed.logReason) {
            deps.logger.warning("security.mls1.rejected", { reason: parsed.logReason, path: `/api/v1/prescriptions/${prescriptionId}/messages` }, getResponseReqId(res));
        }
        return sendJson(res, parsed.statusCode, { ok: false, code: parsed.code }, signingSecret);
    }
    let actor;
    let afterSeq;
    let limit;
    try {
        actor = normalizeMessagesActorFromQuery(url);
        afterSeq = normalizeMessagesAfterSeqQuery(url);
        limit = normalizeMessagesLimitQuery(url);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : "ML_MESSAGE_BAD_REQUEST";
        deps.logger.warning("messages.query_rejected", { reason: message, prescription_id: prescriptionId }, getResponseReqId(res), err);
        return sendJson(res, 400, { ok: false, code: "ML_MESSAGE_BAD_REQUEST" }, signingSecret);
    }
    const canon = (0, mls1_1.parseCanonicalGet)(parsed.token.payloadBytes);
    if (!canon) {
        return sendJson(res, 400, { ok: false, code: "ML_AUTH_BAD_PAYLOAD" }, signingSecret);
    }
    const expectedPath = buildMessagesCanonicalGetPath(prescriptionId, actor, afterSeq, limit);
    if (canon.method !== "GET" || canon.path !== expectedPath) {
        deps.logger.warning("security.mls1.rejected", {
            reason: "scope_denied",
            expected_path: expectedPath,
            received_path: canon.path,
        }, getResponseReqId(res));
        return sendJson(res, 403, { ok: false, code: "ML_AUTH_SCOPE_DENIED" }, signingSecret);
    }
    const now = Date.now();
    const skew = Math.abs(now - canon.tsMs);
    if (skew > deps.skewWindowMs) {
        deps.logger.warning("security.mls1.rejected", { reason: "ts_ms_skew", skew_ms: skew }, getResponseReqId(res));
        return sendJson(res, 401, { ok: false, code: "ML_AUTH_EXPIRED" }, signingSecret);
    }
    const isNew = deps.nonceCache.checkAndStore(canon.nonce, now);
    if (!isNew) {
        deps.logger.warning("security.mls1.rejected", { reason: "replay", nonce: "[REDACTED]" }, getResponseReqId(res));
        return sendJson(res, 409, { ok: false, code: "ML_AUTH_REPLAY" }, signingSecret);
    }
    try {
        const result = await deps.messagesRepo.getThread({
            prescriptionId,
            actor,
            afterSeq,
            limit,
        });
        return sendJson(res, 200, {
            ok: true,
            schema_version: CURRENT_SCHEMA_VERSION,
            prescription_id: prescriptionId,
            thread_state: serializeThreadState(result.threadState),
            messages: result.messages.map(serializeThreadMessage),
        }, signingSecret);
    }
    catch (err) {
        return sendMessagesRepoError(res, deps, signingSecret, err, undefined, "messages.query_failed", { prescription_id: prescriptionId, actor_role: actor.role, actor_wp_user_id: actor.wpUserId });
    }
}
async function handlePrescriptionMessagesCreate(req, res, deps, signingSecret, prescriptionId) {
    const parsedBody = await parseSignedActionBody(req, res, deps, `/api/v1/prescriptions/${prescriptionId}/messages`);
    if (parsedBody.ok !== true) {
        return sendJson(res, parsedBody.statusCode, { ok: false, code: parsedBody.code }, signingSecret);
    }
    const reqId = parsedBody.reqId;
    try {
        const payload = parsedBody.body;
        const actor = normalizeMessagesActorInput(payload.actor);
        const messageBlock = payload.message && typeof payload.message === "object" && !Array.isArray(payload.message)
            ? payload.message
            : {};
        const result = await deps.messagesRepo.addMessage({
            prescriptionId,
            actor,
            body: typeof messageBlock.body === "string" ? messageBlock.body : null,
            attachmentArtifactIds: normalizeAttachmentArtifactIds(messageBlock.attachment_artifact_ids),
        });
        return sendJson(res, 201, {
            ok: true,
            schema_version: CURRENT_SCHEMA_VERSION,
            prescription_id: prescriptionId,
            message: serializeThreadMessage(result.message),
            thread_state: serializeThreadState(result.threadState),
        }, signingSecret);
    }
    catch (err) {
        return sendMessagesRepoError(res, deps, signingSecret, err, reqId, "messages.create_failed", { prescription_id: prescriptionId });
    }
}
async function handlePrescriptionMessagesRead(req, res, deps, signingSecret, prescriptionId) {
    const parsedBody = await parseSignedActionBody(req, res, deps, `/api/v1/prescriptions/${prescriptionId}/messages/read`);
    if (parsedBody.ok !== true) {
        return sendJson(res, parsedBody.statusCode, { ok: false, code: parsedBody.code }, signingSecret);
    }
    const reqId = parsedBody.reqId;
    try {
        const payload = parsedBody.body;
        const actor = normalizeMessagesActorInput(payload.actor);
        const result = await deps.messagesRepo.markAsRead({
            prescriptionId,
            actor,
            readUptoSeq: normalizeReadUptoSeq(payload.read_upto_seq),
        });
        return sendJson(res, 200, {
            ok: true,
            schema_version: CURRENT_SCHEMA_VERSION,
            prescription_id: prescriptionId,
            thread_state: serializeThreadState(result.threadState),
        }, signingSecret);
    }
    catch (err) {
        return sendMessagesRepoError(res, deps, signingSecret, err, reqId, "messages.read_failed", { prescription_id: prescriptionId });
    }
}
async function handlePrescriptionApprove(req, res, deps, signingSecret, prescriptionId) {
    const repo = asApprovalRepo(deps.jobsRepo);
    if (!repo) {
        return sendJson(res, 503, { ok: false, code: "ML_INGEST_DISABLED" }, signingSecret);
    }
    const parsedBody = await parseSignedActionBody(req, res, deps, "/approve");
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
        const rawItems = body.items;
        if (rawItems != null && !Array.isArray(rawItems)) {
            return sendJson(res, 400, { ok: false, code: "ML_INGEST_BAD_REQUEST", message: "items must be an array" }, signingSecret);
        }
        const input = {
            schema_version: CURRENT_SCHEMA_VERSION,
            site_id: deps.siteId,
            ts_ms: Date.now(),
            nonce: node_crypto_1.default.randomBytes(12).toString("hex"),
            req_id: reqId,
            doctor,
            items: Array.isArray(rawItems) ? rawItems : undefined,
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
        deps.logger.error("ingest.approve_failed", { reason: message }, reqId, err);
        return sendJson(res, 500, { ok: false, code: "ML_APPROVE_FAILED" }, signingSecret);
    }
}
async function handlePrescriptionReject(req, res, deps, signingSecret, prescriptionId) {
    const repo = asApprovalRepo(deps.jobsRepo);
    if (!repo) {
        return sendJson(res, 503, { ok: false, code: "ML_INGEST_DISABLED" }, signingSecret);
    }
    const parsedBody = await parseSignedActionBody(req, res, deps, "/reject");
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
        deps.logger.error("ingest.reject_failed", { reason: message }, reqId, err);
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
async function parseSignedActionBody(req, res, deps, pathSuffix) {
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
            deps.logger.warning("security.mls1.rejected", { reason: parsed.logReason, path: pathSuffix }, getResponseReqId(res));
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
        setResponseReqId(res, reqId);
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
function normalizeOptionalString(value) {
    if (typeof value !== "string") {
        return null;
    }
    const normalized = value.trim();
    return normalized === "" ? null : normalized;
}
function normalizeFiniteNumber(value, field) {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`${field} must be a positive number`);
    }
    return Math.trunc(n);
}
function normalizeActorInput(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("actor block is required");
    }
    const row = value;
    const rawRole = normalizeRequiredString(row.role, "actor.role").toUpperCase();
    let role;
    switch (rawRole) {
        case "PATIENT":
        case "DOCTOR":
        case "SYSTEM":
            role = rawRole;
            break;
        default:
            throw new Error("actor.role is invalid");
    }
    const wpUserId = normalizeNullablePositiveInt(row.wp_user_id);
    return { role, wpUserId };
}
function normalizeArtifactInitInput(value, maxBytes) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("artifact block is required");
    }
    const row = value;
    const rawKind = normalizeRequiredString(row.kind, "artifact.kind").toUpperCase();
    let kind;
    switch (rawKind) {
        case client_1.ArtifactKind.PROOF:
        case client_1.ArtifactKind.MESSAGE_ATTACHMENT:
            kind = rawKind;
            break;
        default:
            throw new Error("artifact.kind is invalid");
    }
    const sizeBytes = normalizeFiniteNumber(row.size_bytes, "artifact.size_bytes");
    if (sizeBytes > maxBytes) {
        throw new Error("artifact.size_bytes exceeds the configured maximum");
    }
    const meta = row.meta !== undefined ? row.meta : undefined;
    return {
        kind,
        prescriptionId: normalizeOptionalString(row.prescription_id),
        originalName: normalizeRequiredString(row.original_name, "artifact.original_name"),
        mimeType: normalizeRequiredString(row.mime_type, "artifact.mime_type"),
        sizeBytes,
        meta,
    };
}
function normalizeNullablePositiveInt(value) {
    if (value == null || value === "") {
        return null;
    }
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n) || n <= 0) {
        return null;
    }
    return Math.trunc(n);
}
function parseContentLength(value) {
    const raw = getHeaderValue(value);
    if (!raw) {
        return null;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return null;
    }
    return parsed;
}
function getHeaderValue(value) {
    if (Array.isArray(value)) {
        return value[0] ?? null;
    }
    return typeof value === "string" ? value : null;
}
function isCompatibleContentType(actual, expected) {
    return normalizeMimeType(actual) === normalizeMimeType(expected);
}
function normalizeMimeType(value) {
    return value.split(";")[0]?.trim().toLowerCase() ?? "";
}
function resolvePublicBaseUrl(req, configuredBaseUrl) {
    const configured = normalizeOptionalString(configuredBaseUrl);
    if (configured) {
        return configured.replace(/\/+$/g, "");
    }
    const forwardedProto = normalizeOptionalString(getHeaderValue(req.headers["x-forwarded-proto"]))?.split(",")[0]?.trim();
    const forwardedHost = normalizeOptionalString(getHeaderValue(req.headers["x-forwarded-host"]))?.split(",")[0]?.trim();
    const host = normalizeOptionalString(getHeaderValue(req.headers.host));
    const proto = forwardedProto || "https";
    const finalHost = forwardedHost || host || "localhost";
    return `${proto}://${finalHost}`.replace(/\/+$/g, "");
}
function resolveCorsOrigin(req, allowedOrigins) {
    const requestOrigin = normalizeOptionalString(getHeaderValue(req.headers.origin));
    if (!requestOrigin) {
        return null;
    }
    return allowedOrigins.includes(requestOrigin) ? requestOrigin : null;
}
function buildUploadCorsHeaders(origin) {
    return {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "PUT, OPTIONS",
        "Vary": "Origin",
    };
}
function applyUploadCorsHeaders(res, origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "PUT, OPTIONS");
    res.setHeader("Vary", "Origin");
}
function buildArtifactS3Key(siteId, kind, artifactId, originalName, createdAt) {
    const year = String(createdAt.getUTCFullYear());
    const month = String(createdAt.getUTCMonth() + 1).padStart(2, "0");
    const extension = extractFileExtension(originalName);
    const kindSegment = kind === client_1.ArtifactKind.PROOF ? "proof" : "message-attachment";
    return `unit/${siteId}/artifacts/${kindSegment}/${year}/${month}/${artifactId}${extension}`;
}
function extractFileExtension(originalName) {
    const match = originalName.toLowerCase().match(/(\.[a-z0-9]{1,8})$/);
    return match ? match[1] : "";
}
function serializeThreadState(threadState) {
    return {
        message_count: threadState.messageCount,
        last_message_seq: threadState.lastMessageSeq,
        last_message_at: threadState.lastMessageAt ? threadState.lastMessageAt.toISOString() : null,
        last_message_role: threadState.lastMessageRole,
        doctor_last_read_seq: threadState.doctorLastReadSeq,
        patient_last_read_seq: threadState.patientLastReadSeq,
        unread_count_doctor: threadState.unreadCountDoctor,
        unread_count_patient: threadState.unreadCountPatient,
    };
}
function serializeThreadMessage(message) {
    return {
        id: message.id,
        seq: message.seq,
        author_role: message.authorRole,
        author_wp_user_id: message.authorWpUserId,
        author_doctor_id: message.authorDoctorId,
        body: message.body,
        created_at: message.createdAt.toISOString(),
        attachments: message.attachments.map(serializeThreadAttachment),
    };
}
function serializeThreadAttachment(attachment) {
    return {
        id: attachment.id,
        kind: attachment.kind,
        status: attachment.status,
        original_name: attachment.originalName,
        mime_type: attachment.mimeType,
        size_bytes: attachment.sizeBytes,
        created_at: attachment.createdAt.toISOString(),
        linked_at: attachment.linkedAt ? attachment.linkedAt.toISOString() : null,
    };
}
function buildMessagesCanonicalGetPath(prescriptionId, actor, afterSeq, limit) {
    const search = new URLSearchParams();
    search.set("actor_role", actor.role);
    if (actor.wpUserId != null) {
        search.set("actor_wp_user_id", String(actor.wpUserId));
    }
    search.set("after_seq", String(afterSeq));
    search.set("limit", String(limit));
    return `/api/v1/prescriptions/${encodeURIComponent(prescriptionId)}/messages?${search.toString()}`;
}
function normalizeMessagesActorFromQuery(url) {
    return normalizeMessagesActorInput({
        role: url.searchParams.get("actor_role"),
        wp_user_id: url.searchParams.get("actor_wp_user_id"),
    });
}
function normalizeMessagesActorInput(value) {
    try {
        return normalizeActorInput(value);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : "actor is invalid";
        throw new messagesRepo_1.MessagesRepoError("ML_MESSAGE_BAD_REQUEST", 400, message);
    }
}
function normalizeMessagesAfterSeqQuery(url) {
    const raw = normalizeOptionalString(url.searchParams.get("after_seq"));
    if (!raw) {
        return 0;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new messagesRepo_1.MessagesRepoError("ML_MESSAGE_BAD_REQUEST", 400, "after_seq is invalid");
    }
    return parsed;
}
function normalizeMessagesLimitQuery(url) {
    const raw = normalizeOptionalString(url.searchParams.get("limit"));
    if (!raw) {
        return 50;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new messagesRepo_1.MessagesRepoError("ML_MESSAGE_BAD_REQUEST", 400, "limit is invalid");
    }
    return Math.min(parsed, 100);
}
function normalizeAttachmentArtifactIds(value) {
    if (value == null) {
        return [];
    }
    if (!Array.isArray(value)) {
        throw new messagesRepo_1.MessagesRepoError("ML_MESSAGE_BAD_REQUEST", 400, "attachment_artifact_ids must be an array");
    }
    const unique = new Set();
    for (const raw of value) {
        if (typeof raw !== "string") {
            continue;
        }
        const normalized = raw.trim();
        if (normalized !== "") {
            unique.add(normalized);
        }
    }
    return Array.from(unique);
}
function normalizeReadUptoSeq(value) {
    if (value == null || value === "") {
        return null;
    }
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new messagesRepo_1.MessagesRepoError("ML_MESSAGE_BAD_REQUEST", 400, "read_upto_seq is invalid");
    }
    return Math.trunc(parsed);
}
function hasSubmissionSignedEnvelope(body) {
    return hasSignedEnvelopeFields(body);
}
function normalizeSubmissionActorInput(value) {
    const actor = normalizeActorInput(value);
    if (actor.role !== "SYSTEM" && actor.wpUserId == null) {
        throw new submissionRepo_1.SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, "actor.wp_user_id is required");
    }
    return actor;
}
function normalizeSubmissionFlow(value) {
    return normalizeSubmissionSlug(value, "flow", 64);
}
function normalizeSubmissionPriority(value) {
    return normalizeSubmissionSlug(value, "priority", 32);
}
function normalizeSubmissionIdempotencyKey(value) {
    if (value == null || value === "") {
        return null;
    }
    if (typeof value !== "string") {
        throw new submissionRepo_1.SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, "idempotency_key is invalid");
    }
    const normalized = value.trim();
    if (normalized === "" || normalized.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(normalized)) {
        throw new submissionRepo_1.SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, "idempotency_key is invalid");
    }
    return normalized;
}
function hasPatientProfileSignedEnvelope(body) {
    return hasSignedEnvelopeFields(body);
}
function hasSignedEnvelopeFields(body) {
    return body.ts_ms !== undefined || body.site_id !== undefined || body.nonce !== undefined;
}
function normalizePatientProfileActorInput(value) {
    const actor = normalizeActorInput(value);
    if (actor.role !== "PATIENT" || actor.wpUserId == null) {
        throw new patientRepo_1.PatientRepoError("ML_PATIENT_PROFILE_BAD_REQUEST", 400, "actor is invalid");
    }
    return {
        role: "PATIENT",
        wpUserId: actor.wpUserId,
    };
}
function normalizePatientProfileActorFromQuery(url) {
    return normalizePatientProfileActorInput({
        role: url.searchParams.get("role"),
        wp_user_id: url.searchParams.get("wp_user_id"),
    });
}
function buildPatientProfileCanonicalGetPath(actor) {
    const search = new URLSearchParams();
    search.set("role", actor.role);
    search.set("wp_user_id", String(actor.wpUserId));
    return `/api/v2/patient/profile?${search.toString()}`;
}
function normalizePatientProfileRequestInput(body) {
    return {
        actor: normalizePatientProfileActorInput(body.actor),
        firstName: pickFirstDefined(body.first_name, body.firstName),
        lastName: pickFirstDefined(body.last_name, body.lastName),
        birthDate: pickFirstDefined(body.birthdate, body.birthDate),
        gender: body.gender,
        email: body.email,
        phone: body.phone,
        weightKg: pickFirstDefined(body.weight_kg, body.weightKg),
        heightCm: pickFirstDefined(body.height_cm, body.heightCm),
    };
}
function normalizeSubmissionFinalizeRequestInput(body) {
    const patientBlock = pickRecord(body.patient)
        ?? pickRecord(body.patient_profile)
        ?? pickRecord(body.profile)
        ?? body;
    const prescriptionBlock = pickRecord(body.prescription) ?? body;
    const itemsValue = prescriptionBlock.items ?? body.items;
    if (!Array.isArray(itemsValue)) {
        throw new submissionRepo_1.SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, "items must be an array");
    }
    const privateNotesRaw = pickFirstDefined(prescriptionBlock.private_notes, prescriptionBlock.privateNotes, body.private_notes, body.privateNotes);
    const actor = normalizeSubmissionActorInput(body.actor);
    const patient = {
        firstName: pickFirstDefined(patientBlock.first_name, patientBlock.firstName, body.first_name, body.firstName),
        first_name: pickFirstDefined(patientBlock.first_name, patientBlock.firstName, body.first_name, body.firstName),
        lastName: pickFirstDefined(patientBlock.last_name, patientBlock.lastName, body.last_name, body.lastName),
        last_name: pickFirstDefined(patientBlock.last_name, patientBlock.lastName, body.last_name, body.lastName),
        birthDate: pickFirstDefined(patientBlock.birthdate, patientBlock.birthDate, body.birthdate, body.birthDate),
        birthdate: pickFirstDefined(patientBlock.birthdate, patientBlock.birthDate, body.birthdate, body.birthDate),
        gender: pickFirstDefined(patientBlock.gender, body.gender),
        email: pickFirstDefined(patientBlock.email, body.email),
        phone: pickFirstDefined(patientBlock.phone, body.phone),
        weightKg: pickFirstDefined(patientBlock.weight_kg, patientBlock.weightKg, body.weight_kg, body.weightKg),
        weight_kg: pickFirstDefined(patientBlock.weight_kg, patientBlock.weightKg, body.weight_kg, body.weightKg),
        heightCm: pickFirstDefined(patientBlock.height_cm, patientBlock.heightCm, body.height_cm, body.heightCm),
        height_cm: pickFirstDefined(patientBlock.height_cm, patientBlock.heightCm, body.height_cm, body.heightCm),
    };
    return {
        actor,
        patient,
        items: itemsValue,
        privateNotes: typeof privateNotesRaw === "string" && privateNotesRaw.trim() !== "" ? privateNotesRaw.trim() : null,
        idempotencyKey: normalizeSubmissionIdempotencyKey(pickFirstDefined(body.idempotency_key, body.idempotencyKey)),
    };
}
function normalizeSubmissionFinalizeResult(value) {
    if (!value || typeof value !== "object") {
        throw new Error("Invalid finalize result");
    }
    const row = value;
    const nestedPrescription = pickRecord(row.prescription) ?? null;
    const prescriptionId = readStringField(row, ["prescription_id", "prescriptionId"])
        ?? readStringField(nestedPrescription, ["id", "prescription_id", "prescriptionId"]);
    const uid = readStringField(row, ["uid"])
        ?? readStringField(nestedPrescription, ["uid"]);
    const status = readStringField(row, ["status"])
        ?? readStringField(nestedPrescription, ["status"])
        ?? "PENDING";
    const processingStatus = readStringField(row, ["processing_status", "processingStatus"])
        ?? readStringField(nestedPrescription, ["processing_status", "processingStatus"])
        ?? "PENDING";
    if (!prescriptionId || !uid) {
        throw new Error("Finalize result is incomplete");
    }
    return {
        prescriptionId,
        uid,
        status,
        processingStatus,
    };
}
function buildPatientProfileApiPayload(wpUserId, profile, message) {
    const profilePayload = buildPatientProfilePayload(profile);
    return {
        ok: true,
        schema_version: CURRENT_SCHEMA_VERSION,
        message,
        profile: profilePayload,
        currentUser: {
            id: wpUserId,
            displayName: profilePayload.full_name,
            email: profilePayload.email,
            roles: ["patient"],
            firstName: profilePayload.first_name,
            lastName: profilePayload.last_name,
            first_name: profilePayload.first_name,
            last_name: profilePayload.last_name,
            birthDate: profilePayload.birthdate_iso,
            birthdate: profilePayload.birthdate_iso,
            sosp_birthdate: profilePayload.birthdate_iso,
            phone: profilePayload.phone,
        },
        patientProfile: {
            first_name: profilePayload.first_name,
            last_name: profilePayload.last_name,
            fullname: profilePayload.full_name,
            birthdate_iso: profilePayload.birthdate_iso,
            birthdate_fr: profilePayload.birthdate_fr,
            phone: profilePayload.phone,
            email: profilePayload.email,
            weight_kg: profilePayload.weight_kg,
            height_cm: profilePayload.height_cm,
            bmi_value: profilePayload.bmi_value,
            bmi_label: profilePayload.bmi_label,
        },
    };
}
function buildPatientProfilePayload(profile) {
    const firstName = profile?.firstName ?? "";
    const lastName = profile?.lastName ?? "";
    const fullName = [firstName, lastName].filter((part) => part.trim() !== "").join(" ").trim();
    const birthdateIso = profile?.birthDate ?? "";
    const phone = profile?.phone ?? "";
    const email = profile?.email ?? "";
    const weightKg = profile?.weightKg ?? "";
    const heightCm = profile?.heightCm ?? "";
    const bmiValue = computeProfileBmiValue(weightKg, heightCm);
    const bmiLabel = computeProfileBmiLabel(weightKg, heightCm);
    return {
        first_name: firstName,
        last_name: lastName,
        full_name: fullName,
        birthdate_iso: birthdateIso,
        birthdate_fr: birthdateIso !== "" ? formatIsoDateToFr(birthdateIso) : "",
        phone,
        email,
        weight_kg: weightKg,
        height_cm: heightCm,
        bmi_value: bmiValue !== null ? String(bmiValue) : "",
        bmi_label: bmiLabel !== "—" ? bmiLabel : "",
    };
}
function computeProfileBmiValue(weightKg, heightCm) {
    const weight = typeof weightKg === "number" ? weightKg : Number(String(weightKg ?? "").replace(",", "."));
    const height = typeof heightCm === "number" ? heightCm : Number(String(heightCm ?? "").replace(",", "."));
    if (!Number.isFinite(weight) || !Number.isFinite(height)) {
        return null;
    }
    if (weight <= 0 || weight > 500 || height <= 0 || height > 300) {
        return null;
    }
    const hm = height / 100;
    if (hm <= 0) {
        return null;
    }
    const bmi = weight / (hm * hm);
    if (!Number.isFinite(bmi) || bmi <= 0) {
        return null;
    }
    return Math.round(bmi * 10) / 10;
}
function computeProfileBmiLabel(weightKg, heightCm) {
    const bmi = computeProfileBmiValue(weightKg, heightCm);
    if (bmi === null) {
        return "—";
    }
    if (bmi < 18.5) {
        return `${bmi} • Insuffisance pondérale`;
    }
    if (bmi < 25.0) {
        return `${bmi} • Corpulence normale`;
    }
    if (bmi < 30.0) {
        return `${bmi} • Surpoids`;
    }
    if (bmi < 35.0) {
        return `${bmi} • Obésité (classe I)`;
    }
    if (bmi < 40.0) {
        return `${bmi} • Obésité (classe II)`;
    }
    return `${bmi} • Obésité (classe III)`;
}
function formatIsoDateToFr(value) {
    const match = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) {
        return String(value ?? "").trim();
    }
    return `${match[3]}/${match[2]}/${match[1]}`;
}
function pickFirstDefined(...values) {
    for (const value of values) {
        if (value !== undefined) {
            return value;
        }
    }
    return undefined;
}
function pickRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    return value;
}
function readStringField(row, keys) {
    if (!row) {
        return null;
    }
    for (const key of keys) {
        const value = row[key];
        if (typeof value === "string" && value.trim() !== "") {
            return value.trim();
        }
    }
    return null;
}
function normalizeSubmissionSlug(value, field, maxLength) {
    if (typeof value !== "string") {
        throw new submissionRepo_1.SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, `${field} is required`);
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === "" || normalized.length > maxLength || !/^[a-z0-9][a-z0-9_-]*$/.test(normalized)) {
        throw new submissionRepo_1.SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, `${field} is invalid`);
    }
    return normalized;
}
function buildRequestId() {
    return `req_${node_crypto_1.default.randomBytes(8).toString("hex")}`;
}
function coalesceRequestId(value) {
    if (typeof value === "string" && value.trim() !== "") {
        return value.trim();
    }
    return buildRequestId();
}
function setResponseReqId(res, reqId) {
    const normalized = coalesceRequestId(reqId);
    res[RESPONSE_REQ_ID_SYMBOL] = normalized;
    return normalized;
}
function getResponseReqId(res) {
    const current = res[RESPONSE_REQ_ID_SYMBOL];
    if (typeof current === "string" && current.trim() !== "") {
        return current;
    }
    return setResponseReqId(res, undefined);
}
function normalizePublicErrorMessage(code, status, providedMessage) {
    switch (code) {
        case "NOT_FOUND":
            return "Ressource introuvable.";
        case "INTERNAL_ERROR":
            return "Une erreur interne est survenue. Réessayez ultérieurement.";
        case "ML_AUTH_MISSING":
        case "ML_AUTH_INVALID_SIG":
        case "ML_AUTH_BAD_PAYLOAD":
        case "ML_AUTH_BODY_MISMATCH":
        case "ML_AUTH_SCOPE_DENIED":
        case "ML_AUTH_EXPIRED":
        case "ML_AUTH_REPLAY":
            return "La requête sécurisée n’a pas pu être vérifiée.";
        case "ML_INGEST_DISABLED":
            return "Le service sécurisé est temporairement indisponible.";
        case "ML_INGEST_BAD_JSON":
        case "ML_INGEST_BAD_REQUEST":
            return "La requête transmise au service sécurisé est invalide.";
        case "ML_SUBMISSION_BAD_JSON":
            return "La requête de soumission sécurisée est invalide.";
        case "ML_SUBMISSION_BAD_REQUEST":
            return "La demande de soumission sécurisée est invalide.";
        case "ML_SUBMISSION_CREATE_FAILED":
            return "La préparation de la soumission sécurisée a échoué.";
        case "ML_SUBMISSION_NOT_FOUND":
            return "Soumission sécurisée introuvable.";
        case "ML_SUBMISSION_EXPIRED":
            return "Cette soumission sécurisée a expiré. Merci de recommencer.";
        case "ML_SUBMISSION_NOT_OPEN":
            return "Cette soumission sécurisée ne peut plus être finalisée.";
        case "ML_SUBMISSION_FINALIZE_FAILED":
            return "La création du dossier sécurisé a échoué. Merci de réessayer.";
        case "ML_PATIENT_PROFILE_BAD_REQUEST":
            return "Les informations du profil sont invalides.";
        case "ML_PATIENT_PROFILE_GET_FAILED":
            return "Le profil patient sécurisé est temporairement indisponible.";
        case "ML_PATIENT_PROFILE_SAVE_FAILED":
            return "Le profil patient n’a pas pu être enregistré.";
        case "ML_BODY_TOO_LARGE":
            return "La requête dépasse la taille maximale autorisée.";
        case "ML_BODY_ABORTED":
        case "ML_BODY_READ_FAILED":
            return "La requête n’a pas pu être lue correctement.";
        case "ML_ARTIFACT_NOT_FOUND":
            return "Document introuvable.";
        case "ML_ARTIFACT_NOT_READY":
            return "Le document n’est pas encore disponible.";
        case "ML_ARTIFACT_TOO_LARGE":
            return "Le fichier dépasse la taille maximale autorisée.";
        case "ML_ARTIFACT_SIZE_MISMATCH":
        case "ML_ARTIFACT_CONTENT_TYPE_MISMATCH":
            return "Le fichier transmis est invalide.";
        case "ML_ARTIFACT_TICKET_MISSING":
        case "ML_ARTIFACT_BAD_REQUEST":
            return "La demande de document est invalide.";
        case "ML_ARTIFACT_INIT_FAILED":
            return "La préparation du document sécurisé a échoué.";
        case "ML_ARTIFACT_UPLOAD_FAILED":
            return "Le téléversement du document a échoué.";
        case "ML_ARTIFACT_ACCESS_FAILED":
            return "Le document sécurisé est temporairement indisponible.";
        case "ML_MESSAGE_BAD_REQUEST":
            return "La requête de messagerie est invalide.";
        case "ML_MESSAGES_FAILED":
            return "Le service de messagerie est temporairement indisponible.";
        case "ML_APPROVE_FAILED":
            return "La validation du dossier a échoué. Réessayez ultérieurement.";
        case "ML_REJECT_FAILED":
            return "La mise à jour du dossier a échoué. Réessayez ultérieurement.";
        case "ML_AI_DISABLED":
            return "L’analyse automatique du document est temporairement indisponible.";
        case "ML_AI_TIMEOUT":
            return "L’analyse automatique du document a expiré. Merci de réessayer.";
        case "ML_AI_UNSUPPORTED_MIME":
            return "Ce type de document n’est pas pris en charge pour l’analyse automatique.";
        case "ML_AI_UPSTREAM_FAILED":
        case "ML_AI_FAILED":
            return "L’analyse automatique du document a échoué. Merci de réessayer.";
        case "ML_AI_S3_READ_FAILED":
            return "Le document n’a pas pu être relu pour l’analyse automatique. Merci de le réimporter.";
        case "CORS_FORBIDDEN":
            return "Origine de requête non autorisée.";
        default:
            if (providedMessage && providedMessage.trim() !== "" && (code.startsWith("ML_AI_") || code === "CORS_FORBIDDEN")) {
                return providedMessage.trim();
            }
            if (status >= 500) {
                return "Le service sécurisé est temporairement indisponible.";
            }
            if (status === 401) {
                return "Connexion requise.";
            }
            if (status === 403) {
                return "Accès refusé.";
            }
            if (status === 404) {
                return "Ressource introuvable.";
            }
            if (status === 409) {
                return "Conflit d’état. Merci de recharger la page.";
            }
            if (status === 429) {
                return "Trop de requêtes. Veuillez réessayer plus tard.";
            }
            return "La requête n’a pas pu être traitée.";
    }
}
function normalizeErrorResponseBody(res, status, body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return body;
    }
    const row = body;
    if (row.ok !== false || typeof row.code !== "string") {
        return body;
    }
    const reqId = typeof row.req_id === "string" && row.req_id.trim() !== ""
        ? setResponseReqId(res, row.req_id)
        : getResponseReqId(res);
    const message = normalizePublicErrorMessage(row.code, status, typeof row.message === "string" ? row.message : null);
    return {
        ...row,
        ok: false,
        code: row.code,
        message,
        req_id: reqId,
        schema_version: typeof row.schema_version === "string" && row.schema_version.trim() !== ""
            ? row.schema_version
            : CURRENT_SCHEMA_VERSION,
    };
}
function sendMessagesRepoError(res, deps, signingSecret, err, reqId, event, context) {
    const effectiveReqId = setResponseReqId(res, reqId);
    if (err instanceof messagesRepo_1.MessagesRepoError) {
        deps.logger.warning(event, { ...context, reason: err.message, code: err.code }, effectiveReqId, err);
        sendJson(res, err.statusCode, { ok: false, code: err.code, req_id: effectiveReqId }, signingSecret);
        return;
    }
    const message = err instanceof Error ? err.message : "messages_failed";
    deps.logger.error(event, { ...context, reason: message }, effectiveReqId, err);
    sendJson(res, 500, { ok: false, code: "ML_MESSAGES_FAILED", req_id: effectiveReqId }, signingSecret);
}
function serializeArtifact(artifact) {
    return {
        id: artifact.id,
        prescription_id: artifact.prescriptionId,
        message_id: artifact.messageId,
        kind: artifact.kind,
        status: artifact.status,
        original_name: artifact.originalName,
        mime_type: artifact.mimeType,
        size_bytes: artifact.sizeBytes,
        sha256_hex: artifact.sha256Hex,
        created_at: artifact.createdAt.toISOString(),
        updated_at: artifact.updatedAt.toISOString(),
        linked_at: artifact.linkedAt ? artifact.linkedAt.toISOString() : null,
    };
}
function applyApiResponseHeaders(res, extraHeaders) {
    for (const [header, value] of Object.entries(extraHeaders ?? {})) {
        res.setHeader(header, value);
    }
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("X-SOSPrescription-Request-ID", getResponseReqId(res));
}
function sendJson(res, status, body, signingSecret, extraHeaders) {
    const normalizedBody = normalizeErrorResponseBody(res, status, body);
    const data = Buffer.from(JSON.stringify(normalizedBody));
    const token = (0, mls1_1.buildMls1Token)(data, signingSecret);
    res.statusCode = status;
    applyApiResponseHeaders(res, extraHeaders);
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
function isClientArtifactError(message) {
    const haystack = String(message || "").toLowerCase();
    return [
        "artifact block is required",
        "actor block is required",
        "is invalid",
        "is required",
        "must be a positive number",
        "exceeds the configured maximum",
        "site_id mismatch",
        "expired signature",
        "replay detected",
    ].some((needle) => haystack.includes(needle.toLowerCase()));
}
