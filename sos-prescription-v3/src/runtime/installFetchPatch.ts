type AppConfig = {
  restBase?: string;
  restV4Base?: string;
  nonce?: string;
};

type CachedPrescriptionCollectionEntry = {
  capturedAtMs: number;
  row: unknown;
};

type FetchPatchState = {
  originalFetch: typeof fetch;
  installed: boolean;
  inFlightGetRequests: Map<string, Promise<Response>>;
  prescriptionCollectionCache: Map<number, CachedPrescriptionCollectionEntry>;
};

type GlobalWindow = Window & {
  SosPrescription?: AppConfig;
  SOSPrescription?: AppConfig;
  __SosPrescriptionFetchPatch?: FetchPatchState;
};

const INTERNAL_BYPASS_DEDUP_HEADER = 'X-Sos-Bypass-Dedup';
const IN_FLIGHT_DEDUP_BYPASS_URL_PATTERNS = ['/medications'];
const NONCE_STRIP_URL_PATTERNS = ['/medications/search'];
const NONCE_STRIP_QUERY_PARAM_KEYS = ['_wpnonce'];
const PRESCRIPTION_COLLECTION_CACHE_MAX_AGE_MS = 5000;

function getGlobalWindow(): GlobalWindow {
  return (typeof globalThis !== 'undefined' ? globalThis : window) as unknown as GlobalWindow;
}

function getConfigOrNull(): AppConfig | null {
  const g = getGlobalWindow();
  const cfg = g.SosPrescription || g.SOSPrescription;
  if (!cfg || typeof cfg !== 'object') {
    return null;
  }
  return cfg;
}

function normalizeRestBase(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\/$/, '') : '';
}

function deriveRestV4Base(restBase: string): string {
  if (!restBase) {
    return '';
  }

  return restBase.replace(/\/sosprescription\/v1\/?$/, '/sosprescription/v4');
}

function resolveRestBases(config: AppConfig | null): string[] {
  const restBase = normalizeRestBase(config?.restBase);
  const restV4Base = normalizeRestBase(config?.restV4Base || deriveRestV4Base(restBase));

  return [restBase, restV4Base].filter((value, index, values) => value !== '' && values.indexOf(value) === index);
}

function resolveFetchUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }

  if (typeof URL !== 'undefined' && input instanceof URL) {
    return input.toString();
  }

  if (typeof Request !== 'undefined' && input instanceof Request) {
    return input.url;
  }

  return '';
}

function resolveRequestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (typeof init?.method === 'string' && init.method.trim() !== '') {
    return init.method.trim().toUpperCase();
  }

  if (typeof Request !== 'undefined' && input instanceof Request) {
    return String(input.method || 'GET').toUpperCase();
  }

  return 'GET';
}

function absolutizeUrl(value: string): string {
  if (!value) {
    return '';
  }

  try {
    const origin = typeof window !== 'undefined' && window.location && window.location.origin
      ? window.location.origin
      : 'https://sosprescription.local';
    return new URL(value, origin).toString();
  } catch {
    return String(value || '');
  }
}

function isTargetRestUrl(url: string, restBase: string): boolean {
  const normalizedUrl = absolutizeUrl(url);
  const normalizedRestBase = absolutizeUrl(restBase);
  return normalizedUrl !== '' && normalizedRestBase !== '' && normalizedUrl.startsWith(normalizedRestBase);
}

function isTargetRestRequest(url: string, restBases: string[]): boolean {
  return restBases.some((restBase) => isTargetRestUrl(url, restBase));
}

function extractInternalBooleanHeader(headers: Headers, headerName: string): boolean {
  const rawValue = String(headers.get(headerName) || '').trim().toLowerCase();
  headers.delete(headerName);
  return rawValue === '1' || rawValue === 'true' || rawValue === 'yes';
}

