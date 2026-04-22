import React, { useCallback, useMemo, useSyncExternalStore } from 'react';
import {
  type LegacyDoctorInboxSnapshot,
  getLegacyDoctorInboxSnapshot,
  refreshLegacyDoctorInbox,
  subscribeLegacyInboxSelection,
} from './legacyInboxAdapter';
import { useDoctorMessagingContext } from './DoctorMessagingProvider';

type InboxRow = Record<string, unknown>;

type StatusVariant = 'success' | 'danger' | 'warn' | 'soft';

type InboxStatus = {
  label: string;
  variant: StatusVariant;
};

type InboxUrgency = {
  tone: 'urgent' | 'standard';
  label: string;
};

const FILTER_META: Record<string, { title: string; empty: string }> = {
  pending: {
    title: 'Demandes en attente',
    empty: 'Aucune demande en attente.',
  },
  approved: {
    title: 'Ordonnances validées',
    empty: 'Aucune ordonnance validée.',
  },
  rejected: {
    title: 'Ordonnances refusées',
    empty: 'Aucune ordonnance refusée.',
  },
  all: {
    title: 'Toutes les demandes',
    empty: 'Aucune demande trouvée.',
  },
};

function asRecord(value: unknown): InboxRow {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as InboxRow : {};
}

function asArray(value: unknown): InboxRow[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is InboxRow => !!entry && typeof entry === 'object' && !Array.isArray(entry))
    : [];
}

function normalizeText(value: unknown): string {
  return String(value == null ? '' : value).trim();
}

