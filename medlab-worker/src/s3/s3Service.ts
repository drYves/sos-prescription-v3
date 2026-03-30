// src/s3/s3Service.ts
import { PutObjectCommandInput, S3Client, S3ClientConfig } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { createHash } from "node:crypto";
import { createReadStream, ReadStream } from "node:fs";
import fsp from "node:fs/promises";
import { Readable, Transform, TransformCallback } from "node:stream";
import { normalizeMetadata } from "./s3Utils";

export interface S3ServiceConfig {
  endpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sse: string;
  forcePathStyle: boolean;
}

export interface UploadPdfFileInput {
  bucket: string;
  key: string;
  filePath: string;
  contentType: "application/pdf";
  contentLength: number;
  metadata?: Record<string, string>;
}

export interface UploadStreamInput {
  bucket: string;
  key: string;
  body: Readable;
  contentType: string;
  contentLength?: number;
  metadata?: Record<string, string>;
}

export interface UploadStreamResult {
  sizeBytes: number;
  sha256Hex: string;
}

type S3ClientConfigWithChecksum = S3ClientConfig & {
  requestChecksumCalculation?: "WHEN_REQUIRED" | "ALWAYS";
  responseChecksumValidation?: "WHEN_REQUIRED" | "ALWAYS";
};

class HashingPassThrough extends Transform {
  private readonly hash = createHash("sha256");
  private finalized = false;
  sizeBytes = 0;

  override _transform(chunk: Buffer | string, _enc: BufferEncoding, callback: TransformCallback): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.sizeBytes += buf.length;
    this.hash.update(buf);
    callback(null, buf);
  }

  digestHex(): string {
    if (this.finalized) {
      throw new Error("Hash has already been finalized");
    }
    this.finalized = true;
    return this.hash.digest("hex");
  }
}

export class S3Service {
  private readonly client: S3Client;
  private readonly sse: string;

  constructor(cfg: S3ServiceConfig) {
    const cleanAccessKey = cfg.accessKeyId.replace(/[\s\u200B-\u200D\uFEFF]/g, "");
    const cleanSecretKey = cfg.secretAccessKey.replace(/[\s\u200B-\u200D\uFEFF]/g, "");

    const s3Cfg: S3ClientConfigWithChecksum = {
      region: cfg.region,
      credentials: {
        accessKeyId: cleanAccessKey,
        secretAccessKey: cleanSecretKey,
      },
      forcePathStyle: cfg.forcePathStyle,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 30_000,
        socketTimeout: 30_000,
      }),
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    };

    if (cfg.endpoint) {
      s3Cfg.endpoint = cfg.endpoint;
    }

    this.client = new S3Client(s3Cfg as S3ClientConfig);
    this.sse = String(cfg.sse ?? "").trim();
  }

  async uploadPdfFromFile(input: UploadPdfFileInput): Promise<void> {
    const stat = await fsp.stat(input.filePath);
    if (input.contentLength > 0 && stat.size !== input.contentLength) {
      const err = new Error(
        `File size mismatch: expected ${input.contentLength} bytes, got ${stat.size}`,
      ) as Error & { name: string };
      err.name = "S3UploadInputMismatch";
      throw err;
    }

    const fileStream = createReadStream(input.filePath);
    try {
      await this.uploadStream({
        bucket: input.bucket,
        key: input.key,
        body: fileStream,
        contentType: input.contentType,
        contentLength: stat.size,
        metadata: input.metadata,
      });
    } finally {
      closeReadableQuietly(fileStream);
    }
  }

  async uploadStream(input: UploadStreamInput): Promise<UploadStreamResult> {
    const metadata = normalizeMetadata(input.metadata);
    const hashing = new HashingPassThrough();
    const params: PutObjectCommandInput = {
      Bucket: input.bucket,
      Key: input.key,
      Body: hashing,
      ContentType: input.contentType,
    };

    if (Number.isFinite(input.contentLength) && (input.contentLength ?? 0) > 0) {
      params.ContentLength = Math.floor(input.contentLength as number);
    }

    if (Object.keys(metadata).length > 0) {
      params.Metadata = metadata;
    }

    const sse = this.normalizedSse();
    if (sse) {
      params.ServerSideEncryption = sse as PutObjectCommandInput["ServerSideEncryption"];
    }

    const upload = new Upload({
      client: this.client,
      params,
      queueSize: 1,
      leavePartsOnError: false,
    });

    const forwardBodyError = (error: Error) => {
      hashing.destroy(error);
    };

    input.body.on("error", forwardBodyError);
    input.body.pipe(hashing);

    try {
      await upload.done();
      const sizeBytes = hashing.sizeBytes;
      const sha256Hex = hashing.digestHex();

      if (params.ContentLength != null && sizeBytes !== params.ContentLength) {
        const err = new Error(
          `Stream size mismatch: expected ${params.ContentLength} bytes, got ${sizeBytes}`,
        ) as Error & { name: string };
        err.name = "S3UploadInputMismatch";
        throw err;
      }

      return { sizeBytes, sha256Hex };
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error("S3 stream upload failed");
      closeReadableQuietly(input.body, error);
      hashing.destroy(error);
      throw error;
    } finally {
      input.body.off("error", forwardBodyError);
    }
  }

  async close(): Promise<void> {
    this.client.destroy();
  }

  private normalizedSse(): string | undefined {
    return this.sse !== "" ? this.sse : undefined;
  }
}

function closeReadableQuietly(stream: Readable, error?: Error): void {
  try {
    stream.destroy(error);
  } catch {
    // noop
  }
}
