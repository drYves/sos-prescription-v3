import React from 'react';

type DoctorPatientDetailsProps = {
  detail: Record<string, unknown> | null;
  loading?: boolean;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeText(value: unknown): string {
  return String(value == null ? '' : value).trim();
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

function parseAgeNumber(value: unknown): number | null {
  const raw = normalizeText(value);
  if (!raw) {
    return null;
  }

  const match = raw.match(/(\d{1,3})/);
  if (!match) {
    return null;
  }

  const numeric = Number(match[1]);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : null;
}

function computeAgeFromBirthdate(value: unknown): number | null {
  const parsed = parseDate(value);
  if (!parsed) {
    return null;
  }

  const now = new Date();
  let age = now.getFullYear() - parsed.getFullYear();
  const monthDelta = now.getMonth() - parsed.getMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getDate() < parsed.getDate())) {
    age -= 1;
  }

  return age > 0 ? age : null;
}

function parseWeightKg(value: unknown): number | null {
  const raw = normalizeText(value).replace(',', '.');
  if (!raw) {
    return null;
  }

  const numeric = Number(raw.replace(/[^0-9.]/g, ''));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function parseHeightCm(value: unknown): number | null {
  const raw = normalizeText(value).replace(',', '.');
  if (!raw) {
    return null;
  }

  const numeric = Number(raw.replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  return numeric > 3 ? numeric : numeric * 100;
}

function formatWeight(value: number | null): string {
  if (!Number.isFinite(value)) {
    return 'Non renseigné';
  }

  return `${Number(value).toFixed(Number.isInteger(value) ? 0 : 1)} kg`;
}

function formatHeight(value: number | null): string {
  if (!Number.isFinite(value)) {
    return 'Non renseigné';
  }

  return `${Math.round(Number(value))} cm`;
}

function computeBmi(weightKg: number | null, heightCm: number | null): number | null {
  if (!Number.isFinite(weightKg) || !Number.isFinite(heightCm) || !heightCm) {
    return null;
  }

  const heightMeters = Number(heightCm) / 100;
  if (heightMeters <= 0) {
    return null;
  }

  return Number(weightKg) / (heightMeters * heightMeters);
}

function interpretBmi(value: number | null): string {
  if (!Number.isFinite(value)) {
    return '';
  }

  if (value < 18.5) return 'Insuffisance pondérale';
  if (value < 25) return 'Corpulence normale';
  if (value < 30) return 'Surpoids';
  if (value < 35) return 'Obésité modérée';
  if (value < 40) return 'Obésité sévère';
  return 'Obésité morbide';
}

function readPatientFieldText(detail: Record<string, unknown>, keys: string[]): string {
  const payload = asRecord(detail.payload);
  const patient = asRecord(payload.patient);
  const prescription = asRecord(payload.prescription);

  for (const key of keys) {
    const direct = normalizeText(detail[key]);
    if (direct) {
      return direct;
    }

    const patientValue = normalizeText(patient[key]);
    if (patientValue) {
      return patientValue;
    }

    const prescriptionValue = normalizeText(prescription[key]);
    if (prescriptionValue) {
      return prescriptionValue;
    }
  }

  return '';
}

function extractMedicalNotes(detail: Record<string, unknown>): string {
  const payload = asRecord(detail.payload);
  const prescription = asRecord(payload.prescription);
  const patient = asRecord(payload.patient);

  return firstText([
    detail.privateNotes,
    detail.private_notes,
    prescription.privateNotes,
    prescription.private_notes,
    payload.privateNotes,
    payload.private_notes,
    patient.note,
  ]);
}

function extractPatientSummary(detail: Record<string, unknown>) {
  const payload = asRecord(detail.payload);
  const patient = asRecord(payload.patient);
  const birthDateRaw = firstText([
    readPatientFieldText(detail, ['birthdate', 'birthDate', 'dob', 'birth_date', 'date_of_birth', 'dateOfBirth', 'date_naissance', 'naissance']),
    detail.patient_birthdate,
    detail.patient_dob,
  ]);
  const fallbackAge = parseAgeNumber(firstText([
    detail.patient_age_label,
    readPatientFieldText(detail, ['age_label', 'ageLabel', 'age']),
  ]));
  const ageYears = computeAgeFromBirthdate(birthDateRaw) ?? fallbackAge;
  const weightKg = parseWeightKg(firstText([
    readPatientFieldText(detail, ['weight_kg', 'weightKg', 'weight', 'poids_kg', 'poidsKg', 'poids']),
    detail.patient_weight_kg,
    detail.weight_kg,
  ]));
  const heightCm = parseHeightCm(firstText([
    readPatientFieldText(detail, ['height_cm', 'heightCm', 'height', 'height_m', 'heightM', 'taille_cm', 'tailleCm', 'taille', 'size_cm', 'sizeCm', 'size']),
    detail.patient_height_cm,
    detail.height_cm,
  ]));
  const bmiValue = computeBmi(weightKg, heightCm);

  return {
    fullName: firstText([
      patient.fullname,
      patient.fullName,
      [normalizeText(patient.firstName), normalizeText(patient.lastName)].filter(Boolean).join(' '),
      detail.patient_name,
    ]) || 'Patient',
    birthDate: formatDateDisplay(birthDateRaw),
    age: ageYears ? `${ageYears} ans` : 'Non renseigné',
    weight: formatWeight(weightKg),
    height: formatHeight(heightCm),
    bmi: Number.isFinite(bmiValue) ? bmiValue!.toFixed(1) : '',
    bmiLabel: interpretBmi(bmiValue),
    medicalNotes: extractMedicalNotes(detail),
  };
}

export default function DoctorPatientDetails({ detail, loading = false }: DoctorPatientDetailsProps) {
  if (loading && !detail) {
    return <div className="dc-loading">Chargement du résumé patient…</div>;
  }

  if (!detail) {
    return <div className="dc-empty dc-empty-compact">Résumé patient indisponible.</div>;
  }

  const summary = extractPatientSummary(detail);

  return (
    <div className="dc-summary-card">
      <div className="dc-card__title">Patient</div>
      <div className="dc-summary-grid">
        <div className="dc-summary-row">
          <span>ÂGE</span>
          <strong>{summary.age}</strong>
        </div>
        <div className="dc-summary-row">
          <span>POIDS</span>
          <strong>{summary.weight}</strong>
        </div>
        <div className="dc-summary-row">
          <span>TAILLE</span>
          <strong>{summary.height}</strong>
        </div>
        {summary.bmi ? (
          <div className="dc-summary-row dc-summary-row--bmi">
            <span>IMC</span>
            <strong>{summary.bmi}</strong>
            <small>{summary.bmiLabel}</small>
          </div>
        ) : null}
        {summary.medicalNotes ? (
          <div className="dc-summary-row dc-summary-row--notes">
            <span>PRÉCISIONS MÉDICALES</span>
            <strong style={{ whiteSpace: 'pre-wrap' }}>{summary.medicalNotes}</strong>
          </div>
        ) : null}
        {summary.birthDate ? (
          <div className="dc-summary-row">
            <span>NAISSANCE</span>
            <strong>{summary.birthDate}</strong>
          </div>
        ) : null}
      </div>
    </div>
  );
}
