// src/s3/s3Service.ts
import { PutObjectCommandInput, S3Client, S3ClientConfig } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import fsp from "node:fs/promises";
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

type S3ClientConfigWithChecksum = S3ClientConfig & {
  requestChecksumCalculation?: "WHEN_REQUIRED" | "ALWAYS";
  responseChecksumValidation?: "WHEN_REQUIRED" | "ALWAYS";
};

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
    const bodyBuffer = await fsp.readFile(input.filePath);

    if (input.contentLength > 0 && bodyBuffer.byteLength !== input.contentLength) {
      const err = new Error(
        `File size mismatch: expected ${input.contentLength} bytes, got ${bodyBuffer.byteLength}`,
      ) as Error & { name: string };
      err.name = "S3UploadInputMismatch";
      throw err;
    }

    const metadata = normalizeMetadata(input.metadata);
    const params: PutObjectCommandInput = {
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
      params.ServerSideEncryption = sse as PutObjectCommandInput["ServerSideEncryption"];
    }

    const upload = new Upload({
      client: this.client,
      params,
      queueSize: 1,
      leavePartsOnError: false,
    });

    await upload.done();
  }

  async close(): Promise<void> {
    this.client.destroy();
  }

  private normalizedSse(): string | undefined {
    return this.sse !== "" ? this.sse : undefined;
  }
}
