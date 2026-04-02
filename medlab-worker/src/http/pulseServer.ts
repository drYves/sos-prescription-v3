// src/http/pulseServer.ts
import crypto from "node:crypto";
import http from "node:http";
import { URL } from "node:url";
import { ActorRole, ArtifactKind, Prisma } from "@prisma/client";
import { MemoryGuard } from "../admission/memoryGuard";
import { OpenRouterService } from "../ai/openRouterService";
import { ArtifactRepo, type ArtifactRecord } from "../artifacts/artifactRepo";
import { MessagesRepo, MessagesRepoError, type ThreadMessageRecord, type ThreadState } from "../messages/messagesRepo";
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
import { S3Service } from "../s3/s3Service";

const MAX_INGEST_BODY_BYTES = 512 * 1024;
const ARTIFACT_ACCESS_TTL_SECONDS = 60;
const CURRENT_SCHEMA_VERSION = "2026.6";

const RESPONSE_REQ_ID_SYMBOL = Symbol("sosprescription.response_req_id");

type ErrorResponseBody = {
  ok: false;
  code: string;
  message?: string;
  req_id?: string;
  schema_version?: string;
};

type PostgresApprovalRepo = JobsRepo;

interface ArtifactInitRequestBody {
  actor?: {
    role?: unknown;
    wp_user_id?: unknown;
  };
  artifact?: {
    kind?: unknown;
    prescription_id?: unknown;
    original_name?: unknown;
    mime_type?: unknown;
    size_bytes?: unknown;
    meta?: unknown;
  };
}

interface MessageCreateRequestBody {
  actor?: {
    role?: unknown;
    wp_user_id?: unknown;
  };
  message?: {
    body?: unknown;
    attachment_artifact_ids?: unknown;
  };
}

interface MessageReadRequestBody {
  actor?: {
    role?: unknown;
    wp_user_id?: unknown;
  };
  read_upto_seq?: unknown;
}

export interface PulseServerDeps {
  port: number;
  siteId: string;
  workerId: string;
  jobsRepo: JobsRepo;
  artifactRepo: ArtifactRepo;
  messagesRepo: MessagesRepo;
  s3: S3Service;
  openRouter: OpenRouterService;
  artifactsBucket: string;
  artifactsRegion: string;
  artifactUploadMaxBytes: number;
  artifactUploadTicketTtlMs: number;
  workerPublicBaseUrl?: string;
  uploadAllowedOrigins: string[];
  memGuard: MemoryGuard;
  nonceCache: NonceCache;
  secrets: string[];
  skewWindowMs: number;
  logger: NdjsonLogger;
}

export function startPulseServer(deps: PulseServerDeps): http.Server {
  const signingSecret = deps.secrets[0];

  const server = http.createServer(async (req, res) => {
    setResponseReqId(res, buildRequestId());

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
        return await handleArtifactAccess(
          req,
          res,
          deps,
          signingSecret,
          decodeURIComponent(artifactAccessMatch[1]),
        );
      }

      const artifactAnalyzeMatch = method === "POST" ? path.match(/^\/api\/v1\/artifacts\/([^/]+)\/analyze$/) : null;
      if (artifactAnalyzeMatch) {
        return await handleArtifactAnalyze(
          req,
          res,
          deps,
          signingSecret,
          decodeURIComponent(artifactAnalyzeMatch[1]),
        );
      }

      const messagesReadMatch = method === "POST" ? path.match(/^\/api\/v1\/prescriptions\/([^/]+)\/messages\/read$/) : null;
      if (messagesReadMatch) {
        return await handlePrescriptionMessagesRead(
          req,
          res,
          deps,
          signingSecret,
          decodeURIComponent(messagesReadMatch[1]),
        );
      }

      const messagesPostMatch = method === "POST" ? path.match(/^\/api\/v1\/prescriptions\/([^/]+)\/messages$/) : null;
      if (messagesPostMatch) {
        return await handlePrescriptionMessagesCreate(
          req,
          res,
          deps,
          signingSecret,
          decodeURIComponent(messagesPostMatch[1]),
        );
      }

      const messagesGetMatch = method === "GET" ? path.match(/^\/api\/v1\/prescriptions\/([^/]+)\/messages$/) : null;
      if (messagesGetMatch) {
        return await handlePrescriptionMessagesGet(
          req,
          res,
          deps,
          signingSecret,
          url,
          decodeURIComponent(messagesGetMatch[1]),
        );
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
      const reqId = getResponseReqId(res);
      deps.logger.error(
        "pulse.unhandled_error",
        {
          method: req.method ?? "GET",
          path: req.url ?? "/",
        },
        reqId,
        err,
      );
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
      deps.logger.warning("security.mls1.rejected", { reason: parsed.logReason, path }, getResponseReqId(res));
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
      getResponseReqId(res),
    );
    return sendJson(res, 503, { ok: false, code: "ML_INGEST_DISABLED" }, signingSecret);
  }

  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req, MAX_INGEST_BODY_BYTES);
  } catch (err: unknown) {
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

  let body: IngestPrescriptionRequest;
  try {
    body = JSON.parse(rawBody.toString("utf8")) as IngestPrescriptionRequest;
  } catch {
    deps.logger.warning("ingest.rejected", { reason: "bad_json" }, getResponseReqId(res));
    return sendJson(res, 400, { ok: false, code: "ML_INGEST_BAD_JSON" }, signingSecret);
  }

  let reqId: string;
  try {
    reqId = normalizeRequiredString((body as { req_id?: unknown }).req_id, "req_id");
    validateSignedEnvelope(body as unknown as Record<string, unknown>, deps, reqId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "ML_INGEST_BAD_REQUEST";
    deps.logger.warning("ingest.rejected", { reason: message }, getResponseReqId(res), err);
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
      err,
    );
    return sendJson(res, statusCode, { ok: false, code }, signingSecret);
  }
}

