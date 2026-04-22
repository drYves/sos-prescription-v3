import {
  type DoctorInboxRefreshOptions as SourceRefreshOptions,
  type DoctorInboxSelectOptions as SourceSelectOptions,
  getDoctorInboxSourceSnapshot,
  getDoctorInboxSourceSnapshotSerialized,
  requestDoctorInboxSelection,
  refreshDoctorInboxSource,
  subscribeDoctorInboxSource,
} from './useDoctorInboxSource';

type LegacyDoctorInboxRefreshOptions = SourceRefreshOptions;

export type LegacyDoctorInboxSelectOptions = SourceSelectOptions;

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

function normalizeText(value: unknown): string {
  return String(value == null ? '' : value).trim();
}

function normalizePrescriptionId(value: unknown): number {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

function cloneRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((row) => ({ ...row }));
}

export function getLegacyDoctorInboxSnapshot(fallbackSelectedId = 0): LegacyDoctorInboxSnapshot {
  const sourceSnapshot = getDoctorInboxSourceSnapshot();
  const selectedId = sourceSnapshot.selectedId > 0
    ? sourceSnapshot.selectedId
    : normalizePrescriptionId(fallbackSelectedId);

  return {
    selectedId,
    listFilter: normalizeText(sourceSnapshot.listFilter),
    list: cloneRows(sourceSnapshot.list),
    reason: normalizeText(sourceSnapshot.reason),
  };
}

export function getLegacySelectedId(fallbackSelectedId = 0): number {
  return getLegacyDoctorInboxSnapshot(fallbackSelectedId).selectedId;
}

export function subscribeLegacyInboxSelection(listener: () => void): () => void {
  if (typeof listener !== 'function') {
    return () => {};
  }

  return subscribeDoctorInboxSource(listener);
}

export function getLegacyDoctorInboxSelectionSnapshot(fallbackSelectedId = 0): LegacyDoctorInboxSelectionSnapshot {
  const sourceSnapshot = getDoctorInboxSourceSnapshot();
  const selectedId = sourceSnapshot.selectedId > 0
    ? sourceSnapshot.selectedId
    : normalizePrescriptionId(fallbackSelectedId);
  const requestedSelectedId = sourceSnapshot.requestedSelectedId > 0
    ? sourceSnapshot.requestedSelectedId
    : selectedId;

  return {
    selectedId,
    requestedSelectedId,
    selectionPending: Boolean(sourceSnapshot.selectionPending && requestedSelectedId > 0 && requestedSelectedId !== selectedId),
    hasLegacyOwner: false,
    reason: normalizeText(sourceSnapshot.reason),
  };
}

export function getLegacyDoctorInboxSelectionSnapshotSerialized(fallbackSelectedId = 0): string {
  return JSON.stringify(getLegacyDoctorInboxSelectionSnapshot(fallbackSelectedId));
}

export function subscribeLegacyDoctorInboxSelectionState(listener: () => void): () => void {
  return subscribeLegacyInboxSelection(listener);
}

export async function refreshLegacyDoctorInbox(opts?: LegacyDoctorInboxRefreshOptions): Promise<unknown> {
  return refreshDoctorInboxSource(opts);
}

export async function selectLegacyDoctorCase(id: number, opts?: LegacyDoctorInboxSelectOptions): Promise<unknown> {
  return requestDoctorInboxSelection(id, opts);
}

export async function requestLegacyDoctorCaseSelection(id: number, opts?: LegacyDoctorInboxSelectOptions): Promise<unknown> {
  return requestDoctorInboxSelection(id, opts);
}

export function getLegacyDoctorInboxSnapshotSerialized(): string {
  return getDoctorInboxSourceSnapshotSerialized();
}
