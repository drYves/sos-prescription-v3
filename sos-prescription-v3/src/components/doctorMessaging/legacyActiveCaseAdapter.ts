type LegacyDoctorActiveCaseRefreshOptions = {
  silent?: boolean;
};

export type LegacyDoctorActiveCaseSnapshot = {
  selectedId: number;
  detail: Record<string, unknown> | null;
  pdf: Record<string, unknown> | null;
  detailLoading: boolean;
  detailTab: string;
  reason: string;
};

type LegacyDoctorActiveCaseOwner = {
  getSnapshot?: () => Partial<LegacyDoctorActiveCaseSnapshot> | null;
  refreshDetail?: (id: number, opts?: LegacyDoctorActiveCaseRefreshOptions) => Promise<unknown> | unknown;
  refreshPdf?: (id: number, opts?: LegacyDoctorActiveCaseRefreshOptions) => Promise<unknown> | unknown;
  subscribe?: (listener: (snapshot: LegacyDoctorActiveCaseSnapshot) => void) => (() => void) | void;
};

declare global {
  interface Window {
    SosDoctorActiveCaseOwner?: LegacyDoctorActiveCaseOwner;
  }
}

const LEGACY_DOCTOR_ACTIVE_CASE_EVENT = 'sosprescription:doctor-active-case-changed';

function normalizeText(value: unknown): string {
  return String(value == null ? '' : value).trim();
}

function normalizePrescriptionId(value: unknown): number {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

function cloneRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    return { ...(value as Record<string, unknown>) };
  }
}

function getLegacyDoctorActiveCaseOwner(): LegacyDoctorActiveCaseOwner | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const owner = window.SosDoctorActiveCaseOwner;
  return owner && typeof owner === 'object' ? owner : null;
}

export function getLegacyDoctorActiveCaseSnapshot(fallbackSelectedId = 0): LegacyDoctorActiveCaseSnapshot {
  const owner = getLegacyDoctorActiveCaseOwner();
  const rawSnapshot = owner?.getSnapshot?.() ?? null;
  const rawObject = rawSnapshot && typeof rawSnapshot === 'object' ? rawSnapshot : null;

  return {
    selectedId: normalizePrescriptionId(rawObject?.selectedId ?? fallbackSelectedId),
    detail: cloneRecord(rawObject?.detail),
    pdf: cloneRecord(rawObject?.pdf),
    detailLoading: Boolean(rawObject?.detailLoading),
    detailTab: normalizeText(rawObject?.detailTab),
    reason: normalizeText(rawObject?.reason),
  };
}

export function parseLegacyDoctorActiveCaseSnapshot(serializedSnapshot: string): LegacyDoctorActiveCaseSnapshot {
  try {
    const raw = JSON.parse(serializedSnapshot) as Partial<LegacyDoctorActiveCaseSnapshot> | null;
    const record = raw && typeof raw === 'object' ? raw : null;

    return {
      selectedId: normalizePrescriptionId(record?.selectedId),
      detail: cloneRecord(record?.detail),
      pdf: cloneRecord(record?.pdf),
      detailLoading: Boolean(record?.detailLoading),
      detailTab: normalizeText(record?.detailTab),
      reason: normalizeText(record?.reason),
    };
  } catch {
    return {
      selectedId: 0,
      detail: null,
      pdf: null,
      detailLoading: false,
      detailTab: '',
      reason: 'parse-error',
    };
  }
}

export function getLegacyDoctorActiveCaseSnapshotSerialized(fallbackSelectedId = 0): string {
  return JSON.stringify(getLegacyDoctorActiveCaseSnapshot(fallbackSelectedId));
}

export function subscribeLegacyDoctorActiveCase(listener: () => void): () => void {
  if (typeof listener !== 'function') {
    return () => {};
  }

  const owner = getLegacyDoctorActiveCaseOwner();
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

  window.addEventListener(LEGACY_DOCTOR_ACTIVE_CASE_EVENT, handleChange as EventListener);
  return (): void => {
    window.removeEventListener(LEGACY_DOCTOR_ACTIVE_CASE_EVENT, handleChange as EventListener);
  };
}

export async function refreshLegacyDoctorActiveCaseDetail(
  id: number,
  opts?: LegacyDoctorActiveCaseRefreshOptions,
): Promise<unknown> {
  const owner = getLegacyDoctorActiveCaseOwner();
  const normalizedId = normalizePrescriptionId(id);
  if (!owner || typeof owner.refreshDetail !== 'function' || normalizedId < 1) {
    return null;
  }

  return owner.refreshDetail(normalizedId, opts);
}

export async function refreshLegacyDoctorActiveCasePdf(
  id: number,
  opts?: LegacyDoctorActiveCaseRefreshOptions,
): Promise<unknown> {
  const owner = getLegacyDoctorActiveCaseOwner();
  const normalizedId = normalizePrescriptionId(id);
  if (!owner || typeof owner.refreshPdf !== 'function' || normalizedId < 1) {
    return null;
  }

  return owner.refreshPdf(normalizedId, opts);
}
