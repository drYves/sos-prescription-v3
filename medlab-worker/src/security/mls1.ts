import crypto from "node:crypto";

export interface Mls1TokenParts {
  payloadBytes: Buffer;
  sigHex: string;
  payloadB64Url: string;
}

export interface CanonicalGet {
  method: "GET";
  path: string;
  tsMs: number;
  nonce: string;
}

export function parseMls1Token(headerValue: string): Mls1TokenParts | null {
  const parts = headerValue.split(".");
  if (parts.length !== 3) return null;
  if (parts[0] !== "mls1") return null;

  const payloadB64Url = parts[1];
  const sigHex = parts[2];

  if (!/^[0-9a-f]{64}$/i.test(sigHex)) return null;

  const payloadBytes = base64UrlDecode(payloadB64Url);
  if (!payloadBytes) return null;

  return { payloadBytes, sigHex: sigHex.toLowerCase(), payloadB64Url };
}

export function verifyMls1Payload(
  payloadBytes: Buffer,
  sigHex: string,
  secretCandidates: string[],
): boolean {
  for (const secret of secretCandidates) {
    const expectedHex = crypto.createHmac("sha256", secret).update(payloadBytes).digest("hex");
    if (timingSafeEqualHex(expectedHex, sigHex)) return true;
  }
  return false;
}

export function buildMls1Token(payloadBytes: Buffer, secret: string): string {
  const b64 = base64UrlEncode(payloadBytes);
  const sigHex = crypto.createHmac("sha256", secret).update(payloadBytes).digest("hex");
  return `mls1.${b64}.${sigHex}`;
}

export function parseCanonicalGet(payloadBytes: Buffer): CanonicalGet | null {
  const s = payloadBytes.toString("utf8");
  const parts = s.split("|");
  if (parts.length !== 4) return null;
  if (parts[0] !== "GET") return null;

  const path = parts[1];
  const tsMs = Number(parts[2]);
  const nonce = parts[3];

  if (!Number.isFinite(tsMs) || tsMs <= 0) return null;
  if (!nonce || nonce.length < 8) return null;

  return { method: "GET", path, tsMs, nonce };
}

export function base64UrlEncode(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlDecode(b64url: string): Buffer | null {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64url.length + 3) % 4);
  try {
    return Buffer.from(b64, "base64");
  } catch (_err) {
    return null;
  }
}

function timingSafeEqualHex(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, "utf8");
  const b = Buffer.from(bHex, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
