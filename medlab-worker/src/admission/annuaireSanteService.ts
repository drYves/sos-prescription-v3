/// <reference lib="dom" />
import puppeteer, { Browser, Page } from "puppeteer";

import { NdjsonLogger } from "../logger";

const DEFAULT_TIMEOUT_MS = 18_000;
const MIN_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 20_000;
const DEFAULT_PUBLIC_DETAIL_BASE_URL = "https://annuaire.esante.gouv.fr/pp/detail";
const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const LAUNCH_ARGS: string[] = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
];
const DOM_READY_MARKERS = [
  "identifiant rpps",
  "professionnel de santé",
  "situation d'exercice",
  "situation d’exercice",
  "dossier du professionnel",
  "attestation",
  "source : rpps",
  "source: rpps",
  "source : adeli",
  "source: adeli",
  "en activité",
] as const;
const NOT_FOUND_MARKERS = [
  "page introuvable",
  "profil introuvable",
  "aucun résultat",
  "aucun professionnel",
  "résultat introuvable",
  "resultats introuvables",
  "404",
  "410",
  "n'existe pas",
] as const;

export interface AnnuaireSanteLookupResult {
  valid: boolean;
  rpps: string;
  firstName: string;
  lastName: string;
  profession: string;
}

export class AnnuaireSanteServiceError extends Error {
  constructor(public readonly code: string, public readonly statusCode: number, message: string) {
    super(message);
    this.name = "AnnuaireSanteServiceError";
  }
}

export interface AnnuaireSanteServiceConfig {
  logger: NdjsonLogger;
  timeoutMs?: number;
  publicDetailBaseUrl?: string;
  userAgent?: string;
  chromeExecutablePath?: string;
}

export class AnnuaireSanteService {
  private readonly logger: NdjsonLogger;
  private readonly timeoutMs: number;
  private readonly publicDetailBaseUrl: string;
  private readonly userAgent: string;
  private readonly chromeExecutablePath?: string;

  constructor(config: AnnuaireSanteServiceConfig) {
    this.logger = config.logger;
    this.timeoutMs = Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.floor(config.timeoutMs ?? DEFAULT_TIMEOUT_MS)));
    this.publicDetailBaseUrl = normalizeBaseUrl(config.publicDetailBaseUrl ?? DEFAULT_PUBLIC_DETAIL_BASE_URL);
    this.userAgent = normalizeHumanText(config.userAgent ?? DEFAULT_USER_AGENT);
    this.chromeExecutablePath = config.chromeExecutablePath;
  }

  async verifyRpps(rpps: string, reqId?: string): Promise<AnnuaireSanteLookupResult> {
    const safeRpps = sanitizeRpps(rpps);
    if (safeRpps.length !== 11) {
      return this.buildInvalidResult(safeRpps);
    }

    const rppsFp = fingerprint(safeRpps);
    const url = `${this.publicDetailBaseUrl}/${encodeURIComponent(safeRpps)}`;
    const startMs = Date.now();
    let browser: Browser | null = null;
    let statusCode = 0;

    try {
      browser = await puppeteer.launch({
        headless: true,
        executablePath: this.chromeExecutablePath,
        args: LAUNCH_ARGS,
      });

      const page = await browser.newPage();
      await page.setUserAgent(this.userAgent);
      await page.setExtraHTTPHeaders({
        "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
      });

      page.setDefaultNavigationTimeout(this.timeoutMs);
      page.setDefaultTimeout(this.timeoutMs);

      const response = await page.goto(url, { waitUntil: "networkidle2" });
      if (response) {
        statusCode = response.status();
      }

      if (isUnavailableStatus(statusCode)) {
        this.logger.warning(
          "annuaire_sante.unavailable",
          {
            host: extractHost(url),
            status: statusCode,
            timeout_ms: Date.now() - startMs,
            rpps_probe: true,
            strategy: "public_puppeteer",
          },
          reqId
        );
        return this.buildInvalidResult(safeRpps);
      }

      if (statusCode === 404 || statusCode === 410) {
        this.logger.info(
          "doctor.verify_rpps.not_found",
          {
            actor_role: "SYSTEM",
            actor_wp_user_id: 1,
            valid: false,
            rpps_fp: rppsFp,
            profession_present: false,
            status: statusCode,
          },
          reqId
        );
        return this.buildInvalidResult(safeRpps);
      }

      const isReady = await this.waitForDomHydration(page);
      if (!isReady) {
        const rawBody = await page.evaluate(() => document.body.innerText || "");
        if (looksLikeWafBlock(rawBody)) {
          this.logger.warning(
            "annuaire_sante.blocked",
            {
              host: extractHost(url),
              status: statusCode,
              timeout_ms: Date.now() - startMs,
              rpps_probe: true,
              strategy: "public_puppeteer",
            },
            reqId
          );
          return this.buildInvalidResult(safeRpps);
        }

        this.logger.warning(
          "annuaire_sante.unparseable",
          {
            host: extractHost(url),
            status: statusCode,
            timeout_ms: Date.now() - startMs,
            rpps_probe: true,
            strategy: "public_puppeteer",
          },
          reqId
        );
        return this.buildInvalidResult(safeRpps);
      }

      const extracted = await page.evaluate(() => {
        const docText = (document.body.innerText || "").toLowerCase();
        if (docText.includes("page introuvable") || docText.includes("aucun résultat")) {
          return null;
        }

        const extractFromH1 = (): { firstName: string; lastName: string } | null => {
          const h1 = document.querySelector("h1");
          if (!h1) return null;
          const text = (h1.textContent || "").trim();
          if (!text) return null;

          const parts = text.split(/\s+/);
          if (parts.length < 2) return { firstName: text, lastName: "" };

          const lastName = parts.shift() || "";
          const firstName = parts.join(" ");
          return { firstName, lastName };
        };

        const extractProfession = (): string => {
          const headers = Array.from(document.querySelectorAll("h2, h3, .profession, .specialty")) as Element[];
          for (const h of headers) {
            const text = (h.textContent || "").trim();
            if (text && text.length < 120 && !text.toLowerCase().includes("identifiant")) {
              return text;
            }
          }
          return "";
        };

        const nameData = extractFromH1();
        if (!nameData) return null;

        return {
          firstName: nameData.firstName,
          lastName: nameData.lastName,
          profession: extractProfession(),
        };
      });

      if (!extracted) {
        this.logger.info(
          "doctor.verify_rpps.not_found",
          {
            actor_role: "SYSTEM",
            actor_wp_user_id: 1,
            valid: false,
            rpps_fp: rppsFp,
            profession_present: false,
            status: statusCode,
          },
          reqId
        );
        return this.buildInvalidResult(safeRpps);
      }

      const finalFirstName = normalizeHumanName(extracted.firstName);
      const finalLastName = normalizeHumanName(extracted.lastName).toUpperCase();
      const finalProfession = sanitizeProfession(extracted.profession, finalFirstName, finalLastName);

      if (!finalFirstName && !finalLastName) {
        return this.buildInvalidResult(safeRpps);
      }

      this.logger.info(
        "doctor.verify_rpps.verified",
        {
          actor_role: "SYSTEM",
          actor_wp_user_id: 1,
          valid: true,
          rpps_fp: rppsFp,
          profession_present: finalProfession !== "",
          timeout_ms: Date.now() - startMs,
        },
        reqId
      );

      return {
        valid: true,
        rpps: safeRpps,
        firstName: finalFirstName,
        lastName: finalLastName,
        profession: finalProfession,
      };

    } catch (err: unknown) {
      const errorCode = normalizeErrorCode(err);
      this.logger.error(
        "annuaire_sante.failed",
        {
          host: extractHost(url),
          status: statusCode,
          timeout_ms: Date.now() - startMs,
          rpps_probe: true,
          strategy: "public_puppeteer",
          error_code: errorCode,
        },
        undefined,
        err
      );
      return this.buildInvalidResult(safeRpps);
    } finally {
      if (browser) {
        try {
          await browser.close();
        } catch (closeErr) {
          this.logger.warning("puppeteer.close_failed", { error: String(closeErr) }, reqId);
        }
      }
    }
  }

  private async waitForDomHydration(page: Page): Promise<boolean> {
    try {
      await page.waitForFunction(
        (readyMarkers, notFoundMarkers) => {
          const text = (document.body.innerText || "").toLowerCase();
          if (notFoundMarkers.some(m => text.includes(m))) {
            return true; 
          }
          return readyMarkers.some(m => text.includes(m));
        },
        { timeout: this.timeoutMs - 2000, polling: 500 },
        DOM_READY_MARKERS,
        NOT_FOUND_MARKERS
      );
      return true;
    } catch {
      return false;
    }
  }

  private buildInvalidResult(rpps: string): AnnuaireSanteLookupResult {
    return {
      valid: false,
      rpps,
      firstName: "",
      lastName: "",
      profession: "",
    };
  }
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "").trim();
}

function extractHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

function sanitizeRpps(value: string): string {
  return String(value || "").replace(/\D+/g, "").trim();
}

function normalizeHumanText(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeLookupKey(value: string): string {
  return normalizeHumanText(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

function fingerprint(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url").slice(0, 12);
}

function isUnavailableStatus(statusCode: number): boolean {
  return statusCode === 403 || statusCode === 429 || statusCode === 503 || statusCode === 504;
}

function normalizeErrorCode(err: unknown): string {
  if (err instanceof AnnuaireSanteServiceError) {
    return err.code;
  }
  if (isTimeoutLikeError(err)) {
    return "ML_RPPS_LOOKUP_TIMEOUT";
  }
  return "ML_RPPS_LOOKUP_FAILED";
}

function isTimeoutLikeError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }

  const maybeError = err as Error & { name?: unknown; message?: unknown };
  const name = String(maybeError.name || "").toLowerCase();
  const message = String(maybeError.message || "").toLowerCase();

  return name.includes("timeout") || message.includes("timeout") || message.includes("exceeded");
}

function normalizeHumanName(value: string): string {
  const text = normalizeHumanText(value);
  if (text === "") {
    return "";
  }
  return text.split(/[- ]+/).map(part => {
    const lower = part.toLowerCase();
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }).join(" ");
}

function sanitizeProfession(value: string, firstName: string, lastName: string): string {
  const normalized = normalizeHumanText(value);
  if (normalized === "") {
    return "";
  }

  const candidateKey = normalizeLookupKey(normalized);
  const nameKey = normalizeLookupKey(`${firstName} ${lastName}`);
  if (candidateKey !== "" && candidateKey === nameKey) {
    return "";
  }

  return normalized.length > 120 ? normalized.slice(0, 120).trim() : normalized;
}

function looksLikeWafBlock(body: string): boolean {
  const normalized = normalizeLookupKey(body);
  if (normalized === "") {
    return false;
  }

  const markers = [
    "CLOUDFLARE",
    "JUST A MOMENT",
    "ATTENTION REQUIRED",
    "ACCESS DENIED",
    "SERVICE TEMPORARILY UNAVAILABLE",
    "TEMPORARILY UNAVAILABLE",
    "REQUEST BLOCKED",
    "INCAPSULA",
  ];

  return markers.some(m => normalized.includes(m));
}
