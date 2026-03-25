"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.processJob = processJob;
exports.failOrRetry = failOrRetry;
// src/jobs/processor.ts
const promises_1 = __importDefault(require("node:fs/promises"));
const mls1_1 = require("../security/mls1");
const errors_1 = require("./errors");
async function processJob(job, deps) {
    const reqId = resolveReqId(job);
    deps.logger.info("job.claimed", {
        job_id: job.job_id,
        job_type: job.job_type,
        queue_mode: deps.jobsRepo.mode,
        attempts: job.attempts,
        max_attempts: job.max_attempts,
    }, reqId);
    if (job.job_type !== "PDF_GEN") {
        throw new errors_1.HardError("ML_JOB_TYPE_UNSUPPORTED", "Unsupported job type");
    }
    if (deps.jobsRepo.mode === "rest") {
        await processRestBridgeJob(job, deps, reqId);
        return;
    }
    await processLocalDbJob(job, deps, reqId);
}
async function processRestBridgeJob(job, deps, reqId) {
    assertRestJobSignature(job, deps);
    if (!deps.htmlBuilder) {
        throw new errors_1.HardError("ML_HTML_BUILDER_MISSING", "Prescription HTML builder is not configured");
    }
    const aggregate = buildRestAggregate(job);
    const templateVariant = resolveRestTemplateVariant(job);
    deps.logger.info("job.rest_payload_ready", {
        job_id: job.job_id,
        queue_mode: deps.jobsRepo.mode,
        render_mode: "inline-html",
        template_variant: templateVariant ?? process.env.ML_PDF_TEMPLATE_DEFAULT ?? "modern",
        doctor_rpps_present: normalizeString(aggregate.doctor.rpps) !== "",
        signature_present: normalizeString(aggregate.doctor.signatureS3Key) !== "",
        patient_birthdate_present: normalizeString(aggregate.patient.birthDate) !== "",
        items_count: countPrescriptionItems(aggregate.prescription.items),
    }, reqId);
    const built = await deps.htmlBuilder.buildHtml({
        aggregate,
        jobId: job.job_id,
        reqId,
        templateVariant,
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
async function processLocalDbJob(job, deps, reqId) {
    if (!deps.prescriptionStore) {
        throw new errors_1.HardError("ML_PRESCRIPTION_STORE_MISSING", "Prescription store is not configured");
    }
    if (!deps.htmlBuilder) {
        throw new errors_1.HardError("ML_HTML_BUILDER_MISSING", "Prescription HTML builder is not configured");
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
async function finalizeSuccessfulRender(job, deps, render, reqId, renderMode, templateName) {
    const s3Key = buildPdfS3Key(deps.siteId, job.job_id, new Date());
    const artifactSchemaVersion = renderMode === "inline-html" ? "2026.6" : "2026.5";
    try {
        await deps.s3.uploadPdfFromFile({
            bucket: deps.s3BucketPdf,
            key: s3Key,
            filePath: render.filePath,
            contentType: render.contentType,
            contentLength: render.sizeBytes,
            metadata: {
                schema_version: artifactSchemaVersion,
                job_id: job.job_id,
                req_id: reqId ?? "",
            },
        });
    }
    catch (err) {
        const details = extractErrorDetails(err);
        throw withErrorDetails(new errors_1.SoftError("ML_S3_UPLOAD_FAILED", extractNativeAwsMessage(err)), details);
    }
    finally {
        try {
            await promises_1.default.unlink(render.filePath);
        }
        catch {
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
    deps.logger.info("job.done", {
        job_id: job.job_id,
        queue_mode: deps.jobsRepo.mode,
        render_mode: renderMode,
        template: templateName ?? undefined,
        s3_key_ref: s3Key,
        artifact_size_bytes: render.sizeBytes,
    }, reqId);
}
async function failOrRetry(job, deps, err) {
    const reqId = resolveReqId(job);
    if (err instanceof errors_1.SoftError) {
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
            deps.logger.error("job.failed_hard", {
                job_id: job.job_id,
                queue_mode: deps.jobsRepo.mode,
                error_code: err.code,
                error_message: details.error_message,
                error_stack: details.error_stack,
                aws_code: details.aws_code,
            }, reqId);
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
        deps.logger.warning("job.requeued", {
            job_id: job.job_id,
            queue_mode: deps.jobsRepo.mode,
            error_code: err.code,
            delay_s: Math.floor(delay),
            attempt: job.attempts,
            max_attempts: job.max_attempts,
            error_message: details.error_message,
            error_stack: details.error_stack,
            aws_code: details.aws_code,
        }, reqId);
        return;
    }
    const hard = err instanceof errors_1.HardError ? err : new errors_1.HardError("ML_JOB_PROCESSING_FAILED", "Job processing failed");
    await deps.jobsRepo.markFailed({
        jobId: job.job_id,
        reqId,
        workerRef: deps.workerId,
        errorCode: hard.code,
        messageSafe: hard.messageSafe,
    });
    deps.logger.error("job.failed_hard", {
        job_id: job.job_id,
        queue_mode: deps.jobsRepo.mode,
        error_code: hard.code,
        error_message: hard.message,
        error_stack: hard.stack,
        aws_code: extractAwsCode(hard),
    }, reqId);
}
function assertRestJobSignature(job, deps) {
    const parsed = (0, mls1_1.parseMls1Token)(job.mls1_token);
    if (!parsed) {
        throw new errors_1.HardError("ML_JOB_BAD_MLS1", "Job signature format invalid");
    }
    const okSig = (0, mls1_1.verifyMls1Payload)(parsed.payloadBytes, parsed.sigHex, deps.hmacSecrets);
    if (!okSig) {
        throw new errors_1.HardError("ML_JOB_BAD_SIG", "Job signature invalid");
    }
    let payloadObj;
    try {
        payloadObj = JSON.parse(parsed.payloadBytes.toString("utf8"));
    }
    catch {
        throw new errors_1.HardError("ML_JOB_BAD_PAYLOAD", "Job payload is not valid JSON");
    }
    const schemaVersion = normalizeString(payloadObj.schema_version);
    if (schemaVersion !== "2026.5" && schemaVersion !== "2026.6") {
        throw new errors_1.HardError("ML_JOB_SCHEMA_MISMATCH", "Job schema_version mismatch");
    }
    if (payloadObj.site_id !== deps.siteId) {
        throw new errors_1.HardError("ML_JOB_SITE_MISMATCH", "Job site_id mismatch");
    }
    const payloadJob = asRecord(payloadObj.job);
    const payloadJobId = normalizeString(payloadJob.job_id);
    if (payloadJobId !== "" && payloadJobId !== job.job_id) {
        throw new errors_1.HardError("ML_JOB_ID_MISMATCH", "Job ID mismatch");
    }
}
function buildRestAggregate(job) {
    const payloadRoot = resolveRestPayloadRoot(job);
    const doctor = asRecord(payloadRoot.doctor);
    const patient = asRecord(payloadRoot.patient);
    const prescription = asRecord(payloadRoot.prescription);
    if (Object.keys(doctor).length < 1 || Object.keys(patient).length < 1 || Object.keys(prescription).length < 1) {
        throw new errors_1.HardError("ML_JOB_PAYLOAD_INCOMPLETE", "REST job payload missing doctor/patient/prescription blocks");
    }
    const now = new Date();
    const rootTsMs = toFiniteNumber(payloadRoot.ts_ms);
    const rootDate = Number.isFinite(rootTsMs) && rootTsMs > 0 ? new Date(rootTsMs) : fallbackDate(job.available_at, now);
    const prescriptionCreatedAt = fallbackDate(pickString(prescription, ["createdAt", "created_at"]), rootDate);
    const prescriptionUpdatedAt = fallbackDate(pickString(prescription, ["updatedAt", "updated_at"]), prescriptionCreatedAt);
    const doctorWpUserId = toInteger(pickUnknown(doctor, ["wpUserId", "wp_user_id"]), 0);
    return {
        doctor: {
            id: pickString(doctor, ["id"]) ?? (doctorWpUserId > 0 ? `wp:${doctorWpUserId}` : `rest:${job.job_id}:doctor`),
            wpUserId: doctorWpUserId,
            firstName: nullableHumanString(pickUnknown(doctor, ["firstName", "first_name"])),
            lastName: nullableHumanString(pickUnknown(doctor, ["lastName", "last_name"])),
            email: nullableString(pickUnknown(doctor, ["email"])),
            phone: nullableString(pickUnknown(doctor, ["phone", "telephone", "tel"])),
            title: nullableString(pickUnknown(doctor, ["title"])),
            specialty: nullableString(pickUnknown(doctor, ["specialty", "speciality"])),
            rpps: nullableString(pickUnknown(doctor, ["rpps"])),
            amNumber: nullableString(pickUnknown(doctor, ["amNumber", "am_number"])),
            address: nullableString(pickUnknown(doctor, ["address", "addressLine1", "address_line_1"])),
            city: nullableString(pickUnknown(doctor, ["city"])),
            zipCode: nullableString(pickUnknown(doctor, ["zipCode", "zip_code", "postalCode", "postal_code"])),
            signatureS3Key: nullableString(pickUnknown(doctor, ["signatureS3Key", "signature_s3_key"])),
            createdAt: fallbackDate(pickString(doctor, ["createdAt", "created_at"]), rootDate),
            updatedAt: fallbackDate(pickString(doctor, ["updatedAt", "updated_at"]), rootDate),
        },
        patient: {
            id: pickString(patient, ["id"]) ?? `rest:${job.job_id}:patient`,
            firstName: humanString(pickUnknown(patient, ["firstName", "first_name"])) || "Patient",
            lastName: humanString(pickUnknown(patient, ["lastName", "last_name"])),
            birthDate: pickString(patient, ["birthDate", "birthdate", "birth_date"]) ?? "",
            gender: nullableString(pickUnknown(patient, ["gender"])),
            email: nullableString(pickUnknown(patient, ["email"])),
            phone: nullableString(pickUnknown(patient, ["phone", "telephone", "tel"])),
            createdAt: fallbackDate(pickString(patient, ["createdAt", "created_at"]), rootDate),
            updatedAt: fallbackDate(pickString(patient, ["updatedAt", "updated_at"]), rootDate),
        },
        prescription: {
            id: pickString(prescription, ["id"]) ?? job.job_id,
            uid: pickString(prescription, ["uid", "wpPrescriptionUid", "wp_prescription_uid"]) ?? job.job_id,
            status: pickString(prescription, ["status", "wpStatus", "wp_status"]) ?? "PENDING",
            items: coerceItemsValue(pickUnknown(prescription, ["items", "medications", "lines"])),
            privateNotes: nullableString(pickUnknown(prescription, ["privateNotes", "private_notes"])),
            s3PdfKey: nullableString(pickUnknown(prescription, ["s3PdfKey", "s3_pdf_key"])),
            verifyCode: nullableString(pickUnknown(prescription, ["verifyCode", "verify_code"])),
            verifyToken: nullableString(pickUnknown(prescription, ["verifyToken", "verify_token"]))
                ?? nullableString(job.verify_token),
            processingStatus: pickString(prescription, ["processingStatus", "processing_status"]) ?? job.status,
            availableAt: fallbackDate(job.available_at, rootDate),
            claimedAt: nullableDate(job.locked_at),
            lockExpiresAt: nullableDate(job.lock_expires_at),
            workerRef: nullableString(job.worker_ref ?? job.locked_by),
            attempts: toInteger(job.attempts, 0),
            maxAttempts: toInteger(job.max_attempts, 5),
            lastErrorCode: nullableString(pickUnknown(prescription, ["lastErrorCode", "last_error_code"])),
            lastErrorMessageSafe: nullableString(pickUnknown(prescription, ["lastErrorMessageSafe", "last_error_message_safe"])),
            sourceReqId: pickString(payloadRoot, ["req_id", "reqId"]) ?? job.source_req_id ?? job.req_id,
            createdAt: prescriptionCreatedAt,
            updatedAt: prescriptionUpdatedAt,
        },
    };
}
function resolveRestPayloadRoot(job) {
    const direct = toRecordMaybe(job.payload);
    const directNestedPayload = direct ? toRecordMaybe(direct["payload"]) : null;
    if (hasRenderableBlocks(direct)) {
        return direct;
    }
    if (hasRenderableBlocks(directNestedPayload)) {
        return directNestedPayload;
    }
    const parsedPayloadJson = parseUnknownJson(job.payload_json);
    const parsedRecord = toRecordMaybe(parsedPayloadJson);
    const parsedNestedPayload = parsedRecord ? toRecordMaybe(parsedRecord["payload"]) : null;
    if (hasRenderableBlocks(parsedRecord)) {
        return parsedRecord;
    }
    if (hasRenderableBlocks(parsedNestedPayload)) {
        return parsedNestedPayload;
    }
    throw new errors_1.HardError("ML_JOB_PAYLOAD_INCOMPLETE", "REST job payload missing doctor/patient/prescription blocks");
}
function hasRenderableBlocks(value) {
    if (!value) {
        return false;
    }
    const doctor = asRecord(value.doctor);
    const patient = asRecord(value.patient);
    const prescription = asRecord(value.prescription);
    return Object.keys(doctor).length > 0 && Object.keys(patient).length > 0 && Object.keys(prescription).length > 0;
}
function resolveRestTemplateVariant(job) {
    const root = resolveRestPayloadRoot(job);
    const prescription = asRecord(root.prescription);
    return pickString(root, ["templateVariant", "template_variant", "template"])
        ?? pickString(prescription, ["templateVariant", "template_variant", "template"])
        ?? undefined;
}
function resolveReqId(job) {
    return job.req_id ?? job.source_req_id ?? undefined;
}
function buildPdfS3Key(siteId, jobId, now) {
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
    return `unit/${siteId}/rx-pdf/${yyyy}/${mm}/${jobId}.pdf`;
}
function extractNativeAwsMessage(err) {
    if (err && typeof err === "object") {
        const rec = err;
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
function withErrorDetails(err, details) {
    Object.assign(err, details);
    return err;
}
function extractErrorDetails(err) {
    const error = err;
    return {
        error_message: err instanceof Error ? err.message : String(err),
        error_stack: err instanceof Error ? err.stack : undefined,
        aws_code: extractAwsCode(error),
    };
}
function extractAwsCode(err) {
    if (!err || typeof err !== "object")
        return undefined;
    const rec = err;
    const awsCode = rec.Code ?? rec.code ?? rec.name;
    return typeof awsCode === "string" && awsCode !== "" ? awsCode : undefined;
}
function countPrescriptionItems(value) {
    return Array.isArray(value) ? value.length : 0;
}
function coerceItemsValue(value) {
    if (Array.isArray(value)) {
        return value;
    }
    if (typeof value === "string") {
        const parsed = parseUnknownJson(value);
        if (Array.isArray(parsed)) {
            return parsed;
        }
    }
    return [];
}
function pickUnknown(record, keys) {
    for (const key of keys) {
        if (key in record) {
            return record[key];
        }
    }
    return undefined;
}
function pickString(record, keys) {
    const value = pickUnknown(record, keys);
    return nullableString(value);
}
function normalizeString(value) {
    if (typeof value === "string") {
        return value.trim();
    }
    if (typeof value === "number" || typeof value === "boolean") {
        return String(value).trim();
    }
    return "";
}
function nullableString(value) {
    const text = normalizeString(value);
    return text !== "" ? text : null;
}
function humanString(value) {
    const text = normalizeString(value);
    return text !== "" && !isEmailLike(text) ? text : "";
}
function nullableHumanString(value) {
    const text = humanString(value);
    return text !== "" ? text : null;
}
function isEmailLike(value) {
    const text = normalizeString(value);
    return text !== "" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
}
function toFiniteNumber(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return Number.NaN;
}
function toInteger(value, fallback) {
    const n = toFiniteNumber(value);
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
}
function fallbackDate(value, fallback) {
    const date = nullableDate(value);
    return date ?? fallback;
}
function nullableDate(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : date;
    }
    if (typeof value === "string" && value.trim() !== "") {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : date;
    }
    return null;
}
function toRecordMaybe(value) {
    const parsed = typeof value === "string" ? parseUnknownJson(value) : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : null;
}
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}
function parseUnknownJson(value) {
    if (typeof value !== "string" || value.trim() === "") {
        return null;
    }
    try {
        return JSON.parse(value);
    }
    catch {
        return null;
    }
}
