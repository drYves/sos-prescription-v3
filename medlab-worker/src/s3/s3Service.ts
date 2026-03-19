import fsp from "node:fs/promises";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { S3Config } from "../config";

export interface UploadPdfInput {
  bucket: string;
  key: string;
  body: Buffer;
  contentType: string;
  metadata: Record<string, string>;
}

export interface UploadPdfFileInput {
  bucket: string;
  key: string;
  filePath: string;
  contentType: string;
  contentLength: number;
  metadata: Record<string, string>;
}

export class S3Service {
  private readonly client: S3Client;
  private readonly sse: string;

  constructor(cfg: S3Config) {
    this.sse = cfg.sse;

    this.client = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint,
      forcePathStyle: cfg.forcePathStyle,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
    });
  }

  async uploadPdf(input: UploadPdfInput): Promise<void> {
    const cmd = new PutObjectCommand({
      Bucket: input.bucket,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
      ServerSideEncryption: this.sse as never,
      Metadata: normalizeMetadata(input.metadata),
    });

    await this.client.send(cmd);
  }

  async uploadPdfFromFile(input: UploadPdfFileInput): Promise<void> {
    const bodyBuffer = await fsp.readFile(input.filePath);

    const cmd = new PutObjectCommand({
      Bucket: input.bucket,
      Key: input.key,
      Body: bodyBuffer,
      ContentType: input.contentType,
      ServerSideEncryption: this.sse as never,
      Metadata: normalizeMetadata(input.metadata),
    });

    await this.client.send(cmd);
  }
}

function normalizeMetadata(meta: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) {
    const key = k.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
    out[key] = String(v).slice(0, 256);
  }
  return out;
}
