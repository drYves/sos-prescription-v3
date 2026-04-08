import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import DoctorMessagingApp from '../components/DoctorMessagingApp';

type DoctorMessagingApi = {
  mount: (containerEl: HTMLElement, prescriptionId: number) => void;
  unmount: (containerEl: HTMLElement) => void;
};

type DoctorMessagingBridge = {
  ensureReady: () => Promise<DoctorMessagingApi>;
  mount: (containerEl: HTMLElement, prescriptionId: number) => Promise<void>;
  unmount: (containerEl: HTMLElement) => Promise<void>;
};

declare global {
  interface Window {
    SosDoctorMessaging?: DoctorMessagingApi;
    SosDoctorMessagingBridge?: DoctorMessagingBridge;
  }
}

const roots = new WeakMap<HTMLElement, Root>();

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
  window.SosDoctorMessaging = api;
  window.SosDoctorMessagingBridge = bridge;
}

installGlobals();

export { api, bridge, mount, unmount };
export default bridge;
