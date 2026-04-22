import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { apiJson } from './doctorMessagingSurfaceTransport';

export type DoctorInboxFilterKey = 'pending' | 'approved' | 'rejected' | 'all';
export type DoctorInboxRow = Record<string, unknown>;

export type DoctorInboxRefreshOptions = {
  silent?: boolean;
};

export type DoctorInboxSelectOptions = {
  silent?: boolean;
  preserveNotice?: boolean;
};

export type DoctorInboxSourceSnapshot = {
  list: DoctorInboxRow[];
  listFilter: DoctorInboxFilterKey;
  listLoading: boolean;
  hasLoaded: boolean;
  selectedId: number;
  requestedSelectedId: number;
  selectionPending: boolean;
  reason: string;
  error: string;
  hasLegacySelectionExecutor: boolean;
};

type DoctorInboxSourceListener = () => void;

type DoctorInboxSourceSnapshotListener = (snapshot: DoctorInboxSourceSnapshot) => void;

type DoctorInboxSourceController = {
  getSnapshot: () => DoctorInboxSourceSnapshot;
  subscribe: (listener: DoctorInboxSourceSnapshotListener) => () => void;
  refresh: (opts?: DoctorInboxRefreshOptions) => Promise<DoctorInboxSourceSnapshot>;
  setFilter: (filterKey: DoctorInboxFilterKey) => Promise<DoctorInboxSourceSnapshot>;
  requestSelection: (prescriptionId: number, opts?: DoctorInboxSelectOptions) => Promise<unknown>;
};

type DoctorInboxExecutor = {
  selectCase?: (prescriptionId: number, opts?: DoctorInboxSelectOptions) => Promise<unknown> | unknown;
};

declare global {
  interface Window {
    SosDoctorInboxSource?: DoctorInboxSourceController;
    SosDoctorInboxOwner?: DoctorInboxExecutor;
  }
}

const DOCTOR_INBOX_SOURCE_READY_EVENT = 'sosprescription:doctor-inbox-source-ready';
const POLL_VISIBLE_MS = 15_000;
const POLL_HIDDEN_MS = 30_000;
const POLL_RETRY_MS = 5_000;
const PENDING_BUCKET_STATUSES = ['pending', 'payment_pending', 'in_review', 'needs_info'];

const filterMeta: Record<DoctorInboxFilterKey, { status: string }> = {
  pending: { status: '' },
  approved: { status: 'approved' },
  rejected: { status: 'rejected' },
  all: { status: '' },
};

let snapshot: DoctorInboxSourceSnapshot = {
  list: [],
  listFilter: 'pending',
  listLoading: false,
  hasLoaded: false,
  selectedId: 0,
  requestedSelectedId: 0,
  selectionPending: false,
  reason: 'bootstrap',
  error: '',
  hasLegacySelectionExecutor: false,
};

const listeners = new Set<DoctorInboxSourceListener>();
let pollHandle: number | null = null;
let pollInFlight = false;
let visibilityBound = false;
let inFlightRefresh: Promise<DoctorInboxSourceSnapshot> | null = null;
let queuedRefreshAfterInFlight = false;
let globalInstalled = false;

function normalizeText(value: unknown): string {
  return String(value == null ? '' : value).trim();
}

function normalizePrescriptionId(value: unknown): number {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

function normalizeFilterKey(value: unknown): DoctorInboxFilterKey {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === 'approved' || normalized === 'rejected' || normalized === 'all') {
    return normalized;
  }
  return 'pending';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): DoctorInboxRow[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is DoctorInboxRow => !!entry && typeof entry === 'object' && !Array.isArray(entry))
    : [];
}

function firstText(values: unknown[]): string {
  for (const value of values) {
    const text = normalizeText(value);
    if (text) {
      return text;
    }
  }
  return '';
}

function cloneRows(rows: DoctorInboxRow[]): DoctorInboxRow[] {
  return rows.map((row) => ({ ...row }));
}

function getLegacySelectionExecutor(): DoctorInboxExecutor | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const executor = window.SosDoctorInboxOwner;
  return executor && typeof executor === 'object' ? executor : null;
}

function withExecutorFlag(nextSnapshot: DoctorInboxSourceSnapshot): DoctorInboxSourceSnapshot {
  return {
    ...nextSnapshot,
    hasLegacySelectionExecutor: Boolean(getLegacySelectionExecutor()?.selectCase),
  };
}

