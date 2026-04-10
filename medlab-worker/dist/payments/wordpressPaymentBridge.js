"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WordPressPaymentBridge = exports.WordPressPaymentBridgeError = void 0;
const node_crypto_1 = __importDefault(require("node:crypto"));
const mls1_1 = require("../security/mls1");
const CURRENT_SCHEMA_VERSION = "2026.6";
const DEFAULT_SYNC_PATH_TEMPLATE = "/wp-json/sosprescription/v1/prescriptions/{id}/payment/worker-sync";
class WordPressPaymentBridgeError extends Error {
    code;
    transient;
    statusCode;
    constructor(code, message, transient, statusCode = null) {
        super(message);
        this.name = "WordPressPaymentBridgeError";
        this.code = code;
        this.transient = transient;
        this.statusCode = statusCode;
    }
}
exports.WordPressPaymentBridgeError = WordPressPaymentBridgeError;
class WordPressPaymentBridge {
    wpBaseUrl;
    siteId;
    hmacSecret;
    syncPathTemplate;
    timeoutMs;
    constructor(cfg) {
        this.wpBaseUrl = normalizeBaseUrl(cfg.wpBaseUrl);
        this.siteId = String(cfg.siteId ?? "").trim();
        this.hmacSecret = String(cfg.hmacSecret ?? "").trim();
        this.syncPathTemplate = normalizePathTemplate(cfg.syncPathTemplate ?? DEFAULT_SYNC_PATH_TEMPLATE, DEFAULT_SYNC_PATH_TEMPLATE);
        this.timeoutMs = Math.max(1_000, Math.floor(cfg.timeoutMs ?? 15_000));
    }
    async syncAuthorizedIntent(wpPrescriptionId, payload) {
        const path = renderPathTemplate(this.syncPathTemplate, wpPrescriptionId);
        return this.postSignedJson(path, payload);
    }
    async postSignedJson(path, payload) {
        if (this.wpBaseUrl === "" || this.hmacSecret === "" || this.siteId === "") {
            throw new WordPressPaymentBridgeError("ML_WP_SYNC_DISABLED", "WordPress payment sync is not configured.", false, null);
        }
        const reqId = normalizeReqId(payload.reqId);
        const body = {
            schema_version: CURRENT_SCHEMA_VERSION,
            site_id: this.siteId,
            ts_ms: Date.now(),
            nonce: node_crypto_1.default.randomBytes(16).toString("hex"),
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
                "X-MedLab-Signature": (0, mls1_1.buildMls1Token)(Buffer.from(rawBody, "utf8"), this.hmacSecret),
            },
            body: rawBody,
            signal: AbortSignal.timeout(this.timeoutMs),
        }).catch((err) => {
            const message = err instanceof Error ? err.message : "WordPress sync request failed";
            throw new WordPressPaymentBridgeError("ML_WP_SYNC_NETWORK", message, true, null);
        });
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
            const message = (extractResponseMessage(parsed) ?? response.statusText) || "WordPress payment sync failed";
            const transient = response.status >= 500 || response.status === 429;
            throw new WordPressPaymentBridgeError("ML_WP_SYNC_HTTP", message, transient, response.status);
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return { ok: true };
        }
        return parsed;
    }
}
exports.WordPressPaymentBridge = WordPressPaymentBridge;
function normalizeBaseUrl(value) {
    return String(value ?? "").trim().replace(/\/+$/g, "");
}
function normalizePathTemplate(value, fallback) {
    const normalized = String(value ?? "").trim();
    if (normalized === "") {
        return fallback;
    }
    return normalized.startsWith("/") ? normalized : `/${normalized}`;
}
function renderPathTemplate(template, wpPrescriptionId) {
    return template.replace(/\{id\}/g, encodeURIComponent(String(wpPrescriptionId)));
}
function normalizeReqId(value) {
    const normalized = String(value ?? "").trim();
    return normalized !== "" ? normalized : `req_${node_crypto_1.default.randomBytes(8).toString("hex")}`;
}
function extractResponseMessage(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return typeof payload === "string" && payload.trim() !== "" ? payload.trim() : null;
    }
    const row = payload;
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
