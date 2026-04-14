// src/http/pulseServer.ts
import crypto from "node:crypto";
import http from "node:http";
import { URL } from "node:url";
import { ActorRole, ArtifactKind, Prisma, PrismaClient, SubmissionStatus } from "@prisma/client";
import { AnnuaireSanteService, AnnuaireSanteServiceError } from "../admission/annuaireSanteService";
import { AccountService, AccountServiceError } from "../auth/accountService";
import { AuthService, AuthServiceError } from "../auth/authService";
import { MemoryGuard } from "../admission/memoryGuard";
import { OpenRouterService } from "../ai/openRouterService";
import { ArtifactRepo, type ArtifactRecord } from "../artifacts/artifactRepo";
import { MailService, MailServiceError } from "../mail/mailService";
import { MessagesRepo, MessagesRepoError, type ThreadMessageRecord, type ThreadState } from "../messages/messagesRepo";
import {
  JobsRepoActionError,
  type ApprovePrescriptionRequest,
  type IngestDoctorInput,
  type IngestPrescriptionRequest,
  type JobsRepo,
  type QueueMetrics,
  type RejectPrescriptionRequest,
} from "../jobs/jobsRepo";
import { NdjsonLogger } from "../logger";
import { parseCanonicalGet, parseMls1Token, verifyMls1Payload } from "../security/mls1";
import { NonceCache } from "../security/nonceCache";
import { S3Service } from "../s3/s3Service";
import { SubmissionRepo, SubmissionRepoError } from "../submissions/submissionRepo";
import { PatientRepo, PatientRepoError, type PatientProfileRecord } from "../patients/patientRepo";
import { DoctorReadRepo } from "../prescriptions/doctorReadRepo";
import { PatientReadRepo } from "../prescriptions/patientReadRepo";
import { PrescriptionReadRepoError } from "../prescriptions/prescriptionReadMapper";
import { StripeGateway, type StripePaymentIntentRecord } from "../payments/stripeClient";
import { WordPressPaymentBridge } from "../payments/wordpressPaymentBridge";
import { SmartReplyService, type LatestSmartReplyRecord } from "../services/smartReplyService";
import { CopilotService, type PolishMessageConstraints } from "../services/copilotService";
import { handleMedicationSearchRequest } from "./medicationSearchController";

const MAX_INGEST_BODY_BYTES = 512 * 1024;
const ARTIFACT_ACCESS_TTL_SECONDS = 60;
const CURRENT_SCHEMA_VERSION = "2026.6";

const RESPONSE_REQ_ID_SYMBOL = Symbol("sosprescription.response_req_id");

let pulsePrismaSingleton: PrismaClient | null = null;
let pulseMailServiceSingleton: MailService | null = null;

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

interface SubmissionCreateRequestBody {
  req_id?: unknown;
  ts_ms?: unknown;
  site_id?: unknown;
  nonce?: unknown;
  actor?: {
    role?: unknown;
    wp_user_id?: unknown;
  };
  flow?: unknown;
  priority?: unknown;
  idempotency_key?: unknown;
}

interface SubmissionDraftRequestBody {
  req_id?: unknown;
  ts_ms?: unknown;
  site_id?: unknown;
  nonce?: unknown;
  email?: unknown;
  flow?: unknown;
  priority?: unknown;
  redirect_to?: unknown;
  verify_url?: unknown;
  idempotency_key?: unknown;
}

interface PatientProfileRequestBody {
  req_id?: unknown;
  ts_ms?: unknown;
  site_id?: unknown;
  nonce?: unknown;
  actor?: {
    role?: unknown;
    wp_user_id?: unknown;
  };
  first_name?: unknown;
  firstName?: unknown;
  last_name?: unknown;
  lastName?: unknown;
  birthdate?: unknown;
  birthDate?: unknown;
  gender?: unknown;
  email?: unknown;
  phone?: unknown;
  weight_kg?: unknown;
  weightKg?: unknown;
  height_cm?: unknown;
  heightCm?: unknown;
  note?: unknown;
  medical_notes?: unknown;
  medicalNotes?: unknown;
}

interface DoctorVerifyRppsRequestBody {
  req_id?: unknown;
  ts_ms?: unknown;
  site_id?: unknown;
  nonce?: unknown;
  actor?: {
    role?: unknown;
    wp_user_id?: unknown;
  };
  rpps?: unknown;
}

interface AuthRequestLinkRequestBody {
  req_id?: unknown;
  ts_ms?: unknown;
  site_id?: unknown;
  nonce?: unknown;
  email?: unknown;
  verify_url?: unknown;
}

interface AuthVerifyLinkRequestBody {
  req_id?: unknown;
  ts_ms?: unknown;
  site_id?: unknown;
  nonce?: unknown;
  token?: unknown;
}

interface AccountDeleteRequestBody {
  req_id?: unknown;
  ts_ms?: unknown;
  site_id?: unknown;
  nonce?: unknown;
  actor?: {
    role?: unknown;
    wp_user_id?: unknown;
  };
}

interface LegacyReadFiltersRequestBody {
  status?: unknown;
  limit?: unknown;
  offset?: unknown;
}

interface LegacyReadListRequestBody {
  req_id?: unknown;
  ts_ms?: unknown;
  site_id?: unknown;
  nonce?: unknown;
  actor?: {
    role?: unknown;
    wp_user_id?: unknown;
  };
  filters?: LegacyReadFiltersRequestBody;
  status?: unknown;
  limit?: unknown;
  offset?: unknown;
}

