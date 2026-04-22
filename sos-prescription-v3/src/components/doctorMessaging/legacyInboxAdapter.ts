type LegacyDoctorInboxRefreshOptions = {
  silent?: boolean;
};

export type LegacyDoctorInboxSelectOptions = {
  silent?: boolean;
  preserveNotice?: boolean;
};

export type LegacyDoctorInboxSnapshot = {
  selectedId: number;
  listFilter: string;
  list: Array<Record<string, unknown>>;
  reason: string;
};

export type LegacyDoctorInboxSelectionSnapshot = {
  selectedId: number;
  requestedSelectedId: number;
  selectionPending: boolean;
  hasLegacyOwner: boolean;
  reason: string;
};

type LegacyDoctorInboxOwner = {
  getSelectedId?: () => number;
  getListFilter?: () => string;
  getSnapshot?: () => Partial<LegacyDoctorInboxSnapshot> | null;
  fetchList?: (opts?: LegacyDoctorInboxRefreshOptions) => Promise<unknown> | unknown;
  selectCase?: (id: number, opts?: LegacyDoctorInboxSelectOptions) => Promise<unknown> | unknown;
  subscribe?: (listener: (snapshot: LegacyDoctorInboxSnapshot) => void) => (() => void) | void;
};

declare global {
  interface Window {
    SosDoctorInboxOwner?: LegacyDoctorInboxOwner;
  }
}

const LEGACY_DOCTOR_INBOX_EVENT = 'sosprescription:doctor-inbox-changed';

const selectionStateListeners = new Set<() => void>();

let requestedSelectedId = 0;
let selectionPending = false;
let selectionReason = 'bootstrap';
let stopSelectionSync: (() => void) | null = null;

function normalizeText(value: unknown): string {
  return String(value == null ? '' : value).trim();
}

function normalizePrescriptionId(value: unknown): number {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

function normalizeList(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => ({ ...entry }));
}

function getLegacyDoctorInboxOwner(): LegacyDoctorInboxOwner | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const owner = window.SosDoctorInboxOwner;
  return owner && typeof owner === 'object' ? owner : null;
}

function emitSelectionStateChange(reason: string): void {
  selectionReason = normalizeText(reason) || selectionReason;
  selectionStateListeners.forEach((listener) => {
    try {
      listener();
    } catch {
      // no-op defensive listener isolation
    }
  });
}

function reconcileSelectionState(reason: string, fallbackSelectedId = 0): void {
  const snapshot = getLegacyDoctorInboxSnapshot(fallbackSelectedId);
  const effectiveSelectedId = snapshot.selectedId;

  if (selectionPending) {
    if (effectiveSelectedId > 0 && effectiveSelectedId === requestedSelectedId) {
      selectionPending = false;
    }
  } else if (effectiveSelectedId > 0) {
    requestedSelectedId = effectiveSelectedId;
  } else if (!getLegacyDoctorInboxOwner()) {
    requestedSelectedId = normalizePrescriptionId(fallbackSelectedId);
  } else {
    requestedSelectedId = 0;
  }

  selectionReason = normalizeText(reason) || selectionReason;
}

function ensureSelectionStateSync(): void {
  if (stopSelectionSync) {
    return;
  }

  stopSelectionSync = subscribeLegacyInboxSelection(() => {
    reconcileSelectionState('legacy-sync');
    emitSelectionStateChange('legacy-sync');
  });
}

function releaseSelectionStateSync(): void {
  if (selectionStateListeners.size > 0 || !stopSelectionSync) {
    return;
  }

  stopSelectionSync();
  stopSelectionSync = null;
}

export function getLegacyDoctorInboxSnapshot(fallbackSelectedId = 0): LegacyDoctorInboxSnapshot {
  const owner = getLegacyDoctorInboxOwner();
  const rawSnapshot = owner?.getSnapshot?.() ?? null;
  const rawObject = rawSnapshot && typeof rawSnapshot === 'object' ? rawSnapshot : null;

  const selectedId = normalizePrescriptionId(rawObject?.selectedId ?? owner?.getSelectedId?.() ?? fallbackSelectedId);
  const listFilter = normalizeText(rawObject?.listFilter ?? owner?.getListFilter?.() ?? '');
  const list = normalizeList(rawObject?.list ?? []);
  const reason = normalizeText(rawObject?.reason ?? '');

  return {
    selectedId,
    listFilter,
    list,
    reason,
  };
}

export function getLegacySelectedId(fallbackSelectedId = 0): number {
  const owner = getLegacyDoctorInboxOwner();
  const directSelectedId = normalizePrescriptionId(owner?.getSelectedId?.() ?? fallbackSelectedId);
  if (directSelectedId > 0) {
    return directSelectedId;
  }

  const rawSnapshot = owner?.getSnapshot?.() ?? null;
  const rawObject = rawSnapshot && typeof rawSnapshot === 'object' ? rawSnapshot : null;
  return normalizePrescriptionId(rawObject?.selectedId ?? fallbackSelectedId);
}

