// src/components/PatientConsole.tsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import MessageThread from './messaging/MessageThread';

type Scope = 'patient' | 'form' | 'admin';

type AppConfig = {
  restBase: string;
  nonce: string;
  currentUser?: {
    id?: number;
    displayName?: string;
    email?: string;
    roles?: string[] | string;
  };
  patientProfile?: {
    fullname?: string;
    birthdate_fr?: string;
    birthdate_iso?: string;
    first_name?: string;
    last_name?: string;
    note?: string;
    medical_notes?: string;
    medicalNotes?: string;
    weight_kg?: string;
    height_cm?: string;
  };
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

type UploadedFile = PrescriptionFile;

type PdfState = {
  status?: string;
  can_download?: boolean;
  download_url?: string;
  expires_in?: number;
  message?: string;
  last_error_code?: string | null;
  last_error_message?: string | null;
};

type PaymentIntentResponse = {
  client_secret: string | null;
  payment_intent_id: string | null;
  amount_cents: number;
  currency: string;
  publishable_key: string;
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
  Stripe?: (
    publishableKey: string
  ) => {
    elements: () => {
      create: (type: string) => {
        mount: (element: HTMLElement) => void;
        destroy: () => void;
      };
    };
    confirmCardPayment: (
      clientSecret: string,
      payload: Record<string, unknown>
    ) => Promise<{
      error?: { message?: string };
      paymentIntent?: { id?: string };
    }>;
  };
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
  const fullName = cleanHumanText(profile?.fullname)
    || cleanHumanText([profile?.first_name, profile?.last_name].filter(Boolean).join(' '))
    || (currentUser?.displayName && !isEmailLike(String(currentUser.displayName)) ? cleanHumanText(currentUser.displayName) : undefined);

  const birthdate = cleanHumanText(profile?.birthdate_fr) || cleanHumanText(profile?.birthdate_iso);
  return Boolean(fullName && birthdate);
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

async function uploadPatientFile(file: File, purpose: string, prescriptionId?: number): Promise<UploadedFile> {
  const formData = new FormData();
  formData.append('purpose', purpose);
  if (prescriptionId && prescriptionId > 0) {
    formData.append('prescription_id', String(prescriptionId));
  }
  formData.append('file', file);

  return apiJson<UploadedFile>('/files', { method: 'POST', body: formData }, 'form');
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

async function createPaymentIntent(id: number, priority: 'express' | 'standard'): Promise<PaymentIntentResponse> {
  return apiJson<PaymentIntentResponse>(
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
  return isClosedStatus(status);
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
      label: 'Paiement requis',
      hint: 'Finalisez le paiement sécurisé pour lancer l’analyse médicale de votre dossier.',
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

let stripeScriptPromise: Promise<void> | null = null;

function ensureStripeJs(): Promise<void> {
  const g = (typeof window !== 'undefined' ? window : null) as PatientConsoleWindow | null;
  if (g && typeof g.Stripe === 'function') {
    return Promise.resolve();
  }

  if (!stripeScriptPromise) {
    stripeScriptPromise = new Promise<void>((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>('script[data-stripe-js="1"]');
      if (existing) {
        existing.addEventListener('load', () => resolve());
        existing.addEventListener('error', () => reject(new Error('Impossible de charger Stripe.js')));
        return;
      }

      const script = document.createElement('script');
      script.src = 'https://js.stripe.com/v3/';
      script.async = true;
      script.dataset.stripeJs = '1';
      script.addEventListener('load', () => resolve());
      script.addEventListener('error', () => reject(new Error('Impossible de charger Stripe.js')));
      document.body.appendChild(script);
    });
  }

  return stripeScriptPromise;
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

function ButtonLink({
  href,
  variant = 'primary',
  className = '',
  children,
  target = '_blank',
}: {
  href: string;
  variant?: 'primary' | 'secondary';
  className?: string;
  children: React.ReactNode;
  target?: string;
}) {
  const classes = cx(
    'sp-button',
    variant === 'primary' ? 'sp-button--primary' : 'sp-button--secondary',
    className,
  );

  return (
    <a className={classes} href={href} target={target} rel="noopener noreferrer">
      {children}
    </a>
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

function StatusPill({ status }: { status: string }) {
  const info = statusInfo(status);
  const tone = statusTone(status);

  return (
    <span className={cx('sp-status-pill', `is-${tone}`)}>
      <span className="sp-status-pill__dot" aria-hidden="true" />
      <span>{info.label}</span>
    </span>
  );
}

function HeroBanner({
  title,
  status,
  createdAt,
  pdf,
  paymentPreview,
  decisionReason,
  onDownloadPrescription,
  onScrollToPayment,
}: {
  title: string;
  status: string;
  createdAt: string;
  pdf: PdfState | null;
  paymentPreview: { amountCents: number; currency: string } | null;
  decisionReason?: string;
  onDownloadPrescription: () => void;
  onScrollToPayment: () => void;
}) {
  const info = statusInfo(status);
  const normalizedStatus = normalizeStatusValue(status);
  const pdfStatus = normalizeStatusValue(String(pdf?.status || ''));
  const downloadUrl = String(pdf?.download_url || '');
  const canDownload = Boolean(pdf?.can_download && downloadUrl);

  let lead = info.hint;
  let support = createdAt ? `Demande déposée le ${formatHumanDateTime(createdAt)}.` : '';
  let action: React.ReactNode = null;

  if (isPaymentPendingStatus(normalizedStatus)) {
    lead = 'Une seule étape reste à compléter pour lancer l’analyse médicale de votre demande.';
    support = 'Aucun prélèvement n’est effectué en cas de refus médical.';
    action = (
      <Button type="button" onClick={onScrollToPayment} className="sp-patient-hero__button">
        {paymentPreview ? `Payer ${formatMoney(paymentPreview.amountCents, paymentPreview.currency)}` : 'Payer ma demande'}
      </Button>
    );
  } else if (isWaitingStatus(normalizedStatus)) {
    lead = 'Aucune action n’est requise pour le moment. Un médecin analyse votre dossier.';
    support = 'Vous serez averti ici si une précision ou un document complémentaire est nécessaire.';
    action = <div className="sp-patient-hero__note">Nous vous tenons informé de chaque évolution.</div>;
  } else if (isApprovedStatus(normalizedStatus)) {
    if (canDownload) {
      lead = 'Votre ordonnance est prête. Vous pouvez la télécharger en un seul geste.';
      support = 'Le lien de téléchargement est sécurisé et régénéré automatiquement.';
      action = (
        <Button type="button" onClick={onDownloadPrescription} className="sp-patient-hero__button">
          Télécharger l’ordonnance
        </Button>
      );
    } else if (pdfStatus === 'failed') {
      lead = pdf?.last_error_message || pdf?.message || 'Votre ordonnance est validée, mais le document n’est pas encore téléchargeable.';
      support = 'Le téléchargement réapparaîtra automatiquement dès que le PDF sécurisé sera prêt.';
      action = (
        <Button type="button" disabled className="sp-patient-hero__button">
          Préparation du PDF…
        </Button>
      );
    } else {
      lead = pdf?.message || 'Votre ordonnance est validée. Le PDF sécurisé est en cours de préparation.';
      support = 'Le bouton de téléchargement s’activera automatiquement dès que le document sera prêt.';
      action = (
        <Button type="button" disabled className="sp-patient-hero__button">
          <Spinner className="sp-patient-hero__spinner" />
          Préparation du PDF…
        </Button>
      );
    }
  } else if (isRejectedStatus(normalizedStatus)) {
    lead = 'Votre demande n’a pas pu être validée à l’issue de l’analyse médicale.';
    support = 'Le motif médical, lorsqu’il est renseigné, apparaît ci-dessous.';
    action = <div className="sp-patient-hero__note">Aucune action requise</div>;
  } else if (isClosedStatus(normalizedStatus)) {
    lead = 'Ce dossier est clôturé. Veuillez initier une nouvelle demande si nécessaire.';
    support = 'La messagerie associée à ce dossier est désormais en lecture seule.';
    action = <div className="sp-patient-hero__note">Dossier clôturé</div>;
  }

  return (
    <section className="sp-card sp-patient-hero" data-tone={statusTone(status)}>
      <div className="sp-patient-hero__eyebrow">
        <StatusPill status={status} />
        {createdAt ? <span className="sp-patient-hero__date">{formatHumanDate(createdAt)}</span> : null}
      </div>

      <div className="sp-patient-hero__body">
        <div className="sp-patient-hero__content">
          <h2 className="sp-patient-hero__title">{title}</h2>
          <p className="sp-patient-hero__lead">{lead}</p>
          {support ? <p className="sp-patient-hero__support">{support}</p> : null}

          {decisionReason && isRejectedStatus(normalizedStatus) ? (
            <div className="sp-patient-hero__decision">
              <div className="sp-patient-hero__decision-label">Motif médical</div>
              <div className="sp-prewrap">{decisionReason}</div>
            </div>
          ) : null}
        </div>

        <div className="sp-patient-hero__actions">{action}</div>
      </div>

      <div className="sp-patient-hero__footer">
        <StatusTimeline status={status} />
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

function PaymentCard({
  prescriptionId,
  priority,
  onPaid,
  onIntentReady,
}: {
  prescriptionId: number;
  priority: 'express' | 'standard';
  onPaid: () => void;
  onIntentReady?: (intent: { amountCents: number; currency: string }) => void;
}) {
  const cfg = getAppConfig();
  const mountRef = useRef<HTMLDivElement | null>(null);
  const stripeRef = useRef<ReturnType<NonNullable<PatientConsoleWindow['Stripe']>> | null>(null);
  const cardRef = useRef<{ destroy: () => void } | null>(null);

  const [initializing, setInitializing] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);
  const [amountCents, setAmountCents] = useState<number | null>(null);
  const [currency, setCurrency] = useState<string>('EUR');

  useEffect(() => {
    let disposed = false;

    async function boot(): Promise<void> {
      setError(null);
      setInitializing(true);

      try {
        const intent = await createPaymentIntent(prescriptionId, priority);
        if (disposed) return;

        setClientSecret(intent.client_secret);
        setPaymentIntentId(intent.payment_intent_id);
        setAmountCents(intent.amount_cents);
        setCurrency(intent.currency);
        onIntentReady?.({
          amountCents: intent.amount_cents,
          currency: intent.currency,
        });

        if (!intent.publishable_key) {
          throw new Error('Stripe n’est pas configuré (clé publique manquante).');
        }

        await ensureStripeJs();
        if (disposed) return;
        const g = window as PatientConsoleWindow;
        if (typeof g.Stripe !== 'function') {
          throw new Error('Stripe.js indisponible.');
        }
        if (!mountRef.current) {
          throw new Error('Zone de paiement introuvable.');
        }

        stripeRef.current = stripeRef.current || g.Stripe(intent.publishable_key);
        const elements = stripeRef.current.elements();

        if (cardRef.current) {
          try {
            cardRef.current.destroy();
          } catch {
            // ignore destroy failure
          }
          cardRef.current = null;
        }

        const card = elements.create('card');
        card.mount(mountRef.current);
        cardRef.current = card;
      } catch (err) {
        if (!disposed) {
          setError(err instanceof Error ? err.message : 'Erreur initialisation paiement');
        }
      } finally {
        if (!disposed) {
          setInitializing(false);
        }
      }
    }

    void boot();

    return () => {
      disposed = true;
      if (cardRef.current) {
        try {
          cardRef.current.destroy();
        } catch {
          // ignore destroy failure
        }
        cardRef.current = null;
      }
    };
  }, [onIntentReady, prescriptionId, priority]);

  const handleSubmit = async (): Promise<void> => {
    setError(null);

    if (!clientSecret) {
      setError('Client secret manquant.');
      return;
    }
    if (!stripeRef.current || !cardRef.current) {
      setError('Stripe n’est pas prêt.');
      return;
    }

    setSubmitting(true);
    try {
      const paymentResult = await stripeRef.current.confirmCardPayment(clientSecret, {
        payment_method: {
          card: cardRef.current,
          billing_details: {
            name: cfg.currentUser?.displayName,
            email: cfg.currentUser?.email,
          },
        },
      });

      if (paymentResult?.error) {
        throw new Error(paymentResult.error.message || 'Paiement refusé.');
      }

      const paymentId = paymentResult?.paymentIntent?.id || paymentIntentId;
      if (!paymentId) {
        throw new Error('PaymentIntent invalide.');
      }

      await confirmPaymentIntent(prescriptionId, paymentId);
      onPaid();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur paiement');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="sp-card sp-payment-card">
      <div className="sp-section__title">Paiement sécurisé</div>
      <div className="sp-payment-card__summary">
        Montant : <span className="sp-text-strong">{formatMoney(amountCents, currency)}</span>
      </div>
      <div className="sp-payment-card__notice">
        Zéro frais si refus médical. (Autorisation uniquement)
      </div>

      {error ? (
        <div className="sp-inline-note">
          <Notice variant="error">{error}</Notice>
        </div>
      ) : null}

      <div className="sp-payment-card__mount">
        {initializing ? (
          <div className="sp-loading-row">
            <Spinner />
            <span>Initialisation…</span>
          </div>
        ) : (
          <div ref={mountRef} />
        )}
      </div>

      <div className="sp-payment-card__footer">
        <Button type="button" onClick={handleSubmit} disabled={initializing || submitting}>
          {submitting ? <Spinner /> : amountCents ? `Payer ${formatMoney(amountCents, currency)}` : 'Payer la demande'}
        </Button>
      </div>
    </div>
  );
}

function PdfCard({ status, pdf }: { status: string; pdf: PdfState | null }) {
  const normalizedStatus = String(status || '').toLowerCase();
  if (normalizedStatus !== 'approved') return null;

  const pdfStatus = String(pdf?.status || '').toLowerCase();
  const downloadUrl = String(pdf?.download_url || '');
  const canDownload = Boolean(pdf?.can_download && downloadUrl);

  if (canDownload) {
    return (
      <div className="sp-alert sp-alert--success">
        <div className="sp-alert__title">Ordonnance</div>
        <div className="sp-alert__body">
          Votre ordonnance est prête. Le lien est sécurisé et régénéré automatiquement.
        </div>
        <div className="sp-inline-actions">
          <Button type="button" onClick={() => openPresignedPdf(downloadUrl)}>
            Télécharger mon ordonnance
          </Button>
          <ButtonLink href={downloadUrl} variant="secondary">
            Ouvrir le PDF
          </ButtonLink>
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

  if (pdfStatus === 'done' && !downloadUrl) {
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
  const [workspace, setWorkspace] = useState<'requests' | 'profile'>('requests');
  const [paymentPreview, setPaymentPreview] = useState<{ amountCents: number; currency: string } | null>(null);
  const [profileReady, setProfileReady] = useState(false);

  const paymentSectionRef = useRef<HTMLDivElement | null>(null);
  const profileHostRef = useRef<HTMLDivElement | null>(null);
  const profileRestoreRef = useRef<{ parent: HTMLElement | null; nextSibling: Node | null } | null>(null);


  const requestedId = useMemo(() => {
    try {
      const search = new URLSearchParams(window.location.search);
      const value = Number.parseInt(search.get('rx') || '', 10);
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }, []);

  const selectedSummary = useMemo(
    () => prescriptions.find((row) => Number(row.id) === Number(selectedId)) || null,
    [prescriptions, selectedId]
  );

  const profileComplete = useMemo(
    () => isPatientProfileComplete(cfg.patientProfile, cfg.currentUser),
    [cfg.currentUser, cfg.patientProfile]
  );

  const selectedStatus = normalizeStatusValue(detail?.status || selectedSummary?.status || '');
  const selectedPdf = selectedId ? pdfStates[selectedId] || null : null;
  const requestTitle = useMemo(
    () => buildPrescriptionTitle(detail?.primary_reason || selectedSummary?.primary_reason, detail?.created_at || selectedSummary?.created_at || ''),
    [detail?.created_at, detail?.primary_reason, selectedSummary?.created_at, selectedSummary?.primary_reason]
  );
  const requestDetails = detail?.request_details || [];
  const messagingLocked = detail ? isReadOnlyThreadStatus(detail.status) : false;

  const fileIndex = useMemo(() => {
    const index: Record<number, PrescriptionFile> = {};
    (detail?.files || []).forEach((file) => {
      index[file.id] = file;
    });
    return index;
  }, [detail?.files]);

  const refreshList = useCallback(async () => {
    setError(null);
    setApiBanner(null);
    setListLoading(true);
    try {
      const payload = await listPatientPrescriptions();
      if (!Array.isArray(payload)) {
        debugApiPayload(payload, {
          endpoint: '/prescriptions',
          expected: 'array',
          received_type: typeof payload,
        });
        const banner = resolveBannerFromPayload(payload);
        if (banner) {
          setApiBanner(banner);
        } else {
          setError('Réponse API inattendue pour la liste des demandes. Consultez la console pour le payload brut.');
        }
        setPrescriptions([]);
        setSelectedId(null);
        return;
      }

      const rows = normalizePrescriptionSummaryArray(payload);
      setPrescriptions((current) => rows.map((row) => {
        const existing = current.find((item) => Number(item.id) === Number(row.id));
        return {
          ...row,
          primary_reason: row.primary_reason || existing?.primary_reason,
        };
      }));
      setSelectedId((current) => {
        if (current && rows.some((row) => Number(row.id) === Number(current))) {
          return current;
        }
        if (requestedId && rows.some((row) => Number(row.id) === Number(requestedId))) {
          return requestedId;
        }
        return rows.length > 0 ? Number(rows[0].id) : null;
      });
    } catch (err) {
      const banner = resolveBannerFromError(err);
      if (banner) {
        setApiBanner(banner);
        setError(null);
      } else {
        setError(resolveUnknownErrorMessage(err, 'Erreur chargement'));
      }
      setPrescriptions([]);
      setSelectedId(null);
    } finally {
      setListLoading(false);
    }
  }, [requestedId]);

  const loadDetail = useCallback(async (id: number) => {
    setError(null);
    setApiBanner(null);
    setDetailLoading(true);
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
        if (banner) {
          setApiBanner(banner);
          setError(null);
        } else {
          setError('Réponse API inattendue sur le détail patient. Consultez la console pour le payload brut.');
        }
        setDetail(null);
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
        };
      }));
    } catch (err) {
      const banner = resolveBannerFromError(err);
      if (banner) {
        setApiBanner(banner);
        setError(null);
      } else {
        setError(resolveUnknownErrorMessage(err, 'Erreur chargement'));
      }
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const loadMessages = useCallback(async (id: number, silent = false) => {
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
        if (banner) {
          setApiBanner(banner);
          if (!silent) {
            setError(null);
          }
        } else if (!silent) {
          setError('Réponse API inattendue sur la messagerie. Consultez la console pour le payload brut.');
        }
        setMessages([]);
        return;
      }

      const normalizedMessages = normalizeMessageArray(messagesArray).filter((message) => {
        const normalizedRole = normalizeMessageAuthorRole(message.author_role);
        if (normalizedRole === 'PATIENT' || normalizedRole === 'DOCTOR') {
          return true;
        }

        return String(message.body || '').trim() !== '' || (Array.isArray(message.attachments) && message.attachments.length > 0);
      });

      setMessages(normalizedMessages);
    } catch (err) {
      const banner = resolveBannerFromError(err);
      if (banner) {
        setApiBanner(banner);
        if (!silent) {
          setError(null);
        }
      } else if (!silent) {
        setError(resolveUnknownErrorMessage(err, 'Erreur messagerie'));
      }
      setMessages([]);
    } finally {
      if (!silent) {
        setMessagesLoading(false);
      }
    }
  }, []);

  const loadPdfStatus = useCallback(async (id: number, silent = false) => {
    try {
      const payload = await getPatientPdfStatus(id);
      const banner = resolveBannerFromPayload(payload);
      if (banner) {
        setApiBanner(banner);
        if (!silent) {
          setError(null);
        }
      }
      setPdfStates((current) => ({
        ...current,
        [id]: normalizePdfState(payload),
      }));
    } catch (err) {
      const banner = resolveBannerFromError(err);
      if (banner) {
        setApiBanner(banner);
        if (!silent) {
          setError(null);
        }
      } else if (!silent) {
        setError(resolveUnknownErrorMessage(err, 'Erreur document'));
      }
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
  }, []);

  const refreshAll = useCallback(async () => {
    await refreshList();
    if (selectedId) {
      await Promise.all([
        loadDetail(selectedId),
        loadMessages(selectedId, true),
        selectedStatus === 'approved' ? loadPdfStatus(selectedId, true) : Promise.resolve(),
      ]);
    }
  }, [loadDetail, loadMessages, loadPdfStatus, refreshList, selectedId, selectedStatus]);

  useEffect(() => {
    if (!isLoggedIn) return;
    void refreshList();
  }, [isLoggedIn, refreshList]);

  useEffect(() => {
    if (!isLoggedIn) return;
    if (!selectedId) {
      setDetail(null);
      setMessages([]);
      return;
    }

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
    if (!selectedId || !isPaymentPendingStatus(selectedStatus)) {
      setPaymentPreview(null);
    }
  }, [selectedId, selectedStatus]);

  const openSelectedPrescriptionPdf = useCallback(() => {
    const downloadUrl = String(selectedPdf?.download_url || '');
    if (!downloadUrl) {
      return;
    }

    openPresignedPdf(downloadUrl);
  }, [selectedPdf?.download_url]);

  const scrollToPayment = useCallback(() => {
    paymentSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const syncExternalProfileRoot = useCallback((): boolean => {
    const profileRoot = document.getElementById('sp-patient-profile-root');
    if (!(profileRoot instanceof HTMLElement)) {
      setProfileReady(false);
      return false;
    }

    if (!profileRestoreRef.current) {
      profileRestoreRef.current = {
        parent: profileRoot.parentElement,
        nextSibling: profileRoot.nextSibling,
      };
    }

    if (workspace === 'profile' && profileHostRef.current) {
      if (profileRoot.parentElement !== profileHostRef.current) {
        profileHostRef.current.appendChild(profileRoot);
      }
      profileRoot.hidden = false;
      setProfileReady(true);
      return true;
    }

    const restoreTarget = profileRestoreRef.current;
    if (restoreTarget?.parent && profileRoot.parentElement !== restoreTarget.parent) {
      if (restoreTarget.nextSibling && restoreTarget.nextSibling.parentNode === restoreTarget.parent) {
        restoreTarget.parent.insertBefore(profileRoot, restoreTarget.nextSibling);
      } else {
        restoreTarget.parent.appendChild(profileRoot);
      }
    }

    profileRoot.hidden = true;
    setProfileReady(true);
    return true;
  }, [workspace]);

  useEffect(() => {
    let disposed = false;
    let timer = 0;

    setProfileReady(false);

    const attemptSync = (remainingAttempts: number): void => {
      if (disposed) {
        return;
      }

      if (syncExternalProfileRoot() || remainingAttempts <= 0) {
        return;
      }

      timer = window.setTimeout(() => attemptSync(remainingAttempts - 1), 250);
    };

    attemptSync(40);

    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [syncExternalProfileRoot]);

  useEffect(() => () => {
    const profileRoot = document.getElementById('sp-patient-profile-root');
    const restoreTarget = profileRestoreRef.current;

    if (!(profileRoot instanceof HTMLElement)) {
      return;
    }

    if (restoreTarget?.parent && profileRoot.parentElement !== restoreTarget.parent) {
      if (restoreTarget.nextSibling && restoreTarget.nextSibling.parentNode === restoreTarget.parent) {
        restoreTarget.parent.insertBefore(profileRoot, restoreTarget.nextSibling);
      } else {
        restoreTarget.parent.appendChild(profileRoot);
      }
    }

    profileRoot.hidden = false;
  }, []);

  const registerUploadedFiles = useCallback((uploadedFiles: UploadedFile[]) => {
    if (!uploadedFiles || uploadedFiles.length === 0) return;

    setDetail((current) => {
      if (!current) return current;

      const nextFiles = new Map<number, PrescriptionFile>();
      (current.files || []).forEach((file) => {
        nextFiles.set(file.id, file);
      });
      uploadedFiles.forEach((file) => {
        nextFiles.set(file.id, file);
      });

      return {
        ...current,
        files: Array.from(nextFiles.values()),
      };
    });
  }, []);

  const handleMessageCreated = useCallback(
    async (message: MessageItem): Promise<void> => {
      setMessages((current) => mergeNormalizedMessages(current, [message]));
      await refreshList();
    },
    [refreshList]
  );

  const handleMessageAttachmentDownload = useCallback(
    async (attachmentId: number): Promise<void> => {
      const file = fileIndex[attachmentId];
      const filename = file ? file.original_name : `Fichier #${attachmentId}`;
      const fileUrl = file ? file.download_url : `${cfg.restBase.replace(/\/$/, '')}/files/${attachmentId}/download`;
      await downloadProtectedFile(fileUrl, filename);
    },
    [cfg.restBase, fileIndex]
  );

  if (!isLoggedIn) {
    return (
      <div className="sp-page-shell sp-page-shell--narrow sp-app-theme">
        <Notice variant="warning">Connexion requise. Merci de vous connecter pour accéder à votre espace patient.</Notice>
      </div>
    );
  }

  return (
    <div className="sp-page-shell sp-app-theme sp-app-container sp-patient-console">
      <div className="sp-page-header sp-app-header sp-app-header--compact">
        <div className="sp-page-heading">
          <div className="sp-page-title">Espace patient</div>
          <div className="sp-page-subtitle">Suivi de vos demandes et échanges médicaux sécurisés.</div>
        </div>

        <div className="sp-page-actions">
          <Button
            type="button" 
            variant="secondary"
            onClick={() => void refreshAll()}
            disabled={listLoading || detailLoading || messagesLoading}
          >
            {listLoading || detailLoading || messagesLoading ? <Spinner /> : 'Actualiser'}
          </Button>
        </div>
      </div>

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
          {!profileComplete ? <span className="sp-patient-console__workspace-badge">À compléter</span> : null}
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
            <div ref={profileHostRef} className="sp-patient-console__profile-host" />
            {!profileReady ? <div className="sp-empty-note">Chargement du profil…</div> : null}
          </div>
        </section>
      ) : (
        <div
          id="sp-workspace-panel-requests"
          className="sp-console-grid"
          role="tabpanel"
          aria-labelledby="sp-workspace-tab-requests"
        >
          <aside className="sp-console-grid__sidebar">
            <div className="sp-panel">
              <div className="sp-panel__header">
                <div className="sp-panel__title">Mes demandes</div>
              </div>
              <div className="sp-panel__body">
                {prescriptions.length === 0 ? (
                  <div className="sp-panel__empty">{listLoading ? 'Chargement…' : 'Aucune demande.'}</div>
                ) : (
                  <div className="sp-list">
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

          <section className="sp-console-grid__content">
            <div className="sp-panel">
              <div className="sp-panel__body">
                {!selectedId ? <div className="sp-panel__empty">Sélectionnez une demande à gauche.</div> : null}

                {selectedId && detailLoading ? (
                  <div className="sp-loading-row">
                    <Spinner />
                    <span>Chargement…</span>
                  </div>
                ) : null}

                {selectedId && detail ? (
                  <div className="sp-detail-stack">
                    <HeroBanner
                      title={requestTitle}
                      status={detail.status}
                      createdAt={detail.created_at || selectedSummary?.created_at || ''}
                      pdf={selectedPdf}
                      paymentPreview={paymentPreview}
                      decisionReason={detail.decision_reason}
                      onDownloadPrescription={openSelectedPrescriptionPdf}
                      onScrollToPayment={scrollToPayment}
                    />

                    <RequestDetailsDisclosure fields={requestDetails} />

                    {isPaymentPendingStatus(detail.status) ? (
                      <div ref={paymentSectionRef} className="sp-section">
                        <PaymentCard
                          prescriptionId={detail.id}
                          priority={(selectedSummary?.priority || detail.priority || '').toLowerCase() === 'express' ? 'express' : 'standard'}
                          onIntentReady={setPaymentPreview}
                          onPaid={() => {
                            setPaymentPreview(null);
                            void loadDetail(detail.id);
                            void refreshList();
                          }}
                        />
                      </div>
                    ) : null}

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
                      <MessageThread
                        prescriptionId={detail.id}
                        viewerRole="PATIENT"
                        currentUserRoles={cfg.currentUser?.roles}
                        title="Échanges avec le médecin"
                        subtitle="Messagerie sécurisée associée à votre dossier."
                        loading={messagesLoading}
                        emptyText="Espace d’échange sécurisé avec le médecin. Vous pouvez envoyer un message à tout moment."
                        messages={messages}
                        fileIndex={fileIndex}
                        onDownloadFile={handleMessageAttachmentDownload}
                        canCompose={!messagingLocked}
                        readOnlyNotice="Ce dossier est clôturé. Veuillez initier une nouvelle demande."
                        postMessage={postPatientMessage}
                        onMessageCreated={handleMessageCreated}
                        onSurfaceError={setError}
                      />
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