interface PrescriptionGetRequestBody {
  req_id?: unknown;
  ts_ms?: unknown;
  site_id?: unknown;
  nonce?: unknown;
  actor?: {
    role?: unknown;
    wp_user_id?: unknown;
  };
  prescription_id?: unknown;
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

interface MessagePolishRequestBody {
  actor?: {
    role?: unknown;
    wp_user_id?: unknown;
  };
  draft?: unknown;
  constraints?: {
    audience?: unknown;
    tone?: unknown;
    language?: unknown;
    max_characters?: unknown;
    maxCharacters?: unknown;
    preserve_decision?: unknown;
    preserveDecision?: unknown;
    force_clarification_if_ambiguous?: unknown;
    forceClarificationIfAmbiguous?: unknown;
  };
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
  stripeGateway: StripeGateway;
  wpPaymentBridge: WordPressPaymentBridge;
  smartReplyService?: SmartReplyService;
  copilotService?: CopilotService;
}

export function startPulseServer(deps: PulseServerDeps): http.Server {
  const signingSecret = deps.secrets[0];
  const submissionRepo = new SubmissionRepo({ logger: deps.logger });
  const patientRepo = new PatientRepo({ logger: deps.logger });
  const authService = new AuthService({ logger: deps.logger });
  const accountService = new AccountService({ logger: deps.logger });
  const mailService = new MailService({ logger: deps.logger });
  pulseMailServiceSingleton = mailService;
  const annuaireSanteService = new AnnuaireSanteService({ logger: deps.logger });
  const doctorReadRepo = new DoctorReadRepo({ logger: deps.logger });
  const patientReadRepo = new PatientReadRepo({ logger: deps.logger });

  const server = http.createServer(async (req, res) => {
    setResponseReqId(res, buildRequestId());

    try {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (method === "GET" && path === "/pulse") {
        return await handlePulse(req, res, deps, signingSecret);
      }

      if (method === "GET" && path === "/api/v2/medications/search") {
        return await handleMedicationSearch(req, res, deps, signingSecret, url);
      }

      if (method === "POST" && path === "/webhooks/stripe") {
        return await handleStripeWebhook(req, res, deps);
      }

      if (method === "POST" && path === "/api/v2/auth/request-link") {
        return await handleAuthRequestLink(req, res, deps, signingSecret, authService, mailService);
      }

      if (method === "POST" && path === "/api/v2/auth/verify-link") {
        return await handleAuthVerifyLink(req, res, deps, signingSecret, authService);
      }

      if (method === "POST" && path === "/api/v2/account/delete") {
        return await handleAccountDelete(req, res, deps, signingSecret, accountService);
      }

      if (method === "POST" && path === "/api/v2/submissions") {
        return await handleSubmissionCreate(req, res, deps, signingSecret, submissionRepo);
      }

      if (method === "POST" && path === "/api/v2/submissions/draft") {
        return await handleSubmissionDraftCreate(req, res, deps, signingSecret, submissionRepo, authService, mailService);
      }

      const submissionArtifactInitMatch = method === "POST" ? path.match(/^\/api\/v2\/submissions\/([^/]+)\/artifacts\/init$/) : null;
      if (submissionArtifactInitMatch) {
        return await handleSubmissionArtifactUploadInit(
          req,
          res,
          deps,
          signingSecret,
          decodeURIComponent(submissionArtifactInitMatch[1]),
        );
      }

      const submissionFinalizeMatch = method === "POST" ? path.match(/^\/api\/v2\/submissions\/([^/]+)\/finalize$/) : null;
      if (submissionFinalizeMatch) {
        return await handleSubmissionFinalize(
          req,
          res,
          deps,
          signingSecret,
          submissionRepo,
          decodeURIComponent(submissionFinalizeMatch[1]),
        );
      }

      if (method === "GET" && path === "/api/v2/patient/profile") {
        return await handlePatientProfileGet(req, res, deps, signingSecret, patientRepo, url);
      }

      if (method === "PUT" && path === "/api/v2/patient/profile") {
        return await handlePatientProfilePut(req, res, deps, signingSecret, patientRepo);
      }

      if (method === "POST" && path === "/api/v2/doctor/verify-rpps") {
        return await handleDoctorVerifyRpps(req, res, deps, signingSecret, annuaireSanteService);
      }

      if (method === "POST" && path === "/api/v2/doctor/inbox") {
        return await handleDoctorInbox(req, res, deps, signingSecret, doctorReadRepo);
      }

      if (method === "POST" && path === "/api/v2/patient/prescriptions/query") {
        return await handlePatientPrescriptionsQuery(req, res, deps, signingSecret, patientReadRepo);
      }

      if (method === "POST" && path === "/api/v2/prescriptions/get") {
        return await handlePrescriptionGet(req, res, deps, signingSecret, doctorReadRepo, patientReadRepo);
      }

      const prescriptionDownloadMatch = method === "GET" ? path.match(/^\/api\/v2\/prescriptions\/([^/]+)\/download$/) : null;
      if (prescriptionDownloadMatch) {
        return await handlePrescriptionDownload(
          req,
          res,
          deps,
          signingSecret,
          url,
          decodeURIComponent(prescriptionDownloadMatch[1]),
        );
      }

      if (method === "POST" && path === "/api/v2/messages/polish") {
        return await handleMessagesPolish(req, res, deps, signingSecret);
      }

      const smartRepliesGetMatch = method === "GET" ? path.match(/^\/api\/v2\/prescriptions\/([^/]+)\/smart-replies$/) : null;
      if (smartRepliesGetMatch) {
        return await handlePrescriptionSmartRepliesGet(
          req,
          res,
          deps,
          signingSecret,
          url,
          decodeURIComponent(smartRepliesGetMatch[1]),
        );
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

function logSubmissionRejected(
  logger: NdjsonLogger,
  reqId: string,
  phase: "create" | "create_draft" | "finalize" | "artifact_init",
  reason: string,
  code?: string,
  submissionRef?: string,
  err?: unknown,
  severity: "warning" | "error" = "warning",
): void {
  const context: Record<string, unknown> = {
    phase,
    reason,
  };

  if (code) {
    context.code = code;
  }

  if (submissionRef) {
    context.submission_ref = submissionRef;
  }

  if (severity === "error") {
    logger.error("submission.finalize.rejected", context, reqId, err);
    return;
  }

  logger.warning("submission.finalize.rejected", context, reqId, err);
}

function isSubmissionExpiredError(err: unknown): boolean {
  return err instanceof SubmissionRepoError && err.code === "ML_SUBMISSION_EXPIRED";
}


async function handleMedicationSearch(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: PulseServerDeps,
  signingSecret: string,
  url: URL,
): Promise<void> {
  const response = await handleMedicationSearchRequest(url, { logger: deps.logger });
  sendJson(res, response.statusCode, response.body, signingSecret);
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

async function handleSubmissionCreate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: PulseServerDeps,
  signingSecret: string,
  submissionRepo: SubmissionRepo,
): Promise<void> {
  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req, MAX_INGEST_BODY_BYTES);
  } catch (err: unknown) {
    const code = err instanceof Error ? err.message : "ML_BODY_READ_FAILED";
    const status = code === "ML_BODY_TOO_LARGE" ? 413 : 400;
    logSubmissionRejected(deps.logger, getResponseReqId(res), "create", code, code, undefined, err, "warning");
    return sendJson(res, status, { ok: false, code }, signingSecret);
  }

  const parsed = validateSignedJsonBody(req, rawBody, deps.secrets);
  if (parsed.ok !== true) {
    if (parsed.logReason) {
      deps.logger.warning(
        "security.mls1.rejected",
        { reason: parsed.logReason, path: "/api/v2/submissions" },
        getResponseReqId(res),
      );
    }
    return sendJson(res, parsed.statusCode, { ok: false, code: parsed.code }, signingSecret);
  }

  let body: SubmissionCreateRequestBody;
  try {
    const candidate = JSON.parse(rawBody.toString("utf8")) as unknown;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("bad_json");
    }
    body = candidate as SubmissionCreateRequestBody;
  } catch (err: unknown) {
    logSubmissionRejected(deps.logger, getResponseReqId(res), "create", "ML_SUBMISSION_BAD_JSON", "ML_SUBMISSION_BAD_JSON", undefined, err, "warning");
    return sendJson(res, 400, { ok: false, code: "ML_SUBMISSION_BAD_JSON" }, signingSecret);
  }

  const reqId = typeof body.req_id === "string" && body.req_id.trim() !== ""
    ? setResponseReqId(res, body.req_id)
    : getResponseReqId(res);

  if (hasSubmissionSignedEnvelope(body)) {
    try {
      if (typeof body.req_id !== "string" || body.req_id.trim() === "") {
        throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, "req_id is required");
      }
      validateSignedEnvelope(body as unknown as Record<string, unknown>, deps, reqId);
    } catch (err: unknown) {
      if (err instanceof SubmissionRepoError) {
        logSubmissionRejected(deps.logger, reqId, "create", err.message, err.code, undefined, err, "warning");
      } else {
        const message = err instanceof Error ? err.message : "submission_envelope_invalid";
        logSubmissionRejected(deps.logger, reqId, "create", message, "ML_SUBMISSION_BAD_REQUEST", undefined, err, "warning");
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
      reqId,
      idempotencyKey,
    });

    deps.logger.info(
      "submission.created",
      {
        mode: result.mode,
        submission_ref: result.submission.publicRef,
        owner_role: result.submission.ownerRole,
        owner_wp_user_id: result.submission.ownerWpUserId,
        flow_key: result.submission.flowKey,
        priority: result.submission.priority,
        expires_at: result.submission.expiresAt.toISOString(),
        idempotency_key_present: Boolean(idempotencyKey),
      },
      reqId,
    );

    return sendJson(
      res,
      result.mode === "replayed" ? 200 : 201,
      {
        ok: true,
        schema_version: CURRENT_SCHEMA_VERSION,
        submission_ref: result.submission.publicRef,
        expires_at: result.submission.expiresAt.toISOString(),
        status: result.submission.status,
      },
      signingSecret,
    );
  } catch (err: unknown) {
    if (err instanceof SubmissionRepoError) {
      if (!isSubmissionExpiredError(err) && err.statusCode < 500) {
        logSubmissionRejected(deps.logger, reqId, "create", err.message, err.code, undefined, err, "warning");
      }
      return sendJson(
        res,
        err.statusCode,
        { ok: false, code: err.code, req_id: reqId },
        signingSecret,
      );
    }

    const message = err instanceof Error ? err.message : "submission_create_failed";
    logSubmissionRejected(deps.logger, reqId, "create", message, "ML_SUBMISSION_CREATE_FAILED", undefined, err, "error");
    return sendJson(
      res,
      500,
      { ok: false, code: "ML_SUBMISSION_CREATE_FAILED", req_id: reqId },
      signingSecret,
    );
  }
}

async function handleSubmissionDraftCreate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: PulseServerDeps,
  signingSecret: string,
  submissionRepo: SubmissionRepo,
  authService: AuthService,
  mailService: MailService,
): Promise<void> {
  const parsedBody = await parseSignedActionBody(req, res, deps, "/api/v2/submissions/draft");
  if (parsedBody.ok !== true) {
    logSubmissionRejected(deps.logger, getResponseReqId(res), "create_draft", parsedBody.code, parsedBody.code, undefined, undefined, "warning");
    return sendJson(res, parsedBody.statusCode, { ok: false, code: parsedBody.code }, signingSecret);
  }

  const reqId = parsedBody.reqId;

  try {
    const body = parsedBody.body as SubmissionDraftRequestBody;
    const email = normalizeMagicLinkRequestEmail(body.email);
    const flowKey = normalizeSubmissionFlow(body.flow);
    const priority = normalizeSubmissionPriority(body.priority);
    const redirectTo = normalizeOptionalRedirectTo(body.redirect_to);
    const verifyUrl = normalizeOptionalMagicLinkVerifyUrl(body.verify_url);
    const idempotencyKey = normalizeSubmissionIdempotencyKey(body.idempotency_key);

    const draftResult = await submissionRepo.createDraftSubmission({
      email,
      flowKey,
      priority,
      reqId,
      idempotencyKey,
    });

    const resumeRedirect = appendResumeDraftToRedirect(redirectTo, draftResult.submission.publicRef);

    const issued = await authService.issueMagicLink({
      email,
      ownerRole: ActorRole.PATIENT,
      ownerWpUserId: null,
      metadata: {
        draft_ref: draftResult.submission.publicRef,
        redirect_to: resumeRedirect,
      },
    }, reqId);

    deps.logger.info(
      "submission.draft.magic_link.dispatching",
      {
        submission_ref: draftResult.submission.publicRef,
        email_fp: fingerprintPublicId(email),
        redirect_present: resumeRedirect !== "",
      },
      reqId,
    );

    const mailResult = await mailService.sendMagicLink(
      {
        email,
        token: issued.token,
        expiresAt: issued.expiresAt,
        verifyBaseUrl: verifyUrl || undefined,
      },
      reqId,
    );

    deps.logger.info(
      "submission.draft.magic_link.dispatched",
      {
        submission_ref: draftResult.submission.publicRef,
        email_fp: fingerprintPublicId(email),
        delivery_mode: mailResult.deliveryMode,
        sent: mailResult.sent,
      },
      reqId,
    );

    deps.logger.info(
      "submission.draft.created",
      {
        mode: draftResult.mode,
        submission_ref: draftResult.submission.publicRef,
        flow_key: draftResult.submission.flowKey,
        priority: draftResult.submission.priority,
        email_fp: fingerprintPublicId(email),
        sent: mailResult.sent,
      },
      reqId,
    );

    return sendJson(
      res,
      draftResult.mode === "replayed" ? 200 : 201,
      {
        ok: true,
        schema_version: CURRENT_SCHEMA_VERSION,
        sent: true,
        submission_ref: draftResult.submission.publicRef,
        status: draftResult.submission.status,
        expires_at: draftResult.submission.expiresAt.toISOString(),
        expires_in: issued.expiresIn,
        redirect_to: resumeRedirect,
        req_id: reqId,
      },
      signingSecret,
    );
  } catch (err: unknown) {
    if (err instanceof SubmissionRepoError || err instanceof AuthServiceError || err instanceof MailServiceError) {
      if (err.statusCode >= 500) {
        deps.logger.error("submission.draft.failed", { code: err.code, reason: err.message }, reqId, err);
      } else {
        deps.logger.warning("submission.draft.failed", { code: err.code, reason: err.message }, reqId, err);
      }

      return sendJson(
        res,
        err.statusCode,
        { ok: false, code: err.code, req_id: reqId },
        signingSecret,
      );
    }

    if (err instanceof Error && /(required|invalid)$/i.test(err.message)) {
      deps.logger.warning("submission.draft.failed", { code: "ML_SUBMISSION_BAD_REQUEST", reason: err.message }, reqId, err);
      return sendJson(
        res,
        400,
        { ok: false, code: "ML_SUBMISSION_BAD_REQUEST", req_id: reqId },
        signingSecret,
      );
    }

    const message = err instanceof Error ? err.message : "submission_draft_failed";
    deps.logger.error("submission.draft.failed", { reason: message }, reqId, err);
    return sendJson(
      res,
      500,
      { ok: false, code: "ML_SUBMISSION_CREATE_FAILED", req_id: reqId },
      signingSecret,
    );
  }
}

async function handleSubmissionArtifactUploadInit(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: PulseServerDeps,
  signingSecret: string,
  submissionRef: string,
): Promise<void> {
  const parsedBody = await parseSignedActionBody(req, res, deps, `/api/v2/submissions/${submissionRef}/artifacts/init`);
  if (parsedBody.ok !== true) {
    logSubmissionRejected(deps.logger, getResponseReqId(res), "artifact_init", parsedBody.code, parsedBody.code, submissionRef, undefined, "warning");
    return sendJson(res, parsedBody.statusCode, { ok: false, code: parsedBody.code }, signingSecret);
  }

  const reqId = parsedBody.reqId;
  try {
    const payload = parsedBody.body as ArtifactInitRequestBody;
    const actor = normalizeSubmissionActorInput(payload.actor);
    const artifactInput = normalizeArtifactInitInput(payload.artifact, deps.artifactUploadMaxBytes);
    const submission = await resolveSubmissionForArtifactInit(submissionRef, actor, deps.logger, reqId);

    const created = await deps.artifactRepo.initUpload({
      kind: artifactInput.kind,
      ownerRole: actor.role,
      ownerWpUserId: actor.wpUserId,
      prescriptionId: null,
      submissionId: submission.id,
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
    if (err instanceof SubmissionRepoError) {
      if (!isSubmissionExpiredError(err)) {
        logSubmissionRejected(deps.logger, reqId, "artifact_init", err.message, err.code, submissionRef, err, "warning");
      }
      return sendJson(
        res,
        err.statusCode,
        { ok: false, code: err.code, req_id: reqId },
        signingSecret,
      );
    }

    const message = err instanceof Error ? err.message : "artifact_upload_init_failed";
    const statusCode = isClientArtifactError(message) ? 400 : 500;
    const code = isClientArtifactError(message) ? "ML_ARTIFACT_BAD_REQUEST" : "ML_ARTIFACT_INIT_FAILED";
    logSubmissionRejected(deps.logger, reqId, "artifact_init", message, code, submissionRef, err, statusCode >= 500 ? "error" : "warning");
    return sendJson(res, statusCode, { ok: false, code, req_id: reqId }, signingSecret);
  }
}

async function handleSubmissionFinalize(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: PulseServerDeps,
  signingSecret: string,
  submissionRepo: SubmissionRepo,
  submissionRef: string,
): Promise<void> {
  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req, MAX_INGEST_BODY_BYTES);
  } catch (err: unknown) {
    const code = err instanceof Error ? err.message : "ML_BODY_READ_FAILED";
    const status = code === "ML_BODY_TOO_LARGE" ? 413 : 400;
    logSubmissionRejected(deps.logger, getResponseReqId(res), "finalize", code, code, submissionRef, err, "warning");
    return sendJson(res, status, { ok: false, code }, signingSecret);
  }

  const parsed = validateSignedJsonBody(req, rawBody, deps.secrets);
  if (parsed.ok !== true) {
    if (parsed.logReason) {
      deps.logger.warning(
        "security.mls1.rejected",
        { reason: parsed.logReason, path: `/api/v2/submissions/${submissionRef}/finalize` },
        getResponseReqId(res),
      );
    }
    return sendJson(res, parsed.statusCode, { ok: false, code: parsed.code }, signingSecret);
  }

  let body: Record<string, unknown>;
  try {
    const candidate = JSON.parse(rawBody.toString("utf8")) as unknown;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("bad_json");
    }
    body = candidate as Record<string, unknown>;
  } catch (err: unknown) {
    logSubmissionRejected(deps.logger, getResponseReqId(res), "finalize", "ML_SUBMISSION_BAD_JSON", "ML_SUBMISSION_BAD_JSON", submissionRef, err, "warning");
    return sendJson(res, 400, { ok: false, code: "ML_SUBMISSION_BAD_JSON" }, signingSecret);
  }

  const reqId = typeof body.req_id === "string" && body.req_id.trim() !== ""
    ? setResponseReqId(res, body.req_id)
    : getResponseReqId(res);

  if (hasSignedEnvelopeFields(body)) {
    try {
      if (typeof body.req_id !== "string" || body.req_id.trim() === "") {
        throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, "req_id is required");
      }
      validateSignedEnvelope(body, deps, reqId);
    } catch (err: unknown) {
      if (err instanceof SubmissionRepoError) {
        logSubmissionRejected(deps.logger, reqId, "finalize", err.message, err.code, submissionRef, err, "warning");
      } else {
        const message = err instanceof Error ? err.message : "submission_finalize_envelope_invalid";
        logSubmissionRejected(deps.logger, reqId, "finalize", message, "ML_SUBMISSION_BAD_REQUEST", submissionRef, err, "warning");
      }
      return sendJson(res, 400, { ok: false, code: "ML_SUBMISSION_BAD_REQUEST", req_id: reqId }, signingSecret);
    }
  }

  try {
    const normalized = normalizeSubmissionFinalizeRequestInput(body);

    const result = await submissionRepo.finalizeSubmission({
      submissionRef,
      actor: normalized.actor,
      reqId,
      idempotencyKey: normalized.idempotencyKey,
      patient: normalized.patient,
      items: normalized.items,
      privateNotes: normalized.privateNotes,
    });

    const final = normalizeSubmissionFinalizeResult(result);

    deps.logger.info(
      "submission.finalized",
      {
        mode: result.mode,
        submission_ref: submissionRef,
        prescription_id: final.prescriptionId,
        uid: final.uid,
        status: final.status,
        processing_status: final.processingStatus,
        item_count: normalized.items.length,
        proof_count: result.proof_count,
      },
      reqId,
    );

    return sendJson(
      res,
      result.mode === "replayed" ? 200 : 201,
      {
        ok: true,
        schema_version: CURRENT_SCHEMA_VERSION,
        prescription_id: final.prescriptionId,
        uid: final.uid,
        status: final.status,
        processing_status: final.processingStatus,
      },
      signingSecret,
    );
  } catch (err: unknown) {
    if (err instanceof SubmissionRepoError) {
      if (!isSubmissionExpiredError(err) && err.statusCode < 500) {
        logSubmissionRejected(deps.logger, reqId, "finalize", err.message, err.code, submissionRef, err, "warning");
      }
      return sendJson(res, err.statusCode, { ok: false, code: err.code, req_id: reqId }, signingSecret);
    }

    const message = err instanceof Error ? err.message : "submission_finalize_failed";
    logSubmissionRejected(deps.logger, reqId, "finalize", message, "ML_SUBMISSION_FINALIZE_FAILED", submissionRef, err, "error");
    return sendJson(
      res,
      500,
      { ok: false, code: "ML_SUBMISSION_FINALIZE_FAILED", req_id: reqId },
      signingSecret,
    );
  }
}

