import React from 'react';
import { useDoctorMessagingContext } from './DoctorMessagingProvider';
import DoctorPatientDetails from './DoctorPatientDetails';
import DoctorPdfPanel from './DoctorPdfPanel';
import useDoctorActiveCaseSurface from './useDoctorActiveCaseSurface';

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

function Notice({
  variant = 'info',
  children,
}: {
  variant?: 'info' | 'success' | 'warning' | 'error';
  children: React.ReactNode;
}) {
  return <div className={cx('sp-alert', `sp-alert--${variant}`)}>{children}</div>;
}

export default function DoctorActiveCasePanel() {
  const { prescriptionId } = useDoctorMessagingContext();
  const activeCase = useDoctorActiveCaseSurface();

  if (prescriptionId == null || prescriptionId < 1) {
    return <div className="dc-empty dc-empty-compact">Aucun dossier actif.</div>;
  }

  return (
    <div className="spu-thread-stack">
      {activeCase.selectionPending ? (
        <Notice variant="info">Ouverture du dossier…</Notice>
      ) : null}
      <DoctorPatientDetails detail={activeCase.detail} loading={activeCase.detailLoading} />
      <DoctorPdfPanel detail={activeCase.detail} pdf={activeCase.pdf} loading={activeCase.pdfLoading} />
    </div>
  );
}
