import { PutObjectCommand, S3Client, S3ClientConfig } from "@aws-sdk/client-s3";
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

export class S3Service {
  private readonly client: S3Client;
  private readonly sse: string;

  constructor(cfg: S3ServiceConfig) {
    const s3Cfg: S3ClientConfig = {
      region: cfg.region,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
      forcePathStyle: cfg.forcePathStyle,
    };

    if (cfg.endpoint) {
      s3Cfg.endpoint = cfg.endpoint;
    }

    this.client = new S3Client(s3Cfg);
    this.sse = cfg.sse;
  }

  async uploadPdfFromFile(input: UploadPdfFileInput): Promise<void> {
    const bodyBuffer = await fsp.readFile(input.filePath);

    const cmd = new PutObjectCommand({
      Bucket: input.bucket,
      Key: input.key,
      Body: bodyBuffer,
      ContentType: input.contentType,
      ContentLength: bodyBuffer.length,
      ServerSideEncryption: this.sse as never,
      Metadata: normalizeMetadata(input.metadata),
    });

    await this.client.send(cmd);
  }

  async close(): Promise<void> {
    this.client.destroy();
  }
}
