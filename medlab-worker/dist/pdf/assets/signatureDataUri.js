"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SignatureDataUriLoader = void 0;
// src/pdf/assets/signatureDataUri.ts
const client_s3_1 = require("@aws-sdk/client-s3");
const node_http_handler_1 = require("@smithy/node-http-handler");
const node_path_1 = __importDefault(require("node:path"));
const node_stream_1 = require("node:stream");
class SignatureDataUriLoader {
    client;
    defaultBucket;
    maxBytes;
    constructor(cfg) {
        const s3Config = {
            region: cfg.region,
            credentials: {
                accessKeyId: cfg.accessKeyId.replace(/[\s\u200B-\u200D\uFEFF]/g, ""),
                secretAccessKey: cfg.secretAccessKey.replace(/[\s\u200B-\u200D\uFEFF]/g, ""),
            },
            forcePathStyle: cfg.forcePathStyle,
            requestHandler: new node_http_handler_1.NodeHttpHandler({
                connectionTimeout: cfg.requestTimeoutMs ?? 15_000,
                socketTimeout: cfg.requestTimeoutMs ?? 15_000,
            }),
        };
        if (cfg.endpoint) {
            s3Config.endpoint = cfg.endpoint;
        }
        this.client = new client_s3_1.S3Client(s3Config);
        this.defaultBucket = String(cfg.bucket ?? "").trim();
        this.maxBytes = clampInt(cfg.maxBytes, 32 * 1024, 10 * 1024 * 1024, 2 * 1024 * 1024);
    }
    async loadFromKey(rawKey) {
        const target = normalizeBucketAndKey(rawKey, this.defaultBucket);
        if (!target) {
            return "";
        }
        try {
            const response = await this.client.send(new client_s3_1.GetObjectCommand({
                Bucket: target.bucket,
                Key: target.key,
            }));
            const bytes = await bodyToBuffer(response.Body, this.maxBytes);
            if (bytes.length < 1) {
                return "";
            }
            const contentType = normalizeImageContentType(typeof response.ContentType === "string" ? response.ContentType : "", target.key);
            if (contentType === "") {
                return "";
            }
            return `data:${contentType};base64,${bytes.toString("base64")}`;
        }
        catch (_err) {
            return "";
        }
    }
    async close() {
        this.client.destroy();
    }
}
exports.SignatureDataUriLoader = SignatureDataUriLoader;
async function bodyToBuffer(body, maxBytes) {
    if (!body) {
        return Buffer.alloc(0);
    }
    if (Buffer.isBuffer(body)) {
        ensureMaxBytes(body.byteLength, maxBytes);
        return body;
    }
    if (typeof body === "string") {
        const buf = Buffer.from(body);
        ensureMaxBytes(buf.byteLength, maxBytes);
        return buf;
    }
    const withTransform = body;
    if (typeof withTransform.transformToByteArray === "function") {
        const bytes = await withTransform.transformToByteArray();
        ensureMaxBytes(bytes.byteLength, maxBytes);
        return Buffer.from(bytes);
    }
    if (body instanceof node_stream_1.Readable) {
        const chunks = [];
        let total = 0;
        for await (const chunk of body) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            total += buf.byteLength;
            ensureMaxBytes(total, maxBytes);
            chunks.push(buf);
        }
        return Buffer.concat(chunks);
    }
    return Buffer.alloc(0);
}
function normalizeBucketAndKey(raw, defaultBucket) {
    const value = String(raw ?? "").trim();
    if (value === "") {
        return null;
    }
    if (value.startsWith("s3://")) {
        const withoutScheme = value.slice(5);
        const slash = withoutScheme.indexOf("/");
        if (slash <= 0) {
            return null;
        }
        const bucket = withoutScheme.slice(0, slash).trim();
        const key = withoutScheme.slice(slash + 1).replace(/^\/+/, "").trim();
        if (bucket === "" || key === "") {
            return null;
        }
        return { bucket, key };
    }
    const bucket = defaultBucket.trim();
    const key = value.replace(/^\/+/, "");
    if (bucket === "" || key === "") {
        return null;
    }
    return { bucket, key };
}
function normalizeImageContentType(contentType, key) {
    const raw = contentType.trim().toLowerCase();
    const normalized = raw.split(";")[0]?.trim() ?? "";
    if (isAllowedImageContentType(normalized)) {
        return normalized;
    }
    switch (node_path_1.default.extname(key).toLowerCase()) {
        case ".png":
            return "image/png";
        case ".jpg":
        case ".jpeg":
            return "image/jpeg";
        case ".webp":
            return "image/webp";
        case ".gif":
            return "image/gif";
        case ".svg":
            return "image/svg+xml";
        default:
            return "";
    }
}
function isAllowedImageContentType(value) {
    return value === "image/png"
        || value === "image/jpeg"
        || value === "image/webp"
        || value === "image/gif"
        || value === "image/svg+xml";
}
function ensureMaxBytes(size, maxBytes) {
    if (size > maxBytes) {
        throw new Error("ML_SIGNATURE_TOO_LARGE");
    }
}
function clampInt(value, min, max, fallback) {
    if (!Number.isFinite(value)) {
        return fallback;
    }
    const safe = Math.trunc(Number(value));
    return Math.max(min, Math.min(max, safe));
}
