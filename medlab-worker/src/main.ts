// src/main.ts
import { MemoryGuard } from "./admission/memoryGuard";
import { OpenRouterService } from "./ai/openRouterService";
import { ArtifactRepo } from "./artifacts/artifactRepo";
import { MessagesRepo } from "./messages/messagesRepo";
import { loadConfig } from "./config";
import { startPulseServer } from "./http/pulseServer";
import type { JobsRepo } from "./jobs/jobsRepo";
import { PrismaJobsRepo } from "./jobs/prismaJobsRepo";
import { failOrRetry, processJob } from "./jobs/processor";
import { PdfRenderer } from "./pdf/pdfRenderer";
import { NdjsonLogger } from "./logger";
import { TemplateRegistry } from "./pdf/templateRegistry";
import { SignatureDataUriLoader } from "./pdf/assets/signatureDataUri";
import { PrescriptionHtmlBuilder } from "./pdf/prescriptionHtmlBuilder";
import { PrismaPrescriptionStore } from "./prescriptions/prismaPrescriptionStore";
import { NonceCache } from "./security/nonceCache";
import { S3Service } from "./s3/s3Service";
import { sleep } from "./utils/sleep";
import { processPaymentActionJob } from "./payments/paymentProcessor";
import { StripeGateway } from "./payments/stripeClient";
import { WordPressPaymentBridge } from "./payments/wordpressPaymentBridge";
import { CopilotService } from "./services/copilotService";
import { SmartReplyService } from "./services/smartReplyService";