async function handlePatientProfileGet(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: PulseServerDeps,
  signingSecret: string,
  patientRepo: PatientRepo,
  url: URL,
): Promise<void> {
  const parsed = validateSignedRequestHeader(req, deps.secrets);
  if (parsed.ok !== true) {
    if (parsed.logReason) {
      deps.logger.warning(
        "security.mls1.rejected",
        { reason: parsed.logReason, path: "/api/v2/patient/profile" },
        getResponseReqId(res),
      );
    }
    return sendJson(res, parsed.statusCode, { ok: false, code: parsed.code }, signingSecret);
  }

  let actor: { role: "PATIENT"; wpUserId: number };
  try {
    actor = normalizePatientProfileActorFromQuery(url);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "patient_profile_bad_request";
    deps.logger.warning("patient_profile.get.rejected", { reason: message }, getResponseReqId(res), err);
    return sendJson(res, 400, { ok: false, code: "ML_PATIENT_PROFILE_BAD_REQUEST" }, signingSecret);
  }

  const canon = parseCanonicalGet(parsed.token.payloadBytes);
  if (!canon) {
    return sendJson(res, 400, { ok: false, code: "ML_AUTH_BAD_PAYLOAD" }, signingSecret);
  }

  const expectedPath = buildPatientProfileCanonicalGetPath(actor);
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
    const profile = await patientRepo.getProfileByActor(actor);
    return sendJson(
      res,
      200,
      buildPatientProfileApiPayload(actor.wpUserId, profile, "Profil chargé."),
      signingSecret,
    );
  } catch (err: unknown) {
    if (err instanceof PatientRepoError) {
      deps.logger.warning(
        "patient_profile.get.rejected",
        { code: err.code, reason: err.message, wp_user_id: actor.wpUserId },
        getResponseReqId(res),
        err,
      );
      return sendJson(res, err.statusCode, { ok: false, code: err.code }, signingSecret);
    }

    const message = err instanceof Error ? err.message : "patient_profile_get_failed";
    deps.logger.error(
      "patient_profile.get.failed",
      { reason: message, wp_user_id: actor.wpUserId },
      getResponseReqId(res),
      err,
    );
    return sendJson(res, 500, { ok: false, code: "ML_PATIENT_PROFILE_GET_FAILED" }, signingSecret);
  }
}

async function handlePatientProfilePut(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: PulseServerDeps,
  signingSecret: string,
  patientRepo: PatientRepo,
): Promise<void> {
  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req, MAX_INGEST_BODY_BYTES);
  } catch (err: unknown) {
    const code = err instanceof Error ? err.message : "ML_BODY_READ_FAILED";
    const status = code === "ML_BODY_TOO_LARGE" ? 413 : 400;
    deps.logger.warning("patient_profile.put.rejected", { reason: code }, getResponseReqId(res));
    return sendJson(res, status, { ok: false, code }, signingSecret);
  }

  const parsed = validateSignedJsonBody(req, rawBody, deps.secrets);
  if (parsed.ok !== true) {
    if (parsed.logReason) {
      deps.logger.warning(
        "security.mls1.rejected",
        { reason: parsed.logReason, path: "/api/v2/patient/profile" },
        getResponseReqId(res),
      );
    }
    return sendJson(res, parsed.statusCode, { ok: false, code: parsed.code }, signingSecret);
  }

  let body: PatientProfileRequestBody;
  try {
    const candidate = JSON.parse(rawBody.toString("utf8")) as unknown;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("bad_json");
    }
    body = candidate as PatientProfileRequestBody;
  } catch {
    return sendJson(res, 400, { ok: false, code: "ML_PATIENT_PROFILE_BAD_REQUEST" }, signingSecret);
  }

  const reqId = typeof body.req_id === "string" && body.req_id.trim() !== ""
    ? setResponseReqId(res, body.req_id)
    : getResponseReqId(res);

  if (hasPatientProfileSignedEnvelope(body)) {
    try {
      if (typeof body.req_id !== "string" || body.req_id.trim() === "") {
        throw new PatientRepoError("ML_PATIENT_PROFILE_BAD_REQUEST", 400, "req_id is required");
      }
      validateSignedEnvelope(body as unknown as Record<string, unknown>, deps, reqId);
    } catch (err: unknown) {
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
      note: normalized.note,
    });

    deps.logger.info(
      "patient_profile.put.accepted",
      {
        wp_user_id: normalized.actor.wpUserId,
        has_birthdate: profile.birthDate !== "",
        has_email: Boolean(profile.email),
        has_phone: Boolean(profile.phone),
        has_weight: Boolean(profile.weightKg),
        has_height: Boolean(profile.heightCm),
        has_note: Boolean(profile.note),
      },
      reqId,
    );

    return sendJson(
      res,
      200,
      buildPatientProfileApiPayload(normalized.actor.wpUserId, profile, "Profil enregistré."),
      signingSecret,
    );
  } catch (err: unknown) {
    if (err instanceof PatientRepoError) {
      deps.logger.warning(
        "patient_profile.put.rejected",
        { code: err.code, reason: err.message },
        reqId,
        err,
      );
      return sendJson(res, err.statusCode, { ok: false, code: err.code, req_id: reqId }, signingSecret);
    }

    const message = err instanceof Error ? err.message : "patient_profile_save_failed";
    deps.logger.error(
      "patient_profile.put.failed",
      { reason: message },
      reqId,
      err,
    );
    return sendJson(res, 500, { ok: false, code: "ML_PATIENT_PROFILE_SAVE_FAILED", req_id: reqId }, signingSecret);
  }
}


async function handleDoctorVerifyRpps(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: PulseServerDeps,
  signingSecret: string,
  annuaireSanteService: AnnuaireSanteService,
): Promise<void> {
  const parsedBody = await parseSignedActionBody(req, res, deps, "/api/v2/doctor/verify-rpps");
  if (parsedBody.ok !== true) {
    return sendJson(res, parsedBody.statusCode, { ok: false, code: parsedBody.code }, signingSecret);
  }

  const reqId = parsedBody.reqId;

  try {
    const body = parsedBody.body as DoctorVerifyRppsRequestBody;
    const actor = body.actor != null ? normalizeActorInput(body.actor) : null;
    if (actor && actor.role !== ActorRole.DOCTOR && actor.role !== ActorRole.SYSTEM) {
      return sendJson(res, 403, { ok: false, code: "ML_INGEST_FORBIDDEN", req_id: reqId }, signingSecret);
    }

    const rpps = normalizeDoctorVerifyRppsInput(body);
    const result = await annuaireSanteService.verifyRpps(rpps, reqId);

    deps.logger.info(
      result.valid ? "doctor.verify_rpps.completed" : "doctor.verify_rpps.not_found",
      {
        actor_role: actor?.role ?? null,
        actor_wp_user_id: actor?.wpUserId ?? null,
        valid: result.valid,
        rpps_fp: fingerprintPublicId(result.rpps),
        profession_present: result.profession !== "",
      },
      reqId,
    );

    return sendJson(
      res,
      200,
      {
        ok: true,
        schema_version: CURRENT_SCHEMA_VERSION,
        valid: result.valid,
        rpps: result.rpps,
        firstName: result.firstName,
        first_name: result.firstName,
        lastName: result.lastName,
        last_name: result.lastName,
        profession: result.profession,
        req_id: reqId,
      },
      signingSecret,
    );
  } catch (err: unknown) {
    if (err instanceof AnnuaireSanteServiceError) {
      const context = {
        code: err.code,
        status_code: err.statusCode,
      };

      if (err.statusCode >= 500) {
        deps.logger.error("doctor.verify_rpps.failed", context, reqId, err);
      } else {
        deps.logger.warning("doctor.verify_rpps.failed", context, reqId, err);
      }

      return sendJson(
        res,
        err.statusCode,
        {
          ok: false,
          code: err.code,
          message: err.statusCode >= 500 ? "La vérification RPPS est temporairement indisponible." : err.message,
          req_id: reqId,
        },
        signingSecret,
      );
    }

    const message = err instanceof Error ? err.message : "doctor_verify_rpps_failed";
    deps.logger.error("doctor.verify_rpps.failed", { reason: message }, reqId, err);
    return sendJson(
      res,
      500,
      { ok: false, code: "ML_RPPS_LOOKUP_UNAVAILABLE", message: "doctor_verify_rpps_failed", req_id: reqId },
      signingSecret,
    );
  }
}

async function handleAuthRequestLink(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: PulseServerDeps,
  signingSecret: string,
  authService: AuthService,
  mailService: MailService,
): Promise<void> {
  const parsedBody = await parseSignedActionBody(req, res, deps, "/api/v2/auth/request-link");
  if (parsedBody.ok !== true) {
    return sendJson(res, parsedBody.statusCode, { ok: false, code: parsedBody.code }, signingSecret);
  }

  const reqId = parsedBody.reqId;

  try {
    const body = parsedBody.body as AuthRequestLinkRequestBody;
    const email = normalizeMagicLinkRequestEmail(body.email);
    const verifyUrl = normalizeOptionalMagicLinkVerifyUrl(body.verify_url);
    const lookup = await authService.lookupOwnerByEmail(email, reqId);

    if (lookup.status !== "matched" || !lookup.candidate) {
      deps.logger.info(
        "auth.request_link.accepted",
        {
          email_fp: fingerprintPublicId(email),
          owner_match: lookup.status,
          sent: false,
        },
        reqId,
      );

      return sendJson(
        res,
        200,
        {
          ok: true,
          schema_version: CURRENT_SCHEMA_VERSION,
          sent: false,
          not_found: true,
          code: "ML_AUTH_EMAIL_NOT_FOUND",
          message: "Adresse e-mail inconnue.",
          owner_match: lookup.status,
          req_id: reqId,
        },
        signingSecret,
      );
    }

    const issued = await authService.issueMagicLink({
      email: lookup.candidate.email,
      ownerRole: lookup.candidate.ownerRole,
      ownerWpUserId: lookup.candidate.ownerWpUserId,
    }, reqId);

    await mailService.sendMagicLink(
      {
        email: lookup.candidate.email,
        token: issued.token,
        expiresAt: issued.expiresAt,
        verifyBaseUrl: verifyUrl || undefined,
      },
      reqId,
    );

    deps.logger.info(
      "auth.request_link.accepted",
      {
        email_fp: fingerprintPublicId(lookup.candidate.email),
        owner_role: lookup.candidate.ownerRole,
        owner_wp_user_id: lookup.candidate.ownerWpUserId,
        sent: true,
      },
      reqId,
    );

    return sendJson(
      res,
      200,
      {
        ok: true,
        schema_version: CURRENT_SCHEMA_VERSION,
        sent: true,
        expires_in: issued.expiresIn,
        req_id: reqId,
      },
      signingSecret,
    );
  } catch (err: unknown) {
    if (err instanceof AuthServiceError) {
      if (err.statusCode >= 500) {
        deps.logger.error("auth.request_link.failed", { code: err.code, reason: err.message }, reqId, err);
      } else {
        deps.logger.warning("auth.request_link.failed", { code: err.code, reason: err.message }, reqId, err);
      }

      return sendJson(
        res,
        err.statusCode,
        { ok: false, code: err.code, req_id: reqId },
        signingSecret,
      );
    }

    if (err instanceof MailServiceError) {
      deps.logger.error("auth.request_link.failed", { code: err.code, reason: err.message }, reqId, err);
      return sendJson(
        res,
        err.statusCode,
        { ok: false, code: err.code, req_id: reqId },
        signingSecret,
      );
    }

    if (err instanceof Error && /(required|invalid)$/i.test(err.message)) {
      deps.logger.warning("auth.request_link.failed", { code: "ML_MAGIC_LINK_BAD_REQUEST", reason: err.message }, reqId, err);
      return sendJson(
        res,
        400,
        { ok: false, code: "ML_MAGIC_LINK_BAD_REQUEST", req_id: reqId },
        signingSecret,
      );
    }

    const message = err instanceof Error ? err.message : "auth_request_link_failed";
    deps.logger.error("auth.request_link.failed", { reason: message }, reqId, err);
    return sendJson(
      res,
      500,
      { ok: false, code: "ML_MAGIC_LINK_REQUEST_FAILED", req_id: reqId },
      signingSecret,
    );
  }
}

