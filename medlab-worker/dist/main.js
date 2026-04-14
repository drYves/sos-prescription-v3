"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
// src/main.ts
const memoryGuard_1 = require("./admission/memoryGuard");
const openRouterService_1 = require("./ai/openRouterService");
const artifactRepo_1 = require("./artifacts/artifactRepo");
const messagesRepo_1 = require("./messages/messagesRepo");
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
const paymentProcessor_1 = require("./payments/paymentProcessor");
const stripeClient_1 = require("./payments/stripeClient");
const wordpressPaymentBridge_1 = require("./payments/wordpressPaymentBridge");
const copilotService_1 = require("./services/copilotService");
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
    const stripeGateway = new stripeClient_1.StripeGateway({
        secretKey: process.env.STRIPE_SECRET_KEY,
        webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    });
    const wpPaymentBridge = new wordpressPaymentBridge_1.WordPressPaymentBridge({
        wpBaseUrl: cfg.wpBaseUrl,
        siteId: cfg.siteId,
        hmacSecret: cfg.security.hmacSecretActive,
        timeoutMs: cfg.restRequestTimeoutMs,
    });
    const jobsRepo = new prismaJobsRepo_1.PrismaJobsRepo({
        siteId: cfg.siteId,
        workerId: cfg.workerId,
        hmacSecretActive: cfg.security.hmacSecretActive,
        wpBaseUrl: cfg.wpBaseUrl,
        wpCallbackPathTemplate: process.env.WP_SHADOW_CALLBACK_PATH_TEMPLATE ?? DEFAULT_WP_CALLBACK_PATH_TEMPLATE,
        requestTimeoutMs: cfg.restRequestTimeoutMs,
        logger,
    });
    const artifactRepo = new artifactRepo_1.ArtifactRepo({ logger });
    const messagesRepo = new messagesRepo_1.MessagesRepo({ logger });
    const prismaJobsRepo = jobsRepo instanceof prismaJobsRepo_1.PrismaJobsRepo ? jobsRepo : null;
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
        requestTimeoutMs: cfg.restRequestTimeoutMs,
        wpBaseUrl: cfg.wpBaseUrl,
        wpHmacSecret: cfg.security.hmacSecretActive,
    });
    const prescriptionStore = new prismaPrescriptionStore_1.PrismaPrescriptionStore({ logger });
    const htmlBuilder = new prescriptionHtmlBuilder_1.PrescriptionHtmlBuilder({
        templateRegistry,
        signatureLoader,
        logger,
        verifyBaseUrl: process.env.ML_VERIFY_BASE_URL ?? "https://sosprescription.fr",
        defaultTemplateVariant: process.env.ML_PDF_TEMPLATE_DEFAULT ?? "modern",
    });
    const openRouter = new openRouterService_1.OpenRouterService({
        apiKey: cfg.openRouter.apiKey,
        model: cfg.openRouter.model,
        baseUrl: cfg.openRouter.baseUrl,
        requestTimeoutMs: cfg.openRouter.requestTimeoutMs,
        httpReferer: cfg.openRouter.httpReferer,
        title: cfg.openRouter.title,
        logger,
    });
    const copilotService = new copilotService_1.CopilotService({
        apiKey: cfg.openRouter.apiKey,
        model: cfg.openRouter.model,
        baseUrl: cfg.openRouter.baseUrl,
        requestTimeoutMs: cfg.openRouter.requestTimeoutMs,
        httpReferer: cfg.openRouter.httpReferer,
        title: `${cfg.openRouter.title ?? "SOS Prescription Worker"} Copilot`,
        logger,
    });
    const smartRepliesEnabled = resolveBooleanFlag(process.env.SMART_REPLIES_ENABLED, false);
    let smartReplyService;
    if (smartRepliesEnabled) {
        const { SmartReplyService: SmartReplyServiceCtor } = await Promise.resolve().then(() => __importStar(require("./services/smartReplyService")));
        smartReplyService = new SmartReplyServiceCtor({
            siteId: cfg.siteId,
            copilot: copilotService,
            logger,
        });
        await smartReplyService.ensureSchema();
    }
    else {
        logger.info("smart_replies.disabled", {
            smart_replies_enabled: false,
        }, undefined);
    }
    if (prismaJobsRepo) {
        await prismaJobsRepo.ensurePaymentActionQueueSchema();
    }
    const secrets = [
        cfg.security.hmacSecretActive,
        ...(cfg.security.hmacSecretPrevious ? [cfg.security.hmacSecretPrevious] : []),
    ];
    const server = (0, pulseServer_1.startPulseServer)({
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
        copilotService,
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
            await artifactRepo.close();
        }
        catch {
            // noop
        }
        try {
            await messagesRepo.close();
        }
        catch {
            // noop
        }
        if (smartRepliesEnabled && smartReplyService) {
            try {
                await smartReplyService.close();
            }
            catch {
                // noop
            }
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
        artifact_bucket: cfg.s3.bucketArtifacts,
        artifact_upload_max_bytes: cfg.upload.maxBytes,
        artifact_ticket_ttl_ms: cfg.upload.ticketTtlMs,
        openrouter_enabled: openRouter.isEnabled(),
        openrouter_model: cfg.openRouter.model,
        smart_replies_enabled: smartReplyService != null,
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
        if (job) {
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
            continue;
        }
        if (prismaJobsRepo) {
            let paymentJob = null;
            try {
                paymentJob = await prismaJobsRepo.claimNextPendingPaymentActionJob({
                    workerId: cfg.workerId,
                    leaseMinutes: cfg.leaseMinutes,
                });
            }
            catch (err) {
                logger.error("payment.job.claim_failed", {
                    message: err instanceof Error ? err.message : "Failed to claim payment job",
                    queue_mode: prismaJobsRepo.mode,
                    queue_table: prismaJobsRepo.getTableName(),
                }, undefined);
                await (0, sleep_1.sleep)(withJitter(claimFailureBackoffMs, 1_000));
                continue;
            }
            if (paymentJob) {
                await (0, paymentProcessor_1.processPaymentActionJob)(paymentJob, {
                    repo: prismaJobsRepo,
                    stripe: stripeGateway,
                    wpBridge: wpPaymentBridge,
                    logger,
                });
                continue;
            }
        }
        if (smartRepliesEnabled && smartReplyService) {
            let smartReplyJob = null;
            try {
                smartReplyJob = await smartReplyService.claimNextPendingJob({
                    workerId: cfg.workerId,
                    leaseMinutes: cfg.leaseMinutes,
                });
            }
            catch (err) {
                logger.error("smart_replies.job.claim_failed", {
                    message: err instanceof Error ? err.message : "Failed to claim smart reply job",
                }, undefined);
                await (0, sleep_1.sleep)(withJitter(claimFailureBackoffMs, 1_000));
                continue;
            }
            if (smartReplyJob) {
                await smartReplyService.processJob(smartReplyJob);
                continue;
            }
        }
        await (0, sleep_1.sleep)(withJitter(idlePollMs, 1_000));
    }
}
function resolveQueueMode(value) {
    const normalized = String(value ?? "postgres").trim().toLowerCase();
    return normalized === "rest" ? "rest" : "postgres";
}
function resolveBooleanFlag(value, fallback) {
    const normalized = String(value ?? "").trim().toLowerCase();
    if (normalized === "") {
        return fallback;
    }
    return ["1", "true", "yes", "on"].includes(normalized);
}
function withJitter(baseMs, spreadMs) {
    const spread = Math.max(0, Math.floor(spreadMs));
    if (spread === 0)
        return Math.max(0, Math.floor(baseMs));
    const min = Math.max(0, Math.floor(baseMs) - spread);
    const max = Math.max(min, Math.floor(baseMs) + spread);
    return Math.floor(Math.random() * (max - min + 1)) + min;
}
main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
});
