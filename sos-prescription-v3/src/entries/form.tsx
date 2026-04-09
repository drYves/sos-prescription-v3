import React from 'react';
import { createRoot } from 'react-dom/client';
import PatientConsole from '../components/PatientConsole';

type AppConfig = {
  restBase: string;
  nonce: string;
  currentUser?: {
    id?: number;
    displayName?: string;
    email?: string;
  };
};

type FetchPatchState = {
  originalFetch: typeof fetch;
  scope: string;
  restBase: string;
  nonce: string;
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
  if (!cfg || typeof cfg.restBase !== 'string' || typeof cfg.nonce !== 'string') {
    return null;
  }
  return cfg;
}

function normalizeRestBase(value: string): string {
  return String(value || '').replace(/\/$/, '');
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

  new Headers(source).forEach((value, key) => {
    target.set(key, value);
  });
}

function patchFetch(scope: string): void {
  if (!scope) {
    return;
  }

  const g = getGlobalWindow();
  const cfg = getConfigOrNull();
  if (!cfg || typeof g.fetch !== 'function') {
    return;
  }

  const restBase = normalizeRestBase(cfg.restBase);
  if (!restBase) {
    return;
  }

  if (g.__SosPrescriptionFetchPatch && typeof g.__SosPrescriptionFetchPatch.originalFetch === 'function') {
    g.__SosPrescriptionFetchPatch.scope = scope;
    g.__SosPrescriptionFetchPatch.restBase = restBase;
    g.__SosPrescriptionFetchPatch.nonce = cfg.nonce;
    return;
  }

  const state: FetchPatchState = {
    originalFetch: g.fetch.bind(g),
    scope,
    restBase,
    nonce: cfg.nonce,
  };

  g.__SosPrescriptionFetchPatch = state;

  const patchedFetch: typeof fetch = async (input, init) => {
    const activeWindow = getGlobalWindow();
    const activeState = activeWindow.__SosPrescriptionFetchPatch || state;

    try {
      const activeConfig = getConfigOrNull();
      const activeRestBase = normalizeRestBase(activeConfig?.restBase || activeState.restBase);
      const activeNonce = String(activeConfig?.nonce || activeState.nonce || '');
      const requestUrl = resolveFetchUrl(input);

      if (!requestUrl || !activeRestBase || !isTargetRestUrl(requestUrl, activeRestBase)) {
        return activeState.originalFetch(input, init);
      }

      const headers = new Headers();
      if (typeof Request !== 'undefined' && input instanceof Request) {
        applyHeaders(headers, input.headers);
      }
      applyHeaders(headers, init?.headers);
      headers.set('X-Sos-Scope', activeState.scope);
      if (activeNonce) {
        headers.set('X-WP-Nonce', activeNonce);
      }

      const nextInit: RequestInit = {
        ...init,
        headers,
      };

      if (typeof Request !== 'undefined' && input instanceof Request) {
        return activeState.originalFetch(new Request(input, nextInit));
      }

      return activeState.originalFetch(input, nextInit);
    } catch {
      return activeState.originalFetch(input, init);
    }
  };

  g.fetch = patchedFetch;
}

function renderFatal(container: HTMLElement, message: string): void {
  container.innerHTML = '';
  const div = document.createElement('div');
  div.style.padding = '12px';
  div.style.border = '1px solid #e5e7eb';
  div.style.borderRadius = '8px';
  div.style.background = '#fff';
  div.style.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
  div.style.fontSize = '14px';
  div.style.color = '#111827';
  div.textContent = message;
  container.appendChild(div);
}

(function boot() {
  const rootEl = document.getElementById('sosprescription-root-form');
  if (!rootEl) {
    return;
  }

  const cfg = getConfigOrNull();
  if (!cfg) {
    renderFatal(rootEl, 'Configuration SosPrescription manquante (restBase/nonce).');
    return;
  }

  patchFetch('sosprescription_form');

  const root = createRoot(rootEl);
  root.render(
    <React.StrictMode>
      <PatientConsole />
    </React.StrictMode>,
  );
})();
