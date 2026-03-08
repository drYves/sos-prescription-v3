import { inspect } from "node:util";

export type Severity = "info" | "warning" | "error" | "critical";

export interface LoggerContext {
  [k: string]: unknown;
}

export class NdjsonLogger {
  constructor(
    private readonly component: "worker" | "cron" | "web",
    private readonly siteId: string,
    private readonly env: string,
  ) {}

  log(severity: Severity, event: string, context: LoggerContext = {}, reqId?: string): void {
    const tsMs = Date.now();
    const ts = new Date(tsMs).toISOString();

    const record: Record<string, unknown> = {
      ts,
      ts_ms: tsMs,
      severity,
      component: this.component,
      service: "sosprescription",
      site_id: this.siteId,
      env: this.env,
      event,
    };

    if (reqId) record.req_id = reqId;

    const mem = process.memoryUsage();
    record.mem = {
      rss_mb: Math.round(mem.rss / 1024 / 1024),
      heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
    };

    record.context = sanitizeContext(context);

    process.stderr.write(`${JSON.stringify(record)}\n`);
  }

  info(event: string, context?: LoggerContext, reqId?: string): void {
    this.log("info", event, context, reqId);
  }

  warning(event: string, context?: LoggerContext, reqId?: string): void {
    this.log("warning", event, context, reqId);
  }

  error(event: string, context?: LoggerContext, reqId?: string): void {
    this.log("error", event, context, reqId);
  }

  critical(event: string, context?: LoggerContext, reqId?: string): void {
    this.log("critical", event, context, reqId);
  }
}

function sanitizeContext(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeContext);

  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (shouldRedactKey(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = sanitizeContext(v);
      }
    }
    return out;
  }

  if (typeof value === "string") return redactStringPatterns(truncate(value, 500));
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;

  return truncate(inspect(value), 500);
}

function shouldRedactKey(key: string): boolean {
  const k = key.toLowerCase();
  const needles = [
    "patient", "prenom", "nom", "name", "firstname", "lastname",
    "email", "mail", "phone", "tel", "address", "adresse",
    "dob", "birth", "naissance",
    "ssn", "nss",
    "token", "authorization", "cookie", "session",
    "password", "secret", "apikey", "access_key", "secret_key",
    "signature", "hmac",
    "ocr", "raw_text", "html", "body",
  ];
  return needles.some((n) => k === n || k.includes(n));
}

function redactStringPatterns(s: string): string {
  let out = s.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL]");
  out = out.replace(/\b(?:\+33|0)[1-9](?:[\s.\-]?\d{2}){4}\b/g, "[PHONE]");
  out = out.replace(/\b[a-f0-9]{32,}\b/gi, "[HEX]");
  return out;
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}…[truncated]`;
}
