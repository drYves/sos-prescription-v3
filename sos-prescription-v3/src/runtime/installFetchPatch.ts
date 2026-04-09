type AppConfig = {
  restBase?: string;
  nonce?: string;
};

type FetchPatchState = {
  originalFetch: typeof fetch;
  installed: boolean;
};

type GlobalWindow = Window & {
  SosPrescription?: AppConfig;
  SOSPrescription?: AppConfig;
  __SosPrescriptionFetchPatch?: FetchPatchState;
};

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
    return;
  }

  const state: FetchPatchState = {
    originalFetch: g.fetch.bind(g),
    installed: true,
  };

  g.__SosPrescriptionFetchPatch = state;

  const patchedFetch: typeof fetch = async (input, init) => {
    const activeWindow = getGlobalWindow();
    const activeState = activeWindow.__SosPrescriptionFetchPatch || state;

    try {
      const activeConfig = getConfigOrNull();
      const activeRestBase = normalizeRestBase(activeConfig?.restBase);
      const activeNonce = typeof activeConfig?.nonce === 'string' ? activeConfig.nonce : '';
      const requestUrl = resolveFetchUrl(input);
      const isTargetRequest = Boolean(requestUrl && activeRestBase && isTargetRestUrl(requestUrl, activeRestBase));

      if (!isTargetRequest) {
        return activeState.originalFetch(input, init);
      }

      const headers = new Headers();
      if (typeof Request !== 'undefined' && input instanceof Request) {
        applyHeaders(headers, input.headers);
      }
      applyHeaders(headers, init?.headers);
      headers.set('X-Sos-Scope', detectScope());
      if (activeNonce) {
        headers.set('X-WP-Nonce', activeNonce);
      }

      const nextInit: RequestInit = {
        ...init,
        headers,
      };

      const response = typeof Request !== 'undefined' && input instanceof Request
        ? await activeState.originalFetch(new Request(input, nextInit))
        : await activeState.originalFetch(input, nextInit);

      if (response.status >= 400) {
        await logRejectedResponse(requestUrl, response);
      }

      return response;
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
