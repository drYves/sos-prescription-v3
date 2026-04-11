import { URL } from "node:url";
import { NdjsonLogger } from "../logger";
import {
  MedicationSearchError,
  MedicationSearchService,
  type MedicationSearchResponse,
} from "../services/medicationSearch";

export interface MedicationSearchControllerConfig {
  logger?: NdjsonLogger;
  service?: MedicationSearchService;
}

export interface MedicationSearchHttpResponse {
  statusCode: number;
  body: Record<string, unknown>;
}

export async function handleMedicationSearchRequest(
  url: URL,
  cfg: MedicationSearchControllerConfig = {},
): Promise<MedicationSearchHttpResponse> {
  const service = cfg.service ?? new MedicationSearchService({ logger: cfg.logger });

  try {
    const result = await service.search({
      query: resolveQuery(url),
      limit: url.searchParams.get("limit"),
    });

    return buildSuccessResponse(result);
  } catch (err: unknown) {
    if (err instanceof MedicationSearchError) {
      return {
        statusCode: err.statusCode,
        body: {
          ok: false,
          code: err.code,
        },
      };
    }

    cfg.logger?.error(
      "medication_search.controller_failed",
      {
        query: url.searchParams.get("q") ?? url.searchParams.get("query") ?? url.searchParams.get("term"),
        reason: err instanceof Error ? err.message : "medication_search_controller_failed",
      },
      undefined,
      err,
    );

    return {
      statusCode: 500,
      body: {
        ok: false,
        code: "ML_MEDICATION_SEARCH_FAILED",
      },
    };
  }
}

function resolveQuery(url: URL): string {
  return (
    url.searchParams.get("q")
    ?? url.searchParams.get("query")
    ?? url.searchParams.get("term")
    ?? ""
  );
}

function buildSuccessResponse(result: MedicationSearchResponse): MedicationSearchHttpResponse {
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
