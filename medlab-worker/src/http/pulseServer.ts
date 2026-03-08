import http from "node:http";
import { URL } from "node:url";
import { MemoryGuard } from "../admission/memoryGuard";
import { JobsRepo } from "../db/jobsRepo";
import { NdjsonLogger } from "../logger";
import { parseMls1Token, parseCanonicalGet, verifyMls1Payload } from "../security/mls1";
import { NonceCache } from "../security/nonceCache";

export interface PulseServerDeps {
  port: number;
  siteId: string;
  workerId: string;
  jobsRepo: JobsRepo;
  memGuard: MemoryGuard;
  nonceCache: NonceCache;
  secrets: string[];
  skewWindowMs: number;
  logger: NdjsonLogger;
}

export function startPulseServer(deps: PulseServerDeps): http.Server {
  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (method === "GET" && path === "/pulse") {
        const rawSig = req.headers["x-medlab-signature"];
        const sigHeader = Array.isArray(rawSig) ? rawSig[0] ?? "" : rawSig ?? "";
        const parsed = parseMls1Token(sigHeader);
        if (!parsed) {
          return json(res, 401, { ok: false, code: "ML_AUTH_MISSING" });
        }

        const okSig = verifyMls1Payload(parsed.payloadBytes, parsed.sigHex, deps.secrets);
        if (!okSig) {
          deps.logger.warning("security.mls1.rejected", { reason: "bad_signature", path }, undefined);
          return json(res, 401, { ok: false, code: "ML_AUTH_INVALID_SIG" });
        }

        const canon = parseCanonicalGet(parsed.payloadBytes);
        if (!canon) {
          return json(res, 400, { ok: false, code: "ML_AUTH_BAD_PAYLOAD" });
        }

        if (canon.method !== "GET" || canon.path !== "/pulse") {
          return json(res, 403, { ok: false, code: "ML_AUTH_SCOPE_DENIED" });
        }

        const now = Date.now();
        const skew = Math.abs(now - canon.tsMs);
        if (skew > deps.skewWindowMs) {
          deps.logger.warning("security.mls1.rejected", { reason: "ts_ms_skew", skew_ms: skew }, undefined);
          return json(res, 401, { ok: false, code: "ML_AUTH_EXPIRED" });
        }

        const isNew = deps.nonceCache.checkAndStore(canon.nonce, now);
        if (!isNew) {
          deps.logger.warning("security.mls1.rejected", { reason: "replay", nonce: "[REDACTED]" }, undefined);
          return json(res, 409, { ok: false, code: "ML_AUTH_REPLAY" });
        }

        deps.memGuard.tick();
        const rssMb = deps.memGuard.rssMb();
        const state = deps.memGuard.getState();
        const queue = await deps.jobsRepo.getQueueMetrics(deps.siteId);

        return json(res, 200, {
          ok: true,
          schema_version: "2026.5",
          server_time_ms: now,
          worker_id: deps.workerId,
          state,
          rss_mb: rssMb,
          queue,
        });
      }

      return json(res, 404, { ok: false, code: "NOT_FOUND" });
    } catch (_err) {
      deps.logger.error("pulse.unhandled_error", { message: "Unhandled /pulse error" }, undefined);
      return json(res, 500, { ok: false, code: "INTERNAL_ERROR" });
    }
  });

  server.listen(deps.port, () => {
    deps.logger.info("system.pulse_server.listening", { port: deps.port, worker_id: deps.workerId }, undefined);
  });

  return server;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body));
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", data.length);
  res.end(data);
}
