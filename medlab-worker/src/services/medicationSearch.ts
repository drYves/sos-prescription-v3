import { Prisma, PrismaClient } from "@prisma/client";
import { NdjsonLogger } from "../logger";

let prismaSingleton: PrismaClient | null = null;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 250;
const MIN_TEXT_QUERY_LENGTH = 2;
const MIN_NUMERIC_QUERY_LENGTH = 3;
const STUPEFIANT_REGEX = "(^|[[:space:]])stupefiant(s)?($|[[:space:]])";

export interface MedicationSearchConfig {
  prisma?: PrismaClient;
  logger?: NdjsonLogger;
}

export interface MedicationSearchInput {
  query?: unknown;
  limit?: unknown;
}

export interface MedicationSearchResult {
  cis: string;
  cip13: string;
  cip7: string;
  label: string;
  sublabel: string | null;
  denomination: string;
  libellePresentation: string | null;
  reimbursementRate: string | null;
  priceTtc: number | null;
  isSelectable: boolean;
}

export interface MedicationSearchResponse {
  query: string;
  normalizedQuery: string;
  limit: number;
  total: number;
  items: MedicationSearchResult[];
}

interface SearchQueryShape {
  query: string;
  normalizedQuery: string;
  digitsOnly: string;
  limit: number;
  kind: "numeric" | "text";
  tokens: string[];
}

interface MedicationSearchRow {
  cis: string;
  cip13: string;
  cip7: string;
  label: string;
  sublabel: string | null;
  reimbursementRate: string | null;
  priceEuro: Prisma.Decimal | number | string | null;
  totalCount: bigint | number | string;
  isSelectable: boolean;
}

export class MedicationSearchError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(code: string, statusCode: number, message: string) {
    super(message);
    this.name = "MedicationSearchError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class MedicationSearchService {
  private readonly prisma: PrismaClient;
  private readonly logger?: NdjsonLogger;

  constructor(cfg: MedicationSearchConfig = {}) {
    this.prisma = cfg.prisma ?? getPrismaClient();
    this.logger = cfg.logger;
  }

  async search(input: MedicationSearchInput): Promise<MedicationSearchResponse> {
    const normalized = normalizeMedicationSearchInput(input);

    try {
      const rows = normalized.kind === "numeric"
        ? await this.searchByNumericIdentifier(normalized)
        : await this.searchByNormalizedLabel(normalized);

      return {
        query: normalized.query,
        normalizedQuery: normalized.normalizedQuery,
        limit: normalized.limit,
        total: rows.length > 0 ? normalizeTotalCount(rows[0].totalCount) : 0,
        items: rows.map(mapMedicationSearchRow),
      };
    } catch (err: unknown) {
      if (err instanceof MedicationSearchError) {
        throw err;
      }

      this.logger?.error(
        "medication_search.repo_failed",
        {
          query: normalized.query,
          normalized_query: normalized.normalizedQuery,
          limit: normalized.limit,
          reason: err instanceof Error ? err.message : "medication_search_failed",
        },
        undefined,
        err,
      );

      throw new MedicationSearchError("ML_MEDICATION_SEARCH_FAILED", 500, "medication_search_failed");
    }
  }

