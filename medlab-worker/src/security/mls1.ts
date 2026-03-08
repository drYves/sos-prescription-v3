import { createHmac, timingSafeEqual } from 'node:crypto';

const b64url = (raw: Buffer): string => raw.toString('base64url');

export type Mls1Claims = { ts_ms: number; nonce: string; req_id?: string };

export function signMls1(rawBody: Buffer, secret: string): string {
  const sig = createHmac('sha256', secret).update(rawBody).digest('hex');
  return `mls1.${b64url(rawBody)}.${sig}`;
}

export function verifyMls1(rawBody: Buffer, token: string, activeSecret: string, previousSecret?: string): boolean {
  const [prefix, payload, sigHex] = token.split('.');
  if (prefix !== 'mls1' || !payload || !sigHex || !/^[0-9a-f]{64}$/i.test(sigHex)) return false;

  const decoded = Buffer.from(payload, 'base64url');
  if (!timingSafeEqual(decoded, rawBody)) return false;

  const expected = Buffer.from(createHmac('sha256', activeSecret).update(rawBody).digest('hex'));
  const candidate = Buffer.from(sigHex.toLowerCase());
  if (timingSafeEqual(expected, candidate)) return true;

  if (previousSecret) {
    const rotated = Buffer.from(createHmac('sha256', previousSecret).update(rawBody).digest('hex'));
    if (timingSafeEqual(rotated, candidate)) return true;
  }

  return false;
}