function emitSnapshot(reason: string, partial?: Partial<DoctorInboxSourceSnapshot>): DoctorInboxSourceSnapshot {
  snapshot = withExecutorFlag({
    ...snapshot,
    ...(partial || {}),
    reason: normalizeText(reason) || snapshot.reason,
  });

  listeners.forEach((listener) => {
    try {
      listener();
    } catch {
      // no-op defensive listener isolation
    }
  });

  return snapshot;
}

function readSnapshot(): DoctorInboxSourceSnapshot {
  return snapshot;
}

function cloneSnapshot(source: DoctorInboxSourceSnapshot = snapshot): DoctorInboxSourceSnapshot {
  return {
    ...source,
    list: cloneRows(source.list),
  };
}

function getPollDelay(): number {
  if (typeof document !== 'undefined' && document.hidden) {
    return POLL_HIDDEN_MS;
  }
  return POLL_VISIBLE_MS;
}

function stopPolling(): void {
  if (pollHandle != null && typeof window !== 'undefined') {
    window.clearTimeout(pollHandle);
  }
  pollHandle = null;
}

function scheduleNextPoll(delayMs: number): void {
  if (typeof window === 'undefined' || listeners.size < 1) {
    return;
  }

  stopPolling();
  pollHandle = window.setTimeout(runPollCycle, Math.max(1000, Number(delayMs || getPollDelay())));
}

function finalizePollCycle(delayMs: number): void {
  pollInFlight = false;
  scheduleNextPoll(delayMs);
}

function handleVisibilityChange(): void {
  if (listeners.size < 1) {
    return;
  }

  if (typeof document !== 'undefined' && document.hidden) {
    scheduleNextPoll(getPollDelay());
    return;
  }

  if (!pollInFlight) {
    scheduleNextPoll(1200);
  }
}

function ensureVisibilityBinding(): void {
  if (visibilityBound || typeof document === 'undefined') {
    return;
  }

  document.addEventListener('visibilitychange', handleVisibilityChange);
  visibilityBound = true;
}

function buildListPath(filterKey: DoctorInboxFilterKey): string {
  const meta = filterMeta[filterKey] || filterMeta.pending;
  const params = ['limit=50', 'offset=0'];
  if (filterKey !== 'pending' && meta.status) {
    params.push(`status=${encodeURIComponent(meta.status)}`);
  }
  return `/prescriptions?${params.join('&')}`;
}

function getBusinessStatusForFilter(row: DoctorInboxRow): string {
  const payload = asRecord(row.payload);
  const worker = asRecord(payload.worker);

  const businessStatus = normalizeText(row.status).toLowerCase();
  if (businessStatus) {
    return businessStatus;
  }

  const workerStatus = normalizeText(worker.status).toLowerCase();
  const processingStatus = normalizeText(worker.processing_status).toLowerCase();

  if (workerStatus === 'approved' || workerStatus === 'done' || processingStatus === 'done') {
    return 'approved';
  }
  if (workerStatus === 'rejected' || processingStatus === 'failed') {
    return 'rejected';
  }
  if (processingStatus === 'claimed' || processingStatus === 'processing') {
    return 'in_review';
  }

  return 'pending';
}

function rowMatchesFilter(row: DoctorInboxRow, filterKey: DoctorInboxFilterKey): boolean {
  if (filterKey === 'all') {
    return true;
  }

  const status = getBusinessStatusForFilter(row);
  if (filterKey === 'pending') {
    return PENDING_BUCKET_STATUSES.includes(status);
  }

  return status === filterKey;
}

function extractPriority(row: DoctorInboxRow): 'Express' | 'Standard' {
  const payload = asRecord(row.payload);
  const requestPayload = asRecord(payload.request);
  const priority = firstText([
    row.priority,
    payload.priority,
    payload.request_priority,
    requestPayload.priority,
  ]).toLowerCase();

  return priority === 'express' ? 'Express' : 'Standard';
}

function sortRows(rows: DoctorInboxRow[]): DoctorInboxRow[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const leftExpress = extractPriority(left.row) === 'Express' ? 1 : 0;
      const rightExpress = extractPriority(right.row) === 'Express' ? 1 : 0;
      if (leftExpress !== rightExpress) {
        return rightExpress - leftExpress;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.row);
}

function rowExists(rows: DoctorInboxRow[], prescriptionId: number): boolean {
  return rows.some((row) => normalizePrescriptionId(row.id) === prescriptionId);
}

