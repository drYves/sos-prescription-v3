// src/pdf/assets/signatureDataUri.ts
import { GetObjectCommand, S3Client, S3ClientConfig } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import path from "node:path";
import { Readable } from "node:stream";

export interface SignatureDataUriLoaderConfig {
  endpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  bucket: string;
  requestTimeoutMs?: number;
  maxBytes?: number;
}

export class SignatureDataUriLoader {
  private readonly client: S3Client;
  private readonly defaultBucket: string;
  private readonly maxBytes: number;

  constructor(cfg: SignatureDataUriLoaderConfig) {
    const s3Config: S3ClientConfig = {
      region: cfg.region,
      credentials: {
        accessKeyId: cfg.accessKeyId.replace(/[\s\u200B-\u200D\uFEFF]/g, ""),
        secretAccessKey: cfg.secretAccessKey.replace(/[\s\u200B-\u200D\uFEFF]/g, ""),
      },
      forcePathStyle: cfg.forcePathStyle,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: cfg.requestTimeoutMs ?? 15_000,
        socketTimeout: cfg.requestTimeoutMs ?? 15_000,
      }),
    };

    if (cfg.endpoint) {
      s3Config.endpoint = cfg.endpoint;
    }

    this.client = new S3Client(s3Config);
    this.defaultBucket = String(cfg.bucket ?? "").trim();
    this.maxBytes = clampInt(cfg.maxBytes, 32 * 1024, 10 * 1024 * 1024, 2 * 1024 * 1024);
  }

  async loadFromKey(rawKey?: string | null): Promise<string> {
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
        return "";
      }

      const contentType = normalizeImageContentType(
        typeof response.ContentType === "string" ? response.ContentType : "",
        target.key,
      );
      if (contentType === "") {
        return "";
      }

      return `data:${contentType};base64,${bytes.toString("base64")}`;
    } catch (_err) {
      return "";
    }
  }

  async close(): Promise<void> {
    this.client.destroy();
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
