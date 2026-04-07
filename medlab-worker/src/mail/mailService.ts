import { NdjsonLogger } from "../logger";

const DEFAULT_VERIFY_BASE_URL = "https://sosprescription.fr/auth/verify";
const DEFAULT_PATIENT_PORTAL_URL = "https://sosprescription.fr/espace-patient/";
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 2_000;
const MAX_TIMEOUT_MS = 30_000;

type DeliveryMode = "webhook" | "mock";

export interface MailServiceConfig {
  logger?: NdjsonLogger;
  verifyBaseUrl?: string;
  patientPortalUrl?: string;
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

export interface SendNewMessageNotificationInput {
  email: string;
  prescriptionUid?: string | null;
}

export interface SendMagicLinkMailResult {
  sent: boolean;
  deliveryMode: DeliveryMode;
}

export interface SendNewMessageNotificationResult {
  sent: boolean;
  deliveryMode: DeliveryMode;
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
  private readonly patientPortalUrl: string;
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
    this.patientPortalUrl = normalizeBaseUrl(
      cfg.patientPortalUrl
        ?? process.env.ML_PATIENT_PORTAL_URL
        ?? process.env.PATIENT_PORTAL_URL
        ?? DEFAULT_PATIENT_PORTAL_URL,
      DEFAULT_PATIENT_PORTAL_URL,
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

    return this.dispatchMail(
      {
        email,
        subject: `[${this.fromName}] Votre lien de connexion sécurisé`,
        text: buildMagicLinkPlainTextBody(magicUrl, ttlMinutes),
        html: buildMagicLinkHtmlBody(magicUrl, ttlMinutes),
        meta: {
          channel: "magic_link",
          ttl_minutes: ttlMinutes,
        },
        successLogEvent: "mail.magic_link.dispatched",
        mockLogEvent: "mail.magic_link.mock_dispatched",
        errorLogEvent: "mail.magic_link.dispatch_failed",
        successLogContext: {
          verify_host: safeHost(this.verifyBaseUrl),
          ttl_minutes: ttlMinutes,
        },
      },
      reqId,
      "ML_MAGIC_LINK_MAIL_FAILED",
    );
  }

  async sendNewMessageNotification(
    input: SendNewMessageNotificationInput,
    reqId?: string,
  ): Promise<SendNewMessageNotificationResult> {
    const email = normalizeEmail(input.email);
    if (email === "") {
      throw new MailServiceError("ML_MESSAGE_NOTIFICATION_BAD_REQUEST", 400, "message_notification_input_invalid");
    }

    const portalUrl = buildPatientPortalUrl(this.patientPortalUrl, input.prescriptionUid);

    return this.dispatchMail(
      {
        email,
        subject: `[${this.fromName}] Nouveau message de votre médecin`,
        text: buildNewMessageNotificationPlainTextBody(portalUrl),
        html: buildNewMessageNotificationHtmlBody(portalUrl),
        meta: {
          channel: "patient_new_message",
          prescription_uid: normalizeOptionalString(input.prescriptionUid) || null,
        },
        successLogEvent: "mail.patient_new_message.dispatched",
        mockLogEvent: "mail.patient_new_message.mock_dispatched",
        errorLogEvent: "mail.patient_new_message.dispatch_failed",
        successLogContext: {
          portal_host: safeHost(portalUrl),
        },
      },
      reqId,
      "ML_MESSAGE_NOTIFICATION_FAILED",
    );
  }

  private async dispatchMail(
    input: {
      email: string;
      subject: string;
      text: string;
      html: string;
      meta: Record<string, unknown>;
      successLogEvent: string;
      mockLogEvent: string;
      errorLogEvent: string;
      successLogContext: Record<string, unknown>;
    },
    reqId: string | undefined,
    failureCode: string,
  ): Promise<{ sent: boolean; deliveryMode: DeliveryMode }> {
    if (this.webhookUrl === "") {
      this.logger?.info(
        input.mockLogEvent,
        {
          email_fp: fingerprint(input.email),
          delivery_mode: "mock",
          ...input.successLogContext,
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
          to: input.email,
          subject: input.subject,
          text: input.text,
          html: input.html,
          meta: input.meta,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new MailServiceError(failureCode, 502, `mail_http_${response.status}`);
      }

      this.logger?.info(
        input.successLogEvent,
        {
          email_fp: fingerprint(input.email),
          delivery_mode: "webhook",
          ...input.successLogContext,
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
          input.errorLogEvent,
          {
            email_fp: fingerprint(input.email),
            delivery_mode: "webhook",
            reason: err.message,
          },
          reqId,
          err,
        );
        throw err;
      }

      const message = isAbortError(err) ? "mail_timeout" : err instanceof Error ? err.message : "mail_failed";
      this.logger?.error(
        input.errorLogEvent,
        {
          email_fp: fingerprint(input.email),
          delivery_mode: "webhook",
          reason: message,
        },
        reqId,
        err,
      );

      throw new MailServiceError(failureCode, 502, message, { cause: err instanceof Error ? err : undefined });
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

function buildMagicLinkPlainTextBody(magicUrl: string, ttlMinutes: number): string {
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

function buildMagicLinkHtmlBody(magicUrl: string, ttlMinutes: number): string {
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

function buildNewMessageNotificationPlainTextBody(portalUrl: string): string {
  return [
    "Bonjour,",
    "",
    "Vous avez un nouveau message de votre médecin sur SOS Prescription.",
    "Connectez-vous à votre espace pour lui répondre.",
    portalUrl,
  ].join("\n");
}

function buildNewMessageNotificationHtmlBody(portalUrl: string): string {
  const escapedUrl = escapeHtml(portalUrl);

  return [
    "<!doctype html>",
    '<html lang="fr">',
    "<body>",
    "<p>Bonjour,</p>",
    "<p>Vous avez un nouveau message de votre médecin sur SOS Prescription.</p>",
    "<p>Connectez-vous à votre espace pour lui répondre.</p>",
    `<p><a href="${escapedUrl}">${escapedUrl}</a></p>`,
    "</body>",
    "</html>",
  ].join("");
}

function buildMagicUrl(baseUrl: string, token: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

function buildPatientPortalUrl(baseUrl: string, prescriptionUid?: string | null): string {
  const url = new URL(baseUrl);
  const normalizedUid = normalizeOptionalString(prescriptionUid);
  if (normalizedUid !== "") {
    url.searchParams.set("rx_uid", normalizedUid);
  }
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
