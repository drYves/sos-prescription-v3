// src/admission/annuaireSanteService.ts
import { NdjsonLogger } from "../logger";

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_TIMEOUT_MS = 8_000;
const DEFAULT_PUBLIC_BASE_URL = "https://annuaire.esante.gouv.fr";
const DEFAULT_PUBLIC_SEARCH_BASE_URL = `${DEFAULT_PUBLIC_BASE_URL}/search/pp`;
const DEFAULT_PUBLIC_DETAIL_BASE_URL = `${DEFAULT_PUBLIC_BASE_URL}/pp/detail`;
const USER_AGENT = "SOSPrescription-Worker/3.6.1 (+https://sosprescription.fr)";
const ACCEPT_LANGUAGE = "fr-FR,fr;q=0.9,en;q=0.4";
const HTML_ACCEPT = "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8";

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
  publicBaseUrl?: string;
  publicSearchBaseUrl?: string;
  publicDetailBaseUrl?: string;
  fhirBaseUrl?: string;
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
  private readonly publicBaseUrl: string;
  private readonly publicSearchBaseUrl: string;
  private readonly publicDetailBaseUrl: string;

  constructor(cfg: AnnuaireSanteServiceConfig) {
    this.logger = cfg.logger;
    this.timeoutMs = clampTimeoutMs(cfg.timeoutMs ?? readPositiveIntEnv("ANN_SANTE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS));
    this.publicBaseUrl = normalizeBaseUrl(
      cfg.publicBaseUrl
      ?? process.env.ANN_SANTE_PUBLIC_BASE_URL
      ?? DEFAULT_PUBLIC_BASE_URL,
      DEFAULT_PUBLIC_BASE_URL,
    );
    this.publicSearchBaseUrl = normalizeBaseUrl(
      cfg.publicSearchBaseUrl
      ?? process.env.ANN_SANTE_PUBLIC_SEARCH_BASE_URL
      ?? `${this.publicBaseUrl}/search/pp`,
      DEFAULT_PUBLIC_SEARCH_BASE_URL,
    );
    this.publicDetailBaseUrl = normalizeBaseUrl(
      cfg.publicDetailBaseUrl
      ?? process.env.ANN_SANTE_PUBLIC_DETAIL_BASE_URL
      ?? `${this.publicBaseUrl}/pp/detail`,
      DEFAULT_PUBLIC_DETAIL_BASE_URL,
    );
  }

  async verifyRpps(input: string, reqId?: string): Promise<AnnuaireSanteLookupResult> {
    const rpps = sanitizeRpps(input);
    if (rpps.length !== 11) {
      throw new AnnuaireSanteServiceError("ML_RPPS_BAD_REQUEST", "rpps must contain exactly 11 digits", 400);
    }

    const deadlineAt = Date.now() + this.timeoutMs;
    let successfulProbeCount = 0;

    const probes: Array<{ name: string; run: () => Promise<AnnuaireSanteCandidate | null> }> = [
      {
        name: "public_detail",
        run: () => this.lookupViaDetailPage(rpps, reqId, deadlineAt),
      },
      {
        name: "public_search",
        run: () => this.lookupViaPublicSearch(rpps, reqId, deadlineAt),
      },
    ];

    for (const probe of probes) {
      try {
        const candidate = await probe.run();
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
            provider: probe.name,
            strategy: "public_scraper",
          },
          reqId,
          err,
        );
      }
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

  private async lookupViaDetailPage(
    rpps: string,
    reqId: string | undefined,
    deadlineAt: number,
  ): Promise<AnnuaireSanteCandidate | null> {
    const variants = uniqueStrings([
      `${this.publicDetailBaseUrl}/${encodeURIComponent(rpps)}`,
      `${this.publicDetailBaseUrl}/${encodeURIComponent(rpps)}/`,
    ]);

    for (const url of variants) {
      const response = await this.fetchTextResponse(
        url,
        reqId,
        {
          Accept: HTML_ACCEPT,
        },
        deadlineAt,
        { allowNotFound: true },
      );
      if (!response) {
        continue;
      }

      const candidates = this.extractCandidatesFromHtml(response.body, rpps);
      const best = this.pickBestCandidate(candidates, rpps);
      if (best) {
        return best;
      }
    }

    return null;
  }

  private async lookupViaPublicSearch(
    rpps: string,
    reqId: string | undefined,
    deadlineAt: number,
  ): Promise<AnnuaireSanteCandidate | null> {
    const variants: Array<Record<string, string>> = [
      { q: rpps },
      { term: rpps },
      { query: rpps },
      { rpps },
      { identifiant: rpps },
      { identifiant_rpps: rpps },
    ];

    for (const params of variants) {
      const url = new URL(this.publicSearchBaseUrl);
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }

      const response = await this.fetchTextResponse(
        url.toString(),
        reqId,
        {
          Accept: HTML_ACCEPT,
        },
        deadlineAt,
        { allowNotFound: true },
      );
      if (!response) {
        continue;
      }

      const contentType = normalizeOptionalString(response.headers.get("content-type")).toLowerCase();
      let candidates: AnnuaireSanteCandidate[] = [];

      if (contentType.includes("json")) {
        const decoded = safeJsonParse(response.body);
        if (decoded && typeof decoded === "object") {
          candidates = candidates.concat(this.collectCandidatesFromMixed(decoded));
        }
      }

      candidates = candidates.concat(this.extractCandidatesFromHtml(response.body, rpps));
      const best = this.pickBestCandidate(candidates, rpps);
      if (best) {
        return best;
      }
    }

    return null;
  }

  private async fetchTextResponse(
    url: string,
    reqId: string | undefined,
    extraHeaders: Record<string, string> | undefined,
    deadlineAt: number,
    options?: { allowNotFound?: boolean },
  ): Promise<{ status: number; headers: Headers; body: string } | null> {
    const response = await this.fetchWithTimeout(url, reqId, extraHeaders, deadlineAt);
    const body = response.body;

    if (options?.allowNotFound && response.status === 404) {
      return null;
    }

    if (response.status === 404) {
      return null;
    }

    if (response.status === 401 || response.status === 403) {
      if (looksLikeWafBlock(body)) {
        throw new AnnuaireSanteServiceError(
          "ML_RPPS_LOOKUP_UPSTREAM_BUSY",
          `Annuaire Santé HTTP ${response.status}`,
          502,
        );
      }
      throw new AnnuaireSanteServiceError(
        "ML_RPPS_LOOKUP_FORBIDDEN",
        `Annuaire Santé HTTP ${response.status}`,
        502,
      );
    }

    if (response.status === 429 || response.status === 503 || (response.status >= 520 && response.status <= 524)) {
      throw new AnnuaireSanteServiceError(
        "ML_RPPS_LOOKUP_UPSTREAM_BUSY",
        `Annuaire Santé HTTP ${response.status}`,
        502,
      );
    }

    if (response.status < 200 || response.status >= 300) {
      throw new AnnuaireSanteServiceError(
        "ML_RPPS_LOOKUP_UPSTREAM_HTTP",
        `Annuaire Santé HTTP ${response.status}`,
        502,
      );
    }

    if (looksLikeWafBlock(body)) {
      throw new AnnuaireSanteServiceError(
        "ML_RPPS_LOOKUP_UPSTREAM_BUSY",
        "Annuaire Santé anti-bot or WAF challenge",
        502,
      );
    }

    return response;
  }

  private async fetchWithTimeout(
    url: string,
    reqId: string | undefined,
    extraHeaders: Record<string, string> | undefined,
    deadlineAt: number,
  ): Promise<{ status: number; headers: Headers; body: string }> {
    const remainingMs = computeRemainingBudgetMs(deadlineAt, this.timeoutMs);
    if (remainingMs <= 0) {
      throw new AnnuaireSanteServiceError("ML_RPPS_LOOKUP_TIMEOUT", "Annuaire Santé timeout", 502);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), remainingMs);
    timeout.unref?.();

    const headers = new Headers({
      "User-Agent": USER_AGENT,
      "Accept-Language": ACCEPT_LANGUAGE,
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      ...extraHeaders,
    });

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
          timeout_ms: remainingMs,
          rpps_probe: true,
          strategy: "public_scraper",
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

  private extractCandidatesFromHtml(html: string, wantedRpps: string): AnnuaireSanteCandidate[] {
    const candidates: AnnuaireSanteCandidate[] = [];
    if (normalizeOptionalString(html) === "") {
      return candidates;
    }

    for (const json of extractEmbeddedJsonStrings(html)) {
      const decoded = safeJsonParse(json);
      if (decoded && typeof decoded === "object") {
        candidates.push(...this.collectCandidatesFromMixed(decoded));
      }
    }

    for (const metaText of extractMetaContents(html)) {
      candidates.push(...this.extractCandidatesFromTextBlock(metaText, wantedRpps));
    }

    for (const block of extractContextWindows(html, [`/pp/detail/${wantedRpps}`, wantedRpps, "Identifiant RPPS", "Civil -"])) {
      const decoded = safeJsonParse(block);
      if (decoded && typeof decoded === "object") {
        candidates.push(...this.collectCandidatesFromMixed(decoded));
      }
      candidates.push(...this.extractCandidatesFromTextBlock(stripHtml(block), wantedRpps));
    }

    const stripped = normalizeHumanText(stripHtml(html));
    if (stripped !== "") {
      candidates.push(...this.extractCandidatesFromTextBlock(stripped, wantedRpps));
    }

    return deduplicateCandidates(candidates);
  }

  private extractCandidatesFromTextBlock(text: string, wantedRpps: string): AnnuaireSanteCandidate[] {
    const normalized = normalizeHumanText(decodeHtmlEntities(text));
    if (normalized === "") {
      return [];
    }

    const mentionsWantedRpps = wantedRpps !== ""
      && (normalized.includes(wantedRpps) || normalized.includes(`/pp/detail/${wantedRpps}`));
    const looksLikeRppsContext = mentionsWantedRpps || /Identifiant\s+RPPS|\bRPPS\b/iu.test(normalized);
    if (!looksLikeRppsContext) {
      return [];
    }

    const rpps = extractRppsFromText(normalized, wantedRpps);
    const profession = extractProfessionFromText(normalized);
    const labeledFirstName = extractLabeledField(normalized, [
      /Pr[ée]nom(?:\s+d[’']exercice)?\s*[:\-]?\s*([A-Za-zÀ-ÿ'’\- ]{1,80})/iu,
    ]);
    const labeledLastName = extractLabeledField(normalized, [
      /Nom(?:\s+d[’']exercice)?\s*[:\-]?\s*([A-Za-zÀ-ÿ'’\- ]{1,80})/iu,
    ]);

    const out: AnnuaireSanteCandidate[] = [];

    if (labeledFirstName !== "" || labeledLastName !== "") {
      out.push({
        rpps,
        firstName: normalizePersonalPart(labeledFirstName),
        lastName: normalizeLastNamePart(labeledLastName),
        profession,
      });
    }

    for (const rawName of extractNameSnippets(normalized)) {
      const parsed = parseFullName(rawName);
      if (!parsed) {
        continue;
      }
      out.push({
        rpps,
        firstName: parsed.firstName,
        lastName: parsed.lastName,
        profession,
      });
    }

    return deduplicateCandidates(
      out.filter((candidate) => isCandidateUsable(candidate, wantedRpps)),
    );
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

    return deduplicateCandidates(out);
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
      "identifiant_rpps",
      "identifiantdps",
      "identifier.value",
      "nationalidentifier",
    ]);

    let firstName = normalizePersonalPart(firstMappedValue(flat, [
      "prenom",
      "firstname",
      "first_name",
      "given",
      "ps_prenom",
      "prenomexercice",
      "prenom_exercice",
      "prenomdexercice",
      "name.given",
      "valuehumanname.given",
    ]));

    let lastName = normalizeLastNamePart(firstMappedValue(flat, [
      "nom",
      "lastname",
      "last_name",
      "family",
      "ps_nom",
      "nomexercice",
      "nom_exercice",
      "nomdexercice",
      "name.family",
      "valuehumanname.family",
    ]));

    let profession = sanitizeProfession(
      firstMappedValue(flat, [
        "profession",
        "professionlibelle",
        "profession_label",
        "libelleprofession",
        "professionexercee",
        "professionexerceelabel",
        "specialite",
        "specialty",
        "qualification.text",
        "qualification.code.text",
        "qualification.code.coding.display",
        "specialitequalification",
        "professionlabel",
        "civil",
        "code.text",
        "code.coding.display",
        "display",
      ]),
      firstName,
      lastName,
    );

    const descriptiveText = firstMappedValue(flat, [
      "displayname",
      "display_name",
      "fullname",
      "full_name",
      "name.text",
      "title",
      "label",
      "description",
      "content",
    ]);

    if ((firstName === "" || lastName === "") && descriptiveText !== "") {
      const parsed = parseFullName(descriptiveText);
      if (parsed) {
        if (firstName === "") {
          firstName = parsed.firstName;
        }
        if (lastName === "") {
          lastName = parsed.lastName;
        }
      }
    }

    if (profession === "" && descriptiveText !== "") {
      profession = extractProfessionFromText(descriptiveText);
    }

    const candidate: AnnuaireSanteCandidate = {
      rpps: sanitizeRpps(rawRpps),
      firstName,
      lastName,
      profession,
    };

    if (!isCandidateUsable(candidate, "")) {
      return null;
    }

    return candidate;
  }

  private pickBestCandidate(candidates: AnnuaireSanteCandidate[], wantedRpps: string): AnnuaireSanteCandidate | null {
    if (candidates.length === 0) {
      return null;
    }

    let best: AnnuaireSanteCandidate | null = null;
    let bestScore = -1;

    for (const candidate of candidates) {
      const rpps = sanitizeRpps(candidate.rpps);
      const firstName = normalizePersonalPart(candidate.firstName);
      const lastName = normalizeLastNamePart(candidate.lastName);
      const profession = sanitizeProfession(candidate.profession, firstName, lastName);
      const usableCandidate: AnnuaireSanteCandidate = {
        rpps,
        firstName,
        lastName,
        profession,
      };

      if (!isCandidateUsable(usableCandidate, wantedRpps)) {
        continue;
      }

      let score = 0;
      if (wantedRpps !== "" && rpps === wantedRpps) {
        score += 100;
      }
      if (firstName !== "") {
        score += 20;
      }
      if (lastName !== "") {
        score += 20;
      }
      if (profession !== "") {
        score += 10;
      }
      if (rpps !== "" && (firstName !== "" || lastName !== "")) {
        score += 10;
      }

      if (score > bestScore) {
        bestScore = score;
        best = usableCandidate;
      }
    }

    return best;
  }
}