  private async searchByNumericIdentifier(input: SearchQueryShape): Promise<MedicationSearchRow[]> {
    const prefixValue = `${input.digitsOnly}%`;

    const query = Prisma.sql`
      WITH cpd_flags AS (
        SELECT
          cpd."cis" AS "cis",
          BOOL_OR(cpd."normalizedCondition" ~ ${STUPEFIANT_REGEX}) AS "hasStupefiantCondition"
        FROM "BdpmPrescriptionCondition" cpd
        GROUP BY cpd."cis"
      )
      SELECT
        m."cis" AS "cis",
        p."cip13" AS "cip13",
        p."cip7" AS "cip7",
        m."denomination" AS "label",
        NULLIF(BTRIM(p."label"), '') AS "sublabel",
        NULLIF(BTRIM(p."reimbursementRate"), '') AS "reimbursementRate",
        p."priceEuro" AS "priceEuro",
        COUNT(*) OVER() AS "totalCount",
        CASE
          WHEN p."cip13" = ${input.digitsOnly} THEN 0
          WHEN p."cip7" = ${input.digitsOnly} THEN 1
          WHEN m."cis" = ${input.digitsOnly} THEN 2
          WHEN p."cip13" LIKE ${prefixValue} THEN 3
          WHEN p."cip7" LIKE ${prefixValue} THEN 4
          WHEN m."cis" LIKE ${prefixValue} THEN 5
          ELSE 9
        END AS "matchRank",
        CASE
          WHEN BTRIM(m."commercializationState") = 'Commercialisée'
            AND BTRIM(p."presentationCommercializationState") = 'Déclaration de commercialisation' THEN 0
          WHEN BTRIM(p."presentationCommercializationState") = 'Déclaration de commercialisation' THEN 1
          WHEN BTRIM(m."commercializationState") = 'Commercialisée' THEN 2
          ELSE 3
        END AS "commercializationRank",
        CASE
          WHEN COALESCE(cpd."hasStupefiantCondition", FALSE) = TRUE THEN FALSE
          ELSE TRUE
        END AS "isSelectable"
      FROM "BdpmPresentation" p
      INNER JOIN "BdpmMedication" m
        ON m."cis" = p."cis"
      LEFT JOIN cpd_flags cpd
        ON cpd."cis" = m."cis"
      WHERE (
        p."cip13" = ${input.digitsOnly}
        OR p."cip7" = ${input.digitsOnly}
        OR m."cis" = ${input.digitsOnly}
        OR p."cip13" LIKE ${prefixValue}
        OR p."cip7" LIKE ${prefixValue}
        OR m."cis" LIKE ${prefixValue}
      )
      ORDER BY
        "commercializationRank" ASC,
        "matchRank" ASC,
        "isSelectable" DESC,
        CHAR_LENGTH(m."denomination") ASC,
        m."cis" ASC,
        p."cip13" ASC
      LIMIT ${input.limit}
    `;

    return this.prisma.$queryRaw<MedicationSearchRow[]>(query);
  }

  private async searchByNormalizedLabel(input: SearchQueryShape): Promise<MedicationSearchRow[]> {
    const fullPrefix = `${input.normalizedQuery}%`;
    const fullContains = `%${input.normalizedQuery}%`;
    const tokenClauses = buildTokenClauses(input.tokens);

    const query = Prisma.sql`
      WITH cpd_flags AS (
        SELECT
          cpd."cis" AS "cis",
          BOOL_OR(cpd."normalizedCondition" ~ ${STUPEFIANT_REGEX}) AS "hasStupefiantCondition"
        FROM "BdpmPrescriptionCondition" cpd
        GROUP BY cpd."cis"
      )
      SELECT
        m."cis" AS "cis",
        p."cip13" AS "cip13",
        p."cip7" AS "cip7",
        m."denomination" AS "label",
        NULLIF(BTRIM(p."label"), '') AS "sublabel",
        NULLIF(BTRIM(p."reimbursementRate"), '') AS "reimbursementRate",
        p."priceEuro" AS "priceEuro",
        COUNT(*) OVER() AS "totalCount",
        CASE
          WHEN m."normalizedDenomination" = ${input.normalizedQuery} THEN 0
          WHEN m."normalizedDenomination" LIKE ${fullPrefix} THEN 1
          WHEN m."normalizedDenomination" LIKE ${fullContains} THEN 2
          WHEN p."normalizedLabel" = ${input.normalizedQuery} THEN 3
          WHEN p."normalizedLabel" LIKE ${fullPrefix} THEN 4
          WHEN p."normalizedLabel" LIKE ${fullContains} THEN 5
          ELSE 9
        END AS "matchRank",
        CASE
          WHEN BTRIM(m."commercializationState") = 'Commercialisée'
            AND BTRIM(p."presentationCommercializationState") = 'Déclaration de commercialisation' THEN 0
          WHEN BTRIM(p."presentationCommercializationState") = 'Déclaration de commercialisation' THEN 1
          WHEN BTRIM(m."commercializationState") = 'Commercialisée' THEN 2
          ELSE 3
        END AS "commercializationRank",
        CASE
          WHEN COALESCE(cpd."hasStupefiantCondition", FALSE) = TRUE THEN FALSE
          ELSE TRUE
        END AS "isSelectable"
      FROM "BdpmPresentation" p
      INNER JOIN "BdpmMedication" m
        ON m."cis" = p."cis"
      LEFT JOIN cpd_flags cpd
        ON cpd."cis" = m."cis"
      WHERE ${tokenClauses}
      ORDER BY
        "commercializationRank" ASC,
        "matchRank" ASC,
        "isSelectable" DESC,
        CHAR_LENGTH(m."denomination") ASC,
        m."cis" ASC,
        p."cip13" ASC
      LIMIT ${input.limit}
    `;

    return this.prisma.$queryRaw<MedicationSearchRow[]>(query);
  }
}

