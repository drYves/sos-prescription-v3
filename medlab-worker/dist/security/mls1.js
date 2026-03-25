"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseMls1Token = parseMls1Token;
exports.verifyMls1Payload = verifyMls1Payload;
exports.buildMls1Token = buildMls1Token;
exports.parseCanonicalGet = parseCanonicalGet;
exports.base64UrlEncode = base64UrlEncode;
exports.base64UrlDecode = base64UrlDecode;
const node_crypto_1 = __importDefault(require("node:crypto"));
function parseMls1Token(headerValue) {
    const parts = headerValue.split(".");
    if (parts.length !== 3)
        return null;
    if (parts[0] !== "mls1")
        return null;
    const payloadB64Url = parts[1];
    const sigHex = parts[2];
    if (!/^[0-9a-f]{64}$/i.test(sigHex))
        return null;
    const payloadBytes = base64UrlDecode(payloadB64Url);
    if (!payloadBytes)
        return null;
    return { payloadBytes, sigHex: sigHex.toLowerCase(), payloadB64Url };
}
function verifyMls1Payload(payloadBytes, sigHex, secretCandidates) {
    for (const secret of secretCandidates) {
        const expectedHex = node_crypto_1.default.createHmac("sha256", secret).update(payloadBytes).digest("hex");
        if (timingSafeEqualHex(expectedHex, sigHex))
            return true;
    }
    return false;
}
function buildMls1Token(payloadBytes, secret) {
    const b64 = base64UrlEncode(payloadBytes);
    const sigHex = node_crypto_1.default.createHmac("sha256", secret).update(payloadBytes).digest("hex");
    return `mls1.${b64}.${sigHex}`;
}
function parseCanonicalGet(payloadBytes) {
    const s = payloadBytes.toString("utf8");
    const parts = s.split("|");
    if (parts.length !== 4)
        return null;
    if (parts[0] !== "GET")
        return null;
    const path = parts[1];
    const tsMs = Number(parts[2]);
    const nonce = parts[3];
    if (!Number.isFinite(tsMs) || tsMs <= 0)
        return null;
    if (!nonce || nonce.length < 8)
        return null;
    return { method: "GET", path, tsMs, nonce };
}
function base64UrlEncode(bytes) {
    return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function base64UrlDecode(b64url) {
    const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64url.length + 3) % 4);
    try {
        return Buffer.from(b64, "base64");
    }
    catch (_err) {
        return null;
    }
}
function timingSafeEqualHex(aHex, bHex) {
    const a = Buffer.from(aHex, "utf8");
    const b = Buffer.from(bHex, "utf8");
    if (a.length !== b.length)
        return false;
    return node_crypto_1.default.timingSafeEqual(a, b);
}
