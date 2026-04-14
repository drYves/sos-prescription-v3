"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SignatureDataUriLoader = void 0;
// src/pdf/assets/signatureDataUri.ts
const client_s3_1 = require("@aws-sdk/client-s3");
const node_http_handler_1 = require("@smithy/node-http-handler");
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_http_1 = require("node:http");
const node_https_1 = require("node:https");
const node_path_1 = __importDefault(require("node:path"));
const node_stream_1 = require("node:stream");
const node_url_1 = require("node:url");
const mls1_1 = require("../../security/mls1");
class SignatureDataUriLoader {
    client;
    defaultBucket;
    maxBytes;
    requestTimeoutMs;
    wpBaseUrl;
    wpHmacSecret;
    constructor(cfg) {
        const timeoutMs = clampInt(cfg.requestTimeoutMs, 5_000, 60_000, 15_000);
        const s3Config = {
            region: cfg.region,
            credentials: {
                accessKeyId: cfg.accessKeyId.replace(/[\s\u200B-\u200D\uFEFF]/g, ""),
                secretAccessKey: cfg.secretAccessKey.replace(/[\s\u200B-\u200D\uFEFF]/g, ""),
            },
            forcePathStyle: cfg.forcePathStyle,
            requestHandler: new node_http_handler_1.NodeHttpHandler({
                connectionTimeout: timeoutMs,
                socketTimeout: timeoutMs,
            }),
        };
        if (cfg.endpoint) {
            s3Config.endpoint = cfg.endpoint;
        }
        this.client = new client_s3_1.S3Client(s3Config);
        this.defaultBucket = String(cfg.bucket ?? "").trim();
        this.maxBytes = clampInt(cfg.maxBytes, 32 * 1024, 10 * 1024 * 1024, 2 * 1024 * 1024);
        this.requestTimeoutMs = timeoutMs;
        this.wpBaseUrl = normalizeBaseUrl(cfg.wpBaseUrl);
        this.wpHmacSecret = String(cfg.wpHmacSecret ?? "").trim();
    }
    async loadFromKey(rawKey) {
        const wpRef = parseWordPressBridgeRef(rawKey);
        if (wpRef) {
            return this.loadFromWordPressBridgeRef(wpRef);
        }
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
                throw new Error("ML_SIGNATURE_EMPTY_BODY");
            }
            const contentType = normalizeImageContentType(typeof response.ContentType === "string" ? response.ContentType : "", target.key);
            if (contentType === "") {
                throw new Error("ML_SIGNATURE_UNSUPPORTED_CONTENT_TYPE");
            }
            return buildDataUri(contentType, bytes);
        }
        catch (err) {
            if (this.canUseWordPressBridge()) {
                try {
                    return await this.loadFromWordPressStorageKey(target.key);
                }
                catch (wpErr) {
                    throw combineLoadErrors(err, wpErr, target.key);
                }
            }
            throw toError(err, "ML_SIGNATURE_S3_READ_FAILED");
        }
    }
    async close() {
        this.client.destroy();
    }
    canUseWordPressBridge() {
        return this.wpBaseUrl !== "" && this.wpHmacSecret !== "";
    }
    async loadFromWordPressBridgeRef(ref) {
        if (!this.canUseWordPressBridge()) {
            throw new Error("ML_SIGNATURE_WP_BRIDGE_DISABLED");
        }
        if (ref.kind === "file") {
            return this.fetchWordPressDataUri(`/sosprescription/v3/worker/signatures/file/${ref.value}`);
        }
        if (ref.kind === "media") {
            return this.fetchWordPressDataUri(`/sosprescription/v3/worker/signatures/media/${ref.value}`);
        }
        return this.fetchWordPressDataUri(`/sosprescription/v3/worker/signatures/storage/${ref.value}`);
    }
    async loadFromWordPressStorageKey(storageKey) {
        if (!this.canUseWordPressBridge()) {
            throw new Error("ML_SIGNATURE_WP_BRIDGE_DISABLED");
        }
        const normalizedKey = String(storageKey ?? "").replace(/^\/+/, "").trim();
        if (normalizedKey === "") {
            throw new Error("ML_SIGNATURE_WP_STORAGE_KEY_MISSING");
        }
        const encoded = base64UrlEncode(Buffer.from(normalizedKey, "utf8"));
        return this.fetchWordPressDataUri(`/sosprescription/v3/worker/signatures/storage/${encoded}`);
    }
    async fetchWordPressDataUri(restPath) {
        const canonicalPath = normalizeCanonicalRestPath(restPath);
        const url = buildWordPressRestUrl(this.wpBaseUrl, canonicalPath);
        const headers = {
            Accept: "image/*,*/*;q=0.8",
            "X-MedLab-Signature": this.buildCanonicalGetToken(canonicalPath),
            "Cache-Control": "no-cache, no-store, must-revalidate",
            Pragma: "no-cache",
        };
        const response = await bufferedGet(url, headers, this.requestTimeoutMs, this.maxBytes);
        if (response.statusCode !== 200) {
            throw new Error(`ML_SIGNATURE_WP_HTTP_${response.statusCode}`);
        }
        if (response.body.length < 1) {
            throw new Error("ML_SIGNATURE_WP_EMPTY_BODY");
        }
        const headerContentType = readHeaderValue(response.headers, "content-type");
        const contentType = normalizeImageContentType(headerContentType, url.pathname);
        if (contentType === "") {
            throw new Error("ML_SIGNATURE_WP_UNSUPPORTED_CONTENT_TYPE");
        }
        return buildDataUri(contentType, response.body);
    }
    buildCanonicalGetToken(canonicalPath) {
        const tsMs = Date.now();
        const nonce = node_crypto_1.default.randomBytes(12).toString("hex");
        const payload = Buffer.from(`GET|${canonicalPath}|${tsMs}|${nonce}`, "utf8");
        return (0, mls1_1.buildMls1Token)(payload, this.wpHmacSecret);
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
function parseWordPressBridgeRef(raw) {
    const value = String(raw ?? "").trim();
    if (value === "") {
        return null;
    }
    const fileMatch = value.match(/^wpfile:(\d+)$/i);
    if (fileMatch) {
        return { kind: "file", value: Math.trunc(Number(fileMatch[1])) };
    }
    const mediaMatch = value.match(/^wpmedia:(\d+)$/i);
    if (mediaMatch) {
        return { kind: "media", value: Math.trunc(Number(mediaMatch[1])) };
    }
    const storageMatch = value.match(/^wpstorage:([A-Za-z0-9_-]+)$/i);
    if (storageMatch) {
        return { kind: "storage", value: storageMatch[1] };
    }
    return null;
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
function normalizeBaseUrl(value) {
    const raw = String(value ?? "").trim();
    return raw === "" ? "" : raw.replace(/\/+$/, "");
}
function normalizeCanonicalRestPath(value) {
    const raw = String(value ?? "").trim();
    if (raw === "") {
        throw new Error("ML_SIGNATURE_WP_PATH_MISSING");
    }
    const normalized = raw.startsWith("/") ? raw : `/${raw}`;
    if (!normalized.startsWith("/sosprescription/")) {
        throw new Error("ML_SIGNATURE_WP_PATH_INVALID");
    }
    return normalized;
}
function buildWordPressRestUrl(baseUrl, canonicalPath) {
    if (baseUrl === "") {
        throw new Error("ML_SIGNATURE_WP_BASE_URL_MISSING");
    }
    return new node_url_1.URL(`/wp-json${canonicalPath}`, `${baseUrl}/`);
}
function readHeaderValue(headers, name) {
    const raw = headers[name.toLowerCase()];
    if (Array.isArray(raw)) {
        return raw[0] ? String(raw[0]).trim() : "";
    }
    return raw ? String(raw).trim() : "";
}
function buildDataUri(contentType, bytes) {
    return `data:${contentType};base64,${bytes.toString("base64")}`;
}
function toError(err, fallbackCode) {
    if (err instanceof Error) {
        return err;
    }
    return new Error(fallbackCode);
}
function combineLoadErrors(primary, secondary, key) {
    const primaryError = toError(primary, "ML_SIGNATURE_S3_READ_FAILED");
    const secondaryError = toError(secondary, "ML_SIGNATURE_WP_READ_FAILED");
    const keyTail = key.length <= 32 ? key : key.slice(-32);
    return new Error(`${primaryError.message}; fallback=${secondaryError.message}; key_tail=${keyTail}`);
}
function base64UrlEncode(bytes) {
    return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function bufferedGet(url, headers, timeoutMs, maxBytes) {
    return new Promise((resolve, reject) => {
        const requester = url.protocol === "https:" ? node_https_1.request : node_http_1.request;
        const req = requester(url, {
            method: "GET",
            headers,
        }, (res) => {
            const chunks = [];
            let total = 0;
            res.on("data", (chunk) => {
                const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                total += buf.byteLength;
                try {
                    ensureMaxBytes(total, maxBytes);
                }
                catch (err) {
                    req.destroy(toError(err, "ML_SIGNATURE_WP_TOO_LARGE"));
                    return;
                }
                chunks.push(buf);
            });
            res.on("end", () => {
                resolve({
                    statusCode: typeof res.statusCode === "number" ? res.statusCode : 0,
                    headers: res.headers,
                    body: Buffer.concat(chunks),
                });
            });
        });
        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error("ML_SIGNATURE_WP_TIMEOUT"));
        });
        req.on("error", (err) => {
            reject(toError(err, "ML_SIGNATURE_WP_REQUEST_FAILED"));
        });
        req.end();
    });
}
