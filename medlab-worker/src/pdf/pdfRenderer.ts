// src/pdf/pdfRenderer.ts
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import puppeteer, { Browser, Page } from "puppeteer";

import { MemoryGuard } from "../admission/memoryGuard";
import { HardError } from "../jobs/errors";
import { NdjsonLogger } from "../logger";

const BROWSER_LAUNCH_TIMEOUT_MS = 60_000;
const BROWSER_PROTOCOL_TIMEOUT_MS = 60_000;
const BROWSER_HEALTHCHECK_TIMEOUT_MS = 2_500;
const BROWSER_CLOSE_TIMEOUT_MS = 2_000;
const PAGE_CLOSE_TIMEOUT_MS = 1_500;

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
  doctorId?: string;
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
  private browser: Browser | null = null;
  private browserPromise: Promise<Browser> | null = null;
  private browserUserDir: string | null = null;

  constructor(private readonly logger: NdjsonLogger) {}

  async resetBrowser(reason = "manual_reset", reqId?: string): Promise<void> {
    const browser = this.browser;
    const userDir = this.browserUserDir;

    this.browser = null;
    this.browserPromise = null;
    this.browserUserDir = null;

    if (browser) {
      this.logger.warning(
        "pdf.chrome.reset",
        {
          reason,
          pid: browser.process()?.pid ?? null,
        },
        reqId,
      );

      await hardKillBrowser(browser, this.logger, reqId);
    }

    if (userDir) {
      await safeRmDir(userDir);
    }
  }

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
          doctor_id: input.doctorId,
          render_mode: input.mode,
        },
        input.reqId,
      );

      browser = await this.ensureBrowser(input, input.reqId);
      page = await browser.newPage();

      const pageTimeoutMs = Math.max(30_000, input.renderTimeoutMs, input.readyTimeoutMs);
      page.setDefaultNavigationTimeout(pageTimeoutMs);
      page.setDefaultTimeout(pageTimeoutMs);

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
            { timeout: Math.max(1_000, input.readyTimeoutMs) },
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
      }, input.renderTimeoutMs, () => new HardError("ML_PDF_TIMEOUT", "PDF render timeout"));

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
          doctor_id: input.doctorId,
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
            doctor_id: input.doctorId,
            rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
          },
          input.reqId,
        );

        await this.resetBrowser("admission_overload", input.reqId);
        throw new HardError("ML_ADMISSION_OVERLOAD", "Admission overload");
      }

      this.logger.error(
        "pdf.render.failed",
        {
          job_id: input.jobId,
          rx_id: input.rxId,
          doctor_id: input.doctorId,
          error_message: err instanceof Error ? err.message : String(err),
          error_stack: err instanceof Error ? err.stack : undefined,
        },
        input.reqId,
      );

      if (shouldResetBrowserAfterFailure(err)) {
        await this.resetBrowser("render_failed", input.reqId);
      }

      throw err;
    } finally {
      clearInterval(memTimer);
      await safeClose(page, PAGE_CLOSE_TIMEOUT_MS);
      await safeUnlink(tmpPdfPath);
    }
  }

  private async ensureBrowser(input: PdfRenderInput, reqId?: string): Promise<Browser> {
    if (this.browser) {
      const healthy = await this.isBrowserHealthy(this.browser, reqId);
      if (healthy) {
        this.logger.info(
          "pdf.chrome.reused",
          {
            worker_id: input.workerId,
            pid: this.browser.process()?.pid ?? null,
          },
          reqId,
        );
        return this.browser;
      }

      await this.resetBrowser("healthcheck_failed", reqId);
    }

    if (!this.browserPromise) {
      const safeWorkerId = sanitizeId(input.workerId || "worker");
      const userDir = path.join("/tmp", `medlab-chrome-${safeWorkerId}`);
      this.browserUserDir = userDir;
      this.browserPromise = this.launchBrowser(input, userDir, reqId);
    }

    return await this.browserPromise;
  }

  private async launchBrowser(input: PdfRenderInput, userDir: string, reqId?: string): Promise<Browser> {
    const safeExecutablePath = input.chromeExecutablePath && fs.existsSync(input.chromeExecutablePath)
      ? input.chromeExecutablePath
      : undefined;

    await safeRmDir(userDir);
    await safeMkdir(userDir);

    this.logger.info(
      "pdf.chrome.launching",
      {
        worker_id: input.workerId,
        job_id: input.jobId,
        executable_path_present: Boolean(safeExecutablePath),
        launch_timeout_ms: BROWSER_LAUNCH_TIMEOUT_MS,
        protocol_timeout_ms: BROWSER_PROTOCOL_TIMEOUT_MS,
      },
      reqId,
    );

    try {
      const browser = await puppeteer.launch({
        executablePath: safeExecutablePath,
        headless: true,
        pipe: true,
        timeout: BROWSER_LAUNCH_TIMEOUT_MS,
        protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
        args: chromeArgs(),
        userDataDir: userDir,
      });

      browser.on("disconnected", () => {
        if (this.browser === browser) {
          this.browser = null;
          this.browserPromise = null;
          this.logger.warning(
            "pdf.chrome.disconnected",
            {
              pid: browser.process()?.pid ?? null,
            },
            undefined,
          );
        }
      });

      this.browser = browser;

      this.logger.info(
        "pdf.chrome.ready",
        {
          worker_id: input.workerId,
          job_id: input.jobId,
          pid: browser.process()?.pid ?? null,
        },
        reqId,
      );

      return browser;
    } catch (err) {
      this.browser = null;

      this.logger.error(
        "pdf.chrome.launch_failed",
        {
          worker_id: input.workerId,
          job_id: input.jobId,
          error_message: err instanceof Error ? err.message : String(err),
          error_stack: err instanceof Error ? err.stack : undefined,
        },
        reqId,
      );

      await safeRmDir(userDir);
      throw err;
    } finally {
      this.browserPromise = null;
    }
  }

  private async isBrowserHealthy(browser: Browser, reqId?: string): Promise<boolean> {
    if (!browser.isConnected()) {
      return false;
    }

    const proc = browser.process();
    if (proc && (proc.killed || proc.exitCode !== null)) {
      return false;
    }

    try {
      await withTimeout(
        async () => {
          await browser.version();
        },
        BROWSER_HEALTHCHECK_TIMEOUT_MS,
        () => new Error("Browser health check timeout"),
      );
      return true;
    } catch (err) {
      this.logger.warning(
        "pdf.chrome.unhealthy",
        {
          pid: proc?.pid ?? null,
          error_message: err instanceof Error ? err.message : String(err),
        },
        reqId,
      );
      return false;
    }
  }
}

