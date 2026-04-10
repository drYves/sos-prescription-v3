import crypto from "node:crypto";

export interface StripePaymentIntentRecord {
  id: string;
  object: "payment_intent";
  status: string;
  amount: number | null;
  currency: string | null;
  metadata: Record<string, string>;
  client_secret?: string | null;
  next_action?: unknown;
}

interface StripeGatewayConfig {
  secretKey?: string;
  webhookSecret?: string;
  apiBaseUrl?: string;
}

interface StripeRequestOptions {
  idempotencyKey?: string;
  body?: URLSearchParams;
}

export class StripeGatewayError extends Error {
  readonly code: string;
  readonly statusCode: number | null;
  readonly transient: boolean;
  readonly responseBody: unknown;

  constructor(code: string, message: string, transient: boolean, statusCode: number | null = null, responseBody: unknown = null) {
    super(message);
    this.name = "StripeGatewayError";
    this.code = code;
    this.statusCode = statusCode;
    this.transient = transient;
    this.responseBody = responseBody;
  }
}

export class StripeGateway {
  private readonly secretKey: string;
  private readonly webhookSecret: string;
  private readonly apiBaseUrl: string;

  constructor(cfg: StripeGatewayConfig = {}) {
    this.secretKey = String(cfg.secretKey ?? process.env.STRIPE_SECRET_KEY ?? "").trim();
    this.webhookSecret = String(cfg.webhookSecret ?? process.env.STRIPE_WEBHOOK_SECRET ?? "").trim();
    this.apiBaseUrl = String(cfg.apiBaseUrl ?? "https://api.stripe.com/v1").trim().replace(/\/+$/g, "");
  }

  isEnabled(): boolean {
    return this.secretKey !== "";
  }

  hasWebhookSecret(): boolean {
    return this.webhookSecret !== "";
  }

  async retrievePaymentIntent(paymentIntentId: string): Promise<StripePaymentIntentRecord> {
    const id = normalizeRequiredString(paymentIntentId, "paymentIntentId");
    const payload = await this.requestJson("GET", `/payment_intents/${encodeURIComponent(id)}`);
    return toPaymentIntentRecord(payload);
  }

  async capturePaymentIntent(paymentIntentId: string, idempotencyKey?: string): Promise<StripePaymentIntentRecord> {
    const id = normalizeRequiredString(paymentIntentId, "paymentIntentId");
    const payload = await this.requestJson("POST", `/payment_intents/${encodeURIComponent(id)}/capture`, {
      idempotencyKey,
      body: new URLSearchParams(),
    });
    return toPaymentIntentRecord(payload);
  }

  async cancelPaymentIntent(paymentIntentId: string, idempotencyKey?: string): Promise<StripePaymentIntentRecord> {
    const id = normalizeRequiredString(paymentIntentId, "paymentIntentId");
    const payload = await this.requestJson("POST", `/payment_intents/${encodeURIComponent(id)}/cancel`, {
      idempotencyKey,
      body: new URLSearchParams(),
    });
    return toPaymentIntentRecord(payload);
  }

  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string, toleranceSeconds = 300): boolean {
    if (!Buffer.isBuffer(rawBody) || rawBody.length < 1) {
      return false;
    }

    const secret = this.webhookSecret;
    const header = String(signatureHeader ?? "").trim();
    if (secret === "" || header === "") {
      return false;
    }

    let timestamp = 0;
    const signatures: string[] = [];
    for (const chunk of header.split(",")) {
      const [rawKey, rawValue] = chunk.split("=", 2);
      const key = String(rawKey ?? "").trim();
      const value = String(rawValue ?? "").trim();
      if (key === "t") {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          timestamp = parsed;
        }
      }
      if (key === "v1" && /^[0-9a-f]{64}$/i.test(value)) {
        signatures.push(value.toLowerCase());
      }
    }

    if (timestamp <= 0 || signatures.length < 1) {
      return false;
    }

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > Math.max(0, toleranceSeconds)) {
      return false;
    }

    const signedPayload = Buffer.concat([
      Buffer.from(String(timestamp), "utf8"),
      Buffer.from(".", "utf8"),
      rawBody,
    ]);

    const expected = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex").toLowerCase();
    return signatures.some((candidate) => timingSafeHexEqual(candidate, expected));
  }

  private async requestJson(method: "GET" | "POST", path: string, opts: StripeRequestOptions = {}): Promise<unknown> {
    if (!this.isEnabled()) {
      throw new StripeGatewayError("ML_STRIPE_DISABLED", "Stripe is not configured.", false, null, null);
    }

    const url = `${this.apiBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.secretKey}`,
      Accept: "application/json",
    };

    let body: string | undefined;
    if (method === "POST") {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = opts.body instanceof URLSearchParams ? opts.body.toString() : "";
    }
    if (opts.idempotencyKey && opts.idempotencyKey.trim() !== "") {
      headers["Idempotency-Key"] = opts.idempotencyKey.trim();
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Stripe network failure";
      throw new StripeGatewayError("ML_STRIPE_NETWORK", message, true, null, null);
    }

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
      const stripeMessage = (extractStripeErrorMessage(parsed) ?? response.statusText) || "Stripe request failed";
      const transient = response.status >= 500 || response.status === 429;
      throw new StripeGatewayError(
        mapStripeHttpStatusToCode(response.status),
        stripeMessage,
        transient,
        response.status,
        parsed,
      );
    }

    return parsed;
  }
}

