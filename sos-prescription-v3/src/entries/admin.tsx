import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import DoctorMessagingApp from '../components/DoctorMessagingApp';

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

type DoctorMessagingApi = {
  mount: (containerEl: HTMLElement, prescriptionId: number) => void;
  unmount: (containerEl: HTMLElement) => void;
};

type DoctorMessagingBridge = {
  ensureReady: () => Promise<DoctorMessagingApi>;
  mount: (containerEl: HTMLElement, prescriptionId: number) => Promise<void>;
  unmount: (containerEl: HTMLElement) => Promise<void>;
};

type GlobalWindow = Window & {
  SosPrescription?: AppConfig;
  SOSPrescription?: AppConfig;
  SosDoctorMessaging?: DoctorMessagingApi;
  SosDoctorMessagingBridge?: DoctorMessagingBridge;
  __SosPrescriptionFetchPatch?: FetchPatchState;
};

const roots = new WeakMap<HTMLElement, Root>();

function getGlobalWindow(): GlobalWindow {
  return (typeof globalThis !== 'undefined' ? globalThis : window) as unknown as GlobalWindow;
}

function getAppConfigOrNull(): AppConfig | null {
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
  const cfg = getAppConfigOrNull();
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
      const activeConfig = getAppConfigOrNull();
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

function normalizePrescriptionId(value: number): number {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

function mount(containerEl: HTMLElement, prescriptionId: number): void {
  if (!(containerEl instanceof HTMLElement)) {
    return;
  }

  const normalizedId = normalizePrescriptionId(prescriptionId);
  if (normalizedId < 1) {
    throw new Error('PrescriptionId invalide pour le montage React médecin.');
  }

  let root = roots.get(containerEl);
  if (!root) {
    root = createRoot(containerEl);
    roots.set(containerEl, root);
  }

  root.render(
    <React.StrictMode>
      <DoctorMessagingApp prescriptionId={normalizedId} />
    </React.StrictMode>,
  );
}

function unmount(containerEl: HTMLElement): void {
  if (!(containerEl instanceof HTMLElement)) {
    return;
  }

  const root = roots.get(containerEl);
  if (!root) {
    return;
  }

  root.unmount();
  roots.delete(containerEl);
}

const api: DoctorMessagingApi = {
  mount,
  unmount,
};

const bridge: DoctorMessagingBridge = {
  ensureReady: async (): Promise<DoctorMessagingApi> => api,
  mount: async (containerEl: HTMLElement, prescriptionId: number): Promise<void> => {
    api.mount(containerEl, prescriptionId);
  },
  unmount: async (containerEl: HTMLElement): Promise<void> => {
    api.unmount(containerEl);
  },
};

function installGlobals(): void {
  const g = getGlobalWindow();
  g.SosDoctorMessaging = api;
  g.SosDoctorMessagingBridge = bridge;
}

try {
  patchFetch('sosprescription_admin');
  installGlobals();
} catch {
  // Fail-closed: si l'environnement ne permet pas d'écrire sur window, on n'explose pas.
}
