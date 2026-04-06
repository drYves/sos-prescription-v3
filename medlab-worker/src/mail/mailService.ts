import { NdjsonLogger } from "../logger";

const DEFAULT_VERIFY_BASE_URL = "https://sosprescription.fr/auth/verify";
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 2_000;
const MAX_TIMEOUT_MS = 30_000;

export interface MailServiceConfig {
  logger?: NdjsonLogger;
  verifyBaseUrl?: string;
  webhookUrl?: string;
  webhookBearer?: string;
  requestTimeoutMs?: number;
  fromName?: string;
}

export interface SendMagicLinkMailInput {
  email: string;
  token: string;
  expiresAt: Date;
}

export interface SendMagicLinkMailResult {
  sent: boolean;
  deliveryMode: "webhook" | "mock";
}

export class MailServiceError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(code: string, statusCode: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MailServiceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class MailService {
  private readonly logger?: NdjsonLogger;
  private readonly verifyBaseUrl: string;
  private readonly webhookUrl: string;
  private readonly webhookBearer: string;
  private readonly requestTimeoutMs: number;
  private readonly fromName: string;

  constructor(cfg: MailServiceConfig = {}) {
    this.logger = cfg.logger;
    this.verifyBaseUrl = normalizeBaseUrl(
      cfg.verifyBaseUrl
        ?? process.env.ML_MAGIC_LINK_VERIFY_URL
        ?? process.env.MAGIC_LINK_VERIFY_URL
        ?? DEFAULT_VERIFY_BASE_URL,
      DEFAULT_VERIFY_BASE_URL,
    );
    this.webhookUrl = normalizeOptionalString(
      cfg.webhookUrl
        ?? process.env.ML_MAGIC_LINK_EMAIL_WEBHOOK_URL
        ?? process.env.MAGIC_LINK_EMAIL_WEBHOOK_URL,
    );
    this.webhookBearer = normalizeOptionalString(
      cfg.webhookBearer
        ?? process.env.ML_MAGIC_LINK_EMAIL_WEBHOOK_BEARER
        ?? process.env.MAGIC_LINK_EMAIL_WEBHOOK_BEARER,
    );
    this.requestTimeoutMs = clampTimeout(
      cfg.requestTimeoutMs
        ?? readPositiveIntEnv("ML_MAGIC_LINK_EMAIL_TIMEOUT_MS", readPositiveIntEnv("MAGIC_LINK_EMAIL_TIMEOUT_MS", DEFAULT_TIMEOUT_MS)),
    );
    this.fromName = normalizeOptionalString(
      cfg.fromName
        ?? process.env.ML_MAGIC_LINK_FROM_NAME
        ?? process.env.MAGIC_LINK_FROM_NAME,
    ) || "SOS Prescription";
  }

  async sendMagicLink(input: SendMagicLinkMailInput, reqId?: string): Promise<SendMagicLinkMailResult> {
    const email = normalizeEmail(input.email);
    const token = normalizeToken(input.token);
    if (email === "" || token === "") {
      throw new MailServiceError("ML_MAGIC_LINK_MAIL_BAD_REQUEST", 400, "magic_link_mail_input_invalid");
    }

    const magicUrl = buildMagicUrl(this.verifyBaseUrl, token);
    const ttlMinutes = Math.max(1, Math.ceil(Math.max(1, input.expiresAt.getTime() - Date.now()) / 60_000));
    const subject = `[${this.fromName}] Votre lien de connexion sécurisé`;
    const text = buildPlainTextBody(magicUrl, ttlMinutes);
    const html = buildHtmlBody(magicUrl, ttlMinutes);

    if (this.webhookUrl === "") {
      this.logger?.info(
        "mail.magic_link.mock_dispatched",
        {
          email_fp: fingerprint(email),
          delivery_mode: "mock",
          verify_host: safeHost(this.verifyBaseUrl),
          ttl_minutes: ttlMinutes,
        },
        reqId,
      );

      return {
        sent: true,
        deliveryMode: "mock",
      };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const response = await fetch(this.webhookUrl, {
        method: "POST",
        headers: buildWebhookHeaders(this.webhookBearer),
        body: JSON.stringify({
          to: email,
          subject,
          text,
          html,
          meta: {
            channel: "magic_link",
            ttl_minutes: ttlMinutes,
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new MailServiceError(
          "ML_MAGIC_LINK_MAIL_FAILED",
          502,
          `magic_link_mail_http_${response.status}`,
        );
      }

      this.logger?.info(
        "mail.magic_link.dispatched",
        {
          email_fp: fingerprint(email),
          delivery_mode: "webhook",
          verify_host: safeHost(this.verifyBaseUrl),
          ttl_minutes: ttlMinutes,
        },
        reqId,
      );

      return {
        sent: true,
        deliveryMode: "webhook",
      };
    } catch (err: unknown) {
      if (err instanceof MailServiceError) {
        this.logger?.error(
          "mail.magic_link.dispatch_failed",
          {
            email_fp: fingerprint(email),
            delivery_mode: "webhook",
            reason: err.message,
          },
          reqId,
          err,
        );
        throw err;
      }

      const message = isAbortError(err) ? "magic_link_mail_timeout" : err instanceof Error ? err.message : "magic_link_mail_failed";
      this.logger?.error(
        "mail.magic_link.dispatch_failed",
        {
          email_fp: fingerprint(email),
          delivery_mode: "webhook",
          reason: message,
        },
        reqId,
        err,
      );

      throw new MailServiceError("ML_MAGIC_LINK_MAIL_FAILED", 502, message, { cause: err instanceof Error ? err : undefined });
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

function buildWebhookHeaders(bearer: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json; charset=utf-8",
  };

  if (bearer !== "") {
    headers.Authorization = `Bearer ${bearer}`;
  }

  return headers;
}

function buildPlainTextBody(magicUrl: string, ttlMinutes: number): string {
  return [
    "Bonjour,",
    "",
    "Cliquez sur le lien ci-dessous pour vous connecter à votre espace SOS Prescription :",
    magicUrl,
    "",
    `Ce lien est valable ${ttlMinutes} minute${ttlMinutes > 1 ? "s" : ""} et ne peut être utilisé qu’une seule fois.`,
    "",
    "Si vous n’êtes pas à l’origine de cette demande, vous pouvez ignorer cet e-mail.",
  ].join("\n");
}

function buildHtmlBody(magicUrl: string, ttlMinutes: number): string {
  const escapedUrl = escapeHtml(magicUrl);
  const ttlLabel = `${ttlMinutes} minute${ttlMinutes > 1 ? "s" : ""}`;

  return [
    "<!doctype html>",
    '<html lang="fr">',
    "<body>",
    "<p>Bonjour,</p>",
    "<p>Cliquez sur le lien ci-dessous pour vous connecter à votre espace SOS Prescription :</p>",
    `<p><a href="${escapedUrl}">${escapedUrl}</a></p>`,
    `<p>Ce lien est valable ${escapeHtml(ttlLabel)} et ne peut être utilisé qu’une seule fois.</p>`,
    "<p>Si vous n’êtes pas à l’origine de cette demande, vous pouvez ignorer cet e-mail.</p>",
    "</body>",
    "</html>",
  ].join("");
}

function buildMagicUrl(baseUrl: string, token: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

function normalizeBaseUrl(value: string, fallback: string): string {
  const raw = normalizeOptionalString(value);
  if (raw === "") {
    return fallback;
  }

  try {
    return new URL(raw).toString();
  } catch {
    return fallback;
  }
}

function normalizeOptionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeEmail(value: string): string {
  const normalized = String(value || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : "";
}

function normalizeToken(value: string): string {
  const normalized = String(value || "").trim();
  if (normalized.length < 32 || normalized.length > 256) {
    return "";
  }
  if (!/^[A-Za-z0-9_-]+$/.test(normalized)) {
    return "";
  }
  return normalized;
}

function clampTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(value)));
}

function readPositiveIntEnv(key: string, fallback: number): number {
  const raw = normalizeOptionalString(process.env[key]);
  if (raw === "") {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function fingerprint(value: string): string {
  return Buffer.from(String(value || ""), "utf8").toString("base64url").slice(0, 12);
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }

  const candidate = err as Error & { name?: unknown; message?: unknown };
  const name = typeof candidate.name === "string" ? candidate.name : "";
  const message = typeof candidate.message === "string" ? candidate.message : "";
  return name === "AbortError" || /abort/i.test(message) || /timeout/i.test(message);
}

function escapeHtml(value: string): string {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
