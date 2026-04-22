import React, { createContext, useContext, useMemo, useSyncExternalStore } from 'react';
import { getLegacySelectedId, subscribeLegacyInboxSelection } from './legacyInboxAdapter';

type DoctorMessagingContextValue = {
  prescriptionId: number;
};

type DoctorMessagingProviderProps = {
  prescriptionId: number;
  children: React.ReactNode;
};

const DoctorMessagingContext = createContext<DoctorMessagingContextValue | null>(null);

function normalizePrescriptionId(value: number): number {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric < 1) {
    throw new Error('PrescriptionId invalide pour le contexte actif médecin.');
  }
  return Math.trunc(numeric);
}

export function DoctorMessagingProvider({ prescriptionId, children }: DoctorMessagingProviderProps) {
  const fallbackPrescriptionId = normalizePrescriptionId(prescriptionId);
  const selectedId = useSyncExternalStore(
    subscribeLegacyInboxSelection,
    () => getLegacySelectedId(fallbackPrescriptionId),
    () => getLegacySelectedId(fallbackPrescriptionId),
  );

  const activePrescriptionId = normalizePrescriptionId(selectedId > 0 ? selectedId : fallbackPrescriptionId);

  const value = useMemo<DoctorMessagingContextValue>(() => ({
    prescriptionId: activePrescriptionId,
  }), [activePrescriptionId]);

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
