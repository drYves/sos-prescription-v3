import crypto from "node:crypto";
import { buildMls1Token } from "../security/mls1";

const CURRENT_SCHEMA_VERSION = "2026.6";
const DEFAULT_SYNC_PATH_TEMPLATE = "/wp-json/sosprescription/v1/prescriptions/{id}/payment/worker-sync";

interface WordPressPaymentBridgeConfig {
  wpBaseUrl: string;
  siteId: string;
  hmacSecret: string;
  syncPathTemplate?: string;
  timeoutMs?: number;
}

export interface PaymentSyncPayload {
  paymentIntentId: string;
  stripeStatus: string;
  amountCents?: number | null;
  currency?: string | null;
  eventType?: string | null;
  reqId?: string | null;
}

export class WordPressPaymentBridgeError extends Error {
  readonly code: string;
  readonly transient: boolean;
  readonly statusCode: number | null;

  constructor(code: string, message: string, transient: boolean, statusCode: number | null = null) {
    super(message);
    this.name = "WordPressPaymentBridgeError";
    this.code = code;
    this.transient = transient;
    this.statusCode = statusCode;
  }
}

export class WordPressPaymentBridge {
  private readonly wpBaseUrl: string;
  private readonly siteId: string;
  private readonly hmacSecret: string;
  private readonly syncPathTemplate: string;
  private readonly timeoutMs: number;

  constructor(cfg: WordPressPaymentBridgeConfig) {
    this.wpBaseUrl = normalizeBaseUrl(cfg.wpBaseUrl);
    this.siteId = String(cfg.siteId ?? "").trim();
    this.hmacSecret = String(cfg.hmacSecret ?? "").trim();
    this.syncPathTemplate = normalizePathTemplate(cfg.syncPathTemplate ?? DEFAULT_SYNC_PATH_TEMPLATE, DEFAULT_SYNC_PATH_TEMPLATE);
    this.timeoutMs = Math.max(1_000, Math.floor(cfg.timeoutMs ?? 15_000));
  }

  async syncAuthorizedIntent(wpPrescriptionId: number, payload: PaymentSyncPayload): Promise<Record<string, unknown>> {
    const path = renderPathTemplate(this.syncPathTemplate, wpPrescriptionId);
    return this.postSignedJson(path, payload);
  }

  private async postSignedJson(path: string, payload: PaymentSyncPayload): Promise<Record<string, unknown>> {
    if (this.wpBaseUrl === "" || this.hmacSecret === "" || this.siteId === "") {
      throw new WordPressPaymentBridgeError("ML_WP_SYNC_DISABLED", "WordPress payment sync is not configured.", false, null);
    }

    const reqId = normalizeReqId(payload.reqId);
    const body = {
      schema_version: CURRENT_SCHEMA_VERSION,
      site_id: this.siteId,
      ts_ms: Date.now(),
      nonce: crypto.randomBytes(16).toString("hex"),
      req_id: reqId,
      payment_intent_id: String(payload.paymentIntentId ?? "").trim(),
      stripe_status: String(payload.stripeStatus ?? "").trim(),
      amount_cents: payload.amountCents ?? null,
      currency: payload.currency != null ? String(payload.currency).trim().toUpperCase() : null,
      event_type: payload.eventType != null ? String(payload.eventType).trim() : null,
    };

    if (body.payment_intent_id === "") {
      throw new WordPressPaymentBridgeError("ML_WP_SYNC_BAD_INPUT", "payment_intent_id is required for WordPress sync.", false, null);
    }

    const rawBody = JSON.stringify(body);
    const response = await fetch(`${this.wpBaseUrl}${path}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json; charset=utf-8",
        "X-MedLab-Signature": buildMls1Token(Buffer.from(rawBody, "utf8"), this.hmacSecret),
      },
      body: rawBody,
      signal: AbortSignal.timeout(this.timeoutMs),
    }).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : "WordPress sync request failed";
      throw new WordPressPaymentBridgeError("ML_WP_SYNC_NETWORK", message, true, null);
    });

    const rawText = await response.text();
    let parsed: unknown = null;
    if (rawText.trim() !== "") {
      try {
        parsed = JSON.parse(rawText);
      } catch {
        parsed = rawText;
      }
    }

    if (!response.ok) {
      const message = extractResponseMessage(parsed) ?? response.statusText || "WordPress payment sync failed";
      const transient = response.status >= 500 || response.status === 429;
      throw new WordPressPaymentBridgeError("ML_WP_SYNC_HTTP", message, transient, response.status);
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: true };
    }

    return parsed as Record<string, unknown>;
  }
}

function normalizeBaseUrl(value: string): string {
  return String(value ?? "").trim().replace(/\/+$/g, "");
}

function normalizePathTemplate(value: string, fallback: string): string {
  const normalized = String(value ?? "").trim();
  if (normalized === "") {
    return fallback;
  }
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function renderPathTemplate(template: string, wpPrescriptionId: number): string {
  return template.replace(/\{id\}/g, encodeURIComponent(String(wpPrescriptionId)));
}

function normalizeReqId(value: unknown): string {
  const normalized = String(value ?? "").trim();
  return normalized !== "" ? normalized : `req_${crypto.randomBytes(8).toString("hex")}`;
}

function extractResponseMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return typeof payload === "string" && payload.trim() !== "" ? payload.trim() : null;
  }

  const row = payload as Record<string, unknown>;
  const message = row.message;
  if (typeof message === "string" && message.trim() !== "") {
    return message.trim();
  }

  const code = row.code;
  if (typeof code === "string" && code.trim() !== "") {
    return code.trim();
  }

  return null;
}
