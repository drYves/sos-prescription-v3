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
const promises_1 = __importDefault(require("node:fs/promises"));
const s3Utils_1 = require("./s3Utils");
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
                socketTimeout: 30_000,
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
        const bodyBuffer = await promises_1.default.readFile(input.filePath);
        if (input.contentLength > 0 && bodyBuffer.byteLength !== input.contentLength) {
            const err = new Error(`File size mismatch: expected ${input.contentLength} bytes, got ${bodyBuffer.byteLength}`);
            err.name = "S3UploadInputMismatch";
            throw err;
        }
        const metadata = (0, s3Utils_1.normalizeMetadata)(input.metadata);
        const params = {
            Bucket: input.bucket,
            Key: input.key,
            Body: bodyBuffer,
            ContentType: input.contentType,
            ContentLength: bodyBuffer.byteLength,
        };
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
        await upload.done();
    }
    async close() {
        this.client.destroy();
    }
    normalizedSse() {
        return this.sse !== "" ? this.sse : undefined;
    }
}
exports.S3Service = S3Service;
