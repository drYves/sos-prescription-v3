/// <reference lib="dom" />
// src/pdf/pdfRenderer.ts
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { URL } from "node:url";
import puppeteer, { Browser, BrowserContext, HTTPResponse, Page } from "puppeteer-core";

import { MemoryGuard } from "../admission/memoryGuard";
import { HardError } from "../jobs/errors";
import { NdjsonLogger } from "../logger";
import { buildMls1Token } from "../security/mls1";

export interface PdfRenderInput {
  siteId: string;
  wpBaseUrl: string;
  renderPathTemplate: string;
  hmacSecret: string;
  workerId: string;
  jobId: string;
  rxId: number;
  reqId?: string;
  chromeExecutablePath: string;
  renderTimeoutMs: number;
  readyTimeoutMs: number;
  memGuard: MemoryGuard;
  admissionMaxMb: number;
}

export interface PdfRenderResult {
  filePath: string;
  sha256Hex: string;
  sizeBytes: number;
  contentType: "application/pdf";
}

export class PdfRenderer {
  constructor(private readonly logger: NdjsonLogger) {}

  async renderToTmpPdf(input: PdfRenderInput): Promise<PdfRenderResult> {
    const startedAt = Date.now();

    if (input.rxId <= 0) {
      throw new HardError("ML_PDF_BAD_RX_ID", "Invalid rx_id");
    }

    input.memGuard.tick();
    if (input.memGuard.rssMb() >= input.admissionMaxMb) {
      throw new HardError("ML_ADMISSION_OVERLOAD", "Admission overload");
    }

    const tmpRoot = "/tmp/sosprescription-pdf";
    await safeMkdir(tmpRoot);

    const tmpPdfPath = path.join(tmpRoot, `${input.jobId}.pdf.tmp`);
    const pdfPath = path.join(tmpRoot, `${input.jobId}.pdf`);

    await safeUnlink(tmpPdfPath);
    await safeUnlink(pdfPath);

    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let page: Page | null = null;

    let abortedByOverload = false;
    const memTimer = setInterval(() => {
      const rss = Math.round(process.memoryUsage().rss / 1024 / 1024);
      if (rss >= input.admissionMaxMb) {
        abortedByOverload = true;
      }
    }, 250);
    memTimer.unref();

    try {
      this.logger.info(
        "pdf.render.started",
        {
          job_id: input.jobId,
          rx_id: input.rxId,
          worker_id: input.workerId,
        },
        input.reqId,
      );

      browser = await puppeteer.launch({
        executablePath: input.chromeExecutablePath,
        headless: true,
        args: chromeArgs(),
        userDataDir: path.join("/tmp", `medlab-chrome-${sanitizeId(input.workerId)}`),
      });

      context = await browser.createBrowserContext();
      page = await context.newPage();

      await page.setCacheEnabled(false);
      await page.emulateMediaType("print");
      await page.setViewport({ width: 1240, height: 1754, deviceScaleFactor: 2 });

      const renderPath = input.renderPathTemplate.replace("{rx_id}", String(input.rxId));
      const tsMs = Date.now();
      const nonce = base64Url(randomBytes(16));
      const canonical = `GET|${renderPath}|${tsMs}|${nonce}`;
      const token = buildMls1Token(Buffer.from(canonical, "utf8"), input.hmacSecret);
      const renderUrl = input.wpBaseUrl + renderPath;
      const allowedOrigin = new URL(input.wpBaseUrl).origin;

      await page.setRequestInterception(true);
      page.on("request", (req) => {
        try {
          const u = new URL(req.url());

          if (u.protocol === "data:" || u.protocol === "blob:") {
            return req.continue();
          }

          if (u.origin !== allowedOrigin) {
            this.logger.warning("pdf.render.blocked_request", { origin: u.origin }, input.reqId);
            return req.abort();
          }

          if (req.isNavigationRequest() && u.pathname === new URL(renderUrl).pathname) {
            const headers = { ...req.headers(), "x-medlab-signature": token };
            return req.continue({ headers });
          }

          return req.continue();
        } catch (_err) {
          return req.abort();
        }
      });

      await withTimeout(async () => {
        const navResponse = await page!.goto(renderUrl, { waitUntil: "networkidle0" });

        await assertDocumentIsRenderable(page!, navResponse, renderUrl);

        await page!.evaluate(`
          (async () => {
            if (document.fonts && document.fonts.ready) {
              await document.fonts.ready;
            }
          })();
        `);

        try {
          await page!.waitForFunction(
            `globalThis.__ML_PDF_READY__ === true || document.querySelector("[data-ml-pdf-ready='1']") !== null`,
            { timeout: input.readyTimeoutMs },
          );
        } catch (_err) {
          await new Promise((resolve) => setTimeout(resolve, 150));
        }

        await assertDocumentIsRenderable(page!, navResponse, renderUrl);

        if (abortedByOverload) {
          throw new HardError("ML_ADMISSION_OVERLOAD", "Admission overload");
        }

        await page!.pdf({
          path: tmpPdfPath,
          format: "A4",
          printBackground: true,
          displayHeaderFooter: false,
          preferCSSPageSize: true,
          margin: { top: "0", right: "0", bottom: "0", left: "0" },
        });
      }, input.renderTimeoutMs);

      if (abortedByOverload) {
        throw new HardError("ML_ADMISSION_OVERLOAD", "Admission overload");
      }

      await safeUnlink(pdfPath);
      await fsp.rename(tmpPdfPath, pdfPath);

      await verifyPdfHeader(pdfPath);
      const { sha256Hex, sizeBytes } = await sha256File(pdfPath);

      this.logger.info(
        "pdf.render.completed",
        {
          job_id: input.jobId,
          rx_id: input.rxId,
          size_bytes: sizeBytes,
          duration_ms: Date.now() - startedAt,
        },
        input.reqId,
      );

      return {
        filePath: pdfPath,
        sha256Hex,
        sizeBytes,
        contentType: "application/pdf",
      };
    } catch (err) {
      if (abortedByOverload) {
        this.logger.critical(
          "pdf.render.aborted_overload",
          {
            job_id: input.jobId,
            rx_id: input.rxId,
            rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
          },
          input.reqId,
        );

        await hardKillBrowser(browser, this.logger, input.reqId);
        throw new HardError("ML_ADMISSION_OVERLOAD", "Admission overload");
      }

      this.logger.error(
        "pdf.render.failed",
        {
          job_id: input.jobId,
          rx_id: input.rxId,
        },
        input.reqId,
      );

      await hardKillBrowser(browser, this.logger, input.reqId);
      throw err;
    } finally {
      clearInterval(memTimer);
      await safeClose(page);
      await safeClose(context);
      await safeClose(browser);
      await safeUnlink(tmpPdfPath);
    }
  }
}

