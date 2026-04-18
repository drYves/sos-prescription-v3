// PatientConsole.tsx · V8.2.0
// src/components/PatientConsole.tsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import MessageThread from './messaging/MessageThread';
import StripePaymentModule, { type StripePaymentIntentPayload, toMedicalGradePaymentErrorMessage } from './payment/StripePaymentModule';

type Scope = 'patient' | 'form' | 'admin';

type AppConfig = {
  restBase: string;
  restV4Base?: string;
  nonce: string;
  currentUser?: {
    id?: number;
    displayName?: string;
    email?: string;
    roles?: string[] | string;
    firstName?: string;
    lastName?: string;
    first_name?: string;
    last_name?: string;
    birthDate?: string;
    birthdate?: string;
    sosp_birthdate?: string;
  };
  patientProfile?: {
    fullname?: string;
    full_name?: string;
    fullName?: string;
    birthdate?: string;
    birthdate_fr?: string;
    birthdate_iso?: string;
    first_name?: string;
    last_name?: string;
    email?: string;
    note?: string;
    medical_notes?: string;
    medicalNotes?: string;
    weight_kg?: string;
    weightKg?: string;
    height_cm?: string;
    heightCm?: string;
    bmi_label?: string;
  };
  capabilities?: {
    manage?: boolean;
    manageData?: boolean;
    validate?: boolean;
  };
};

type PaymentShadow = {
  local_status?: string | null;
  provider?: string | null;
  status?: string | null;
  amount_cents?: number | null;
  currency?: string | null;
  priority?: string | null;
  flow?: string | null;
  reference?: string | null;
  transaction_at?: string | null;
};

type PatientProfileSnapshot = {
  patientProfile?: AppConfig['patientProfile'];
  currentUser?: AppConfig['currentUser'];
};

type RequestDetailField = {
  label: string;
  value: string;
};

type PrescriptionSummary = {
  id: number;
  uid: string;
  status: string;
  created_at: string;
  priority?: string;
  primary_reason?: string;
  row_rev?: string;
  updated_at?: string | null;
  last_activity_at?: string | null;
  processing_status?: string;
  message_count?: number;
  last_message_seq?: number;
  unread_count_patient?: number;
  has_proof?: boolean;
  proof_count?: number;
  pdf_ready?: boolean;
  payment?: PaymentShadow;
};

type PrescriptionFile = {
  id: number;
  original_name: string;
  purpose?: string;
  mime?: string;
  size_bytes?: number;
  download_url: string;
};

type PrescriptionItem = {
  denomination: string;
  posologie?: string;
  quantite?: string;
};

type PrescriptionDetail = {
  id: number;
  uid: string;
  status: string;
  created_at: string;
  priority?: string;
  decision_reason?: string;
  primary_reason?: string;
  request_details?: RequestDetailField[];
  files?: PrescriptionFile[];
  items: PrescriptionItem[];
  payment?: PaymentShadow;
};

type MessageItem = {
  id: number;
  seq?: number;
  author_role: string;
  author_wp_user_id?: number;
  author_name?: string;
  body: string;
  created_at: string;
  attachments?: number[];
};

type PatientMessagingState = 'WAITING_DOCTOR' | 'OPEN' | 'CLOSED';

type PdfState = {
  status?: string;
  can_download?: boolean;
  download_url?: string;
  expires_in?: number;
  message?: string;
  last_error_code?: string | null;
  last_error_message?: string | null;
};

type PatientPulseItem = {
  id: number;
  uid: string;
  row_rev: string;
  status: string;
  processing_status?: string;
  updated_at?: string | null;
  last_activity_at?: string | null;
  message_count?: number;
  last_message_seq?: number;
  unread_count_patient?: number;
  has_proof?: boolean;
  proof_count?: number;
  pdf_ready?: boolean;
  payment?: PaymentShadow;
};

type PatientPulseResponse = {
  count: number;
  max_updated_at?: string | null;
  collection_hash: string;
  unchanged: boolean;
  items: PatientPulseItem[];
};

type PatientProfileFormState = {
  first_name: string;
  last_name: string;
  birthdate: string;
  email: string;
  weight_kg: string;
  height_cm: string;
  note: string;
  bmi_label: string;
};

type ApiPayloadRecord = Record<string, unknown>;

class ApiPayloadError extends Error {
  status: number;
  payload: unknown;

  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = 'ApiPayloadError';
    this.status = status;
    this.payload = payload;
  }
}

type PatientConsoleWindow = Window & {
  SosPrescription?: AppConfig;
  SOSPrescription?: AppConfig;
};

function getAppConfig(): AppConfig {
  const g = window as PatientConsoleWindow;
  const cfg = g.SosPrescription || g.SOSPrescription;
  if (!cfg || typeof cfg.restBase !== 'string' || typeof cfg.nonce !== 'string') {
    throw new Error('Configuration SosPrescription introuvable (window.SosPrescription).');
  }
  return cfg;
}

function withCacheBuster(path: string, method: string): string {
  const isGet = method.toUpperCase() === 'GET';
  if (!isGet) return path;

  try {
    const base = typeof window !== 'undefined' ? window.location.origin : 'https://sosprescription.local';
    const url = new URL(path, base);
    url.searchParams.set('_ts', String(Date.now()));
    return url.pathname + url.search;
  } catch {
    const sep = path.includes('?') ? '&' : '?';
    return `${path}${sep}_ts=${Date.now()}`;
  }
}

