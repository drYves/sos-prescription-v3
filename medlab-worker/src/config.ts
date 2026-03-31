// src/config.ts
import os from "node:os";

export type EnvName = "prod" | "staging" | "dev";

export interface S3Config {
  endpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketPdf: string;
  bucketArtifacts: string;
  sse: "AES256" | "aws:kms" | string;
  forcePathStyle: boolean;
}

export interface SecurityConfig {
  hmacSecretActive: string;
  hmacSecretPrevious?: string;
  authSkewWindowMs: number;
}

export interface UploadConfig {
  workerPublicBaseUrl?: string;
  maxBytes: number;
  ticketTtlMs: number;
  allowedOrigins: string[];
}

export interface OpenRouterConfig {
  apiKey?: string;
  model: string;
  baseUrl: string;
  requestTimeoutMs: number;
  httpReferer?: string;
  title?: string;
}

export interface WorkerConfig {
  siteId: string;
  workerId: string;
  env: EnvName;
  port: number;
  leaseMinutes: number;
  pollIntervalMs: number;
  ramGuardMaxMb: number;
  ramGuardResumeMb: number;
  wpBaseUrl: string;
  jobClaimPath: string;
  jobCallbackPathTemplate: string;
  pdfRenderPathTemplate: string;
  chromeExecutablePath: string;
  pdfRenderTimeoutMs: number;
  pdfReadyTimeoutMs: number;
  restRequestTimeoutMs: number;
  s3: S3Config;
  security: SecurityConfig;
  upload: UploadConfig;
  openRouter: OpenRouterConfig;
}

function mustGetEnv(key: string): string {
  const v = process.env[key];
  if (!v || v.trim() === "") throw new Error(`Missing required env var: ${key}`);
  return v.trim();
}

function getEnv(key: string): string | undefined {
  const v = process.env[key];
  if (!v) return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseBool(v: string | undefined, def: boolean): boolean {
  if (!v) return def;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function parseIntEnv(key: string, def: number): number {
  const v = getEnv(key);
  if (!v) return def;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function normalizePath(path: string, fallback: string): string {
  const raw = (path || fallback).trim();
  if (raw === "") return fallback;
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function normalizeBaseUrl(url: string | undefined): string | undefined {
  const raw = String(url ?? "").trim();
  if (raw === "") {
    return undefined;
  }

  try {
    return new URL(raw).toString().replace(/\/+$/g, "");
  } catch {
    return undefined;
  }
}

function parseOriginsCsv(value: string | undefined): string[] {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      try {
        return new URL(entry).origin;
      } catch {
        return "";
      }
    })
    .filter((entry) => entry.length > 0);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim() !== "")));
}