const DEFAULT_WP_CALLBACK_PATH_TEMPLATE = "/wp-json/sosprescription/v1/prescriptions/worker/{job_id}/callback";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const logger = new NdjsonLogger("worker", cfg.siteId, cfg.env);
  const requestedQueueMode = resolveQueueMode(process.env.QUEUE_MODE);
  const queueMode: "postgres" = "postgres";

  if (requestedQueueMode !== "postgres") {
    logger.warning(
      "system.queue_mode_forced",
      {
        requested_queue_mode: requestedQueueMode,
        effective_queue_mode: queueMode,
      },
      undefined,
    );
  }

  const idlePollMs = Math.max(cfg.pollIntervalMs, 5_000);
  const claimFailureBackoffMs = Math.max(idlePollMs, 10_000);

  const stripeGateway = new StripeGateway({
    secretKey: process.env.STRIPE_SECRET_KEY,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  });

  const wpPaymentBridge = new WordPressPaymentBridge({
    wpBaseUrl: cfg.wpBaseUrl,
    siteId: cfg.siteId,
    hmacSecret: cfg.security.hmacSecretActive,
    timeoutMs: cfg.restRequestTimeoutMs,
  });

  const jobsRepo: JobsRepo = new PrismaJobsRepo({
    siteId: cfg.siteId,
    workerId: cfg.workerId,
    hmacSecretActive: cfg.security.hmacSecretActive,
    wpBaseUrl: cfg.wpBaseUrl,
    wpCallbackPathTemplate: process.env.WP_SHADOW_CALLBACK_PATH_TEMPLATE ?? DEFAULT_WP_CALLBACK_PATH_TEMPLATE,
    requestTimeoutMs: cfg.restRequestTimeoutMs,
    logger,
  });

  const artifactRepo = new ArtifactRepo({ logger });
  const messagesRepo = new MessagesRepo({ logger });
  const prismaJobsRepo = jobsRepo instanceof PrismaJobsRepo ? jobsRepo : null;

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

  const openRouter = new OpenRouterService({
    apiKey: cfg.openRouter.apiKey,
    model: cfg.openRouter.model,
    baseUrl: cfg.openRouter.baseUrl,
    requestTimeoutMs: cfg.openRouter.requestTimeoutMs,
    httpReferer: cfg.openRouter.httpReferer,
    title: cfg.openRouter.title,
    logger,
  });

  const copilotService = new CopilotService({
    apiKey: cfg.openRouter.apiKey,
    model: cfg.openRouter.model,
    baseUrl: cfg.openRouter.baseUrl,
    requestTimeoutMs: cfg.openRouter.requestTimeoutMs,
    httpReferer: cfg.openRouter.httpReferer,
    title: `${cfg.openRouter.title ?? "SOS Prescription Worker"} Copilot`,
    logger,
  });

  const smartReplyService = new SmartReplyService({
    siteId: cfg.siteId,
    copilot: copilotService,
    logger,
  });

  await smartReplyService.ensureSchema();

  if (prismaJobsRepo) {
    await prismaJobsRepo.ensurePaymentActionQueueSchema();
  }

  const secrets = [
    cfg.security.hmacSecretActive,
    ...(cfg.security.hmacSecretPrevious ? [cfg.security.hmacSecretPrevious] : []),
  ];

  const server = startPulseServer({
    port: cfg.port,
    siteId: cfg.siteId,
    workerId: cfg.workerId,
    jobsRepo,
    artifactRepo,
    messagesRepo,
    s3,
    openRouter,
    artifactsBucket: cfg.s3.bucketArtifacts,
    artifactsRegion: cfg.s3.region,
    artifactUploadMaxBytes: cfg.upload.maxBytes,
    artifactUploadTicketTtlMs: cfg.upload.ticketTtlMs,
    workerPublicBaseUrl: cfg.upload.workerPublicBaseUrl,
    uploadAllowedOrigins: cfg.upload.allowedOrigins,
    memGuard,
    nonceCache,
    secrets,
    skewWindowMs: cfg.security.authSkewWindowMs,
    logger,
    stripeGateway,
    wpPaymentBridge,
    smartReplyService,
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
      await artifactRepo.close();
    } catch {
      // noop
    }

    try {
      await messagesRepo.close();
    } catch {
      // noop
    }

    try {
      await smartReplyService.close();
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
      queue_mode: jobsRepo.mode,
      queue_table: jobsRepo.getTableName(),
      lease_min: cfg.leaseMinutes,
      poll_ms: idlePollMs,
      render_mode: "local-inline-html",
      template_default: process.env.ML_PDF_TEMPLATE_DEFAULT ?? "modern",
      html_builder_ready: true,
      signature_loader_ready: true,
      wp_shadow_callback_path: process.env.WP_SHADOW_CALLBACK_PATH_TEMPLATE ?? DEFAULT_WP_CALLBACK_PATH_TEMPLATE,
      artifact_bucket: cfg.s3.bucketArtifacts,
      artifact_upload_max_bytes: cfg.upload.maxBytes,
      artifact_ticket_ttl_ms: cfg.upload.ticketTtlMs,
      openrouter_enabled: openRouter.isEnabled(),
      openrouter_model: cfg.openRouter.model,
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

    if (job) {
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
      continue;
    }

    if (prismaJobsRepo) {
      let paymentJob = null;
      try {
        paymentJob = await prismaJobsRepo.claimNextPendingPaymentActionJob({
          workerId: cfg.workerId,
          leaseMinutes: cfg.leaseMinutes,
        });
      } catch (err: unknown) {
        logger.error(
          "payment.job.claim_failed",
          {
            message: err instanceof Error ? err.message : "Failed to claim payment job",
            queue_mode: prismaJobsRepo.mode,
            queue_table: prismaJobsRepo.getTableName(),
          },
          undefined,
        );
        await sleep(withJitter(claimFailureBackoffMs, 1_000));
        continue;
      }

      if (paymentJob) {
        await processPaymentActionJob(paymentJob, {
          repo: prismaJobsRepo,
          stripe: stripeGateway,
          wpBridge: wpPaymentBridge,
          logger,
        });
        continue;
      }
    }

    let smartReplyJob = null;
    try {
      smartReplyJob = await smartReplyService.claimNextPendingJob({
        workerId: cfg.workerId,
        leaseMinutes: cfg.leaseMinutes,
      });
    } catch (err: unknown) {
      logger.error(
        "smart_replies.job.claim_failed",
        {
          message: err instanceof Error ? err.message : "Failed to claim smart reply job",
        },
        undefined,
      );
      await sleep(withJitter(claimFailureBackoffMs, 1_000));
      continue;
    }

    if (smartReplyJob) {
      await smartReplyService.processJob(smartReplyJob);
      continue;
    }

    await sleep(withJitter(idlePollMs, 1_000));
  }
}

function resolveQueueMode(value: string | undefined): string {
  const normalized = String(value ?? "postgres").trim().toLowerCase();
  return normalized === "rest" ? "rest" : "postgres";
}

function withJitter(baseMs: number, spreadMs: number): number {
  const spread = Math.max(0, Math.floor(spreadMs));
  if (spread === 0) return Math.max(0, Math.floor(baseMs));
  const min = Math.max(0, Math.floor(baseMs) - spread);
  const max = Math.max(min, Math.floor(baseMs) + spread);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
