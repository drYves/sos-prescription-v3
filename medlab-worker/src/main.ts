import { MemoryGuard } from "./admission/memoryGuard";
import { loadConfig } from "./config";
import { JobsRepo } from "./db/jobsRepo";
import { createMysqlPool } from "./db/mysql";
import { startPulseServer } from "./http/pulseServer";
import { failOrRetry, processJob } from "./jobs/processor";
import { PdfRenderer } from "./pdf/pdfRenderer";
import { NdjsonLogger } from "./logger";
import { NonceCache } from "./security/nonceCache";
import { S3Service } from "./s3/s3Service";
import { sleep } from "./utils/sleep";

async function main(): Promise<void> {
  process.stderr.write("Vérification de DATABASE_URL...\n");
  const cfg = loadConfig();
  const logger = new NdjsonLogger("worker", cfg.siteId, cfg.env);

  const pool = createMysqlPool(cfg.mysql);
  const jobsRepo = new JobsRepo(pool, cfg.mysql.tablePrefix);

  process.stderr.write("Initialisation du Bucket S3...\n");
  const s3 = new S3Service(cfg.s3);

  process.stderr.write("Lancement du binaire Chrome...\n");
  const pdfRenderer = new PdfRenderer(logger);

  const memGuard = new MemoryGuard(cfg.ramGuardMaxMb, cfg.ramGuardResumeMb);
  const nonceCache = new NonceCache(cfg.security.authSkewWindowMs * 2);

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

  const zombieTimer = setInterval(async () => {
    try {
      const r = await jobsRepo.sweepZombies(cfg.siteId, 50);
      if (r.requeued || r.failed) {
        logger.warning("job.zombie_sweep", { requeued: r.requeued, failed: r.failed }, undefined);
      }
    } catch (_err) {
      logger.error("job.zombie_sweep_failed", { message: "Zombie sweep failed" }, undefined);
    }
  }, cfg.zombieSweepIntervalMs);
  zombieTimer.unref();

  const shutdown = async (signal: string) => {
    logger.warning("system.shutdown", { signal }, undefined);
    try {
      server.close();
    } catch (_err) {
      // noop
    }
    try {
      clearInterval(zombieTimer);
    } catch (_err) {
      // noop
    }
    try {
      await pool.end();
    } catch (_err) {
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
      table: jobsRepo.getTableName(),
      lease_min: cfg.leaseMinutes,
      poll_ms: cfg.pollIntervalMs,
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

      await sleep(2000);
      continue;
    }

    let job = null;
    try {
      job = await jobsRepo.claimNextPendingJob({
        siteId: cfg.siteId,
        workerId: cfg.workerId,
        leaseMinutes: cfg.leaseMinutes,
      });
    } catch (_err) {
      logger.error("job.claim_failed", { message: "Failed to claim job" }, undefined);
      await sleep(1000);
      continue;
    }

    if (!job) {
      await sleep(cfg.pollIntervalMs);
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
        hmacSecrets: secrets,
        hmacSecretActive: cfg.security.hmacSecretActive,
        workerId: cfg.workerId,
        pdfRenderer,
        logger,
        memGuard,
        admissionMaxMb: cfg.ramGuardMaxMb,
        pdfRenderTimeoutMs: cfg.pdfRenderTimeoutMs,
        pdfReadyTimeoutMs: cfg.pdfReadyTimeoutMs,
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
          hmacSecrets: secrets,
          hmacSecretActive: cfg.security.hmacSecretActive,
          workerId: cfg.workerId,
          pdfRenderer,
          logger,
          memGuard,
          admissionMaxMb: cfg.ramGuardMaxMb,
          pdfRenderTimeoutMs: cfg.pdfRenderTimeoutMs,
          pdfReadyTimeoutMs: cfg.pdfReadyTimeoutMs,
        },
        err,
      );
    }
  }
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