function chooseNextSelectedId(rows: DoctorInboxRow[]): number {
  const currentSelectedId = normalizePrescriptionId(snapshot.selectedId);
  if (currentSelectedId > 0 && rowExists(rows, currentSelectedId)) {
    return currentSelectedId;
  }

  const requestedSelectedId = normalizePrescriptionId(snapshot.requestedSelectedId);
  if (requestedSelectedId > 0 && rowExists(rows, requestedSelectedId)) {
    return requestedSelectedId;
  }

  return normalizePrescriptionId(rows[0]?.id);
}

async function executeLegacySelection(
  prescriptionId: number,
  opts?: DoctorInboxSelectOptions,
): Promise<unknown> {
  const executor = getLegacySelectionExecutor();
  if (!executor || typeof executor.selectCase !== 'function') {
    emitSnapshot('selection-executor-missing', {
      hasLegacySelectionExecutor: false,
      error: 'Exécuteur de sélection legacy introuvable.',
    });
    return null;
  }

  emitSnapshot('selection-applied', {
    selectedId: prescriptionId,
    requestedSelectedId: prescriptionId,
    selectionPending: false,
    error: '',
    hasLegacySelectionExecutor: true,
  });

  return executor.selectCase(prescriptionId, opts);
}

export async function requestDoctorInboxSelection(
  prescriptionId: number,
  opts?: DoctorInboxSelectOptions,
): Promise<unknown> {
  const normalizedId = normalizePrescriptionId(prescriptionId);
  if (normalizedId < 1) {
    return null;
  }

  emitSnapshot('selection-requested', {
    requestedSelectedId: normalizedId,
    selectionPending: snapshot.selectedId !== normalizedId,
    error: '',
  });

  try {
    return await executeLegacySelection(normalizedId, opts);
  } catch (error) {
    emitSnapshot('selection-error', {
      requestedSelectedId: snapshot.selectedId,
      selectionPending: false,
      error: error instanceof Error ? error.message : 'Impossible de changer de dossier.',
    });
    throw error;
  }
}

export async function refreshDoctorInboxSource(
  opts?: DoctorInboxRefreshOptions,
): Promise<DoctorInboxSourceSnapshot> {
  if (inFlightRefresh) {
    queuedRefreshAfterInFlight = true;
    return inFlightRefresh;
  }

  const silent = Boolean(opts?.silent);
  if (!silent && (!snapshot.hasLoaded || snapshot.list.length < 1)) {
    emitSnapshot('list-loading', {
      listLoading: true,
      error: '',
    });
  }

  inFlightRefresh = apiJson<unknown>(buildListPath(snapshot.listFilter), { method: 'GET' }, 'admin')
    .then(async (payload) => {
      const nextRows = sortRows(
        asArray(payload).filter((row) => rowMatchesFilter(row, snapshot.listFilter)),
      );
      const nextSelectedId = chooseNextSelectedId(nextRows);
      const previousSelectedId = normalizePrescriptionId(snapshot.selectedId);
      const shouldApplySelection = nextSelectedId > 0 && nextSelectedId !== previousSelectedId;

      emitSnapshot(nextRows.length < 1 ? 'list-empty' : 'list', {
        list: cloneRows(nextRows),
        listLoading: false,
        hasLoaded: true,
        error: '',
        selectedId: nextRows.length < 1 ? 0 : (shouldApplySelection ? nextSelectedId : previousSelectedId),
        requestedSelectedId: nextRows.length < 1 ? 0 : nextSelectedId,
        selectionPending: false,
      });

      if (nextRows.length < 1) {
        return cloneSnapshot();
      }

      if (shouldApplySelection) {
        await executeLegacySelection(nextSelectedId, { silent: true, preserveNotice: true });
      }

      return cloneSnapshot();
    })
    .catch((error) => {
      emitSnapshot('list-error', {
        listLoading: false,
        hasLoaded: snapshot.hasLoaded,
        error: error instanceof Error ? error.message : 'Impossible de charger la file de demandes.',
      });
      throw error;
    })
    .finally(() => {
      inFlightRefresh = null;
      if (queuedRefreshAfterInFlight) {
        queuedRefreshAfterInFlight = false;
        void refreshDoctorInboxSource({ silent: true }).catch(() => {
          // no-op surfaced through snapshot.error
        });
      }
    });

  return inFlightRefresh;
}