function isRecord(value: unknown): value is ApiPayloadRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toPositiveInteger(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

function getCurrentWpUserId(): number | undefined {
  const id = toPositiveInteger(getAppConfig().currentUser?.id);
  return id > 0 ? id : undefined;
}

function toRequiredString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function toOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function toOptionalNullableString(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function toOptionalNumber(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function normalizeMultilineText(value: string): string {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function isEmailLike(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function isTechnicalIdentifier(value: string): boolean {
  const normalized = String(value || '').trim();
  if (normalized === '') {
    return true;
  }

  return (
    /^req[_-]/i.test(normalized)
    || /^uid[_-]/i.test(normalized)
    || /^pi_[a-z0-9_]+$/i.test(normalized)
    || /^[a-f0-9]{16,}$/i.test(normalized)
    || /^\d{4}-\d{2}-\d{2}(t|\s)\d{2}:\d{2}/i.test(normalized)
  );
}

function cleanHumanText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = normalizeMultilineText(value);
  if (normalized === '' || isTechnicalIdentifier(normalized)) {
    return undefined;
  }

  return normalized;
}

function flattenUnknownText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return cleanHumanText(value);
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : undefined;
  }

  if (typeof value === 'boolean') {
    return value ? 'Oui' : 'Non';
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => flattenUnknownText(entry))
      .filter((entry): entry is string => Boolean(entry));

    if (parts.length < 1) {
      return undefined;
    }

    return normalizeMultilineText(Array.from(new Set(parts)).join('\n'));
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const directKeys = ['value', 'text', 'body', 'description', 'name', 'label', 'title'] as const;
  for (const key of directKeys) {
    const candidate = flattenUnknownText(value[key]);
    if (candidate) {
      return candidate;
    }
  }

  return undefined;
}

function buildPayloadContainers(payload: ApiPayloadRecord): ApiPayloadRecord[] {
  const containers: ApiPayloadRecord[] = [payload];
  const nestedKeys = ['patient', 'request', 'form', 'summary', 'metadata', 'context', 'payload', 'submission'];

  nestedKeys.forEach((key) => {
    const candidate = payload[key];
    if (isRecord(candidate)) {
      containers.push(candidate);
    }
  });

  return containers;
}

function readPayloadText(payload: ApiPayloadRecord, keys: string[]): string | undefined {
  const containers = buildPayloadContainers(payload);

  for (const container of containers) {
    for (const key of keys) {
      if (!(key in container)) {
        continue;
      }

      const candidate = flattenUnknownText(container[key]);
      if (candidate) {
        return candidate;
      }
    }
  }

  return undefined;
}

function dedupeRequestDetails(fields: RequestDetailField[]): RequestDetailField[] {
  const seen = new Set<string>();

  return fields.filter((field) => {
    const label = normalizeMultilineText(field.label);
    const value = normalizeMultilineText(field.value);
    if (label === '' || value === '') {
      return false;
    }

    const key = `${label.toLowerCase()}::${value.toLowerCase()}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function extractPrimaryReasonFromPayload(payload: ApiPayloadRecord): string | undefined {
  const candidate = readPayloadText(payload, [
    'motif_principal',
    'motif',
    'main_reason',
    'reason',
    'request_reason',
    'consultation_reason',
    'chief_complaint',
    'request_title',
    'title',
    'label',
    'summary',
  ]);

  return candidate && !isEmailLike(candidate) ? candidate : undefined;
}

function extractRequestDetailsFromPayload(payload: ApiPayloadRecord): RequestDetailField[] {
  const primaryReason = extractPrimaryReasonFromPayload(payload);
  const fields: RequestDetailField[] = [];

  const specs: Array<{ label: string; keys: string[] }> = [
    {
      label: 'Motif principal',
      keys: ['motif_principal', 'motif', 'main_reason', 'reason', 'consultation_reason', 'chief_complaint', 'summary'],
    },
    {
      label: 'Symptômes ou contexte',
      keys: ['symptoms', 'symptom_summary', 'symptoms_summary', 'symptomes', 'symptômes', 'context', 'request_context'],
    },
    {
      label: 'Historique médical',
      keys: ['medical_history', 'history', 'historique', 'antecedents', 'antécédents'],
    },
    {
      label: 'Informations communiquées',
      keys: ['private_notes', 'patient_note', 'patient_notes', 'medical_notes', 'medicalNotes', 'note', 'notes', 'comments', 'commentaire', 'description'],
    },
  ];

  specs.forEach((spec) => {
    const value = readPayloadText(payload, spec.keys);
    if (!value) {
      return;
    }

    if (primaryReason && spec.label === 'Motif principal' && value.toLowerCase() === primaryReason.toLowerCase()) {
      return;
    }

    fields.push({ label: spec.label, value });
  });

  return dedupeRequestDetails(fields);
}

function parseDisplayDate(value: string): Date | null {
  const raw = String(value || '').trim();
  if (!raw) {
    return null;
  }

  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? date : null;
}

function formatDateShort(value: string): string {
  const date = parseDisplayDate(value);
  if (!date) {
    return String(value || '').trim();
  }

  try {
    return new Intl.DateTimeFormat('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(date);
  } catch {
    return String(value || '').trim();
  }
}

function formatDateLong(value: string): string {
  const date = parseDisplayDate(value);
  if (!date) {
    return String(value || '').trim();
  }

  try {
    return new Intl.DateTimeFormat('fr-FR', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(date);
  } catch {
    return formatDateShort(value);
  }
}

function formatHumanDate(value: string): string {
  const date = parseDisplayDate(value);
  if (!date) {
    return String(value || '').trim();
  }

  const today = new Date();
  const currentDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const targetDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diffDays = Math.round((targetDay - currentDay) / 86400000);

  if (diffDays === 0) {
    return 'Aujourd’hui';
  }

  if (diffDays === -1) {
    return 'Hier';
  }

  return formatDateShort(value);
}

function formatHumanDateTime(value: string): string {
  const date = parseDisplayDate(value);
  if (!date) {
    return String(value || '').trim();
  }

  try {
    return new Intl.DateTimeFormat('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  } catch {
    return formatDateShort(value);
  }
}

function buildPrescriptionTitle(primaryReason: string | undefined, createdAt: string): string {
  if (primaryReason) {
    return primaryReason;
  }

  const shortDate = formatDateShort(createdAt);
  return shortDate ? `Ordonnance du ${shortDate}` : 'Ordonnance';
}

function formatFileSize(sizeBytes: number | undefined): string {
  const size = Number(sizeBytes || 0);
  if (!Number.isFinite(size) || size <= 0) {
    return 'Taille inconnue';
  }

  if (size >= 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1).replace('.', ',')} Mo`;
  }

  return `${Math.max(1, Math.round(size / 1024))} Ko`;
}

function isPatientProfileComplete(profile: AppConfig['patientProfile'] | undefined, currentUser: AppConfig['currentUser'] | undefined): boolean {
  const firstName = cleanHumanText(profile?.first_name)
    || cleanHumanText(currentUser?.firstName)
    || cleanHumanText(currentUser?.first_name);

  const lastName = cleanHumanText(profile?.last_name)
    || cleanHumanText(currentUser?.lastName)
    || cleanHumanText(currentUser?.last_name);

  const fullName = cleanHumanText(profile?.fullname)
    || cleanHumanText(profile?.full_name)
    || cleanHumanText(profile?.fullName)
    || cleanHumanText([firstName, lastName].filter(Boolean).join(' '))
    || (currentUser?.displayName && !isEmailLike(String(currentUser.displayName)) ? cleanHumanText(String(currentUser.displayName)) : undefined);

  const birthdate = cleanHumanText(profile?.birthdate_fr)
    || cleanHumanText(profile?.birthdate_iso)
    || cleanHumanText(profile?.birthdate)
    || cleanHumanText(currentUser?.birthDate)
    || cleanHumanText(currentUser?.birthdate)
    || cleanHumanText(currentUser?.sosp_birthdate);

  const email = cleanHumanText(profile?.email)
    || cleanHumanText(currentUser?.email);

  const weightKg = cleanHumanText(profile?.weight_kg)
    || cleanHumanText(profile?.weightKg);

  const heightCm = cleanHumanText(profile?.height_cm)
    || cleanHumanText(profile?.heightCm);

  return Boolean(fullName && birthdate && email && weightKg && heightCm);
}

function normalizeAttachmentIds(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const ids = value
    .map((entry) => {
      if (isRecord(entry)) {
        return toPositiveInteger(entry.id);
      }
      return toPositiveInteger(entry);
    })
    .filter((entry) => entry > 0);

  return ids.length > 0 ? ids : undefined;
}

function debugApiPayload(payload: unknown, context?: Record<string, unknown>): void {
  try {
    console.error('SOS_DEBUG_API_PAYLOAD:', payload);
    if (context) {
      console.error('SOS_DEBUG_API_CONTEXT:', context);
    }
  } catch {
    // Ignore console failures in hostile browser environments.
  }
}

function extractApiCode(payload: unknown): string {
  return isRecord(payload) && typeof payload.code === 'string' ? payload.code : '';
}

function extractApiMessage(payload: unknown): string {
  return isRecord(payload) && typeof payload.message === 'string' ? payload.message : '';
}

function buildPatientApiBanner(payload: unknown, status?: number): string | null {
  const code = extractApiCode(payload).toLowerCase();
  const message = extractApiMessage(payload).trim();

  if (code.includes('bad_nonce')) {
    return 'Session invalide côté API. Rechargez la page pour régénérer le jeton de sécurité.';
  }

  if (code.includes('auth_required') || status === 401) {
    return 'Connexion requise pour accéder à l’espace patient.';
  }

  if (code.includes('forbidden') || status === 403) {
    return 'Accès refusé à l’espace patient. Rechargez la page ou reconnectez-vous pour restaurer la session.';
  }

  if (code !== '' && message !== '') {
    return message;
  }

  return null;
}

function normalizePrescriptionSummaryArray(payload: unknown): PrescriptionSummary[] {
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload
    .map((entry): PrescriptionSummary | null => {
      if (!isRecord(entry)) {
        return null;
      }

      const id = toPositiveInteger(entry.id);
      if (id < 1) {
        return null;
      }

      return {
        id,
        uid: toRequiredString(entry.uid, `#${id}`),
        status: toRequiredString(entry.status, ''),
        created_at: toRequiredString(entry.created_at, ''),
        priority: toOptionalString(entry.priority),
        primary_reason: extractPrimaryReasonFromPayload(entry),
      };
    })
    .filter((entry): entry is PrescriptionSummary => entry !== null);
}

function normalizePrescriptionFileArray(payload: unknown): PrescriptionFile[] {
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload
    .map((entry): PrescriptionFile | null => {
      if (!isRecord(entry)) {
        return null;
      }

      const id = toPositiveInteger(entry.id);
      if (id < 1) {
        return null;
      }

      return {
        id,
        original_name: toRequiredString(entry.original_name, `Document #${id}`),
        purpose: toOptionalString(entry.purpose),
        mime: toOptionalString(entry.mime),
        size_bytes: toOptionalNumber(entry.size_bytes),
        download_url: toRequiredString(entry.download_url, ''),
      };
    })
    .filter((entry): entry is PrescriptionFile => entry !== null);
}

function normalizePrescriptionItemArray(payload: unknown): PrescriptionItem[] {
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload
    .map((entry): PrescriptionItem | null => {
      if (!isRecord(entry)) {
        return null;
      }

      const denomination = toRequiredString(entry.denomination, '').trim();
      if (denomination === '') {
        return null;
      }

      return {
        denomination,
        posologie: toOptionalString(entry.posologie),
        quantite: toOptionalString(entry.quantite),
      };
    })
    .filter((entry): entry is PrescriptionItem => entry !== null);
}

function normalizePrescriptionDetail(payload: unknown): PrescriptionDetail | null {
  if (!isRecord(payload)) {
    return null;
  }

  if (extractApiCode(payload) !== '' && extractApiMessage(payload) !== '') {
    return null;
  }

  const id = toPositiveInteger(payload.id);
  if (id < 1) {
    return null;
  }

  if (typeof payload.files !== 'undefined' && !Array.isArray(payload.files)) {
    debugApiPayload(payload, {
      endpoint: `/prescriptions/${id}`,
      expected: 'files[]',
      received_type: typeof payload.files,
    });
  }

  if (typeof payload.items !== 'undefined' && !Array.isArray(payload.items)) {
    debugApiPayload(payload, {
      endpoint: `/prescriptions/${id}`,
      expected: 'items[]',
      received_type: typeof payload.items,
    });
  }

  return {
    id,
    uid: toRequiredString(payload.uid, `#${id}`),
    status: toRequiredString(payload.status, ''),
    created_at: toRequiredString(payload.created_at ?? payload.createdAt, ''),
    priority: toOptionalString(payload.priority),
    decision_reason: toOptionalString(payload.decision_reason),
    primary_reason: extractPrimaryReasonFromPayload(payload),
    request_details: extractRequestDetailsFromPayload(payload),
    files: normalizePrescriptionFileArray(payload.files),
    items: normalizePrescriptionItemArray(payload.items),
    payment: normalizePaymentShadow(payload.payment),
  };
}

function normalizeMessageAuthorRole(value: unknown): string {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === '') {
    return '';
  }

  if (normalized.includes('patient')) {
    return 'PATIENT';
  }

  if (
    normalized.includes('doctor')
    || normalized.includes('medecin')
    || normalized.includes('médecin')
    || normalized.includes('physician')
    || normalized.includes('praticien')
    || normalized.includes('admin')
    || normalized.includes('administrator')
  ) {
    return 'DOCTOR';
  }

  return normalized.toUpperCase();
}

function normalizeMessageId(idValue: unknown, seqValue: unknown): number {
  const seqId = toPositiveInteger(seqValue);
  if (seqId > 0) {
    return seqId;
  }

  const directId = toPositiveInteger(idValue);
  if (directId > 0) {
    return directId;
  }

  return 0;
}

function normalizeMessageRecord(payload: unknown): MessageItem | null {
  if (!isRecord(payload)) {
    return null;
  }

  const seq = toPositiveInteger(payload.seq);
  const id = normalizeMessageId(payload.id, payload.seq);
  if (id < 1) {
    return null;
  }

  const rawAuthorRole =
    payload.author_role
    ?? payload.authorRole
    ?? payload.role;
  const rawCreatedAt =
    payload.created_at
    ?? payload.createdAt;
  const rawAttachments =
    typeof payload.attachments !== 'undefined'
      ? payload.attachments
      : payload.attachment_artifact_ids;

  const authorWpUserId = toPositiveInteger(
    payload.author_wp_user_id
    ?? payload.authorWpUserId
    ?? payload.author_user_id
    ?? payload.authorUserId
  );

  const authorName = cleanHumanText(
    payload.author_name
    ?? payload.authorName
    ?? payload.author_display_name
    ?? payload.authorDisplayName
    ?? payload.doctor_name
    ?? payload.doctorName
  );

  return {
    id,
    seq: seq > 0 ? seq : undefined,
    author_role: normalizeMessageAuthorRole(rawAuthorRole),
    author_wp_user_id: authorWpUserId > 0 ? authorWpUserId : undefined,
    author_name: authorName,
    body: toRequiredString(payload.body, ''),
    created_at: toRequiredString(rawCreatedAt, ''),
    attachments: normalizeAttachmentIds(rawAttachments),
  };
}

function mergeNormalizedMessages(current: MessageItem[], incoming: MessageItem[]): MessageItem[] {
  const map = new Map<string, MessageItem>();

  current.concat(incoming).forEach((message) => {
    const normalized = normalizeMessageRecord(message);
    if (!normalized) {
      return;
    }

    const key = normalized.seq && normalized.seq > 0 ? `seq:${normalized.seq}` : `id:${normalized.id}`;
    map.set(key, normalized);
  });

  return Array.from(map.values()).sort((left, right) => {
    const leftOrder = left.seq && left.seq > 0 ? left.seq : left.id;
    const rightOrder = right.seq && right.seq > 0 ? right.seq : right.id;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return String(left.created_at || '').localeCompare(String(right.created_at || ''));
  });
}

function normalizeMessageArray(payload: unknown): MessageItem[] {
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload
    .map((entry): MessageItem | null => normalizeMessageRecord(entry))
    .filter((entry): entry is MessageItem => entry !== null);
}

function normalizePdfState(payload: unknown): PdfState {
  if (!isRecord(payload)) {
    return {};
  }

  const source = isRecord(payload.pdf) ? payload.pdf : payload;

  return {
    status: toOptionalString(source.status),
    can_download: typeof source.can_download === 'boolean' ? source.can_download : undefined,
    download_url: toOptionalString(source.download_url),
    expires_in: toOptionalNumber(source.expires_in),
    message: toOptionalString(source.message),
    last_error_code: toOptionalNullableString(source.last_error_code),
    last_error_message: toOptionalNullableString(source.last_error_message),
  };
}

function resolveUnknownErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  const apiMessage = extractApiMessage(error);
  return apiMessage !== '' ? apiMessage : fallback;
}

function resolveBannerFromPayload(payload: unknown): string | null {
  return buildPatientApiBanner(payload, 200);
}

function resolveBannerFromError(error: unknown): string | null {
  if (error instanceof ApiPayloadError) {
    return buildPatientApiBanner(error.payload, error.status);
  }
  return null;
}

async function apiJson<T>(path: string, init: RequestInit, scope: Scope = 'patient'): Promise<T> {
  const cfg = getAppConfig();
  const method = String(init.method || 'GET').toUpperCase();
  const headers = new Headers(init.headers || {});
  headers.set('X-WP-Nonce', cfg.nonce);
  headers.set('Accept', 'application/json');
  headers.set('X-Sos-Scope', scope);

  if (method === 'GET') {
    headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    headers.set('Pragma', 'no-cache');
  }

  const response = await fetch(cfg.restBase.replace(/\/$/, '') + withCacheBuster(path, method), {
    ...init,
    method,
    headers,
    credentials: 'same-origin',
    cache: method === 'GET' ? 'no-store' : init.cache,
  });

  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }

  if (!response.ok) {
    debugApiPayload(payload, {
      endpoint: path,
      method,
      status: response.status,
      scope,
    });

    const message =
      payload && typeof payload === 'object' && 'message' in payload && typeof (payload as { message?: unknown }).message === 'string'
        ? String((payload as { message: string }).message)
        : `Erreur API (${response.status})`;
    throw new ApiPayloadError(message, response.status, payload);
  }

  return payload as T;
}

function resolveRestV4Base(cfg: AppConfig): string {
  const explicitBase = String(cfg.restV4Base || '').trim();
  if (explicitBase !== '') {
    return explicitBase.replace(/\/+$/, '');
  }

  const restBase = String(cfg.restBase || '').trim();
  if (restBase === '') {
    throw new Error('Configuration REST V4 absente.');
  }

  return restBase.replace(/\/sosprescription\/v1\/?$/, '/sosprescription/v4').replace(/\/+$/, '');
}

async function apiJsonV4<T>(path: string, init: RequestInit, scope: Scope = 'patient'): Promise<T> {
  const cfg = getAppConfig();
  const method = String(init.method || 'GET').toUpperCase();
  const headers = new Headers(init.headers || {});
  headers.set('X-WP-Nonce', cfg.nonce);
  headers.set('Accept', 'application/json');
  headers.set('X-Sos-Scope', scope);

  if (method === 'GET') {
    headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    headers.set('Pragma', 'no-cache');
  }

  const response = await fetch(resolveRestV4Base(cfg) + withCacheBuster(path, method), {
    ...init,
    method,
    headers,
    credentials: 'same-origin',
    cache: method === 'GET' ? 'no-store' : init.cache,
  });

  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }

  if (!response.ok) {
    debugApiPayload(payload, {
      endpoint: path,
      method,
      status: response.status,
      scope,
    });

    const message =
      payload && typeof payload === 'object' && 'message' in payload && typeof (payload as { message?: unknown }).message === 'string'
        ? String((payload as { message: string }).message)
        : `Erreur API (${response.status})`;
    throw new ApiPayloadError(message, response.status, payload);
  }

  return payload as T;
}

async function getPatientPulse(knownCollectionHash?: string): Promise<unknown> {
  const query = knownCollectionHash && /^[a-f0-9]{12,128}$/i.test(knownCollectionHash)
    ? `?known_collection_hash=${encodeURIComponent(knownCollectionHash)}`
    : '';

  return apiJsonV4<unknown>(`/patient/pulse${query}`, { method: 'GET' }, 'patient');
}

async function getPatientProfile(): Promise<unknown> {
  return apiJsonV4<unknown>('/patient/profile', { method: 'GET' }, 'patient');
}

async function savePatientProfile(payload: Record<string, unknown>): Promise<unknown> {
  return apiJsonV4<unknown>(
    '/patient/profile',
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
    'patient'
  );
}

async function deleteOwnPatientAccount(): Promise<unknown> {
  return apiJsonV4<unknown>(
    '/account/delete',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    },
    'patient'
  );
}

function normalizeProfileMetricInput(value: unknown): string {
  return String(value ?? '').trim().replace(/,/g, '.');
}

function formatIsoToFr(value: string): string {
  const normalized = String(value || '').trim();
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return normalized;
  }
  return `${match[3]}/${match[2]}/${match[1]}`;
}

function parseMetricNumber(value: string): number | null {
  const raw = normalizeProfileMetricInput(value);
  if (raw === '') {
    return null;
  }

  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  return numeric;
}

function computeBmiLabel(weightKg: string, heightCm: string): string {
  const weight = parseMetricNumber(weightKg);
  const height = parseMetricNumber(heightCm);

  if (!weight || !height || weight < 1 || weight > 500 || height < 30 || height > 300) {
    return 'IMC —';
  }

  const meters = height / 100;
  if (meters <= 0) {
    return 'IMC —';
  }

  const bmi = weight / (meters * meters);
  if (!Number.isFinite(bmi) || bmi <= 0) {
    return 'IMC —';
  }

  const rounded = Math.round(bmi * 10) / 10;
  let suffix = 'Corpulence normale';
  if (rounded < 18.5) suffix = 'Insuffisance pondérale';
  else if (rounded < 25) suffix = 'Corpulence normale';
  else if (rounded < 30) suffix = 'Surpoids';
  else if (rounded < 35) suffix = 'Obésité (classe I)';
  else if (rounded < 40) suffix = 'Obésité (classe II)';
  else suffix = 'Obésité (classe III)';

  return `IMC ${String(rounded).replace('.', ',')} • ${suffix}`;
}