function toValidResult(candidate: AnnuaireSanteCandidate, rpps: string): AnnuaireSanteLookupResult {
  return {
    valid: true,
    rpps: sanitizeRpps(candidate.rpps) || rpps,
    firstName: normalizePersonalPart(candidate.firstName),
    lastName: normalizeLastNamePart(candidate.lastName),
    profession: sanitizeProfession(candidate.profession, candidate.firstName, candidate.lastName),
  };
}

function clampTimeoutMs(value: number): number {
  const numeric = Number.isFinite(value) ? Math.trunc(value) : DEFAULT_TIMEOUT_MS;
  if (numeric <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(MAX_TIMEOUT_MS, Math.max(1_500, numeric));
}

function computeRemainingBudgetMs(deadlineAt: number, fallback: number): number {
  const remaining = Math.trunc(deadlineAt - Date.now());
  if (!Number.isFinite(remaining)) {
    return fallback;
  }
  return Math.max(0, Math.min(fallback, remaining));
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

function normalizeOptionalString(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function readPositiveIntEnv(key: string, fallback: number): number {
  const raw = normalizeOptionalString(process.env[key]);
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
  const withoutScripts = String(html || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");

  const withBreaks = withoutScripts
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/p>/gi, " ")
    .replace(/<\/div>/gi, " ")
    .replace(/<\/li>/gi, " ");

  return decodeHtmlEntities(withBreaks.replace(/<[^>]+>/g, " "));
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    nbsp: " ",
    quot: '"',
    lt: "<",
    gt: ">",
    laquo: "«",
    raquo: "»",
    rsquo: "’",
    lsquo: "‘",
    ldquo: "“",
    rdquo: "”",
  };

  return String(value || "")
    .replace(/&#(\d+);/g, (_match, rawCode: string) => {
      const code = Number.parseInt(rawCode, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : " ";
    })
    .replace(/&#x([\da-fA-F]+);/g, (_match, rawCode: string) => {
      const code = Number.parseInt(rawCode, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : " ";
    })
    .replace(/&([a-zA-Z]+);/g, (match, rawName: string) => named[rawName.toLowerCase()] ?? match)
    .replace(/\s+/g, " ")
    .trim();
}

function extractMetaContents(html: string): string[] {
  const out = new Set<string>();
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (titleMatch?.[1]) {
    const title = normalizeHumanText(stripHtml(titleMatch[1]));
    if (title !== "") {
      out.add(title);
    }
  }

  const metaTagPattern = /<meta\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = metaTagPattern.exec(html)) !== null) {
    const tag = match[0] ?? "";
    const key = normalizeHumanText(extractHtmlAttribute(tag, "name") || extractHtmlAttribute(tag, "property")).toLowerCase();
    const content = normalizeHumanText(decodeHtmlEntities(extractHtmlAttribute(tag, "content")));
    if (content === "") {
      continue;
    }
    if (key === "description" || key === "og:description" || key === "twitter:description" || key === "og:title" || key === "twitter:title") {
      out.add(content);
    }
  }

  return Array.from(out);
}

