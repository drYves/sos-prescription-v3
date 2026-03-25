"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// src/main.ts
const memoryGuard_1 = require("./admission/memoryGuard");
const config_1 = require("./config");
const pulseServer_1 = require("./http/pulseServer");
const prismaJobsRepo_1 = require("./jobs/prismaJobsRepo");
const processor_1 = require("./jobs/processor");
const pdfRenderer_1 = require("./pdf/pdfRenderer");
const logger_1 = require("./logger");
const templateRegistry_1 = require("./pdf/templateRegistry");
const signatureDataUri_1 = require("./pdf/assets/signatureDataUri");
const prescriptionHtmlBuilder_1 = require("./pdf/prescriptionHtmlBuilder");
const prismaPrescriptionStore_1 = require("./prescriptions/prismaPrescriptionStore");
const nonceCache_1 = require("./security/nonceCache");
const s3Service_1 = require("./s3/s3Service");
const sleep_1 = require("./utils/sleep");
const DEFAULT_WP_CALLBACK_PATH_TEMPLATE = "/wp-json/sosprescription/v1/prescriptions/worker/{job_id}/callback";
async function main() {
    const cfg = (0, config_1.loadConfig)();
    const logger = new logger_1.NdjsonLogger("worker", cfg.siteId, cfg.env);
    const requestedQueueMode = resolveQueueMode(process.env.QUEUE_MODE);
    const queueMode = "postgres";
    if (requestedQueueMode !== "postgres") {
        logger.warning("system.queue_mode_forced", {
            requested_queue_mode: requestedQueueMode,
            effective_queue_mode: queueMode,
        }, undefined);
    }
    const idlePollMs = Math.max(cfg.pollIntervalMs, 5_000);
    const claimFailureBackoffMs = Math.max(idlePollMs, 10_000);
    const jobsRepo = new prismaJobsRepo_1.PrismaJobsRepo({
        siteId: cfg.siteId,
        workerId: cfg.workerId,
        hmacSecretActive: cfg.security.hmacSecretActive,
        wpBaseUrl: cfg.wpBaseUrl,
        wpCallbackPathTemplate: process.env.WP_SHADOW_CALLBACK_PATH_TEMPLATE ?? DEFAULT_WP_CALLBACK_PATH_TEMPLATE,
        requestTimeoutMs: cfg.restRequestTimeoutMs,
        logger,
    });
    process.stderr.write("Initialisation du Bucket S3...\n");
    const s3 = new s3Service_1.S3Service(cfg.s3);
    process.stderr.write("Lancement du binaire Chrome...\n");
    const pdfRenderer = new pdfRenderer_1.PdfRenderer(logger);
    const memGuard = new memoryGuard_1.MemoryGuard(cfg.ramGuardMaxMb, cfg.ramGuardResumeMb);
    const nonceCache = new nonceCache_1.NonceCache(cfg.security.authSkewWindowMs * 2);
    const templateRegistry = new templateRegistry_1.TemplateRegistry();
    const signatureLoader = new signatureDataUri_1.SignatureDataUriLoader({
        endpoint: cfg.s3.endpoint,
        region: cfg.s3.region,
        accessKeyId: cfg.s3.accessKeyId,
        secretAccessKey: cfg.s3.secretAccessKey,
        forcePathStyle: cfg.s3.forcePathStyle,
        bucket: (process.env.S3_BUCKET_SIGNATURES ?? cfg.s3.bucketPdf).trim(),
    });
    const prescriptionStore = new prismaPrescriptionStore_1.PrismaPrescriptionStore({ logger });
    const htmlBuilder = new prescriptionHtmlBuilder_1.PrescriptionHtmlBuilder({
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
    const server = (0, pulseServer_1.startPulseServer)({
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
    const shutdown = async (signal) => {
        logger.warning("system.shutdown", { signal, queue_mode: jobsRepo.mode }, undefined);
        try {
            server.close();
        }
        catch {
            // noop
        }
        try {
            await prescriptionStore.close();
        }
        catch {
            // noop
        }
        try {
            await signatureLoader.close();
        }
        catch {
            // noop
        }
        try {
            await jobsRepo.close();
        }
        catch {
            // noop
        }
        try {
            await s3.close();
        }
        catch {
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
    logger.info("system.worker_started", {
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
    }, undefined);
    while (true) {
        memGuard.tick();
        if (!memGuard.canClaim()) {
            logger.warning("system.admission.degraded", {
                rss_mb: memGuard.rssMb(),
                threshold_mb: cfg.ramGuardMaxMb,
                resume_mb: cfg.ramGuardResumeMb,
            }, undefined);
            await (0, sleep_1.sleep)(withJitter(Math.min(idlePollMs, 5_000), 500));
            continue;
        }
        let job = null;
        try {
            job = await jobsRepo.claimNextPendingJob({
                siteId: cfg.siteId,
                workerId: cfg.workerId,
                leaseMinutes: cfg.leaseMinutes,
            });
        }
        catch (err) {
            logger.error("job.claim_failed", {
                message: err instanceof Error ? err.message : "Failed to claim job",
                queue_mode: jobsRepo.mode,
                queue_table: jobsRepo.getTableName(),
            }, undefined);
            await (0, sleep_1.sleep)(withJitter(claimFailureBackoffMs, 1_000));
            continue;
        }
        if (!job) {
            await (0, sleep_1.sleep)(withJitter(idlePollMs, 1_000));
            continue;
        }
        try {
            await (0, processor_1.processJob)(job, {
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
        }
        catch (err) {
            await (0, processor_1.failOrRetry)(job, {
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
            }, err);
        }
    }
}
function resolveQueueMode(value) {
    const raw = (value ?? "postgres").trim().toLowerCase();
    return raw === "rest" ? "rest" : "postgres";
}
function withJitter(baseMs, jitterMs) {
    if (jitterMs <= 0) {
        return baseMs;
    }
    const extra = Math.floor(Math.random() * (jitterMs + 1));
    return baseMs + extra;
}
void main().catch((error) => {
    process.stderr.write("Fatal worker error\n");
    if (error instanceof Error) {
        process.stderr.write(`${error.stack ?? error.message}\n`);
    }
    else {
        process.stderr.write(`${String(error)}\n`);
    }
    process.exit(1);
});