function normalizeUrlForRequestKey(value: string): string {
  if (!value) {
    return '';
  }

  try {
    const origin = typeof window !== 'undefined' && window.location && window.location.origin
      ? window.location.origin
      : 'https://sosprescription.local';
    const url = new URL(value, origin);
    const entries = Array.from(url.searchParams.entries())
      .filter(([key]) => key !== '_ts')
      .sort(([keyA, valueA], [keyB, valueB]) => {
        if (keyA === keyB) {
          return valueA.localeCompare(valueB);
        }
        return keyA.localeCompare(keyB);
      });

    const normalizedParams = new URLSearchParams();
    entries.forEach(([key, entryValue]) => {
      normalizedParams.append(key, entryValue);
    });

    url.hash = '';
    url.search = normalizedParams.toString();
    return url.toString();
  } catch {
    return String(value || '');
  }
}

function buildInFlightRequestKey(url: string, method: string, headers: Headers): string {
  const normalizedUrl = normalizeUrlForRequestKey(url);
  if (!normalizedUrl) {
    return '';
  }

  const scope = String(headers.get('X-Sos-Scope') || '').trim().toLowerCase();
  return `${String(method || 'GET').toUpperCase()} ${normalizedUrl} ${scope}`;
}

function shouldBypassInFlightDedupForUrl(url: string): boolean {
  const normalizedUrl = absolutizeUrl(url).toLowerCase();
  if (!normalizedUrl) {
    return false;
  }

  return IN_FLIGHT_DEDUP_BYPASS_URL_PATTERNS.some((pattern) => normalizedUrl.includes(String(pattern || '').toLowerCase()));
}

function shouldStripNonceForUrl(url: string): boolean {
  const normalizedUrl = absolutizeUrl(url).toLowerCase();
  if (!normalizedUrl) {
    return false;
  }

  return NONCE_STRIP_URL_PATTERNS.some((pattern) => normalizedUrl.includes(String(pattern || '').toLowerCase()));
}

function stripNonceFromUrl(value: string): string {
  if (!value) {
    return '';
  }

  try {
    const origin = typeof window !== 'undefined' && window.location && window.location.origin
      ? window.location.origin
      : 'https://sosprescription.local';
    const url = new URL(value, origin);

    Array.from(url.searchParams.keys()).forEach((key) => {
      if (NONCE_STRIP_QUERY_PARAM_KEYS.includes(String(key || '').toLowerCase())) {
        url.searchParams.delete(key);
      }
    });

    return url.toString();
  } catch {
    return String(value || '');
  }
}

function applyHeaders(target: Headers, source?: HeadersInit): void {
  if (!source) {
    return;
  }

  try {
    new Headers(source).forEach((value, key) => {
      target.set(key, value);
    });
  } catch {
    // Ignore invalid external headers and fall back to a permissive pass-through.
  }
}

function detectScope(): string {
  try {
    if (typeof document !== 'undefined') {
      if (document.getElementById('sosprescription-root-form')) {
        return 'sosprescription_form';
      }

      if (
        document.getElementById('sosprescription-doctor-console-root')
        || document.querySelector('[data-sp-doctor-chat-root="1"]')
      ) {
        return 'sosprescription_admin';
      }

      const currentScript = document.currentScript;
      if (currentScript instanceof HTMLScriptElement) {
        const src = String(currentScript.getAttribute('src') || currentScript.src || '').toLowerCase();
        if (src.endsWith('/form.js') || src.endsWith('form.js') || src.includes('/form-')) {
          return 'sosprescription_form';
        }
        if (src.endsWith('/admin.js') || src.endsWith('admin.js') || src.includes('/admin-')) {
          return 'sosprescription_admin';
        }
      }
    }
  } catch {
    // Ignore detection failures and fall back to the safest admin scope.
  }

  return 'sosprescription_admin';
}