function chromeArgs(): string[] {
  return [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--no-zygote",
    "--single-process",
    "--disable-software-rasterizer",
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

async function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number, onTimeout: () => Error): Promise<T> {
  const timeout = Math.max(1_000, timeoutMs);

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(onTimeout()), timeout);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
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
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, BROWSER_CLOSE_TIMEOUT_MS);
        timer.unref?.();
      }),
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

async function safeClose(obj: { close?: () => Promise<unknown> } | null, timeoutMs = PAGE_CLOSE_TIMEOUT_MS): Promise<void> {
  if (!obj?.close) return;
  try {
    await Promise.race([
      obj.close(),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
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

function shouldResetBrowserAfterFailure(err: unknown): boolean {
  if (err instanceof HardError) {
    if (
      err.code === "ML_PDF_TIMEOUT"
      || err.code === "ML_ADMISSION_OVERLOAD"
      || err.code === "ML_PDF_EMPTY"
      || err.code === "ML_PDF_CORRUPT"
      || err.code === "ML_PDF_READ_FAILED"
    ) {
      return true;
    }
  }

  const text = err instanceof Error
    ? `${err.name} ${err.message}`.toLowerCase()
    : String(err).toLowerCase();

  const markers = [
    "waiting for the ws endpoint url",
    "failed to launch the browser process",
    "browser has disconnected",
    "target closed",
    "page crashed",
    "session closed",
    "protocol error",
    "socket hang up",
    "econnreset",
    "broken pipe",
    "timeout",
  ];

  return markers.some((marker) => text.includes(marker));
}