function extractHtmlAttribute(tag: string, attribute: string): string {
  const direct = new RegExp(`${attribute}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i").exec(tag);
  if (direct?.[2]) {
    return direct[2];
  }

  const unquoted = new RegExp(`${attribute}\\s*=\\s*([^\\s>]+)`, "i").exec(tag);
  if (unquoted?.[1]) {
    return unquoted[1];
  }

  return "";
}

function extractEmbeddedJsonStrings(html: string): string[] {
  const out = new Set<string>();
  const patterns = [
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi,
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/gi,
    /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;/gi,
    /window\.__PRELOADED_STATE__\s*=\s*(\{[\s\S]*?\})\s*;/gi,
    /window\.__NUXT__\s*=\s*(\{[\s\S]*?\})\s*;/gi,
    /TRANSFER_STATE\s*=\s*(\{[\s\S]*?\})\s*;/gi,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null) {
      const candidate = normalizeHumanText(decodeHtmlEntities(match[1] ?? ""));
      if (candidate !== "") {
        out.add(candidate);
      }
    }
  }

  return Array.from(out);
}

function extractContextWindows(haystack: string, needles: string[], radius = 900): string[] {
  const out = new Set<string>();
  const source = String(haystack || "");
  const lowerSource = source.toLowerCase();

  for (const rawNeedle of needles) {
    const needle = String(rawNeedle || "").trim();
    if (needle === "") {
      continue;
    }

    const lowerNeedle = needle.toLowerCase();
    let cursor = 0;
    while (cursor < lowerSource.length) {
      const index = lowerSource.indexOf(lowerNeedle, cursor);
      if (index < 0) {
        break;
      }
      const start = Math.max(0, index - radius);
      const end = Math.min(source.length, index + lowerNeedle.length + radius);
      out.add(source.slice(start, end));
      cursor = index + lowerNeedle.length;
    }
  }

  return Array.from(out);
}

function extractRppsFromText(value: string, wantedRpps: string): string {
  const normalized = normalizeHumanText(value);
  if (wantedRpps !== "" && new RegExp(`\\b${escapeRegExp(wantedRpps)}\\b`).test(normalized)) {
    return wantedRpps;
  }

  const patterns = [
    /\/pp\/detail\/(\d{11})/i,
    /Identifiant\s+RPPS\s*[:\-]?\s*(\d{11})/iu,
    /\bRPPS\b[^\d]{0,20}(\d{11})/iu,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(normalized);
    if (match?.[1]) {
      const rpps = sanitizeRpps(match[1]);
      if (rpps.length === 11) {
        return rpps;
      }
    }
  }

  const allMatches = Array.from(new Set((normalized.match(/\b\d{11}\b/g) ?? []).map((entry) => sanitizeRpps(entry))));
  if (wantedRpps !== "") {
    const exact = allMatches.find((entry) => entry === wantedRpps);
    if (exact) {
      return exact;
    }
  }

  return allMatches.length === 1 ? allMatches[0] : "";
}

function extractLabeledField(text: string, patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const candidate = cleanCapturedField(match?.[1] ?? "");
    if (candidate !== "") {
      return candidate;
    }
  }
  return "";
}

function extractProfessionFromText(text: string): string {
  const patterns = [
    /Civil\s*-\s*([A-ZÀ-ÿ][A-Za-zÀ-ÿ'’\- ]{2,80})/iu,
    /Profession(?:nel de santé)?\s*[:\-]?\s*([A-ZÀ-ÿ][A-Za-zÀ-ÿ0-9'’\- ]{2,80})/iu,
    /Sp[ée]cialit[ée]\s*[:\-]?\s*([A-ZÀ-ÿ][A-Za-zÀ-ÿ0-9'’\- ]{2,80})/iu,
    /Qualification\s*[:\-]?\s*([A-ZÀ-ÿ][A-Za-zÀ-ÿ0-9'’\- ]{2,80})/iu,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const profession = sanitizeProfession(match?.[1] ?? "", "", "");
    if (profession !== "") {
      return profession;
    }
  }

  return "";
}

function extractNameSnippets(text: string): string[] {
  const out = new Set<string>();
  const patterns = [
    /([^.;:]{3,120})\s*-\s*Annuaire Santé\b/giu,
    /([^.;:]{3,120})\.\s*Civil\s*-\s*[A-Za-zÀ-ÿ]/giu,
    /([^.;:]{3,120})\s+Civil\s*-\s*[A-Za-zÀ-ÿ]/giu,
    /Professionnel de santé\.\s*([^.;:]{3,120})\.\s*Civil\s*-\s*[A-Za-zÀ-ÿ]/giu,
    /Dossier du professionnel(?:\s*[:\-]\s*|\s+)([^.;:]{3,120})/giu,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const candidate = cleanCapturedField(match[1] ?? "");
      if (candidate !== "") {
        out.add(candidate);
      }
    }
  }

  return Array.from(out);
}

function parseFullName(rawValue: string): { firstName: string; lastName: string } | null {
  const cleaned = cleanCapturedField(rawValue)
    .replace(/^(?:Dr\.?|Docteur|Mme|Madame|M\.?|Monsieur)\s+/iu, "")
    .trim();

  if (!isLikelyHumanName(cleaned)) {
    return null;
  }

  const tokens = cleaned
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length < 2) {
    return null;
  }

  let firstNameTokens: string[] = [];
  let lastNameTokens: string[] = [];

  const firstUpperIndex = tokens.findIndex((token) => isMostlyUpperToken(token));
  if (firstUpperIndex > 0) {
    firstNameTokens = tokens.slice(0, firstUpperIndex);
    lastNameTokens = tokens.slice(firstUpperIndex);
  } else if (tokens.every((token) => isMostlyUpperToken(token))) {
    firstNameTokens = tokens.slice(0, 1);
    lastNameTokens = tokens.slice(1);
  } else {
    firstNameTokens = tokens.slice(0, 1);
    lastNameTokens = tokens.slice(1);
  }

  const firstName = normalizePersonalPart(firstNameTokens.join(" "));
  const lastName = normalizeLastNamePart(lastNameTokens.join(" "));

  if (firstName === "" || lastName === "") {
    return null;
  }

  return { firstName, lastName };
}

function isLikelyHumanName(value: string): boolean {
  const normalized = normalizeLookupKey(value);
  if (normalized === "") {
    return false;
  }

  const blockedTokens = [
    "ANNUAIRE",
    "SANTE",
    "IDENTIFIANT",
    "RPPS",
    "RECHERCHE",
    "RESULTAT",
    "RESULTATS",
    "DOSSIER",
    "PROFESSIONNEL",
    "EXERCICE",
    "JAVASCRIPT",
    "DESACTIVE",
    "NAVIGATEUR",
    "ATTESTATION",
    "SOURCE",
    "ACTIVITE",
  ];

  return !blockedTokens.some((token) => normalized.includes(token));
}

function cleanCapturedField(value: string): string {
  return normalizeHumanText(
    decodeHtmlEntities(String(value || ""))
      .replace(/\b(?:Identifiant RPPS|En Activit[ée]|Source|Attestation|Situation d[’']exercice|Dossier du professionnel|Javascript est d[ée]sactiv[ée] dans votre navigateur|Annuaire Santé)\b.*$/iu, "")
      .replace(/^[\s.,:;\-–—]+|[\s.,:;\-–—]+$/g, ""),
  );
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

function deduplicateCandidates(candidates: AnnuaireSanteCandidate[]): AnnuaireSanteCandidate[] {
  const out: AnnuaireSanteCandidate[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const normalized: AnnuaireSanteCandidate = {
      rpps: sanitizeRpps(candidate.rpps),
      firstName: normalizePersonalPart(candidate.firstName),
      lastName: normalizeLastNamePart(candidate.lastName),
      profession: sanitizeProfession(candidate.profession, candidate.firstName, candidate.lastName),
    };

    const key = [normalized.rpps, normalized.firstName, normalized.lastName, normalized.profession].join("|");
    if (key === "|||" || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(normalized);
  }

  return out;
}

function isCandidateUsable(candidate: AnnuaireSanteCandidate, wantedRpps: string): boolean {
  const rpps = sanitizeRpps(candidate.rpps);
  const firstName = normalizePersonalPart(candidate.firstName);
  const lastName = normalizeLastNamePart(candidate.lastName);
  const profession = sanitizeProfession(candidate.profession, firstName, lastName);

  if (wantedRpps !== "" && rpps !== "" && rpps !== wantedRpps) {
    return false;
  }

  if (rpps === "" && (firstName === "" || lastName === "")) {
    return false;
  }

  if (rpps !== "" && firstName === "" && lastName === "" && profession === "") {
    return false;
  }

  return rpps !== "" || (firstName !== "" && lastName !== "");
}

function uniqueStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeOptionalString(value);
    if (normalized === "" || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function sanitizeRpps(value: string): string {
  return String(value || "").replace(/\D+/g, "").trim();
}

function normalizeHumanText(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function sanitizeProfession(value: string, firstName: string, lastName: string): string {
  let normalized = cleanCapturedField(value)
    .replace(/^Civil\s*-\s*/iu, "")
    .replace(/\b(?:En Activit[ée]|Source|Attestation|Situation d[’']exercice|Dossier du professionnel)\b.*$/iu, "")
    .replace(/^[\s.,:;\-–—]+|[\s.,:;\-–—]+$/g, "")
    .trim();

  if (normalized === "") {
    return "";
  }

  const candidateKey = normalizeLookupKey(normalized);
  const nameKey = normalizeLookupKey(`${firstName} ${lastName}`);
  if (candidateKey !== "" && candidateKey === nameKey) {
    return "";
  }

  const blockedKeys = new Set([
    "PROFESSIONNEL DE SANTE",
    "IDENTIFIANT RPPS",
    "ANNUAIRE SANTE",
    "JAVASCRIPT EST DESACTIVE DANS VOTRE NAVIGATEUR",
  ]);
  if (blockedKeys.has(candidateKey)) {
    return "";
  }

  return normalized.length > 120 ? normalized.slice(0, 120).trim() : normalized;
}

function normalizePersonalPart(value: string): string {
  const normalized = cleanCapturedField(value);
  if (normalized === "") {
    return "";
  }

  return normalized
    .split(/\s+/)
    .map((part) => titleCaseToken(part))
    .join(" ");
}

function normalizeLastNamePart(value: string): string {
  const normalized = cleanCapturedField(value);
  if (normalized === "") {
    return "";
  }

  return normalized
    .split(/\s+/)
    .map((part) => (isMostlyUpperToken(part) ? part.toUpperCase() : titleCaseToken(part)))
    .join(" ");
}

function titleCaseToken(value: string): string {
  const token = String(value || "").trim();
  if (token === "") {
    return "";
  }

  return token.replace(/[A-Za-zÀ-ÿ]+(?:['’\-][A-Za-zÀ-ÿ]+)*/g, (segment) => segment
    .split(/(['’\-])/)
    .map((part) => {
      if (part === "'" || part === "’" || part === "-") {
        return part;
      }
      if (part === "") {
        return "";
      }
      const lower = part.toLowerCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(""));
}

function isMostlyUpperToken(value: string): boolean {
  const lettersOnly = String(value || "").replace(/[^A-Za-zÀ-ÿ]/g, "");
  if (lettersOnly.length === 0) {
    return false;
  }
  return lettersOnly === lettersOnly.toUpperCase() && lettersOnly !== lettersOnly.toLowerCase();
}

function normalizeLookupKey(value: string): string {
  return normalizeHumanText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

function fingerprint(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url").slice(0, 12);
}

function escapeRegExp(value: string): string {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function looksLikeWafBlock(body: string): boolean {
  const normalized = normalizeLookupKey(stripHtml(body));
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

  return markers.some((marker) => normalized.includes(marker));
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const name = "name" in err ? String((err as { name?: unknown }).name ?? "") : "";
  return name === "AbortError";
}
