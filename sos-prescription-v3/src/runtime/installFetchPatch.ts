type AppConfig = {
  restBase?: string;
  restV4Base?: string;
  nonce?: string;
};

type FetchPatchState = {
  originalFetch: typeof fetch;
  installed: boolean;
  inFlightGetRequests: Map<string, Promise<Response>>;
};

type GlobalWindow = Window & {
  SosPrescription?: AppConfig;
  SOSPrescription?: AppConfig;
  __SosPrescriptionFetchPatch?: FetchPatchState;
};

const INTERNAL_BYPASS_DEDUP_HEADER = 'X-Sos-Bypass-Dedup';

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
    return;
  }

  const state: FetchPatchState = {
    originalFetch: g.fetch.bind(g),
    installed: true,
    inFlightGetRequests: new Map<string, Promise<Response>>(),
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

      headers.set('X-Sos-Scope', detectScope());
      if (activeNonce) {
        headers.set('X-WP-Nonce', activeNonce);
      }

      const nextInit: RequestInit = {
        ...init,
        method: requestMethod,
        headers,
      };

      const executeRequest = async (): Promise<Response> => {
        const response = typeof Request !== 'undefined' && input instanceof Request
          ? await activeState.originalFetch(new Request(input, nextInit))
          : await activeState.originalFetch(input, nextInit);

        if (response.status >= 400) {
          await logRejectedResponse(requestUrl, response);
        }

        return response;
      };

      if (requestMethod !== 'GET' || bypassInFlightDedup) {
        return executeRequest();
      }

      const requestKey = buildInFlightRequestKey(requestUrl, requestMethod, headers);
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
      safeConsoleError(`[FetchPatch] Erreur réseau sur l'URL ${requestUrl || '(inconnue)'}`, {
        url: requestUrl || '(inconnue)',
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
