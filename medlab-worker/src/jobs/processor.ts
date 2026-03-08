import { JobRow, JobsRepo, sha256Bytes } from "../db/jobsRepo";
import { NdjsonLogger } from "../logger";
import { parseMls1Token, verifyMls1Payload } from "../security/mls1";
import { S3Service } from "../s3/s3Service";

export class SoftError extends Error {
  constructor(public readonly code: string, public readonly messageSafe: string) {
    super(messageSafe);
  }
}

export class HardError extends Error {
  constructor(public readonly code: string, public readonly messageSafe: string) {
    super(messageSafe);
  }
}

export interface JobProcessorDeps {
  siteId: string;
  jobsRepo: JobsRepo;
  s3: S3Service;
  s3BucketPdf: string;
  hmacSecrets: string[];
  logger: NdjsonLogger;
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

  const pdfBytes = makePlaceholderPdf(job.job_id, reqId);
  const artifactSha = sha256Bytes(pdfBytes);

  const s3Key = buildPdfS3Key(deps.siteId, job.job_id, new Date());
  try {
    await deps.s3.uploadPdf({
      bucket: deps.s3BucketPdf,
      key: s3Key,
      body: pdfBytes,
      contentType: "application/pdf",
      metadata: {
        schema_version: "2026.5",
        job_id: job.job_id,
        req_id: reqId ?? "",
      },
    });
  } catch (_err) {
    throw new SoftError("ML_S3_UPLOAD_FAILED", "S3 upload failed");
  }

  await deps.jobsRepo.markDone({
    jobId: job.job_id,
    s3KeyRef: s3Key,
    artifactSha256: artifactSha,
    artifactSizeBytes: pdfBytes.length,
    contentType: "application/pdf",
  });

  deps.logger.info(
    "job.done",
    {
      job_id: job.job_id,
      s3_key_ref: s3Key,
      artifact_size_bytes: pdfBytes.length,
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
        errorCode: err.code,
        messageSafe: err.messageSafe,
      });
      deps.logger.error("job.failed_hard", { job_id: job.job_id, error_code: err.code }, reqId);
      return;
    }

    await deps.jobsRepo.requeueWithBackoff({
      jobId: job.job_id,
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

function makePlaceholderPdf(jobId: string, reqId?: string): Buffer {
  const text = `SOS Prescription v3\nPlaceholder PDF\njob_id=${jobId}\nreq_id=${reqId ?? "n/a"}\n`;
  const pdf = [
    "%PDF-1.4",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >> endobj",
    `4 0 obj << /Length ${text.length + 40} >> stream`,
    `BT /F1 12 Tf 72 760 Td (${escapePdfString(text)}) Tj ET`,
    "endstream endobj",
    "xref",
    "0 5",
    "0000000000 65535 f ",
    "trailer << /Root 1 0 R /Size 5 >>",
    "startxref",
    "0",
    "%%EOF",
  ].join("\n");
  return Buffer.from(pdf, "utf8");
}

function escapePdfString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}