function splitHumanDisplayName(value: string): { firstName: string; lastName: string } {
  const normalized = normalizeMultilineText(value).replace(/\s+/g, ' ').trim();
  if (normalized === '' || isEmailLike(normalized)) {
    return { firstName: '', lastName: '' };
  }

  const parts = normalized.split(/\s+/u).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 1) {
    return { firstName: '', lastName: '' };
  }
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: '' };
  }

  const firstName = parts.shift() || '';
  return { firstName, lastName: parts.join(' ') };
}

function buildPatientProfileSeed(
  profile: AppConfig['patientProfile'] | undefined,
  currentUser: AppConfig['currentUser'] | undefined
): PatientProfileFormState {
  const displaySplit = splitHumanDisplayName(
    cleanHumanText(profile?.fullname)
      || cleanHumanText(profile?.full_name)
      || cleanHumanText(profile?.fullName)
      || cleanHumanText(currentUser?.displayName)
      || ''
  );

  const firstName = cleanHumanText(currentUser?.firstName)
    || cleanHumanText(currentUser?.first_name)
    || cleanHumanText(profile?.first_name)
    || displaySplit.firstName
    || '';

  const lastName = cleanHumanText(currentUser?.lastName)
    || cleanHumanText(currentUser?.last_name)
    || cleanHumanText(profile?.last_name)
    || displaySplit.lastName
    || '';

  const birthdate = cleanHumanText(profile?.birthdate_fr)
    || formatIsoToFr(
      cleanHumanText(profile?.birthdate_iso)
      || cleanHumanText(profile?.birthdate)
      || cleanHumanText(currentUser?.birthDate)
      || cleanHumanText(currentUser?.birthdate)
      || cleanHumanText(currentUser?.sosp_birthdate)
      || ''
    )
    || '';

  const email = String(
    cleanHumanText(profile?.email)
    || cleanHumanText(currentUser?.email)
    || ''
  ).toLowerCase();

  const weightKg = normalizeProfileMetricInput(profile?.weight_kg || profile?.weightKg || '');
  const heightCm = normalizeProfileMetricInput(profile?.height_cm || profile?.heightCm || '');
  const note = String(
    cleanHumanText(profile?.note)
    || cleanHumanText(profile?.medical_notes)
    || cleanHumanText(profile?.medicalNotes)
    || ''
  );

  return {
    first_name: firstName,
    last_name: lastName,
    birthdate,
    email,
    weight_kg: weightKg,
    height_cm: heightCm,
    note,
    bmi_label: cleanHumanText(profile?.bmi_label) || computeBmiLabel(weightKg, heightCm),
  };
}

function buildPatientProfilePayload(form: PatientProfileFormState): Record<string, unknown> {
  const note = normalizeMultilineText(form.note || '');
  const weightKg = normalizeProfileMetricInput(form.weight_kg);
  const heightCm = normalizeProfileMetricInput(form.height_cm);

  return {
    first_name: normalizeMultilineText(form.first_name || ''),
    last_name: normalizeMultilineText(form.last_name || ''),
    birthdate: String(form.birthdate || '').trim(),
    email: String(form.email || '').trim().toLowerCase(),
    weight_kg: weightKg,
    weightKg: weightKg,
    height_cm: heightCm,
    heightCm: heightCm,
    note,
    medical_notes: note,
    medicalNotes: note,
  };
}

function profileFormToConfig(form: PatientProfileFormState): AppConfig['patientProfile'] {
  const fullName = normalizeMultilineText([form.first_name, form.last_name].filter(Boolean).join(' '));
  const bmiLabel = computeBmiLabel(form.weight_kg, form.height_cm);

  return {
    fullname: fullName,
    full_name: fullName,
    fullName: fullName,
    birthdate: String(form.birthdate || '').trim(),
    birthdate_fr: String(form.birthdate || '').trim(),
    first_name: normalizeMultilineText(form.first_name || ''),
    last_name: normalizeMultilineText(form.last_name || ''),
    email: String(form.email || '').trim().toLowerCase(),
    note: normalizeMultilineText(form.note || ''),
    medical_notes: normalizeMultilineText(form.note || ''),
    medicalNotes: normalizeMultilineText(form.note || ''),
    weight_kg: normalizeProfileMetricInput(form.weight_kg),
    weightKg: normalizeProfileMetricInput(form.weight_kg),
    height_cm: normalizeProfileMetricInput(form.height_cm),
    heightCm: normalizeProfileMetricInput(form.height_cm),
    bmi_label: bmiLabel,
  };
}

function buildPatientProfileFormRevision(form: PatientProfileFormState): string {
  return JSON.stringify({
    first_name: normalizeMultilineText(form.first_name || ''),
    last_name: normalizeMultilineText(form.last_name || ''),
    birthdate: String(form.birthdate || '').trim(),
    email: String(form.email || '').trim().toLowerCase(),
    weight_kg: normalizeProfileMetricInput(form.weight_kg),
    height_cm: normalizeProfileMetricInput(form.height_cm),
    note: normalizeMultilineText(form.note || ''),
    bmi_label: computeBmiLabel(form.weight_kg, form.height_cm),
  });
}

function normalizePatientProfileFromResponse(
  payload: unknown,
  fallback: PatientProfileFormState,
  currentUser?: AppConfig['currentUser']
): PatientProfileFormState {
  const profile = isRecord(payload) && isRecord(payload.profile)
    ? payload.profile
    : (isRecord(payload) ? payload : {});

  const seed = buildPatientProfileSeed(profile as AppConfig['patientProfile'], currentUser);

  const merged: PatientProfileFormState = {
    first_name: seed.first_name || fallback.first_name,
    last_name: seed.last_name || fallback.last_name,
    birthdate: seed.birthdate || fallback.birthdate,
    email: seed.email || fallback.email,
    weight_kg: seed.weight_kg || fallback.weight_kg,
    height_cm: seed.height_cm || fallback.height_cm,
    note: seed.note || fallback.note,
    bmi_label: seed.bmi_label || fallback.bmi_label,
  };

  return {
    ...merged,
    bmi_label: computeBmiLabel(merged.weight_kg, merged.height_cm),
  };
}

function updateGlobalPatientProfileConfig(profile: AppConfig['patientProfile'] | undefined): void {
  if (!profile) {
    return;
  }

  const g = window as PatientConsoleWindow;
  const cfg = g.SosPrescription || g.SOSPrescription;
  if (!cfg) {
    return;
  }

  const currentUser = { ...(cfg.currentUser || {}) };
  const nextProfile = { ...(cfg.patientProfile || {}), ...profile };
  const fullName = cleanHumanText(profile.fullname)
    || cleanHumanText(profile.full_name)
    || cleanHumanText(profile.fullName)
    || normalizeMultilineText([String(profile.first_name || ''), String(profile.last_name || '')].filter(Boolean).join(' '));

  if (profile.first_name) {
    currentUser.firstName = profile.first_name;
    currentUser.first_name = profile.first_name;
  }
  if (profile.last_name) {
    currentUser.lastName = profile.last_name;
    currentUser.last_name = profile.last_name;
  }
  if (profile.birthdate_iso || profile.birthdate) {
    const birthValue = String(profile.birthdate_iso || profile.birthdate || '').trim();
    currentUser.birthDate = birthValue;
    currentUser.birthdate = birthValue;
    currentUser.sosp_birthdate = birthValue;
  }
  if (profile.email) {
    currentUser.email = profile.email;
  }
  if (fullName && (!cleanHumanText(currentUser.displayName) || isEmailLike(String(currentUser.displayName || '')))) {
    currentUser.displayName = fullName;
  }

  cfg.currentUser = currentUser;
  cfg.patientProfile = nextProfile;
  g.SosPrescription = cfg;
  g.SOSPrescription = cfg;

  window.dispatchEvent(new CustomEvent('sosprescription:patient-profile-updated', {
    detail: {
      profile: nextProfile,
    },
  }));
}

function normalizePaymentShadow(value: unknown): PaymentShadow | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const pricingSnapshot = isRecord(value.pricing_snapshot) ? value.pricing_snapshot : null;

  const directAmount = value.amount_cents === null ? null : toOptionalNumber(value.amount_cents);
  const snapshotAmount = pricingSnapshot && pricingSnapshot.amount_cents !== null
    ? toOptionalNumber(pricingSnapshot.amount_cents)
    : undefined;

  const directCurrency = typeof value.currency === 'string' ? value.currency : null;
  const snapshotCurrency = pricingSnapshot && typeof pricingSnapshot.currency === 'string'
    ? pricingSnapshot.currency
    : null;

  const directPriority = typeof value.priority === 'string' ? value.priority : null;
  const snapshotPriority = pricingSnapshot && typeof pricingSnapshot.selected_priority === 'string'
    ? pricingSnapshot.selected_priority
    : pricingSnapshot && typeof pricingSnapshot.priority === 'string'
    ? pricingSnapshot.priority
    : null;

  const directFlow = typeof value.flow === 'string' ? value.flow : null;
  const snapshotFlow = pricingSnapshot && typeof pricingSnapshot.selected_flow === 'string'
    ? pricingSnapshot.selected_flow
    : pricingSnapshot && typeof pricingSnapshot.flow === 'string'
    ? pricingSnapshot.flow
    : null;

  const directProvider = typeof value.provider === 'string' ? value.provider : null;
  const snapshotProvider = pricingSnapshot && typeof pricingSnapshot.provider === 'string'
    ? pricingSnapshot.provider
    : null;

  const directReference = typeof value.reference === 'string'
    ? value.reference
    : typeof value.payment_reference === 'string'
    ? value.payment_reference
    : typeof value.payment_intent_id === 'string'
    ? value.payment_intent_id
    : null;
  const snapshotReference = pricingSnapshot && typeof pricingSnapshot.payment_intent_id === 'string'
    ? pricingSnapshot.payment_intent_id
    : null;

  const directTransactionAt = typeof value.transaction_at === 'string' ? value.transaction_at : null;
  const snapshotTransactionAt = pricingSnapshot && typeof pricingSnapshot.created_at === 'string'
    ? pricingSnapshot.created_at
    : null;

  const normalized: PaymentShadow = {
    local_status: typeof value.local_status === 'string' ? value.local_status : null,
    provider: directProvider || snapshotProvider || null,
    status: typeof value.status === 'string' ? value.status : null,
    amount_cents: directAmount ?? snapshotAmount ?? null,
    currency: directCurrency || snapshotCurrency || null,
    priority: directPriority || snapshotPriority || null,
    flow: directFlow || snapshotFlow || null,
    reference: directReference || snapshotReference || null,
    transaction_at: directTransactionAt || snapshotTransactionAt || null,
  };

  return hasStructuredPaymentDetails(normalized) ? normalized : undefined;
}

function normalizePatientPulseResponse(payload: unknown): PatientPulseResponse | null {
  if (!isRecord(payload)) {
    return null;
  }

  const collectionHash = toRequiredString(payload.collection_hash, '').trim();
  if (collectionHash === '') {
    return null;
  }

  const unchanged = Boolean(payload.unchanged);
  const items = Array.isArray(payload.items)
    ? payload.items
        .map((entry): PatientPulseItem | null => {
          if (!isRecord(entry)) {
            return null;
          }

          const id = toPositiveInteger(entry.id);
          if (id < 1) {
            return null;
          }

          const rowRev = toRequiredString(entry.row_rev, '').trim();
          if (rowRev === '') {
            return null;
          }

          return {
            id,
            uid: toRequiredString(entry.uid, `#${id}`),
            row_rev: rowRev,
            status: toRequiredString(entry.status, ''),
            processing_status: toOptionalString(entry.processing_status),
            updated_at: toOptionalNullableString(entry.updated_at),
            last_activity_at: toOptionalNullableString(entry.last_activity_at),
            message_count: toOptionalNumber(entry.message_count),
            last_message_seq: toOptionalNumber(entry.last_message_seq),
            unread_count_patient: toOptionalNumber(entry.unread_count_patient),
            has_proof: typeof entry.has_proof === 'boolean' ? entry.has_proof : Boolean(entry.has_proof),
            proof_count: toOptionalNumber(entry.proof_count),
            pdf_ready: typeof entry.pdf_ready === 'boolean' ? entry.pdf_ready : Boolean(entry.pdf_ready),
            payment: normalizePaymentShadow(entry.payment),
          };
        })
        .filter((entry): entry is PatientPulseItem => entry !== null)
    : [];

  return {
    count: toPositiveInteger(payload.count),
    max_updated_at: toOptionalNullableString(payload.max_updated_at),
    collection_hash: collectionHash,
    unchanged,
    items,
  };
}

function mergeSummaryWithPulseRow(row: PrescriptionSummary, pulse: PatientPulseItem | undefined): PrescriptionSummary {
  if (!pulse) {
    return row;
  }

  return {
    ...row,
    uid: pulse.uid || row.uid,
    status: pulse.status || row.status,
    row_rev: pulse.row_rev,
    updated_at: pulse.updated_at,
    last_activity_at: pulse.last_activity_at,
    processing_status: pulse.processing_status,
    message_count: typeof pulse.message_count === 'number' ? pulse.message_count : row.message_count,
    last_message_seq: typeof pulse.last_message_seq === 'number' ? pulse.last_message_seq : row.last_message_seq,
    unread_count_patient: typeof pulse.unread_count_patient === 'number' ? pulse.unread_count_patient : row.unread_count_patient,
    has_proof: typeof pulse.has_proof === 'boolean' ? pulse.has_proof : row.has_proof,
    proof_count: typeof pulse.proof_count === 'number' ? pulse.proof_count : row.proof_count,
    pdf_ready: typeof pulse.pdf_ready === 'boolean' ? pulse.pdf_ready : row.pdf_ready,
    payment: pulse.payment || row.payment,
  };
}

