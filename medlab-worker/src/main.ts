// src/main.ts
import { MemoryGuard } from "./admission/memoryGuard";
import { loadConfig } from "./config";
import { startPulseServer } from "./http/pulseServer";
import type { JobsRepo } from "./jobs/jobsRepo";
import { PrismaJobsRepo } from "./jobs/prismaJobsRepo";
import { failOrRetry, processJob } from "./jobs/processor";
import { PdfRenderer } from "./pdf/pdfRenderer";
import { NdjsonLogger } from "./logger";
import { NonceCache } from "./security/nonceCache";
import { S3Service } from "./s3/s3Service";
import { sleep } from "./utils/sleep";
import { TemplateRegistry } from "./pdf/templateRegistry";
import { SignatureDataUriLoader } from "./pdf/assets/signatureDataUri";
import { PrescriptionHtmlBuilder } from "./pdf/prescriptionHtmlBuilder";
import { PrismaPrescriptionStore } from "./prescriptions/prismaPrescriptionStore";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const logger = new NdjsonLogger("worker", cfg.siteId, cfg.env);
  const queueMode = resolveForcedQueueMode(process.env.QUEUE_MODE);
  const idlePollMs = Math.max(cfg.pollIntervalMs, 5_000);
  const claimFailureBackoffMs = Math.max(idlePollMs, 10_000);

  const jobsRepo: JobsRepo = new PrismaJobsRepo({
    siteId: cfg.siteId,
    workerId: cfg.workerId,
    hmacSecretActive: cfg.security.hmacSecretActive,
    logger,
  });

  process.stderr.write("Initialisation du Bucket S3...\n");
  const s3 = new S3Service(cfg.s3);

  process.stderr.write("Lancement du binaire Chrome...\n");
  const pdfRenderer = new PdfRenderer(logger);

  const memGuard = new MemoryGuard(cfg.ramGuardMaxMb, cfg.ramGuardResumeMb);
  const nonceCache = new NonceCache(cfg.security.authSkewWindowMs * 2);
  const templateRegistry = new TemplateRegistry();

  const signatureLoader = new SignatureDataUriLoader({
    endpoint: cfg.s3.endpoint,
    region: cfg.s3.region,
    accessKeyId: cfg.s3.accessKeyId,
    secretAccessKey: cfg.s3.secretAccessKey,
    forcePathStyle: cfg.s3.forcePathStyle,
    bucket: (process.env.S3_BUCKET_SIGNATURES ?? cfg.s3.bucketPdf).trim(),
  });

  const prescriptionStore = new PrismaPrescriptionStore({ logger });

  const htmlBuilder = new PrescriptionHtmlBuilder({
    templateRegistry,
    signatureLoader,
    logger,
    verifyBaseUrl: process.env.ML_VERIFY_BASE_URL ?? "https://sosprescription.fr",
    defaultTemplateVariant: process.env.ML_PDF_TEMPLATE_DEFAULT ?? "modern",
  });

  const secrets = [
    cfg.security.hmacSecretActive,
    ...(cfg.security.hmacSecretPrevious ? [cfg.security.hmacSecretPrevious] : []),
  ];

  const server = startPulseServer({
    port: cfg.port,
    siteId: cfg.siteId,
    workerId: cfg.workerId,
    jobsRepo,
    memGuard,
    nonceCache,
    secrets,
    skewWindowMs: cfg.security.authSkewWindowMs,
    logger,
  });

  const shutdown = async (signal: string) => {
    logger.warning("system.shutdown", { signal, queue_mode: jobsRepo.mode }, undefined);

    try {
      server.close();
    } catch {
      // noop
    }

    try {
      await prescriptionStore.close();
    } catch {
      // noop
    }

    try {
      await signatureLoader.close();
    } catch {
      // noop
    }

    try {
      await jobsRepo.close();
    } catch {
      // noop
    }

    try {
      await s3.close();
    } catch {
      // noop
    }

    process.exit(0);
  };

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  logger.info(
    "system.worker_started",
    {
      worker_id: cfg.workerId,
      queue_mode: queueMode,
      queue_table: jobsRepo.getTableName(),
      lease_min: cfg.leaseMinutes,
      poll_ms: idlePollMs,
      render_mode: "local-inline-html",
      template_default: process.env.ML_PDF_TEMPLATE_DEFAULT ?? "modern",
      html_builder_ready: true,
      signature_loader_ready: true,
    },
    undefined,
  );

  while (true) {
    memGuard.tick();

    if (!memGuard.canClaim()) {
      logger.warning(
        "system.admission.degraded",
        {
          rss_mb: memGuard.rssMb(),
          threshold_mb: cfg.ramGuardMaxMb,
          resume_mb: cfg.ramGuardResumeMb,
        },
        undefined,
      );

      await sleep(withJitter(Math.min(idlePollMs, 5_000), 500));
      continue;
    }

    let job = null;
    try {
      job = await jobsRepo.claimNextPendingJob({
        siteId: cfg.siteId,
        workerId: cfg.workerId,
        leaseMinutes: cfg.leaseMinutes,
      });
    } catch (err: unknown) {
      logger.error(
        "job.claim_failed",
        {
          message: err instanceof Error ? err.message : "Failed to claim job",
          queue_mode: jobsRepo.mode,
          queue_table: jobsRepo.getTableName(),
        },
        undefined,
      );
      await sleep(withJitter(claimFailureBackoffMs, 1_000));
      continue;
    }

    if (!job) {
      await sleep(withJitter(idlePollMs, 1_000));
      continue;
    }

    try {
      await processJob(job, {
        siteId: cfg.siteId,
        wpBaseUrl: cfg.wpBaseUrl,
        renderPathTemplate: cfg.pdfRenderPathTemplate,
        chromeExecutablePath: cfg.chromeExecutablePath,
        jobsRepo,
        s3,
        s3BucketPdf: cfg.s3.bucketPdf,
        s3Region: cfg.s3.region,
        hmacSecrets: secrets,
        hmacSecretActive: cfg.security.hmacSecretActive,
        workerId: cfg.workerId,
        pdfRenderer,
        logger,
        memGuard,
        admissionMaxMb: cfg.ramGuardMaxMb,
        pdfRenderTimeoutMs: cfg.pdfRenderTimeoutMs,
        pdfReadyTimeoutMs: cfg.pdfReadyTimeoutMs,
        prescriptionStore,
        htmlBuilder,
      });
    } catch (err) {
      await failOrRetry(
        job,
        {
          siteId: cfg.siteId,
          wpBaseUrl: cfg.wpBaseUrl,
          renderPathTemplate: cfg.pdfRenderPathTemplate,
          chromeExecutablePath: cfg.chromeExecutablePath,
          jobsRepo,
          s3,
          s3BucketPdf: cfg.s3.bucketPdf,
          s3Region: cfg.s3.region,
          hmacSecrets: secrets,
          hmacSecretActive: cfg.security.hmacSecretActive,
          workerId: cfg.workerId,
          pdfRenderer,
          logger,
          memGuard,
          admissionMaxMb: cfg.ramGuardMaxMb,
          pdfRenderTimeoutMs: cfg.pdfRenderTimeoutMs,
          pdfReadyTimeoutMs: cfg.pdfReadyTimeoutMs,
          prescriptionStore,
          htmlBuilder,
        },
        err,
      );
    }
  }
}

function resolveForcedQueueMode(value: string | undefined): "postgres" {
  const raw = (value ?? "postgres").trim().toLowerCase();
  if (raw !== "postgres") {
    throw new Error(`QUEUE_MODE must be 'postgres' for Zero-PII mode, received: ${raw || "<empty>"}`);
  }
  return "postgres";
}

function withJitter(baseMs: number, jitterMs: number): number {
  if (jitterMs <= 0) {
    return baseMs;
  }

  const extra = Math.floor(Math.random() * (jitterMs + 1));
  return baseMs + extra;
}

void main().catch((error: unknown) => {
  process.stderr.write("Fatal worker error\n");
  if (error instanceof Error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
  } else {
    process.stderr.write(`${String(error)}\n`);
  }
  process.exit(1);
});