export function loadConfig(): WorkerConfig {
  const siteId = mustGetEnv("ML_SITE_ID");
  const env = (getEnv("SOSPRESCRIPTION_ENV") ?? "prod") as EnvName;
  const workerId = getEnv("WORKER_ID") ?? `${os.hostname()}-${process.pid}`;

  const security: SecurityConfig = {
    hmacSecretActive: mustGetEnv("ML_HMAC_SECRET"),
    hmacSecretPrevious: getEnv("ML_HMAC_SECRET_PREVIOUS"),
    authSkewWindowMs: parseIntEnv("ML_AUTH_SKEW_WINDOW_MS", 30_000),
  };

  const wpBaseUrl = mustGetEnv("ML_WP_BASE_URL").replace(/\/+$/g, "");
  const wpOrigin = (() => {
    try {
      return new URL(wpBaseUrl).origin;
    } catch {
      return undefined;
    }
  })();

  const bucketPdf = mustGetEnv("S3_BUCKET_PDF");

  const s3: S3Config = {
    endpoint: getEnv("S3_ENDPOINT") ?? undefined,
    region: mustGetEnv("S3_REGION"),
    accessKeyId: mustGetEnv("S3_ACCESS_KEY_ID"),
    secretAccessKey: mustGetEnv("S3_SECRET_ACCESS_KEY"),
    bucketPdf,
    bucketArtifacts: getEnv("S3_BUCKET_ARTIFACTS") ?? bucketPdf,
    sse: getEnv("S3_SSE") ?? "AES256",
    forcePathStyle: parseBool(getEnv("S3_FORCE_PATH_STYLE"), false),
  };

  const explicitUploadOrigins = parseOriginsCsv(getEnv("ARTIFACT_UPLOAD_ALLOWED_ORIGINS"));
  const fallbackOrigins = wpOrigin ? [wpOrigin] : [];

  const openRouter: OpenRouterConfig = {
    apiKey: getEnv("OPENROUTER_API_KEY"),
    model: getEnv("OPENROUTER_MODEL") ?? "google/gemini-2.5-flash",
    baseUrl: getEnv("OPENROUTER_BASE_URL") ?? "https://openrouter.ai/api/v1/chat/completions",
    requestTimeoutMs: parseIntEnv("OPENROUTER_REQUEST_TIMEOUT_MS", 45_000),
    httpReferer: normalizeBaseUrl(getEnv("OPENROUTER_HTTP_REFERER") ?? wpBaseUrl) ?? wpBaseUrl,
    title: getEnv("OPENROUTER_TITLE") ?? "SOS Prescription Worker",
  };

  return {
    siteId,
    workerId,
    env,
    port: parseIntEnv("PORT", 8080),
    leaseMinutes: parseIntEnv("JOB_LEASE_MINUTES", 10),
    pollIntervalMs: parseIntEnv("POLL_INTERVAL_MS", 1000),
    ramGuardMaxMb: parseIntEnv("RAM_GUARD_MAX_MB", 512),
    ramGuardResumeMb: parseIntEnv("RAM_GUARD_RESUME_MB", 450),
    wpBaseUrl,
    jobClaimPath: normalizePath(
      getEnv("JOB_CLAIM_PATH_TEMPLATE") ?? "/wp-json/sosprescription/v3/worker/jobs/claim",
      "/wp-json/sosprescription/v3/worker/jobs/claim",
    ),
    jobCallbackPathTemplate: normalizePath(
      getEnv("JOB_CALLBACK_PATH_TEMPLATE") ?? "/wp-json/sosprescription/v3/worker/jobs/{job_id}/callback",
      "/wp-json/sosprescription/v3/worker/jobs/{job_id}/callback",
    ),
    pdfRenderPathTemplate: normalizePath(
      getEnv("PDF_RENDER_PATH_TEMPLATE") ?? "/wp-json/sosprescription/v3/worker/render/rx/{rx_id}",
      "/wp-json/sosprescription/v3/worker/render/rx/{rx_id}",
    ),
    chromeExecutablePath:
      getEnv("CHROME_EXECUTABLE_PATH")
      ?? getEnv("PUPPETEER_EXECUTABLE_PATH")
      ?? mustGetEnv("CHROME_EXECUTABLE_PATH"),
    pdfRenderTimeoutMs: parseIntEnv("PDF_RENDER_TIMEOUT_MS", 45_000),
    pdfReadyTimeoutMs: parseIntEnv("PDF_READY_TIMEOUT_MS", 15_000),
    restRequestTimeoutMs: parseIntEnv("WP_REST_REQUEST_TIMEOUT_MS", 15_000),
    s3,
    security,
    upload: {
      workerPublicBaseUrl: normalizeBaseUrl(getEnv("ML_WORKER_BASE_URL") ?? getEnv("WORKER_PUBLIC_BASE_URL")),
      maxBytes: parseIntEnv("ARTIFACT_UPLOAD_MAX_BYTES", 8 * 1024 * 1024),
      ticketTtlMs: parseIntEnv("ARTIFACT_UPLOAD_TICKET_TTL_MS", 15 * 60 * 1000),
      allowedOrigins: uniqueStrings(explicitUploadOrigins.length > 0 ? explicitUploadOrigins : fallbackOrigins),
    },
    openRouter,
  };
}
