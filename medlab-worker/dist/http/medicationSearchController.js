"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleMedicationSearchRequest = handleMedicationSearchRequest;
const medicationSearch_1 = require("../services/medicationSearch");
async function handleMedicationSearchRequest(url, cfg = {}) {
    const service = cfg.service ?? new medicationSearch_1.MedicationSearchService({ logger: cfg.logger });
    try {
        const result = await service.search({
            query: resolveQuery(url),
            limit: url.searchParams.get("limit"),
        });
        return buildSuccessResponse(result);
    }
    catch (err) {
        if (err instanceof medicationSearch_1.MedicationSearchError) {
            return {
                statusCode: err.statusCode,
                body: {
                    ok: false,
                    code: err.code,
                },
            };
        }
        cfg.logger?.error("medication_search.controller_failed", {
            query: url.searchParams.get("q") ?? url.searchParams.get("query") ?? url.searchParams.get("term"),
            reason: err instanceof Error ? err.message : "medication_search_controller_failed",
        }, undefined, err);
        return {
            statusCode: 500,
            body: {
                ok: false,
                code: "ML_MEDICATION_SEARCH_FAILED",
            },
        };
    }
}
function resolveQuery(url) {
    return (url.searchParams.get("q")
        ?? url.searchParams.get("query")
        ?? url.searchParams.get("term")
        ?? "");
}
function buildSuccessResponse(result) {
    return {
        statusCode: 200,
        body: {
            ok: true,
            query: result.query,
            normalized_query: result.normalizedQuery,
            limit: result.limit,
            items: result.items.map((item) => ({
                cis: item.cis,
                cip13: item.cip13,
                label: item.label,
                sublabel: item.sublabel,
                is_selectable: item.isSelectable,
            })),
        },
    };
}
