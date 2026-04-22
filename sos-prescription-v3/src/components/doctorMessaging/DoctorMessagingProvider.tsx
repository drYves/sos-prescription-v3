import React, { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react';
import {
  type LegacyDoctorInboxSelectOptions,
  getLegacyDoctorInboxSelectionSnapshotSerialized,
  requestLegacyDoctorCaseSelection,
  subscribeLegacyDoctorInboxSelectionState,
} from './legacyInboxAdapter';

type DoctorMessagingContextValue = {
  prescriptionId: number | null;
  requestedPrescriptionId: number | null;
  selectionPending: boolean;
  requestPrescriptionSelection: (prescriptionId: number, opts?: LegacyDoctorInboxSelectOptions) => Promise<unknown>;
};

type DoctorMessagingProviderProps = {
  prescriptionId?: number | null;
  children: React.ReactNode;
};

type SerializedSelectionSnapshot = {
  selectedId?: unknown;
  requestedSelectedId?: unknown;
  selectionPending?: unknown;
  hasLegacyOwner?: unknown;
};

const DoctorMessagingContext = createContext<DoctorMessagingContextValue | null>(null);

function normalizeOptionalPrescriptionId(value: unknown): number {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

function parseSelectionSnapshot(serializedSnapshot: string): {
  selectedId: number;
  requestedSelectedId: number;
  selectionPending: boolean;
  hasLegacyOwner: boolean;
} {
  try {
    const raw = JSON.parse(serializedSnapshot) as SerializedSelectionSnapshot | null;
    const selectedId = normalizeOptionalPrescriptionId(raw?.selectedId);
    const requestedSelectedId = normalizeOptionalPrescriptionId(raw?.requestedSelectedId);

    return {
      selectedId,
      requestedSelectedId,
      selectionPending: Boolean(raw?.selectionPending) && requestedSelectedId > 0 && requestedSelectedId !== selectedId,
      hasLegacyOwner: Boolean(raw?.hasLegacyOwner),
    };
  } catch {
    return {
      selectedId: 0,
      requestedSelectedId: 0,
      selectionPending: false,
      hasLegacyOwner: false,
    };
  }
}

export function DoctorMessagingProvider({ prescriptionId, children }: DoctorMessagingProviderProps) {
  const initialPrescriptionId = normalizeOptionalPrescriptionId(prescriptionId);
  const serializedSelectionSnapshot = useSyncExternalStore(
    subscribeLegacyDoctorInboxSelectionState,
    () => getLegacyDoctorInboxSelectionSnapshotSerialized(initialPrescriptionId),
    () => getLegacyDoctorInboxSelectionSnapshotSerialized(initialPrescriptionId),
  );

  const selectionSnapshot = useMemo(
    () => parseSelectionSnapshot(serializedSelectionSnapshot),
    [serializedSelectionSnapshot],
  );

  const activePrescriptionId = selectionSnapshot.selectedId > 0
    ? selectionSnapshot.selectedId
    : (selectionSnapshot.hasLegacyOwner ? null : (initialPrescriptionId > 0 ? initialPrescriptionId : null));

  const requestedPrescriptionId = selectionSnapshot.requestedSelectedId > 0
    ? selectionSnapshot.requestedSelectedId
    : activePrescriptionId;

  const requestPrescriptionSelection = useCallback(
    (nextPrescriptionId: number, opts?: LegacyDoctorInboxSelectOptions): Promise<unknown> => (
      requestLegacyDoctorCaseSelection(nextPrescriptionId, opts)
    ),
    [],
  );

  const value = useMemo<DoctorMessagingContextValue>(() => ({
    prescriptionId: activePrescriptionId,
    requestedPrescriptionId,
    selectionPending: Boolean(
      selectionSnapshot.selectionPending
      && requestedPrescriptionId != null
      && activePrescriptionId !== requestedPrescriptionId
    ),
    requestPrescriptionSelection,
  }), [activePrescriptionId, requestPrescriptionSelection, requestedPrescriptionId, selectionSnapshot.selectionPending]);

  return (
    <DoctorMessagingContext.Provider value={value}>
      {children}
    </DoctorMessagingContext.Provider>
  );
}

export function useDoctorMessagingContext(): DoctorMessagingContextValue {
  const context = useContext(DoctorMessagingContext);
  if (!context) {
    throw new Error('useDoctorMessagingContext doit être utilisé dans DoctorMessagingProvider.');
  }
  return context;
}