async function runPollCycle(): Promise<void> {
  if (pollInFlight) {
    scheduleNextPoll(POLL_RETRY_MS);
    return;
  }

  pollInFlight = true;
  try {
    await refreshDoctorInboxSource({ silent: true });
    finalizePollCycle(getPollDelay());
  } catch {
    finalizePollCycle(POLL_RETRY_MS);
  }
}

export async function setDoctorInboxFilter(filterKey: DoctorInboxFilterKey): Promise<DoctorInboxSourceSnapshot> {
  const normalizedFilter = normalizeFilterKey(filterKey);
  if (snapshot.listFilter === normalizedFilter && snapshot.hasLoaded) {
    return cloneSnapshot();
  }

  emitSnapshot('filter-change', {
    listFilter: normalizedFilter,
    listLoading: snapshot.hasLoaded ? true : snapshot.listLoading,
    error: '',
  });

  return refreshDoctorInboxSource({ silent: false });
}

function ensureStarted(): void {
  ensureVisibilityBinding();
  if (!snapshot.hasLoaded && !inFlightRefresh) {
    void refreshDoctorInboxSource({ silent: false }).catch(() => {
      // no-op surfaced through snapshot.error
    });
  }
  if (!pollInFlight && pollHandle == null) {
    scheduleNextPoll(getPollDelay());
  }
}

export function subscribeDoctorInboxSource(listener: DoctorInboxSourceListener): () => void {
  if (typeof listener !== 'function') {
    return () => {};
  }

  listeners.add(listener);
  ensureStarted();

  return (): void => {
    listeners.delete(listener);
    if (listeners.size < 1) {
      stopPolling();
    }
  };
}

export function subscribeDoctorInboxSourceSnapshot(listener: DoctorInboxSourceSnapshotListener): () => void {
  if (typeof listener !== 'function') {
    return () => {};
  }

  return subscribeDoctorInboxSource(() => {
    listener(cloneSnapshot());
  });
}

export function getDoctorInboxSourceSnapshot(): DoctorInboxSourceSnapshot {
  return readSnapshot();
}

export function getDoctorInboxSourceSnapshotSerialized(): string {
  return JSON.stringify(cloneSnapshot());
}

function seedInitialSelection(initialPrescriptionId: unknown): void {
  const normalizedId = normalizePrescriptionId(initialPrescriptionId);
  if (normalizedId < 1) {
    return;
  }

  if (snapshot.selectedId > 0 || snapshot.requestedSelectedId > 0) {
    return;
  }

  emitSnapshot('initial-selection', {
    selectedId: normalizedId,
    requestedSelectedId: normalizedId,
    selectionPending: false,
  });
}

function installDoctorInboxSourceGlobal(): void {
  if (globalInstalled || typeof window === 'undefined') {
    return;
  }

  const controller: DoctorInboxSourceController = {
    getSnapshot: () => cloneSnapshot(),
    subscribe: (listener) => subscribeDoctorInboxSourceSnapshot(listener),
    refresh: (opts) => refreshDoctorInboxSource(opts),
    setFilter: (filterKey) => setDoctorInboxFilter(filterKey),
    requestSelection: (prescriptionId, opts) => requestDoctorInboxSelection(prescriptionId, opts),
  };

  window.SosDoctorInboxSource = controller;
  globalInstalled = true;

  if (typeof window.dispatchEvent === 'function' && typeof window.CustomEvent === 'function') {
    try {
      window.dispatchEvent(new CustomEvent(DOCTOR_INBOX_SOURCE_READY_EVENT));
    } catch {
      // no-op defensive event isolation
    }
  }
}

installDoctorInboxSourceGlobal();

export function useDoctorInboxSource(initialPrescriptionId?: number | null) {
  const normalizedInitialPrescriptionId = normalizePrescriptionId(initialPrescriptionId);

  useEffect(() => {
    seedInitialSelection(normalizedInitialPrescriptionId);
  }, [normalizedInitialPrescriptionId]);

  const currentSnapshot = useSyncExternalStore(
    subscribeDoctorInboxSource,
    getDoctorInboxSourceSnapshot,
    getDoctorInboxSourceSnapshot,
  );

  return useMemo(() => ({
    ...currentSnapshot,
    refreshInbox: refreshDoctorInboxSource,
    setInboxFilter: setDoctorInboxFilter,
    requestPrescriptionSelection: requestDoctorInboxSelection,
  }), [currentSnapshot]);
}