function getPrismaClient(): PrismaClient {
  if (!prismaSingleton) {
    prismaSingleton = new PrismaClient();
  }

  return prismaSingleton;
}

function normalizeMedicationSearchInput(input: MedicationSearchInput): SearchQueryShape {
  const query = normalizeQueryString(input.query);
  const limit = normalizeLimit(input.limit);
  const digitsOnly = query.replace(/\D+/g, "");

  if (digitsOnly.length === query.replace(/\s+/g, "").length && digitsOnly.length >= MIN_NUMERIC_QUERY_LENGTH) {
    return {
      query,
      normalizedQuery: digitsOnly,
      digitsOnly,
      limit,
      kind: "numeric",
      tokens: [digitsOnly],
    };
  }

  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length < MIN_TEXT_QUERY_LENGTH) {
    throw new MedicationSearchError(
      "ML_MEDICATION_SEARCH_BAD_REQUEST",
      400,
      "query must contain at least 2 non-space characters",
    );
  }

  const tokens = normalizedQuery
    .split(" ")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return {
    query,
    normalizedQuery,
    digitsOnly,
    limit,
    kind: "text",
    tokens,
  };
}

function normalizeQueryString(value: unknown): string {
  if (typeof value !== "string") {
    throw new MedicationSearchError("ML_MEDICATION_SEARCH_BAD_REQUEST", 400, "query is required");
  }

  const normalized = value.trim();
  if (normalized === "") {
    throw new MedicationSearchError("ML_MEDICATION_SEARCH_BAD_REQUEST", 400, "query is required");
  }

  if (normalized.length > 160) {
    throw new MedicationSearchError("ML_MEDICATION_SEARCH_BAD_REQUEST", 400, "query is too long");
  }

  return normalized;
}

function normalizeLimit(value: unknown): number {
  if (value == null || value === "") {
    return DEFAULT_LIMIT;
  }

  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new MedicationSearchError("ML_MEDICATION_SEARCH_BAD_REQUEST", 400, "limit is invalid");
  }

  return Math.min(MAX_LIMIT, Math.trunc(parsed));
}

function buildTokenClauses(tokens: string[]): Prisma.Sql {
  if (tokens.length === 0) {
    return Prisma.sql`FALSE`;
  }

  const tokenFilters = tokens.map((token) => Prisma.sql`
    (
      m."normalizedDenomination" LIKE ${`%${token}%`}
      OR p."normalizedLabel" LIKE ${`%${token}%`}
    )
  `);

  return Prisma.join(tokenFilters, " AND ");
}

function mapMedicationSearchRow(row: MedicationSearchRow): MedicationSearchResult {
  const label = normalizeOptionalText(row.label) ?? "Médicament";
  const sublabel = normalizeOptionalText(row.sublabel);

  return {
    cis: normalizeRequiredText(row.cis),
    cip13: normalizeRequiredText(row.cip13),
    cip7: normalizeRequiredText(row.cip7),
    label,
    sublabel,
    denomination: label,
    libellePresentation: sublabel,
    reimbursementRate: normalizeOptionalText(row.reimbursementRate),
    priceTtc: normalizeNullableNumber(row.priceEuro),
    isSelectable: row.isSelectable,
  };
}

function normalizeRequiredText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (value == null) {
    return "";
  }

  return String(value).trim();
}

function normalizeOptionalText(value: unknown): string | null {
  const normalized = normalizeRequiredText(value);
  return normalized === "" ? null : normalized;
}

function normalizeNullableNumber(value: unknown): number | null {
  if (value == null || value === "") {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (typeof value === "object" && value !== null && "toString" in value) {
    const parsed = Number(String(value));
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function normalizeTotalCount(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  }

  if (typeof value === "bigint") {
    return value > 0n ? Number(value) : 0;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
  }

  if (typeof value === "object" && value !== null && "toString" in value) {
    const parsed = Number(String(value));
    return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
  }

  return 0;
}

export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}