async function handleAuthVerifyLink(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: PulseServerDeps,
  signingSecret: string,
  authService: AuthService,
): Promise<void> {
  const parsedBody = await parseSignedActionBody(req, res, deps, "/api/v2/auth/verify-link");
  if (parsedBody.ok !== true) {
    return sendJson(res, parsedBody.statusCode, { ok: false, code: parsedBody.code }, signingSecret);
  }

  const reqId = parsedBody.reqId;

  try {
    const body = parsedBody.body as AuthVerifyLinkRequestBody;
    const token = normalizeMagicLinkToken(body.token);
    const result = await authService.consumeMagicLink(token, reqId);

    const draftRef = typeof result.metadata?.draft_ref === "string" ? result.metadata.draft_ref : "";
    const redirectTo = typeof result.metadata?.redirect_to === "string" ? result.metadata.redirect_to : "";

    if (!result.valid || result.ownerRole == null) {
      deps.logger.info(
        "auth.verify_link.completed",
        {
          valid: false,
          token_fp: token !== "" ? fingerprintPublicId(token) : null,
          has_draft_ref: draftRef !== "",
        },
        reqId,
      );

      return sendJson(
        res,
        200,
        {
          ok: true,
          schema_version: CURRENT_SCHEMA_VERSION,
          valid: false,
          email: result.email || undefined,
          draft_ref: draftRef || undefined,
          redirect_to: redirectTo || undefined,
          req_id: reqId,
        },
        signingSecret,
      );
    }

    const publicRole = toPublicMagicLinkRole(result.ownerRole);

    deps.logger.info(
      "auth.verify_link.completed",
      {
        valid: true,
        owner_role: result.ownerRole,
        owner_wp_user_id: result.ownerWpUserId,
        has_draft_ref: draftRef !== "",
      },
      reqId,
    );

    return sendJson(
      res,
      200,
      {
        ok: true,
        schema_version: CURRENT_SCHEMA_VERSION,
        valid: true,
        email: result.email,
        wp_user_id: result.ownerWpUserId,
        role: publicRole,
        draft_ref: draftRef || undefined,
        redirect_to: redirectTo || undefined,
        req_id: reqId,
      },
      signingSecret,
    );
  } catch (err: unknown) {
    if (err instanceof AuthServiceError) {
      deps.logger.error("auth.verify_link.failed", { code: err.code, reason: err.message }, reqId, err);
      return sendJson(
        res,
        err.statusCode,
        { ok: false, code: err.code, req_id: reqId },
        signingSecret,
      );
    }

    const message = err instanceof Error ? err.message : "auth_verify_link_failed";
    deps.logger.error("auth.verify_link.failed", { reason: message }, reqId, err);
    return sendJson(
      res,
      500,
      { ok: false, code: "ML_MAGIC_LINK_VERIFY_FAILED", req_id: reqId },
      signingSecret,
    );
  }
}

async function handleAccountDelete(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: PulseServerDeps,
  signingSecret: string,
  accountService: AccountService,
): Promise<void> {
  const parsedBody = await parseSignedActionBody(req, res, deps, "/api/v2/account/delete");
  if (parsedBody.ok !== true) {
    return sendJson(res, parsedBody.statusCode, { ok: false, code: parsedBody.code }, signingSecret);
  }

  const reqId = parsedBody.reqId;

  try {
    const body = parsedBody.body as AccountDeleteRequestBody;
    const actor = normalizeAccountDeleteActorInput(body.actor);
    const result = await accountService.deleteAccount(actor.role, actor.wpUserId, reqId);

    deps.logger.info(
      "account.delete.accepted",
      {
        actor_role: actor.role,
        actor_wp_user_id: actor.wpUserId,
        account_id: result.accountId,
        auth_tokens_revoked: result.authTokensRevoked,
        not_found: result.notFound,
      },
      reqId,
    );

    return sendJson(
      res,
      200,
      {
        ok: true,
        schema_version: CURRENT_SCHEMA_VERSION,
        deleted: true,
        actor_role: actor.role === ActorRole.DOCTOR ? "doctor" : "patient",
        req_id: reqId,
      },
      signingSecret,
    );
  } catch (err: unknown) {
    if (err instanceof AccountServiceError) {
      if (err.statusCode >= 500) {
        deps.logger.error("account.delete.failed", { code: err.code, reason: err.message }, reqId, err);
      } else {
        deps.logger.warning("account.delete.failed", { code: err.code, reason: err.message }, reqId, err);
      }

      return sendJson(
        res,
        err.statusCode,
        { ok: false, code: err.code, req_id: reqId },
        signingSecret,
      );
    }

    const message = err instanceof Error ? err.message : "account_delete_failed";
    deps.logger.error("account.delete.failed", { reason: message }, reqId, err);
    return sendJson(
      res,
      500,
      { ok: false, code: "ML_ACCOUNT_DELETE_FAILED", req_id: reqId },
      signingSecret,
    );
  }
}

async function handleDoctorInbox(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: PulseServerDeps,
  signingSecret: string,
  doctorReadRepo: DoctorReadRepo,
): Promise<void> {
  const parsedBody = await parseSignedActionBody(req, res, deps, "/api/v2/doctor/inbox");
  if (parsedBody.ok !== true) {
    return sendJson(res, parsedBody.statusCode, { ok: false, code: parsedBody.code }, signingSecret);
  }

  const reqId = parsedBody.reqId;
  try {
    const body = parsedBody.body as LegacyReadListRequestBody;
    const actor = normalizeDoctorReadActorInput(body.actor);
    const filters = normalizeLegacyReadListFilters(body);
    const rows = await doctorReadRepo.queryInbox({
      actor,
      status: filters.status,
      limit: filters.limit,
      offset: filters.offset,
    });

    deps.logger.info(
      "doctor.inbox.fetched",
      {
        actor_wp_user_id: actor.wpUserId,
        status: filters.status,
        limit: filters.limit,
        offset: filters.offset,
        returned_count: rows.length,
      },
      reqId,
    );

    return sendJson(
      res,
      200,
      {
        ok: true,
        schema_version: CURRENT_SCHEMA_VERSION,
        rows,
        count: rows.length,
        limit: filters.limit,
        offset: filters.offset,
      },
      signingSecret,
    );
  } catch (err: unknown) {
    return sendPrescriptionReadRepoError(
      res,
      deps,
      signingSecret,
      err,
      reqId,
      "doctor.inbox.failed",
      {
        route: "/api/v2/doctor/inbox",
      },
      "ML_DOCTOR_INBOX_FAILED",
    );
  }
}

async function handlePatientPrescriptionsQuery(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: PulseServerDeps,
  signingSecret: string,
  patientReadRepo: PatientReadRepo,
): Promise<void> {
  const parsedBody = await parseSignedActionBody(req, res, deps, "/api/v2/patient/prescriptions/query");
  if (parsedBody.ok !== true) {
    return sendJson(res, parsedBody.statusCode, { ok: false, code: parsedBody.code }, signingSecret);
  }

  const reqId = parsedBody.reqId;
  try {
    const body = parsedBody.body as LegacyReadListRequestBody;
    const actor = normalizePatientReadActorInput(body.actor);
    const filters = normalizeLegacyReadListFilters(body);
    const rows = await patientReadRepo.queryPrescriptions({
      actor,
      status: filters.status,
      limit: filters.limit,
      offset: filters.offset,
    });

    deps.logger.info(
      "patient.prescriptions.fetched",
      {
        actor_wp_user_id: actor.wpUserId,
        status: filters.status,
        limit: filters.limit,
        offset: filters.offset,
        returned_count: rows.length,
      },
      reqId,
    );

    return sendJson(
      res,
      200,
      {
        ok: true,
        schema_version: CURRENT_SCHEMA_VERSION,
        rows,
        count: rows.length,
        limit: filters.limit,
        offset: filters.offset,
      },
      signingSecret,
    );
  } catch (err: unknown) {
    return sendPrescriptionReadRepoError(
      res,
      deps,
      signingSecret,
      err,
      reqId,
      "patient.prescriptions.failed",
      {
        route: "/api/v2/patient/prescriptions/query",
      },
      "ML_PATIENT_PRESCRIPTIONS_FAILED",
    );
  }
}

async function handlePrescriptionGet(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: PulseServerDeps,
  signingSecret: string,
  doctorReadRepo: DoctorReadRepo,
  patientReadRepo: PatientReadRepo,
): Promise<void> {
  const parsedBody = await parseSignedActionBody(req, res, deps, "/api/v2/prescriptions/get");
  if (parsedBody.ok !== true) {
    return sendJson(res, parsedBody.statusCode, { ok: false, code: parsedBody.code }, signingSecret);
  }

  const reqId = parsedBody.reqId;
  try {
    const body = parsedBody.body as PrescriptionGetRequestBody;
    const actor = normalizePrescriptionReadActorInput(body.actor);
    const prescriptionId = normalizeReadPrescriptionId(body.prescription_id);

    const prescription = actor.role === "DOCTOR"
      ? await doctorReadRepo.getPrescriptionDetail({
          actor: { role: "DOCTOR", wpUserId: actor.wpUserId },
          prescriptionId,
        })
      : await patientReadRepo.getPrescriptionDetail({
          actor: { role: "PATIENT", wpUserId: actor.wpUserId },
          prescriptionId,
        });

    deps.logger.info(
      "prescription.get.fetched",
      {
        actor_role: actor.role,
        actor_wp_user_id: actor.wpUserId,
        prescription_id: prescriptionId,
      },
      reqId,
    );

    return sendJson(
      res,
      200,
      {
        ok: true,
        schema_version: CURRENT_SCHEMA_VERSION,
        prescription,
      },
      signingSecret,
    );
  } catch (err: unknown) {
    return sendPrescriptionReadRepoError(
      res,
      deps,
      signingSecret,
      err,
      reqId,
      "prescription.get.failed",
      {
        route: "/api/v2/prescriptions/get",
      },
      "ML_PRESCRIPTION_GET_FAILED",
    );
  }
}

async function handlePrescriptionDownload(
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
        { reason: parsed.logReason, path: `/api/v2/prescriptions/${prescriptionId}/download` },
        getResponseReqId(res),
      );
    }
    return sendJson(res, parsed.statusCode, { ok: false, code: parsed.code }, signingSecret);
  }

  const reqId = getResponseReqId(res);

  let actor: { role: "DOCTOR" | "PATIENT"; wpUserId: number };
  try {
    actor = normalizePrescriptionDownloadActorFromQuery(url);
  } catch (err: unknown) {
    return sendPrescriptionReadRepoError(
      res,
      deps,
      signingSecret,
      err,
      reqId,
      "prescription.download.failed",
      {
        route: `/api/v2/prescriptions/${prescriptionId}/download`,
      },
      "ML_PRESCRIPTION_DOWNLOAD_FAILED",
    );
  }

  const canon = parseCanonicalGet(parsed.token.payloadBytes);
  if (!canon) {
    return sendJson(res, 400, { ok: false, code: "ML_AUTH_BAD_PAYLOAD" }, signingSecret);
  }

  const expectedPath = buildPrescriptionDownloadCanonicalGetPath(prescriptionId, actor);
  if (canon.method !== "GET" || canon.path !== expectedPath) {
    deps.logger.warning(
      "security.mls1.rejected",
      {
        reason: "scope_denied",
        expected_path: expectedPath,
        received_path: canon.path,
      },
      reqId,
    );
    return sendJson(res, 403, { ok: false, code: "ML_AUTH_SCOPE_DENIED" }, signingSecret);
  }

  const now = Date.now();
  const skew = Math.abs(now - canon.tsMs);
  if (skew > deps.skewWindowMs) {
    deps.logger.warning("security.mls1.rejected", { reason: "ts_ms_skew", skew_ms: skew }, reqId);
    return sendJson(res, 401, { ok: false, code: "ML_AUTH_EXPIRED" }, signingSecret);
  }

  const isNew = deps.nonceCache.checkAndStore(canon.nonce, now);
  if (!isNew) {
    deps.logger.warning("security.mls1.rejected", { reason: "replay", nonce: "[REDACTED]" }, reqId);
    return sendJson(res, 409, { ok: false, code: "ML_AUTH_REPLAY" }, signingSecret);
  }

  try {
    const record = await resolvePrescriptionDownloadRecord(prescriptionId);
    if (!record) {
      return sendJson(res, 404, { ok: false, code: "ML_PRESCRIPTION_NOT_FOUND" }, signingSecret);
    }

    if (!canActorDownloadPrescription(record, actor)) {
      return sendJson(res, 403, { ok: false, code: "ML_READ_FORBIDDEN" }, signingSecret);
    }

    const target = normalizeS3ObjectLocation(record.s3PdfKey, resolvePdfBucketForDownload(deps));
    if (!target) {
      return sendJson(res, 409, { ok: false, code: "ML_PDF_NOT_READY" }, signingSecret);
    }

    const presignedUrl = await deps.s3.createPresignedAccessUrl({
      bucket: target.bucket,
      key: target.key,
      expiresInSeconds: 300,
      contentDisposition: buildArtifactContentDisposition("attachment", buildPrescriptionPdfFilename(record.uid)),
      contentType: "application/pdf",
    });

    deps.logger.info(
      "prescription.download.redirected",
      {
        actor_role: actor.role,
        actor_wp_user_id: actor.wpUserId,
        prescription_id: record.id,
        prescription_uid: record.uid,
        ttl_seconds: 300,
      },
      reqId,
    );

    res.statusCode = 302;
    res.setHeader("Location", presignedUrl);
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.end();
    return;
  } catch (err: unknown) {
    return sendPrescriptionReadRepoError(
      res,
      deps,
      signingSecret,
      err,
      reqId,
      "prescription.download.failed",
      {
        route: `/api/v2/prescriptions/${prescriptionId}/download`,
      },
      "ML_PRESCRIPTION_DOWNLOAD_FAILED",
    );
  }
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

    if (artifactInput.kind === ArtifactKind.MESSAGE_ATTACHMENT) {
      if (!artifactInput.prescriptionId) {
        throw new MessagesRepoError("ML_MESSAGE_BAD_REQUEST", 400, "artifact.prescription_id is required");
      }

      await deps.messagesRepo.ensureThreadWritable({
        prescriptionId: artifactInput.prescriptionId,
        actor,
      });
    }

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
    if (err instanceof MessagesRepoError) {
      deps.logger.warning(
        "artifact.upload_init.thread_forbidden",
        {
          code: err.code,
          reason: err.message,
        },
        reqId,
        err,
      );
      return sendJson(
        res,
        err.statusCode,
        { ok: false, code: err.code, message: err.message },
        signingSecret,
      );
    }

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

    if (actor.role === ActorRole.PATIENT && deps.smartReplyService && result.message.body.trim() !== "") {
      try {
        await deps.smartReplyService.enqueueGenerateSmartReplies({
          prescriptionId,
          messageId: result.message.id,
          reqId,
        });
      } catch (enqueueErr: unknown) {
        deps.logger.error(
          "smart_replies.enqueue_failed",
          {
            prescription_id: prescriptionId,
            message_id: result.message.id,
            author_role: actor.role,
          },
          reqId,
          enqueueErr,
        );
      }
    }

    if (actor.role === ActorRole.DOCTOR && result.threadState.unreadCountPatient === 1) {
      await maybeNotifyPatientAboutNewMessage(deps, prescriptionId, reqId);
    }

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

