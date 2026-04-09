import '../runtime/installFetchPatch';
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

function getGlobalWindow(): Window {
  return (typeof globalThis !== 'undefined' ? globalThis : window) as unknown as Window;
}

function getConfigOrNull(): AppConfig | null {
  const g = getGlobalWindow() as Window & {
    SosPrescription?: AppConfig;
    SOSPrescription?: AppConfig;
  };
  const cfg = g.SosPrescription || g.SOSPrescription;
  if (!cfg || typeof cfg.restBase !== 'string' || typeof cfg.nonce !== 'string') {
    return null;
  }
  return cfg;
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

  const root = createRoot(rootEl);
  root.render(
    React.createElement(
      React.StrictMode,
      null,
      React.createElement(PatientConsole),
    ),
  );
})();
