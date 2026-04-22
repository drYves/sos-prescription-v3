import React, { createContext, useContext, useMemo } from 'react';
import {
  type DoctorInboxFilterKey,
  type DoctorInboxRefreshOptions,
  type DoctorInboxRow,
  type DoctorInboxSelectOptions,
  useDoctorInboxSource,
} from './useDoctorInboxSource';

type DoctorMessagingContextValue = {
  prescriptionId: number | null;
  requestedPrescriptionId: number | null;
  selectionPending: boolean;
  requestPrescriptionSelection: (prescriptionId: number, opts?: DoctorInboxSelectOptions) => Promise<unknown>;
  inboxList: DoctorInboxRow[];
  inboxListFilter: DoctorInboxFilterKey;
  inboxListLoading: boolean;
  inboxHasLoaded: boolean;
  refreshInbox: (opts?: DoctorInboxRefreshOptions) => Promise<unknown>;
  setInboxFilter: (filterKey: DoctorInboxFilterKey) => Promise<unknown>;
};

type DoctorMessagingProviderProps = {
  prescriptionId?: number | null;
  children: React.ReactNode;
};

const DoctorMessagingContext = createContext<DoctorMessagingContextValue | null>(null);

function normalizeOptionalPrescriptionId(value: unknown): number {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

export function DoctorMessagingProvider({ prescriptionId, children }: DoctorMessagingProviderProps) {
  const initialPrescriptionId = normalizeOptionalPrescriptionId(prescriptionId);
  const inboxSource = useDoctorInboxSource(initialPrescriptionId);

  const activePrescriptionId = inboxSource.selectedId > 0
    ? inboxSource.selectedId
    : (inboxSource.hasLoaded ? null : (initialPrescriptionId > 0 ? initialPrescriptionId : null));

  const requestedPrescriptionId = inboxSource.requestedSelectedId > 0
    ? inboxSource.requestedSelectedId
    : activePrescriptionId;

  const value = useMemo<DoctorMessagingContextValue>(() => ({
    prescriptionId: activePrescriptionId,
    requestedPrescriptionId,
    selectionPending: Boolean(
      inboxSource.selectionPending
      && requestedPrescriptionId != null
      && activePrescriptionId !== requestedPrescriptionId
    ),
    requestPrescriptionSelection: inboxSource.requestPrescriptionSelection,
    inboxList: inboxSource.list,
    inboxListFilter: inboxSource.listFilter,
    inboxListLoading: inboxSource.listLoading,
    inboxHasLoaded: inboxSource.hasLoaded,
    refreshInbox: inboxSource.refreshInbox,
    setInboxFilter: inboxSource.setInboxFilter,
  }), [
    activePrescriptionId,
    inboxSource.hasLoaded,
    inboxSource.list,
    inboxSource.listFilter,
    inboxSource.listLoading,
    inboxSource.refreshInbox,
    inboxSource.requestPrescriptionSelection,
    inboxSource.selectionPending,
    inboxSource.setInboxFilter,
    requestedPrescriptionId,
  ]);

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
