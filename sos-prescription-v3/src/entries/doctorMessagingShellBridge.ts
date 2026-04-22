import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import DoctorMessagingWorkspace from '../components/DoctorMessagingWorkspace';
import DoctorInbox from '../components/doctorMessaging/DoctorInbox';
import DoctorActiveCasePanel from '../components/doctorMessaging/DoctorActiveCasePanel';
import { DoctorMessagingProvider } from '../components/doctorMessaging/DoctorMessagingProvider';

export type DoctorMessagingApi = {
  mount: (containerEl: HTMLElement, prescriptionId: number) => void;
  unmount: (containerEl: HTMLElement) => void;
  mountInbox?: (containerEl: HTMLElement) => void;
  unmountInbox?: (containerEl: HTMLElement) => void;
  mountActiveCase?: (containerEl: HTMLElement, prescriptionId: number) => void;
  unmountActiveCase?: (containerEl: HTMLElement) => void;
};

export type DoctorMessagingBridge = {
  ensureReady: () => Promise<DoctorMessagingApi>;
  mount: (containerEl: HTMLElement, prescriptionId: number) => Promise<void>;
  unmount: (containerEl: HTMLElement) => Promise<void>;
  mountInbox?: (containerEl: HTMLElement) => Promise<void>;
  unmountInbox?: (containerEl: HTMLElement) => Promise<void>;
  mountActiveCase?: (containerEl: HTMLElement, prescriptionId: number) => Promise<void>;
  unmountActiveCase?: (containerEl: HTMLElement) => Promise<void>;
};

declare global {
  interface Window {
    SosDoctorMessaging?: DoctorMessagingApi;
    SosDoctorMessagingBridge?: DoctorMessagingBridge;
  }
}

const roots = new WeakMap<HTMLElement, Root>();
const inboxRoots = new WeakMap<HTMLElement, Root>();
const activeCaseRoots = new WeakMap<HTMLElement, Root>();

function normalizePrescriptionId(value: number): number {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

function renderWorkspace(root: Root, prescriptionId: number): void {
  root.render(
    React.createElement(
      React.StrictMode,
      null,
      React.createElement(
        DoctorMessagingProvider,
        { prescriptionId },
        React.createElement(DoctorMessagingWorkspace),
      ),
    ),
  );
}

function renderInbox(root: Root): void {
  root.render(
    React.createElement(
      React.StrictMode,
      null,
      React.createElement(
        DoctorMessagingProvider,
        { prescriptionId: null },
        React.createElement(DoctorInbox),
      ),
    ),
  );
}

function renderActiveCase(root: Root, prescriptionId: number): void {
  root.render(
    React.createElement(
      React.StrictMode,
      null,
      React.createElement(
        DoctorMessagingProvider,
        { prescriptionId },
        React.createElement(DoctorActiveCasePanel),
      ),
    ),
  );
}

function mountWorkspace(containerEl: HTMLElement, prescriptionId: number): void {
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

  renderWorkspace(root, normalizedId);
}

function mountInbox(containerEl: HTMLElement): void {
  if (!(containerEl instanceof HTMLElement)) {
    return;
  }

  let root = inboxRoots.get(containerEl);
  if (!root) {
    root = createRoot(containerEl);
    inboxRoots.set(containerEl, root);
  }

  renderInbox(root);
}

function unmountInbox(containerEl: HTMLElement): void {
  if (!(containerEl instanceof HTMLElement)) {
    return;
  }

  const root = inboxRoots.get(containerEl);
  if (!root) {
    return;
  }

  root.unmount();
  inboxRoots.delete(containerEl);
}

function mountActiveCase(containerEl: HTMLElement, prescriptionId: number): void {
  if (!(containerEl instanceof HTMLElement)) {
    return;
  }

  const normalizedId = normalizePrescriptionId(prescriptionId);
  if (normalizedId < 1) {
    throw new Error('PrescriptionId invalide pour le panneau React du dossier actif.');
  }

  let root = activeCaseRoots.get(containerEl);
  if (!root) {
    root = createRoot(containerEl);
    activeCaseRoots.set(containerEl, root);
  }

  renderActiveCase(root, normalizedId);
}

function unmountActiveCase(containerEl: HTMLElement): void {
  if (!(containerEl instanceof HTMLElement)) {
    return;
  }

  const root = activeCaseRoots.get(containerEl);
  if (!root) {
    return;
  }

  root.unmount();
  activeCaseRoots.delete(containerEl);
}

function unmountWorkspace(containerEl: HTMLElement): void {
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

function createDoctorMessagingApi(): DoctorMessagingApi {
  return {
    mount: mountWorkspace,
    unmount: unmountWorkspace,
    mountInbox,
    unmountInbox,
    mountActiveCase,
    unmountActiveCase,
  };
}

function createDoctorMessagingBridge(api: DoctorMessagingApi): DoctorMessagingBridge {
  return {
    ensureReady: async (): Promise<DoctorMessagingApi> => api,
    mount: async (containerEl: HTMLElement, prescriptionId: number): Promise<void> => {
      api.mount(containerEl, prescriptionId);
    },
    unmount: async (containerEl: HTMLElement): Promise<void> => {
      api.unmount(containerEl);
    },
    mountInbox: async (containerEl: HTMLElement): Promise<void> => {
      api.mountInbox?.(containerEl);
    },
    unmountInbox: async (containerEl: HTMLElement): Promise<void> => {
      api.unmountInbox?.(containerEl);
    },
    mountActiveCase: async (containerEl: HTMLElement, prescriptionId: number): Promise<void> => {
      api.mountActiveCase?.(containerEl, prescriptionId);
    },
    unmountActiveCase: async (containerEl: HTMLElement): Promise<void> => {
      api.unmountActiveCase?.(containerEl);
    },
  };
}

export function installDoctorMessagingShellBridge(): void {
  const api = createDoctorMessagingApi();
  const bridge = createDoctorMessagingBridge(api);
  const g = (typeof globalThis !== 'undefined' ? globalThis : window) as unknown as Window;
  g.SosDoctorMessaging = api;
  g.SosDoctorMessagingBridge = bridge;
}
