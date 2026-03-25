// src/pdf/pdfRenderer.ts
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import puppeteer, { Browser, BrowserContext, Page } from "puppeteer";

import { MemoryGuard } from "../admission/memoryGuard";
import { HardError } from "../jobs/errors";
import { NdjsonLogger } from "../logger";

export interface PdfRenderInput {
  mode: "inline-html" | "remote-wordpress";
  html?: string;
  templateName?: string;
  siteId?: string;
  wpBaseUrl?: string;
  renderPathTemplate?: string;
  hmacSecret?: string;
  workerId: string;
  jobId: string;
  rxId?: number;
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

    if (input.mode === "remote-wordpress" && (!input.rxId || input.rxId <= 0)) {
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

    const safeWorkerId = sanitizeId(input.workerId || "worker");
    const safeJobId = sanitizeId(input.jobId || "job");
    const userDir = path.join("/tmp", `medlab-chrome-${safeWorkerId}-${safeJobId}`);

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
          render_mode: input.mode,
        },
        input.reqId,
      );

      const safeExecutablePath = input.chromeExecutablePath && fs.existsSync(input.chromeExecutablePath)
        ? input.chromeExecutablePath
        : undefined;

      browser = await puppeteer.launch({
        executablePath: safeExecutablePath,
        headless: true,
        args: chromeArgs(),
        userDataDir: userDir,
      });

      context = await browser.createBrowserContext();
      page = await context.newPage();

      await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
      await page.setExtraHTTPHeaders({
        "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Ch-Ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
      });
      await page.evaluateOnNewDocument(`
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      `);

      await page.setCacheEnabled(false);
      await page.emulateMediaType("print");
      await page.setViewport({ width: 1240, height: 1754, deviceScaleFactor: 2 });

      await withTimeout(async () => {
        if (input.mode === "inline-html" && input.html) {
          await page!.setContent(input.html, { waitUntil: ["load", "networkidle0"] });
        } else {
          throw new HardError("ML_PDF_MODE_ERROR", "Remote rendering is disabled. Only inline-html is supported.");
        }

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
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 150));
        }

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
          error_message: err instanceof Error ? err.message : String(err),
          error_stack: err instanceof Error ? err.stack : undefined,
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
      await safeRmDir(userDir);
    }
  }
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
      (t as { unref?: () => void }).unref?.();
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
  } catch {
    // noop
  }

  try {
    const proc = browser.process();
    const pid = proc?.pid;
    if (pid && pid > 1) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // noop
      }
      logger.warning("pdf.chrome.killed", { pid }, reqId);
    }
  } catch {
    // noop
  }
}

async function safeClose(obj: { close?: () => Promise<unknown> } | null): Promise<void> {
  if (!obj?.close) return;
  try {
    await obj.close();
  } catch {
    // noop
  }
}

async function safeMkdir(dir: string): Promise<void> {
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch {
    // noop
  }
}

async function safeUnlink(p: string): Promise<void> {
  try {
    await fsp.unlink(p);
  } catch {
    // noop
  }
}

async function safeRmDir(dir: string): Promise<void> {
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch {
    // noop
  }
}

function sanitizeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 64);
}
