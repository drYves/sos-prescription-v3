// src/admission/annuaireSanteService.ts
import { NdjsonLogger } from "../logger";

const DEFAULT_TIMEOUT_MS = 6_000;
const DEFAULT_FHIR_BASE_URL = "https://gateway.api.esante.gouv.fr/fhir/v2";
const DEFAULT_PUBLIC_SEARCH_BASE_URL = "https://annuaire.esante.gouv.fr/search/pp";
const USER_AGENT = "SOSPrescription-Worker/3.6.0 (+https://sosprescription.fr)";

export interface AnnuaireSanteLookupResult {
  valid: boolean;
  rpps: string;
  firstName: string;
  lastName: string;
  profession: string;
}

interface AnnuaireSanteCandidate {
  rpps: string;
  firstName: string;
  lastName: string;
  profession: string;
}

interface AnnuaireSanteServiceConfig {
  logger: NdjsonLogger;
  timeoutMs?: number;
  fhirBaseUrl?: string;
  publicSearchBaseUrl?: string;
  apiKey?: string;
  bearerToken?: string;
}

export class AnnuaireSanteServiceError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 502, options?: ErrorOptions) {
    super(message, options);
    this.name = "AnnuaireSanteServiceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class AnnuaireSanteService {
  private readonly logger: NdjsonLogger;
  private readonly timeoutMs: number;
  private readonly fhirBaseUrl: string;
  private readonly publicSearchBaseUrl: string;
  private readonly apiKey: string;
  private readonly bearerToken: string;

