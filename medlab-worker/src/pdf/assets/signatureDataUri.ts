// src/pdf/assets/signatureDataUri.ts
import { GetObjectCommand, S3Client, S3ClientConfig } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import crypto from "node:crypto";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import path from "node:path";
import { Readable } from "node:stream";
import { URL } from "node:url";
import { buildMls1Token } from "../../security/mls1";

export interface SignatureDataUriLoaderConfig {
  endpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  bucket: string;
  requestTimeoutMs?: number;
  maxBytes?: number;
  wpBaseUrl?: string;
  wpHmacSecret?: string;
}

type WordPressBridgeRef =
  | { kind: "file"; value: number }
  | { kind: "media"; value: number }
  | { kind: "storage"; value: string };

interface BufferedHttpResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export class SignatureDataUriLoader {
  private readonly client: S3Client;
  private readonly defaultBucket: string;
  private readonly maxBytes: number;
  private readonly requestTimeoutMs: number;
  private readonly wpBaseUrl: string;
  private readonly wpHmacSecret: string;

  constructor(cfg: SignatureDataUriLoaderConfig) {
    const timeoutMs = clampInt(cfg.requestTimeoutMs, 5_000, 60_000, 15_000);
    const s3Config: S3ClientConfig = {
      region: cfg.region,
      credentials: {
        accessKeyId: cfg.accessKeyId.replace(/[\s\u200B-\u200D\uFEFF]/g, ""),
        secretAccessKey: cfg.secretAccessKey.replace(/[\s\u200B-\u200D\uFEFF]/g, ""),
      },
      forcePathStyle: cfg.forcePathStyle,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: timeoutMs,
        socketTimeout: timeoutMs,
      }),
    };

    if (cfg.endpoint) {
      s3Config.endpoint = cfg.endpoint;
    }

    this.client = new S3Client(s3Config);
    this.defaultBucket = String(cfg.bucket ?? "").trim();
    this.maxBytes = clampInt(cfg.maxBytes, 32 * 1024, 10 * 1024 * 1024, 2 * 1024 * 1024);
    this.requestTimeoutMs = timeoutMs;
    this.wpBaseUrl = normalizeBaseUrl(cfg.wpBaseUrl);
    this.wpHmacSecret = String(cfg.wpHmacSecret ?? "").trim();
  }

  async loadFromKey(rawKey?: string | null): Promise<string> {
    const wpRef = parseWordPressBridgeRef(rawKey);
    if (wpRef) {
      return this.loadFromWordPressBridgeRef(wpRef);
    }

    const target = normalizeBucketAndKey(rawKey, this.defaultBucket);
    if (!target) {
      return "";
    }

    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: target.bucket,
          Key: target.key,
        }),
      );

      const bytes = await bodyToBuffer(response.Body, this.maxBytes);
      if (bytes.length < 1) {
        throw new Error("ML_SIGNATURE_EMPTY_BODY");
      }

      const contentType = normalizeImageContentType(
        typeof response.ContentType === "string" ? response.ContentType : "",
        target.key,
      );
      if (contentType === "") {
        throw new Error("ML_SIGNATURE_UNSUPPORTED_CONTENT_TYPE");
      }

      return buildDataUri(contentType, bytes);
    } catch (err) {
      if (this.canUseWordPressBridge()) {
        try {
          return await this.loadFromWordPressStorageKey(target.key);
        } catch (wpErr) {
          throw combineLoadErrors(err, wpErr, target.key);
        }
      }

      throw toError(err, "ML_SIGNATURE_S3_READ_FAILED");
    }
  }

  async close(): Promise<void> {
    this.client.destroy();
  }

  private canUseWordPressBridge(): boolean {
    return this.wpBaseUrl !== "" && this.wpHmacSecret !== "";
  }

  private async loadFromWordPressBridgeRef(ref: WordPressBridgeRef): Promise<string> {
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

  private async loadFromWordPressStorageKey(storageKey: string): Promise<string> {
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

  private async fetchWordPressDataUri(restPath: string): Promise<string> {
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

  private buildCanonicalGetToken(canonicalPath: string): string {
    const tsMs = Date.now();
    const nonce = crypto.randomBytes(12).toString("hex");
    const payload = Buffer.from(`GET|${canonicalPath}|${tsMs}|${nonce}`, "utf8");
    return buildMls1Token(payload, this.wpHmacSecret);
  }
}

async function bodyToBuffer(body: unknown, maxBytes: number): Promise<Buffer> {
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

  const withTransform = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof withTransform.transformToByteArray === "function") {
    const bytes = await withTransform.transformToByteArray();
    ensureMaxBytes(bytes.byteLength, maxBytes);
    return Buffer.from(bytes);
  }

  if (body instanceof Readable) {
    const chunks: Buffer[] = [];
    let total = 0;

    for await (const chunk of body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += buf.byteLength;
      ensureMaxBytes(total, maxBytes);
      chunks.push(buf);
    }

    return Buffer.concat(chunks);
  }

  return Buffer.alloc(0);
}

function parseWordPressBridgeRef(raw: string | null | undefined): WordPressBridgeRef | null {
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

function normalizeBucketAndKey(raw: string | null | undefined, defaultBucket: string): { bucket: string; key: string } | null {
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

function normalizeImageContentType(contentType: string, key: string): string {
  const raw = contentType.trim().toLowerCase();
  const normalized = raw.split(";")[0]?.trim() ?? "";

  if (isAllowedImageContentType(normalized)) {
    return normalized;
  }

  switch (path.extname(key).toLowerCase()) {
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

function isAllowedImageContentType(value: string): boolean {
  return value === "image/png"
    || value === "image/jpeg"
    || value === "image/webp"
    || value === "image/gif"
    || value === "image/svg+xml";
}

function ensureMaxBytes(size: number, maxBytes: number): void {
  if (size > maxBytes) {
    throw new Error("ML_SIGNATURE_TOO_LARGE");
  }
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  const safe = Math.trunc(Number(value));
  return Math.max(min, Math.min(max, safe));
}

function normalizeBaseUrl(value: string | undefined): string {
  const raw = String(value ?? "").trim();
  return raw === "" ? "" : raw.replace(/\/+$/, "");
}

function normalizeCanonicalRestPath(value: string): string {
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

function buildWordPressRestUrl(baseUrl: string, canonicalPath: string): URL {
  if (baseUrl === "") {
    throw new Error("ML_SIGNATURE_WP_BASE_URL_MISSING");
  }

  return new URL(`/wp-json${canonicalPath}`, `${baseUrl}/`);
}

function readHeaderValue(headers: IncomingHttpHeaders, name: string): string {
  const raw = headers[name.toLowerCase()];
  if (Array.isArray(raw)) {
    return raw[0] ? String(raw[0]).trim() : "";
  }

  return raw ? String(raw).trim() : "";
}

function buildDataUri(contentType: string, bytes: Buffer): string {
  return `data:${contentType};base64,${bytes.toString("base64")}`;
}

function toError(err: unknown, fallbackCode: string): Error {
  if (err instanceof Error) {
    return err;
  }

  return new Error(fallbackCode);
}

function combineLoadErrors(primary: unknown, secondary: unknown, key: string): Error {
  const primaryError = toError(primary, "ML_SIGNATURE_S3_READ_FAILED");
  const secondaryError = toError(secondary, "ML_SIGNATURE_WP_READ_FAILED");
  const keyTail = key.length <= 32 ? key : key.slice(-32);
  return new Error(`${primaryError.message}; fallback=${secondaryError.message}; key_tail=${keyTail}`);
}

function base64UrlEncode(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function bufferedGet(
  url: URL,
  headers: Record<string, string>,
  timeoutMs: number,
  maxBytes: number,
): Promise<BufferedHttpResponse> {
  return new Promise((resolve, reject) => {
    const requester = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = requester(
      url,
      {
        method: "GET",
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;

        res.on("data", (chunk: Buffer | string) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buf.byteLength;
          try {
            ensureMaxBytes(total, maxBytes);
          } catch (err) {
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
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("ML_SIGNATURE_WP_TIMEOUT"));
    });

    req.on("error", (err) => {
      reject(toError(err, "ML_SIGNATURE_WP_REQUEST_FAILED"));
    });

    req.end();
  });
}