function parsePayloadFromText(text: string): unknown {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toPositiveInteger(value: unknown): number {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

function cloneJsonValue<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

function extractPathSegments(value: string): string[] {
  const normalizedUrl = absolutizeUrl(value);
  if (!normalizedUrl) {
    return [];
  }

  try {
    return new URL(normalizedUrl).pathname.split('/').filter(Boolean);
  } catch {
    return [];
  }
}

function isAdminScope(headers: Headers): boolean {
  const scope = String(headers.get('X-Sos-Scope') || '').trim().toLowerCase();
  return scope.includes('admin');
}

function isPrescriptionCollectionUrl(value: string): boolean {
  const segments = extractPathSegments(value);
  const anchorIndex = segments.lastIndexOf('prescriptions');
  return anchorIndex >= 0 && segments.length === anchorIndex + 1;
}

function extractPrescriptionDetailIdFromUrl(value: string): number {
  const segments = extractPathSegments(value);
  const anchorIndex = segments.lastIndexOf('prescriptions');
  if (anchorIndex < 0 || segments.length !== anchorIndex + 2) {
    return 0;
  }

  return toPositiveInteger(segments[anchorIndex + 1]);
}

function isReusablePrescriptionCollectionRow(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }

  const id = toPositiveInteger(value.id);
  if (id < 1) {
    return false;
  }

  const hasStatus = typeof value.status === 'string' && value.status.trim() !== '';
  const hasCreatedAt = typeof value.created_at === 'string' && value.created_at.trim() !== '';
  const hasItems = Array.isArray(value.items);
  const hasPayload = isRecord(value.payload) && Object.keys(value.payload).length > 0;

  return hasStatus && hasCreatedAt && (hasItems || hasPayload);
}

function pruneExpiredPrescriptionCollectionCache(cache: Map<number, CachedPrescriptionCollectionEntry>): void {
  const now = Date.now();
  Array.from(cache.entries()).forEach(([id, entry]) => {
    if (!entry || now - Number(entry.capturedAtMs || 0) > PRESCRIPTION_COLLECTION_CACHE_MAX_AGE_MS) {
      cache.delete(id);
    }
  });
}

function refreshPrescriptionCollectionCacheTimestamps(cache: Map<number, CachedPrescriptionCollectionEntry>): void {
  const now = Date.now();
  Array.from(cache.entries()).forEach(([id, entry]) => {
    if (!entry) {
      cache.delete(id);
      return;
    }

    cache.set(id, {
      ...entry,
      capturedAtMs: now,
    });
  });
}

function replacePrescriptionCollectionCache(
  cache: Map<number, CachedPrescriptionCollectionEntry>,
  payload: unknown,
): void {
  cache.clear();

  if (!Array.isArray(payload)) {
    return;
  }

  const now = Date.now();
  payload.forEach((entry) => {
    if (!isReusablePrescriptionCollectionRow(entry)) {
      return;
    }

    const id = toPositiveInteger(entry.id);
    if (id < 1) {
      return;
    }

    cache.set(id, {
      capturedAtMs: now,
      row: cloneJsonValue(entry),
    });
  });
}

function readSelectedPrescriptionIdFromDom(): number {
  if (typeof document === 'undefined') {
    return 0;
  }

  const selectedInboxItem = document.querySelector('[data-role="inbox-item"].is-selected[data-id]');
  const selectedInboxId = toPositiveInteger(selectedInboxItem?.getAttribute('data-id'));
  if (selectedInboxId > 0) {
    return selectedInboxId;
  }

  const detailPane = document.querySelector('[data-dc-detail-pane][data-case-id]');
  return toPositiveInteger(detailPane?.getAttribute('data-case-id'));
}

function buildCollectionBackedPrescriptionDetailResponse(
  url: string,
  headers: Headers,
  state: FetchPatchState,
): Response | null {
  if (!isAdminScope(headers)) {
    return null;
  }

  pruneExpiredPrescriptionCollectionCache(state.prescriptionCollectionCache);

  const prescriptionId = extractPrescriptionDetailIdFromUrl(url);
  if (prescriptionId < 1) {
    return null;
  }

  const selectedPrescriptionId = readSelectedPrescriptionIdFromDom();
  if (selectedPrescriptionId > 0 && selectedPrescriptionId === prescriptionId) {
    return null;
  }

  const cachedEntry = state.prescriptionCollectionCache.get(prescriptionId);
  if (!cachedEntry) {
    return null;
  }

  return new Response(JSON.stringify(cloneJsonValue(cachedEntry.row)), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'X-SOSPrescription-FetchPatch': 'collection-cache',
    },
  });
}