  constructor(cfg: AnnuaireSanteServiceConfig) {
    this.logger = cfg.logger;
    this.timeoutMs = Math.max(1_500, Math.trunc(cfg.timeoutMs ?? readPositiveIntEnv("ANN_SANTE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS)));
    this.fhirBaseUrl = normalizeBaseUrl(
      cfg.fhirBaseUrl
        ?? process.env.ANN_SANTE_FHIR_BASE_URL
        ?? DEFAULT_FHIR_BASE_URL,
      DEFAULT_FHIR_BASE_URL,
    );
    this.publicSearchBaseUrl = normalizeBaseUrl(
      cfg.publicSearchBaseUrl
        ?? process.env.ANN_SANTE_PUBLIC_SEARCH_BASE_URL
        ?? DEFAULT_PUBLIC_SEARCH_BASE_URL,
      DEFAULT_PUBLIC_SEARCH_BASE_URL,
    );
    this.apiKey = normalizeOptionalEnvString(cfg.apiKey ?? process.env.ANN_SANTE_API_KEY ?? process.env.ESANTE_API_KEY);
    this.bearerToken = normalizeOptionalEnvString(
      cfg.bearerToken
      ?? process.env.ANN_SANTE_BEARER_TOKEN
      ?? process.env.ANN_SANTE_AUTH_TOKEN,
    );
  }

  async verifyRpps(input: string, reqId?: string): Promise<AnnuaireSanteLookupResult> {
    const rpps = sanitizeRpps(input);
    if (rpps.length !== 11) {
      throw new AnnuaireSanteServiceError("ML_RPPS_BAD_REQUEST", "rpps must contain exactly 11 digits", 400);
    }

    let successfulProbeCount = 0;

    try {
      const candidate = await this.lookupViaFhirByRpps(rpps, reqId);
      successfulProbeCount += 1;
      if (candidate) {
        return toValidResult(candidate, rpps);
      }
    } catch (err: unknown) {
      this.logger.warning(
        "annuaire_sante.fhir_probe_failed",
        {
          rpps_fp: fingerprint(rpps),
          timeout_ms: this.timeoutMs,
          provider: "fhir",
        },
        reqId,
        err,
      );
    }

    try {
      const candidate = await this.lookupViaPublicSearch(rpps, reqId);
      successfulProbeCount += 1;
      if (candidate) {
        return toValidResult(candidate, rpps);
      }
    } catch (err: unknown) {
      this.logger.warning(
        "annuaire_sante.public_probe_failed",
        {
          rpps_fp: fingerprint(rpps),
          timeout_ms: this.timeoutMs,
          provider: "public_search",
        },
        reqId,
        err,
      );
    }

    if (successfulProbeCount === 0) {
      throw new AnnuaireSanteServiceError(
        "ML_RPPS_LOOKUP_UNAVAILABLE",
        "annuaire_sante_lookup_unavailable",
        502,
      );
    }

    return {
      valid: false,
      rpps,
      firstName: "",
      lastName: "",
      profession: "",
    };
  }

  private async lookupViaFhirByRpps(rpps: string, reqId?: string): Promise<AnnuaireSanteCandidate | null> {
    const url = new URL(`${this.fhirBaseUrl}/Practitioner`);
    url.searchParams.set("identifier", rpps);
    url.searchParams.set("_count", "5");
    url.searchParams.set("_revinclude", "PractitionerRole:practitioner");

    const body = await this.fetchJson(url.toString(), reqId, {
      Accept: "application/fhir+json, application/json;q=0.9, */*;q=0.1",
    });

    return this.extractBestCandidateFromMixed(body, rpps, "");
  }

  private async lookupViaPublicSearch(rpps: string, reqId?: string): Promise<AnnuaireSanteCandidate | null> {
    const variants: Array<Record<string, string>> = [
      { q: rpps },
      { term: rpps },
      { query: rpps },
      { rpps },
    ];

    for (const params of variants) {
      const url = new URL(this.publicSearchBaseUrl);
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }

      const response = await this.fetchTextResponse(url.toString(), reqId, {
        Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
      });

      const contentType = normalizeOptionalEnvString(response.headers.get("content-type"))?.toLowerCase() ?? "";
      const text = response.body;
      let candidates: AnnuaireSanteCandidate[] = [];

      if (contentType.includes("json")) {
        const decoded = safeJsonParse(text);
        if (decoded && typeof decoded === "object") {
          candidates = candidates.concat(this.collectCandidatesFromMixed(decoded));
        }
      }

      candidates = candidates.concat(this.extractCandidatesFromHtml(text));
      const best = this.pickBestCandidate(candidates, rpps);
      if (best) {
        return best;
      }
    }

    return null;
  }

  private async fetchJson(url: string, reqId: string | undefined, extraHeaders?: Record<string, string>): Promise<unknown> {
    const response = await this.fetchWithTimeout(url, reqId, extraHeaders);
    if (response.status === 401 || response.status === 403) {
      throw new AnnuaireSanteServiceError("ML_RPPS_LOOKUP_FORBIDDEN", `Annuaire Santé HTTP ${response.status}`, 502);
    }
    if (response.status === 404) {
      return { entry: [] };
    }
    if (response.status < 200 || response.status >= 300) {
      throw new AnnuaireSanteServiceError("ML_RPPS_LOOKUP_UPSTREAM_HTTP", `Annuaire Santé HTTP ${response.status}`, 502);
    }

    const decoded = safeJsonParse(response.body);
    if (decoded == null) {
      throw new AnnuaireSanteServiceError("ML_RPPS_LOOKUP_BAD_JSON", "Annuaire Santé JSON unreadable", 502);
    }

    return decoded;
  }

  private async fetchTextResponse(url: string, reqId: string | undefined, extraHeaders?: Record<string, string>): Promise<{ status: number; headers: Headers; body: string }> {
    const response = await this.fetchWithTimeout(url, reqId, extraHeaders);
    if (response.status < 200 || response.status >= 300) {
      throw new AnnuaireSanteServiceError("ML_RPPS_LOOKUP_UPSTREAM_HTTP", `Annuaire Santé HTTP ${response.status}`, 502);
    }

    return response;
  }

  private async fetchWithTimeout(url: string, reqId: string | undefined, extraHeaders?: Record<string, string>): Promise<{ status: number; headers: Headers; body: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();

    const headers = new Headers({
      "User-Agent": USER_AGENT,
      ...extraHeaders,
    });

    if (this.apiKey !== "") {
      headers.set("ESANTE-API-KEY", this.apiKey);
    }
    if (this.bearerToken !== "") {
      headers.set("Authorization", `Bearer ${this.bearerToken}`);
    }

    try {
      const response = await fetch(url, {
        method: "GET",
        headers,
        redirect: "follow",
        signal: controller.signal,
      });
      const body = await response.text();

      this.logger.info(
        "annuaire_sante.fetch",
        {
          host: safeHost(url),
          status: response.status,
          timeout_ms: this.timeoutMs,
          rpps_probe: true,
        },
        reqId,
      );

      return {
        status: response.status,
        headers: response.headers,
        body,
      };
    } catch (err: unknown) {
      if (isAbortError(err)) {
        throw new AnnuaireSanteServiceError("ML_RPPS_LOOKUP_TIMEOUT", "Annuaire Santé timeout", 502, { cause: err as Error });
      }
      throw new AnnuaireSanteServiceError("ML_RPPS_LOOKUP_NETWORK", "Annuaire Santé network failure", 502, { cause: err as Error });
    } finally {
      clearTimeout(timeout);
    }
  }

  private extractBestCandidateFromMixed(value: unknown, wantedRpps: string, contextProfession: string): AnnuaireSanteCandidate | null {
    const candidates = this.collectCandidatesFromMixed(value);
    if (contextProfession.trim() !== "") {
      candidates.push({
        rpps: wantedRpps,
        firstName: "",
        lastName: "",
        profession: contextProfession.trim(),
      });
    }
    return this.pickBestCandidate(candidates, wantedRpps);
  }

  private collectCandidatesFromMixed(value: unknown): AnnuaireSanteCandidate[] {
    const out: AnnuaireSanteCandidate[] = [];

    if (Array.isArray(value)) {
      for (const item of value) {
        out.push(...this.collectCandidatesFromMixed(item));
      }
      return out;
    }

    if (!value || typeof value !== "object") {
      return out;
    }

    const record = value as Record<string, unknown>;
    const mapped = this.mapPotentialCandidate(record);
    if (mapped) {
      out.push(mapped);
    }

    for (const item of Object.values(record)) {
      out.push(...this.collectCandidatesFromMixed(item));
    }

    return out;
  }

  private mapPotentialCandidate(row: Record<string, unknown>): AnnuaireSanteCandidate | null {
    const flat = flattenKeys(row);
    if (Object.keys(flat).length === 0) {
      return null;
    }

    const rawRpps = firstMappedValue(flat, [
      "rpps",
      "ps_idnat",
      "idnat",
      "identifiantnational",
      "identifiantrpps",
      "identifiantrppsadeli",
      "identifier.value",
      "nationalidentifier",
    ]);

    const rawFirstName = firstMappedValue(flat, [
      "prenom",
      "firstname",
      "given",
      "ps_prenom",
      "name.given",
      "valuehumanname.given",
    ]);

    const rawLastName = firstMappedValue(flat, [
      "nom",
      "lastname",
      "family",
      "ps_nom",
      "name.family",
      "valuehumanname.family",
    ]);

    const rawProfession = firstMappedValue(flat, [
      "profession",
      "professionlibelle",
      "specialite",
      "specialty",
      "qualification.text",
      "qualification.code.text",
      "qualification.code.coding.display",
      "qualification.code.coding.code",
      "specialitequalification",
      "professionlabel",
      "code.text",
      "code.coding.display",
      "display",
    ]);

    const rpps = sanitizeRpps(rawRpps);
    const firstName = normalizeHumanText(rawFirstName);
    const lastName = normalizeHumanText(rawLastName);
    const profession = sanitizeProfession(rawProfession, firstName, lastName);

    if (rpps === "" && (firstName === "" || lastName === "")) {
      return null;
    }

    return {
      rpps,
      firstName,
      lastName,
      profession,
    };
  }

  private extractCandidatesFromHtml(html: string): AnnuaireSanteCandidate[] {
    const candidates: AnnuaireSanteCandidate[] = [];

    for (const json of extractEmbeddedJsonStrings(html)) {
      const decoded = safeJsonParse(json);
      if (decoded && typeof decoded === "object") {
        candidates.push(...this.collectCandidatesFromMixed(decoded));
      }
    }

    const text = normalizeHumanText(stripHtml(html));
    if (text === "") {
      return candidates;
    }

    const rppsMatch = text.match(/\b(?:RPPS|Identifiant RPPS)\b[^\d]{0,20}(\d{7,14})/iu);
    const firstNameMatch = text.match(/\b(?:Pr[ée]nom(?: d[’']exercice)?)\b[^A-Za-zÀ-ÿ]{0,20}([A-Za-zÀ-ÿ\-' ]{2,80})/iu);
    const lastNameMatch = text.match(/\b(?:Nom(?: d[’']exercice)?)\b[^A-Za-zÀ-ÿ]{0,20}([A-Za-zÀ-ÿ\-' ]{2,80})/iu);
    const professionMatch = text.match(/\b(?:Sp[ée]cialit[ée]|Profession|Qualification)\b[^A-Za-zÀ-ÿ]{0,20}([A-Za-zÀ-ÿ0-9\-' ]{2,120})/iu);

    const candidate: AnnuaireSanteCandidate = {
      rpps: sanitizeRpps(rppsMatch?.[1] ?? ""),
      firstName: normalizeHumanText(firstNameMatch?.[1] ?? ""),
      lastName: normalizeHumanText(lastNameMatch?.[1] ?? ""),
      profession: sanitizeProfession(professionMatch?.[1] ?? "", firstNameMatch?.[1] ?? "", lastNameMatch?.[1] ?? ""),
    };

    if (candidate.rpps !== "" || (candidate.firstName !== "" && candidate.lastName !== "")) {
      candidates.push(candidate);
    }

    return candidates;
  }

  private pickBestCandidate(candidates: AnnuaireSanteCandidate[], wantedRpps: string): AnnuaireSanteCandidate | null {
    if (candidates.length === 0) {
      return null;
    }

    let best: AnnuaireSanteCandidate | null = null;
    let bestScore = -1;

    for (const candidate of candidates) {
      const rpps = sanitizeRpps(candidate.rpps);
      const firstName = normalizeHumanText(candidate.firstName);
      const lastName = normalizeHumanText(candidate.lastName);
      const profession = sanitizeProfession(candidate.profession, firstName, lastName);

      let score = 0;
      if (wantedRpps !== "" && rpps === wantedRpps) {
        score += 100;
      }
      if (firstName !== "") {
        score += 10;
      }
      if (lastName !== "") {
        score += 10;
      }
      if (profession !== "") {
        score += 5;
      }

      if (score > bestScore) {
        bestScore = score;
        best = {
          rpps,
          firstName,
          lastName,
          profession,
        };
      }
    }

    return best;
  }
}

function toValidResult(candidate: AnnuaireSanteCandidate, rpps: string): AnnuaireSanteLookupResult {
  return {
    valid: true,
    rpps: sanitizeRpps(candidate.rpps) || rpps,
    firstName: normalizeHumanText(candidate.firstName),
    lastName: normalizeHumanText(candidate.lastName),
    profession: sanitizeProfession(candidate.profession, candidate.firstName, candidate.lastName),
  };
}

function normalizeBaseUrl(value: string, fallback: string): string {
  const raw = String(value || "").trim();
  if (raw === "") {
    return fallback;
  }

  try {
    return new URL(raw).toString().replace(/\/+$/g, "");
  } catch {
    return fallback;
  }
}

function normalizeOptionalEnvString(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function readPositiveIntEnv(key: string, fallback: number): number {
  const raw = normalizeOptionalEnvString(process.env[key]);
  if (raw === "") {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

function safeJsonParse(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function extractEmbeddedJsonStrings(html: string): string[] {
  const out = new Set<string>();
  const patterns = [
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/gi,
    /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;/gi,
    /window\.__PRELOADED_STATE__\s*=\s*(\{[\s\S]*?\})\s*;/gi,
    /window\.__NUXT__\s*=\s*(\{[\s\S]*?\})\s*;/gi,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null) {
      const candidate = normalizeHumanText(match[1] ?? "");
      if (candidate !== "") {
        out.add(candidate);
      }
    }
  }

  return Array.from(out);
}

function flattenKeys(value: Record<string, unknown>, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [rawKey, item] of Object.entries(value)) {
    const key = String(rawKey);
    const path = prefix === "" ? key : `${prefix}.${key}`;

    if (Array.isArray(item)) {
      item.forEach((entry, index) => {
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          Object.assign(out, flattenKeys(entry as Record<string, unknown>, `${path}.${index}`));
          return;
        }
        if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
          const normalized = normalizeHumanText(String(entry));
          if (normalized !== "") {
            out[`${path}.${index}`.toLowerCase()] = normalized;
          }
        }
      });
      continue;
    }

    if (item && typeof item === "object") {
      Object.assign(out, flattenKeys(item as Record<string, unknown>, path));
      continue;
    }

    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      const normalized = normalizeHumanText(String(item));
      if (normalized !== "") {
        out[path.toLowerCase()] = normalized;
        const tail = key.toLowerCase();
        if (!(tail in out)) {
          out[tail] = normalized;
        }
      }
    }
  }

  return out;
}

function firstMappedValue(flat: Record<string, string>, candidates: string[]): string {
  for (const rawCandidate of candidates) {
    const candidate = rawCandidate.toLowerCase();
    for (const [key, value] of Object.entries(flat)) {
      if (key === candidate || key.endsWith(`.${candidate}`) || key.includes(candidate)) {
        return value;
      }
    }
  }
  return "";
}

function sanitizeRpps(value: string): string {
  return String(value || "").replace(/\D+/g, "").trim();
}

function normalizeHumanText(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
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

function normalizeLookupKey(value: string): string {
  return normalizeHumanText(value).toUpperCase();
}

function fingerprint(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url").slice(0, 12);
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const name = "name" in err ? String((err as { name?: unknown }).name ?? "") : "";
  return name === "AbortError";
}
