// src/jobs/processor.ts
import fs from "node:fs/promises";
import { NdjsonLogger } from "../logger";
import { PdfRenderer } from "../pdf/pdfRenderer";
import { parseMls1Token, verifyMls1Payload } from "../security/mls1";
import { S3Service } from "../s3/s3Service";
import { HardError, SoftError } from "./errors";
import { JobRow, RestJobsRepo } from "./restJobsRepo";

export interface JobProcessorDeps {
  siteId: string;
  wpBaseUrl: string;
  renderPathTemplate: string;
  chromeExecutablePath: string;
  jobsRepo: RestJobsRepo;
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
}

export async function processJob(job: JobRow, deps: JobProcessorDeps): Promise<void> {
  const reqId = job.req_id ?? undefined;

  deps.logger.info(
    "job.claimed",
    {
      job_id: job.job_id,
      job_type: job.job_type,
      attempts: job.attempts,
      max_attempts: job.max_attempts,
    },
    reqId,
  );

  const parsed = parseMls1Token(job.mls1_token);
  if (!parsed) {
    throw new HardError("ML_JOB_BAD_MLS1", "Job signature format invalid");
  }

  const okSig = verifyMls1Payload(parsed.payloadBytes, parsed.sigHex, deps.hmacSecrets);
  if (!okSig) {
    throw new HardError("ML_JOB_BAD_SIG", "Job signature invalid");
  }

  let payloadObj: any;
  try {
    payloadObj = JSON.parse(parsed.payloadBytes.toString("utf8"));
  } catch (_err) {
    throw new HardError("ML_JOB_BAD_PAYLOAD", "Job payload is not valid JSON");
  }

  if (payloadObj?.schema_version !== "2026.5") {
    throw new HardError("ML_JOB_SCHEMA_MISMATCH", "Job schema_version mismatch");
  }
  if (payloadObj?.site_id !== deps.siteId) {
    throw new HardError("ML_JOB_SITE_MISMATCH", "Job site_id mismatch");
  }

  const payloadJobId = payloadObj?.job?.job_id;
  if (payloadJobId && payloadJobId !== job.job_id) {
    throw new HardError("ML_JOB_ID_MISMATCH", "Job ID mismatch");
  }

  if (job.job_type !== "PDF_GEN") {
    throw new HardError("ML_JOB_TYPE_UNSUPPORTED", "Unsupported job type");
  }

  const render = await deps.pdfRenderer.renderToTmpPdf({
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

  const s3Key = buildPdfS3Key(deps.siteId, job.job_id, new Date());

  try {
    await deps.s3.uploadPdfFromFile({
      bucket: deps.s3BucketPdf,
      key: s3Key,
      filePath: render.filePath,
      contentType: render.contentType,
      contentLength: render.sizeBytes,
      metadata: {
        schema_version: "2026.5",
        job_id: job.job_id,
        req_id: reqId ?? "",
      },
    });
  } catch (_err) {
    throw new SoftError("ML_S3_UPLOAD_FAILED", "S3 upload failed");
  } finally {
    try {
      await fs.unlink(render.filePath);
    } catch (_err) {
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
      s3_key_ref: s3Key,
      artifact_size_bytes: render.sizeBytes,
    },
    reqId,
  );
}

export async function failOrRetry(job: JobRow, deps: JobProcessorDeps, err: unknown): Promise<void> {
  const reqId = job.req_id ?? undefined;

  if (err instanceof SoftError) {
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
      deps.logger.error("job.failed_hard", { job_id: job.job_id, error_code: err.code }, reqId);
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
        error_code: err.code,
        delay_s: Math.floor(delay),
        attempt: job.attempts,
        max_attempts: job.max_attempts,
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
      error_code: hard.code,
    },
    reqId,
  );
}

function buildPdfS3Key(siteId: string, jobId: string, now: Date): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `unit/${siteId}/rx-pdf/${yyyy}/${mm}/${jobId}.pdf`;
}