export function subscribeLegacyInboxSelection(listener: () => void): () => void {
  const owner = getLegacyDoctorInboxOwner();
  if (owner && typeof owner.subscribe === 'function') {
    const unsubscribe = owner.subscribe(() => {
      listener();
    });
    return typeof unsubscribe === 'function' ? unsubscribe : () => {};
  }

  if (typeof window === 'undefined') {
    return () => {};
  }

  const handleChange = (): void => {
    listener();
  };

  window.addEventListener(LEGACY_DOCTOR_INBOX_EVENT, handleChange as EventListener);
  return (): void => {
    window.removeEventListener(LEGACY_DOCTOR_INBOX_EVENT, handleChange as EventListener);
  };
}

export function getLegacyDoctorInboxSelectionSnapshot(fallbackSelectedId = 0): LegacyDoctorInboxSelectionSnapshot {
  const inboxSnapshot = getLegacyDoctorInboxSnapshot(fallbackSelectedId);
  const hasLegacyOwner = !!getLegacyDoctorInboxOwner();
  const effectiveSelectedId = inboxSnapshot.selectedId;
  const normalizedRequestedId = normalizePrescriptionId(requestedSelectedId);
  const nextRequestedId = normalizedRequestedId > 0
    ? normalizedRequestedId
    : (effectiveSelectedId > 0 ? effectiveSelectedId : 0);
  const pending = Boolean(selectionPending && nextRequestedId > 0 && nextRequestedId !== effectiveSelectedId);

  return {
    selectedId: effectiveSelectedId,
    requestedSelectedId: pending ? nextRequestedId : (effectiveSelectedId > 0 ? effectiveSelectedId : nextRequestedId),
    selectionPending: pending,
    hasLegacyOwner,
    reason: normalizeText(selectionReason || inboxSnapshot.reason || 'selection'),
  };
}

export function getLegacyDoctorInboxSelectionSnapshotSerialized(fallbackSelectedId = 0): string {
  return JSON.stringify(getLegacyDoctorInboxSelectionSnapshot(fallbackSelectedId));
}

export function subscribeLegacyDoctorInboxSelectionState(listener: () => void): () => void {
  if (typeof listener !== 'function') {
    return () => {};
  }

  selectionStateListeners.add(listener);
  ensureSelectionStateSync();

  return (): void => {
    selectionStateListeners.delete(listener);
    releaseSelectionStateSync();
  };
}

export async function refreshLegacyDoctorInbox(opts?: LegacyDoctorInboxRefreshOptions): Promise<unknown> {
  const owner = getLegacyDoctorInboxOwner();
  if (!owner || typeof owner.fetchList !== 'function') {
    return null;
  }
  return owner.fetchList(opts);
}

export async function selectLegacyDoctorCase(id: number, opts?: LegacyDoctorInboxSelectOptions): Promise<unknown> {
  const owner = getLegacyDoctorInboxOwner();
  const normalizedId = normalizePrescriptionId(id);
  if (!owner || typeof owner.selectCase !== 'function' || normalizedId < 1) {
    return null;
  }
  return owner.selectCase(normalizedId, opts);
}

export async function requestLegacyDoctorCaseSelection(id: number, opts?: LegacyDoctorInboxSelectOptions): Promise<unknown> {
  const normalizedId = normalizePrescriptionId(id);
  if (normalizedId < 1) {
    return null;
  }

  const effectiveSelectedIdBeforeRequest = getLegacyDoctorInboxSnapshot(0).selectedId;
  requestedSelectedId = normalizedId;
  selectionPending = effectiveSelectedIdBeforeRequest !== normalizedId;
  emitSelectionStateChange('selection-requested');

  try {
    const result = await selectLegacyDoctorCase(normalizedId, opts);
    const effectiveSelectedIdAfterRequest = getLegacyDoctorInboxSnapshot(0).selectedId;

    if (effectiveSelectedIdAfterRequest > 0 && effectiveSelectedIdAfterRequest === normalizedId) {
      requestedSelectedId = normalizedId;
      selectionPending = false;
      emitSelectionStateChange('selection-applied');
      return result;
    }

    requestedSelectedId = effectiveSelectedIdAfterRequest > 0 ? effectiveSelectedIdAfterRequest : 0;
    selectionPending = false;
    emitSelectionStateChange(effectiveSelectedIdAfterRequest > 0 ? 'selection-reconciled' : 'selection-cleared');
    return result;
  } catch (error) {
    const effectiveSelectedIdAfterError = getLegacyDoctorInboxSnapshot(0).selectedId;
    requestedSelectedId = effectiveSelectedIdAfterError > 0 ? effectiveSelectedIdAfterError : 0;
    selectionPending = false;
    emitSelectionStateChange('selection-error');
    throw error;
  }
}
