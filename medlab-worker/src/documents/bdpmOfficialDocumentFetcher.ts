import { assertBdpmOfficialUrl, containsUnsupportedOffsiteDocumentSource } from "./bdpmOfficialDocumentSource";

export interface FetchOfficialDocumentResult {
  sourceUrl: string;
  finalUrl: string;
  httpStatus: number;
  durationMs: number;
  rawHtml?: string;
  errorCode?: string;
  errorMessage?: string;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const USER_AGENT = "SOSPrescriptionDocumentPilot/1.0 (+https://sosprescription.fr; worker-only Lot2)";

export async function fetchBdpmOfficialHtml(sourceUrl: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<FetchOfficialDocumentResult> {
  assertBdpmOfficialUrl(sourceUrl);
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(sourceUrl, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml",
      },
    });

    const finalUrl = response.url || sourceUrl;
    try {
      assertBdpmOfficialUrl(finalUrl);
    } catch (err) {
      return {
        sourceUrl,
        finalUrl,
        httpStatus: response.status,
        durationMs: Date.now() - started,
        errorCode: "OFFSITE_SOURCE_UNSUPPORTED",
        errorMessage: err instanceof Error ? err.message : "Final URL is outside the official BDPM host",
      };
    }

    if (response.status === 404) {
      return { sourceUrl, finalUrl, httpStatus: response.status, durationMs: Date.now() - started, errorCode: "DOCUMENT_NOT_FOUND" };
    }

    if (!response.ok) {
      return { sourceUrl, finalUrl, httpStatus: response.status, durationMs: Date.now() - started, errorCode: "HTTP_ERROR", errorMessage: response.statusText };
    }

    const rawHtml = await response.text();
    if (rawHtml.trim() === "") {
      return { sourceUrl, finalUrl, httpStatus: response.status, durationMs: Date.now() - started, errorCode: "EMPTY_CONTENT" };
    }

    if (containsUnsupportedOffsiteDocumentSource(rawHtml)) {
      return { sourceUrl, finalUrl, httpStatus: response.status, durationMs: Date.now() - started, rawHtml, errorCode: "OFFSITE_SOURCE_UNSUPPORTED" };
    }

    return { sourceUrl, finalUrl, httpStatus: response.status, durationMs: Date.now() - started, rawHtml };
  } catch (err) {
    return {
      sourceUrl,
      finalUrl: sourceUrl,
      httpStatus: 0,
      durationMs: Date.now() - started,
      errorCode: err instanceof Error && err.name === "AbortError" ? "FETCH_TIMEOUT" : "FETCH_FAILED",
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}