async function rememberPrescriptionCollectionResponse(
  url: string,
  headers: Headers,
  response: Response,
  state: FetchPatchState,
): Promise<void> {
  if (!response.ok || !isAdminScope(headers) || !isPrescriptionCollectionUrl(url)) {
    return;
  }

  try {
    const payload = parsePayloadFromText(await response.clone().text());
    if (Array.isArray(payload)) {
      replacePrescriptionCollectionCache(state.prescriptionCollectionCache, payload);
      return;
    }

    if (isRecord(payload) && payload.unchanged === true) {
      refreshPrescriptionCollectionCacheTimestamps(state.prescriptionCollectionCache);
    }
  } catch {
    // Ignore cache priming failures and let the request resolve normally.
  }
}

function safeConsoleError(...args: unknown[]): void {
  try {
    if (typeof console !== 'undefined' && typeof console.error === 'function') {
      console.error(...args);
    }
  } catch {
    // Ignore console failures in hostile browser environments.
  }
}

async function logRejectedResponse(url: string, response: Response): Promise<void> {
  const targetUrl = response.url || url || '(inconnue)';

  try {
    const rawText = await response.clone().text();
    const payload = parsePayloadFromText(rawText);

    if (payload !== null && payload !== '') {
      safeConsoleError(`[FetchPatch] Rejet réseau sur l'URL ${targetUrl} avec le statut ${response.status}`, {
        status: response.status,
        url: targetUrl,
        payload,
      });
      return;
    }

    safeConsoleError(`[FetchPatch] Rejet réseau sur l'URL ${targetUrl} avec le statut ${response.status}`, {
      status: response.status,
      url: targetUrl,
    });
  } catch (error) {
    safeConsoleError(
      `[FetchPatch] Rejet réseau sur l'URL ${targetUrl} avec le statut ${response.status} (lecture du payload impossible)`,
      error,
    );
  }
}

