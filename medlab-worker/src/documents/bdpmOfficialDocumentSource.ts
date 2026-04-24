export const BDPM_DOCUMENT_SOURCE = "bdpm_extrait";
export const BDPM_OFFICIAL_HOST = "base-donnees-publique.medicaments.gouv.fr";
export const DEFAULT_BDPM_EXTRACT_BASE_URL = `https://${BDPM_OFFICIAL_HOST}/`;

export interface ResolvedOfficialDocumentSource {
  cis: string;
  sourceUrl: string;
}

export function resolveBdpmExtraitSource(cis: string): ResolvedOfficialDocumentSource {
  const normalizedCis = normalizeCis(cis);
  const url = new URL(`/medicament/${encodeURIComponent(normalizedCis)}/extrait`, DEFAULT_BDPM_EXTRACT_BASE_URL);
  assertBdpmOfficialUrl(url.toString());
  return { cis: normalizedCis, sourceUrl: url.toString() };
}

export function assertBdpmOfficialUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`INVALID_SOURCE_URL: ${value}`);
  }

  if (parsed.protocol !== "https:" || parsed.hostname !== BDPM_OFFICIAL_HOST) {
    throw new Error(`SOURCE_HOST_UNSUPPORTED: ${parsed.hostname}`);
  }
}

export function normalizeCis(value: string): string {
  const trimmed = String(value ?? "").trim();
  if (!/^\d{8}$/.test(trimmed)) {
    throw new Error(`INVALID_CIS: ${trimmed || "empty"}`);
  }
  return trimmed;
}

export function containsUnsupportedOffsiteDocumentSource(html: string): boolean {
  const normalized = html.toLowerCase();
  return normalized.includes("ema.europa.eu")
    || normalized.includes("vous allez être redirigé")
    || normalized.includes("vous allez etre redirige")
    || normalized.includes("commission européenne")
    || normalized.includes("commission europeenne");
}