async function handleMessagesPolish(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: PulseServerDeps,
  signingSecret: string,
): Promise<void> {
  const parsedBody = await parseSignedActionBody(req, res, deps, "/api/v2/messages/polish");
  if (parsedBody.ok !== true) {
    return sendJson(res, parsedBody.statusCode, { ok: false, code: parsedBody.code }, signingSecret);
  }

  const reqId = parsedBody.reqId;

  try {
    const payload = parsedBody.body as MessagePolishRequestBody;
    const actor = normalizeDoctorReadActorInput(payload.actor);
    const draft = normalizePolishDraft(payload.draft);
    const constraints = normalizePolishConstraints(payload.constraints);

    if (draft === "") {
      return sendJson(res, 400, { ok: false, code: "ML_MESSAGE_BAD_REQUEST", req_id: reqId }, signingSecret);
    }

    if (!deps.copilotService) {
      return sendJson(
        res,
        200,
        {
          ok: true,
          schema_version: CURRENT_SCHEMA_VERSION,
          rewritten_body: draft,
          changes_summary: ["assistant_unavailable_original_returned"],
          risk_flags: ["ASSISTANT_UNAVAILABLE"],
          actor_role: actor.role,
        },
        signingSecret,
      );
    }

    const result = await deps.copilotService.polishMessage(draft, constraints);

    return sendJson(
      res,
      200,
      {
        ok: true,
        schema_version: CURRENT_SCHEMA_VERSION,
        rewritten_body: result.rewritten_body,
        changes_summary: result.changes_summary,
        risk_flags: result.risk_flags,
        provider: result.provider ?? null,
        model: result.model ?? null,
        actor_role: actor.role,
      },
      signingSecret,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "copilot_polish_failed";
    deps.logger.error("copilot.polish_failed", { reason: message }, reqId, err instanceof Error ? err : undefined);
    return sendJson(res, 500, { ok: false, code: "ML_COPILOT_POLISH_FAILED", req_id: reqId }, signingSecret);
  }
}

async function handlePrescriptionSmartRepliesGet(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: PulseServerDeps,
  signingSecret: string,
  url: URL,
  prescriptionId: string,
): Promise<void> {
  if (!deps.smartReplyService) {
    return sendJson(
      res,
      200,
      {
        ok: true,
        schema_version: CURRENT_SCHEMA_VERSION,
        prescription_id: prescriptionId,
        smart_replies: null,
      },
      signingSecret,
    );
  }

  const parsed = validateSignedRequestHeader(req, deps.secrets);
  if (parsed.ok !== true) {
    if (parsed.logReason) {
      deps.logger.warning(
        "security.mls1.rejected",
        { reason: parsed.logReason, path: `/api/v2/prescriptions/${prescriptionId}/smart-replies` },
        getResponseReqId(res),
      );
    }
    return sendJson(res, parsed.statusCode, { ok: false, code: parsed.code }, signingSecret);
  }

  let actor: { role: ActorRole; wpUserId: number | null };
  try {
    actor = normalizeMessagesActorFromQuery(url);
    if (actor.role !== ActorRole.DOCTOR || actor.wpUserId == null) {
      throw new MessagesRepoError("ML_READ_FORBIDDEN", 403, "doctor_actor_required");
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "smart_replies_bad_request";
    deps.logger.warning(
      "smart_replies.query_rejected",
      { reason: message, prescription_id: prescriptionId },
      getResponseReqId(res),
      err instanceof Error ? err : undefined,
    );
    return sendJson(res, 400, { ok: false, code: "ML_MESSAGE_BAD_REQUEST" }, signingSecret);
  }

  const canon = parseCanonicalGet(parsed.token.payloadBytes);
  if (!canon) {
    return sendJson(res, 400, { ok: false, code: "ML_AUTH_BAD_PAYLOAD" }, signingSecret);
  }

  const expectedPath = buildSmartRepliesCanonicalGetPath(prescriptionId, actor);
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
    const result = await deps.smartReplyService.getLatestReplies(prescriptionId);
    return sendJson(
      res,
      200,
      {
        ok: true,
        schema_version: CURRENT_SCHEMA_VERSION,
        prescription_id: prescriptionId,
        smart_replies: result ? serializeLatestSmartReply(result) : null,
      },
      signingSecret,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "smart_replies_query_failed";
    deps.logger.error(
      "smart_replies.query_failed",
      { reason: message, prescription_id: prescriptionId },
      getResponseReqId(res),
      err instanceof Error ? err : undefined,
    );
    return sendJson(res, 500, { ok: false, code: "ML_SMART_REPLIES_FAILED" }, signingSecret);
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
  let doctorWpUserId: number | null = null;
  let itemsCount = 0;
  let paymentPresent = false;

  try {
    const body = parsedBody.body;
    const doctor = body.doctor && typeof body.doctor === "object" ? (body.doctor as IngestDoctorInput) : null;
    if (!doctor) {
      throw new Error("doctor block is required");
    }

    doctorWpUserId = typeof doctor.wpUserId === "number" && Number.isFinite(doctor.wpUserId)
      ? doctor.wpUserId
      : null;

    const rawItems = Object.prototype.hasOwnProperty.call(body, "items") ? body.items : undefined;
    if (rawItems != null && !Array.isArray(rawItems)) {
      return sendJson(res, 400, { ok: false, code: "ML_INGEST_BAD_REQUEST", message: "items must be an array" }, signingSecret);
    }

    itemsCount = Array.isArray(rawItems) ? rawItems.length : 0;
    const items = Array.isArray(rawItems) && rawItems.length > 0 ? rawItems : undefined;
    const payment = body.payment && typeof body.payment === "object" && !Array.isArray(body.payment)
      ? (body.payment as ApprovePrescriptionRequest["payment"])
      : undefined;
    paymentPresent = payment !== undefined;
    const input: ApprovePrescriptionRequest = {
      schema_version: CURRENT_SCHEMA_VERSION,
      site_id: deps.siteId,
      ts_ms: Date.now(),
      nonce: crypto.randomBytes(12).toString("hex"),
      req_id: reqId,
      doctor,
      items,
      payment,
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
    const failure = classifyPrescriptionActionFailure(err, "approve");
    deps.logger.error(
      "ingest.approve_failed",
      {
        prescription_id: prescriptionId,
        doctor_wp_user_id: doctorWpUserId,
        items_count: itemsCount,
        payment_present: paymentPresent,
        failure_code: failure.code,
        failure_status: failure.statusCode,
        failure_stage: failure.stage,
        prisma_code: failure.prismaCode,
        system_code: failure.systemCode,
        system_errno: failure.systemErrno,
        system_syscall: failure.systemSyscall,
        system_path: failure.systemPath,
        raw_error_name: failure.rawName,
        raw_error_message: failure.rawMessage,
        raw_error_stack: failure.rawStack,
        raw_error_cause: failure.rawCauseMessage,
        repo_details: failure.repoDetails,
      },
      reqId,
      err,
    );
    return sendJson(res, failure.statusCode, { ok: false, code: failure.code, req_id: reqId }, signingSecret);
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
  let paymentPresent = false;
  let reasonPresent = false;
  try {
    const body = parsedBody.body;
    const reason = typeof body.reason === "string" ? body.reason : null;
    reasonPresent = typeof reason === "string" && reason.trim() !== "";
    const payment = body.payment && typeof body.payment === "object" && !Array.isArray(body.payment)
      ? (body.payment as RejectPrescriptionRequest["payment"])
      : undefined;
    paymentPresent = payment !== undefined;
    const input: RejectPrescriptionRequest = {
      schema_version: CURRENT_SCHEMA_VERSION,
      site_id: deps.siteId,
      ts_ms: Date.now(),
      nonce: crypto.randomBytes(12).toString("hex"),
      req_id: reqId,
      reason,
      payment,
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
    const failure = classifyPrescriptionActionFailure(err, "reject");
    deps.logger.error(
      "ingest.reject_failed",
      {
        prescription_id: prescriptionId,
        payment_present: paymentPresent,
        reason_present: reasonPresent,
        failure_code: failure.code,
        failure_status: failure.statusCode,
        failure_stage: failure.stage,
        prisma_code: failure.prismaCode,
        system_code: failure.systemCode,
        system_errno: failure.systemErrno,
        system_syscall: failure.systemSyscall,
        system_path: failure.systemPath,
        raw_error_name: failure.rawName,
        raw_error_message: failure.rawMessage,
        raw_error_stack: failure.rawStack,
        raw_error_cause: failure.rawCauseMessage,
        repo_details: failure.repoDetails,
      },
      reqId,
      err,
    );
    return sendJson(res, failure.statusCode, { ok: false, code: failure.code, req_id: reqId }, signingSecret);
  }
}

async function handleStripeWebhook(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: PulseServerDeps,
): Promise<void> {
  const reqId = getResponseReqId(res);
  if (!deps.stripeGateway.hasWebhookSecret()) {
    deps.logger.warning("stripe.webhook.disabled", { reason: "missing_webhook_secret" }, reqId);
    return sendUnsignedJson(res, 503, { ok: false, code: "ML_STRIPE_WEBHOOK_DISABLED", req_id: reqId });
  }

  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req, MAX_INGEST_BODY_BYTES);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "ML_BODY_READ_FAILED";
    deps.logger.warning("stripe.webhook.bad_body", { reason: message }, reqId, err);
    return sendUnsignedJson(res, 400, { ok: false, code: "ML_BODY_INVALID", req_id: reqId });
  }

  const signatureHeader = (() => {
    const raw = req.headers["stripe-signature"];
    return Array.isArray(raw) ? String(raw[0] ?? "") : String(raw ?? "");
  })();

  if (!deps.stripeGateway.verifyWebhookSignature(rawBody, signatureHeader)) {
    deps.logger.warning("stripe.webhook.rejected", { reason: "bad_signature" }, reqId);
    return sendUnsignedJson(res, 401, { ok: false, code: "ML_STRIPE_BAD_SIG", req_id: reqId });
  }

  let event: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawBody.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid_event");
    }
    event = parsed as Record<string, unknown>;
  } catch (err: unknown) {
    deps.logger.warning("stripe.webhook.bad_json", { reason: err instanceof Error ? err.message : "invalid_json" }, reqId, err);
    return sendUnsignedJson(res, 400, { ok: false, code: "ML_STRIPE_BAD_PAYLOAD", req_id: reqId });
  }

  const eventType = typeof event.type === "string" ? event.type.trim() : "";
  const dataNode = event.data && typeof event.data === "object" && !Array.isArray(event.data)
    ? (event.data as Record<string, unknown>)
    : null;
  const objectNode = dataNode?.object;
  if (!objectNode || typeof objectNode !== "object" || Array.isArray(objectNode)) {
    return sendUnsignedJson(res, 200, { ok: true, ignored: true, req_id: reqId });
  }

  let paymentIntent: StripePaymentIntentRecord;
  try {
    paymentIntent = normalizeWebhookPaymentIntent(objectNode);
  } catch (err: unknown) {
    deps.logger.warning("stripe.webhook.ignored", { reason: err instanceof Error ? err.message : "invalid_payment_intent" }, reqId, err);
    return sendUnsignedJson(res, 200, { ok: true, ignored: true, req_id: reqId });
  }

  const wpPrescriptionId = extractWpPrescriptionId(paymentIntent);
  if (wpPrescriptionId == null || wpPrescriptionId < 1) {
    deps.logger.warning(
      "stripe.webhook.ignored",
      { event_type: eventType, payment_intent_id: paymentIntent.id, reason: "missing_wp_prescription_id" },
      reqId,
    );
    return sendUnsignedJson(res, 200, { ok: true, ignored: true, req_id: reqId });
  }

  const shouldSync = eventType === "payment_intent.amount_capturable_updated"
    || eventType === "payment_intent.succeeded"
    || eventType === "payment_intent.canceled"
    || eventType === "payment_intent.payment_failed";

  if (!shouldSync) {
    return sendUnsignedJson(res, 200, { ok: true, ignored: true, req_id: reqId });
  }

  try {
    await deps.wpPaymentBridge.syncAuthorizedIntent(wpPrescriptionId, {
      paymentIntentId: paymentIntent.id,
      stripeStatus: paymentIntent.status,
      amountCents: paymentIntent.amount,
      currency: paymentIntent.currency,
      eventType,
      reqId,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "wordpress_sync_failed";
    deps.logger.error(
      "stripe.webhook.sync_failed",
      { event_type: eventType, payment_intent_id: paymentIntent.id, wp_prescription_id: wpPrescriptionId, reason: message },
      reqId,
      err,
    );
    return sendUnsignedJson(res, 500, { ok: false, code: "ML_STRIPE_WEBHOOK_SYNC_FAILED", req_id: reqId });
  }

  deps.logger.info(
    "stripe.webhook.synced",
    {
      event_type: eventType,
      payment_intent_id: paymentIntent.id,
      stripe_status: paymentIntent.status,
      wp_prescription_id: wpPrescriptionId,
    },
    reqId,
  );

  return sendUnsignedJson(res, 200, { ok: true, req_id: reqId });
}

function normalizeWebhookPaymentIntent(value: unknown): StripePaymentIntentRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("payment_intent_required");
  }
  const row = value as Record<string, unknown>;
  if (String(row.object ?? "").trim() !== "payment_intent") {
    throw new Error("payment_intent_object_required");
  }
  const metadata: Record<string, string> = {};
  const rawMetadata = row.metadata;
  if (rawMetadata && typeof rawMetadata === "object" && !Array.isArray(rawMetadata)) {
    for (const [key, entry] of Object.entries(rawMetadata as Record<string, unknown>)) {
      if (typeof entry === "string") {
        metadata[key] = entry;
      }
    }
  }
  return {
    id: normalizeRequiredString(row.id, "payment_intent.id"),
    object: "payment_intent",
    status: typeof row.status === "string" ? row.status.trim() : "",
    amount: typeof row.amount === "number" && Number.isFinite(row.amount) ? Math.trunc(row.amount) : null,
    currency: typeof row.currency === "string" ? row.currency.trim().toLowerCase() : null,
    metadata,
    client_secret: null,
    next_action: Object.prototype.hasOwnProperty.call(row, "next_action") ? row.next_action : null,
  };
}

function extractWpPrescriptionId(paymentIntent: StripePaymentIntentRecord): number | null {
  const candidates = [
    paymentIntent.metadata.prescription_id,
    paymentIntent.metadata.wp_prescription_id,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.trim() === "") {
      continue;
    }
    const parsed = Number.parseInt(candidate, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.trunc(parsed);
    }
  }

  return null;
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

function sendPrescriptionReadRepoError(
  res: http.ServerResponse,
  deps: PulseServerDeps,
  signingSecret: string,
  err: unknown,
  reqId: string | undefined,
  event: string,
  context: Record<string, unknown>,
  fallbackCode: string,
): void {
  const effectiveReqId = setResponseReqId(res, reqId);

  if (err instanceof PrescriptionReadRepoError) {
    if (err.statusCode >= 500) {
      deps.logger.error(event, { ...context, code: err.code, reason: err.message }, effectiveReqId, err);
    } else {
      deps.logger.warning(event, { ...context, code: err.code, reason: err.message }, effectiveReqId, err);
    }

    sendJson(res, err.statusCode, { ok: false, code: err.code, req_id: effectiveReqId }, signingSecret);
    return;
  }

  const message = err instanceof Error ? err.message : "read_failed";
  deps.logger.error(event, { ...context, reason: message }, effectiveReqId, err);
  sendJson(res, 500, { ok: false, code: fallbackCode, req_id: effectiveReqId }, signingSecret);
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

function normalizeAccountDeleteActorInput(value: unknown): { role: ActorRole; wpUserId: number } {
  const actor = normalizeActorInput(value);
  if ((actor.role !== ActorRole.DOCTOR && actor.role !== ActorRole.PATIENT) || actor.wpUserId == null) {
    throw new AccountServiceError("ML_ACCOUNT_DELETE_BAD_REQUEST", 400, "account_actor_required");
  }

  return {
    role: actor.role,
    wpUserId: actor.wpUserId,
  };
}

function normalizeDoctorReadActorInput(value: unknown): { role: "DOCTOR"; wpUserId: number } {
  const actor = normalizeActorInput(value);
  if (actor.role !== ActorRole.DOCTOR || actor.wpUserId == null) {
    throw new PrescriptionReadRepoError("ML_READ_FORBIDDEN", 403, "doctor_actor_required");
  }

  return {
    role: "DOCTOR",
    wpUserId: actor.wpUserId,
  };
}

function normalizePatientReadActorInput(value: unknown): { role: "PATIENT"; wpUserId: number } {
  const actor = normalizeActorInput(value);
  if (actor.role !== ActorRole.PATIENT || actor.wpUserId == null) {
    throw new PrescriptionReadRepoError("ML_READ_FORBIDDEN", 403, "patient_actor_required");
  }

  return {
    role: "PATIENT",
    wpUserId: actor.wpUserId,
  };
}

function normalizePrescriptionReadActorInput(value: unknown): { role: "DOCTOR" | "PATIENT"; wpUserId: number } {
  const actor = normalizeActorInput(value);
  if ((actor.role !== ActorRole.DOCTOR && actor.role !== ActorRole.PATIENT) || actor.wpUserId == null) {
    throw new PrescriptionReadRepoError("ML_READ_FORBIDDEN", 403, "read_actor_required");
  }

  return {
    role: actor.role,
    wpUserId: actor.wpUserId,
  };
}

function normalizeLegacyReadListFilters(body: LegacyReadListRequestBody): {
  status: string | null;
  limit: number;
  offset: number;
} {
  const filters = body.filters && typeof body.filters === "object" && !Array.isArray(body.filters)
    ? body.filters
    : undefined;

  return {
    status: normalizeLegacyReadStatus((filters as LegacyReadFiltersRequestBody | undefined)?.status ?? body.status),
    limit: normalizeLegacyReadLimit((filters as LegacyReadFiltersRequestBody | undefined)?.limit ?? body.limit),
    offset: normalizeLegacyReadOffset((filters as LegacyReadFiltersRequestBody | undefined)?.offset ?? body.offset),
  };
}

function normalizeLegacyReadStatus(value: unknown): string | null {
  if (value == null || value === "") {
    return null;
  }

  if (typeof value !== "string") {
    throw new PrescriptionReadRepoError("ML_READ_BAD_REQUEST", 400, "status_invalid");
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "" || normalized === "all") {
    return null;
  }

  if (!["pending", "payment_pending", "approved", "rejected"].includes(normalized)) {
    throw new PrescriptionReadRepoError("ML_READ_BAD_REQUEST", 400, "status_invalid");
  }

  return normalized;
}

function normalizeLegacyReadLimit(value: unknown): number {
  if (value == null || value === "") {
    return 100;
  }

  const parsed = typeof value === "number" ? value : Number(value);
  if (!globalThis.Number.isFinite(parsed) || parsed <= 0) {
    throw new PrescriptionReadRepoError("ML_READ_BAD_REQUEST", 400, "limit_invalid");
  }

  return Math.min(200, Math.trunc(parsed));
}

function normalizeLegacyReadOffset(value: unknown): number {
  if (value == null || value === "") {
    return 0;
  }

  const parsed = typeof value === "number" ? value : Number(value);
  if (!globalThis.Number.isFinite(parsed) || parsed < 0) {
    throw new PrescriptionReadRepoError("ML_READ_BAD_REQUEST", 400, "offset_invalid");
  }

  return Math.trunc(parsed);
}

function normalizeReadPrescriptionId(value: unknown): string {
  if (typeof value !== "string") {
    throw new PrescriptionReadRepoError("ML_READ_BAD_REQUEST", 400, "prescription_id_required");
  }

  const normalized = value.trim();
  if (normalized === "" || normalized.length > 191) {
    throw new PrescriptionReadRepoError("ML_READ_BAD_REQUEST", 400, "prescription_id_invalid");
  }

  return normalized;
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
    mode: threadState.mode,
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

function buildSmartRepliesCanonicalGetPath(
  prescriptionId: string,
  actor: { role: ActorRole; wpUserId: number | null },
): string {
  const search = new URLSearchParams();
  search.set("actor_role", actor.role);
  if (actor.wpUserId != null) {
    search.set("actor_wp_user_id", String(actor.wpUserId));
  }
  return `/api/v2/prescriptions/${encodeURIComponent(prescriptionId)}/smart-replies?${search.toString()}`;
}

function buildPrescriptionDownloadCanonicalGetPath(
  prescriptionId: string,
  actor: { role: "DOCTOR" | "PATIENT"; wpUserId: number },
): string {
  const search = new URLSearchParams();
  search.set("actor_role", actor.role);
  search.set("actor_wp_user_id", String(actor.wpUserId));
  return `/api/v2/prescriptions/${encodeURIComponent(prescriptionId)}/download?${search.toString()}`;
}

type PrescriptionDownloadRecord = {
  id: string;
  uid: string;
  status: string;
  s3PdfKey: string | null;
  doctor: { wpUserId: number | null } | null;
  patient: { wpUserId: number | null };
};

async function resolvePrescriptionDownloadRecord(prescriptionId: string): Promise<PrescriptionDownloadRecord | null> {
  const normalizedPrescriptionId = normalizeReadPrescriptionId(prescriptionId);
  const prisma = getPulsePrismaClient();
  return prisma.prescription.findFirst({
    where: {
      OR: [
        { id: normalizedPrescriptionId },
        { uid: normalizedPrescriptionId },
      ],
    },
    select: {
      id: true,
      uid: true,
      status: true,
      s3PdfKey: true,
      doctor: {
        select: {
          wpUserId: true,
        },
      },
      patient: {
        select: {
          wpUserId: true,
        },
      },
    },
  });
}

function canActorDownloadPrescription(
  record: PrescriptionDownloadRecord,
  actor: { role: "DOCTOR" | "PATIENT"; wpUserId: number },
): boolean {
  if (actor.role === "DOCTOR") {
    if (record.doctor == null) {
      return true;
    }
    return record.doctor.wpUserId === actor.wpUserId;
  }

  return record.patient.wpUserId === actor.wpUserId;
}

function resolvePdfBucketForDownload(deps: PulseServerDeps): string {
  return normalizeOptionalString(process.env.S3_BUCKET_PDF)
    ?? normalizeOptionalString(process.env.S3_BUCKET_ARTIFACTS)
    ?? deps.artifactsBucket;
}

function normalizeS3ObjectLocation(
  rawValue: string | null,
  fallbackBucket: string,
): { bucket: string; key: string } | null {
  const value = normalizeOptionalString(rawValue);
  if (!value) {
    return null;
  }

  if (value.startsWith("s3://")) {
    const withoutScheme = value.slice("s3://".length);
    const slashIndex = withoutScheme.indexOf("/");
    if (slashIndex <= 0) {
      return null;
    }

    const bucket = withoutScheme.slice(0, slashIndex).trim();
    const key = withoutScheme.slice(slashIndex + 1).replace(/^\/+/, "").trim();
    if (bucket === "" || key === "") {
      return null;
    }

    return { bucket, key };
  }

  const bucket = normalizeOptionalString(fallbackBucket);
  const key = value.replace(/^\/+/, "");
  if (!bucket || key === "") {
    return null;
  }

  return { bucket, key };
}

function buildPrescriptionPdfFilename(uid: string): string {
  const normalizedUid = sanitizeDispositionFilename(uid).replace(/\.pdf$/i, "").trim();
  return normalizedUid !== "" ? `ordonnance-${normalizedUid}.pdf` : "ordonnance.pdf";
}

function serializeLatestSmartReply(record: LatestSmartReplyRecord): Record<string, unknown> {
  return {
    prescription_id: record.prescriptionId,
    message_id: record.messageId,
    replies: record.replies.map((reply) => ({
      type: reply.type,
      title: reply.title,
      body: reply.body,
    })),
    risk_flags: record.riskFlags,
    provider: record.provider,
    model: record.model,
    created_at: record.createdAt.toISOString(),
    updated_at: record.updatedAt.toISOString(),
  };
}

function normalizeMessagesActorFromQuery(url: URL): { role: ActorRole; wpUserId: number | null } {
  return normalizeMessagesActorInput({
    role: url.searchParams.get("actor_role"),
    wp_user_id: url.searchParams.get("actor_wp_user_id"),
  });
}

function normalizePrescriptionDownloadActorFromQuery(url: URL): { role: "DOCTOR" | "PATIENT"; wpUserId: number } {
  return normalizePrescriptionReadActorInput({
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

function normalizePolishDraft(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function normalizePolishConstraints(value: unknown): PolishMessageConstraints {
  const row = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

  const audienceRaw = normalizeOptionalString(row.audience);
  const toneRaw = normalizeOptionalString(row.tone);
  const languageRaw = normalizeOptionalString(row.language);
  const maxCharactersRaw = row.max_characters ?? row.maxCharacters;
  const preserveDecisionRaw = row.preserve_decision ?? row.preserveDecision;
  const forceClarificationRaw = row.force_clarification_if_ambiguous ?? row.forceClarificationIfAmbiguous;

  const constraints: PolishMessageConstraints = {};

  if (audienceRaw === "patient" || audienceRaw === "doctor" || audienceRaw === "internal") {
    constraints.audience = audienceRaw;
  }

  if (
    toneRaw === "professional"
    || toneRaw === "warm"
    || toneRaw === "direct"
    || toneRaw === "reassuring"
  ) {
    constraints.tone = toneRaw;
  }

  if (languageRaw) {
    constraints.language = languageRaw;
  }

  const maxCharacters = normalizeOptionalPositiveInt(maxCharactersRaw);
  if (maxCharacters != null) {
    constraints.maxCharacters = maxCharacters;
  }

  const preserveDecision = normalizeOptionalBoolean(preserveDecisionRaw);
  if (preserveDecision != null) {
    constraints.preserveDecision = preserveDecision;
  }

  const forceClarificationIfAmbiguous = normalizeOptionalBoolean(forceClarificationRaw);
  if (forceClarificationIfAmbiguous != null) {
    constraints.forceClarificationIfAmbiguous = forceClarificationIfAmbiguous;
  }

  return constraints;
}

function normalizeOptionalPositiveInt(value: unknown): number | null {
  if (value == null || value === "") {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.trunc(parsed);
}

function normalizeOptionalBoolean(value: unknown): boolean | null {
  if (value == null || value === "") {
    return null;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "n", "off"].includes(normalized)) {
      return false;
    }
  }
  return null;
}

function hasSubmissionSignedEnvelope(body: SubmissionCreateRequestBody): boolean {
  return hasSignedEnvelopeFields(body as unknown as Record<string, unknown>);
}

type SubmissionArtifactInitRow = {
  id: string;
  publicRef: string;
  ownerRole: ActorRole;
  ownerWpUserId: number | null;
  status: SubmissionStatus;
  expiresAt: Date;
};

function getPulsePrismaClient(): PrismaClient {
  if (!pulsePrismaSingleton) {
    pulsePrismaSingleton = new PrismaClient();
  }

  return pulsePrismaSingleton;
}

function getPulseMailService(logger?: NdjsonLogger): MailService {
  if (!pulseMailServiceSingleton) {
    pulseMailServiceSingleton = new MailService({ logger });
  }

  return pulseMailServiceSingleton;
}

async function maybeNotifyPatientAboutNewMessage(
  deps: PulseServerDeps,
  prescriptionId: string,
  reqId?: string,
): Promise<void> {
  const prisma = getPulsePrismaClient();
  const prescription = await prisma.prescription.findUnique({
    where: { id: prescriptionId },
    select: {
      id: true,
      uid: true,
      patient: {
        select: {
          email: true,
          deletedAt: true,
        },
      },
    },
  });

  if (!prescription || !prescription.patient || prescription.patient.deletedAt !== null) {
    return;
  }

  const email = normalizeOptionalString(prescription.patient.email);
  if (!email) {
    return;
  }

  await getPulseMailService(deps.logger).sendNewMessageNotification(
    {
      email,
      prescriptionUid: prescription.uid,
    },
    reqId,
  );
}

async function resolveSubmissionForArtifactInit(
  submissionRef: string,
  actor: { role: ActorRole; wpUserId: number | null },
  logger?: NdjsonLogger,
  reqId?: string,
): Promise<SubmissionArtifactInitRow> {
  const normalizedSubmissionRef = normalizeSubmissionRefParam(submissionRef);
  const prisma = getPulsePrismaClient();
  const row = await prisma.submission.findUnique({
    where: { publicRef: normalizedSubmissionRef },
    select: {
      id: true,
      publicRef: true,
      ownerRole: true,
      ownerWpUserId: true,
      status: true,
      expiresAt: true,
    },
  });

  if (row == null || row.ownerRole == null) {
    logger?.warning(
      "submission.artifact_init.missing",
      {
        phase: "artifact_init",
        submission_ref: normalizedSubmissionRef,
        actor_role: actor.role,
        actor_wp_user_id: actor.wpUserId,
      },
      reqId,
    );

    throw new SubmissionRepoError("ML_SUBMISSION_NOT_FOUND", 404, "Submission not found");
  }

  if (actor.role !== ActorRole.SYSTEM) {
    if (actor.wpUserId == null || row.ownerRole !== actor.role || row.ownerWpUserId !== actor.wpUserId) {
      throw new SubmissionRepoError("ML_SUBMISSION_NOT_FOUND", 404, "Submission not found");
    }
  }

  if (row.status === SubmissionStatus.EXPIRED || row.expiresAt.getTime() <= Date.now()) {
    if (row.status === SubmissionStatus.OPEN || row.status === "DRAFT") {
      await prisma.submission.updateMany({
        where: {
          id: row.id,
          status: row.status,
        },
        data: {
          status: SubmissionStatus.EXPIRED,
        },
      });
    }

    logger?.warning(
      "submission.expired",
      {
        phase: "artifact_init",
        submission_ref: normalizedSubmissionRef,
        submission_id: row.id,
        owner_role: row.ownerRole,
        owner_wp_user_id: row.ownerWpUserId,
      },
      reqId,
    );

    throw new SubmissionRepoError("ML_SUBMISSION_EXPIRED", 410, "Submission has expired");
  }

  if (row.status !== SubmissionStatus.OPEN && row.status !== "DRAFT") {
    throw new SubmissionRepoError("ML_SUBMISSION_NOT_OPEN", 409, "Submission cannot accept new artifacts");
  }

  return row;
}

function normalizeSubmissionRefParam(value: unknown): string {
  if (typeof value !== "string") {
    throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, "submission_ref is invalid");
  }

  const normalized = value.trim();
  if (normalized === "" || normalized.length > 128 || !/^[A-Za-z0-9_-]{8,128}$/.test(normalized)) {
    throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, "submission_ref is invalid");
  }

  return normalized;
}

function normalizeSubmissionActorInput(value: unknown): { role: ActorRole; wpUserId: number | null } {
  const actor = normalizeActorInput(value);
  if (actor.role !== "SYSTEM" && actor.wpUserId == null) {
    throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, "actor.wp_user_id is required");
  }
  return actor;
}

function normalizeSubmissionFlow(value: unknown): string {
  return normalizeSubmissionSlug(value, "flow", 64);
}

function normalizeSubmissionPriority(value: unknown): string {
  return normalizeSubmissionSlug(value, "priority", 32);
}

function normalizeSubmissionIdempotencyKey(value: unknown): string | null {
  if (value == null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, "idempotency_key is invalid");
  }

  const normalized = value.trim();
  if (normalized === "" || normalized.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, "idempotency_key is invalid");
  }

  return normalized;
}

function hasPatientProfileSignedEnvelope(body: PatientProfileRequestBody): boolean {
  return hasSignedEnvelopeFields(body as unknown as Record<string, unknown>);
}

function hasSignedEnvelopeFields(body: Record<string, unknown>): boolean {
  return body.ts_ms !== undefined || body.site_id !== undefined || body.nonce !== undefined;
}

function normalizePatientProfileActorInput(value: unknown): { role: "PATIENT"; wpUserId: number } {
  const actor = normalizeActorInput(value);
  if (actor.role !== "PATIENT" || actor.wpUserId == null) {
    throw new PatientRepoError("ML_PATIENT_PROFILE_BAD_REQUEST", 400, "actor is invalid");
  }

  return {
    role: "PATIENT",
    wpUserId: actor.wpUserId,
  };
}

function normalizePatientProfileActorFromQuery(url: URL): { role: "PATIENT"; wpUserId: number } {
  return normalizePatientProfileActorInput({
    role: url.searchParams.get("role"),
    wp_user_id: url.searchParams.get("wp_user_id"),
  });
}

function normalizeMagicLinkRequestEmail(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("email is required");
  }

  const normalized = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error("email is invalid");
  }

  return normalized;
}

