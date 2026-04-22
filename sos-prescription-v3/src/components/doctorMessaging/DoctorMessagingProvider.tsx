import React, { createContext, useContext, useMemo } from 'react';

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
  const value = useMemo<DoctorMessagingContextValue>(() => ({
    prescriptionId: normalizePrescriptionId(prescriptionId),
  }), [prescriptionId]);

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