function normalizePrescriptionId(value: unknown): number {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
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

function parseDate(value: unknown): Date | null {
  const raw = normalizeText(value);
  if (!raw) {
    return null;
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDateDisplay(value: unknown): string {
  const parsed = parseDate(value);
  if (!parsed) {
    return '';
  }

  return new Intl.DateTimeFormat('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(parsed);
}

function formatRelativeDate(value: unknown): string {
  const parsed = parseDate(value);
  if (!parsed) {
    return '';
  }

  const diffMs = Date.now() - parsed.getTime();
  const diffMinutes = Math.max(0, Math.round(diffMs / 60000));
  if (diffMinutes < 1) {
    return 'À l’instant';
  }
  if (diffMinutes < 60) {
    return `Il y a ${diffMinutes} min`;
  }

  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) {
    return `Il y a ${diffHours} h`;
  }

  const diffDays = Math.round(diffHours / 24);
  if (diffDays < 7) {
    return `Il y a ${diffDays} j`;
  }

  return formatDateDisplay(parsed.toISOString());
}

function getFilterMeta(filterKey: string): { title: string; empty: string } {
  return FILTER_META[filterKey] || FILTER_META.pending;
}

function extractPatientName(row: InboxRow): string {
  const payload = asRecord(row.payload);
  const patient = asRecord(payload.patient);
  return firstText([
    patient.fullname,
    patient.fullName,
    [normalizeText(patient.firstName), normalizeText(patient.lastName)].filter(Boolean).join(' '),
    row.patient_name,
    `Dossier #${normalizePrescriptionId(row.id)}`,
  ]);
}

function extractBirthDate(row: InboxRow): string {
  const payload = asRecord(row.payload);
  const patient = asRecord(payload.patient);
  const raw = firstText([
    patient.birthdate,
    patient.birthDate,
    patient.dob,
    patient.birth_date,
    patient.date_of_birth,
    patient.dateOfBirth,
    patient.date_naissance,
    row.patient_birthdate,
    row.patient_dob,
  ]);

  return formatDateDisplay(raw) || 'Date non renseignée';
}

function extractCreatedLabel(row: InboxRow): string {
  return formatRelativeDate(row.created_at) || formatDateDisplay(row.created_at) || 'Date inconnue';
}

function extractStatus(row: InboxRow): InboxStatus {
  const payload = asRecord(row.payload);
  const worker = asRecord(payload.worker);

  const businessStatus = normalizeText(row.status).toLowerCase();
  const workerStatus = normalizeText(worker.status).toLowerCase();
  const processingStatus = normalizeText(worker.processing_status).toLowerCase();

  if (businessStatus === 'approved' || workerStatus === 'approved' || processingStatus === 'done' || workerStatus === 'done') {
    return { label: 'Validée', variant: 'success' };
  }
  if (businessStatus === 'rejected' || workerStatus === 'rejected' || processingStatus === 'failed') {
    return { label: 'Refusée', variant: 'danger' };
  }
  if (processingStatus === 'claimed' || processingStatus === 'processing' || businessStatus === 'in_review') {
    return { label: 'En cours', variant: 'warn' };
  }
  if (businessStatus === 'payment_pending') {
    return { label: 'Paiement en attente', variant: 'soft' };
  }
  return { label: 'À traiter', variant: 'soft' };
}

function extractFlowKey(row: InboxRow): string {
  const payload = asRecord(row.payload);
  const prescription = asRecord(payload.prescription);
  return firstText([
    row.flow,
    payload.flow,
    prescription.flow,
    row.flow_key,
    payload.flow_key,
  ]).toLowerCase();
}

function extractPriority(row: InboxRow): 'Express' | 'Standard' {
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

function extractUrgency(row: InboxRow): InboxUrgency {
  if (extractFlowKey(row) === 'depannage_no_proof') {
    return { tone: 'urgent', label: 'Dépannage SOS' };
  }

  if (extractPriority(row) === 'Express') {
    return { tone: 'urgent', label: 'Express' };
  }

  return { tone: 'standard', label: 'Standard' };
}

function extractMedicationPreview(row: InboxRow): string {
  const labels = asArray(row.items)
    .map((item) => {
      const raw = asRecord(item.raw);
      return firstText([
        item.label,
        item.denomination,
        item.name,
        raw.label,
        raw.denomination,
        raw.name,
      ]);
    })
    .filter(Boolean);

  if (labels.length < 1) {
    return '';
  }

  const unique = Array.from(new Set(labels));
  const preview = unique.slice(0, 2).join(' • ');
  return unique.length > 2 ? `${preview} …` : preview;
}

function getSnapshotSerialized(): string {
  return JSON.stringify(getLegacyDoctorInboxSnapshot(0));
}

function parseSnapshot(serialized: string): LegacyDoctorInboxSnapshot {
  try {
    const raw = JSON.parse(serialized) as Partial<LegacyDoctorInboxSnapshot> | null;
    const record = raw && typeof raw === 'object' ? raw : null;
    return {
      selectedId: normalizePrescriptionId(record?.selectedId),
      listFilter: normalizeText(record?.listFilter) || 'pending',
      list: asArray(record?.list).map((entry) => ({ ...entry })),
      reason: normalizeText(record?.reason),
    };
  } catch {
    return {
      selectedId: 0,
      listFilter: 'pending',
      list: [],
      reason: 'parse-error',
    };
  }
}

export default function DoctorInbox() {
  const { requestPrescriptionSelection } = useDoctorMessagingContext();
  const serializedSnapshot = useSyncExternalStore(
    subscribeLegacyInboxSelection,
    getSnapshotSerialized,
    getSnapshotSerialized,
  );

  const snapshot = useMemo(() => parseSnapshot(serializedSnapshot), [serializedSnapshot]);
  const filterMeta = getFilterMeta(snapshot.listFilter);
  const visibleCount = snapshot.list.length;

  const handleRefresh = useCallback((): void => {
    void refreshLegacyDoctorInbox({ silent: false });
  }, []);

  const handleSelect = useCallback((id: number): void => {
    void requestPrescriptionSelection(id);
  }, [requestPrescriptionSelection]);

  return (
    <div className="dc-inbox-react-panel">
      <div className="dc-toolbar-console">
        <div className="dc-toolbar-console__context">
          <div className="dc-toolbar-console__eyebrow">Inbox React</div>
          <div className="dc-toolbar-console__title">{filterMeta.title}</div>
          <div className="dc-toolbar-console__caption">
            {visibleCount === 1 ? '1 dossier visible' : `${visibleCount} dossiers visibles`}
          </div>
        </div>
        <div className="dc-toolbar-console__filters">
          <button type="button" className="sp-button sp-button--ghost" onClick={handleRefresh}>
            Actualiser
          </button>
        </div>
      </div>

      <div className="dc-inbox__list" aria-live="polite">
        {visibleCount < 1 ? (
          <div className="dc-empty">{filterMeta.empty}</div>
        ) : (
          snapshot.list.map((row) => {
            const id = normalizePrescriptionId(row.id);
            if (id < 1) {
              return null;
            }

            const selected = snapshot.selectedId === id;
            const status = extractStatus(row);
            const urgency = extractUrgency(row);
            const patientName = extractPatientName(row);
            const medicationPreview = extractMedicationPreview(row);
            const metaLine = [extractBirthDate(row), extractCreatedLabel(row)].filter(Boolean).join(' • ');

            return (
              <button
                key={id}
                type="button"
                className={[
                  'dc-item',
                  `dc-item--${urgency.tone}`,
                  selected ? 'is-selected' : '',
                ].filter(Boolean).join(' ')}
                aria-pressed={selected}
                onClick={(): void => {
                  handleSelect(id);
                }}
              >
                <div className="dc-item__row">
                  <div className="dc-item__patient">{patientName}</div>
                  <div className="dc-item__status">
                    <span className={[ 'dc-pill', `dc-pill-${status.variant}` ].join(' ')}>{status.label}</span>
                  </div>
                </div>
                {medicationPreview ? (
                  <div className="dc-item__meds" title={medicationPreview}>{medicationPreview}</div>
                ) : null}
                <div className="dc-item__meta">{metaLine}</div>
                <div className="dc-item__foot">
                  <span className={[ 'dc-urgency-chip', `dc-urgency-chip--${urgency.tone}` ].join(' ')}>
                    <span>{urgency.label}</span>
                  </span>
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