function normalizeMagicLinkToken(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("token is required");
  }

  const normalized = value.trim();
  if (normalized.length < 32 || normalized.length > 256) {
    throw new Error("token is invalid");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(normalized)) {
    throw new Error("token is invalid");
  }

  return normalized;
}

function normalizeOptionalRedirectTo(value: unknown): string {
  if (value == null || value === "") {
    return "";
  }

  if (typeof value !== "string") {
    throw new Error("redirect_to is invalid");
  }

  const normalized = value.trim();
  if (normalized === "" || normalized.length > 1024) {
    throw new Error("redirect_to is invalid");
  }

  return normalized;
}

function normalizeOptionalMagicLinkVerifyUrl(value: unknown): string {
  if (value == null || value === "") {
    return "";
  }

  if (typeof value !== "string") {
    throw new Error("verify_url is invalid");
  }

  const normalized = value.trim();
  if (normalized === "" || normalized.length > 1024) {
    throw new Error("verify_url is invalid");
  }

  const url = new URL(normalized);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("verify_url is invalid");
  }

  return url.toString();
}

function appendResumeDraftToRedirect(redirectTo: string, draftRef: string): string {
  if (!redirectTo) {
    return "";
  }

  const url = new URL(redirectTo);
  url.searchParams.set("resume_draft", draftRef);
  return url.toString();
}

