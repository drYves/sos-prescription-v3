// src/jobs/processor.ts
import fs from "node:fs/promises";
import type { JobsRepo, JobRow } from "./jobsRepo";
import { NdjsonLogger } from "../logger";
import { PdfRenderer } from "../pdf/pdfRenderer";
import { parseMls1Token, verifyMls1Payload } from "../security/mls1";
import { S3Service } from "../s3/s3Service";
import { HardError, SoftError } from "./errors";
import { PrismaPrescriptionStore } from "../prescriptions/prismaPrescriptionStore";
import { PrescriptionHtmlBuilder } from "../pdf/prescriptionHtmlBuilder";

export interface JobProcessorDeps {
  siteId: string;
  wpBaseUrl: string;
  renderPathTemplate: string;
  chromeExecutablePath: string;
  jobsRepo: JobsRepo;
  s3: S3Service;
  s3BucketPdf: string;
  s3Region: string;
  hmacSecrets: string[];
  hmacSecretActive: string;
  workerId: string;
  pdfRenderer: PdfRenderer;
  logger: NdjsonLogger;
  memGuard: any;
  admissionMaxMb: number;
  pdfRenderTimeoutMs: number;
  pdfReadyTimeoutMs: number;
  prescriptionStore?: PrismaPrescriptionStore | null;
  htmlBuilder?: PrescriptionHtmlBuilder | null;
}

export async function processJob(job: JobRow, deps: JobProcessorDeps): Promise<void> {
  const reqId = resolveReqId(job);

  deps.logger.info(
    "job.claimed",
    {
      job_id: job.job_id,
      job_type: job.job_type,
      queue_mode: deps.jobsRepo.mode,
      attempts: job.attempts,
      max_attempts: job.max_attempts,
    },
    reqId,
  );

  if (job.job_type !== "PDF_GEN") {
    throw new HardError("ML_JOB_TYPE_UNSUPPORTED", "Unsupported job type");
  }

  if (deps.jobsRepo.mode === "rest") {
    await processRestBridgeJob(job, deps, reqId);
    return;
  }

  await processLocalDbJob(job, deps, reqId);
}

async function processRestBridgeJob(job: JobRow, deps: JobProcessorDeps, reqId?: string): Promise<void> {
  assertRestJobSignature(job, deps);

  const render = await deps.pdfRenderer.renderToTmpPdf({
    mode: "remote-wordpress",
    siteId: deps.siteId,
    wpBaseUrl: deps.wpBaseUrl,
    renderPathTemplate: deps.renderPathTemplate,
    hmacSecret: deps.hmacSecretActive,
    workerId: deps.workerId,
    jobId: job.job_id,
    rxId: job.rx_id,
    reqId,
    chromeExecutablePath: deps.chromeExecutablePath,
    renderTimeoutMs: deps.pdfRenderTimeoutMs,
    readyTimeoutMs: deps.pdfReadyTimeoutMs,
    memGuard: deps.memGuard,
    admissionMaxMb: deps.admissionMaxMb,
  });

  await finalizeSuccessfulRender(job, deps, render, reqId, "remote-wordpress", undefined);
}

async function processLocalDbJob(job: JobRow, deps: JobProcessorDeps, reqId?: string): Promise<void> {
  if (!deps.prescriptionStore) {
    throw new HardError("ML_PRESCRIPTION_STORE_MISSING", "Prescription store is not configured");
  }
  if (!deps.htmlBuilder) {
    throw new HardError("ML_HTML_BUILDER_MISSING", "Prescription HTML builder is not configured");
  }

  const aggregate = await deps.prescriptionStore.getRenderablePrescription(job.job_id);
  const built = await deps.htmlBuilder.buildHtml({
    aggregate,
    jobId: job.job_id,
    reqId,
    templateVariant: process.env.ML_PDF_TEMPLATE_DEFAULT ?? "modern",
  });

  const render = await deps.pdfRenderer.renderToTmpPdf({
    mode: "inline-html",
    workerId: deps.workerId,
    jobId: job.job_id,
    reqId,
    chromeExecutablePath: deps.chromeExecutablePath,
    renderTimeoutMs: deps.pdfRenderTimeoutMs,
    readyTimeoutMs: deps.pdfReadyTimeoutMs,
    memGuard: deps.memGuard,
    admissionMaxMb: deps.admissionMaxMb,
    html: built.html,
    templateName: built.templateName,
  });

  await finalizeSuccessfulRender(job, deps, render, reqId, "inline-html", built.templateName);
}

