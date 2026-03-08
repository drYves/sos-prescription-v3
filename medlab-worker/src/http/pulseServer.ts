import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { signMls1 } from '../security/mls1.js';

export function startPulseServer(port = Number(process.env['PORT'] ?? '3000')): void {
  const secret = process.env['ML_HMAC_SECRET'] ?? '';

  const server = createServer((req, res) => {
    if (req.url !== '/pulse') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    const payload = Buffer.from(JSON.stringify({ schema_version: '2026.5', ts_ms: Date.now(), nonce: randomBytes(8).toString('base64url'), status: 'ok' }));
    res.setHeader('content-type', 'application/json');
    res.setHeader('x-medlab-signature', signMls1(payload, secret));
    res.end(payload);
  });

  server.listen(port, '0.0.0.0');
}