function toPublicMagicLinkRole(role: ActorRole): "doctor" | "patient" {
  return role === ActorRole.DOCTOR ? "doctor" : "patient";
}

function normalizeDoctorVerifyRppsInput(body: DoctorVerifyRppsRequestBody): string {
  const raw = normalizeRequiredString(body.rpps, "rpps").replace(/\D+/g, "");
  if (raw.length !== 11) {
    throw new AnnuaireSanteServiceError("ML_RPPS_BAD_REQUEST", 400, "rpps must contain exactly 11 digits");
  }
  return raw;
}

function buildPatientProfileCanonicalGetPath(actor: { role: "PATIENT"; wpUserId: number }): string {
  const search = new URLSearchParams();
  search.set("role", actor.role);
  search.set("wp_user_id", String(actor.wpUserId));
  return `/api/v2/patient/profile?${search.toString()}`;
}

function normalizePatientProfileRequestInput(body: PatientProfileRequestBody): {
  actor: { role: "PATIENT"; wpUserId: number };
  firstName: unknown;
  lastName: unknown;
  birthDate: unknown;
  gender: unknown;
  email: unknown;
  phone: unknown;
  weightKg: unknown;
  heightCm: unknown;
  note: unknown;
} {
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
    note: pickFirstDefined(body.note, body.medical_notes, body.medicalNotes),
  };
}

function normalizeSubmissionFinalizeRequestInput(body: Record<string, unknown>): {
  actor: { role: ActorRole; wpUserId: number | null };
  patient: Record<string, unknown>;
  items: unknown[];
  privateNotes: string | null;
  idempotencyKey: string | null;
} {
  const patientBlock = pickRecord(body.patient)
    ?? pickRecord(body.patient_profile)
    ?? pickRecord(body.profile)
    ?? body;
  const prescriptionBlock = pickRecord(body.prescription) ?? body;
  const itemsValue = prescriptionBlock.items ?? body.items;
  if (!Array.isArray(itemsValue)) {
    throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, "items must be an array");
  }

  const privateNotesRaw = pickFirstDefined(
    prescriptionBlock.private_notes,
    prescriptionBlock.privateNotes,
    body.private_notes,
    body.privateNotes,
    patientBlock.note,
    patientBlock.medical_notes,
    patientBlock.medicalNotes,
    body.note,
    body.medical_notes,
    body.medicalNotes,
  );

  const actor = normalizeSubmissionActorInput(body.actor);
  const patientNote = pickFirstDefined(
    patientBlock.note,
    patientBlock.medical_notes,
    patientBlock.medicalNotes,
    body.note,
    body.medical_notes,
    body.medicalNotes,
    privateNotesRaw,
  );
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
    note: patientNote,
    medical_notes: patientNote,
    medicalNotes: patientNote,
  } satisfies Record<string, unknown>;

  return {
    actor,
    patient,
    items: itemsValue,
    privateNotes: typeof privateNotesRaw === "string" && privateNotesRaw.trim() !== "" ? privateNotesRaw.trim() : null,
    idempotencyKey: normalizeSubmissionIdempotencyKey(pickFirstDefined(body.idempotency_key, body.idempotencyKey)),
  };
}