function toPaymentIntentRecord(payload: unknown): StripePaymentIntentRecord {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new StripeGatewayError("ML_STRIPE_BAD_RESPONSE", "Stripe returned an invalid payment_intent payload.", true, null, payload);
  }

  const row = payload as Record<string, unknown>;
  const id = normalizeRequiredString(row.id, "stripe.payment_intent.id");
  const object = String(row.object ?? "").trim();
  if (object !== "payment_intent") {
    throw new StripeGatewayError("ML_STRIPE_BAD_RESPONSE", "Stripe object is not a payment_intent.", true, null, payload);
  }

  const metadata: Record<string, string> = {};
  const rawMetadata = row.metadata;
  if (rawMetadata && typeof rawMetadata === "object" && !Array.isArray(rawMetadata)) {
    for (const [key, value] of Object.entries(rawMetadata as Record<string, unknown>)) {
      if (typeof value === "string") {
        metadata[key] = value;
      }
    }
  }

  return {
    id,
    object: "payment_intent",
    status: String(row.status ?? "").trim(),
    amount: typeof row.amount === "number" && Number.isFinite(row.amount) ? Math.trunc(row.amount) : null,
    currency: typeof row.currency === "string" ? row.currency.trim().toLowerCase() : null,
    metadata,
    client_secret: typeof row.client_secret === "string" ? row.client_secret : null,
    next_action: Object.prototype.hasOwnProperty.call(row, "next_action") ? row.next_action : null,
  };
}

function mapStripeHttpStatusToCode(status: number): string {
  if (status === 400) return "ML_STRIPE_BAD_REQUEST";
  if (status === 401 || status === 403) return "ML_STRIPE_AUTH_FAILED";
  if (status === 404) return "ML_STRIPE_NOT_FOUND";
  if (status === 409) return "ML_STRIPE_CONFLICT";
  if (status === 429) return "ML_STRIPE_RATE_LIMIT";
  if (status >= 500) return "ML_STRIPE_UPSTREAM_DOWN";
  return "ML_STRIPE_HTTP_ERROR";
}

function extractStripeErrorMessage(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return typeof parsed === "string" && parsed.trim() !== "" ? parsed.trim() : null;
  }

  const errorNode = (parsed as Record<string, unknown>).error;
  if (errorNode && typeof errorNode === "object" && !Array.isArray(errorNode)) {
    const message = (errorNode as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim() !== "") {
      return message.trim();
    }
  }

  return null;
}

function normalizeRequiredString(value: unknown, field: string): string {
  const text = String(value ?? "").trim();
  if (text === "") {
    throw new StripeGatewayError("ML_STRIPE_BAD_INPUT", `${field} is required`, false, null, { field });
  }
  return text;
}

function timingSafeHexEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}