function installFetchPatch(): void {
  const g = getGlobalWindow();
  if (typeof g.fetch !== 'function') {
    return;
  }

  const existingState = g.__SosPrescriptionFetchPatch;
  if (existingState && existingState.installed && typeof existingState.originalFetch === 'function') {
    if (!(existingState.inFlightGetRequests instanceof Map)) {
      existingState.inFlightGetRequests = new Map<string, Promise<Response>>();
    }
    if (!(existingState.prescriptionCollectionCache instanceof Map)) {
      existingState.prescriptionCollectionCache = new Map<number, CachedPrescriptionCollectionEntry>();
    }
    return;
  }

  const state: FetchPatchState = {
    originalFetch: g.fetch.bind(g),
    installed: true,
    inFlightGetRequests: new Map<string, Promise<Response>>(),
    prescriptionCollectionCache: new Map<number, CachedPrescriptionCollectionEntry>(),
  };

  g.__SosPrescriptionFetchPatch = state;

  const patchedFetch: typeof fetch = async (input, init) => {
    const activeWindow = getGlobalWindow();
    const activeState = activeWindow.__SosPrescriptionFetchPatch || state;

    try {
      const activeConfig = getConfigOrNull();
      const activeRestBases = resolveRestBases(activeConfig);
      const activeNonce = typeof activeConfig?.nonce === 'string' ? activeConfig.nonce : '';
      const requestUrl = resolveFetchUrl(input);
      const requestMethod = resolveRequestMethod(input, init);
      const isTargetRequest = Boolean(requestUrl && activeRestBases.length > 0 && isTargetRestRequest(requestUrl, activeRestBases));

      if (!isTargetRequest) {
        return activeState.originalFetch(input, init);
      }

      const headers = new Headers();
      if (typeof Request !== 'undefined' && input instanceof Request) {
        applyHeaders(headers, input.headers);
      }
      applyHeaders(headers, init?.headers);

      const bypassInFlightDedup = extractInternalBooleanHeader(headers, INTERNAL_BYPASS_DEDUP_HEADER);
      const stripNonceForRequest = shouldStripNonceForUrl(requestUrl);
      const effectiveRequestUrl = stripNonceForRequest ? stripNonceFromUrl(requestUrl) : requestUrl;

      if (stripNonceForRequest) {
        headers.delete('X-WP-Nonce');
      }

      headers.set('X-Sos-Scope', detectScope());
      if (activeNonce && !stripNonceForRequest) {
        headers.set('X-WP-Nonce', activeNonce);
      }

      const nextInit: RequestInit = {
        ...init,
        method: requestMethod,
        headers,
      };

      if (requestMethod === 'GET' && !bypassInFlightDedup) {
        const cachedDetailResponse = buildCollectionBackedPrescriptionDetailResponse(effectiveRequestUrl, headers, activeState);
        if (cachedDetailResponse) {
          return cachedDetailResponse;
        }
      }

      const executeRequest = async (): Promise<Response> => {
        const response = typeof Request !== 'undefined' && input instanceof Request
          ? await activeState.originalFetch(
            stripNonceForRequest
              ? new Request(effectiveRequestUrl, {
                method: requestMethod,
                headers,
                cache: init?.cache ?? input.cache,
                credentials: init?.credentials ?? input.credentials,
                integrity: init?.integrity ?? input.integrity,
                keepalive: init?.keepalive ?? input.keepalive,
                mode: init?.mode ?? input.mode,
                redirect: init?.redirect ?? input.redirect,
                referrer: init?.referrer ?? input.referrer,
                referrerPolicy: init?.referrerPolicy ?? input.referrerPolicy,
                signal: init?.signal ?? input.signal,
              })
              : new Request(input, nextInit)
          )
          : await activeState.originalFetch(effectiveRequestUrl || input, nextInit);

        if (response.status >= 400) {
          await logRejectedResponse(effectiveRequestUrl, response);
        }

        if (requestMethod === 'GET') {
          await rememberPrescriptionCollectionResponse(effectiveRequestUrl, headers, response, activeState);
        }

        return response;
      };

      const bypassUrlDedup = shouldBypassInFlightDedupForUrl(effectiveRequestUrl);

      if (requestMethod !== 'GET' || bypassInFlightDedup || bypassUrlDedup) {
        return executeRequest();
      }

      const requestKey = buildInFlightRequestKey(effectiveRequestUrl, requestMethod, headers);
      if (!requestKey) {
        return executeRequest();
      }

      const existingPromise = activeState.inFlightGetRequests.get(requestKey);
      if (existingPromise) {
        return existingPromise.then((response) => response.clone());
      }

      const requestPromise = executeRequest();
      activeState.inFlightGetRequests.set(requestKey, requestPromise);

      requestPromise.finally(() => {
        const liveState = getGlobalWindow().__SosPrescriptionFetchPatch || activeState;
        if (liveState.inFlightGetRequests.get(requestKey) === requestPromise) {
          liveState.inFlightGetRequests.delete(requestKey);
        }
      });

      return requestPromise.then((response) => response.clone());
    } catch (error) {
      const requestUrl = resolveFetchUrl(input);
      const effectiveRequestUrl = shouldStripNonceForUrl(requestUrl) ? stripNonceFromUrl(requestUrl) : requestUrl;
      safeConsoleError(`[FetchPatch] Erreur réseau sur l'URL ${effectiveRequestUrl || '(inconnue)'}`, {
        url: effectiveRequestUrl || '(inconnue)',
        error,
      });
      throw error;
    }
  };

  g.fetch = patchedFetch;
}

try {
  installFetchPatch();
} catch {
  // Fail-closed: if the environment forbids patching fetch, keep native fetch untouched.
}
