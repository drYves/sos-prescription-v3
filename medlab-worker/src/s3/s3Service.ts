// src/s3/s3Service.ts
import { PutObjectCommand, S3Client, S3ClientConfig } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
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

interface PresignedPutRequest {
  url: string;
  headers: Record<string, string>;
}

type S3ClientConfigWithChecksum = S3ClientConfig & {
  requestChecksumCalculation?: "WHEN_REQUIRED" | "ALWAYS";
  responseChecksumValidation?: "WHEN_REQUIRED" | "ALWAYS";
};

const PRESIGNED_URL_TTL_SECONDS = 900;
const UPLOAD_TIMEOUT_MS = 30_000;

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
    const presignedPut = await this.createPresignedPutRequest(input, metadata, bodyBuffer);

    await this.putBufferWithPresignedUrl(presignedPut, bodyBuffer);
  }

  async close(): Promise<void> {
    this.client.destroy();
  }

  private async createPresignedPutRequest(
    input: UploadPdfFileInput,
    metadata: Record<string, string>,
    bodyBuffer: Buffer,
  ): Promise<PresignedPutRequest> {
    const sse = this.normalizedSse();

    const command = new PutObjectCommand({
      Bucket: input.bucket,
      Key: input.key,
      Body: bodyBuffer,
      ContentType: input.contentType,
      Metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      ServerSideEncryption: sse,
    });

    const signedHeaders = new Set<string>(["content-type"]);
    if (sse) {
      signedHeaders.add("x-amz-server-side-encryption");
    }
    for (const key of Object.keys(metadata)) {
      signedHeaders.add(`x-amz-meta-${key}`);
    }

    const unhoistableHeaders = new Set<string>();
    for (const headerName of signedHeaders) {
      if (headerName.startsWith("x-amz-")) {
        unhoistableHeaders.add(headerName);
      }
    }

    const url = await getSignedUrl(this.client as any, command as any, {
      expiresIn: PRESIGNED_URL_TTL_SECONDS,
      signableHeaders: signedHeaders,
      unhoistableHeaders: unhoistableHeaders.size > 0 ? unhoistableHeaders : undefined,
    });

    const headers: Record<string, string> = {
      "content-type": input.contentType,
    };

    if (sse) {
      headers["x-amz-server-side-encryption"] = sse;
    }

    for (const [key, value] of Object.entries(metadata)) {
      headers[`x-amz-meta-${key}`] = value;
    }

    return { url, headers };
  }

  private async putBufferWithPresignedUrl(req: PresignedPutRequest, bodyBuffer: Buffer): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    timeout.unref?.();

    let response: Response;

    try {
      response = await fetch(req.url, {
        method: "PUT",
        headers: {
          ...req.headers,
          "content-length": String(bodyBuffer.byteLength),
        },
        body: bodyBuffer,
        signal: controller.signal,
      });
    } catch (err) {
      throw this.normalizeUploadTransportError(err);
    } finally {
      clearTimeout(timeout);
    }

    if (response.status < 200 || response.status >= 300) {
      const bodyText = await safeReadResponseText(response);
      throw this.buildUploadHttpError(response.status, bodyText);
    }
  }

  private normalizedSse(): string | undefined {
    return this.sse !== "" ? this.sse : undefined;
  }

  private normalizeUploadTransportError(err: unknown): Error {
    if (err instanceof Error) {
      if (err.name === "AbortError") {
        const timeoutErr = new Error("Presigned PUT upload timed out") as Error & {
          name: string;
          $metadata?: { httpStatusCode: number };
        };
        timeoutErr.name = "S3UploadTimeout";
        timeoutErr.$metadata = { httpStatusCode: 0 };
        return timeoutErr;
      }

      const uploadErr = new Error(err.message) as Error & {
        name: string;
        $metadata?: { httpStatusCode: number };
      };
      uploadErr.name = err.name || "S3UploadError";
      uploadErr.$metadata = { httpStatusCode: 0 };
      return uploadErr;
    }

    const unknownErr = new Error(String(err)) as Error & {
      name: string;
      $metadata?: { httpStatusCode: number };
    };
    unknownErr.name = "S3UploadError";
    unknownErr.$metadata = { httpStatusCode: 0 };
    return unknownErr;
  }

  private buildUploadHttpError(statusCode: number, responseBody: string): Error {
    const code = matchXmlTag(responseBody, "Code") ?? `S3UploadHttp${statusCode}`;
    const message =
      matchXmlTag(responseBody, "Message") ?? `Presigned PUT upload failed with HTTP ${statusCode}`;

    const err = new Error(message) as Error & {
      name: string;
      statusCode?: number;
      responseBody?: string;
      $metadata?: { httpStatusCode: number };
    };

    err.name = code;
    err.statusCode = statusCode;
    err.$metadata = { httpStatusCode: statusCode };
    if (responseBody !== "") {
      err.responseBody = responseBody.slice(0, 4_000);
    }

    return err;
  }
}

async function safeReadResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (_err) {
    return "";
  }
}

function matchXmlTag(xml: string, tagName: string): string | undefined {
  const re = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = re.exec(xml);
  if (!match || typeof match[1] !== "string") {
    return undefined;
  }
  return decodeXmlEntities(match[1].trim());
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
