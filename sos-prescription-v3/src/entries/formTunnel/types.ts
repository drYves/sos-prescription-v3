export type PricingConfig = {
  standard_cents: number;
  express_cents: number;
  currency: string;
  standard_eta_minutes?: number | null;
  express_eta_minutes?: number | null;
};

export type PaymentsConfig = {
  enabled: boolean;
  publishable_key?: string;
  provider?: string;
  capture_method?: string;
};

export type FlowType = 'ro_proof' | 'depannage_no_proof';
export type Stage = 'choose' | 'form' | 'priority_selection' | 'payment_auth' | 'done';
export type FrequencyUnit = 'jour' | 'semaine';
export type DurationUnit = 'jour' | 'mois' | 'semaine';

export type Schedule = {
  nb: number;
  freqUnit: FrequencyUnit;
  durationVal: number;
  durationUnit: DurationUnit;
  times: string[];
  doses: string[];
  note: string;
  autoTimesEnabled: boolean;
  start: string;
  end: string;
};

export type MedEditorState = {
  detailId: number;
  index: number;
  medicationName: string;
  draft: Schedule;
};

export type MedicationSearchResult = {
  cis?: string;
  cip13?: string;
  label: string;
  sublabel?: string | null;
  specialite?: string;
  tauxRemb?: string;
  prixTTC?: number;
  is_selectable?: boolean;
  scheduleText?: string;
};

export type MedicationItem = {
  cis?: string;
  cip13?: string | null;
  label: string;
  schedule: Schedule;
  quantite?: string;
};

export type LocalUpload = {
  id: string;
  file: File;
  original_name: string;
  mime: string;
  mime_type: string;
  size_bytes: number;
  kind: 'PROOF';
  status: 'QUEUED' | 'READY';
};

export type UploadedArtifact = {
  id: string;
  original_name: string;
  purpose?: string;
  mime?: string;
  mime_type?: string;
  size_bytes?: number;
  kind?: string;
  status?: string;
};

export type SubmissionInitResponse = {
  submission_ref?: string;
};

export type SubmissionResult = {
  id: number;
  uid: string;
  status: string;
  created_at?: string;
};

export type DraftSaveResponse = {
  submission_ref?: string;
  expires_at?: string;
  expires_in?: number;
  sent?: boolean;
  redirect_to?: string;
  message?: string;
};

export type StoredDraftPayload = {
  submission_ref?: string;
  email?: string;
  flow?: FlowType;
  priority?: 'standard' | 'express' | string;
  patient?: Record<string, unknown>;
  items?: Array<Record<string, unknown>>;
  private_notes?: string;
  files?: Array<Record<string, unknown>>;
  redirect_to?: string;
  expires_at?: string | null;
  attestation_no_proof?: boolean;
  consent?: Record<string, unknown>;
};

export type AnalyzeMedication = {
  label?: string;
  scheduleText?: string;
};

export type ArtifactAnalysis = {
  ok?: boolean;
  message?: string;
  code?: string;
  is_prescription?: boolean;
  medications?: AnalyzeMedication[];
  analysis?: {
    is_prescription?: boolean;
    medications?: AnalyzeMedication[];
  };
};

export type SubmissionRefState = {
  ref: string | null;
};

export type ClinicalState = {
  flow: FlowType | null;
  priority: 'standard' | 'express';
  fullName: string;
  birthdate: string;
  medicalNotes: string;
  items: MedicationItem[];
  files: LocalUpload[];
  draftEmail: string;
  attestationNoProof: boolean;
  consentTelemedicine: boolean;
  consentTruth: boolean;
  consentCgu: boolean;
  consentPrivacy: boolean;
};

export type UIState = {
  medEditor: MedEditorState | null;
  pricingLoading: boolean;
  analysisInProgress: boolean;
  analysisMessage: string | null;
  rejectedFiles: File[];
  submitError: string | null;
  submitLoading: boolean;
  copiedUid: boolean;
  draftEmailLocked: boolean;
  draftSending: boolean;
  draftSent: boolean;
  draftSuccessMessage: string | null;
};

export type WorkflowState = {
  stage: Stage;
  pricing: PricingConfig | null;
  paymentsConfig: PaymentsConfig | null;
  preparedSubmission: SubmissionResult | null;
  submissionResult: SubmissionResult | null;
  draftResumeLoading: boolean;
  resumedDraftRef: string | null;
  submissionRef: string | null;
};

export type DraftFileManifestItem = {
  id: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  kind: 'PROOF';
  status: 'QUEUED' | 'READY';
};

export type ConsentPayload = {
  telemedicine: boolean;
  truth: boolean;
  cgu: boolean;
  privacy: boolean;
  timestamp: string;
  cgu_version: string;
  privacy_version: string;
};

export type DraftMedicationPayload = {
  label: string;
  schedule: Schedule | Record<string, never>;
  cis?: string;
  cip13?: string;
  quantite?: string;
};

export type DraftPatientPayload = {
  email: string;
  fullname: string;
  firstName: string;
  lastName: string;
  birthdate: string;
  birthDate: string;
  note?: string;
  medical_notes?: string;
  medicalNotes?: string;
};

export type FinalizePatientPayload = {
  fullname: string;
  firstName: string;
  lastName: string;
  birthdate: string;
  birthDate: string;
  note?: string;
  medical_notes?: string;
  medicalNotes?: string;
};

export type DraftSubmissionPayload = {
  email: string;
  flow: FlowType;
  priority: 'standard' | 'express';
  redirect_to: string;
  patient: DraftPatientPayload;
  items: DraftMedicationPayload[];
  privateNotes?: string;
  files: DraftFileManifestItem[];
  consent?: ConsentPayload;
  attestation_no_proof?: boolean;
};

export type FinalizeSubmissionPayload = {
  flow: FlowType;
  priority: 'standard' | 'express';
  patient: FinalizePatientPayload;
  items: DraftMedicationPayload[];
  privateNotes?: string;
  consent?: ConsentPayload;
  attestation_no_proof?: boolean;
};

export type DraftHydrationResult = {
  flow: FlowType | null;
  priority: 'standard' | 'express';
  fullName: string;
  birthdate: string;
  medicalNotes: string;
  items: MedicationItem[];
  files: LocalUpload[];
  draftEmail: string;
  draftEmailLocked: boolean;
  attestationNoProof: boolean;
  consentTelemedicine: boolean;
  consentTruth: boolean;
  consentCgu: boolean;
  consentPrivacy: boolean;
};