function applyPulseToSummaries(rows: PrescriptionSummary[], items: PatientPulseItem[]): PrescriptionSummary[] {
  const index = new Map<number, PatientPulseItem>();
  items.forEach((item) => {
    index.set(item.id, item);
  });

  return rows.map((row) => mergeSummaryWithPulseRow(row, index.get(row.id)));
}

function canSelfDeletePatientAccount(cfg: AppConfig): boolean {
  return !Boolean(cfg.capabilities?.manage || cfg.capabilities?.manageData || cfg.capabilities?.validate);
}

async function listPatientPrescriptions(): Promise<unknown> {
  return apiJson<unknown>('/prescriptions', { method: 'GET' }, 'patient');
}

async function getPatientPrescription(id: number): Promise<unknown> {
  return apiJson<unknown>(`/prescriptions/${id}`, { method: 'GET' }, 'patient');
}

async function getPatientMessages(id: number): Promise<unknown> {
  return apiJson<unknown>(`/prescriptions/${id}/messages`, { method: 'GET' }, 'patient');
}

async function getPatientPdfStatus(id: number): Promise<unknown> {
  return apiJson<unknown>(`/prescriptions/${id}/pdf-status`, { method: 'GET' }, 'patient');
}

async function postPatientMessage(id: number, body: string, attachments?: number[]): Promise<MessageItem> {
  const payload = await apiJson<unknown>(
    `/prescriptions/${id}/messages`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body, attachments }),
    },
    'patient'
  );

  const messagePayload = isRecord(payload) && isRecord(payload.message) ? payload.message : payload;
  const normalized = normalizeMessageRecord(messagePayload);
  if (normalized) {
    return normalized;
  }

  debugApiPayload(payload, {
    endpoint: `/prescriptions/${id}/messages`,
    expected: 'message object',
    phase: 'create_message',
  });

  return {
    id: Date.now(),
    author_role: 'PATIENT',
    author_wp_user_id: getCurrentWpUserId(),
    body,
    created_at: new Date().toISOString(),
    attachments: Array.isArray(attachments) ? attachments.filter((value) => toPositiveInteger(value) > 0) : undefined,
  };
}

async function createPaymentIntent(id: number, priority: 'express' | 'standard'): Promise<StripePaymentIntentPayload> {
  return apiJson<StripePaymentIntentPayload>(
    `/prescriptions/${id}/payment/intent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority }),
    },
    'form'
  );
}

async function confirmPaymentIntent(id: number, paymentIntentId: string): Promise<unknown> {
  return apiJson<unknown>(
    `/prescriptions/${id}/payment/confirm`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payment_intent_id: paymentIntentId }),
    },
    'form'
  );
}

async function downloadProtectedFile(url: string, filename: string): Promise<void> {
  const cfg = getAppConfig();
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'X-WP-Nonce': cfg.nonce,
    },
    credentials: 'same-origin',
  });

  if (!response.ok) {
    throw new Error('Téléchargement impossible (accès refusé ou fichier indisponible).');
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename || 'download';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

function openPresignedPdf(url: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function normalizeStatusValue(status: string): string {
  return String(status || '').trim().toLowerCase();
}

function isPaymentPendingStatus(status: string): boolean {
  return normalizeStatusValue(status) === 'payment_pending';
}

function isWaitingStatus(status: string): boolean {
  return ['pending', 'in_review', 'needs_info'].includes(normalizeStatusValue(status));
}

function isApprovedStatus(status: string): boolean {
  return normalizeStatusValue(status) === 'approved';
}

function isRejectedStatus(status: string): boolean {
  return normalizeStatusValue(status) === 'rejected';
}

function isClosedStatus(status: string): boolean {
  return ['archived', 'closed', 'completed', 'done', 'terminated', 'cancelled', 'expired'].includes(normalizeStatusValue(status));
}

function isReadOnlyThreadStatus(status: string): boolean {
  return isClosedStatus(status) || isApprovedStatus(status) || isRejectedStatus(status);
}

function hasDoctorQuestionMessage(messages: MessageItem[]): boolean {
  return messages.some((message) => normalizeMessageAuthorRole(message.author_role) === 'DOCTOR');
}

function resolvePatientMessagingState(status: string, messages: MessageItem[]): PatientMessagingState {
  if (isReadOnlyThreadStatus(status)) {
    return 'CLOSED';
  }

  return hasDoctorQuestionMessage(messages) ? 'OPEN' : 'WAITING_DOCTOR';
}

function patientMessagingReadOnlyNotice(status: string, state: PatientMessagingState): string {
  if (state === 'WAITING_DOCTOR') {
    return "Le médecin n'a pas encore sollicité d'information pour ce dossier. Vous pourrez répondre ici dès qu'un message médical sera envoyé.";
  }

  if (isApprovedStatus(status)) {
    return "L'ordonnance a été délivrée. Cet espace est clôturé pour ce dossier.";
  }

  if (isRejectedStatus(status)) {
    return 'Ce dossier est clôturé. Si nécessaire, vous pouvez initier une nouvelle demande.';
  }

  return 'Ce dossier est clôturé. Cet espace sécurisé est désormais en lecture seule.';
}

function patientMessagingEmptyText(status: string, state: PatientMessagingState): string {
  if (state === 'WAITING_DOCTOR') {
    return "Le médecin n'a pas encore sollicité d'information. Cet espace s'ouvrira automatiquement dès qu'un message médical sera envoyé.";
  }

  if (state === 'CLOSED') {
    return patientMessagingReadOnlyNotice(status, state);
  }

  return 'Le médecin a sollicité des informations complémentaires. Vous pouvez lui répondre ici de façon sécurisée.';
}

function statusTone(status: string): 'success' | 'warning' | 'neutral' {
  if (isApprovedStatus(status)) {
    return 'success';
  }

  if (isPaymentPendingStatus(status) || isWaitingStatus(status)) {
    return 'warning';
  }

  return 'neutral';
}

function statusInfo(status: string): { variant: 'info' | 'success' | 'warning' | 'error'; label: string; hint: string } {
  const normalized = normalizeStatusValue(status);
  if (normalized === 'payment_pending') {
    return {
      variant: 'warning',
      label: 'Paiement à finaliser',
      hint: 'Votre dossier est prêt. Il ne manque plus que la validation sécurisée de l’empreinte bancaire.',
    };
  }
  if (normalized === 'pending' || normalized === 'in_review' || normalized === 'needs_info') {
    return {
      variant: 'info',
      label: 'En attente médicale',
      hint: 'Aucune action n’est requise pour le moment. Un médecin examine votre dossier.',
    };
  }
  if (normalized === 'approved') {
    return {
      variant: 'success',
      label: 'Validée',
      hint: 'Votre ordonnance validée est disponible ici dès que le PDF sécurisé est prêt.',
    };
  }
  if (normalized === 'rejected') {
    return {
      variant: 'error',
      label: 'Refusée',
      hint: 'La demande a été refusée. Le motif (si renseigné) apparaît ci-dessous.',
    };
  }
  if (isClosedStatus(status)) {
    return {
      variant: 'info',
      label: 'Clôturée',
      hint: 'Ce dossier est clôturé. Veuillez initier une nouvelle demande si nécessaire.',
    };
  }
  return {
    variant: 'info',
    label: status || '—',
    hint: '',
  };
}

function filePurposeLabel(purpose: string | undefined): string {
  const normalized = String(purpose || '').toLowerCase();
  if (normalized === 'message') return 'Pièce jointe';
  if (normalized === 'supporting_document') return 'Document complémentaire';
  if (normalized === 'identity') return 'Justificatif';
  if (normalized === 'pdf') return 'Ordonnance PDF';
  return 'Document';
}

function getDecisionStep(status: string): number {
  const normalized = normalizeStatusValue(status);
  if (normalized === 'approved' || normalized === 'rejected' || isClosedStatus(status)) return 2;
  if (normalized === 'pending' || normalized === 'in_review' || normalized === 'needs_info') return 1;
  return 0;
}

function formatMoney(amountCents: number | null | undefined, currency: string | null | undefined): string {
  const cents = typeof amountCents === 'number' ? amountCents : 0;
  const code = String(currency || 'EUR').toUpperCase();

  try {
    return new Intl.NumberFormat('fr-FR', {
      style: 'currency',
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${code}`;
  }
}


function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

function Spinner({ className = '' }: { className?: string }) {
  return <span className={cx('sp-spinner', className)} aria-label="Chargement" />;
}

function Notice({
  variant = 'info',
  title,
  children,
}: {
  variant?: 'info' | 'success' | 'warning' | 'error';
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cx('sp-alert', `sp-alert--${variant}`)}>
      {title ? <div className="sp-alert__title">{title}</div> : null}
      <div className={title ? 'sp-alert__body' : undefined}>{children}</div>
    </div>
  );
}

function Button({
  variant = 'primary',
  className = '',
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger';
}) {
  const classes = cx(
    'sp-button',
    variant === 'primary'
      ? 'sp-button--primary'
      : variant === 'danger'
      ? 'sp-button--danger'
      : 'sp-button--secondary',
    className,
  );

  return (
    <button className={classes} {...rest}>
      {children}
    </button>
  );
}