async function assertDocumentIsRenderable(
  page: Page,
  response: HTTPResponse | null,
  expectedUrl: string,
): Promise<void> {
  const status = response?.status() ?? 0;
  if (status >= 400) {
    throw new HardError("ML_PDF_WAF_BLOCKED", `Render blocked upstream (HTTP ${status})`);
  }

  const probe = await page.evaluate(() => {
    const title = typeof document.title === "string" ? document.title : "";
    const bodyText =
      (document.body && typeof document.body.innerText === "string" ? document.body.innerText : "") ||
      (document.documentElement && typeof document.documentElement.innerText === "string"
        ? document.documentElement.innerText
        : "");

    return {
      href: location.href,
      title,
      bodyText: bodyText.slice(0, 4000),
      readyGlobal: (globalThis as any).__ML_PDF_READY__ === true,
      readyMarker: !!document.querySelector("[data-ml-pdf-ready='1']"),
    };
  });

  const normalized = normalizeProbeText(`${probe.title}\n${probe.bodyText}`);

  const wafMarkers = [
    "403 forbidden",
    "access denied",
    "access to this page has been denied",
    "request forbidden",
    "verify you are human",
    "security check",
    "web application firewall",
    "your request has been blocked",
    "automated queries",
    "bot detection",
    "bot detected",
    "litespeed",
    "hostinger",
    "captcha",
  ];

  if (wafMarkers.some((marker) => normalized.includes(marker))) {
    throw new HardError("ML_PDF_WAF_BLOCKED", "Render blocked by upstream WAF");
  }

  const expectedPath = normalizePathname(pathFromUrlSafe(expectedUrl));
  const actualPath = normalizePathname(pathFromUrlSafe(probe.href));

  if (expectedPath !== "" && actualPath !== "" && expectedPath !== actualPath) {
    if (!probe.readyGlobal && !probe.readyMarker) {
      throw new HardError("ML_PDF_WAF_BLOCKED", "Render redirected away from expected document");
    }
  }
}

