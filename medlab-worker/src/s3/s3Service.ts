// src/s3/s3Service.ts
import { PutObjectCommand, S3Client, S3ClientConfig } from "@aws-sdk/client-s3";
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
    // PURIFICATION STRICTE DES CLÉS (Éradication des espaces invisibles ZWSP, \n, \r)
    const cleanAccessKey = cfg.accessKeyId.replace(/[\s\u200B-\u200D\uFEFF]/g, "");
    const cleanSecretKey = cfg.secretAccessKey.replace(/[\s\u200B-\u200D\uFEFF]/g, "");

    const s3Cfg: S3ClientConfigWithChecksum = {
      region: cfg.region,
      credentials: {
        accessKeyId: cleanAccessKey,
        secretAccessKey: cleanSecretKey,
      },
      forcePathStyle: cfg.forcePathStyle,
      // LE FIX ABSOLU : Contournement du bug fetch Node 24
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 30000,
        socketTimeout: 30000,
      }),
      // LE FIX ULTIME POUR NODE 24 : Empêche l'ajout de headers variables qui cassent la signature V4
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    };

    if (cfg.endpoint) {
      s3Cfg.endpoint = cfg.endpoint;
    }

    this.client = new S3Client(s3Cfg as S3ClientConfig);
    this.sse = cfg.sse;
  }

  async uploadPdfFromFile(input: UploadPdfFileInput): Promise<void> {
    const bodyBuffer = await fsp.readFile(input.filePath);

    // On ne passe plus CONTENT-LENGTH ni rien d'autre qui pourrait
    // corrompre la signature V4 calculée par le NodeHttpHandler.
    const cmd = new PutObjectCommand({
      Bucket: input.bucket,
      Key: input.key,
      Body: bodyBuffer,
      ContentType: "application/pdf",
    });

    await this.client.send(cmd);
  }

  async close(): Promise<void> {
    this.client.destroy();
  }
}