async function handleArtifactUploadInit(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: PulseServerDeps,
  signingSecret: string,
): Promise<void> {
  const parsedBody = await parseSignedActionBody(req, res, deps, "/api/v1/artifacts/upload/init");
  if (parsedBody.ok !== true) {
    return sendJson(res, parsedBody.statusCode, { ok: false, code: parsedBody.code }, signingSecret);
  }

  const reqId = parsedBody.reqId;
  try {
    const payload = parsedBody.body as ArtifactInitRequestBody;
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
      meta: artifactInput.meta as Prisma.InputJsonValue | undefined,
    });

    const publicBaseUrl = resolvePublicBaseUrl(req, deps.workerPublicBaseUrl);
    const ticket = created.draftKey;
    if (!ticket) {
      throw new Error("Artifact ticket generation failed");
    }

    const uploadUrl = `${publicBaseUrl}/api/v1/artifacts/upload/direct?ticket=${encodeURIComponent(ticket)}`;

    deps.logger.info(
      "artifact.upload_init.accepted",
      {
        artifact_id: created.id,
        kind: created.kind,
        owner_role: created.ownerRole,
        prescription_id: created.prescriptionId,
        size_bytes: created.sizeBytes,
      },
      reqId,
    );

    return sendJson(
      res,
      201,
      {
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
      },
      signingSecret,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "artifact_upload_init_failed";
    const statusCode = isClientArtifactError(message) ? 400 : 500;
    const code = isClientArtifactError(message) ? "ML_ARTIFACT_BAD_REQUEST" : "ML_ARTIFACT_INIT_FAILED";
    deps.logger.error("artifact.upload_init.failed", { reason: message }, reqId, err);
    return sendJson(res, statusCode, { ok: false, code }, signingSecret);
  }
}