async function finalizeSuccessfulRender(
  job: JobRow,
  deps: JobProcessorDeps,
  render: { filePath: string; sha256Hex: string; sizeBytes: number; contentType: "application/pdf" },
  reqId: string | undefined,
  renderMode: "remote-wordpress" | "inline-html",
  templateName?: string,
): Promise<void> {
  const s3Key = buildPdfS3Key(deps.siteId, job.job_id, new Date());

  try {
    await deps.s3.uploadPdfFromFile({
      bucket: deps.s3BucketPdf,
      key: s3Key,
      filePath: render.filePath,
      contentType: render.contentType,
      contentLength: render.sizeBytes,
      metadata: {
        schema_version: deps.jobsRepo.mode === "postgres" ? "2026.6" : "2026.5",
        job_id: job.job_id,
        req_id: reqId ?? "",
      },
    });
  } catch (err) {
    const details = extractErrorDetails(err);
    throw withErrorDetails(
      new SoftError("ML_S3_UPLOAD_FAILED", extractNativeAwsMessage(err)),
      details,
    );
  } finally {
    try {
      await fs.unlink(render.filePath);
    } catch {
      // noop
    }
  }

  await deps.jobsRepo.markDone({
    jobId: job.job_id,
    reqId,
    workerRef: deps.workerId,
    s3KeyRef: s3Key,
    s3Bucket: deps.s3BucketPdf,
    s3Region: deps.s3Region,
    artifactSha256Hex: render.sha256Hex,
    artifactSizeBytes: render.sizeBytes,
    contentType: render.contentType,
  });

  deps.logger.info(
    "job.done",
    {
      job_id: job.job_id,
      queue_mode: deps.jobsRepo.mode,
      render_mode: renderMode,
      template: templateName ?? undefined,
      s3_key_ref: s3Key,
      artifact_size_bytes: render.sizeBytes,
    },
    reqId,
  );
}

export async function failOrRetry(job: JobRow, deps: JobProcessorDeps, err: unknown): Promise<void> {
  const reqId = resolveReqId(job);

  if (err instanceof SoftError) {
    const details = extractErrorDetails(err);
    const attempt = Math.max(1, job.attempts);
    const delay = Math.min(10 * Math.pow(2, attempt - 1), 900);
    if (job.attempts >= job.max_attempts) {
      await deps.jobsRepo.markFailed({
        jobId: job.job_id,
        reqId,
        workerRef: deps.workerId,
        errorCode: err.code,
        messageSafe: err.messageSafe,
      });
      deps.logger.error(
        "job.failed_hard",
        {
          job_id: job.job_id,
          queue_mode: deps.jobsRepo.mode,
          error_code: err.code,
          error_message: details.error_message,
          error_stack: details.error_stack,
          aws_code: details.aws_code,
        },
        reqId,
      );
      return;
    }

    await deps.jobsRepo.requeueWithBackoff({
      jobId: job.job_id,
      reqId,
      workerRef: deps.workerId,
      delaySeconds: Math.floor(delay),
      errorCode: err.code,
      messageSafe: err.messageSafe,
    });

    deps.logger.warning(
      "job.requeued",
      {
        job_id: job.job_id,
        queue_mode: deps.jobsRepo.mode,
        error_code: err.code,
        delay_s: Math.floor(delay),
        attempt: job.attempts,
        max_attempts: job.max_attempts,
        error_message: details.error_message,
        error_stack: details.error_stack,
        aws_code: details.aws_code,
      },
      reqId,
    );

    return;
  }

  const hard = err instanceof HardError ? err : new HardError("ML_JOB_PROCESSING_FAILED", "Job processing failed");

  await deps.jobsRepo.markFailed({
    jobId: job.job_id,
    reqId,
    workerRef: deps.workerId,
    errorCode: hard.code,
    messageSafe: hard.messageSafe,
  });

  deps.logger.error(
    "job.failed_hard",
    {
      job_id: job.job_id,
      queue_mode: deps.jobsRepo.mode,
      error_code: hard.code,
      error_message: hard.message,
      error_stack: hard.stack,
      aws_code: extractAwsCode(hard),
    },
    reqId,
  );
}

