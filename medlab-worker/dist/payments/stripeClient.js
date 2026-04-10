"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.StripeGateway = exports.StripeGatewayError = void 0;
const node_crypto_1 = __importDefault(require("node:crypto"));
class StripeGatewayError extends Error {
    code;
    statusCode;
    transient;
    responseBody;
    constructor(code, message, transient, statusCode = null, responseBody = null) {
        super(message);
        this.name = "StripeGatewayError";
        this.code = code;
        this.statusCode = statusCode;
        this.transient = transient;
        this.responseBody = responseBody;
    }
}
exports.StripeGatewayError = StripeGatewayError;
class StripeGateway {
    secretKey;
    webhookSecret;
    apiBaseUrl;
    constructor(cfg = {}) {
        this.secretKey = String(cfg.secretKey ?? process.env.STRIPE_SECRET_KEY ?? "").trim();
        this.webhookSecret = String(cfg.webhookSecret ?? process.env.STRIPE_WEBHOOK_SECRET ?? "").trim();
        this.apiBaseUrl = String(cfg.apiBaseUrl ?? "https://api.stripe.com/v1").trim().replace(/\/+$/g, "");
    }
    isEnabled() {
        return this.secretKey !== "";
    }
    hasWebhookSecret() {
        return this.webhookSecret !== "";
    }
    async retrievePaymentIntent(paymentIntentId) {
        const id = normalizeRequiredString(paymentIntentId, "paymentIntentId");
        const payload = await this.requestJson("GET", `/payment_intents/${encodeURIComponent(id)}`);
        return toPaymentIntentRecord(payload);
    }
    async capturePaymentIntent(paymentIntentId, idempotencyKey) {
        const id = normalizeRequiredString(paymentIntentId, "paymentIntentId");
        const payload = await this.requestJson("POST", `/payment_intents/${encodeURIComponent(id)}/capture`, {
            idempotencyKey,
            body: new URLSearchParams(),
        });
        return toPaymentIntentRecord(payload);
    }
    async cancelPaymentIntent(paymentIntentId, idempotencyKey) {
        const id = normalizeRequiredString(paymentIntentId, "paymentIntentId");
        const payload = await this.requestJson("POST", `/payment_intents/${encodeURIComponent(id)}/cancel`, {
            idempotencyKey,
            body: new URLSearchParams(),
        });
        return toPaymentIntentRecord(payload);
    }
    verifyWebhookSignature(rawBody, signatureHeader, toleranceSeconds = 300) {
        if (!Buffer.isBuffer(rawBody) || rawBody.length < 1) {
            return false;
        }
        const secret = this.webhookSecret;
        const header = String(signatureHeader ?? "").trim();
        if (secret === "" || header === "") {
            return false;
        }
        let timestamp = 0;
        const signatures = [];
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
        const expected = node_crypto_1.default.createHmac("sha256", secret).update(signedPayload).digest("hex").toLowerCase();
        return signatures.some((candidate) => timingSafeHexEqual(candidate, expected));
    }
    async requestJson(method, path, opts = {}) {
        if (!this.isEnabled()) {
            throw new StripeGatewayError("ML_STRIPE_DISABLED", "Stripe is not configured.", false, null, null);
        }
        const url = `${this.apiBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;
        const headers = {
            Authorization: `Bearer ${this.secretKey}`,
            Accept: "application/json",
        };
        let body;
        if (method === "POST") {
            headers["Content-Type"] = "application/x-www-form-urlencoded";
            body = opts.body instanceof URLSearchParams ? opts.body.toString() : "";
        }
        if (opts.idempotencyKey && opts.idempotencyKey.trim() !== "") {
            headers["Idempotency-Key"] = opts.idempotencyKey.trim();
        }
        let response;
        try {
            response = await fetch(url, {
                method,
                headers,
                body,
            });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : "Stripe network failure";
            throw new StripeGatewayError("ML_STRIPE_NETWORK", message, true, null, null);
        }
        const rawText = await response.text();
        let parsed = null;
        if (rawText.trim() !== "") {
            try {
                parsed = JSON.parse(rawText);
            }
            catch {
                parsed = rawText;
            }
        }
        if (!response.ok) {
            const stripeMessage = (extractStripeErrorMessage(parsed) ?? response.statusText) || "Stripe request failed";
            const transient = response.status >= 500 || response.status === 429;
            throw new StripeGatewayError(mapStripeHttpStatusToCode(response.status), stripeMessage, transient, response.status, parsed);
        }
        return parsed;
    }
}
exports.StripeGateway = StripeGateway;
function toPaymentIntentRecord(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new StripeGatewayError("ML_STRIPE_BAD_RESPONSE", "Stripe returned an invalid payment_intent payload.", true, null, payload);
    }
    const row = payload;
    const id = normalizeRequiredString(row.id, "stripe.payment_intent.id");
    const object = String(row.object ?? "").trim();
    if (object !== "payment_intent") {
        throw new StripeGatewayError("ML_STRIPE_BAD_RESPONSE", "Stripe object is not a payment_intent.", true, null, payload);
    }
    const metadata = {};
    const rawMetadata = row.metadata;
    if (rawMetadata && typeof rawMetadata === "object" && !Array.isArray(rawMetadata)) {
        for (const [key, value] of Object.entries(rawMetadata)) {
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
function mapStripeHttpStatusToCode(status) {
    if (status === 400)
        return "ML_STRIPE_BAD_REQUEST";
    if (status === 401 || status === 403)
        return "ML_STRIPE_AUTH_FAILED";
    if (status === 404)
        return "ML_STRIPE_NOT_FOUND";
    if (status === 409)
        return "ML_STRIPE_CONFLICT";
    if (status === 429)
        return "ML_STRIPE_RATE_LIMIT";
    if (status >= 500)
        return "ML_STRIPE_UPSTREAM_DOWN";
    return "ML_STRIPE_HTTP_ERROR";
}
function extractStripeErrorMessage(parsed) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return typeof parsed === "string" && parsed.trim() !== "" ? parsed.trim() : null;
    }
    const errorNode = parsed.error;
    if (errorNode && typeof errorNode === "object" && !Array.isArray(errorNode)) {
        const message = errorNode.message;
        if (typeof message === "string" && message.trim() !== "") {
            return message.trim();
        }
    }
    return null;
}
function normalizeRequiredString(value, field) {
    const text = String(value ?? "").trim();
    if (text === "") {
        throw new StripeGatewayError("ML_STRIPE_BAD_INPUT", `${field} is required`, false, null, { field });
    }
    return text;
}
function timingSafeHexEqual(left, right) {
    const a = Buffer.from(left, "utf8");
    const b = Buffer.from(right, "utf8");
    if (a.length !== b.length) {
        return false;
    }
    return node_crypto_1.default.timingSafeEqual(a, b);
}