function handleArtifactUploadDirectOptions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: PulseServerDeps,
): void {
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

async function handleArtifactUploadDirect(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: PulseServerDeps,
  signingSecret: string,
  url: URL,
): Promise<void> {
  const corsOrigin = resolveCorsOrigin(req, deps.uploadAllowedOrigins);
  if (!corsOrigin) {
    return sendJson(res, 403, { ok: false, code: "CORS_FORBIDDEN" }, signingSecret);
  }

  const ticket = normalizeOptionalString(url.searchParams.get("ticket"));
  if (!ticket) {
    return sendJson(
      res,
      400,
      { ok: false, code: "ML_ARTIFACT_TICKET_MISSING" },
      signingSecret,
      buildUploadCorsHeaders(corsOrigin),
    );
  }

  const verified = await deps.artifactRepo.verifyAndConsumeTicket(ticket, deps.artifactUploadTicketTtlMs);
  if (!verified.ok) {
    const statusCode = verified.code === "EXPIRED" ? 410 : 404;
    const code = verified.code === "EXPIRED" ? "ML_ARTIFACT_TICKET_EXPIRED" : "ML_ARTIFACT_TICKET_INVALID";
    return sendJson(
      res,
      statusCode,
      { ok: false, code },
      signingSecret,
      buildUploadCorsHeaders(corsOrigin),
    );
  }

  const artifact = verified.artifact;
  const expectedSize = artifact.sizeBytes;
  const declaredContentLength = parseContentLength(req.headers["content-length"]);
  if (declaredContentLength != null && declaredContentLength > deps.artifactUploadMaxBytes) {
    await deps.artifactRepo.markArtifactFailed(artifact.id);
    return sendJson(
      res,
      413,
      { ok: false, code: "ML_ARTIFACT_TOO_LARGE" },
      signingSecret,
      buildUploadCorsHeaders(corsOrigin),
    );
  }

  if (expectedSize > deps.artifactUploadMaxBytes) {
    await deps.artifactRepo.markArtifactFailed(artifact.id);
    return sendJson(
      res,
      413,
      { ok: false, code: "ML_ARTIFACT_TOO_LARGE" },
      signingSecret,
      buildUploadCorsHeaders(corsOrigin),
    );
  }

  if (declaredContentLength != null && declaredContentLength !== expectedSize) {
    await deps.artifactRepo.markArtifactFailed(artifact.id);
    return sendJson(
      res,
      400,
      { ok: false, code: "ML_ARTIFACT_SIZE_MISMATCH" },
      signingSecret,
      buildUploadCorsHeaders(corsOrigin),
    );
  }

  const requestContentType = normalizeOptionalString(getHeaderValue(req.headers["content-type"]));
  if (requestContentType && !isCompatibleContentType(requestContentType, artifact.mimeType)) {
    await deps.artifactRepo.markArtifactFailed(artifact.id);
    return sendJson(
      res,
      415,
      { ok: false, code: "ML_ARTIFACT_CONTENT_TYPE_MISMATCH" },
      signingSecret,
      buildUploadCorsHeaders(corsOrigin),
    );
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

    deps.logger.info(
      "artifact.upload.completed",
      {
        artifact_id: ready.id,
        kind: ready.kind,
        prescription_id: ready.prescriptionId,
        size_bytes: ready.sizeBytes,
        s3_key: ready.s3Key,
      },
      getResponseReqId(res),
    );

    return sendJson(
      res,
      200,
      {
        ok: true,
        schema_version: CURRENT_SCHEMA_VERSION,
        artifact: serializeArtifact(ready),
      },
      signingSecret,
      buildUploadCorsHeaders(corsOrigin),
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "artifact_upload_failed";
    await deps.artifactRepo.markArtifactFailed(artifact.id);
    deps.logger.error(
      "artifact.upload.failed",
      {
        artifact_id: artifact.id,
        kind: artifact.kind,
        reason: message,
      },
      getResponseReqId(res),
      err,
    );
    return sendJson(
      res,
      500,
      { ok: false, code: "ML_ARTIFACT_UPLOAD_FAILED" },
      signingSecret,
      buildUploadCorsHeaders(corsOrigin),
    );
  }
}

async function handleArtifactAccess(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: PulseServerDeps,
  signingSecret: string,
  artifactId: string,
): Promise<void> {
  const parsedBody = await parseSignedActionBody(req, res, deps, `/api/v1/artifacts/${artifactId}/access`);
  if (parsedBody.ok !== true) {
    return sendJson(res, parsedBody.statusCode, { ok: false, code: parsedBody.code }, signingSecret);
  }

  const reqId = parsedBody.reqId;

  try {
    const body = parsedBody.body as Record<string, unknown>;
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

    deps.logger.info(
      "artifact.access.generated",
      {
        artifact_id: artifact.id,
        kind: artifact.kind,
        actor_role: actor.role,
        owner_role: artifact.ownerRole,
        disposition,
        expires_in: ARTIFACT_ACCESS_TTL_SECONDS,
      },
      reqId,
    );

    return sendJson(
      res,
      200,
      {
        ok: true,
        schema_version: CURRENT_SCHEMA_VERSION,
        artifact: serializeArtifact(artifact),
        access: {
          url: accessUrl,
          disposition,
          expires_in: ARTIFACT_ACCESS_TTL_SECONDS,
          mime_type: artifact.mimeType,
        },
      },
      signingSecret,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "artifact_access_failed";
    deps.logger.error(
      "artifact.access.failed",
      {
        artifact_id: artifactId,
        reason: message,
      },
      reqId,
      err,
    );
    return sendJson(res, 500, { ok: false, code: "ML_ARTIFACT_ACCESS_FAILED" }, signingSecret);
  }
}

async function handleArtifactAnalyze(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: PulseServerDeps,
  signingSecret: string,
  artifactId: string,
): Promise<void> {
  const parsedBody = await parseSignedActionBody(req, res, deps, `/api/v1/artifacts/${artifactId}/analyze`);
  if (parsedBody.ok !== true) {
    return sendJson(res, parsedBody.statusCode, { ok: false, code: parsedBody.code }, signingSecret);
  }

  const reqId = parsedBody.reqId;

  try {
    const body = parsedBody.body as Record<string, unknown>;
    const actor = normalizeActorInput(body.actor);
    const artifact = await deps.artifactRepo.getReadyArtifactForActor(artifactId, actor);

    if (!artifact) {
      return sendJson(res, 404, { ok: false, code: "ML_ARTIFACT_NOT_FOUND" }, signingSecret);
    }

    if (!artifact.s3Key) {
      return sendJson(res, 409, { ok: false, code: "ML_ARTIFACT_NOT_READY" }, signingSecret);
    }

    const bucket = artifact.s3Bucket && artifact.s3Bucket.trim() !== "" ? artifact.s3Bucket : deps.artifactsBucket;

    let fileBuffer: Buffer;
    try {
      fileBuffer = await deps.s3.downloadBuffer({
        bucket,
        key: artifact.s3Key,
        maxBytes: Math.max(deps.artifactUploadMaxBytes, 12 * 1024 * 1024),
      });
    } catch (err: unknown) {
      const failure = normalizeAnalyzeFailure(err, "ML_AI_S3_READ_FAILED");
      deps.logger.error(
        "artifact.analyze.failed",
        {
          artifact_id: artifact.id,
          reason: failure.reason,
          reason_code: failure.code,
        },
        reqId,
        err,
      );

      return sendJson(
        res,
        200,
        buildAnalyzeFailurePayload(artifact.id, failure.code, failure.message),
        signingSecret,
      );
    }

    try {
      const analysis = await deps.openRouter.analyzeArtifact({
        artifactId: artifact.id,
        mimeType: artifact.mimeType,
        originalName: artifact.originalName,
        data: fileBuffer,
      });

      deps.logger.info(
        "artifact.analyze.completed",
        {
          artifact_id: artifact.id,
          kind: artifact.kind,
          owner_role: artifact.ownerRole,
          actor_role: actor.role,
          is_prescription: analysis.is_prescription,
          medications_count: analysis.medications.length,
        },
        reqId,
      );

      return sendJson(
        res,
        200,
        {
          ok: true,
          schema_version: CURRENT_SCHEMA_VERSION,
          artifact_id: artifact.id,
          analysis,
        },
        signingSecret,
      );
    } catch (err: unknown) {
      const failure = normalizeAnalyzeFailure(err);
      deps.logger.error(
        "artifact.analyze.failed",
        {
          artifact_id: artifact.id,
          reason: failure.reason,
          reason_code: failure.code,
        },
        reqId,
        err,
      );

      return sendJson(
        res,
        200,
        buildAnalyzeFailurePayload(artifact.id, failure.code, failure.message),
        signingSecret,
      );
    }
  } catch (err: unknown) {
    const failure = normalizeAnalyzeFailure(err);
    deps.logger.error(
      "artifact.analyze.failed",
      {
        artifact_id: artifactId,
        reason: failure.reason,
        reason_code: failure.code,
      },
      reqId,
      err,
    );

    return sendJson(
      res,
      200,
      buildAnalyzeFailurePayload(artifactId, failure.code, failure.message),
      signingSecret,
    );
  }
}

function normalizeArtifactAccessDisposition(value: unknown): "inline" | "attachment" {
  return typeof value === "string" && value.trim().toLowerCase() === "attachment" ? "attachment" : "inline";
}

function buildArtifactContentDisposition(disposition: "inline" | "attachment", originalName: string): string {
  const fallbackName = sanitizeDispositionFilename(originalName) || "document";
  const encoded = encodeURIComponent(fallbackName).replace(/['()]/g, escape).replace(/\*/g, "%2A");
  return `${disposition}; filename="${fallbackName}"; filename*=UTF-8''${encoded}`;
}

function sanitizeDispositionFilename(value: string): string {
  return String(value || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[\/]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function buildAnalyzeFailurePayload(
  artifactId: string,
  code: string,
  message: string,
): {
  ok: false;
  schema_version: string;
  artifact_id: string;
  is_prescription: false;
  reasoning: string;
  medications: never[];
  code: string;
  message: string;
} {
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

function normalizeAnalyzeFailure(
  err: unknown,
  fallbackCode = "ML_AI_FAILED",
): {
  code: string;
  reason: string;
  message: string;
} {
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

async function handlePrescriptionMessagesGet(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: PulseServerDeps,
  signingSecret: string,
  url: URL,
  prescriptionId: string,
): Promise<void> {
  const parsed = validateSignedRequestHeader(req, deps.secrets);
  if (parsed.ok !== true) {
    if (parsed.logReason) {
      deps.logger.warning(
        "security.mls1.rejected",
        { reason: parsed.logReason, path: `/api/v1/prescriptions/${prescriptionId}/messages` },
        getResponseReqId(res),
      );
    }
    return sendJson(res, parsed.statusCode, { ok: false, code: parsed.code }, signingSecret);
  }

  let actor: { role: ActorRole; wpUserId: number | null };
  let afterSeq: number;
  let limit: number;
  try {
    actor = normalizeMessagesActorFromQuery(url);
    afterSeq = normalizeMessagesAfterSeqQuery(url);
    limit = normalizeMessagesLimitQuery(url);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "ML_MESSAGE_BAD_REQUEST";
    deps.logger.warning(
      "messages.query_rejected",
      { reason: message, prescription_id: prescriptionId },
      getResponseReqId(res),
      err,
    );
    return sendJson(res, 400, { ok: false, code: "ML_MESSAGE_BAD_REQUEST" }, signingSecret);
  }

  const canon = parseCanonicalGet(parsed.token.payloadBytes);
  if (!canon) {
    return sendJson(res, 400, { ok: false, code: "ML_AUTH_BAD_PAYLOAD" }, signingSecret);
  }

  const expectedPath = buildMessagesCanonicalGetPath(prescriptionId, actor, afterSeq, limit);
  if (canon.method !== "GET" || canon.path !== expectedPath) {
    deps.logger.warning(
      "security.mls1.rejected",
      {
        reason: "scope_denied",
        expected_path: expectedPath,
        received_path: canon.path,
      },
      getResponseReqId(res),
    );
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

    return sendJson(
      res,
      200,
      {
        ok: true,
        schema_version: CURRENT_SCHEMA_VERSION,
        prescription_id: prescriptionId,
        thread_state: serializeThreadState(result.threadState),
        messages: result.messages.map(serializeThreadMessage),
      },
      signingSecret,
    );
  } catch (err: unknown) {
    return sendMessagesRepoError(
      res,
      deps,
      signingSecret,
      err,
      undefined,
      "messages.query_failed",
      { prescription_id: prescriptionId, actor_role: actor.role, actor_wp_user_id: actor.wpUserId },
    );
  }
}

async function handlePrescriptionMessagesCreate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: PulseServerDeps,
  signingSecret: string,
  prescriptionId: string,
): Promise<void> {
  const parsedBody = await parseSignedActionBody(req, res, deps, `/api/v1/prescriptions/${prescriptionId}/messages`);
  if (parsedBody.ok !== true) {
    return sendJson(res, parsedBody.statusCode, { ok: false, code: parsedBody.code }, signingSecret);
  }

  const reqId = parsedBody.reqId;

  try {
    const payload = parsedBody.body as MessageCreateRequestBody;
    const actor = normalizeMessagesActorInput(payload.actor);
    const messageBlock: Record<string, unknown> = payload.message && typeof payload.message === "object" && !Array.isArray(payload.message)
      ? (payload.message as Record<string, unknown>)
      : {};

    const result = await deps.messagesRepo.addMessage({
      prescriptionId,
      actor,
      body: typeof messageBlock.body === "string" ? messageBlock.body : null,
      attachmentArtifactIds: normalizeAttachmentArtifactIds(messageBlock.attachment_artifact_ids),
    });

    return sendJson(
      res,
      201,
      {
        ok: true,
        schema_version: CURRENT_SCHEMA_VERSION,
        prescription_id: prescriptionId,
        message: serializeThreadMessage(result.message),
        thread_state: serializeThreadState(result.threadState),
      },
      signingSecret,
    );
  } catch (err: unknown) {
    return sendMessagesRepoError(
      res,
      deps,
      signingSecret,
      err,
      reqId,
      "messages.create_failed",
      { prescription_id: prescriptionId },
    );
  }
}

async function handlePrescriptionMessagesRead(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: PulseServerDeps,
  signingSecret: string,
  prescriptionId: string,
): Promise<void> {
  const parsedBody = await parseSignedActionBody(req, res, deps, `/api/v1/prescriptions/${prescriptionId}/messages/read`);
  if (parsedBody.ok !== true) {
    return sendJson(res, parsedBody.statusCode, { ok: false, code: parsedBody.code }, signingSecret);
  }

  const reqId = parsedBody.reqId;

  try {
    const payload = parsedBody.body as MessageReadRequestBody;
    const actor = normalizeMessagesActorInput(payload.actor);

    const result = await deps.messagesRepo.markAsRead({
      prescriptionId,
      actor,
      readUptoSeq: normalizeReadUptoSeq(payload.read_upto_seq),
    });

    return sendJson(
      res,
      200,
      {
        ok: true,
        schema_version: CURRENT_SCHEMA_VERSION,
        prescription_id: prescriptionId,
        thread_state: serializeThreadState(result.threadState),
      },
      signingSecret,
    );
  } catch (err: unknown) {
    return sendMessagesRepoError(
      res,
      deps,
      signingSecret,
      err,
      reqId,
      "messages.read_failed",
      { prescription_id: prescriptionId },
    );
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

  const parsedBody = await parseSignedActionBody(req, res, deps, "/approve");
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

    const rawItems = body.items;
    if (rawItems != null && !Array.isArray(rawItems)) {
      return sendJson(res, 400, { ok: false, code: "ML_INGEST_BAD_REQUEST", message: "items must be an array" }, signingSecret);
    }

    const input: ApprovePrescriptionRequest = {
      schema_version: CURRENT_SCHEMA_VERSION,
      site_id: deps.siteId,
      ts_ms: Date.now(),
      nonce: crypto.randomBytes(12).toString("hex"),
      req_id: reqId,
      doctor,
      items: Array.isArray(rawItems) ? rawItems : undefined,
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
    deps.logger.error("ingest.approve_failed", { reason: message }, reqId, err);
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

  const parsedBody = await parseSignedActionBody(req, res, deps, "/reject");
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
    deps.logger.error("ingest.reject_failed", { reason: message }, reqId, err);
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
  res: http.ServerResponse,
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
      deps.logger.warning("security.mls1.rejected", { reason: parsed.logReason, path: pathSuffix }, getResponseReqId(res));
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
    setResponseReqId(res, reqId);
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

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized === "" ? null : normalized;
}

function normalizeFiniteNumber(value: unknown, field: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${field} must be a positive number`);
  }
  return Math.trunc(n);
}

function normalizeActorInput(value: unknown): { role: ActorRole; wpUserId: number | null } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("actor block is required");
  }

  const row = value as Record<string, unknown>;
  const rawRole = normalizeRequiredString(row.role, "actor.role").toUpperCase();
  let role: ActorRole;
  switch (rawRole) {
    case ActorRole.PATIENT:
    case ActorRole.DOCTOR:
    case ActorRole.SYSTEM:
      role = rawRole;
      break;
    default:
      throw new Error("actor.role is invalid");
  }

  const wpUserId = normalizeNullablePositiveInt(row.wp_user_id);
  return { role, wpUserId };
}

function normalizeArtifactInitInput(value: unknown, maxBytes: number): {
  kind: ArtifactKind;
  prescriptionId: string | null;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  meta?: Prisma.InputJsonValue;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("artifact block is required");
  }

  const row = value as Record<string, unknown>;
  const rawKind = normalizeRequiredString(row.kind, "artifact.kind").toUpperCase();
  let kind: ArtifactKind;
  switch (rawKind) {
    case ArtifactKind.PROOF:
    case ArtifactKind.MESSAGE_ATTACHMENT:
      kind = rawKind;
      break;
    default:
      throw new Error("artifact.kind is invalid");
  }

  const sizeBytes = normalizeFiniteNumber(row.size_bytes, "artifact.size_bytes");
  if (sizeBytes > maxBytes) {
    throw new Error("artifact.size_bytes exceeds the configured maximum");
  }

  const meta = row.meta !== undefined ? (row.meta as Prisma.InputJsonValue) : undefined;

  return {
    kind,
    prescriptionId: normalizeOptionalString(row.prescription_id),
    originalName: normalizeRequiredString(row.original_name, "artifact.original_name"),
    mimeType: normalizeRequiredString(row.mime_type, "artifact.mime_type"),
    sizeBytes,
    meta,
  };
}

function normalizeNullablePositiveInt(value: unknown): number | null {
  if (value == null || value === "") {
    return null;
  }

  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }

  return Math.trunc(n);
}

function parseContentLength(value: string | string[] | undefined): number | null {
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

function getHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return typeof value === "string" ? value : null;
}

function isCompatibleContentType(actual: string, expected: string): boolean {
  return normalizeMimeType(actual) === normalizeMimeType(expected);
}

function normalizeMimeType(value: string): string {
  return value.split(";")[0]?.trim().toLowerCase() ?? "";
}

function resolvePublicBaseUrl(req: http.IncomingMessage, configuredBaseUrl?: string): string {
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

function resolveCorsOrigin(req: http.IncomingMessage, allowedOrigins: string[]): string | null {
  const requestOrigin = normalizeOptionalString(getHeaderValue(req.headers.origin));
  if (!requestOrigin) {
    return null;
  }

  return allowedOrigins.includes(requestOrigin) ? requestOrigin : null;
}

function buildUploadCorsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "PUT, OPTIONS",
    "Vary": "Origin",
  };
}

function applyUploadCorsHeaders(res: http.ServerResponse, origin: string): void {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "PUT, OPTIONS");
  res.setHeader("Vary", "Origin");
}

function buildArtifactS3Key(
  siteId: string,
  kind: ArtifactKind,
  artifactId: string,
  originalName: string,
  createdAt: Date,
): string {
  const year = String(createdAt.getUTCFullYear());
  const month = String(createdAt.getUTCMonth() + 1).padStart(2, "0");
  const extension = extractFileExtension(originalName);
  const kindSegment = kind === ArtifactKind.PROOF ? "proof" : "message-attachment";
  return `unit/${siteId}/artifacts/${kindSegment}/${year}/${month}/${artifactId}${extension}`;
}

function extractFileExtension(originalName: string): string {
  const match = originalName.toLowerCase().match(/(\.[a-z0-9]{1,8})$/);
  return match ? match[1] : "";
}

function serializeThreadState(threadState: ThreadState): Record<string, unknown> {
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

function serializeThreadMessage(message: ThreadMessageRecord): Record<string, unknown> {
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

function serializeThreadAttachment(attachment: ThreadMessageRecord["attachments"][number]): Record<string, unknown> {
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

function buildMessagesCanonicalGetPath(
  prescriptionId: string,
  actor: { role: ActorRole; wpUserId: number | null },
  afterSeq: number,
  limit: number,
): string {
  const search = new URLSearchParams();
  search.set("actor_role", actor.role);
  if (actor.wpUserId != null) {
    search.set("actor_wp_user_id", String(actor.wpUserId));
  }
  search.set("after_seq", String(afterSeq));
  search.set("limit", String(limit));
  return `/api/v1/prescriptions/${encodeURIComponent(prescriptionId)}/messages?${search.toString()}`;
}

function normalizeMessagesActorFromQuery(url: URL): { role: ActorRole; wpUserId: number | null } {
  return normalizeMessagesActorInput({
    role: url.searchParams.get("actor_role"),
    wp_user_id: url.searchParams.get("actor_wp_user_id"),
  });
}

function normalizeMessagesActorInput(value: unknown): { role: ActorRole; wpUserId: number | null } {
  try {
    return normalizeActorInput(value);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "actor is invalid";
    throw new MessagesRepoError("ML_MESSAGE_BAD_REQUEST", 400, message);
  }
}

function normalizeMessagesAfterSeqQuery(url: URL): number {
  const raw = normalizeOptionalString(url.searchParams.get("after_seq"));
  if (!raw) {
    return 0;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new MessagesRepoError("ML_MESSAGE_BAD_REQUEST", 400, "after_seq is invalid");
  }
  return parsed;
}

function normalizeMessagesLimitQuery(url: URL): number {
  const raw = normalizeOptionalString(url.searchParams.get("limit"));
  if (!raw) {
    return 50;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new MessagesRepoError("ML_MESSAGE_BAD_REQUEST", 400, "limit is invalid");
  }
  return Math.min(parsed, 100);
}

function normalizeAttachmentArtifactIds(value: unknown): string[] {
  if (value == null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new MessagesRepoError("ML_MESSAGE_BAD_REQUEST", 400, "attachment_artifact_ids must be an array");
  }

  const unique = new Set<string>();
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

function normalizeReadUptoSeq(value: unknown): number | null {
  if (value == null || value === "") {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new MessagesRepoError("ML_MESSAGE_BAD_REQUEST", 400, "read_upto_seq is invalid");
  }
  return Math.trunc(parsed);
}

function buildRequestId(): string {
  return `req_${crypto.randomBytes(8).toString("hex")}`;
}

type ResponseWithReqId = http.ServerResponse & {
  [RESPONSE_REQ_ID_SYMBOL]?: string;
};

function coalesceRequestId(value: unknown): string {
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }

  return buildRequestId();
}

function setResponseReqId(res: http.ServerResponse, reqId: unknown): string {
  const normalized = coalesceRequestId(reqId);
  (res as ResponseWithReqId)[RESPONSE_REQ_ID_SYMBOL] = normalized;
  return normalized;
}

function getResponseReqId(res: http.ServerResponse): string {
  const current = (res as ResponseWithReqId)[RESPONSE_REQ_ID_SYMBOL];
  if (typeof current === "string" && current.trim() !== "") {
    return current;
  }

  return setResponseReqId(res, undefined);
}

function normalizePublicErrorMessage(code: string, status: number, providedMessage: string | null): string {
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

function normalizeErrorResponseBody(res: http.ServerResponse, status: number, body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return body;
  }

  const row = body as Record<string, unknown>;
  if (row.ok !== false || typeof row.code !== "string") {
    return body;
  }

  const reqId = typeof row.req_id === "string" && row.req_id.trim() !== ""
    ? setResponseReqId(res, row.req_id)
    : getResponseReqId(res);
  const message = normalizePublicErrorMessage(
    row.code,
    status,
    typeof row.message === "string" ? row.message : null,
  );

  return {
    ...row,
    ok: false,
    code: row.code,
    message,
    req_id: reqId,
    schema_version: typeof row.schema_version === "string" && row.schema_version.trim() !== ""
      ? row.schema_version
      : CURRENT_SCHEMA_VERSION,
  } satisfies ErrorResponseBody & Record<string, unknown>;
}

function sendMessagesRepoError(
  res: http.ServerResponse,
  deps: PulseServerDeps,
  signingSecret: string,
  err: unknown,
  reqId: string | undefined,
  event: string,
  context: Record<string, unknown>,
): void {
  const effectiveReqId = setResponseReqId(res, reqId);

  if (err instanceof MessagesRepoError) {
    deps.logger.warning(event, { ...context, reason: err.message, code: err.code }, effectiveReqId, err);
    sendJson(res, err.statusCode, { ok: false, code: err.code, req_id: effectiveReqId }, signingSecret);
    return;
  }

  const message = err instanceof Error ? err.message : "messages_failed";
  deps.logger.error(event, { ...context, reason: message }, effectiveReqId, err);
  sendJson(res, 500, { ok: false, code: "ML_MESSAGES_FAILED", req_id: effectiveReqId }, signingSecret);
}

function serializeArtifact(artifact: ArtifactRecord): Record<string, unknown> {
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

function applyApiResponseHeaders(
  res: http.ServerResponse,
  extraHeaders?: Record<string, string>,
): void {
  for (const [header, value] of Object.entries(extraHeaders ?? {})) {
    res.setHeader(header, value);
  }

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("X-SOSPrescription-Request-ID", getResponseReqId(res));
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  signingSecret: string,
  extraHeaders?: Record<string, string>,
): void {
  const normalizedBody = normalizeErrorResponseBody(res, status, body);
  const data = Buffer.from(JSON.stringify(normalizedBody));
  const token = buildMls1Token(data, signingSecret);

  res.statusCode = status;
  applyApiResponseHeaders(res, extraHeaders);
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

function isClientArtifactError(message: string): boolean {
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
