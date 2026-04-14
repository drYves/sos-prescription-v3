"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MedicationSearchService = exports.MedicationSearchError = void 0;
exports.normalizeSearchText = normalizeSearchText;
const client_1 = require("@prisma/client");
let prismaSingleton = null;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MIN_TEXT_QUERY_LENGTH = 2;
const MIN_NUMERIC_QUERY_LENGTH = 3;
const STUPEFIANT_REGEX = "(^|[[:space:]])stupefiant(s)?($|[[:space:]])";
class MedicationSearchError extends Error {
    code;
    statusCode;
    constructor(code, statusCode, message) {
        super(message);
        this.name = "MedicationSearchError";
        this.code = code;
        this.statusCode = statusCode;
    }
}
exports.MedicationSearchError = MedicationSearchError;
class MedicationSearchService {
    prisma;
    logger;
    constructor(cfg = {}) {
        this.prisma = cfg.prisma ?? getPrismaClient();
        this.logger = cfg.logger;
    }
    async search(input) {
        const normalized = normalizeMedicationSearchInput(input);
        try {
            const rows = normalized.kind === "numeric"
                ? await this.searchByNumericIdentifier(normalized)
                : await this.searchByNormalizedLabel(normalized);
            return {
                query: normalized.query,
                normalizedQuery: normalized.normalizedQuery,
                limit: normalized.limit,
                items: rows.map(mapMedicationSearchRow),
            };
        }
        catch (err) {
            if (err instanceof MedicationSearchError) {
                throw err;
            }
            this.logger?.error("medication_search.repo_failed", {
                query: normalized.query,
                normalized_query: normalized.normalizedQuery,
                limit: normalized.limit,
                reason: err instanceof Error ? err.message : "medication_search_failed",
            }, undefined, err);
            throw new MedicationSearchError("ML_MEDICATION_SEARCH_FAILED", 500, "medication_search_failed");
        }
    }
    async searchByNumericIdentifier(input) {
        const prefixValue = `${input.digitsOnly}%`;
        const query = client_1.Prisma.sql `
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
        m."denomination" AS "label",
        NULLIF(BTRIM(p."label"), '') AS "sublabel",
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
        return this.prisma.$queryRaw(query);
    }
    async searchByNormalizedLabel(input) {
        const fullPrefix = `${input.normalizedQuery}%`;
        const fullContains = `%${input.normalizedQuery}%`;
        const tokenClauses = buildTokenClauses(input.tokens);
        const query = client_1.Prisma.sql `
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
        m."denomination" AS "label",
        NULLIF(BTRIM(p."label"), '') AS "sublabel",
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
        return this.prisma.$queryRaw(query);
    }
}
exports.MedicationSearchService = MedicationSearchService;
function getPrismaClient() {
    if (!prismaSingleton) {
        prismaSingleton = new client_1.PrismaClient();
    }
    return prismaSingleton;
}
function normalizeMedicationSearchInput(input) {
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
        throw new MedicationSearchError("ML_MEDICATION_SEARCH_BAD_REQUEST", 400, "query must contain at least 2 non-space characters");
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
function normalizeQueryString(value) {
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
function normalizeLimit(value) {
    if (value == null || value === "") {
        return DEFAULT_LIMIT;
    }
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new MedicationSearchError("ML_MEDICATION_SEARCH_BAD_REQUEST", 400, "limit is invalid");
    }
    return Math.min(MAX_LIMIT, Math.trunc(parsed));
}
function buildTokenClauses(tokens) {
    if (tokens.length === 0) {
        return client_1.Prisma.sql `FALSE`;
    }
    const tokenFilters = tokens.map((token) => client_1.Prisma.sql `
    (
      m."normalizedDenomination" LIKE ${`%${token}%`}
      OR p."normalizedLabel" LIKE ${`%${token}%`}
    )
  `);
    return client_1.Prisma.join(tokenFilters, " AND ");
}
function mapMedicationSearchRow(row) {
    return {
        cis: row.cis,
        cip13: row.cip13,
        label: row.label,
        sublabel: row.sublabel,
        isSelectable: row.isSelectable,
    };
}
function normalizeSearchText(value) {
    return value
        .normalize("NFD")
        .replace(/\p{Diacritic}+/gu, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .replace(/\s+/g, " ");
}
