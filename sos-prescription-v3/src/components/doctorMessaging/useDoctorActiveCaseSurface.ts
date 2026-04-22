import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useDoctorMessagingContext } from './DoctorMessagingProvider';
import {
  getLegacyDoctorActiveCaseSnapshotSerialized,
  parseLegacyDoctorActiveCaseSnapshot,
  refreshLegacyDoctorActiveCaseDetail,
  refreshLegacyDoctorActiveCasePdf,
  subscribeLegacyDoctorActiveCase,
} from './legacyActiveCaseAdapter';

function normalizeText(value: unknown): string {
  return String(value == null ? '' : value).trim();
}

function normalizePrescriptionId(value: unknown): number {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasMatchingDetailId(detail: Record<string, unknown> | null, prescriptionId: number): boolean {
  return normalizePrescriptionId(detail?.id) === prescriptionId;
}

export default function useDoctorActiveCaseSurface() {
  const { prescriptionId, selectionPending } = useDoctorMessagingContext();
  const fallbackSelectedId = prescriptionId ?? 0;
  const serializedSnapshot = useSyncExternalStore(
    subscribeLegacyDoctorActiveCase,
    () => getLegacyDoctorActiveCaseSnapshotSerialized(fallbackSelectedId),
    () => getLegacyDoctorActiveCaseSnapshotSerialized(fallbackSelectedId),
  );

  const snapshot = useMemo(
    () => parseLegacyDoctorActiveCaseSnapshot(serializedSnapshot),
    [serializedSnapshot],
  );

  const activePrescriptionId = normalizePrescriptionId(prescriptionId);
  const detail = activePrescriptionId > 0 && snapshot.selectedId === activePrescriptionId
    ? asRecord(snapshot.detail)
    : null;
  const pdf = activePrescriptionId > 0 && snapshot.selectedId === activePrescriptionId
    ? asRecord(snapshot.pdf)
    : null;
  const detailStatus = normalizeText(detail?.status).toLowerCase();
  const pdfStatus = normalizeText(pdf?.status).toLowerCase();
  const pdfDownloadUrl = normalizeText(pdf?.download_url);
  const needsDetailRefresh = activePrescriptionId > 0 && !hasMatchingDetailId(detail, activePrescriptionId);
  const needsPdfRefresh = activePrescriptionId > 0
    && detailStatus === 'approved'
    && pdfDownloadUrl === ''
    && pdfStatus !== 'done'
    && pdfStatus !== 'failed';

  useEffect(() => {
    if (activePrescriptionId < 1 || !needsDetailRefresh) {
      return;
    }

    void refreshLegacyDoctorActiveCaseDetail(activePrescriptionId, { silent: true });
  }, [activePrescriptionId, needsDetailRefresh]);

  useEffect(() => {
    if (activePrescriptionId < 1 || !needsPdfRefresh) {
      return;
    }

    void refreshLegacyDoctorActiveCasePdf(activePrescriptionId, { silent: true });
  }, [activePrescriptionId, needsPdfRefresh]);

  useEffect(() => {
    if (activePrescriptionId < 1 || !needsPdfRefresh) {
      return undefined;
    }

    const handle = window.setInterval(() => {
      void refreshLegacyDoctorActiveCasePdf(activePrescriptionId, { silent: true });
    }, 15000);

    return (): void => {
      window.clearInterval(handle);
    };
  }, [activePrescriptionId, needsPdfRefresh]);

  return {
    prescriptionId: activePrescriptionId > 0 ? activePrescriptionId : null,
    selectionPending,
    detail,
    pdf,
    detailLoading: Boolean(snapshot.detailLoading) || needsDetailRefresh,
    pdfLoading: needsPdfRefresh,
    detailTab: snapshot.detailTab,
    reason: snapshot.reason,
  };
}
