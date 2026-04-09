import React from 'react';
import { createRoot } from 'react-dom/client';
import PatientConsole from '../components/PatientConsole';

type AppConfig = {
  restBase: string;
  nonce: string;
};

declare global {
  interface Window {
    SosPrescription?: AppConfig;
    SOSPrescription?: AppConfig;
  }
}

function getConfigOrNull(): AppConfig | null {
  const cfg = (typeof globalThis !== 'undefined' ? (globalThis as unknown as Window) : window).SosPrescription
    || (typeof globalThis !== 'undefined' ? (globalThis as unknown as Window) : window).SOSPrescription;
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

// Entry patient/form: auto-mount dans le DOM.
// IMPORTANT: bundle IIFE => script classique, pas besoin de type="module".
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

  // La config est lue par PatientConsole via window.* ; on ne la modifie pas ici.
  const root = createRoot(rootEl);
  root.render(
    <React.StrictMode>
      <PatientConsole />
    </React.StrictMode>,
  );
})();