function assertRestJobSignature(job: JobRow, deps: JobProcessorDeps): void {
  const parsed = parseMls1Token(job.mls1_token);
  if (!parsed) {
    throw new HardError("ML_JOB_BAD_MLS1", "Job signature format invalid");
  }

  const okSig = verifyMls1Payload(parsed.payloadBytes, parsed.sigHex, deps.hmacSecrets);
  if (!okSig) {
    throw new HardError("ML_JOB_BAD_SIG", "Job signature invalid");
  }

  let payloadObj: Record<string, unknown>;
  try {
    payloadObj = JSON.parse(parsed.payloadBytes.toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new HardError("ML_JOB_BAD_PAYLOAD", "Job payload is not valid JSON");
  }

  if (payloadObj.schema_version !== "2026.5") {
    throw new HardError("ML_JOB_SCHEMA_MISMATCH", "Job schema_version mismatch");
  }
  if (payloadObj.site_id !== deps.siteId) {
    throw new HardError("ML_JOB_SITE_MISMATCH", "Job site_id mismatch");
  }

  const payloadJob = payloadObj.job as Record<string, unknown> | undefined;
  const payloadJobId = typeof payloadJob?.job_id === "string" ? payloadJob.job_id : null;
  if (payloadJobId && payloadJobId !== job.job_id) {
    throw new HardError("ML_JOB_ID_MISMATCH", "Job ID mismatch");
  }
}

function resolveReqId(job: JobRow): string | undefined {
  return job.req_id ?? job.source_req_id ?? undefined;
}

function buildPdfS3Key(siteId: string, jobId: string, now: Date): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `unit/${siteId}/rx-pdf/${yyyy}/${mm}/${jobId}.pdf`;
}

function extractNativeAwsMessage(err: unknown): string {
  if (err && typeof err === "object") {
    const rec = err as Record<string, unknown>;
    const name = typeof rec.name === "string" ? rec.name : "";
    const message = typeof rec.message === "string" ? rec.message : "";

    if (rec.$metadata && name && message) {
      return `[${name}] ${message}`;
    }

    if (name && message) {
      return `[${name}] ${message}`;
    }

    if (message) {
      return message;
    }
  }

  if (err instanceof Error && err.message) {
    return err.message;
  }

  return String(err);
}

function withErrorDetails<T extends Error>(err: T, details: ErrorDetails): T {
  Object.assign(err as Record<string, unknown>, details);
  return err;
}

function extractErrorDetails(err: unknown): ErrorDetails {
  const error = err as Record<string, unknown> | undefined;

  return {
    error_message: err instanceof Error ? err.message : String(err),
    error_stack: err instanceof Error ? err.stack : undefined,
    aws_code: extractAwsCode(error),
  };
}

function extractAwsCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;

  const rec = err as Record<string, unknown>;
  const awsCode = rec.Code ?? rec.code ?? rec.name;
  return typeof awsCode === "string" && awsCode !== "" ? awsCode : undefined;
}

interface ErrorDetails {
  error_message: string;
  error_stack?: string;
  aws_code?: string;
}