function normalizeSubmissionFinalizeResult(value: unknown): {
  prescriptionId: string;
  uid: string;
  status: string;
  processingStatus: string;
} {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid finalize result");
  }

  const row = value as Record<string, unknown>;
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

function buildPatientProfileApiPayload(
  wpUserId: number,
  profile: PatientProfileRecord | null,
  message: string,
): Record<string, unknown> {
  const profilePayload = buildPatientProfilePayload(profile);
  return {
    ok: true,
    schema_version: CURRENT_SCHEMA_VERSION,
    message,
    fullname: profilePayload.fullname,
    firstName: profilePayload.firstName,
    lastName: profilePayload.lastName,
    first_name: profilePayload.first_name,
    last_name: profilePayload.last_name,
    birthDate: profilePayload.birthDate,
    birthdate: profilePayload.birthdate,
    birthdate_iso: profilePayload.birthdate_iso,
    birthdate_fr: profilePayload.birthdate_fr,
    phone: profilePayload.phone,
    email: profilePayload.email,
    weight_kg: profilePayload.weight_kg,
    weightKg: profilePayload.weightKg,
    height_cm: profilePayload.height_cm,
    heightCm: profilePayload.heightCm,
    note: profilePayload.note,
    medical_notes: profilePayload.medical_notes,
    medicalNotes: profilePayload.medicalNotes,
    bmi_value: profilePayload.bmi_value,
    bmiValue: profilePayload.bmiValue,
    bmi_label: profilePayload.bmi_label,
    bmiLabel: profilePayload.bmiLabel,
    profile: profilePayload,
    currentUser: {
      id: wpUserId,
      displayName: profilePayload.fullname,
      email: profilePayload.email,
      roles: ["patient"],
      firstName: profilePayload.firstName,
      lastName: profilePayload.lastName,
      first_name: profilePayload.first_name,
      last_name: profilePayload.last_name,
      birthDate: profilePayload.birthDate,
      birthdate: profilePayload.birthdate,
      sosp_birthdate: profilePayload.birthdate_iso,
      phone: profilePayload.phone,
    },
    patientProfile: {
      first_name: profilePayload.first_name,
      last_name: profilePayload.last_name,
      firstName: profilePayload.firstName,
      lastName: profilePayload.lastName,
      full_name: profilePayload.full_name,
      fullname: profilePayload.fullname,
      birthDate: profilePayload.birthDate,
      birthdate: profilePayload.birthdate,
      birthdate_iso: profilePayload.birthdate_iso,
      birthdate_fr: profilePayload.birthdate_fr,
      phone: profilePayload.phone,
      email: profilePayload.email,
      weight_kg: profilePayload.weight_kg,
      weightKg: profilePayload.weightKg,
      height_cm: profilePayload.height_cm,
      heightCm: profilePayload.heightCm,
      note: profilePayload.note,
      medical_notes: profilePayload.medical_notes,
      medicalNotes: profilePayload.medicalNotes,
      bmi_value: profilePayload.bmi_value,
      bmiValue: profilePayload.bmiValue,
      bmi_label: profilePayload.bmi_label,
      bmiLabel: profilePayload.bmiLabel,
    },
  };
}

function buildPatientProfilePayload(profile: PatientProfileRecord | null): {
  first_name: string;
  last_name: string;
  firstName: string;
  lastName: string;
  full_name: string;
  fullname: string;
  birthDate: string;
  birthdate: string;
  birthdate_iso: string;
  birthdate_fr: string;
  phone: string;
  email: string;
  weight_kg: string;
  weightKg: string;
  height_cm: string;
  heightCm: string;
  note: string;
  medical_notes: string;
  medicalNotes: string;
  bmi_value: string;
  bmiValue: string;
  bmi_label: string;
  bmiLabel: string;
} {
  const firstName = profile?.firstName ?? "";
  const lastName = profile?.lastName ?? "";
  const fullName = [firstName, lastName].filter((part) => part.trim() !== "").join(" ").trim();
  const birthdateIso = profile?.birthDate ?? "";
  const birthdateFr = birthdateIso !== "" ? formatIsoDateToFr(birthdateIso) : "";
  const phone = profile?.phone ?? "";
  const email = profile?.email ?? "";
  const weightKg = profile?.weightKg ?? "";
  const heightCm = profile?.heightCm ?? "";
  const note = profile?.note ?? "";
  const bmiValue = computeProfileBmiValue(weightKg, heightCm);
  const bmiValueText = bmiValue !== null ? String(bmiValue) : "";
  const bmiLabel = computeProfileBmiLabel(weightKg, heightCm);
  const bmiLabelText = bmiLabel !== "—" ? bmiLabel : "";

  return {
    first_name: firstName,
    last_name: lastName,
    firstName,
    lastName,
    full_name: fullName,
    fullname: fullName,
    birthDate: birthdateIso,
    birthdate: birthdateIso,
    birthdate_iso: birthdateIso,
    birthdate_fr: birthdateFr,
    phone,
    email,
    weight_kg: weightKg,
    weightKg: weightKg,
    height_cm: heightCm,
    heightCm: heightCm,
    note,
    medical_notes: note,
    medicalNotes: note,
    bmi_value: bmiValueText,
    bmiValue: bmiValueText,
    bmi_label: bmiLabelText,
    bmiLabel: bmiLabelText,
  };
}

function computeProfileBmiValue(weightKg: unknown, heightCm: unknown): number | null {
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

function computeProfileBmiLabel(weightKg: unknown, heightCm: unknown): string {
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

function formatIsoDateToFr(value: string): string {
  const match = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return String(value ?? "").trim();
  }

  return `${match[3]}/${match[2]}/${match[1]}`;
}

function pickFirstDefined<T>(...values: T[]): T | undefined {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function pickRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readStringField(row: Record<string, unknown> | null, keys: string[]): string | null {
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

function normalizeSubmissionSlug(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, `${field} is required`);
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "" || normalized.length > maxLength || !/^[a-z0-9][a-z0-9_-]*$/.test(normalized)) {
    throw new SubmissionRepoError("ML_SUBMISSION_BAD_REQUEST", 400, `${field} is invalid`);
  }

  return normalized;
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
    case "ML_READ_BAD_REQUEST":
      return "La requête de lecture sécurisée est invalide.";
    case "ML_READ_FORBIDDEN":
      return "Accès refusé.";
    case "ML_PRESCRIPTION_NOT_FOUND":
      return "Ordonnance introuvable.";
    case "ML_DOCTOR_INBOX_FAILED":
      return "La lecture sécurisée des dossiers médecin est temporairement indisponible.";
    case "ML_PATIENT_PRESCRIPTIONS_FAILED":
      return "La lecture sécurisée des dossiers patient est temporairement indisponible.";
    case "ML_PRESCRIPTION_GET_FAILED":
      return "La lecture sécurisée du dossier est temporairement indisponible.";
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
    case "ML_PDF_GENERATION_FAILED":
      return "La génération du document a échoué. Réessayez ultérieurement.";
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

  if (err instanceof MailServiceError) {
    deps.logger.error(event, { ...context, reason: err.message, code: err.code }, effectiveReqId, err);
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
    submission_id: artifact.submissionId,
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

function fingerprintPublicId(value: string): string {
  const normalized = String(value || "").trim();
  if (normalized === "") {
    return "";
  }

  return Buffer.from(normalized, "utf8").toString("base64url").slice(0, 12);
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
  const token = buildResponseSignature(data, signingSecret);

  res.statusCode = status;
  applyApiResponseHeaders(res, extraHeaders);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", data.length);
  res.setHeader("X-MedLab-Signature", token);
  res.end(data);
}

function sendUnsignedJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  const normalizedBody = normalizeErrorResponseBody(res, status, body);
  const data = Buffer.from(JSON.stringify(normalizedBody));

  res.statusCode = status;
  applyApiResponseHeaders(res, extraHeaders);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", data.length);
  res.end(data);
}

function buildResponseSignature(payloadBytes: Buffer, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(payloadBytes).digest("hex")}`;
}

interface PrescriptionActionFailureDetails {
  code: string;
  statusCode: number;
  stage: "validation" | "approval" | "rejection" | "pdf_generation" | "payment" | "database" | "unknown";
  rawName: string;
  rawMessage: string;
  rawStack: string | null;
  rawCauseMessage: string | null;
  prismaCode: string | null;
  systemCode: string | null;
  systemErrno: number | string | null;
  systemSyscall: string | null;
  systemPath: string | null;
  repoDetails: Record<string, unknown> | null;
}

function classifyPrescriptionActionFailure(
  err: unknown,
  action: "approve" | "reject",
): PrescriptionActionFailureDetails {
  const snapshot = buildPrescriptionActionFailureSnapshot(err);
  const fallbackCode = action === "approve" ? "ML_APPROVE_FAILED" : "ML_REJECT_FAILED";
  const actionStage = action === "approve" ? "approval" : "rejection";

  if (err instanceof JobsRepoActionError) {
    return {
      ...snapshot,
      code: err.code,
      statusCode: err.statusCode,
      stage: err.stage,
      repoDetails: err.details && typeof err.details === "object" ? err.details : null,
    };
  }

  if (isPdfGenerationFailureMessage(snapshot.rawMessage)) {
    return {
      ...snapshot,
      code: "ML_PDF_GENERATION_FAILED",
      statusCode: 500,
      stage: "pdf_generation",
    };
  }

  if (isClientIngestError(snapshot.rawMessage)) {
    return {
      ...snapshot,
      code: "ML_INGEST_BAD_REQUEST",
      statusCode: 400,
      stage: "validation",
    };
  }

  return {
    ...snapshot,
    code: fallbackCode,
    statusCode: 500,
    stage: snapshot.prismaCode ? "database" : actionStage,
  };
}

function buildPrescriptionActionFailureSnapshot(err: unknown): PrescriptionActionFailureDetails {
  return {
    code: "ML_APPROVE_FAILED",
    statusCode: 500,
    stage: "unknown",
    rawName: extractActionErrorName(err),
    rawMessage: extractActionErrorMessage(err),
    rawStack: extractActionErrorStack(err),
    rawCauseMessage: extractActionCauseMessage(err),
    prismaCode: extractActionPrismaCode(err),
    systemCode: extractActionSystemCode(err),
    systemErrno: extractActionSystemErrno(err),
    systemSyscall: extractActionSystemStringField(err, "syscall"),
    systemPath: extractActionSystemStringField(err, "path"),
    repoDetails: null,
  };
}

function isPdfGenerationFailureMessage(message: string): boolean {
  const haystack = String(message || "").toLowerCase();
  return [
    "ml_pdf_",
    "pdf generation",
    "pdf render",
    "pdf.render",
    "puppeteer",
    "invalid pdf",
    "failed to read pdf",
  ].some((needle) => haystack.includes(needle));
}

function extractActionErrorName(err: unknown): string {
  if (err instanceof Error && typeof err.name === "string" && err.name.trim() !== "") {
    return err.name.trim();
  }
  return typeof err === "object" && err !== null ? "Object" : typeof err;
}

function extractActionErrorMessage(err: unknown): string {
  if (err instanceof Error && typeof err.message === "string") {
    return err.message.trim();
  }
  return typeof err === "string" ? err.trim() : "";
}

function extractActionErrorStack(err: unknown): string | null {
  return err instanceof Error && typeof err.stack === "string" && err.stack.trim() !== ""
    ? err.stack
    : null;
}

function extractActionCauseMessage(err: unknown): string | null {
  if (!(err instanceof Error)) {
    return null;
  }

  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause instanceof Error && typeof cause.message === "string" && cause.message.trim() !== "") {
    return cause.message.trim();
  }

  return typeof cause === "string" && cause.trim() !== "" ? cause.trim() : null;
}

function extractActionPrismaCode(err: unknown): string | null {
  for (const candidate of iterateActionErrorCandidates(err)) {
    const code = candidate.code;
    if (typeof code === "string" && /^P\d{4}$/u.test(code.trim())) {
      return code.trim();
    }
  }

  return null;
}

function extractActionSystemCode(err: unknown): string | null {
  for (const candidate of iterateActionErrorCandidates(err)) {
    const code = candidate.code;
    if (typeof code !== "string" || code.trim() === "") {
      continue;
    }
    if (/^P\d{4}$/u.test(code.trim())) {
      continue;
    }
    return code.trim();
  }

  return null;
}

function extractActionSystemErrno(err: unknown): number | string | null {
  for (const candidate of iterateActionErrorCandidates(err)) {
    const errno = candidate.errno;
    if (typeof errno === "number" || typeof errno === "string") {
      return errno;
    }
  }

  return null;
}

function extractActionSystemStringField(err: unknown, field: "syscall" | "path"): string | null {
  for (const candidate of iterateActionErrorCandidates(err)) {
    const value = candidate[field];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }

  return null;
}

function* iterateActionErrorCandidates(err: unknown): Generator<Record<string, unknown>> {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    yield current as Record<string, unknown>;
    if (current instanceof Error) {
      current = (current as Error & { cause?: unknown }).cause;
      continue;
    }
    break;
  }
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
