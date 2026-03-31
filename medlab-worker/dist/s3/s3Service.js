"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.S3Service = void 0;
// src/s3/s3Service.ts
const client_s3_1 = require("@aws-sdk/client-s3");
const lib_storage_1 = require("@aws-sdk/lib-storage");
const node_http_handler_1 = require("@smithy/node-http-handler");
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const promises_1 = __importDefault(require("node:fs/promises"));
const node_stream_1 = require("node:stream");
const s3Utils_1 = require("./s3Utils");
class HashingPassThrough extends node_stream_1.Transform {
    hash = (0, node_crypto_1.createHash)("sha256");
    finalized = false;
    sizeBytes = 0;
    _transform(chunk, _enc, callback) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        this.sizeBytes += buf.length;
        this.hash.update(buf);
        callback(null, buf);
    }
    digestHex() {
        if (this.finalized) {
            throw new Error("Hash has already been finalized");
        }
        this.finalized = true;
        return this.hash.digest("hex");
    }
}
class S3Service {
    client;
    sse;
    constructor(cfg) {
        const cleanAccessKey = cfg.accessKeyId.replace(/[\s\u200B-\u200D\uFEFF]/g, "");
        const cleanSecretKey = cfg.secretAccessKey.replace(/[\s\u200B-\u200D\uFEFF]/g, "");
        const s3Cfg = {
            region: cfg.region,
            credentials: {
                accessKeyId: cleanAccessKey,
                secretAccessKey: cleanSecretKey,
            },
            forcePathStyle: cfg.forcePathStyle,
            requestHandler: new node_http_handler_1.NodeHttpHandler({
                connectionTimeout: 30_000,
                socketTimeout: 60_000,
            }),
            requestChecksumCalculation: "WHEN_REQUIRED",
            responseChecksumValidation: "WHEN_REQUIRED",
        };
        if (cfg.endpoint) {
            s3Cfg.endpoint = cfg.endpoint;
        }
        this.client = new client_s3_1.S3Client(s3Cfg);
        this.sse = String(cfg.sse ?? "").trim();
    }
    async uploadPdfFromFile(input) {
        const stat = await promises_1.default.stat(input.filePath);
        if (input.contentLength > 0 && stat.size !== input.contentLength) {
            const err = new Error(`File size mismatch: expected ${input.contentLength} bytes, got ${stat.size}`);
            err.name = "S3UploadInputMismatch";
            throw err;
        }
        const fileStream = (0, node_fs_1.createReadStream)(input.filePath);
        try {
            await this.uploadDirect({
                bucket: input.bucket,
                key: input.key,
                body: fileStream,
                contentType: input.contentType,
                contentLength: stat.size,
                metadata: input.metadata,
            });
        }
        finally {
            closeReadableQuietly(fileStream);
        }
    }
    async uploadDirect(input) {
        const metadata = (0, s3Utils_1.normalizeMetadata)(input.metadata);
        const hashing = new HashingPassThrough();
        const params = {
            Bucket: input.bucket,
            Key: input.key,
            Body: hashing,
            ContentType: input.contentType,
        };
        if (Number.isFinite(input.contentLength) && (input.contentLength ?? 0) > 0) {
            params.ContentLength = Math.floor(input.contentLength);
        }
        if (Object.keys(metadata).length > 0) {
            params.Metadata = metadata;
        }
        const sse = this.normalizedSse();
        if (sse) {
            params.ServerSideEncryption = sse;
        }
        const upload = new lib_storage_1.Upload({
            client: this.client,
            params,
            queueSize: 1,
            leavePartsOnError: false,
        });
        const forwardBodyError = (error) => {
            hashing.destroy(error);
        };
        input.body.on("error", forwardBodyError);
        input.body.pipe(hashing);
        try {
            await upload.done();
            const sizeBytes = hashing.sizeBytes;
            const sha256Hex = hashing.digestHex();
            if (params.ContentLength != null && sizeBytes !== params.ContentLength) {
                const err = new Error(`Stream size mismatch: expected ${params.ContentLength} bytes, got ${sizeBytes}`);
                err.name = "S3UploadInputMismatch";
                throw err;
            }
            return { sizeBytes, sha256Hex };
        }
        catch (err) {
            const error = err instanceof Error ? err : new Error("S3 stream upload failed");
            closeReadableQuietly(input.body, error);
            hashing.destroy(error);
            throw error;
        }
        finally {
            input.body.off("error", forwardBodyError);
        }
    }
    async uploadStream(input) {
        return this.uploadDirect(input);
    }
    async downloadBuffer(input) {
        const bucket = normalizeRequiredString(input.bucket, "bucket");
        const key = normalizeRequiredString(input.key, "key");
        const maxBytes = Math.max(1, Math.floor(input.maxBytes ?? 16 * 1024 * 1024));
        const response = await this.client.send(new client_s3_1.GetObjectCommand({
            Bucket: bucket,
            Key: key,
        }));
        if (!response.Body) {
            throw new Error("S3 object body is empty");
        }
        const body = response.Body;
        try {
            return await readableToBuffer(body, maxBytes);
        }
        catch (err) {
            closeReadableQuietly(body, err instanceof Error ? err : undefined);
            throw err;
        }
    }
    async getObjectBuffer(input) {
        return this.downloadBuffer(input);
    }
    async close() {
        this.client.destroy();
    }
    normalizedSse() {
        return this.sse !== "" ? this.sse : undefined;
    }
}
exports.S3Service = S3Service;
async function readableToBuffer(stream, maxBytes) {
    const chunks = [];
    let total = 0;
    for await (const chunk of stream) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.length;
        if (total > maxBytes) {
            throw new Error(`S3 object exceeds maxBytes (${maxBytes})`);
        }
        chunks.push(buf);
    }
    return Buffer.concat(chunks);
}
function normalizeRequiredString(value, field) {
    if (typeof value !== "string" || value.trim() === "") {
        throw new Error(`${field} is required`);
    }
    return value.trim();
}
function closeReadableQuietly(stream, error) {
    try {
        stream.destroy(error);
    }
    catch {
        // noop
    }
}
