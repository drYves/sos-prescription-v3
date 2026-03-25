"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PdfRenderer = void 0;
/// <reference lib="dom" />
// src/pdf/pdfRenderer.ts
const node_fs_1 = __importDefault(require("node:fs"));
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_url_1 = require("node:url");
const puppeteer_1 = __importDefault(require("puppeteer"));
const errors_1 = require("../jobs/errors");
const mls1_1 = require("../security/mls1");
class PdfRenderer {
    logger;
    constructor(logger) {
        this.logger = logger;
    }
    async renderToTmpPdf(input) {
        const startedAt = Date.now();
        if (input.mode === "remote-wordpress" && input.rxId <= 0) {
            throw new errors_1.HardError("ML_PDF_BAD_RX_ID", "Invalid rx_id");
        }
        if (input.mode === "inline-html" && input.html.trim() === "") {
            throw new errors_1.HardError("ML_PDF_EMPTY_HTML", "Inline HTML payload is empty");
        }
        input.memGuard.tick();
        if (input.memGuard.rssMb() >= input.admissionMaxMb) {
            throw new errors_1.HardError("ML_ADMISSION_OVERLOAD", "Admission overload");
        }
        const tmpRoot = "/tmp/sosprescription-pdf";
        await safeMkdir(tmpRoot);
        const tmpPdfPath = node_path_1.default.join(tmpRoot, `${input.jobId}.pdf.tmp`);
        const pdfPath = node_path_1.default.join(tmpRoot, `${input.jobId}.pdf`);
        await safeUnlink(tmpPdfPath);
        await safeUnlink(pdfPath);
        let browser = null;
        let context = null;
        let page = null;
        const safeWorkerId = sanitizeId(input.workerId || "worker");
        const safeJobId = sanitizeId(input.jobId || "job");
        const userDir = node_path_1.default.join("/tmp", `medlab-chrome-${safeWorkerId}-${safeJobId}`);
        let abortedByOverload = false;
        const memTimer = setInterval(() => {
            const rss = Math.round(process.memoryUsage().rss / 1024 / 1024);
            if (rss >= input.admissionMaxMb) {
                abortedByOverload = true;
            }
        }, 250);
        memTimer.unref();
        try {
            this.logger.info("pdf.render.started", {
                job_id: input.jobId,
                worker_id: input.workerId,
                mode: input.mode,
                rx_id: input.mode === "remote-wordpress" ? input.rxId : undefined,
                template: input.mode === "inline-html" ? input.templateName ?? undefined : undefined,
            }, input.reqId);
            const safeExecutablePath = input.chromeExecutablePath && node_fs_1.default.existsSync(input.chromeExecutablePath)
                ? input.chromeExecutablePath
                : undefined;
            browser = await puppeteer_1.default.launch({
                executablePath: safeExecutablePath,
                headless: true,
                args: chromeArgs(),
                userDataDir: userDir,
            });
            context = await browser.createBrowserContext();
            page = await context.newPage();
            page.setDefaultNavigationTimeout(input.renderTimeoutMs);
            await page.setCacheEnabled(false);
            await page.emulateMediaType("print");
            await page.setViewport({ width: 1240, height: 1754, deviceScaleFactor: 2 });
            await withTimeout(async () => {
                if (input.mode === "remote-wordpress") {
                    await renderRemoteWordpressPage(page, input, this.logger);
                }
                else {
                    await renderInlineHtmlPage(page, input, this.logger);
                }
                await ensureFontsReady(page);
                await waitForPdfReadyMarker(page, input.readyTimeoutMs);
                if (abortedByOverload) {
                    throw new errors_1.HardError("ML_ADMISSION_OVERLOAD", "Admission overload");
                }
                await page.pdf({
                    path: tmpPdfPath,
                    format: "A4",
                    printBackground: true,
                    displayHeaderFooter: false,
                    preferCSSPageSize: true,
                    margin: { top: "0", right: "0", bottom: "0", left: "0" },
                });
            }, input.renderTimeoutMs);
            if (abortedByOverload) {
                throw new errors_1.HardError("ML_ADMISSION_OVERLOAD", "Admission overload");
            }
            await safeUnlink(pdfPath);
            await promises_1.default.rename(tmpPdfPath, pdfPath);
            await verifyPdfHeader(pdfPath);
            const { sha256Hex, sizeBytes } = await sha256File(pdfPath);
            this.logger.info("pdf.render.completed", {
                job_id: input.jobId,
                mode: input.mode,
                rx_id: input.mode === "remote-wordpress" ? input.rxId : undefined,
                template: input.mode === "inline-html" ? input.templateName ?? undefined : undefined,
                size_bytes: sizeBytes,
                duration_ms: Date.now() - startedAt,
            }, input.reqId);
            return {
                filePath: pdfPath,
                sha256Hex,
                sizeBytes,
                contentType: "application/pdf",
            };
        }
        catch (err) {
            if (abortedByOverload) {
                this.logger.critical("pdf.render.aborted_overload", {
                    job_id: input.jobId,
                    mode: input.mode,
                    rx_id: input.mode === "remote-wordpress" ? input.rxId : undefined,
                    rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
                }, input.reqId);
                await hardKillBrowser(browser, this.logger, input.reqId);
                throw new errors_1.HardError("ML_ADMISSION_OVERLOAD", "Admission overload");
            }
            this.logger.error("pdf.render.failed", {
                job_id: input.jobId,
                mode: input.mode,
                rx_id: input.mode === "remote-wordpress" ? input.rxId : undefined,
                template: input.mode === "inline-html" ? input.templateName ?? undefined : undefined,
                error_message: err instanceof Error ? err.message : String(err),
                error_stack: err instanceof Error ? err.stack : undefined,
            }, input.reqId);
            await hardKillBrowser(browser, this.logger, input.reqId);
            throw err;
        }
        finally {
            clearInterval(memTimer);
            await safeClose(page);
            await safeClose(context);
            await safeClose(browser);
            await safeUnlink(tmpPdfPath);
            await safeRmDir(userDir);
        }
    }
}
exports.PdfRenderer = PdfRenderer;
async function renderRemoteWordpressPage(page, input, logger) {
    const wpBaseUrl = input.wpBaseUrl.trim().replace(/\/+$/g, "");
    const renderPath = input.renderPathTemplate.replace("{rx_id}", String(input.rxId));
    const tsMs = Date.now();
    const nonce = base64Url(randomBytes(16));
    const canonical = `GET|${renderPath}|${tsMs}|${nonce}`;
    const token = (0, mls1_1.buildMls1Token)(Buffer.from(canonical, "utf8"), input.hmacSecret);
    const renderUrl = wpBaseUrl + renderPath;
    const allowedOrigin = new node_url_1.URL(wpBaseUrl).origin;
    const expectedPathname = new node_url_1.URL(renderUrl).pathname;
    await page.setRequestInterception(true);
    page.removeAllListeners("request");
    page.on("request", (req) => {
        void handleRemoteRequest(req, token, allowedOrigin, expectedPathname, logger, input.reqId);
    });
    const navResponse = await page.goto(renderUrl, { waitUntil: "networkidle0" });
    await assertDocumentIsRenderable(page, navResponse, renderUrl);
}
async function handleRemoteRequest(req, token, allowedOrigin, expectedPathname, logger, reqId) {
    try {
        const url = new node_url_1.URL(req.url());
        if (url.protocol === "data:" || url.protocol === "blob:" || url.protocol === "about:") {
            await req.continue();
            return;
        }
        if (url.origin !== allowedOrigin) {
            logger.warning("pdf.render.blocked_request", { reason: "foreign_origin", origin: url.origin }, reqId);
            await req.abort();
            return;
        }
        if (req.isNavigationRequest() && url.pathname === expectedPathname) {
            await req.continue({ headers: { ...req.headers(), "x-medlab-signature": token } });
            return;
        }
        await req.continue();
    }
    catch (_err) {
        try {
            await req.abort();
        }
        catch {
            // noop
        }
    }
}
async function renderInlineHtmlPage(page, input, logger) {
    await page.setRequestInterception(true);
    page.removeAllListeners("request");
    page.on("request", (req) => {
        void handleOfflineRequest(req, logger, input.reqId);
    });
    await page.setContent(input.html, { waitUntil: "networkidle0" });
    await assertInlineDocumentRenderable(page);
}
async function handleOfflineRequest(req, logger, reqId) {
    const url = req.url();
    const protocol = protocolOf(url);
    if (protocol === "data:" || protocol === "blob:" || protocol === "about:") {
        await req.continue();
        return;
    }
    logger.warning("pdf.render.blocked_request", { reason: "offline_sandbox", protocol }, reqId);
    try {
        await req.abort();
    }
    catch {
        // noop
    }
}
function protocolOf(url) {
    try {
        return new node_url_1.URL(url).protocol;
    }
    catch {
        return "unknown:";
    }
}
async function assertInlineDocumentRenderable(page) {
    const probe = await page.evaluate(() => {
        const title = typeof document.title === "string" ? document.title : "";
        const bodyText = (document.body && typeof document.body.innerText === "string" ? document.body.innerText : "") ||
            (document.documentElement && typeof document.documentElement.innerText === "string"
                ? document.documentElement.innerText
                : "");
        return {
            title,
            bodyLength: bodyText.trim().length,
            readyGlobal: globalThis.__ML_PDF_READY__ === true,
            readyMarker: !!document.querySelector("[data-ml-pdf-ready='1']"),
        };
    });
    if (probe.bodyLength < 1 && !probe.readyGlobal && !probe.readyMarker) {
        throw new errors_1.HardError("ML_PDF_EMPTY_HTML", "Inline HTML produced an empty document");
    }
}
async function waitForPdfReadyMarker(page, timeoutMs) {
    try {
        await page.waitForFunction(`globalThis.__ML_PDF_READY__ === true || document.querySelector("[data-ml-pdf-ready='1']") !== null`, { timeout: timeoutMs, polling: "mutation" });
    }
    catch (_err) {
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
}
async function ensureFontsReady(page) {
    await page.evaluate(`
    (async () => {
      if (document.fonts && document.fonts.ready) {
        await document.fonts.ready;
      }
    })();
  `);
}
async function assertDocumentIsRenderable(page, response, expectedUrl) {
    const status = response?.status() ?? 0;
    if (status >= 400) {
        throw new errors_1.HardError("ML_PDF_WAF_BLOCKED", `Render blocked upstream (HTTP ${status})`);
    }
    const probe = await page.evaluate(() => {
        const title = typeof document.title === "string" ? document.title : "";
        const bodyText = (document.body && typeof document.body.innerText === "string" ? document.body.innerText : "") ||
            (document.documentElement && typeof document.documentElement.innerText === "string"
                ? document.documentElement.innerText
                : "");
        return {
            href: location.href,
            title,
            bodyText: bodyText.slice(0, 4000),
            readyGlobal: globalThis.__ML_PDF_READY__ === true,
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
        throw new errors_1.HardError("ML_PDF_WAF_BLOCKED", "Render blocked by upstream WAF");
    }
    const expectedPath = normalizePathname(pathFromUrlSafe(expectedUrl));
    const actualPath = normalizePathname(pathFromUrlSafe(probe.href));
    if (expectedPath !== "" && actualPath !== "" && expectedPath !== actualPath) {
        if (!probe.readyGlobal && !probe.readyMarker) {
            throw new errors_1.HardError("ML_PDF_WAF_BLOCKED", "Render redirected away from expected document");
        }
    }
}
function pathFromUrlSafe(value) {
    try {
        return new node_url_1.URL(value).pathname || "";
    }
    catch {
        return "";
    }
}
function normalizePathname(value) {
    if (!value)
        return "";
    const trimmed = value.trim();
    if (trimmed === "/")
        return "/";
    return trimmed.replace(/\/+$/g, "");
}
function normalizeProbeText(value) {
    return value
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
}
function chromeArgs() {
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
async function withTimeout(fn, timeoutMs) {
    const timeout = Math.max(1_000, timeoutMs);
    return await Promise.race([
        fn(),
        new Promise((_resolve, reject) => {
            const t = setTimeout(() => reject(new errors_1.HardError("ML_PDF_TIMEOUT", "PDF render timeout")), timeout);
            t.unref?.();
        }),
    ]);
}
async function verifyPdfHeader(filePath) {
    const fh = await promises_1.default.open(filePath, "r");
    try {
        const buf = Buffer.alloc(5);
        await fh.read(buf, 0, 5, 0);
        if (buf.toString("utf8") !== "%PDF-") {
            throw new errors_1.HardError("ML_PDF_CORRUPT", "Invalid PDF header");
        }
    }
    finally {
        await fh.close();
    }
}
async function sha256File(filePath) {
    const st = await promises_1.default.stat(filePath);
    if (st.size <= 0) {
        throw new errors_1.HardError("ML_PDF_EMPTY", "Empty PDF file");
    }
    return await new Promise((resolve, reject) => {
        const hash = node_crypto_1.default.createHash("sha256");
        const rs = node_fs_1.default.createReadStream(filePath);
        rs.on("data", (chunk) => hash.update(chunk));
        rs.on("error", () => reject(new errors_1.HardError("ML_PDF_READ_FAILED", "Failed to read PDF")));
        rs.on("end", () => {
            resolve({ sha256Hex: hash.digest("hex"), sizeBytes: st.size });
        });
    });
}
async function hardKillBrowser(browser, logger, reqId) {
    if (!browser) {
        return;
    }
    try {
        await Promise.race([
            browser.close(),
            new Promise((resolve) => setTimeout(resolve, 1_500)),
        ]);
    }
    catch {
        // noop
    }
    try {
        const proc = browser.process();
        const pid = proc?.pid;
        if (pid && pid > 1) {
            try {
                process.kill(pid, "SIGKILL");
            }
            catch {
                // noop
            }
            logger.warning("pdf.chrome.killed", { pid }, reqId);
        }
    }
    catch {
        // noop
    }
}
async function safeClose(obj) {
    if (!obj) {
        return;
    }
    try {
        await obj.close();
    }
    catch {
        // noop
    }
}
async function safeMkdir(dir) {
    try {
        await promises_1.default.mkdir(dir, { recursive: true });
    }
    catch {
        // noop
    }
}
async function safeUnlink(filePath) {
    try {
        await promises_1.default.unlink(filePath);
    }
    catch {
        // noop
    }
}
async function safeRmDir(dirPath) {
    try {
        await promises_1.default.rm(dirPath, { recursive: true, force: true });
    }
    catch {
        // noop
    }
}
function randomBytes(length) {
    return node_crypto_1.default.randomBytes(length);
}
function base64Url(buf) {
    return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function sanitizeId(value) {
    return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 64);
}