function pathFromUrlSafe(value: string): string {
  try {
    return new URL(value).pathname || "";
  } catch (_err) {
    return "";
  }
}

function normalizePathname(value: string): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (trimmed === "/") return "/";
  return trimmed.replace(/\/+$/, "");
}

function normalizeProbeText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function chromeArgs(): string[] {
  return [
    "--disable-gpu",
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-breakpad",
    "--disable-component-update",
    "--disable-sync",
    "--disable-notifications",
    "--metrics-recording-only",
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "--mute-audio",
    "--disk-cache-size=0",
    "--safebrowsing-disable-auto-update",
  ];
}

async function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  const timeout = Math.max(1000, timeoutMs);
  return await Promise.race([
    fn(),
    new Promise<T>((_resolve, reject) => {
      const t = setTimeout(() => reject(new HardError("ML_PDF_TIMEOUT", "PDF render timeout")), timeout);
      (t as any).unref?.();
    }),
  ]);
}

async function verifyPdfHeader(filePath: string): Promise<void> {
  const fh = await fsp.open(filePath, "r");
  try {
    const buf = Buffer.alloc(5);
    await fh.read(buf, 0, 5, 0);
    if (buf.toString("utf8") !== "%PDF-") {
      throw new HardError("ML_PDF_CORRUPT", "Invalid PDF header");
    }
  } finally {
    await fh.close();
  }
}

async function sha256File(filePath: string): Promise<{ sha256Hex: string; sizeBytes: number }> {
  const st = await fsp.stat(filePath);
  if (st.size <= 0) {
    throw new HardError("ML_PDF_EMPTY", "Empty PDF file");
  }

  return await new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    const rs = fs.createReadStream(filePath);

    rs.on("data", (chunk) => h.update(chunk));
    rs.on("error", () => reject(new HardError("ML_PDF_READ_FAILED", "Failed to read PDF")));
    rs.on("end", () => {
      resolve({ sha256Hex: h.digest("hex"), sizeBytes: st.size });
    });
  });
}

async function hardKillBrowser(browser: Browser | null, logger: NdjsonLogger, reqId?: string): Promise<void> {
  if (!browser) return;

  try {
    await Promise.race([
      browser.close(),
      new Promise<void>((resolve) => setTimeout(resolve, 1500)),
    ]);
  } catch (_err) {
    // noop
  }

  try {
    const proc = browser.process();
    const pid = proc?.pid;
    if (pid && pid > 1) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (_err) {
        // noop
      }
      logger.warning("pdf.chrome.killed", { pid }, reqId);
    }
  } catch (_err) {
    // noop
  }
}

async function safeClose(obj: any): Promise<void> {
  if (!obj) return;
  try {
    await obj.close();
  } catch (_err) {
    // noop
  }
}

async function safeMkdir(dir: string): Promise<void> {
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (_err) {
    // noop
  }
}

async function safeUnlink(p: string): Promise<void> {
  try {
    await fsp.unlink(p);
  } catch (_err) {
    // noop
  }
}

function randomBytes(n: number): Buffer {
  return crypto.randomBytes(n);
}

function base64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function sanitizeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 64);
}
