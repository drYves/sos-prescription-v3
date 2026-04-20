import type {
  ClinicalState,
  ConsentPayload,
  DraftFileManifestItem,
  DraftMedicationPayload,
  DraftSubmissionPayload,
  FinalizePatientPayload,
  FinalizeSubmissionPayload,
  FlowType,
  MedicationItem,
} from './types';

function isEmailLikeValue(value: unknown): boolean {
  const normalized = String(value ?? '').trim();
  return normalized !== '' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
}

function safePatientNameValue(value: unknown): string {
  const normalized = String(value ?? '').trim();
  return normalized !== '' && !isEmailLikeValue(normalized) ? normalized : '';
}

function splitPatientNameValue(value: unknown): { firstName: string; lastName: string } {
  const normalized = safePatientNameValue(value);
  if (!normalized) {
    return { firstName: '', lastName: '' };
  }

  const parts = normalized
    .split(/\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length < 2) {
    return { firstName: parts[0] || '', lastName: '' };
  }

  const firstName = parts.shift() || '';
  return {
    firstName,
    lastName: parts.join(' '),
  };
}

function buildMedicationPayload(item: MedicationItem): DraftMedicationPayload {
  const payload: DraftMedicationPayload = {
    label: (item.label || '').trim(),
    schedule: item.schedule && typeof item.schedule === 'object' ? item.schedule : {},
  };

  if (item.cis) {
    payload.cis = String(item.cis);
  }
  if (item.cip13) {
    payload.cip13 = String(item.cip13);
  }
  if (item.quantite) {
    payload.quantite = String(item.quantite);
  }

  return payload;
}

function buildConsentPayload(input: {
  clinicalState: ClinicalState;
  consentRequired: boolean;
  consentTimestamp: string;
  cguVersion?: string;
  privacyVersion?: string;
}): ConsentPayload | undefined {
  if (!input.consentRequired) {
    return undefined;
  }

  return {
    telemedicine: input.clinicalState.consentTelemedicine,
    truth: input.clinicalState.consentTruth,
    cgu: input.clinicalState.consentCgu,
    privacy: input.clinicalState.consentPrivacy,
    timestamp: input.consentTimestamp,
    cgu_version: input.cguVersion ? String(input.cguVersion) : '',
    privacy_version: input.privacyVersion ? String(input.privacyVersion) : '',
  };
}

function buildFinalizePatientPayload(clinicalState: ClinicalState): FinalizePatientPayload {
  const patientFullName = safePatientNameValue(clinicalState.fullName);
  const patientName = splitPatientNameValue(patientFullName);
  const trimmedBirthdate = clinicalState.birthdate.trim();
  const trimmedNotes = clinicalState.medicalNotes.trim() || undefined;

  return {
    fullname: patientFullName,
    firstName: patientName.firstName,
    lastName: patientName.lastName,
    birthdate: trimmedBirthdate,
    birthDate: trimmedBirthdate,
    note: trimmedNotes,
    medical_notes: trimmedNotes,
    medicalNotes: trimmedNotes,
  };
}

export function buildDraftFileManifest(files: ClinicalState['files']): DraftFileManifestItem[] {
  return files.map((file) => ({
    id: file.id,
    original_name: file.original_name,
    mime_type: file.mime_type || file.mime || 'application/octet-stream',
    size_bytes: Number.isFinite(Number(file.size_bytes || 0)) ? Number(file.size_bytes || 0) : 0,
    kind: 'PROOF',
    status: file.status === 'READY' ? 'READY' : 'QUEUED',
  }));
}

export function buildDraftPayload(input: {
  clinicalState: ClinicalState & { flow: FlowType };
  redirectTo: string;
  consentRequired: boolean;
  consentTimestamp: string;
  cguVersion?: string;
  privacyVersion?: string;
  fileManifest: DraftFileManifestItem[];
}): DraftSubmissionPayload {
  const patient = buildFinalizePatientPayload(input.clinicalState);
  const email = String(input.clinicalState.draftEmail || '').trim().toLowerCase();

  return {
    email,
    flow: input.clinicalState.flow,
    priority: input.clinicalState.priority,
    redirect_to: input.redirectTo,
    patient: {
      email,
      ...patient,
    },
    items: input.clinicalState.items.map(buildMedicationPayload),
    privateNotes: input.clinicalState.medicalNotes.trim() || undefined,
    files: input.fileManifest,
    consent: buildConsentPayload({
      clinicalState: input.clinicalState,
      consentRequired: input.consentRequired,
      consentTimestamp: input.consentTimestamp,
      cguVersion: input.cguVersion,
      privacyVersion: input.privacyVersion,
    }),
    attestation_no_proof: input.clinicalState.flow === 'depannage_no_proof'
      ? input.clinicalState.attestationNoProof
      : undefined,
  };
}

export function buildFinalizePayload(input: {
  clinicalState: ClinicalState & { flow: FlowType };
  consentRequired: boolean;
  consentTimestamp: string;
  cguVersion?: string;
  privacyVersion?: string;
}): FinalizeSubmissionPayload {
  return {
    flow: input.clinicalState.flow,
    priority: input.clinicalState.priority,
    patient: buildFinalizePatientPayload(input.clinicalState),
    items: input.clinicalState.items.map(buildMedicationPayload),
    privateNotes: input.clinicalState.medicalNotes.trim() || undefined,
    consent: buildConsentPayload({
      clinicalState: input.clinicalState,
      consentRequired: input.consentRequired,
      consentTimestamp: input.consentTimestamp,
      cguVersion: input.cguVersion,
      privacyVersion: input.privacyVersion,
    }),
    attestation_no_proof: input.clinicalState.flow === 'depannage_no_proof'
      ? input.clinicalState.attestationNoProof
      : undefined,
  };
}