function StatusTimeline({ status }: { status: string }) {
  const currentStep = getDecisionStep(status);
  const steps = [
    { key: 'received', label: 'Reçu' },
    { key: 'review', label: 'Analyse' },
    { key: 'decision', label: 'Décision' },
  ];

  return (
    <div className="sp-steps">
      {steps.map((step, index) => {
        const reached = index <= currentStep;
        const active = index === currentStep;

        return (
          <div key={step.key} className="sp-steps__item">
            <div
              aria-hidden="true"
              className={cx('sp-steps__badge', reached && 'is-reached', active && 'is-active')}
            >
              {index + 1}
            </div>
            <div className={cx('sp-steps__label', reached && 'is-reached', active && 'is-active')}>
              {step.label}
            </div>
            {index < steps.length - 1 ? (
              <div className={cx('sp-steps__divider', index < currentStep && 'is-reached')} aria-hidden="true" />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function StatusPillIcon({ tone }: { tone: 'success' | 'warning' | 'neutral' }) {
  if (tone === 'success') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="sp-status-pill__icon">
        <path d="M20 6 9 17l-5-5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  if (tone === 'warning') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="sp-status-pill__icon">
        <path d="M12 3 3 20h18L12 3Z" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M12 9v4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
        <path d="M12 17h.01" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="sp-status-pill__icon">
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.9" />
      <path d="M12 8v4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      <path d="M12 16h.01" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

function StatusPill({ status }: { status: string }) {
  const info = statusInfo(status);
  const tone = statusTone(status);
  const showIcon = tone !== 'warning';
  const showDot = !showIcon;

  return (
    <span className={cx('sp-status-pill', `is-${tone}`, showIcon ? 'has-icon' : 'has-dot-only')}>
      {showDot ? <span className="sp-status-pill__dot" aria-hidden="true" /> : null}
      {showIcon ? <StatusPillIcon tone={tone} /> : null}
      <span>{info.label}</span>
    </span>
  );
}

function HeroBanner({
  title,
  status,
  createdAt,
  pdf,
  decisionReason,
}: {
  title: string;
  status: string;
  createdAt: string;
  pdf: PdfState | null;
  decisionReason?: string;
}) {
  const normalizedStatus = normalizeStatusValue(status);
  const pdfStatus = normalizeStatusValue(String(pdf?.status || ''));

  let message = statusInfo(status).hint;

  if (normalizedStatus === 'payment_pending') {
    message = 'Une seule étape reste à compléter avant le lancement de l’analyse médicale de votre demande.';
  } else if (isWaitingStatus(normalizedStatus)) {
    message = 'Aucune action n’est requise pour le moment. Un médecin analyse votre dossier et vous préviendra si un complément est nécessaire.';
  } else if (isApprovedStatus(normalizedStatus)) {
    if (pdfStatus === 'failed') {
      message = pdf?.last_error_message || pdf?.message || 'Votre demande est validée, mais le document sécurisé n’est pas encore téléchargeable.';
    } else if (pdfStatus === 'done' && !pdf?.download_url) {
      message = 'Votre demande est validée. Le lien sécurisé est en cours de synchronisation.';
    } else if (Boolean(pdf?.can_download && pdf?.download_url)) {
      message = 'Votre ordonnance validée est prête et disponible dans le bloc de téléchargement sécurisé ci-dessous.';
    } else {
      message = pdf?.message || 'Votre ordonnance est validée. Le PDF sécurisé est en cours de préparation.';
    }
  } else if (isRejectedStatus(normalizedStatus)) {
    message = decisionReason
      ? `Motif médical : ${decisionReason}`
      : 'La demande n’a pas pu être validée à l’issue de l’analyse médicale.';
  } else if (isClosedStatus(normalizedStatus)) {
    message = 'Ce dossier est clôturé. Veuillez initier une nouvelle demande si nécessaire.';
  }

  return (
    <section className="sp-card sp-patient-hero" data-tone={statusTone(status)}>
      <div className="sp-patient-hero__shell">
        <div className="sp-patient-hero__meta-row">
          <div className="sp-patient-hero__eyebrow">
            <StatusPill status={status} />
          </div>
          {createdAt ? <span className="sp-patient-hero__date-chip">{formatDateShort(createdAt)}</span> : null}
        </div>

        <div className="sp-patient-hero__copy-block">
          <h2 className="sp-patient-hero__title">{title}</h2>
          {message ? <p className="sp-patient-hero__message">{message}</p> : null}
        </div>

        <div className="sp-patient-hero__footer">
          <StatusTimeline status={status} />
        </div>
      </div>
    </section>
  );
}

function RequestDetailsDisclosure({ fields }: { fields: RequestDetailField[] }) {
  if (!fields.length) {
    return null;
  }

  return (
    <details className="sp-disclosure">
      <summary>Voir les détails de ma demande</summary>
      <div className="sp-disclosure__content">
        {fields.map((field) => (
          <div key={`${field.label}-${field.value}`} className="sp-disclosure__row">
            <div className="sp-disclosure__label">{field.label}</div>
            <div className="sp-disclosure__value sp-prewrap">{field.value}</div>
          </div>
        ))}
      </div>
    </details>
  );
}

function paymentProviderLabel(provider: string | null | undefined): string {
  const normalized = normalizeStatusValue(String(provider || ''));
  if (normalized === 'stripe') {
    return 'Stripe';
  }

  return provider && String(provider).trim() !== '' ? String(provider).trim() : 'Prestataire sécurisé';
}

function paymentSurfaceStatusLabel(status: string, payment: PaymentShadow | undefined): string {
  if (isPaymentPendingStatus(status)) {
    return 'En attente';
  }

  const normalized = normalizeStatusValue(String(payment?.status || payment?.local_status || ''));

  if (normalized === 'requires_capture' || normalized === 'succeeded' || normalized === 'captured') {
    return 'Payé';
  }

  if (normalized === 'processing') {
    return 'Validation bancaire en cours';
  }

  if (normalized === 'canceled' || normalized === 'cancelled') {
    return 'Annulé';
  }

  if (normalized === 'requires_payment_method' || normalized === 'requires_action') {
    return 'En attente';
  }

  return normalized !== '' ? 'Payé' : 'Non communiqué';
}

function hasStructuredPaymentDetails(payment: PaymentShadow | undefined): boolean {
  if (!payment) {
    return false;
  }

  return (
    typeof payment.amount_cents === 'number'
    || Boolean(payment.provider && String(payment.provider).trim() !== '')
    || Boolean(payment.status && String(payment.status).trim() !== '')
    || Boolean(payment.local_status && String(payment.local_status).trim() !== '')
    || Boolean(payment.priority && String(payment.priority).trim() !== '')
    || Boolean(payment.flow && String(payment.flow).trim() !== '')
    || Boolean(payment.reference && String(payment.reference).trim() !== '')
    || Boolean(payment.transaction_at && String(payment.transaction_at).trim() !== '')
  );
}

function paymentAmountLabel(payment: PaymentShadow | undefined): string {
  if (typeof payment?.amount_cents === 'number') {
    return formatMoney(payment.amount_cents, payment.currency ?? 'EUR');
  }

  return 'Non communiqué';
}

function paymentPriorityLabel(priority: string | null | undefined): string {
  const normalized = normalizeStatusValue(String(priority || ''));
  if (normalized === 'express') {
    return 'Express';
  }

  if (normalized === 'standard') {
    return 'Standard';
  }

  return priority && String(priority).trim() !== '' ? String(priority).trim() : '';
}

function paymentFlowLabel(flow: string | null | undefined): string {
  const normalized = normalizeStatusValue(String(flow || ''));
  if (normalized === 'renewal' || normalized === 'ro_proof' || normalized === 'renouvellement') {
    return 'Renouvellement';
  }

  if (normalized === 'depannage' || normalized === 'depannage_no_proof' || normalized === 'sos' || normalized === 'depannage-sos') {
    return 'Dépannage';
  }

  return flow && String(flow).trim() !== '' ? String(flow).trim() : '';
}

function paymentFormulaLabel(payment: PaymentShadow | undefined, fallbackPriority?: string | null): string {
  const flowLabel = paymentFlowLabel(payment?.flow);
  const priorityLabel = paymentPriorityLabel(payment?.priority || fallbackPriority || null);

  if (flowLabel && priorityLabel) {
    return `${flowLabel} · ${priorityLabel}`;
  }

  if (priorityLabel) {
    return priorityLabel;
  }

  if (flowLabel) {
    return flowLabel;
  }

  return 'Non communiquée';
}

function paymentReferenceLabel(payment: PaymentShadow | undefined, fallbackUid?: string | null): string {
  const reference = typeof payment?.reference === 'string' ? payment.reference.trim() : '';
  if (reference !== '') {
    return reference;
  }

  const uid = typeof fallbackUid === 'string' ? fallbackUid.trim() : '';
  if (uid !== '') {
    return uid;
  }

  return 'Non communiquée';
}

function paymentTransactionDateLabel(status: string, payment: PaymentShadow | undefined): string {
  const transactionAt = typeof payment?.transaction_at === 'string' ? payment.transaction_at.trim() : '';
  if (transactionAt !== '') {
    return formatHumanDateTime(transactionAt);
  }

  if (isPaymentPendingStatus(status)) {
    return 'En attente';
  }

  return 'Non communiquée';
}

function paymentDisclosureSummaryText(status: string, payment: PaymentShadow | undefined): string {
  const statusLabel = paymentSurfaceStatusLabel(status, payment);
  const amountLabel = paymentAmountLabel(payment);

  return amountLabel !== 'Non communiqué'
    ? `${statusLabel} · ${amountLabel}`
    : statusLabel;
}

function PaymentDetailsCard({
  status,
  payment,
  fallbackPriority,
  fallbackUid,
}: {
  status: string;
  payment: PaymentShadow | undefined;
  fallbackPriority?: string | null;
  fallbackUid?: string | null;
}) {
  if (!hasStructuredPaymentDetails(payment)) {
    return null;
  }

  const summaryMeta = paymentDisclosureSummaryText(status, payment);
  const defaultOpen = isPaymentPendingStatus(status);

  return (
    <details className="sp-disclosure sp-disclosure--payment sp-payment-details-card" open={defaultOpen}>
      <summary>
        <span className="sp-disclosure__summary-copy">
          <span className="sp-disclosure__summary-title">Détails du paiement</span>
          {summaryMeta ? <span className="sp-disclosure__summary-meta">{summaryMeta}</span> : null}
        </span>
      </summary>
      <div className="sp-disclosure__content sp-disclosure__content--payment">
        <div className="sp-payment-details-card__grid">
          <div className="sp-inline-card sp-payment-details-card__item">
            <div className="sp-inline-card__title">Montant exact</div>
            <div className="sp-inline-card__meta sp-payment-details-card__value">{paymentAmountLabel(payment)}</div>
          </div>
          <div className="sp-inline-card sp-payment-details-card__item">
            <div className="sp-inline-card__title">Formule choisie</div>
            <div className="sp-inline-card__meta sp-payment-details-card__value">{paymentFormulaLabel(payment, fallbackPriority)}</div>
          </div>
          <div className="sp-inline-card sp-payment-details-card__item">
            <div className="sp-inline-card__title">Statut</div>
            <div className="sp-inline-card__meta sp-payment-details-card__value">{paymentSurfaceStatusLabel(status, payment)}</div>
          </div>
          <div className="sp-inline-card sp-payment-details-card__item">
            <div className="sp-inline-card__title">Date de transaction</div>
            <div className="sp-inline-card__meta sp-payment-details-card__value">{paymentTransactionDateLabel(status, payment)}</div>
          </div>
          <div className="sp-inline-card sp-payment-details-card__item">
            <div className="sp-inline-card__title">Référence interne</div>
            <div className="sp-inline-card__meta sp-payment-details-card__value sp-payment-details-card__value--reference">
              {paymentReferenceLabel(payment, fallbackUid)}
            </div>
          </div>
          <div className="sp-inline-card sp-payment-details-card__item">
            <div className="sp-inline-card__title">Prestataire</div>
            <div className="sp-inline-card__meta sp-payment-details-card__value">{paymentProviderLabel(payment?.provider)}</div>
          </div>
        </div>
      </div>
    </details>
  );
}

function PatientPaymentSection({
  prescriptionId,
  priority,
  billingName,
  billingEmail,
  amountCents,
  currency,
  etaValue,
  onPaid,
}: {
  prescriptionId: number;
  priority: 'express' | 'standard';
  billingName?: string;
  billingEmail?: string;
  amountCents?: number | null;
  currency?: string | null;
  etaValue?: string | null;
  onPaid: () => void;
}) {
  const createIntentHandler = useCallback(() => createPaymentIntent(prescriptionId, priority), [prescriptionId, priority]);
  const confirmIntentHandler = useCallback((paymentIntentId: string) => confirmPaymentIntent(prescriptionId, paymentIntentId), [prescriptionId]);

  return (
    <StripePaymentModule
      mode="patient_space"
      title="Paiement à finaliser"
      intro="Votre dossier est prêt. Il n’attend plus que la validation sécurisée de l’empreinte bancaire avant son traitement médical."
      note="Empreinte bancaire sécurisée via Stripe • Aucun débit avant validation médicale"
      amountCents={amountCents ?? null}
      currency={currency || 'EUR'}
      etaValue={etaValue || null}
      billingName={billingName}
      billingEmail={billingEmail}
      createIntent={createIntentHandler}
      confirmIntent={confirmIntentHandler}
      onAuthorized={onPaid}
      safeErrorMessage={toMedicalGradePaymentErrorMessage}
      submitIdleLabel={amountCents ? `Finaliser mon paiement — ${formatMoney(amountCents, currency || 'EUR')}` : 'Finaliser mon paiement'}
      submitBusyLabel="Validation sécurisée en cours…"
      mountLoadingLabel="Chargement du formulaire de paiement sécurisé…"
      submittingStatusLabel="Validation bancaire sécurisée en cours. Ne fermez pas la page et ne cliquez pas une seconde fois."
    />
  );
}

function PdfCard({
  status,
  pdf,
  downloadBusy = false,
  onDownload,
}: {
  status: string;
  pdf: PdfState | null;
  downloadBusy?: boolean;
  onDownload: () => void | Promise<void>;
}) {
  const normalizedStatus = String(status || '').toLowerCase();
  if (normalizedStatus !== 'approved') return null;

  const pdfStatus = String(pdf?.status || '').toLowerCase();
  const canDownload = Boolean(pdf?.can_download);

  if (canDownload) {
    return (
      <div className="sp-alert sp-alert--success">
        <div className="sp-alert__title">Ordonnance</div>
        <div className="sp-alert__body">
          Votre ordonnance est prête. Le lien de téléchargement sécurisé est régénéré au moment du clic.
        </div>
        <div className="sp-inline-actions">
          <Button type="button" onClick={() => void onDownload()} disabled={downloadBusy}>
            {downloadBusy ? 'Préparation du lien sécurisé…' : 'Télécharger l’ordonnance'}
          </Button>
        </div>
      </div>
    );
  }

  if (pdfStatus === 'failed') {
    return (
      <Notice variant="error" title="Ordonnance">
        {pdf?.last_error_message || pdf?.message || 'Votre ordonnance est validée, mais le document n’est pas encore téléchargeable.'}
      </Notice>
    );
  }

  if (pdfStatus === 'done' && !pdf?.download_url) {
    return (
      <Notice variant="warning" title="Ordonnance">
        Ordonnance générée — synchronisation du lien de téléchargement en cours.
      </Notice>
    );
  }

  return (
    <Notice variant="info" title="Ordonnance">
      <div className="sp-loading-row">
        <Spinner />
        <span>{pdf?.message || 'Ordonnance validée — génération du PDF en cours.'}</span>
      </div>
    </Notice>
  );
}

function PatientProfilePanel({
  snapshot,
  onProfileChange,
  canDeleteAccount,
}: {
  snapshot: PatientProfileSnapshot;
  onProfileChange: (profile: AppConfig['patientProfile']) => void;
  canDeleteAccount: boolean;
}) {
  const initialSeed = useMemo(
    () => buildPatientProfileSeed(snapshot.patientProfile, snapshot.currentUser),
    [
      snapshot.currentUser?.displayName,
      snapshot.currentUser?.email,
      snapshot.currentUser?.firstName,
      snapshot.currentUser?.lastName,
      snapshot.currentUser?.first_name,
      snapshot.currentUser?.last_name,
      snapshot.currentUser?.birthDate,
      snapshot.currentUser?.birthdate,
      snapshot.currentUser?.sosp_birthdate,
      snapshot.patientProfile?.fullname,
      snapshot.patientProfile?.full_name,
      snapshot.patientProfile?.fullName,
      snapshot.patientProfile?.birthdate,
      snapshot.patientProfile?.birthdate_fr,
      snapshot.patientProfile?.birthdate_iso,
      snapshot.patientProfile?.first_name,
      snapshot.patientProfile?.last_name,
      snapshot.patientProfile?.email,
      snapshot.patientProfile?.note,
      snapshot.patientProfile?.medical_notes,
      snapshot.patientProfile?.medicalNotes,
      snapshot.patientProfile?.weight_kg,
      snapshot.patientProfile?.weightKg,
      snapshot.patientProfile?.height_cm,
      snapshot.patientProfile?.heightCm,
      snapshot.patientProfile?.bmi_label,
    ]
  );

  const profileOwnerId = useMemo(() => {
    const snapshotId = toPositiveInteger(snapshot.currentUser?.id);
    if (snapshotId > 0) {
      return snapshotId;
    }

    const globalId = getCurrentWpUserId();
    return typeof globalId === 'number' && globalId > 0 ? globalId : 0;
  }, [snapshot.currentUser?.id]);

  const [form, setForm] = useState<PatientProfileFormState>(initialSeed);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const initialSeedRef = useRef(initialSeed);
  const currentUserRef = useRef(snapshot.currentUser);
  const initialProfileLoadDoneRef = useRef(false);
  const formDirtyRef = useRef(false);
  const lastAppliedFormRevisionRef = useRef<string>(buildPatientProfileFormRevision(initialSeed));

  useEffect(() => {
    initialSeedRef.current = initialSeed;
  }, [initialSeed]);

  useEffect(() => {
    currentUserRef.current = snapshot.currentUser;
  }, [snapshot.currentUser]);

  useEffect(() => {
    const nextRevision = buildPatientProfileFormRevision(initialSeed);

    if (!initialProfileLoadDoneRef.current) {
      setForm(initialSeed);
      lastAppliedFormRevisionRef.current = nextRevision;
      return;
    }

    if (formDirtyRef.current) {
      return;
    }

    if (lastAppliedFormRevisionRef.current === nextRevision) {
      return;
    }

    setForm(initialSeed);
    lastAppliedFormRevisionRef.current = nextRevision;
  }, [initialSeed]);

  useEffect(() => {
    let disposed = false;
    const seed = initialSeedRef.current;
    const currentUser = currentUserRef.current;
    const seedRevision = buildPatientProfileFormRevision(seed);

    if (profileOwnerId < 1) {
      initialProfileLoadDoneRef.current = true;
      formDirtyRef.current = false;
      lastAppliedFormRevisionRef.current = seedRevision;
      setForm(seed);
      setLoading(false);
      return () => {
        disposed = true;
      };
    }

    initialProfileLoadDoneRef.current = false;
    formDirtyRef.current = false;
    lastAppliedFormRevisionRef.current = seedRevision;
    setForm(seed);
    setLoading(true);
    setFeedback(null);

    async function boot(): Promise<void> {
      try {
        const payload = await getPatientProfile();
        if (disposed) {
          return;
        }

        const normalized = normalizePatientProfileFromResponse(payload, seed, currentUser);
        const nextRevision = buildPatientProfileFormRevision(normalized);
        lastAppliedFormRevisionRef.current = nextRevision;
        setForm(normalized);
        const nextProfile = profileFormToConfig(normalized);
        updateGlobalPatientProfileConfig(nextProfile);
        onProfileChange(nextProfile);
      } catch {
        if (!disposed) {
          lastAppliedFormRevisionRef.current = seedRevision;
        }
      } finally {
        if (!disposed) {
          initialProfileLoadDoneRef.current = true;
          setLoading(false);
        }
      }
    }

    void boot();

    return () => {
      disposed = true;
    };
  }, [onProfileChange, profileOwnerId]);

  const updateField = (field: keyof PatientProfileFormState, value: string): void => {
    formDirtyRef.current = true;

    setForm((current) => ({
      ...current,
      [field]: value,
      ...(field === 'weight_kg' || field === 'height_cm'
        ? {
            bmi_label: computeBmiLabel(
              field === 'weight_kg' ? value : current.weight_kg,
              field === 'height_cm' ? value : current.height_cm,
            ),
          }
        : {}),
    }));
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setFeedback(null);

    const payload = buildPatientProfilePayload(form);
    const firstName = String(payload.first_name || '').trim();
    const lastName = String(payload.last_name || '').trim();
    const email = String(payload.email || '').trim();

    if (firstName !== '' && isEmailLike(firstName)) {
      setFeedback({ tone: 'error', text: 'Le prénom ne peut pas être une adresse e-mail.' });
      return;
    }
    if (lastName !== '' && isEmailLike(lastName)) {
      setFeedback({ tone: 'error', text: 'Le nom ne peut pas être une adresse e-mail.' });
      return;
    }
    if (email !== '' && !isEmailLike(email)) {
      setFeedback({ tone: 'error', text: 'Adresse e-mail invalide.' });
      return;
    }

    setSaving(true);
    try {
      const response = await savePatientProfile(payload);
      const normalized = normalizePatientProfileFromResponse(response, form, snapshot.currentUser);
      const nextProfile = isRecord(response) && isRecord(response.profile)
        ? ({ ...profileFormToConfig(normalized), ...(response.profile as AppConfig['patientProfile']) })
        : profileFormToConfig(normalized);
      const nextRevision = buildPatientProfileFormRevision(normalized);

      formDirtyRef.current = false;
      lastAppliedFormRevisionRef.current = nextRevision;
      setForm(normalized);
      updateGlobalPatientProfileConfig(nextProfile);
      onProfileChange(nextProfile);
      setFeedback({ tone: 'success', text: 'Profil enregistré avec succès.' });
    } catch (error) {
      setFeedback({
        tone: 'error',
        text: resolveUnknownErrorMessage(error, 'Impossible d’enregistrer le profil patient.'),
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteAccount = async (): Promise<void> => {
    const confirmed = window.confirm(
      "Action irréversible. Votre accès sera immédiatement détruit et vous ne pourrez plus vous connecter. Vos données médicales strictement nécessaires seront conservées sous forme d'archives inactives pour répondre aux obligations légales de traçabilité. Confirmer la suppression ?"
    );

    if (!confirmed) {
      return;
    }

    setFeedback(null);
    setDeleting(true);
    try {
      await deleteOwnPatientAccount();
      setFeedback({ tone: 'success', text: 'Compte supprimé. Redirection…' });
      window.location.assign('/');
    } catch (error) {
      setFeedback({
        tone: 'error',
        text: resolveUnknownErrorMessage(error, 'La suppression du compte a échoué.'),
      });
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div className="sp-profile-card sp-profile-card--embedded">
        {feedback ? (
          <div className="sp-inline-note">
            <Notice variant={feedback.tone === 'success' ? 'success' : feedback.tone === 'info' ? 'info' : 'error'}>
              {feedback.text}
            </Notice>
          </div>
        ) : null}

        <Notice variant="info" title="Profil patient">
          <div className="sp-loading-row">
            <Spinner />
            <span>Chargement sécurisé du profil…</span>
          </div>
        </Notice>
      </div>
    );
  }

  return (
    <div className="sp-profile-card sp-profile-card--embedded">
      {feedback ? (
        <div className="sp-inline-note">
          <Notice variant={feedback.tone === 'success' ? 'success' : feedback.tone === 'info' ? 'info' : 'error'}>
            {feedback.text}
          </Notice>
        </div>
      ) : null}

      <form id="sp-patient-profile-form" noValidate onSubmit={(event) => void handleSubmit(event)}>
        <div className="sp-profile-grid">
          <label className="sp-field">
            <span>Prénom</span>
            <input
              type="text"
              name="first_name"
              maxLength={100}
              autoComplete="given-name"
              value={form.first_name}
              onChange={(event) => updateField('first_name', event.currentTarget.value)}
            />
          </label>

          <label className="sp-field">
            <span>Nom</span>
            <input
              type="text"
              name="last_name"
              maxLength={120}
              autoComplete="family-name"
              value={form.last_name}
              onChange={(event) => updateField('last_name', event.currentTarget.value)}
            />
          </label>

          <label className="sp-field">
            <span>Date de naissance</span>
            <input
              type="text"
              name="birthdate"
              placeholder="JJ/MM/AAAA"
              inputMode="numeric"
              autoComplete="bday"
              value={form.birthdate}
              onChange={(event) => updateField('birthdate', event.currentTarget.value)}
            />
          </label>

          <label className="sp-field">
            <span>Email</span>
            <input
              type="email"
              name="email"
              maxLength={190}
              autoComplete="email"
              value={form.email}
              onChange={(event) => updateField('email', event.currentTarget.value)}
            />
          </label>

          <label className="sp-field">
            <span>Poids (kg)</span>
            <input
              type="number"
              name="weight_kg"
              min="1"
              max="500"
              step="0.1"
              inputMode="decimal"
              value={form.weight_kg}
              onChange={(event) => updateField('weight_kg', event.currentTarget.value)}
            />
          </label>

          <label className="sp-field">
            <span>Taille (cm)</span>
            <input
              type="number"
              name="height_cm"
              min="30"
              max="300"
              step="0.1"
              inputMode="decimal"
              value={form.height_cm}
              onChange={(event) => updateField('height_cm', event.currentTarget.value)}
            />
          </label>

          <div className="sp-field sp-field--readonly">
            <span>IMC</span>
            <div className="sp-profile-bmi">{form.bmi_label || 'IMC —'}</div>
          </div>
        </div>

        <div className="sp-field sp-field--full">
          <label className="sp-field__label" htmlFor="sp-profile-medical-notes">
            Précisions médicales (optionnel)
          </label>
          <textarea
            id="sp-profile-medical-notes"
            name="note"
            className="sp-textarea"
            rows={4}
            placeholder="Allergies, antécédents, contre-indications ou toute information utile au médecin…"
            value={form.note}
            onChange={(event) => updateField('note', event.currentTarget.value)}
          />
        </div>

        <div className="sp-profile-actions">
          <Button type="submit" className="sp-profile-actions__submit" disabled={saving || deleting}>
            {saving ? <Spinner /> : 'Enregistrer mes informations'}
          </Button>
        </div>
      </form>

      {canDeleteAccount ? (
        <div className="sp-card" style={{ marginTop: '1rem' }}>
          <div className="sp-stack">
            <h3>Suppression de compte</h3>
            <p className="sp-field__help">
              Votre accès sera immédiatement détruit. Vos données strictement nécessaires seront conservées sous forme d’archives inactives pour répondre aux obligations légales de traçabilité.
            </p>
            <div>
              <Button type="button" variant="secondary" disabled={saving || deleting} onClick={() => void handleDeleteAccount()}>
                {deleting ? <Spinner /> : 'Supprimer mon compte'}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}


export default function PatientConsole() {
  const cfg = getAppConfig();
  const isLoggedIn = Boolean(cfg.currentUser?.id && Number(cfg.currentUser.id) > 0);

  const [prescriptions, setPrescriptions] = useState<PrescriptionSummary[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<PrescriptionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [apiBanner, setApiBanner] = useState<string | null>(null);
  const [pdfStates, setPdfStates] = useState<Record<number, PdfState>>({});
  const [pdfDownloadBusyId, setPdfDownloadBusyId] = useState<number | null>(null);
  const [workspace, setWorkspace] = useState<'requests' | 'profile'>('requests');
  const [profileSnapshot, setProfileSnapshot] = useState<PatientProfileSnapshot>(() => ({
    patientProfile: cfg.patientProfile,
    currentUser: cfg.currentUser,
  }));

  const prescriptionsRef = useRef<PrescriptionSummary[]>([]);
  const selectedIdRef = useRef<number | null>(null);
  const pulseCollectionHashRef = useRef<string>('');
  const pulseInFlightRef = useRef(false);
  const pulseTimerRef = useRef<number | null>(null);
  const listRequestSeqRef = useRef(0);
  const detailRequestSeqRef = useRef(0);
  const messagesRequestSeqRef = useRef(0);

  const requestedId = useMemo(() => {
    try {
      const search = new URLSearchParams(window.location.search);
      const value = Number.parseInt(search.get('rx') || '', 10);
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    prescriptionsRef.current = prescriptions;
  }, [prescriptions]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  const clearPulseTimer = useCallback((): void => {
    if (pulseTimerRef.current !== null) {
      window.clearTimeout(pulseTimerRef.current);
      pulseTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!isLoggedIn) {
      clearPulseTimer();
      pulseCollectionHashRef.current = '';
      pulseInFlightRef.current = false;
      setPrescriptions([]);
      setSelectedId(null);
      setDetail(null);
      setMessages([]);
      setPdfStates({});
      setPdfDownloadBusyId(null);
    }
  }, [clearPulseTimer, isLoggedIn]);

  useEffect(() => {
    const handlePatientProfileUpdated = (event: Event): void => {
      const detail = event instanceof CustomEvent
        ? (event.detail as { profile?: AppConfig['patientProfile'] } | undefined)
        : undefined;
      const nextConfig = getAppConfig();
      setProfileSnapshot({
        patientProfile: detail?.profile || nextConfig.patientProfile,
        currentUser: nextConfig.currentUser,
      });
    };

    window.addEventListener('sosprescription:patient-profile-updated', handlePatientProfileUpdated as EventListener);
    return () => {
      window.removeEventListener('sosprescription:patient-profile-updated', handlePatientProfileUpdated as EventListener);
    };
  }, []);

  const handleProfileChange = useCallback((profile: AppConfig['patientProfile']): void => {
    const nextConfig = getAppConfig();
    setProfileSnapshot({
      patientProfile: { ...(nextConfig.patientProfile || {}), ...(profile || {}) },
      currentUser: nextConfig.currentUser,
    });
  }, []);

  const selectedSummary = useMemo(
    () => prescriptions.find((row) => Number(row.id) === Number(selectedId)) || null,
    [prescriptions, selectedId]
  );

  const profileComplete = useMemo(
    () => isPatientProfileComplete(profileSnapshot.patientProfile, profileSnapshot.currentUser),
    [profileSnapshot.currentUser, profileSnapshot.patientProfile]
  );

  const paymentProfileSeed = useMemo(
    () => buildPatientProfileSeed(profileSnapshot.patientProfile, profileSnapshot.currentUser),
    [profileSnapshot.currentUser, profileSnapshot.patientProfile]
  );
  const paymentBillingName = useMemo(() => {
    const combined = cleanHumanText([paymentProfileSeed.first_name, paymentProfileSeed.last_name].filter(Boolean).join(' '));
    return combined
      || cleanHumanText(profileSnapshot.patientProfile?.fullname)
      || cleanHumanText(profileSnapshot.patientProfile?.full_name)
      || cleanHumanText(profileSnapshot.patientProfile?.fullName)
      || cleanHumanText(profileSnapshot.currentUser?.displayName)
      || undefined;
  }, [
    paymentProfileSeed.first_name,
    paymentProfileSeed.last_name,
    profileSnapshot.currentUser?.displayName,
    profileSnapshot.patientProfile?.fullName,
    profileSnapshot.patientProfile?.full_name,
    profileSnapshot.patientProfile?.fullname,
  ]);
  const paymentBillingEmail = useMemo(() => {
    const email = cleanHumanText(profileSnapshot.patientProfile?.email)
      || cleanHumanText(profileSnapshot.currentUser?.email)
      || cleanHumanText(paymentProfileSeed.email);
    return email || undefined;
  }, [paymentProfileSeed.email, profileSnapshot.currentUser?.email, profileSnapshot.patientProfile?.email]);

  const selectedStatus = normalizeStatusValue(selectedSummary?.status || detail?.status || '');
  const selectedPdf = selectedId ? pdfStates[selectedId] || null : null;
  const activePayment = useMemo<PaymentShadow | undefined>(() => {
    if (!selectedSummary?.payment && !detail?.payment) {
      return undefined;
    }

    return {
      ...(detail?.payment || {}),
      ...(selectedSummary?.payment || {}),
    };
  }, [detail?.payment, selectedSummary?.payment]);
  const selectedPaymentPriority = normalizeStatusValue(String(activePayment?.priority || selectedSummary?.priority || detail?.priority || ''));
  const requestTitle = useMemo(
    () => buildPrescriptionTitle(detail?.primary_reason || selectedSummary?.primary_reason, detail?.created_at || selectedSummary?.created_at || ''),
    [detail?.created_at, detail?.primary_reason, selectedSummary?.created_at, selectedSummary?.primary_reason]
  );
  const requestDetails = detail?.request_details || [];
  const messagingState = useMemo<PatientMessagingState>(
    () => (selectedId ? resolvePatientMessagingState(selectedStatus, messages) : 'WAITING_DOCTOR'),
    [messages, selectedId, selectedStatus]
  );
  const messagingLocked = messagingState !== 'OPEN';
  const messagingReadOnlyNotice = selectedId
    ? patientMessagingReadOnlyNotice(selectedStatus, messagingState)
    : "Le médecin n'a pas encore sollicité d'information pour ce dossier.";
  const messagingEmptyText = selectedId
    ? patientMessagingEmptyText(selectedStatus, messagingState)
    : "Le médecin n'a pas encore sollicité d'information. Cet espace s'ouvrira automatiquement dès qu'un message médical sera envoyé.";
  const messagingSubtitle = messagingState === 'OPEN'
    ? 'Messagerie sécurisée associée à votre dossier.'
    : '';
  const unreadPatientMessages = toPositiveInteger(selectedSummary?.unread_count_patient);
  const messagingDisclosureDefaultOpen = unreadPatientMessages > 0 || messagingState === 'OPEN';
  const messagingDisclosureSummary = unreadPatientMessages > 1
    ? `${unreadPatientMessages} messages non lus`
    : unreadPatientMessages === 1
      ? '1 message non lu'
      : '';
  const messagingDisclosureResetKey = `patient-thread-${detail?.id || selectedId || 0}-${messagingDisclosureDefaultOpen ? 'open' : 'closed'}-${unreadPatientMessages}`;

  const fileIndex = useMemo(() => {
    const index: Record<number, PrescriptionFile> = {};
    (detail?.files || []).forEach((file) => {
      index[file.id] = file;
    });
    return index;
  }, [detail?.files]);

  const refreshList = useCallback(async ({ silent = false }: { silent?: boolean } = {}): Promise<void> => {
    const requestSeq = ++listRequestSeqRef.current;

    if (!silent) {
      setError(null);
      setApiBanner(null);
      setListLoading(true);
    }

    try {
      const payload = await listPatientPrescriptions();
      if (!Array.isArray(payload)) {
        debugApiPayload(payload, {
          endpoint: '/prescriptions',
          expected: 'array',
          received_type: typeof payload,
        });

        const banner = resolveBannerFromPayload(payload);
        if (!silent && banner) {
          setApiBanner(banner);
          setError(null);
        } else if (!silent) {
          setError('Réponse API inattendue pour la liste des demandes. Consultez la console pour le payload brut.');
        }
        return;
      }

      const rows = normalizePrescriptionSummaryArray(payload);
      setPrescriptions((current) => {
        const index = new Map<number, PrescriptionSummary>();
        current.forEach((row) => {
          index.set(Number(row.id), row);
        });

        return rows.map((row) => {
          const existing = index.get(Number(row.id));
          if (!existing) {
            return row;
          }

          return {
            ...row,
            status: existing.status || row.status,
            primary_reason: row.primary_reason || existing.primary_reason,
            row_rev: existing.row_rev,
            updated_at: existing.updated_at,
            last_activity_at: existing.last_activity_at,
            processing_status: existing.processing_status,
            message_count: existing.message_count,
            last_message_seq: existing.last_message_seq,
            unread_count_patient: existing.unread_count_patient,
            has_proof: existing.has_proof,
            proof_count: existing.proof_count,
            pdf_ready: existing.pdf_ready,
            payment: existing.payment,
          };
        });
      });

      setSelectedId((current) => {
        if (current && rows.some((row) => Number(row.id) === Number(current))) {
          return current;
        }
        if (requestedId && rows.some((row) => Number(row.id) === Number(requestedId))) {
          return requestedId;
        }
        return rows.length > 0 ? Number(rows[0].id) : null;
      });

      if (rows.length < 1 && !silent) {
        setDetail(null);
        setMessages([]);
      }
    } catch (err) {
      const banner = resolveBannerFromError(err);
      if (!silent && banner) {
        setApiBanner(banner);
        setError(null);
      } else if (!silent) {
        setError(resolveUnknownErrorMessage(err, 'Erreur chargement'));
      }
    } finally {
      if (!silent && listRequestSeqRef.current === requestSeq) {
        setListLoading(false);
      }
    }
  }, [requestedId]);

  const loadDetail = useCallback(async (id: number, silent = false): Promise<void> => {
    const requestSeq = ++detailRequestSeqRef.current;

    if (!silent) {
      setError(null);
      setApiBanner(null);
      setDetailLoading(true);
    }

    try {
      const payload = await getPatientPrescription(id);
      const normalized = normalizePrescriptionDetail(payload);

      if (!normalized) {
        debugApiPayload(payload, {
          endpoint: `/prescriptions/${id}`,
          expected: 'object',
          received_type: typeof payload,
        });
        const banner = resolveBannerFromPayload(payload);
        if (!silent && banner) {
          setApiBanner(banner);
          setError(null);
        } else if (!silent) {
          setError('Réponse API inattendue sur le détail patient. Consultez la console pour le payload brut.');
        }
        if (!silent && selectedIdRef.current === id) {
          setDetail(null);
        }
        return;
      }

      if (selectedIdRef.current !== id) {
        return;
      }

      setDetail(normalized);
      setPrescriptions((current) => current.map((row) => {
        if (Number(row.id) !== Number(normalized.id)) {
          return row;
        }

        return {
          ...row,
          created_at: normalized.created_at || row.created_at,
          primary_reason: normalized.primary_reason || row.primary_reason,
          payment: normalized.payment || row.payment,
        };
      }));
    } catch (err) {
      const banner = resolveBannerFromError(err);
      if (!silent && banner) {
        setApiBanner(banner);
        setError(null);
      } else if (!silent) {
        setError(resolveUnknownErrorMessage(err, 'Erreur chargement'));
      }
      if (!silent && selectedIdRef.current === id) {
        setDetail(null);
      }
    } finally {
      if (!silent && detailRequestSeqRef.current === requestSeq) {
        setDetailLoading(false);
      }
    }
  }, []);

  const loadMessages = useCallback(async (id: number, silent = false): Promise<void> => {
    const requestSeq = ++messagesRequestSeqRef.current;

    if (!silent) {
      setError(null);
      setApiBanner(null);
      setMessagesLoading(true);
    }

    try {
      const payload = await getPatientMessages(id);
      const messagesArray = Array.isArray(payload)
        ? payload
        : (payload && typeof payload === 'object' && 'messages' in payload ? (payload as { messages?: unknown }).messages : payload);

      if (!Array.isArray(messagesArray)) {
        debugApiPayload(payload, {
          endpoint: `/prescriptions/${id}/messages`,
          expected: 'array | { messages: array }',
          received_type: typeof payload,
        });
        const banner = resolveBannerFromPayload(payload);
        if (!silent && banner) {
          setApiBanner(banner);
          setError(null);
        } else if (!silent) {
          setError('Réponse API inattendue sur la messagerie. Consultez la console pour le payload brut.');
        }
        if (!silent && selectedIdRef.current === id) {
          setMessages([]);
        }
        return;
      }

      const normalizedMessages = normalizeMessageArray(messagesArray).filter((message) => {
        const normalizedRole = normalizeMessageAuthorRole(message.author_role);
        if (normalizedRole === 'PATIENT' || normalizedRole === 'DOCTOR') {
          return true;
        }

        return String(message.body || '').trim() !== '' || (Array.isArray(message.attachments) && message.attachments.length > 0);
      });

      if (selectedIdRef.current !== id) {
        return;
      }

      setMessages(normalizedMessages);
    } catch (err) {
      const banner = resolveBannerFromError(err);
      if (!silent && banner) {
        setApiBanner(banner);
        setError(null);
      } else if (!silent) {
        setError(resolveUnknownErrorMessage(err, 'Erreur messagerie'));
      }
      if (!silent && selectedIdRef.current === id) {
        setMessages([]);
      }
    } finally {
      if (!silent && messagesRequestSeqRef.current === requestSeq) {
        setMessagesLoading(false);
      }
    }
  }, []);

  const loadPdfStatus = useCallback(async (id: number, silent = false): Promise<void> => {
    try {
      const payload = await getPatientPdfStatus(id);
      const banner = resolveBannerFromPayload(payload);
      if (!silent && banner) {
        setApiBanner(banner);
        setError(null);
      }
      setPdfStates((current) => ({
        ...current,
        [id]: normalizePdfState(payload),
      }));
    } catch (err) {
      const banner = resolveBannerFromError(err);
      if (!silent && banner) {
        setApiBanner(banner);
        setError(null);
      } else if (!silent) {
        setError(resolveUnknownErrorMessage(err, 'Erreur document'));
      }

      if (!silent) {
        setPdfStates((current) => ({
          ...current,
          [id]: {
            status: 'failed',
            message: 'Impossible de récupérer le statut PDF.',
            last_error_message: resolveUnknownErrorMessage(err, 'Erreur document'),
            last_error_code: err instanceof ApiPayloadError ? extractApiCode(err.payload) || null : null,
          },
        }));
      }
    }
  }, []);

  const syncPulse = useCallback(async (): Promise<void> => {
    if (!isLoggedIn || pulseInFlightRef.current) {
      return;
    }

    pulseInFlightRef.current = true;
    try {
      const knownCollectionHash = pulseCollectionHashRef.current || undefined;
      const payload = await getPatientPulse(knownCollectionHash);
      const normalized = normalizePatientPulseResponse(payload);
      if (!normalized) {
        debugApiPayload(payload, {
          endpoint: '/patient/pulse',
          expected: 'pulse payload',
        });
        return;
      }

      pulseCollectionHashRef.current = normalized.collection_hash;
      if (normalized.unchanged) {
        return;
      }

      const previousRows = prescriptionsRef.current;
      const previousMap = new Map<number, PrescriptionSummary>();
      previousRows.forEach((row) => {
        previousMap.set(Number(row.id), row);
      });

      const nextMap = new Map<number, PatientPulseItem>();
      normalized.items.forEach((item) => {
        nextMap.set(Number(item.id), item);
      });

      setPrescriptions((current) => applyPulseToSummaries(current, normalized.items));

      let shouldReloadList = normalized.count !== previousRows.length;
      if (!shouldReloadList) {
        for (const item of normalized.items) {
          if (!previousMap.has(Number(item.id))) {
            shouldReloadList = true;
            break;
          }
        }
      }
      if (!shouldReloadList) {
        for (const row of previousRows) {
          if (!nextMap.has(Number(row.id))) {
            shouldReloadList = true;
            break;
          }
        }
      }

      if (shouldReloadList) {
        await refreshList({ silent: true });
      }

      const activeId = selectedIdRef.current;
      if (!activeId) {
        return;
      }

      const previousActive = previousMap.get(Number(activeId));
      const nextActive = nextMap.get(Number(activeId));
      if (!nextActive) {
        return;
      }

      const detailChanged = !previousActive || nextActive.row_rev !== previousActive.row_rev;
      const activityChanged = !previousActive
        || nextActive.last_activity_at !== previousActive.last_activity_at
        || nextActive.last_message_seq !== previousActive.last_message_seq
        || nextActive.message_count !== previousActive.message_count
        || nextActive.unread_count_patient !== previousActive.unread_count_patient;
      const pdfChanged = !previousActive
        || nextActive.status !== previousActive.status
        || Boolean(nextActive.pdf_ready) !== Boolean(previousActive.pdf_ready)
        || nextActive.updated_at !== previousActive.updated_at
        || nextActive.processing_status !== previousActive.processing_status;

      if (detailChanged) {
        await loadDetail(activeId, true);
      }
      if (activityChanged) {
        await loadMessages(activeId, true);
      }
      if (normalizeStatusValue(nextActive.status) === 'approved' && (pdfChanged || detailChanged)) {
        await loadPdfStatus(activeId, true);
      }

      if (
        previousActive
        && normalizeStatusValue(previousActive.status) === 'approved'
        && normalizeStatusValue(nextActive.status) !== 'approved'
      ) {
        setPdfStates((current) => {
          if (!(activeId in current)) {
            return current;
          }
          const next = { ...current };
          delete next[activeId];
          return next;
        });
      }
    } catch {
      // silent refresh must never destabilize the current UI snapshot
    } finally {
      pulseInFlightRef.current = false;
    }
  }, [isLoggedIn, loadDetail, loadMessages, loadPdfStatus, refreshList]);

  useEffect(() => {
    if (!isLoggedIn) {
      return;
    }

    let disposed = false;
    void (async () => {
      await refreshList();
      if (!disposed) {
        await syncPulse();
      }
    })();

    return () => {
      disposed = true;
    };
  }, [isLoggedIn, refreshList, syncPulse]);

  useEffect(() => {
    if (!isLoggedIn) {
      return;
    }

    if (!selectedId) {
      setDetail(null);
      setMessages([]);
      setDetailLoading(false);
      setMessagesLoading(false);
      return;
    }

    setDetail(null);
    setMessages([]);
    void loadDetail(selectedId);
    void loadMessages(selectedId);
  }, [isLoggedIn, loadDetail, loadMessages, selectedId]);

  useEffect(() => {
    if (!isLoggedIn || !selectedId) return;
    if (selectedStatus !== 'approved') return;
    void loadPdfStatus(selectedId, true);
  }, [isLoggedIn, loadPdfStatus, selectedId, selectedStatus]);

  useEffect(() => {
    if (!isLoggedIn || !selectedId) return;
    if (selectedStatus !== 'approved') return;

    const pdfStatus = String(selectedPdf?.status || '').toLowerCase();
    const canDownload = Boolean(selectedPdf?.can_download && selectedPdf?.download_url);
    if (canDownload || pdfStatus === 'failed') {
      return;
    }

    const timer = window.setInterval(() => {
      void loadPdfStatus(selectedId, true);
    }, 15000);

    return () => {
      window.clearInterval(timer);
    };
  }, [isLoggedIn, loadPdfStatus, selectedId, selectedPdf?.can_download, selectedPdf?.download_url, selectedPdf?.status, selectedStatus]);

  useEffect(() => {
    if (!isLoggedIn) {
      clearPulseTimer();
      return;
    }

    let disposed = false;

    const scheduleNext = (): void => {
      if (disposed) {
        return;
      }

      clearPulseTimer();
      const delay = document.hidden ? 60000 : 20000;
      pulseTimerRef.current = window.setTimeout(() => {
        void (async () => {
          await syncPulse();
          if (!disposed) {
            scheduleNext();
          }
        })();
      }, delay);
    };

    const triggerNow = (): void => {
      if (disposed) {
        return;
      }

      clearPulseTimer();
      void (async () => {
        await syncPulse();
        if (!disposed) {
          scheduleNext();
        }
      })();
    };

    const handleVisibility = (): void => {
      if (!document.hidden) {
        triggerNow();
      }
    };

    scheduleNext();
    window.addEventListener('focus', triggerNow);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      disposed = true;
      clearPulseTimer();
      window.removeEventListener('focus', triggerNow);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [clearPulseTimer, isLoggedIn, syncPulse]);

  const handleMessageCreated = useCallback(async (message: MessageItem): Promise<void> => {
    setMessages((current) => mergeNormalizedMessages(current, [message]));
    setPrescriptions((current) => current.map((row) => {
      if (Number(row.id) !== Number(selectedIdRef.current)) {
        return row;
      }

      return {
        ...row,
        last_activity_at: message.created_at,
        message_count: (row.message_count || 0) + 1,
        last_message_seq: typeof message.seq === 'number' ? message.seq : row.last_message_seq,
      };
    }));
    void syncPulse();
  }, [syncPulse]);

  const handleMessageAttachmentDownload = useCallback(
    async (attachmentId: number): Promise<void> => {
      const file = fileIndex[attachmentId];
      const filename = file ? file.original_name : `Fichier #${attachmentId}`;
      const fileUrl = file ? file.download_url : `${cfg.restBase.replace(/\/$/, '')}/files/${attachmentId}/download`;
      await downloadProtectedFile(fileUrl, filename);
    },
    [cfg.restBase, fileIndex]
  );

  const handlePrescriptionPdfDownload = useCallback(async (prescriptionId: number): Promise<void> => {
    if (prescriptionId < 1) {
      return;
    }

    setPdfDownloadBusyId(prescriptionId);
    setError(null);
    setApiBanner(null);

    try {
      const payload = await getPatientPdfStatus(prescriptionId);
      const banner = resolveBannerFromPayload(payload);
      if (banner) {
        throw new Error(banner);
      }

      const normalized = normalizePdfState(payload);
      setPdfStates((current) => ({
        ...current,
        [prescriptionId]: normalized,
      }));

      const freshUrl = String(normalized.download_url || '').trim();
      const canDownload = Boolean(normalized.can_download && freshUrl !== '');
      if (!canDownload) {
        throw new Error(normalized.last_error_message || normalized.message || 'Le document sécurisé est en cours de préparation.');
      }

      openPresignedPdf(freshUrl);
    } catch (err) {
      const banner = resolveBannerFromError(err);
      if (banner) {
        setApiBanner(banner);
        setError(null);
      } else {
        setError(resolveUnknownErrorMessage(err, 'Le document sécurisé est temporairement indisponible.'));
      }
    } finally {
      setPdfDownloadBusyId((current) => (current === prescriptionId ? null : current));
    }
  }, []);

  if (!isLoggedIn) {
    return (
      <div className="sp-page-shell sp-page-shell--narrow sp-app-theme">
        <Notice variant="warning">Connexion requise. Merci de vous connecter pour accéder à votre espace patient.</Notice>
      </div>
    );
  }

  return (
    <div className="sp-page-shell sp-app-theme sp-app-container sp-patient-console">
      <div className="sp-patient-console__workspace-nav" role="tablist" aria-label="Navigation de l’espace patient">
        <button
          id="sp-workspace-tab-requests"
          type="button"
          role="tab"
          aria-selected={workspace === 'requests'}
          aria-controls="sp-workspace-panel-requests"
          className={cx('sp-patient-console__workspace-tab', workspace === 'requests' && 'is-active')}
          onClick={() => setWorkspace('requests')}
        >
          Mes dossiers médicaux
        </button>

        <button
          id="sp-workspace-tab-profile"
          type="button"
          role="tab"
          aria-selected={workspace === 'profile'}
          aria-controls="sp-workspace-panel-profile"
          className={cx('sp-patient-console__workspace-tab', workspace === 'profile' && 'is-active')}
          onClick={() => setWorkspace('profile')}
        >
          Profil patient
          <span
            className="sp-patient-console__workspace-badge"
            data-state={profileComplete ? 'success' : 'warning'}
          >
            {profileComplete ? 'Complet' : 'À compléter'}
          </span>
        </button>
      </div>

      {apiBanner ? (
        <div className="sp-inline-note">
          <Notice variant="error" title="Incident API patient">{apiBanner}</Notice>
        </div>
      ) : null}

      {error ? (
        <div className="sp-inline-note">
          <Notice variant="error">{error}</Notice>
        </div>
      ) : null}

      {workspace === 'profile' ? (
        <section
          id="sp-workspace-panel-profile"
          className="sp-panel sp-patient-console__profile-panel"
          role="tabpanel"
          aria-labelledby="sp-workspace-tab-profile"
        >
          <div className="sp-panel__header">
            <div>
              <div className="sp-panel__title">Profil patient</div>
              <div className="sp-text-subtle">Mettez à jour votre profil sans bloquer l’accès à vos dossiers médicaux.</div>
            </div>
          </div>

          <div className="sp-panel__body">
            <PatientProfilePanel
              snapshot={profileSnapshot}
              onProfileChange={handleProfileChange}
              canDeleteAccount={canSelfDeletePatientAccount(cfg)}
            />
          </div>
        </section>
      ) : (
        <div
          id="sp-workspace-panel-requests"
          className="sp-console-grid sp-patient-console__workspace"
          role="tabpanel"
          aria-labelledby="sp-workspace-tab-requests"
        >
          <aside className="sp-console-grid__sidebar sp-patient-console__sidebar">
            <div className="sp-panel sp-patient-console__sidebar-panel">
              <div className="sp-panel__header">
                <div className="sp-panel__title">Mes demandes</div>
              </div>
              <div className="sp-panel__body">
                {prescriptions.length === 0 ? (
                  <div className="sp-panel__empty">{listLoading ? 'Chargement…' : 'Aucune demande.'}</div>
                ) : (
                  <div className="sp-list sp-patient-console__request-list">
                    {prescriptions.map((row) => {
                      const info = statusInfo(row.status);
                      const selected = Number(row.id) === Number(selectedId);

                      return (
                        <button
                          key={row.id}
                          type="button"
                          className={cx('sp-list-item', 'sp-list-item--button', 'sp-list-item--request', selected && 'is-selected')}
                          onClick={() => setSelectedId(Number(row.id))}
                        >
                          <div className="sp-list-item__status-row">
                            <span className={cx('sp-status-dot', `is-${statusTone(row.status)}`)} aria-hidden="true" />
                            <div className="sp-list-item__meta">{info.label}</div>
                          </div>
                          <div className="sp-list-item__title">{buildPrescriptionTitle(row.primary_reason, row.created_at)}</div>
                          <div className="sp-list-item__submeta">{formatHumanDate(row.created_at)}</div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </aside>

          <section className="sp-console-grid__content sp-patient-console__detail">
            {!selectedId ? (
              <div className="sp-card sp-patient-console__detail-state">Sélectionnez une demande à gauche.</div>
            ) : null}

            {selectedId && detailLoading && !detail ? (
              <div className="sp-card sp-patient-console__detail-state sp-patient-console__detail-state--loading">
                <div className="sp-loading-row">
                  <Spinner />
                  <span>Chargement…</span>
                </div>
              </div>
            ) : null}

            {selectedId && detail ? (
              <div className="sp-patient-console__detail-shell">
                <div className="sp-patient-console__detail-stack">
                  <HeroBanner
                    title={requestTitle}
                    status={selectedStatus}
                    createdAt={detail.created_at || selectedSummary?.created_at || ''}
                    pdf={selectedPdf}
                    decisionReason={detail.decision_reason}
                  />

                  <PdfCard
                    status={selectedStatus}
                    pdf={selectedPdf}
                    downloadBusy={pdfDownloadBusyId === detail.id}
                    onDownload={() => handlePrescriptionPdfDownload(detail.id)}
                  />

                  {isPaymentPendingStatus(selectedStatus) ? (
                    <div className="sp-section">
                      <PatientPaymentSection
                        prescriptionId={detail.id}
                        priority={selectedPaymentPriority === 'express' ? 'express' : 'standard'}
                        billingName={paymentBillingName}
                        billingEmail={paymentBillingEmail}
                        amountCents={activePayment?.amount_cents ?? null}
                        currency={activePayment?.currency ?? 'EUR'}
                        etaValue={selectedPaymentPriority === 'express' ? 'Traitement prioritaire' : null}
                        onPaid={() => {
                          void refreshList({ silent: true });
                          void loadDetail(detail.id, true);
                          void syncPulse();
                        }}
                      />
                    </div>
                  ) : null}

                  <PaymentDetailsCard
                    status={selectedStatus}
                    payment={activePayment}
                    fallbackPriority={selectedPaymentPriority !== '' ? selectedPaymentPriority : null}
                    fallbackUid={detail.uid || selectedSummary?.uid || null}
                  />

                  <RequestDetailsDisclosure fields={requestDetails} />

                  {(detail.files || []).length > 0 ? (
                    <div className="sp-section">
                      <div className="sp-section__title">Documents</div>
                      <div className="sp-stack sp-stack--compact">
                        {(detail.files || []).map((file) => (
                          <div key={file.id} className="sp-inline-card">
                            <div className="sp-inline-card__row">
                              <div className="sp-inline-card__content">
                                <div className="sp-inline-card__title sp-truncate">{file.original_name}</div>
                                <div className="sp-inline-card__meta">
                                  {filePurposeLabel(file.purpose)} • {formatFileSize(file.size_bytes)}
                                </div>
                              </div>
                              <Button
                                type="button"
                                variant="secondary"
                                onClick={() => void downloadProtectedFile(file.download_url, file.original_name)}
                              >
                                Télécharger
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {detail.items.length > 0 ? (
                    <div className="sp-section">
                      <div className="sp-section__title">Médicaments</div>
                      <div className="sp-stack sp-stack--compact">
                        {detail.items.map((item, index) => (
                          <div key={`${item.denomination}-${index}`} className="sp-inline-card">
                            <div className="sp-inline-card__title">{item.denomination}</div>
                            {item.posologie ? <div className="sp-inline-card__meta">Posologie : {item.posologie}</div> : null}
                            {item.quantite ? <div className="sp-inline-card__meta">Quantité : {item.quantite}</div> : null}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  <div className="sp-section">
                    <details
                      key={messagingDisclosureResetKey}
                      className="sp-disclosure sp-disclosure--thread"
                      defaultOpen={messagingDisclosureDefaultOpen}
                    >
                      <summary>
                        <span className="sp-disclosure__summary-copy">
                          <span className="sp-disclosure__summary-title">Échanges avec le médecin</span>
                          {messagingDisclosureSummary ? (
                            <span className="sp-disclosure__summary-meta">{messagingDisclosureSummary}</span>
                          ) : null}
                        </span>
                      </summary>
                      <div className="sp-disclosure__content sp-disclosure__content--thread">
                        <MessageThread
                          prescriptionId={detail.id}
                          viewerRole="PATIENT"
                          currentUserRoles={cfg.currentUser?.roles}
                          title=""
                          subtitle={messagingSubtitle}
                          loading={messagesLoading}
                          emptyText={messagingLocked ? '' : messagingEmptyText}
                          messages={messages}
                          fileIndex={fileIndex}
                          onDownloadFile={handleMessageAttachmentDownload}
                          canCompose={!messagingLocked}
                          readOnlyNotice={messagingReadOnlyNotice}
                          hideComposerWhenReadOnly={messagingLocked}
                          postMessage={postPatientMessage}
                          onMessageCreated={handleMessageCreated}
                          onSurfaceError={setError}
                        />
                      </div>
                    </details>
                  </div>
                </div>
              </div>
            ) : null}
          </section>
        </div>
      )}
    </div>
  );
}
