type LegacyDoctorInboxRefreshOptions = {
  silent?: boolean;
};

type LegacyDoctorInboxSelectOptions = {
  silent?: boolean;
  preserveNotice?: boolean;
};

export type LegacyDoctorInboxSnapshot = {
  selectedId: number;
  listFilter: string;
  list: Array<Record<string, unknown>>;
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
