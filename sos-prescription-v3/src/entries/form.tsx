// src/entries/form.tsx · V8.6.0
import '../runtime/installFetchPatch';
import '../styles/medical-grade-aura.css';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import PatientConsole from '../components/PatientConsole';
import StripePaymentModule, { type StripePaymentResolutionMeta, toMedicalGradePaymentErrorMessage } from '../components/payment/StripePaymentModule';
import { buildDraftFileManifest, buildDraftPayload, buildFinalizePayload } from './formTunnel/builders';
import { hydrateStoredDraftPayload } from './formTunnel/hydrators';
import type { ClinicalState, FlowType as TunnelFlowType, UIState, WorkflowState } from './formTunnel/types';
import { useDraftNetwork } from './formTunnel/useDraftNetwork';
import { useSubmissionNetwork } from './formTunnel/useSubmissionNetwork';

type AppConfig = {
  restBase: string;
  restV4Base?: string;
  nonce: string;
  currentUser?: {
    id?: number;
    displayName?: string;
    email?: string;
  };
  notices?: {
    enabled_form?: boolean;
    title?: string;
    items_text?: string;
  };
  patientProfile?: {
    fullname?: string;
    birthdate_fr?: string;
    note?: string;
    medical_notes?: string;
    medicalNotes?: string;
  };
  compliance?: {
    consent_required?: boolean;
    cgu_url?: string;
    privacy_url?: string;
    cgu_version?: string;
    privacy_version?: string;
  };
  turnstile?: {
    enabled?: boolean;
    siteKey?: string;
  };
  urls?: {
    patientPortal?: string;
  };
};

type PricingConfig = {
  standard_cents: number;
  express_cents: number;
  currency: string;
  standard_eta_minutes?: number | null;
  express_eta_minutes?: number | null;
};

type PaymentsConfig = {
  enabled: boolean;
  publishable_key?: string;
  provider?: string;
  capture_method?: string;
};

type PaymentIntentResponse = {
  provider?: string;
  payment_intent_id: string | null;
  client_secret: string | null;
  status?: string | null;
  amount_cents?: number | null;
  currency?: string | null;
  priority?: string | null;
  publishable_key?: string;
  capture_method?: string | null;
};

type FlowType = 'ro_proof' | 'depannage_no_proof';
type Stage = 'choose' | 'form' | 'priority_selection' | 'payment_auth' | 'done';
type FrequencyUnit = 'jour' | 'semaine';
type DurationUnit = 'jour' | 'mois' | 'semaine';

type Schedule = {
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

type MedEditorState = {
  detailId: number;
  index: number;
  medicationName: string;
  draft: Schedule;
};

const AUTO_SCHEDULE_STEP_MINUTES = 5;

type MedicationSearchResult = {
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

type MedicationItem = {
  cis?: string;
  cip13?: string | null;
  label: string;
  schedule: Schedule;
  quantite?: string;
};

type LocalUpload = {
  id: string;
  file: File;
  original_name: string;
  mime: string;
  mime_type: string;
  size_bytes: number;
  kind: 'PROOF';
  status: 'QUEUED' | 'READY';
};

type UploadedArtifact = {
  id: string;
  original_name: string;
  purpose?: string;
  mime?: string;
  mime_type?: string;
  size_bytes?: number;
  kind?: string;
  status?: string;
};

type SubmissionInitResponse = {
  submission_ref?: string;
};

type SubmissionResult = {
  id: number;
  uid: string;
  status: string;
  created_at?: string;
};

type DraftSaveResponse = {
  submission_ref?: string;
  expires_at?: string;
  expires_in?: number;
  sent?: boolean;
  redirect_to?: string;
  message?: string;
};

type StoredDraftPayload = {
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

type AnalyzeMedication = {
  label?: string;
  scheduleText?: string;
};

type ArtifactAnalysis = {
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

type SubmissionRefState = {
  ref: string | null;
};

type FormWindow = Window & {
  SosPrescription?: AppConfig;
  SOSPrescription?: AppConfig;
  __SosPrescriptionPublicFormRoot?: ReturnType<typeof createRoot>;
  __SosPrescriptionPatientRoot?: ReturnType<typeof createRoot>;
};

declare global {
  interface Window {
    __SosPrescriptionPublicFormRoot?: ReturnType<typeof createRoot>;
    __SosPrescriptionPatientRoot?: ReturnType<typeof createRoot>;
  }
}


function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

function Spinner({ className = '' }: { className?: string }) {
  return (
    <span
      className={cx('sp-app-spinner', className)}
      aria-label="Chargement"
    />
  );
}

function Notice({
  variant = 'info',
  children,
}: {
  variant?: 'info' | 'success' | 'warning' | 'error';
  children: React.ReactNode;
}) {
  return (
    <div className={cx('sp-app-notice', `sp-app-notice--${variant}`)}>
      {children}
    </div>
  );
}

function Button({
  variant = 'primary',
  className = '',
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
}) {
  const variantClass = variant === 'primary'
    ? 'sp-app-button--primary'
    : variant === 'danger'
      ? 'sp-app-button--danger'
      : variant === 'ghost'
        ? 'sp-app-button--ghost'
        : 'sp-app-button--secondary';

  return (
    <button className={cx('sp-app-button', variantClass, className)} {...props}>
      {children}
    </button>
  );
}

function TextInput({
  className = '',
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cx('sp-app-control', 'sp-app-input', className)}
      {...props}
    />
  );
}

function TextareaField({
  className = '',
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cx('sp-app-control', 'sp-app-textarea', className)}
      {...props}
    />
  );
}

type LucideIconProps = {
  className?: string;
};

function FileUpIcon({ className = '' }: LucideIconProps) {
  return (
    <svg className={cx('sp-lucide', className)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function FilePenIcon({ className = '' }: LucideIconProps) {
  return (
    <svg className={cx('sp-lucide', className)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
    </svg>
  );
}

function Clock2Icon({ className = '' }: LucideIconProps) {
  return (
    <svg className={cx('sp-lucide', className)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5v5l3 1.8" />
      <path d="M9 2.5h6" />
    </svg>
  );
}

function TimerIcon({ className = '' }: LucideIconProps) {
  return (
    <svg className={cx('sp-lucide', className)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 2h4" />
      <path d="M12 14v-4" />
      <path d="m15 5 1.6-1.6" />
      <path d="M12 22a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z" />
    </svg>
  );
}

function Settings2Icon({ className = '' }: LucideIconProps) {
  return (
    <svg className={cx('sp-lucide', className)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 17H5" />
      <path d="M19 7h-9" />
      <circle cx="17" cy="17" r="3" />
      <circle cx="7" cy="7" r="3" />
    </svg>
  );
}

function XIcon({ className = '' }: LucideIconProps) {
  return (
    <svg className={cx('sp-lucide', className)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function getConfigOrThrow(): AppConfig {
  const formWindow = window as FormWindow;
  const cfg = (typeof window !== 'undefined' ? (formWindow.SosPrescription || formWindow.SOSPrescription) : null) || null;
  if (!cfg || typeof cfg.restBase !== 'string' || typeof cfg.nonce !== 'string') {
    throw new Error('Configuration SosPrescription introuvable (window.SosPrescription / window.SOSPrescription).');
  }
  return cfg;
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const raw = await response.text();
  let data: unknown = raw;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    // Keep raw text when JSON parsing fails.
  }
  return data;
}

async function sharedApi(path: string, init: RequestInit = {}, scope: 'form' | 'patient' | 'admin' = 'form'): Promise<unknown> {
  const cfg = getConfigOrThrow();
  const method = String(init.method || 'GET').toUpperCase();
  let url = String(cfg.restBase || '').replace(/\/$/, '') + path;

  if (method === 'GET') {
    try {
      const parsed = new URL(url, window.location.href);
      parsed.searchParams.set('_ts', String(Date.now()));
      url = parsed.toString();
    } catch {
      url += (url.includes('?') ? '&' : '?') + '_ts=' + String(Date.now());
    }
  }

  const headers = new Headers(init.headers || undefined);
  headers.set('X-WP-Nonce', cfg.nonce);
  headers.set('X-Sos-Scope', scope);

  if (method === 'GET') {
    headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    headers.set('Pragma', 'no-cache');
  }

  const response = await fetch(url, {
    ...init,
    method,
    headers,
    credentials: 'same-origin',
    cache: method === 'GET' ? 'no-store' : init.cache,
  });

  const data = await parseJsonResponse(response);

  if (!response.ok) {
    const message = data && typeof data === 'object' && 'message' in data && typeof (data as { message?: unknown }).message === 'string'
      ? String((data as { message?: string }).message)
      : data && typeof data === 'object' && 'code' in data && typeof (data as { code?: unknown }).code === 'string'
        ? String((data as { code?: string }).code)
        : 'Erreur API';
    throw new Error(message);
  }

  return data;
}

async function v4Api(path: string, init: RequestInit = {}, scope: 'form' | 'patient' | 'admin' = 'form'): Promise<unknown> {
  const cfg = getConfigOrThrow();
  const fallbackBase = String(cfg.restBase || '').replace(/\/sosprescription\/v1\/?$/, '/sosprescription/v4').trim();
  const restV4Base = typeof cfg.restV4Base === 'string' && cfg.restV4Base.trim() ? cfg.restV4Base.trim() : fallbackBase;
  if (!restV4Base) {
    throw new Error('Configuration REST V4 absente.');
  }

  const method = String(init.method || 'GET').toUpperCase();
  const url = restV4Base.replace(/\/$/, '') + path;
  const headers = new Headers(init.headers || undefined);
  headers.set('X-WP-Nonce', cfg.nonce);
  headers.set('X-Sos-Scope', scope);

  if (method === 'GET') {
    headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    headers.set('Pragma', 'no-cache');
  }

  const response = await fetch(url, {
    ...init,
    method,
    headers,
    credentials: 'same-origin',
    cache: method === 'GET' ? 'no-store' : init.cache,
  });

  const data = await parseJsonResponse(response);

  if (!response.ok) {
    const message = data && typeof data === 'object' && 'message' in data && typeof (data as { message?: unknown }).message === 'string'
      ? String((data as { message?: string }).message)
      : data && typeof data === 'object' && 'code' in data && typeof (data as { code?: unknown }).code === 'string'
        ? String((data as { code?: string }).code)
        : 'Erreur API';
    throw new Error(message);
  }

  return data;
}

async function v4PublicApi(path: string, init: RequestInit = {}, scope: 'form' | 'patient' | 'admin' = 'form'): Promise<unknown> {
  const cfg = getConfigOrThrow();
  const fallbackBase = String(cfg.restBase || '').replace(/\/sosprescription\/v1\/?$/, '/sosprescription/v4').trim();
  const restV4Base = typeof cfg.restV4Base === 'string' && cfg.restV4Base.trim() ? cfg.restV4Base.trim() : fallbackBase;
  if (!restV4Base) {
    throw new Error('Configuration REST V4 absente.');
  }

  const method = String(init.method || 'GET').toUpperCase();
  let url = restV4Base.replace(/\/$/, '') + path;

  if (method === 'GET') {
    try {
      const parsed = new URL(url, window.location.href);
      parsed.searchParams.set('_ts', String(Date.now()));
      url = parsed.toString();
    } catch {
      url += (url.includes('?') ? '&' : '?') + '_ts=' + String(Date.now());
    }
  }

  const headers = new Headers(init.headers || undefined);
  headers.set('X-Sos-Scope', scope);

  if (method === 'GET') {
    headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    headers.set('Pragma', 'no-cache');
  }

  const response = await fetch(url, {
    ...init,
    method,
    headers,
    credentials: 'omit',
    cache: method === 'GET' ? 'no-store' : init.cache,
  });

  const data = await parseJsonResponse(response);

  if (!response.ok) {
    const message = data && typeof data === 'object' && 'message' in data && typeof (data as { message?: unknown }).message === 'string'
      ? String((data as { message?: string }).message)
      : data && typeof data === 'object' && 'code' in data && typeof (data as { code?: unknown }).code === 'string'
        ? String((data as { code?: string }).code)
        : 'Erreur API';
    throw new Error(message);
  }

  return data;
}

async function searchMedicationsApi(query: string, limit = 20): Promise<unknown> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  return v4PublicApi(`/medications/search?${params.toString()}`, { method: 'GET' }, 'form');
}

async function getPricingApi(): Promise<PricingConfig | null> {
  const payload = await sharedApi('/pricing', { method: 'GET' }, 'form');
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const data = payload as Record<string, unknown>;
  const toIntegerOrNull = (value: unknown): number | null => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.trunc(numeric) : null;
  };

  return {
    standard_cents: typeof data.standard_cents === 'number' ? data.standard_cents : Number(data.standard_cents || 0),
    express_cents: typeof data.express_cents === 'number' ? data.express_cents : Number(data.express_cents || 0),
    currency: typeof data.currency === 'string' ? data.currency : 'EUR',
    standard_eta_minutes: toIntegerOrNull(data.standard_eta_minutes),
    express_eta_minutes: toIntegerOrNull(data.express_eta_minutes),
  };
}

async function getPaymentsConfigApi(): Promise<PaymentsConfig | null> {
  const payload = await sharedApi('/payments/config', { method: 'GET' }, 'form');
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const data = payload as Record<string, unknown>;
  return {
    enabled: Boolean(data.enabled),
    publishable_key: typeof data.publishable_key === 'string' ? data.publishable_key : '',
    provider: typeof data.provider === 'string' ? data.provider : 'stripe',
    capture_method: typeof data.capture_method === 'string' ? data.capture_method : 'manual',
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }

    const trimmed = value.trim();
    if (trimmed !== '') {
      return trimmed;
    }
  }

  return '';
}

function firstFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }

  return null;
}

function normalizePaymentIntentResponse(payload: unknown): PaymentIntentResponse {
  const root = asRecord(payload);
  const nestedCandidates: unknown[] = [
    root?.intent,
    root?.payment_intent,
    root?.paymentIntent,
    root?.data,
  ];

  let nested: Record<string, unknown> | null = null;
  for (const candidate of nestedCandidates) {
    const record = asRecord(candidate);
    if (record) {
      nested = record;
      break;
    }
  }

  return {
    provider: firstNonEmptyString(root?.provider, nested?.provider) || 'stripe',
    payment_intent_id: firstNonEmptyString(
      root?.payment_intent_id,
      root?.paymentIntentId,
      root?.id,
      nested?.payment_intent_id,
      nested?.paymentIntentId,
      nested?.id,
    ) || null,
    client_secret: firstNonEmptyString(
      root?.client_secret,
      root?.clientSecret,
      nested?.client_secret,
      nested?.clientSecret,
    ) || null,
    status: firstNonEmptyString(root?.status, nested?.status) || null,
    amount_cents: firstFiniteNumber(
      root?.amount_cents,
      root?.amount,
      nested?.amount_cents,
      nested?.amount,
    ),
    currency: firstNonEmptyString(root?.currency, nested?.currency) || null,
    priority: firstNonEmptyString(root?.priority, nested?.priority) || null,
    publishable_key: firstNonEmptyString(
      root?.publishable_key,
      root?.publishableKey,
      nested?.publishable_key,
      nested?.publishableKey,
    ),
    capture_method: firstNonEmptyString(
      root?.capture_method,
      root?.captureMethod,
      nested?.capture_method,
      nested?.captureMethod,
    ) || null,
  };
}

async function createPaymentIntentApi(id: number, priority: 'standard' | 'express'): Promise<PaymentIntentResponse> {
  const payload = await sharedApi(`/prescriptions/${id}/payment/intent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ priority }),
  }, 'form');

  return normalizePaymentIntentResponse(payload);
}

async function confirmPaymentIntentApi(id: number, paymentIntentId: string): Promise<unknown> {
  return sharedApi(`/prescriptions/${id}/payment/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payment_intent_id: paymentIntentId }),
  }, 'form');
}

async function createSubmissionApi(payload: Record<string, unknown>): Promise<SubmissionInitResponse> {
  return v4Api('/form/submissions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, 'form') as Promise<SubmissionInitResponse>;
}

async function saveSubmissionDraftApi(payload: Record<string, unknown>): Promise<DraftSaveResponse> {
  return v4Api('/submissions/draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, 'form') as Promise<DraftSaveResponse>;
}

async function loadSubmissionDraftApi(submissionRef: string): Promise<StoredDraftPayload> {
  const ref = String(submissionRef || '').trim();
  if (!ref) {
    throw new Error('Référence de brouillon manquante.');
  }

  return v4Api(`/submissions/draft/${encodeURIComponent(ref)}`, {
    method: 'GET',
  }, 'form') as Promise<StoredDraftPayload>;
}

async function submissionArtifactInitApi(submissionRef: string, payload: Record<string, unknown>): Promise<unknown> {
  const ref = String(submissionRef || '').trim();
  if (!ref) {
    throw new Error('Référence de soumission manquante.');
  }

  return v4Api(`/form/submissions/${encodeURIComponent(ref)}/artifacts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, 'form');
}

async function directSubmissionArtifactUpload(file: File, submissionRef: string, kind: 'PROOF' = 'PROOF'): Promise<UploadedArtifact> {
  const initPayload = {
    kind,
    original_name: file && file.name ? String(file.name) : 'upload.bin',
    mime_type: file && file.type ? String(file.type) : 'application/octet-stream',
    size_bytes: file && typeof file.size === 'number' ? file.size : 0,
  };

  const initResponse = await submissionArtifactInitApi(submissionRef, initPayload) as { upload?: { url?: string; method?: string; headers?: Record<string, string> }; artifact?: Partial<UploadedArtifact> };
  const upload = initResponse && typeof initResponse === 'object' ? initResponse.upload : null;
  if (!upload || !upload.url) {
    throw new Error('Ticket d’upload invalide');
  }

  const headers = new Headers(upload.headers || {});
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', initPayload.mime_type);
  }

  const response = await fetch(String(upload.url), {
    method: String(upload.method || 'PUT').toUpperCase(),
    headers,
    body: file,
    mode: 'cors',
    credentials: 'omit',
  });

  const data = await parseJsonResponse(response);
  if (!response.ok) {
    const message = data && typeof data === 'object' && 'message' in data && typeof (data as { message?: unknown }).message === 'string'
      ? String((data as { message?: string }).message)
      : data && typeof data === 'object' && 'code' in data && typeof (data as { code?: unknown }).code === 'string'
        ? String((data as { code?: string }).code)
        : 'Erreur upload';
    throw new Error(message);
  }

  const artifact = data && typeof data === 'object' && 'artifact' in data ? (data as { artifact?: Partial<UploadedArtifact> }).artifact : null;
  if (!artifact || !artifact.id) {
    throw new Error('Réponse artefact incomplète');
  }

  return {
    id: String(artifact.id),
    original_name: artifact.original_name || initPayload.original_name,
    purpose: 'evidence',
    mime: artifact.mime || artifact.mime_type || initPayload.mime_type,
    mime_type: artifact.mime_type || artifact.mime || initPayload.mime_type,
    size_bytes: typeof artifact.size_bytes === 'number' ? artifact.size_bytes : initPayload.size_bytes,
    kind: artifact.kind || kind,
    status: artifact.status || 'READY',
  };
}

async function analyzeArtifactApi(artifactId: string): Promise<ArtifactAnalysis> {
  const id = String(artifactId || '').trim();
  if (!id) {
    throw new Error('Identifiant d’artefact manquant.');
  }

  const cfg = getConfigOrThrow();
  const url = String(cfg.restBase || '').replace(/\/$/, '') + `/artifacts/${encodeURIComponent(id)}/analyze`;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeout = controller
    ? window.setTimeout(() => {
      try {
        controller.abort();
      } catch {
        // noop
      }
    }, 45000)
    : 0;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-WP-Nonce': cfg.nonce,
        'X-Sos-Scope': 'form',
      },
      credentials: 'same-origin',
      signal: controller ? controller.signal : undefined,
    });

    const data = await parseJsonResponse(response);
    if (!response.ok) {
      const message = data && typeof data === 'object' && 'message' in data && typeof (data as { message?: unknown }).message === 'string'
        ? String((data as { message?: string }).message)
        : data && typeof data === 'object' && 'code' in data && typeof (data as { code?: unknown }).code === 'string'
          ? String((data as { code?: string }).code)
          : 'Lecture du document impossible.';
      throw new Error(message);
    }

    if (data && typeof data === 'object' && 'analysis' in data && (data as { analysis?: unknown }).analysis && typeof (data as { analysis?: unknown }).analysis === 'object') {
      return {
        ...(data as Record<string, unknown>),
        ...((data as { analysis?: Record<string, unknown> }).analysis || {}),
      } as ArtifactAnalysis;
    }

    return (data || {}) as ArtifactAnalysis;
  } catch (error) {
    if (error && typeof error === 'object' && 'name' in error && (error as { name?: unknown }).name === 'AbortError') {
      throw new Error('Lecture du document impossible. Merci de réessayer avec un document plus lisible.');
    }
    throw error;
  } finally {
    if (timeout) {
      window.clearTimeout(timeout);
    }
  }
}

async function finalizeSubmissionApi(submissionRef: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ref = String(submissionRef || '').trim();
  if (!ref) {
    throw new Error('Référence de soumission manquante.');
  }

  return v4Api(`/form/submissions/${encodeURIComponent(ref)}/finalize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, 'form') as Promise<Record<string, unknown>>;
}

function frontendLog(event: string, level: 'debug' | 'info' | 'warning' | 'error' = 'info', meta: Record<string, unknown> = {}): void {
  try {
    const cfg = getConfigOrThrow();
    const restBase = String(cfg.restBase || '').replace(/\/$/, '');
    if (!restBase || !cfg.nonce || !window.fetch) {
      return;
    }

    void window.fetch(restBase + '/logs/frontend', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-WP-Nonce': cfg.nonce,
      },
      body: JSON.stringify({
        shortcode: 'sosprescription_form',
        event,
        level,
        meta,
      }),
      keepalive: true,
    }).catch(() => {
      // noop
    });
  } catch {
    // noop
  }
}

function buildCurrentFormRedirectUrl(): string {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('resume_draft');
    return url.toString();
  } catch {
    return window.location.href;
  }
}

function resolveResumeDraftRefFromUrl(): string | null {
  try {
    const raw = new URLSearchParams(window.location.search).get('resume_draft');
    const normalized = String(raw || '').trim();
    return /^[A-Za-z0-9_-]{8,128}$/.test(normalized) ? normalized : null;
  } catch {
    return null;
  }
}

const STICKY_EMAIL_STORAGE_KEY = 'sospatient_email_cache';
const STICKY_EMAIL_URL_PARAM_KEYS = ['email', 'patient_email', 'draft_email'];

function normalizeKnownEmailValue(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return isEmailLikeValue(normalized) ? normalized : null;
}

function resolveKnownEmailFromUrl(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    for (const key of STICKY_EMAIL_URL_PARAM_KEYS) {
      const normalized = normalizeKnownEmailValue(params.get(key));
      if (normalized) {
        return normalized;
      }
    }
  } catch {
    // noop
  }

  return null;
}

function readKnownEmailFromBrowserStorage(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const localValue = normalizeKnownEmailValue(window.localStorage?.getItem(STICKY_EMAIL_STORAGE_KEY));
    if (localValue) {
      return localValue;
    }
  } catch {
    // noop
  }

  try {
    const sessionValue = normalizeKnownEmailValue(window.sessionStorage?.getItem(STICKY_EMAIL_STORAGE_KEY));
    if (sessionValue) {
      return sessionValue;
    }
  } catch {
    // noop
  }

  return null;
}

function writeKnownEmailToBrowserStorage(value: unknown): void {
  if (typeof window === 'undefined') {
    return;
  }

  const normalized = normalizeKnownEmailValue(value);

  try {
    if (normalized) {
      window.localStorage?.setItem(STICKY_EMAIL_STORAGE_KEY, normalized);
    } else {
      window.localStorage?.removeItem(STICKY_EMAIL_STORAGE_KEY);
    }
  } catch {
    // noop
  }

  try {
    if (normalized) {
      window.sessionStorage?.setItem(STICKY_EMAIL_STORAGE_KEY, normalized);
    } else {
      window.sessionStorage?.removeItem(STICKY_EMAIL_STORAGE_KEY);
    }
  } catch {
    // noop
  }
}

function resolveKnownPatientEmail(config: AppConfig): string | null {
  const fromUrl = resolveKnownEmailFromUrl();
  if (fromUrl) {
    return fromUrl;
  }

  const fromStorage = readKnownEmailFromBrowserStorage();
  if (fromStorage) {
    return fromStorage;
  }

  const fromConfig = normalizeKnownEmailValue(config.currentUser?.email);
  if (fromConfig) {
    return fromConfig;
  }

  const formWindow = window as FormWindow;
  return normalizeKnownEmailValue(
    formWindow.SosPrescription?.currentUser?.email
    || formWindow.SOSPrescription?.currentUser?.email,
  );
}


function shouldClearAppStorageKey(key: string): boolean {
  const normalized = String(key || '').trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return normalized.startsWith('sp_')
    || normalized.startsWith('sp-')
    || normalized.startsWith('sp:')
    || normalized.startsWith('sosprescription')
    || normalized.startsWith('sos-prescription')
    || normalized.startsWith('medlab')
    || normalized.startsWith('ml_')
    || normalized.includes('prescription')
    || normalized.includes('submission')
    || normalized.includes('draft');
}

function clearBrowserStorageArea(storage: Storage | null | undefined): void {
  if (!storage) {
    return;
  }

  const keysToRemove: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (typeof key === 'string' && shouldClearAppStorageKey(key)) {
      keysToRemove.push(key);
    }
  }

  keysToRemove.forEach((key) => {
    try {
      storage.removeItem(key);
    } catch {
      // noop
    }
  });
}

function clearAppBrowserStateStorage(): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    clearBrowserStorageArea(window.localStorage);
  } catch {
    // noop
  }

  try {
    clearBrowserStorageArea(window.sessionStorage);
  } catch {
    // noop
  }

  try {
    if (typeof window.name === 'string' && shouldClearAppStorageKey(window.name)) {
      window.name = '';
    }
  } catch {
    // noop
  }
}

function resolveFlowFromUrl(): FlowType | null {
  try {
    const raw = new URLSearchParams(window.location.search).get('type');
    const normalized = String(raw || '').trim().toLowerCase();
    if (normalized === 'standard' || normalized === 'renouvellement' || normalized === 'renewal' || normalized === 'ro_proof') {
      return 'ro_proof';
    }
    if (normalized === 'depannage-sos' || normalized === 'depannage_no_proof' || normalized === 'depannage' || normalized === 'sos') {
      return 'depannage_no_proof';
    }
    return null;
  } catch {
    return null;
  }
}

function resolveRequestedStepFromUrl(): number | null {
  try {
    const raw = new URLSearchParams(window.location.search).get('step');
    const step = Number.parseInt(String(raw || '').trim(), 10);
    return Number.isFinite(step) && step > 0 ? step : null;
  } catch {
    return null;
  }
}

function isEmailLikeValue(value: unknown): boolean {
  const normalized = String(value ?? '').trim();
  return normalized !== '' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
}

function safePatientNameValue(value: unknown): string {
  const normalized = String(value ?? '').trim();
  return normalized !== '' && !isEmailLikeValue(normalized) ? normalized : '';
}

type PatientProfileSnapshot = {
  fullName: string;
  birthdate: string;
  medicalNotes: string;
};

function resolveStrictPatientProfileFullName(config: AppConfig): string {
  return safePatientNameValue(config.patientProfile?.fullname || '');
}

function resolvePatientProfileSnapshotFromSource(source: Record<string, unknown> | null | undefined): PatientProfileSnapshot {
  const joinedName = [
    firstNonEmptyString(source?.first_name, source?.firstName),
    firstNonEmptyString(source?.last_name, source?.lastName),
  ].filter(Boolean).join(' ');

  return {
    fullName: safePatientNameValue(firstNonEmptyString(source?.fullname, source?.fullName, joinedName)),
    birthdate: firstNonEmptyString(source?.birthdate_fr, source?.birthdateFr, source?.birthdate),
    medicalNotes: firstNonEmptyString(source?.note, source?.medical_notes, source?.medicalNotes),
  };
}

function resolvePatientProfileSnapshot(config: AppConfig | null | undefined): PatientProfileSnapshot {
  return resolvePatientProfileSnapshotFromSource(
    config?.patientProfile && typeof config.patientProfile === 'object'
      ? config.patientProfile as unknown as Record<string, unknown>
      : null,
  );
}

function resolveLatestPatientProfileSnapshot(fallbackConfig: AppConfig): PatientProfileSnapshot {
  try {
    return resolvePatientProfileSnapshot(getConfigOrThrow());
  } catch {
    return resolvePatientProfileSnapshot(fallbackConfig);
  }
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

function formatBirthdateInput(value: string): string {
  const digits = String(value || '').replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 2) {
    return digits;
  }
  if (digits.length <= 4) {
    return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  }
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}

function toIsoBirthdate(value: string): string | null {
  const match = /^([0-3]\d)\/([01]\d)\/(\d{4})$/.exec(String(value || '').trim());
  if (!match) {
    return null;
  }

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }

  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function ageFromIsoBirthdate(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const birth = new Date(Date.UTC(year, month - 1, day));
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  if (birth.getTime() > today.getTime()) {
    return null;
  }

  const dayMs = 24 * 60 * 60 * 1000;
  const ageDays = Math.floor((today.getTime() - birth.getTime()) / dayMs);
  if (ageDays < 28) {
    return `${ageDays} jour${ageDays > 1 ? 's' : ''}`;
  }

  let years = today.getUTCFullYear() - birth.getUTCFullYear();
  let months = today.getUTCMonth() - birth.getUTCMonth();
  let days = today.getUTCDate() - birth.getUTCDate();

  if (days < 0) {
    const previousMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
    days += previousMonth.getUTCDate();
    months -= 1;
  }

  if (months < 0) {
    months += 12;
    years -= 1;
  }

  const totalMonths = years * 12 + months;
  if (totalMonths < 24) {
    return `${Math.max(1, totalMonths)} mois`;
  }

  if (years < 18) {
    return `${years} an${years > 1 ? 's' : ''}${months > 0 ? ` ${months} mois` : ''}`;
  }

  return `${years} an${years > 1 ? 's' : ''}`;
}

function ageLabelFromBirthdate(value: string): string {
  const iso = toIsoBirthdate(value);
  return (iso && ageFromIsoBirthdate(iso)) || '';
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = Number.parseInt(String(value ?? ''), 10);
  if (Number.isNaN(numeric)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, numeric));
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function isTimeString(value: string): boolean {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(value);
}

function parseTimeToMinutes(value: string): number | null {
  if (!isTimeString(value)) {
    return null;
  }

  const [hours, minutes] = value.split(':');
  return Number.parseInt(hours, 10) * 60 + Number.parseInt(minutes, 10);
}

function formatMinutesToTime(value: number): string {
  let minutes = Math.round(value);
  if (!Number.isFinite(minutes)) {
    minutes = 0;
  }
  minutes = Math.max(0, Math.min(23 * 60 + 59, minutes));

  const hours = Math.floor(minutes / 60);
  const remain = minutes % 60;
  return `${pad2(hours)}:${pad2(remain)}`;
}

function roundToStep(value: number, step: number): number {
  const normalizedStep = Math.max(1, Math.floor(step));
  return Math.round(value / normalizedStep) * normalizedStep;
}

function fillArray(values: string[] | undefined, size: number, fallback: string): string[] {
  const next = Array.isArray(values) ? values.map((value) => String(value ?? '')) : [];
  if (next.length > size) {
    return next.slice(0, size);
  }
  while (next.length < size) {
    next.push(fallback);
  }
  return next;
}

function distributeTimes(count: number, start: string, end: string): {
  times: string[];
  start: string;
  end: string;
  warnings: string[];
  collisionResolved: boolean;
} {
  const warnings: string[] = [];
  const step = AUTO_SCHEDULE_STEP_MINUTES;
  const startMinutes = parseTimeToMinutes(start) ?? 8 * 60;
  let endMinutes = parseTimeToMinutes(end) ?? 20 * 60;

  if (endMinutes <= startMinutes) {
    endMinutes = Math.min(startMinutes + 60, 23 * 60 + 55);
    warnings.push('Fenêtre de prise invalide : heure de fin ajustée.');
  }

  const windowDuration = endMinutes - startMinutes;
  if (count <= 1) {
    const only = formatMinutesToTime(roundToStep(startMinutes, step));
    const finalEnd = formatMinutesToTime(roundToStep(endMinutes, step));
    return {
      times: [only],
      start: only,
      end: finalEnd,
      warnings,
      collisionResolved: false,
    };
  }

  if (windowDuration < (count - 1) * step) {
    warnings.push('Fenêtre trop courte pour répartir correctement.');
  }
  if (startMinutes > 18 * 60 && count > 1) {
    warnings.push('Première prise tardive : prises rapprochées.');
  }

  let collisionResolved = false;
  const gap = windowDuration / (count - 1);
  const points: number[] = [];
  for (let index = 0; index < count; index += 1) {
    let point = startMinutes + index * gap;
    if (index === 0) {
      point = startMinutes;
    }
    if (index === count - 1) {
      point = endMinutes;
    }
    let rounded = roundToStep(point, step);
    rounded = Math.max(startMinutes, Math.min(endMinutes, rounded));
    points.push(rounded);
  }

  for (let index = 1; index < count; index += 1) {
    if (points[index] <= points[index - 1]) {
      collisionResolved = true;
      points[index] = points[index - 1] + step;
    }
  }

  if (points[count - 1] > endMinutes) {
    collisionResolved = true;
    points[count - 1] = roundToStep(endMinutes, step);
    for (let index = count - 2; index >= 0; index -= 1) {
      if (points[index] >= points[index + 1]) {
        points[index] = points[index + 1] - step;
      }
    }
    if (points[0] < startMinutes) {
      warnings.push('Horaires trop rapprochés : vérifier la posologie.');
      points[0] = roundToStep(startMinutes, step);
      for (let index = 1; index < count; index += 1) {
        points[index] = Math.max(points[index], points[index - 1]);
      }
    }
  }

  let minGap = Number.POSITIVE_INFINITY;
  for (let index = 1; index < count; index += 1) {
    minGap = Math.min(minGap, points[index] - points[index - 1]);
  }
  if (count >= 4 && Number.isFinite(minGap) && minGap < 60) {
    warnings.push('Horaires rapprochés : vérifier la posologie.');
  }

  const times = points.map(formatMinutesToTime);
  return {
    times,
    start: times[0],
    end: times[times.length - 1],
    warnings,
    collisionResolved,
  };
}

function normalizeSchedule(value: Partial<Schedule> | null | undefined): Schedule {
  const freqUnit: FrequencyUnit = value?.freqUnit === 'semaine' ? 'semaine' : 'jour';
  const maxCount = freqUnit === 'jour' ? 6 : 12;
  const nb = clampInt(value?.nb, 1, maxCount, 1);
  const durationVal = clampInt(value?.durationVal, 1, 3650, 5);
  const durationUnit: DurationUnit = value?.durationUnit === 'mois'
    ? 'mois'
    : value?.durationUnit === 'semaine'
      ? 'semaine'
      : 'jour';
  const autoTimesEnabled = value?.autoTimesEnabled !== false;
  const start = typeof value?.start === 'string' ? value.start : typeof value?.times?.[0] === 'string' ? value.times[0] : '08:00';
  const end = typeof value?.end === 'string' ? value.end : typeof value?.times?.[value?.times?.length ? value.times.length - 1 : 0] === 'string' ? value.times[value.times.length - 1] : '20:00';
  const safeStart = isTimeString(start) ? start : '08:00';
  const safeEnd = isTimeString(end) ? end : '20:00';

  let times = fillArray(value?.times, nb, '');
  const doses = fillArray(value?.doses, nb, '1');

  if (autoTimesEnabled && freqUnit === 'jour') {
    const auto = distributeTimes(nb, safeStart, safeEnd);
    times = auto.times;
    return {
      nb,
      freqUnit,
      durationVal,
      durationUnit,
      times,
      doses,
      note: typeof value?.note === 'string' ? value.note : '',
      autoTimesEnabled: true,
      start: auto.start,
      end: auto.end,
    };
  }

  return {
    nb,
    freqUnit,
    durationVal,
    durationUnit,
    times,
    doses,
    note: typeof value?.note === 'string' ? value.note : '',
    autoTimesEnabled: autoTimesEnabled && freqUnit === 'jour',
    start: safeStart,
    end: safeEnd,
  };
}

function aiSafeText(value: unknown): string {
  return String(value || '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function aiNormalizeTime(value: unknown): string | null {
  const normalized = aiSafeText(value)
    .replace(/h/i, ':')
    .replace(/[^0-9:]/g, '');
  if (!normalized) {
    return null;
  }
  const match = normalized.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return null;
  }

  const hours = Math.max(0, Math.min(23, Number.parseInt(match[1], 10) || 0));
  const minutes = Math.max(0, Math.min(59, Number.parseInt(match[2], 10) || 0));
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function aiBuildScheduleFromText(value: unknown): Schedule {
  const text = aiSafeText(value);
  if (!text) {
    return normalizeSchedule({});
  }

  let count = 1;
  let freqUnit: FrequencyUnit = 'jour';
  let durationVal = 5;
  let durationUnit: DurationUnit = 'jour';

  const countMatch = text.match(/(\d+)\s*(?:fois?|prises?)\s*(?:par\s*|\/\s*)(jour|jours|semaine|semaines)/i)
    || text.match(/(\d+)\s*fois?\s*par\s*(jour|jours|semaine|semaines)/i);
  if (countMatch) {
    count = clampInt(countMatch[1], 1, /sem/i.test(countMatch[2]) ? 12 : 6, 1);
    freqUnit = /sem/i.test(countMatch[2]) ? 'semaine' : 'jour';
  }

  const durationMatch = text.match(/(?:pendant|durant|sur)\s*(\d+)\s*(jour|jours|mois|semaine|semaines)/i);
  if (durationMatch) {
    durationVal = clampInt(durationMatch[1], 1, 3650, 5);
    durationUnit = /mois/i.test(durationMatch[2])
      ? 'mois'
      : /sem/i.test(durationMatch[2])
        ? 'semaine'
        : 'jour';
  }

  const times: string[] = [];
  const doses: string[] = [];
  const explicitDoseTime = /([0-9]+(?:[.,][0-9]+)?)\s*@\s*([01]?\d[:h][0-5]\d)/gi;
  let explicitMatch: RegExpExecArray | null = null;
  while ((explicitMatch = explicitDoseTime.exec(text))) {
    const normalized = aiNormalizeTime(explicitMatch[2]);
    if (normalized) {
      times.push(normalized);
      doses.push(String(explicitMatch[1]).replace(',', '.'));
    }
  }

  if (times.length === 0) {
    const rawTimeRegex = /\b([01]?\d|2[0-3])[:h]([0-5]\d)\b/g;
    let rawMatch: RegExpExecArray | null = null;
    while ((rawMatch = rawTimeRegex.exec(text))) {
      const normalized = aiNormalizeTime(`${rawMatch[1]}:${rawMatch[2]}`);
      if (normalized) {
        times.push(normalized);
      }
    }
    if (times.length > 0) {
      count = Math.max(count, times.length);
    }
  } else {
    count = Math.max(count, times.length);
  }

  const base = normalizeSchedule({
    nb: count,
    freqUnit,
    durationVal,
    durationUnit,
    autoTimesEnabled: times.length < 1,
    times: times.length > 0 ? times : undefined,
    doses: doses.length > 0 ? doses : undefined,
    start: times[0] || '08:00',
    end: times[times.length - 1] || '20:00',
    note: '',
  });

  if (times.length > 0) {
    return {
      ...base,
      autoTimesEnabled: false,
      start: times[0] || '08:00',
      end: times[times.length - 1] || times[0] || '20:00',
      times: fillArray(times, count, times[times.length - 1] || times[0] || '08:00'),
      doses: doses.length > 0 ? fillArray(doses, count, doses[doses.length - 1] || '1') : fillArray([], count, '1'),
    };
  }

  return base;
}

function aiMedicationsToItems(value: unknown): MedicationItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      const label = aiSafeText(entry && typeof entry === 'object' ? (entry as AnalyzeMedication).label : '');
      const scheduleText = aiSafeText(entry && typeof entry === 'object' ? (entry as AnalyzeMedication).scheduleText : '');
      if (!label) {
        return null;
      }

      return {
        label,
        schedule: aiBuildScheduleFromText(scheduleText),
      } as MedicationItem;
    })
    .filter((entry): entry is MedicationItem => Boolean(entry));
}

function mergeMedicationItems(current: MedicationItem[], incoming: MedicationItem[]): MedicationItem[] {
  const next = Array.isArray(current) ? current.slice() : [];
  const seen = new Set(next.map((item) => aiSafeText(item?.label).toLowerCase()).filter(Boolean));

  for (const item of Array.isArray(incoming) ? incoming : []) {
    const label = aiSafeText(item?.label);
    if (!label) {
      continue;
    }
    const key = label.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      next.push(item);
    }
  }

  return next;
}

function formatMoney(amountCents: number | null | undefined, currency: string | undefined): string {
  const cents = typeof amountCents === 'number' ? amountCents : 0;
  const safeCurrency = String(currency || 'EUR').toUpperCase();

  try {
    return new Intl.NumberFormat('fr-FR', {
      style: 'currency',
      currency: safeCurrency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(cents / 100);
  } catch {
    const amount = (cents / 100).toLocaleString('fr-FR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return `${amount} ${safeCurrency}`;
  }
}

function formatAmountValue(amount: number | null | undefined, currency: string | undefined): string {
  const value = typeof amount === 'number' ? amount : 0;
  const safeCurrency = String(currency || 'EUR').toUpperCase();

  try {
    return new Intl.NumberFormat('fr-FR', {
      style: 'currency',
      currency: safeCurrency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    const formatted = value.toLocaleString('fr-FR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return `${formatted} ${safeCurrency}`;
  }
}

function formatEtaMinutes(minutes: number | null | undefined): string | null {
  const value = typeof minutes === 'number' ? Math.trunc(minutes) : 0;
  if (!Number.isFinite(value) || value < 1) {
    return null;
  }
  if (value < 60) {
    return `${value} minute${value > 1 ? 's' : ''}`;
  }
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  if (rest < 1) {
    return `${hours} heure${hours > 1 ? 's' : ''}`;
  }
  return `${hours} heure${hours > 1 ? 's' : ''} ${rest} minute${rest > 1 ? 's' : ''}`;
}

function describePriorityTurnaround(
  priority: 'standard' | 'express',
  pricing: PricingConfig | null,
): string {
  const eta = priority === 'express'
    ? formatEtaMinutes(pricing?.express_eta_minutes ?? null)
    : formatEtaMinutes(pricing?.standard_eta_minutes ?? null);

  if (eta) {
    return priority === 'express'
      ? `Traitement prioritaire estimé sous ${eta}`
      : `Traitement estimé sous ${eta}`;
  }

  return priority === 'express'
    ? 'Traitement prioritaire selon la disponibilité médicale.'
    : 'Traitement selon l’ordre d’arrivée des dossiers.';
}

function toPatientSafeSubmissionErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || '');
  const message = raw.trim().toLowerCase();

  if (!message) {
    return 'Nous n’avons pas pu préparer votre demande pour le moment. Merci de réessayer.';
  }

  if (message.includes('tarification')) {
    return 'Le montant de votre demande n’est pas encore disponible. Merci de réessayer dans quelques instants.';
  }

  if (message.includes('connect')) {
    return 'Merci de vous connecter pour finaliser votre demande.';
  }

  return 'Nous n’avons pas pu préparer votre demande pour le moment. Merci de réessayer.';
}

function toPatientSafeArtifactErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || '');
  const message = raw.trim().toLowerCase();

  if (!message) {
    return 'Lecture du document impossible. Merci de réessayer avec un document plus lisible.';
  }

  if (
    message.includes('upload')
    || message.includes('ticket')
    || message.includes('artefact')
    || message.includes('cors')
  ) {
    return 'Le document n’a pas pu être envoyé. Merci de réessayer.';
  }

  if (
    message.includes('lecture')
    || message.includes('analyse')
    || message.includes('document')
    || message.includes('prescription')
    || message.includes('expir')
  ) {
    return 'Lecture du document impossible. Merci de réessayer avec un document plus lisible.';
  }

  return 'Lecture du document impossible. Merci de réessayer avec un document plus lisible.';
}

function mergeRejectedFiles(current: File[], incoming: File[]): File[] {
  const next = Array.isArray(current) ? current.slice() : [];
  const seen = new Set(next.map((file) => `${file.name}::${file.size}::${file.lastModified}`));

  for (const file of Array.isArray(incoming) ? incoming : []) {
    const key = `${file.name}::${file.size}::${file.lastModified}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    next.push(file);
  }

  return next;
}

function buildSubmitBlockInfo(input: {
  loggedIn: boolean;
  flow: FlowType | null;
  fullname: string;
  birthdate: string;
  itemsCount: number;
  filesCount: number;
  attestationNoProof: boolean;
  consentRequired: boolean;
  consentTelemedicine: boolean;
  consentTruth: boolean;
  consentCgu: boolean;
  consentPrivacy: boolean;
  analysisInProgress: boolean;
  allowProofWithoutDetectedItems?: boolean;
}): { ok: boolean; reasons: Array<{ code: string; message: string }>; code: string | null; message: string | null } {
  const reasons: Array<{ code: string; message: string }> = [];

  const flow = String(input.flow || '').trim();
  const fullName = safePatientNameValue(input.fullname);
  const splitName = splitPatientNameValue(fullName);
  const isoBirthdate = toIsoBirthdate(String(input.birthdate || '').trim());
  const itemCount = Number(input.itemsCount || 0);
  const fileCount = Number(input.filesCount || 0);

  if (!flow) {
    reasons.push({
      code: 'flow_missing',
      message: 'Merci de choisir un parcours avant de soumettre votre demande.',
    });
  }

  if (fullName.length < 3 || splitName.firstName === '' || splitName.lastName === '') {
    reasons.push({
      code: 'patient_name_invalid',
      message: 'Merci de saisir le prénom et le nom du patient.',
    });
  }

  if (!input.birthdate) {
    reasons.push({
      code: 'birthdate_missing',
      message: 'Merci de renseigner la date de naissance du patient.',
    });
  } else if (!isoBirthdate) {
    reasons.push({
      code: 'birthdate_invalid',
      message: 'Merci de renseigner une date de naissance valide au format JJ/MM/AAAA.',
    });
  }

  if (flow === 'ro_proof' && fileCount < 1) {
    reasons.push({
      code: 'proof_missing',
      message: 'Merci d’ajouter au moins un document justificatif à analyser.',
    });
  }

  if (
    input.loggedIn
    && flow === 'ro_proof'
    && fileCount > 0
    && itemCount < 1
    && !input.analysisInProgress
    && !input.allowProofWithoutDetectedItems
  ) {
    reasons.push({
      code: 'medication_detection_missing',
      message: 'Aucun traitement n’a pu être détecté. Merci d’ajouter un document plus lisible.',
    });
  }

  if (flow === 'depannage_no_proof' && itemCount < 1) {
    reasons.push({
      code: 'medication_missing',
      message: 'Merci d’ajouter au moins un médicament.',
    });
  }

  if (flow === 'depannage_no_proof' && !input.attestationNoProof) {
    reasons.push({
      code: 'attestation_missing',
      message: 'Merci de confirmer l’attestation de dépannage sans justificatif.',
    });
  }

  if (input.consentRequired) {
    const missing: string[] = [];
    if (!input.consentTelemedicine) missing.push('analyse de votre demande par un médecin');
    if (!input.consentTruth) missing.push('exactitude des informations');
    if (!input.consentCgu) missing.push('CGU');
    if (!input.consentPrivacy) missing.push('politique de confidentialité');

    if (missing.length > 0) {
      reasons.push({
        code: 'consent_missing',
        message: `Merci de valider les consentements requis : ${missing.join(', ')}.`,
      });
    }
  }

  if (input.analysisInProgress) {
    reasons.push({
      code: 'analysis_in_progress',
      message: 'Analyse du document en cours...',
    });
  }

  return {
    ok: reasons.length === 0,
    reasons,
    code: reasons.length > 0 ? reasons[0].code : null,
    message: reasons.length > 0 ? reasons[0].message : null,
  };
}

function createLocalUpload(file: File): LocalUpload {
  return {
    id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    file,
    original_name: file?.name ? String(file.name) : 'upload.bin',
    mime: file?.type ? String(file.type) : 'application/octet-stream',
    mime_type: file?.type ? String(file.type) : 'application/octet-stream',
    size_bytes: typeof file?.size === 'number' ? file.size : 0,
    kind: 'PROOF',
    status: 'QUEUED',
  };
}


function MedicationSearch({
  onSelect,
}: {
  onSelect: (item: MedicationSearchResult) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MedicationSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const abortRef = useRef<AbortController | null>(null);
  const blurTimeoutRef = useRef<number | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const resultsId = 'sp-medication-search-results';

  const canSearch = useMemo(() => query.trim().length >= 2, [query]);
  const hasDisabledResults = useMemo(
    () => results.some((result) => result?.is_selectable === false),
    [results],
  );

  const getSelectableIndex = useCallback((startIndex: number, direction: 1 | -1): number => {
    if (results.length < 1) {
      return -1;
    }

    let index = startIndex;
    for (let steps = 0; steps < results.length; steps += 1) {
      index = (index + direction + results.length) % results.length;
      if (results[index]?.is_selectable !== false) {
        return index;
      }
    }

    return -1;
  }, [results]);

  const selectResult = useCallback((result: MedicationSearchResult) => {
    if (result?.is_selectable === false) {
      return;
    }

    onSelect(result);
    setQuery('');
    setResults([]);
    setError(null);
    setOpen(false);
    setActiveIndex(-1);
  }, [onSelect]);

  const resultsAnnouncement = useMemo(() => {
    if (!canSearch) {
      return 'Saisissez au moins deux caractères pour rechercher un médicament.';
    }

    if (loading) {
      return 'Recherche de médicaments en cours.';
    }

    if (error) {
      return error;
    }

    if (!open) {
      return '';
    }

    if (results.length < 1) {
      return 'Aucun résultat.';
    }

    return `${results.length} résultat${results.length > 1 ? 's' : ''} disponible${results.length > 1 ? 's' : ''}.`;
  }, [canSearch, error, loading, open, results.length]);

  useEffect(() => {
    if (!canSearch) {
      setResults([]);
      setOpen(false);
      setError(null);
      setLoading(false);
      setActiveIndex(-1);
      return;
    }

    const keyword = query.trim();
    setLoading(true);
    setOpen(true);
    setActiveIndex(-1);
    abortRef.current?.abort();

    const controller = new AbortController();
    abortRef.current = controller;

    const timeout = window.setTimeout(() => {
      searchMedicationsApi(keyword, 20)
        .then((data) => {
          if (controller.signal.aborted) {
            return;
          }

          let nextResults = Array.isArray(data)
            ? data
            : (
              data && typeof data === 'object'
                ? ((data as Record<string, unknown>).data
                  || (data as Record<string, unknown>).items
                  || (data as Record<string, unknown>).results
                  || (data as Record<string, unknown>).medications
                  || Object.values(data as Record<string, unknown>))
                : []
            );

          nextResults = Array.isArray(nextResults) ? nextResults : [];
          setError(null);
          setResults(nextResults as MedicationSearchResult[]);
        })
        .catch(() => {
          if (controller.signal.aborted) {
            return;
          }
          setResults([]);
          setError('La recherche du médicament n’a pas pu aboutir. Merci de réessayer.');
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setLoading(false);
          }
        });
    }, 200);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [canSearch, query]);

  useEffect(() => {
    if (!open || results.length < 1) {
      setActiveIndex(-1);
      return;
    }

    if (activeIndex >= 0 && activeIndex < results.length && results[activeIndex]?.is_selectable !== false) {
      return;
    }

    const firstSelectable = results.findIndex((result) => result?.is_selectable !== false);
    setActiveIndex(firstSelectable);
  }, [activeIndex, open, results]);

  useEffect(() => {
    if (!open || activeIndex < 0) {
      return;
    }

    const option = listRef.current?.querySelector<HTMLElement>(`#${resultsId}-option-${activeIndex}`);
    option?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  useEffect(() => {
    return () => {
      if (blurTimeoutRef.current != null) {
        window.clearTimeout(blurTimeoutRef.current);
      }
      abortRef.current?.abort();
    };
  }, []);

  const activeOptionId = open && activeIndex >= 0 ? `${resultsId}-option-${activeIndex}` : undefined;
  const resultsStatusId = `${resultsId}-status`;
  const resultsHintId = `${resultsId}-hint`;
  const inputDescriptionIds = [resultsStatusId, open ? resultsHintId : null].filter(Boolean).join(' ');

  return (
    <div className="sp-app-search" data-open={open ? 'true' : 'false'} data-loading={loading ? 'true' : 'false'}>
      <div className="sp-visually-hidden" id={resultsStatusId} aria-live="polite">{resultsAnnouncement}</div>
      <TextInput
        id="sp-medication-search-input"
        role="combobox"
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? resultsId : undefined}
        aria-activedescendant={activeOptionId}
        aria-describedby={inputDescriptionIds || undefined}
        aria-busy={loading}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(event.target.value.trim().length >= 2);
        }}
        placeholder="Rechercher un médicament..."
        onFocus={() => {
          if (blurTimeoutRef.current != null) {
            window.clearTimeout(blurTimeoutRef.current);
            blurTimeoutRef.current = null;
          }
          if (query.trim().length >= 2) {
            setOpen(true);
          }
        }}
        onBlur={() => {
          if (blurTimeoutRef.current != null) {
            window.clearTimeout(blurTimeoutRef.current);
          }
          blurTimeoutRef.current = window.setTimeout(() => {
            setOpen(false);
            setActiveIndex(-1);
          }, 120);
        }}
        onKeyDown={(event) => {
          if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp') && results.length > 0) {
            event.preventDefault();
            setOpen(true);
            setActiveIndex(getSelectableIndex(-1, 1));
            return;
          }

          if (!open) {
            return;
          }

          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActiveIndex((current) => getSelectableIndex(current < 0 ? -1 : current, 1));
            return;
          }

          if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActiveIndex((current) => getSelectableIndex(current < 0 ? 0 : current, -1));
            return;
          }

          if (event.key === 'Enter') {
            if (activeIndex >= 0 && results[activeIndex]?.is_selectable !== false) {
              event.preventDefault();
              selectResult(results[activeIndex]);
            }
            return;
          }

          if (event.key === 'Home') {
            event.preventDefault();
            setActiveIndex(getSelectableIndex(-1, 1));
            return;
          }

          if (event.key === 'End') {
            event.preventDefault();
            setActiveIndex(getSelectableIndex(results.length, -1));
            return;
          }

          if (event.key === 'Escape') {
            event.preventDefault();
            setOpen(false);
            setActiveIndex(-1);
          }
        }}
      />

      {open ? (
        <div className="sp-app-search__results" id={resultsId} role="listbox" aria-label="Résultats de recherche médicament" aria-busy={loading} ref={listRef}>
          <div className="sp-app-search__head">
            <span>Résultats</span>
            {loading ? <Spinner /> : null}
          </div>

          <div className="sp-app-search__body">
            {!loading && error ? (
              <div className="sp-app-search__feedback sp-app-search__feedback--error">{error}</div>
            ) : null}

            {!loading && !error && results.length === 0 ? (
              <div className="sp-app-search__feedback">
                <div className="sp-app-note-card">
                  <div className="sp-app-note-card__title">Aucun résultat</div>
                  <div className="sp-app-note-card__text">
                    Essayez d’affiner la recherche avec le nom exact, le dosage ou le code CIP si vous l’avez.
                    <ul className="sp-app-list">
                      <li>vérifiez l’orthographe du médicament</li>
                      <li>ajoutez le dosage ou la forme si nécessaire</li>
                      <li>essayez le code CIP indiqué sur la boîte</li>
                    </ul>
                  </div>
                </div>
              </div>
            ) : null}

            {results.map((result, index) => {
              const selectable = result?.is_selectable !== false;
              const key = `${result.cip13 || result.cis || result.label}`;
              const sublabel = typeof result.sublabel === 'string' ? result.sublabel.trim() : '';
              const metaParts = [
                result.cis ? `CIS ${result.cis}` : null,
                result.cip13 ? `CIP13 ${result.cip13}` : null,
                result.tauxRemb ? `Remb. ${result.tauxRemb}` : null,
                typeof result.prixTTC === 'number' ? formatAmountValue(result.prixTTC, 'EUR') : null,
              ].filter((value): value is string => Boolean(value));
              const optionId = `${resultsId}-option-${index}`;
              const selected = activeIndex === index;

              return (
                <button
                  key={key}
                  id={optionId}
                  type="button"
                  disabled={!selectable}
                  role="option"
                  aria-disabled={!selectable}
                  aria-selected={selected}
                  aria-posinset={index + 1}
                  aria-setsize={results.length}
                  tabIndex={-1}
                  className={cx(
                    'sp-app-search__item',
                    selectable ? 'is-selectable' : 'is-disabled',
                    selected && 'is-active',
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => {
                    if (selectable) {
                      setActiveIndex(index);
                    }
                  }}
                  onClick={() => selectResult(result)}
                >
                  <div className="sp-app-search__item-row">
                    <div className="sp-app-search__item-title">
                      <strong>{result.label}</strong>
                      {sublabel ? (
                        <div>
                          <small>{sublabel}</small>
                        </div>
                      ) : null}
                    </div>
                    {!selectable ? (
                      <span className="sp-app-search__badge">Non disponible en ligne</span>
                    ) : null}
                  </div>
                  {metaParts.length > 0 ? (
                    <div className="sp-app-search__item-meta">{metaParts.join(' • ')}</div>
                  ) : null}
                </button>
              );
            })}
          </div>

          <div className="sp-app-search__foot" id={resultsHintId}>
            {hasDisabledResults
              ? 'Les résultats grisés ne peuvent pas être ajoutés dans ce parcours.'
              : 'Sélectionnez un résultat pour l’ajouter à votre demande.'}
          </div>
        </div>
      ) : null}
    </div>
  );
}


function ScheduleEditor({
  value,
  onChange,
}: {
  value?: Partial<Schedule>;
  onChange: (next: Schedule) => void;
}) {
  const normalized = useMemo(() => normalizeSchedule(value), [value]);

  useEffect(() => {
    const input = value as Partial<Schedule> | undefined;
    if (
      !input
      || typeof input !== 'object'
      || input.nb == null
      || input.freqUnit == null
      || input.durationVal == null
      || input.durationUnit == null
      || !Array.isArray(input.times)
      || !Array.isArray(input.doses)
      || input.start == null
      || input.end == null
    ) {
      onChange(normalized);
    }
  }, []);

  const count = normalized.nb;
  const freqUnit = normalized.freqUnit;
  const autoTimesEnabled = normalized.autoTimesEnabled !== false && freqUnit === 'jour';
  const startTime = normalized.start || '08:00';
  const endTime = normalized.end || '20:00';
  const autoDistribution = useMemo(
    () => (autoTimesEnabled ? distributeTimes(count, startTime, endTime) : null),
    [autoTimesEnabled, count, startTime, endTime],
  );
  const times = autoDistribution ? autoDistribution.times : fillArray(normalized.times, count, '');
  const doses = fillArray(normalized.doses, count, '1');
  const warnings = autoDistribution ? autoDistribution.warnings : [];
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const update = useCallback((patch: Partial<Schedule>) => {
    onChange({
      ...normalized,
      ...patch,
    });
  }, [normalized, onChange]);

  const updateCount = useCallback((raw: string) => {
    const nextCount = clampInt(raw, 1, freqUnit === 'jour' ? 6 : 12, 1);
    if (autoTimesEnabled) {
      const auto = distributeTimes(nextCount, startTime, endTime);
      onChange({
        ...normalized,
        nb: nextCount,
        start: auto.start,
        end: auto.end,
        times: auto.times,
        doses: fillArray(normalized.doses, nextCount, '1'),
        autoTimesEnabled: true,
      });
      return;
    }

    onChange({
      ...normalized,
      nb: nextCount,
      times: fillArray(normalized.times, nextCount, ''),
      doses: fillArray(normalized.doses, nextCount, '1'),
    });
  }, [autoTimesEnabled, endTime, freqUnit, normalized, onChange, startTime]);

  const updateFreqUnit = useCallback((nextFreqUnit: FrequencyUnit) => {
    const safeCount = clampInt(normalized.nb, 1, nextFreqUnit === 'jour' ? 6 : 12, 1);
    if (nextFreqUnit === 'jour') {
      const auto = distributeTimes(safeCount, normalized.start, normalized.end);
      onChange({
        ...normalized,
        nb: safeCount,
        freqUnit: nextFreqUnit,
        autoTimesEnabled: normalized.autoTimesEnabled !== false,
        start: auto.start,
        end: auto.end,
        times: normalized.autoTimesEnabled !== false ? auto.times : fillArray(normalized.times, safeCount, ''),
        doses: fillArray(normalized.doses, safeCount, '1'),
      });
      return;
    }

    onChange({
      ...normalized,
      nb: safeCount,
      freqUnit: nextFreqUnit,
      autoTimesEnabled: false,
      times: fillArray(normalized.times, safeCount, ''),
      doses: fillArray(normalized.doses, safeCount, '1'),
    });
  }, [normalized, onChange]);

  const enableAutomaticTimes = useCallback(() => {
    const auto = distributeTimes(normalized.nb, normalized.start, normalized.end);
    onChange({
      ...normalized,
      autoTimesEnabled: true,
      start: auto.start,
      end: auto.end,
      times: auto.times,
      doses: fillArray(normalized.doses, normalized.nb, '1'),
    });
  }, [normalized, onChange]);

  const disableAutomaticTimes = useCallback(() => {
    onChange({
      ...normalized,
      autoTimesEnabled: false,
      times: fillArray(normalized.times, normalized.nb, ''),
      doses: fillArray(normalized.doses, normalized.nb, '1'),
    });
  }, [normalized, onChange]);

  const updateAnchors = useCallback((nextStart: string, nextEnd: string) => {
    const safeStart = isTimeString(nextStart) ? nextStart : normalized.start;
    const safeEnd = isTimeString(nextEnd) ? nextEnd : normalized.end;
    const auto = distributeTimes(normalized.nb, safeStart, safeEnd);
    onChange({
      ...normalized,
      autoTimesEnabled: true,
      start: auto.start,
      end: auto.end,
      times: auto.times,
    });
  }, [normalized, onChange]);


  const updateTime = useCallback((index: number, nextTime: string) => {
    const nextTimes = fillArray(times, normalized.nb, '');
    nextTimes[index] = nextTime;
    onChange({
      ...normalized,
      autoTimesEnabled: false,
      times: nextTimes,
      start: nextTimes[0] || normalized.start,
      end: nextTimes[nextTimes.length - 1] || normalized.end,
    });
  }, [normalized, onChange, times]);

  const updateDose = useCallback((index: number, nextDose: string) => {
    const nextDoses = fillArray(doses, normalized.nb, '1');
    nextDoses[index] = nextDose;
    onChange({
      ...normalized,
      doses: nextDoses,
    });
  }, [doses, normalized, onChange]);

  const openAdvancedPlanning = useCallback(() => {
    setAdvancedOpen(true);
  }, []);

  return (
    <div className="sp-app-card sp-app-card--nested sp-app-schedule-editor">
      <div className="sp-app-grid sp-app-grid--two sp-app-schedule-editor__overview">
        <div className="sp-app-field">
          <label className="sp-app-field__label">Nombre de prises</label>
          <TextInput
            type="number"
            min={1}
            max={freqUnit === 'jour' ? 6 : 12}
            value={count}
            onChange={(event) => updateCount(event.target.value)}
          />
        </div>
        <div className="sp-app-field">
          <label className="sp-app-field__label">Périodicité</label>
          <select
            className="sp-app-control sp-app-select"
            value={freqUnit}
            onChange={(event) => updateFreqUnit(event.target.value === 'semaine' ? 'semaine' : 'jour')}
          >
            <option value="jour">Par jour</option>
            <option value="semaine">Par semaine</option>
          </select>
        </div>
        <div className="sp-app-field">
          <label className="sp-app-field__label">Durée</label>
          <TextInput
            type="number"
            min={1}
            max={3650}
            value={normalized.durationVal}
            onChange={(event) => update({ durationVal: clampInt(event.target.value, 1, 3650, 5) })}
          />
        </div>
        <div className="sp-app-field">
          <label className="sp-app-field__label">Unité</label>
          <select
            className="sp-app-control sp-app-select"
            value={normalized.durationUnit}
            onChange={(event) => update({ durationUnit: event.target.value === 'mois' ? 'mois' : event.target.value === 'semaine' ? 'semaine' : 'jour' })}
          >
            <option value="jour">Jour(s)</option>
            <option value="semaine">Semaine(s)</option>
            <option value="mois">Mois</option>
          </select>
        </div>
      </div>


      {warnings.length > 0 ? (
        <div className="sp-app-block">
          <Notice variant="warning">
            <ul className="sp-app-list">
              {warnings.map((warning, index) => (
                <li key={`${warning}-${index}`}>{warning}</li>
              ))}
            </ul>
          </Notice>
        </div>
      ) : null}

      <div className="sp-app-dose-list sp-app-dose-list--grouped">
        {Array.from({ length: count }).map((_, index) => {
          const isFirst = index === 0;
          const isLast = index === count - 1 && count > 1;
          const label = isFirst ? '1ère prise' : isLast ? 'Dernière prise' : `Prise ${index + 1}`;
          return (
            <div key={index} className="sp-app-dose-row">
              <div className="sp-app-dose-row__label">
                <span>{label}</span>

              </div>
              <TextInput
                type="time"
                step={300}
                value={times[index] || ''}
                onChange={(event) => updateTime(index, event.target.value)}
              />
              <TextInput
                type="text"
                placeholder="Dose ou quantité"
                value={doses[index] || '1'}
                onChange={(event) => updateDose(index, event.target.value)}
              />
            </div>
          );
        })}
      </div>

      {freqUnit === 'jour' ? (
        <div className="sp-app-schedule-editor__advanced" data-expanded={advancedOpen ? 'true' : 'false'}>
          {advancedOpen ? (
            <div className="sp-app-schedule sp-app-schedule--grouped sp-app-schedule--advanced">
              <div className="sp-app-schedule__header">
                <div className="sp-app-schedule__title">
                  <span>Réglages avancés de planification</span>
                </div>
                <div className="sp-app-schedule__actions">
                  {autoTimesEnabled ? (
                    <Button type="button" variant="secondary" className="sp-app-schedule__toggle-auto" onClick={disableAutomaticTimes}>
                      Passer en manuel
                    </Button>
                  ) : (
                    <Button type="button" variant="secondary" className="sp-app-schedule__toggle-auto" onClick={enableAutomaticTimes}>
                      Utiliser les horaires suggérés
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    className="sp-app-schedule__close-button"
                    onClick={() => setAdvancedOpen(false)}
                  >
                    <XIcon className="sp-app-schedule-editor__close-icon" />
                    Fermer
                  </Button>
                </div>
              </div>

              <div className="sp-app-grid sp-app-grid--two sp-app-schedule__anchors">
                <div className="sp-app-field">
                  <label className="sp-app-field__label">1ère prise</label>
                  <TextInput
                    type="time"
                    step={300}
                    value={normalized.start}
                    onChange={(event) => updateAnchors(event.target.value, normalized.end)}
                    disabled={!autoTimesEnabled}
                  />
                </div>
                <div className="sp-app-field">
                  <label className="sp-app-field__label">Dernière prise</label>
                  <TextInput
                    type="time"
                    step={300}
                    value={normalized.end}
                    onChange={(event) => updateAnchors(normalized.start, event.target.value)}
                    disabled={!autoTimesEnabled}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="sp-app-schedule-editor__advanced-toggle">
              <Button type="button" variant="secondary" className="sp-app-schedule-editor__personalize-button" onClick={openAdvancedPlanning}>
                <Settings2Icon className="sp-app-schedule-editor__settings-icon" />
                Personnaliser
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function getFlowLabel(flow: FlowType): string {
  return flow === 'ro_proof'
    ? 'Renouvellement habituel · Avec justificatif'
    : 'Dépannage SOS · Sans justificatif';
}

type StepFlowChoiceProps = {
  flow: FlowType | null;
  onSelectFlow: (nextFlow: FlowType) => void;
};

function StepFlowChoice({ flow, onSelectFlow }: StepFlowChoiceProps) {
  return (
    <section className="sp-app-card sp-app-card--step-choice">
      <div className="sp-app-section__header">
        <div>
          <h2 className="sp-app-section__title">Choisissez votre parcours</h2>
          <p className="sp-app-section__hint">
            Sélectionnez l’entrée qui correspond à votre demande.
          </p>
        </div>
      </div>

      <div className="sp-app-choice-grid sp-app-choice-grid--flow" role="radiogroup" aria-label="Choisir votre parcours">
        <button
          type="button"
          role="radio"
          aria-checked={flow === 'ro_proof'}
          data-selected={flow === 'ro_proof' ? 'true' : 'false'}
          className={cx('sp-app-choice-card', flow === 'ro_proof' && 'is-selected')}
          onClick={() => onSelectFlow('ro_proof')}
        >
          <div className="sp-app-choice-card__header">
            <span className="sp-app-choice-card__icon" aria-hidden="true">
              <FileUpIcon />
            </span>
            <div className="sp-app-choice-card__copy">
              <div className="sp-app-choice-card__title">Renouvellement habituel</div>
              <div className="sp-app-choice-card__subline">Avec justificatif</div>
            </div>
          </div>
          <div className="sp-app-choice-card__text">
            Vous disposez de votre ancienne ordonnance ou d’une photo de votre boîte de médicament.
          </div>
          <div className="sp-app-choice-card__meta">Pré-remplissage du dossier disponible.</div>
        </button>

        <button
          type="button"
          role="radio"
          aria-checked={flow === 'depannage_no_proof'}
          data-selected={flow === 'depannage_no_proof' ? 'true' : 'false'}
          className={cx('sp-app-choice-card', flow === 'depannage_no_proof' && 'is-selected')}
          onClick={() => onSelectFlow('depannage_no_proof')}
        >
          <div className="sp-app-choice-card__header">
            <span className="sp-app-choice-card__icon" aria-hidden="true">
              <FilePenIcon />
            </span>
            <div className="sp-app-choice-card__copy">
              <div className="sp-app-choice-card__title">Dépannage SOS</div>
              <div className="sp-app-choice-card__subline">Sans justificatif</div>
            </div>
          </div>
          <div className="sp-app-choice-card__text">
            Oubli, perte ou déplacement. Vous n’avez aucune preuve de votre traitement sous la main.
          </div>
          <div className="sp-app-choice-card__meta">Attestation sur l'honneur demandée.</div>
        </button>
      </div>
    </section>
  );
}

type StepClinicalDataProps = {
  flow: FlowType;
  isLoggedIn: boolean;
  analysisInProgress: boolean;
  fullName: string;
  birthdate: string;
  draftEmail: string;
  draftEmailLocked: boolean;
  ageLabel: string;
  medicalNotes: string;
  items: MedicationItem[];
  files: LocalUpload[];
  rejectedFiles: File[];
  analysisMessage: string | null;
  attestationNoProof: boolean;
  consentRequired: boolean;
  consentTelemedicine: boolean;
  consentTruth: boolean;
  consentCgu: boolean;
  consentPrivacy: boolean;
  compliance: AppConfig['compliance'];
  submitLoading: boolean;
  onBackToChoice: () => void;
  onFullNameChange: (value: string) => void;
  onBirthdateChange: (value: string) => void;
  onDraftEmailChange: (value: string) => void;
  onUnlockDraftEmail: () => void;
  onMedicalNotesChange: (value: string) => void;
  onFilesSelected: (list: FileList | null) => void;
  onRemoveFile: (fileId: string) => void;
  onAddMedication: (item: MedicationSearchResult) => void;
  onUpdateMedication: (index: number, patch: Partial<MedicationItem>) => void;
  onRemoveMedication: (index: number) => void;
  onAttestationChange: (checked: boolean) => void;
  onConsentTelemedicineChange: (checked: boolean) => void;
  onConsentTruthChange: (checked: boolean) => void;
  onConsentCguChange: (checked: boolean) => void;
  onConsentPrivacyChange: (checked: boolean) => void;
  onContinue: () => void;
};

function StepClinicalData({
  flow,
  isLoggedIn,
  analysisInProgress,
  fullName,
  birthdate,
  draftEmail,
  draftEmailLocked,
  ageLabel,
  medicalNotes,
  items,
  files,
  rejectedFiles,
  analysisMessage,
  attestationNoProof,
  consentRequired,
  consentTelemedicine,
  consentTruth,
  consentCgu,
  consentPrivacy,
  compliance,
  submitLoading,
  onBackToChoice,
  onFullNameChange,
  onBirthdateChange,
  onDraftEmailChange,
  onMedicalNotesChange,
  onFilesSelected,
  onRemoveFile,
  onAddMedication,
  onUpdateMedication,
  onRemoveMedication,
  onAttestationChange,
  onConsentTelemedicineChange,
  onConsentTruthChange,
  onConsentCguChange,
  onConsentPrivacyChange,
  onContinue,
}: StepClinicalDataProps) {
  const showMedicationSection = flow === 'depannage_no_proof'
    || flow === 'ro_proof';

  return (
    <div className="sp-app-stack">
      <section className="sp-app-card sp-app-card--patient-info">
        <div className="sp-app-section__header">
          <div>
            <h2 className="sp-app-section__title">Informations patient</h2>
            <p className="sp-app-section__hint">
              Renseignez les éléments indispensables au contrôle médical.
            </p>
          </div>
        </div>

        <div className="sp-app-grid sp-app-grid--two">
          <div className="sp-app-field">
            <input
              type="text"
              tabIndex={-1}
              autoComplete="username"
              name="sp_trap_username"
              style={{
                position: 'absolute',
                left: '-9999px',
                top: 'auto',
                width: '1px',
                height: '1px',
                overflow: 'hidden',
                opacity: 0,
                pointerEvents: 'none',
              }}
              aria-hidden="true"
            />
            <input
              type="password"
              tabIndex={-1}
              autoComplete="new-password"
              name="sp_trap_password"
              style={{
                position: 'absolute',
                left: '-9999px',
                top: 'auto',
                width: '1px',
                height: '1px',
                overflow: 'hidden',
                opacity: 0,
                pointerEvents: 'none',
              }}
              aria-hidden="true"
            />
            <label className="sp-app-field__label" htmlFor="sp-patient-fullname">
              Nom complet
            </label>
            <TextInput
              id="sp-patient-fullname"
              name="sp_patient_identity_fullname"
              autoComplete="new-password"
              data-lpignore="true"
              data-form-type="other"
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="words"
              value={fullName}
              onChange={(event) => onFullNameChange(event.target.value)}
              placeholder="Prénom NOM"
            />
          </div>

          <div className="sp-app-field">
            <label className="sp-app-field__label" htmlFor="sp-patient-birthdate">
              Date de naissance (JJ/MM/AAAA)
            </label>
            <TextInput
              id="sp-patient-birthdate"
              name="sp_patient_identity_birthdate"
              inputMode="numeric"
              pattern="[0-9]{2}/[0-9]{2}/[0-9]{4}"
              value={birthdate}
              onChange={(event) => onBirthdateChange(formatBirthdateInput(event.target.value))}
              placeholder="JJ/MM/AAAA"
            />
            {ageLabel ? <div className="sp-app-field__hint">Âge estimé : {ageLabel}</div> : null}
          </div>
        </div>

        <div className={cx('sp-app-field', 'sp-app-field--email', draftEmailLocked && 'is-prefilled')}>
          <label className="sp-app-field__label" htmlFor="sp-patient-email">
            Adresse e-mail
          </label>
          <TextInput
            id="sp-patient-email"
            type="email"
            autoComplete="email"
            inputMode="email"
            value={draftEmail}
            onChange={(event) => onDraftEmailChange(event.target.value)}
            placeholder="vous@exemple.fr"
          />
          <div className="sp-app-field__hint">
            Cette adresse sera réutilisée pour reprendre votre dossier et finaliser l’envoi.
          </div>
        </div>

        <div className="sp-app-field">
          <label className="sp-app-field__label" htmlFor="sp-patient-medical-notes">
            Précisions médicales (optionnel)
          </label>
          <TextareaField
            id="sp-patient-medical-notes"
            name="medical_notes"
            value={medicalNotes}
            onChange={(event) => onMedicalNotesChange(event.target.value)}
            placeholder="Allergies, traitements en cours, contre-indications ou toute information utile au médecin..."
          />
        </div>
      </section>

      {flow === 'ro_proof' ? (
        <section className="sp-app-card">
          <div className="sp-app-section__header">
            <div>
              <h2 className="sp-app-section__title">Justificatifs médicaux</h2>
              <p className="sp-app-section__hint">
                Importez votre ordonnance ou une photo de la boîte. Cela nous aide à vérifier le traitement et à pré-remplir la demande.
              </p>
            </div>
          </div>

          <div className="sp-app-upload">
            <input
              id="sp-evidence-input"
              type="file"
              className="sp-app-hidden"
              accept="image/jpeg,image/png,application/pdf"
              multiple
              disabled={analysisInProgress}
              onChange={(event) => {
                onFilesSelected(event.target.files);
                event.currentTarget.value = '';
              }}
            />

            <div className="sp-app-upload__actions">
              <Button
                type="button"
                variant="secondary"
                disabled={analysisInProgress}
                onClick={() => {
                  document.getElementById('sp-evidence-input')?.click();
                }}
              >
                Ajouter un document
              </Button>

              {analysisInProgress ? (
                <div className="sp-app-inline-status">
                  <Spinner />
                  <span>Lecture du document en cours...</span>
                </div>
              ) : null}
            </div>

            <div className="sp-app-field__hint">JPG, PNG ou PDF (Max 5 Mo)</div>
            {!isLoggedIn ? (
              <div className="sp-app-field__hint sp-app-field__hint--warning">
                Vous pourrez valider votre adresse à la fin du parcours. Les documents seront liés à votre dossier avant le paiement.
              </div>
            ) : null}
          </div>

          {files.length > 0 ? (
            <div className="sp-app-upload-list">
              {files.map((file) => (
                <div key={file.id} className="sp-app-upload-item">
                  <div className="sp-app-upload-item__content">
                    <div className="sp-app-upload-item__title">{file.original_name}</div>
                    <div className="sp-app-upload-item__meta">
                      {Math.round((file.size_bytes || 0) / 1024)} Ko • {file.mime || 'application/octet-stream'}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="sp-app-button sp-app-button--secondary sp-app-button--compact sp-app-button--copy"
                    onClick={() => onRemoveFile(file.id)}
                    aria-label={`Retirer ${file.original_name}`}
                    title="Retirer"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          {analysisMessage ? (
            <div className="sp-app-block">
              <Notice variant="success">{analysisMessage}</Notice>
            </div>
          ) : null}

          {rejectedFiles.length > 0 ? (
            <div className="sp-app-block">
              <Notice variant="warning">
                <div className="sp-app-notice__title">Documents à vérifier</div>
                <div className="sp-app-notice__text">
                  Certains documents n’ont pas pu être lus.
                </div>
                <div className="sp-app-tag-list">
                  {rejectedFiles.map((file, index) => (
                    <span key={`${file.name}-${index}`} className="sp-app-tag">{file.name}</span>
                  ))}
                </div>
              </Notice>
            </div>
          ) : null}
        </section>
      ) : null}

      {showMedicationSection ? (
        <section className="sp-app-card sp-app-card--medication-request">
          <div className="sp-app-section__header">
            <div>
              <h2 className="sp-app-section__title">Traitement demandé</h2>
              <p className="sp-app-section__hint">
                Ajoutez chaque médicament puis ajustez la posologie si nécessaire.
              </p>
            </div>
          </div>

          <div className="sp-app-field sp-app-field--search">
            <label className="sp-app-field__label">Médicament concerné</label>
            <MedicationSearch onSelect={onAddMedication} />
          </div>

          {items.length > 0 ? (
            <div className="sp-app-medication-list">
              {items.map((item, index) => (
                <div key={`${item.label}-${index}`} className="sp-app-medication-card sp-app-medication-card--stacked">
                  <div className="sp-app-medication-card__head">
                    <div className="sp-app-medication-card__content">
                      <div className="sp-app-medication-card__title">{item.label}</div>
                      <div className="sp-app-medication-card__meta">
                        {item.cis ? `CIS ${item.cis}` : ''}
                        {item.cip13 ? ` • CIP13 ${item.cip13}` : ''}
                      </div>
                    </div>

                    <Button type="button" variant="secondary" onClick={() => onRemoveMedication(index)}>
                      Retirer
                    </Button>
                  </div>

                  <div className="sp-app-block">
                    <div className="sp-app-field__label">Posologie</div>
                    <ScheduleEditor
                      value={item.schedule || {}}
                      onChange={(nextSchedule) => {
                        onUpdateMedication(index, { schedule: nextSchedule });
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="sp-app-empty">Aucun médicament ajouté pour le moment.</div>
          )}
        </section>
      ) : null}

      {flow === 'depannage_no_proof' ? (
        <section className="sp-app-card sp-app-card--attestation">
          <div className="sp-app-section__header">
            <div>
              <h2 className="sp-app-section__title">Attestation sur l’honneur</h2>
              <p className="sp-app-section__hint">
                Merci de confirmer que ce traitement vous a déjà été prescrit.
              </p>
            </div>
          </div>

          <label className="sp-app-checkbox sp-app-checkbox--emphasis sp-app-checkbox--statement">
            <span className="sp-app-checkbox__control">
              <input
                type="checkbox"
                checked={attestationNoProof}
                onChange={(event) => onAttestationChange(event.target.checked)}
              />
              <span className="sp-app-checkbox__box" aria-hidden="true" />
            </span>
            <span className="sp-app-checkbox__text">
              Je certifie que ce traitement m’a déjà été prescrit et que les informations renseignées sont exactes.
            </span>
          </label>
        </section>
      ) : null}

      {consentRequired ? (
        <section className="sp-app-card sp-app-card--consent">
          <div className="sp-app-section__header">
            <div>
              <h2 className="sp-app-section__title">Vérifications et consentements</h2>
              <p className="sp-app-section__hint">
                Avant l’envoi du dossier, merci de confirmer les éléments essentiels ci-dessous.
              </p>
            </div>
          </div>

          <div className="sp-app-stack sp-app-stack--compact sp-app-consent-list">
            <label className="sp-app-checkbox">
              <span className="sp-app-checkbox__control">
                <input
                  id="sp-consent-medical"
                  type="checkbox"
                  checked={consentTelemedicine}
                  onChange={(event) => onConsentTelemedicineChange(event.target.checked)}
                />
                <span className="sp-app-checkbox__box" aria-hidden="true" />
              </span>
              <span className="sp-app-checkbox__text">
                J’accepte l’analyse de ma demande par un médecin.
              </span>
            </label>

            <label className="sp-app-checkbox">
              <span className="sp-app-checkbox__control">
                <input
                  id="sp-consent-truth"
                  type="checkbox"
                  checked={consentTruth}
                  onChange={(event) => onConsentTruthChange(event.target.checked)}
                />
                <span className="sp-app-checkbox__box" aria-hidden="true" />
              </span>
              <span className="sp-app-checkbox__text">Je confirme l’exactitude des informations.</span>
            </label>

            <div className="sp-app-checkbox sp-app-checkbox--with-action sp-app-checkbox--legal">
              <label className="sp-app-checkbox__label" htmlFor="sp-consent-cgu">
                <span className="sp-app-checkbox__control">
                  <input
                    id="sp-consent-cgu"
                    type="checkbox"
                    checked={consentCgu}
                    onChange={(event) => onConsentCguChange(event.target.checked)}
                  />
                  <span className="sp-app-checkbox__box" aria-hidden="true" />
                </span>
                <span className="sp-app-checkbox__text">J’ai lu et j’accepte les conditions générales d’utilisation.</span>
              </label>
              <a
                href={compliance?.cgu_url || '#'}
                target="_blank"
                rel="noreferrer"
                className="sp-app-link sp-app-checkbox__action"
              >
                Lire les CGU
              </a>
            </div>

            <div className="sp-app-checkbox sp-app-checkbox--with-action sp-app-checkbox--legal">
              <label className="sp-app-checkbox__label" htmlFor="sp-consent-privacy">
                <span className="sp-app-checkbox__control">
                  <input
                    id="sp-consent-privacy"
                    type="checkbox"
                    checked={consentPrivacy}
                    onChange={(event) => onConsentPrivacyChange(event.target.checked)}
                  />
                  <span className="sp-app-checkbox__box" aria-hidden="true" />
                </span>
                <span className="sp-app-checkbox__text">J’ai pris connaissance de la politique de confidentialité.</span>
              </label>
              <a
                href={compliance?.privacy_url || '#'}
                target="_blank"
                rel="noreferrer"
                className="sp-app-link sp-app-checkbox__action"
              >
                Lire la politique de confidentialité
              </a>
            </div>
          </div>
        </section>
      ) : null}

      <div className="sp-app-actions">
        <Button type="button" onClick={onContinue} disabled={submitLoading}>
          Continuer
        </Button>
      </div>
    </div>
  );
}

type StepPrioritySelectionProps = {
  flow: FlowType;
  itemsCount: number;
  filesCount: number;
  pricingLoading: boolean;
  pricing: PricingConfig | null;
  priority: 'standard' | 'express';
  paymentsConfig: PaymentsConfig | null;
  selectedAmount: number | null;
  selectedPriorityEta: string;
  onPriorityChange: (priority: 'standard' | 'express') => void;
  onBack: () => void;
  onContinue: () => void;
  continueDisabled: boolean;
};

function StepPrioritySelection({
  flow,
  itemsCount,
  filesCount,
  pricingLoading,
  pricing,
  priority,
  paymentsConfig,
  selectedAmount,
  selectedPriorityEta,
  onPriorityChange,
  onBack,
  onContinue,
  continueDisabled,
}: StepPrioritySelectionProps) {
  return (
    <div className="sp-app-stack">
      <section className="sp-app-card sp-app-card--priority">
        <div className="sp-app-section__header">
          <div>
            <h2 className="sp-app-section__title">Choisissez le délai de traitement</h2>
            <p className="sp-app-section__hint">
              Sélectionnez l’option qui vous convient avant le règlement sécurisé.
            </p>
          </div>
        </div>

        <div className="sp-app-summary-grid">
          <div className="sp-app-summary-card">
            <div className="sp-app-summary-card__label">Situation</div>
            <div className="sp-app-summary-card__value">{getFlowLabel(flow)}</div>
          </div>
          <div className="sp-app-summary-card">
            <div className="sp-app-summary-card__label">Médicaments</div>
            <div className="sp-app-summary-card__value">{itemsCount}</div>
          </div>
          <div className="sp-app-summary-card">
            <div className="sp-app-summary-card__label">Justificatifs</div>
            <div className="sp-app-summary-card__value">{filesCount}</div>
          </div>
        </div>

        {pricingLoading ? (
          <div className="sp-app-inline-status">
            <Spinner />
            <span>Chargement du montant de la demande…</span>
          </div>
        ) : pricing ? (
          <div className="sp-app-choice-grid" role="radiogroup" aria-label="Choisir le délai de traitement">
            <button
              type="button"
              role="radio"
              aria-checked={priority === 'standard'}
              data-selected={priority === 'standard' ? 'true' : 'false'}
              className={cx('sp-app-choice-card', priority === 'standard' && 'is-selected')}
              onClick={() => onPriorityChange('standard')}
            >
              <div className="sp-app-choice-card__header">
                <span className="sp-app-choice-card__icon" aria-hidden="true">
                  <Clock2Icon />
                </span>
                <div className="sp-app-choice-card__title">Standard</div>
              </div>
              <div className="sp-app-choice-card__text">{describePriorityTurnaround('standard', pricing)}</div>
              <div className="sp-app-choice-card__meta">
                {formatMoney(pricing.standard_cents, pricing.currency)}
              </div>
            </button>

            <button
              type="button"
              role="radio"
              aria-checked={priority === 'express'}
              data-selected={priority === 'express' ? 'true' : 'false'}
              className={cx('sp-app-choice-card', priority === 'express' && 'is-selected')}
              onClick={() => onPriorityChange('express')}
            >
              <div className="sp-app-choice-card__header">
                <span className="sp-app-choice-card__icon" aria-hidden="true">
                  <TimerIcon />
                </span>
                <div className="sp-app-choice-card__title">Express</div>
              </div>
              <div className="sp-app-choice-card__text">{describePriorityTurnaround('express', pricing)}</div>
              <div className="sp-app-choice-card__meta">
                {formatMoney(pricing.express_cents, pricing.currency)}
              </div>
            </button>
          </div>
        ) : (
          <Notice variant="error">
            Nous n’avons pas pu charger le montant de la demande. Merci de réessayer avant de poursuivre.
          </Notice>
        )}

        {selectedAmount != null && pricing ? (
          <div className="sp-app-inline-note">
            Sélection actuelle : <strong>{priority === 'express' ? 'Express' : 'Standard'}</strong> · {selectedPriorityEta} · {formatMoney(selectedAmount, pricing.currency)}
          </div>
        ) : null}
      </section>

      <div className="sp-app-actions">
        <Button type="button" variant="secondary" onClick={onBack}>
          Modifier mes informations
        </Button>

        <Button type="button" onClick={onContinue} disabled={continueDisabled}>
          Continuer
        </Button>
      </div>
    </div>
  );
}

type StepDraftValidationProps = {
  flow: FlowType;
  fullName: string;
  birthdate: string;
  itemsCount: number;
  filesCount: number;
  priority: 'standard' | 'express';
  pricingLoading: boolean;
  pricing: PricingConfig | null;
  selectedAmount: number | null;
  selectedPriorityEta: string;
  draftEmail: string;
  draftEmailLocked: boolean;
  draftSending: boolean;
  draftSent: boolean;
  draftSuccessMessage: string | null;
  onDraftEmailChange: (value: string) => void;
  onUnlockDraftEmail: () => void;
  onBack: () => void;
  onSend: () => void;
};

function StepDraftValidation({
  flow,
  fullName,
  birthdate,
  itemsCount,
  filesCount,
  priority,
  pricingLoading,
  pricing,
  selectedAmount,
  selectedPriorityEta,
  draftEmail,
  draftEmailLocked,
  draftSending,
  draftSent,
  draftSuccessMessage,
  onDraftEmailChange,
  onUnlockDraftEmail,
  onBack,
  onSend,
}: StepDraftValidationProps) {
  return (
    <div className="sp-app-stack">
      <section className="sp-app-card">
        <div className="sp-app-section__header">
          <div>
            <h2 className="sp-app-section__title">Validez votre adresse pour envoyer votre dossier</h2>
            <p className="sp-app-section__hint">
              Nous vous envoyons un lien de connexion pour reprendre ce dossier, confirmer votre identité et poursuivre jusqu’au paiement.
            </p>
          </div>
        </div>

        <div className="sp-app-summary-grid">
          <div className="sp-app-summary-card">
            <div className="sp-app-summary-card__label">Patient</div>
            <div className="sp-app-summary-card__value">{safePatientNameValue(fullName) || '—'}</div>
          </div>
          <div className="sp-app-summary-card">
            <div className="sp-app-summary-card__label">Naissance</div>
            <div className="sp-app-summary-card__value">{birthdate || '—'}</div>
          </div>
          <div className="sp-app-summary-card">
            <div className="sp-app-summary-card__label">Situation</div>
            <div className="sp-app-summary-card__value">{getFlowLabel(flow)}</div>
          </div>
          <div className="sp-app-summary-card">
            <div className="sp-app-summary-card__label">Priorité</div>
            <div className="sp-app-summary-card__value">{priority === 'express' ? 'Express' : 'Standard'}</div>
          </div>
          <div className="sp-app-summary-card">
            <div className="sp-app-summary-card__label">Délai visé</div>
            <div className="sp-app-summary-card__value">{selectedPriorityEta}</div>
          </div>
          <div className="sp-app-summary-card">
            <div className="sp-app-summary-card__label">Montant estimé</div>
            <div className="sp-app-summary-card__value">
              {pricing && selectedAmount != null ? formatMoney(selectedAmount, pricing.currency) : pricingLoading ? 'Chargement…' : '—'}
            </div>
          </div>
          <div className="sp-app-summary-card">
            <div className="sp-app-summary-card__label">Médicaments</div>
            <div className="sp-app-summary-card__value">{itemsCount}</div>
          </div>
          <div className="sp-app-summary-card">
            <div className="sp-app-summary-card__label">Justificatifs</div>
            <div className="sp-app-summary-card__value">{filesCount}</div>
          </div>
        </div>

        <div className="sp-app-field">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
            <label className="sp-app-field__label" htmlFor="sp-draft-email">
              Adresse e-mail
            </label>
            {draftEmailLocked ? (
              <Button type="button" variant="ghost" onClick={onUnlockDraftEmail} disabled={draftSending}>
                Modifier
              </Button>
            ) : null}
          </div>
          <TextInput
            id="sp-draft-email"
            type="email"
            autoComplete="email"
            inputMode="email"
            readOnly={draftEmailLocked}
            aria-readonly={draftEmailLocked}
            value={draftEmail}
            onChange={(event) => onDraftEmailChange(event.target.value)}
            placeholder="vous@exemple.fr"
          />
          <div className="sp-app-field__hint">
            Cette adresse servira à vous renvoyer vers ce dossier pour finaliser l’envoi et procéder au paiement.
          </div>
        </div>

        {draftSent && draftSuccessMessage ? (
          <div className="sp-app-block">
            <Notice variant="success">{draftSuccessMessage}</Notice>
          </div>
        ) : (
          <div className="sp-app-block">
            <Notice variant="info">
              Après l’envoi, vérifiez votre e-mail. Le lien reçu vous redonnera accès à votre dossier.
            </Notice>
          </div>
        )}
      </section>

      <div className="sp-app-actions">
        <Button type="button" variant="secondary" onClick={onBack} disabled={draftSending}>
          Modifier mon choix
        </Button>
        <Button type="button" onClick={onSend} disabled={draftSending} aria-busy={draftSending}>
          {draftSending ? 'Envoi en cours…' : 'Recevoir mon lien de validation'}
        </Button>
      </div>
    </div>
  );
}

type StepPaymentAuthProps = {
  flow: FlowType;
  fullName: string;
  birthdate: string;
  itemsCount: number;
  filesCount: number;
  priority: 'standard' | 'express';
  pricingLoading: boolean;
  pricing: PricingConfig | null;
  selectedAmount: number | null;
  selectedPriorityEta: string;
  paymentsConfig: PaymentsConfig | null;
  preparedSubmission: SubmissionResult | null;
  onBack: () => void;
  onAuthorized: () => void;
};

function StepPaymentAuth({
  fullName,
  priority,
  pricingLoading,
  pricing,
  selectedAmount,
  selectedPriorityEta,
  paymentsConfig,
  preparedSubmission,
  onBack,
  onAuthorized,
}: StepPaymentAuthProps) {
  const billingName = useMemo(() => {
    const config = getConfigOrThrow();
    return safePatientNameValue(fullName) || resolveStrictPatientProfileFullName(config) || undefined;
  }, [fullName]);

  const billingEmail = useMemo(() => {
    const config = getConfigOrThrow();
    const value = typeof config.currentUser?.email === 'string' ? config.currentUser.email.trim() : '';
    return value !== '' ? value : undefined;
  }, []);

  const prerequisiteError = useMemo(() => {
    if (!preparedSubmission || Number(preparedSubmission.id) < 1) {
      return 'Votre dossier n’est pas encore prêt pour la sécurisation bancaire. Merci de revenir à l’étape précédente puis de réessayer.';
    }

    if (!paymentsConfig?.enabled) {
      return 'La sécurisation bancaire est temporairement indisponible. Merci de réessayer un peu plus tard.';
    }

    return null;
  }, [paymentsConfig?.enabled, preparedSubmission]);

  const createIntent = useCallback(async () => {
    if (!preparedSubmission || Number(preparedSubmission.id) < 1) {
      throw new Error('Votre dossier n’est pas encore prêt pour la sécurisation bancaire. Merci de revenir à l’étape précédente puis de réessayer.');
    }

    return createPaymentIntentApi(Number(preparedSubmission.id), priority);
  }, [preparedSubmission, priority]);

  const confirmIntent = useCallback(async (paymentIntentId: string) => {
    if (!preparedSubmission || Number(preparedSubmission.id) < 1) {
      throw new Error('Votre dossier n’est pas encore prêt pour la sécurisation bancaire. Merci de revenir à l’étape précédente puis de réessayer.');
    }

    return confirmPaymentIntentApi(Number(preparedSubmission.id), paymentIntentId);
  }, [preparedSubmission]);

  const handleAuthorizedState = useCallback((event: 'resume' | 'authorized', meta: StripePaymentResolutionMeta) => {
    if (!preparedSubmission) {
      return;
    }

    if (event === 'resume') {
      frontendLog('payment_authorization_resume_ok', 'info', {
        prescription_id: preparedSubmission.id,
        uid: preparedSubmission.uid,
        payment_intent_id: meta.paymentIntentId,
        priority,
        status: meta.status,
      });
      return;
    }

    frontendLog('payment_authorization_ok', 'info', {
      prescription_id: preparedSubmission.id,
      uid: preparedSubmission.uid,
      payment_intent_id: meta.paymentIntentId,
      priority,
      status: meta.status,
    });
  }, [preparedSubmission, priority]);

  const handlePaymentError = useCallback(({ message }: { mode: 'tunnel' | 'patient_space'; error: unknown; message: string }) => {
    if (!preparedSubmission) {
      return;
    }

    frontendLog('payment_authorization_error', 'error', {
      prescription_id: preparedSubmission.id,
      uid: preparedSubmission.uid,
      priority,
      message,
    });
  }, [preparedSubmission, priority]);

  return (
    <StripePaymentModule
      mode="tunnel"
      title="Paiement sécurisé"
      intro="Votre carte est uniquement autorisée avant la transmission au médecin. Aucun débit n’est réalisé avant validation médicale."
      note="Carte bancaire sécurisée par Stripe • Autorisation uniquement • Aucun débit avant validation médicale"
      amountCents={selectedAmount}
      currency={pricing?.currency || 'EUR'}
      etaValue={selectedPriorityEta || null}
      summaryLoading={pricingLoading}
      billingName={billingName}
      billingEmail={billingEmail}
      fallbackPublishableKey={String(paymentsConfig?.publishable_key || '').trim() || null}
      prerequisiteError={prerequisiteError}
      createIntent={createIntent}
      confirmIntent={confirmIntent}
      onAuthorized={onAuthorized}
      onAuthorizedState={handleAuthorizedState}
      onErrorState={handlePaymentError}
      safeErrorMessage={toMedicalGradePaymentErrorMessage}
      onBack={onBack}
      backLabel="Modifier mon choix"
      submitIdleLabel="Valider et envoyer ma demande"
      submitBusyLabel="Validation sécurisée en cours…"
      mountLoadingLabel="Chargement du formulaire bancaire sécurisé…"
      submittingStatusLabel="Validation bancaire sécurisée en cours. Ne fermez pas la page et ne cliquez pas une seconde fois."
    />
  );
}

type StepSuccessProps = {
  submissionResult: SubmissionResult;
  copiedUid: boolean;
  patientPortalUrl: string | null;
  onCopyUid: () => void | Promise<void>;
  onReset: () => void;
};

function StepSuccess({
  submissionResult,
  copiedUid,
  patientPortalUrl,
  onCopyUid,
  onReset,
}: StepSuccessProps) {
  return (
    <div className="sp-app-stack">
      <section className="sp-app-card sp-app-card--success">
        <div className="sp-app-confirmation">
          <div className="sp-app-confirmation__title">Merci ! Votre demande est enregistrée.</div>
          <div className="sp-app-confirmation__label">Numéro de suivi</div>
          <div className="sp-app-confirmation__uid-row">
            <div className="sp-app-confirmation__uid">{submissionResult.uid}</div>
            <button
              type="button"
              className="sp-app-button sp-app-button--secondary sp-app-button--compact sp-app-button--copy"
              onClick={() => {
                void onCopyUid();
              }}
              aria-label="Copier le numéro de suivi"
              title="Copier"
            >
              {copiedUid ? 'Copié' : 'Copier'}
            </button>
          </div>
          <div className="sp-app-confirmation__text">
            Conservez ce numéro pour retrouver votre dossier et suivre son évolution depuis votre espace patient.
          </div>
          {patientPortalUrl ? (
            <div className="sp-app-actions sp-app-actions--start sp-app-confirmation__actions">
              <a href={patientPortalUrl} className="sp-app-button sp-app-button--primary">
                Accéder à mon espace patient
              </a>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function PublicFormApp() {
  const config = useMemo(() => getConfigOrThrow(), []);
  const notices = config.notices || {};
  const noticeEnabled = Boolean(notices?.enabled_form);
  const noticeTitle = String(notices?.title || '').trim();
  const noticeItems = String(notices?.items_text || '')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);

  const resumeDraftRefFromUrl = useMemo(() => resolveResumeDraftRefFromUrl(), []);
  const initialFlow = useMemo<FlowType | null>(() => resolveFlowFromUrl(), []);
  const requestedStepFromUrl = useMemo(() => resolveRequestedStepFromUrl(), []);
  const [stage, setStage] = useState<Stage>(() => (
    resumeDraftRefFromUrl
      ? 'priority_selection'
      : (requestedStepFromUrl && requestedStepFromUrl >= 2 && initialFlow ? 'form' : (initialFlow ? 'form' : 'choose'))
  ));
  const [pricing, setPricing] = useState<PricingConfig | null>(null);
  const [paymentsConfig, setPaymentsConfig] = useState<PaymentsConfig | null>(null);
  const [pricingLoading, setPricingLoading] = useState(true);

  const [flow, setFlow] = useState<FlowType | null>(() => (resumeDraftRefFromUrl ? null : initialFlow));
  const [priority, setPriority] = useState<'standard' | 'express'>('standard');

  const [fullName, setFullName] = useState<string>(() => (
    resumeDraftRefFromUrl ? '' : resolveStrictPatientProfileFullName(config)
  ));
  const [birthdate, setBirthdate] = useState<string>(() => {
    if (resumeDraftRefFromUrl) {
      return '';
    }
    const value = config.patientProfile?.birthdate_fr;
    return value ? String(value) : '';
  });
  const [medicalNotes, setMedicalNotes] = useState<string>(() => {
    if (resumeDraftRefFromUrl) {
      return '';
    }
    return String(
      config.patientProfile?.note
      || config.patientProfile?.medical_notes
      || config.patientProfile?.medicalNotes
      || '',
    ).trim();
  });

  const [items, setItems] = useState<MedicationItem[]>([]);
  const [medEditor, setMedEditor] = useState<MedEditorState | null>(null);
  const [files, setFiles] = useState<LocalUpload[]>([]);
  const [analysisInProgress, setAnalysisInProgress] = useState(false);
  const [analysisMessage, setAnalysisMessage] = useState<string | null>(null);
  const [rejectedFiles, setRejectedFiles] = useState<File[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitLoading, setSubmitLoading] = useState(false);
  const [preparedSubmission, setPreparedSubmission] = useState<SubmissionResult | null>(null);
  const [submissionResult, setSubmissionResult] = useState<SubmissionResult | null>(null);
  const [copiedUid, setCopiedUid] = useState(false);
  const [draftEmail, setDraftEmail] = useState<string>(() => (
    resumeDraftRefFromUrl
      ? ''
      : (resolveKnownPatientEmail(config) || normalizeKnownEmailValue(config.currentUser?.email) || '')
  ));
  const [draftEmailLocked, setDraftEmailLocked] = useState<boolean>(() => (
    !resumeDraftRefFromUrl && Boolean(resolveKnownPatientEmail(config) || normalizeKnownEmailValue(config.currentUser?.email))
  ));
  const [draftSending, setDraftSending] = useState(false);
  const [draftSent, setDraftSent] = useState(false);
  const [draftSuccessMessage, setDraftSuccessMessage] = useState<string | null>(null);
  const [draftResumeLoading, setDraftResumeLoading] = useState(Boolean(resumeDraftRefFromUrl));
  const [resumedDraftRef, setResumedDraftRef] = useState<string | null>(null);
  const submissionRefStateRef = useRef<SubmissionRefState>({ ref: null });
  const resumeDraftConsumedRef = useRef(false);
  const fullNameEditedRef = useRef(false);
  const birthdateEditedRef = useRef(false);
  const medicalNotesEditedRef = useRef(false);

  const compliance = config.compliance || {};
  const consentRequired = Boolean(compliance.consent_required);
  const [attestationNoProof, setAttestationNoProof] = useState(false);
  const [consentTelemedicine, setConsentTelemedicine] = useState(false);
  const [consentTruth, setConsentTruth] = useState(false);
  const [consentCgu, setConsentCgu] = useState(false);
  const [consentPrivacy, setConsentPrivacy] = useState(false);

  const clinicalState = useMemo<ClinicalState>(() => ({
    flow,
    priority,
    fullName,
    birthdate,
    medicalNotes,
    items,
    files,
    draftEmail,
    attestationNoProof,
    consentTelemedicine,
    consentTruth,
    consentCgu,
    consentPrivacy,
  }), [
    attestationNoProof,
    birthdate,
    consentCgu,
    consentPrivacy,
    consentTelemedicine,
    consentTruth,
    draftEmail,
    files,
    flow,
    fullName,
    items,
    medicalNotes,
    priority,
  ]);

  const uiState = useMemo<UIState>(() => ({
    medEditor,
    pricingLoading,
    analysisInProgress,
    analysisMessage,
    rejectedFiles,
    submitError,
    submitLoading,
    copiedUid,
    draftEmailLocked,
    draftSending,
    draftSent,
    draftSuccessMessage,
  }), [
    analysisInProgress,
    analysisMessage,
    copiedUid,
    draftEmailLocked,
    draftSending,
    draftSent,
    draftSuccessMessage,
    medEditor,
    pricingLoading,
    rejectedFiles,
    submitError,
    submitLoading,
  ]);

  const workflowState = useMemo<WorkflowState>(() => ({
    stage,
    pricing,
    paymentsConfig,
    preparedSubmission,
    submissionResult,
    draftResumeLoading,
    resumedDraftRef,
    submissionRef: submissionRefStateRef.current.ref,
  }), [
    draftResumeLoading,
    paymentsConfig,
    preparedSubmission,
    pricing,
    resumedDraftRef,
    stage,
    submissionResult,
  ]);

  const { loadSubmissionDraft, saveSubmissionDraft, uploadDraftArtifacts } = useDraftNetwork({
    loadSubmissionDraftApi,
    saveSubmissionDraftApi,
    directSubmissionArtifactUpload,
  });
  const { createSubmission, uploadIntakeFiles, finalizeSubmission } = useSubmissionNetwork({
    createSubmissionApi,
    directSubmissionArtifactUpload,
    analyzeArtifactApi,
    finalizeSubmissionApi,
  });

  useEffect(() => {
    if (!medEditor) {
      return;
    }

    if (!Number.isFinite(medEditor.detailId) || medEditor.detailId < 1) {
      setMedEditor(null);
      return;
    }

    if (!Number.isInteger(medEditor.index) || medEditor.index < 0 || medEditor.index >= items.length) {
      setMedEditor(null);
      return;
    }

    const currentItem = items[medEditor.index];
    if (!currentItem) {
      setMedEditor(null);
      return;
    }

    const currentName = aiSafeText(currentItem.label);
    const editorName = aiSafeText(medEditor.medicationName);

    if (currentName && editorName && currentName !== editorName) {
      setMedEditor((current) => {
        if (!current) {
          return null;
        }
        return {
          ...current,
          medicationName: currentName,
        };
      });
    }
  }, [items, medEditor]);

  useEffect(() => {
    let cancelled = false;

    async function loadMeta(): Promise<void> {
      setPricingLoading(true);
      try {
        const [nextPricing, nextPayments] = await Promise.all([
          getPricingApi(),
          getPaymentsConfigApi(),
        ]);
        if (!cancelled) {
          setPricing(nextPricing);
          setPaymentsConfig(nextPayments);
        }
      } catch {
        if (!cancelled) {
          setPaymentsConfig({
            enabled: false,
            publishable_key: '',
            provider: 'stripe',
            capture_method: 'manual',
          });
        }
      } finally {
        if (!cancelled) {
          setPricingLoading(false);
        }
      }
    }

    void loadMeta();

    return () => {
      cancelled = true;
    };
  }, []);

  const isLoggedIn = Boolean(config.currentUser?.id && Number(config.currentUser.id) > 0);
  const isDraftMode = !isLoggedIn;

  const handleFullNameChange = useCallback((value: string) => {
    fullNameEditedRef.current = true;
    setFullName(value);
  }, []);

  const handleBirthdateChange = useCallback((value: string) => {
    birthdateEditedRef.current = true;
    setBirthdate(value);
  }, []);

  const handleMedicalNotesChange = useCallback((value: string) => {
    medicalNotesEditedRef.current = true;
    setMedicalNotes(value);
  }, []);

  const hydratePatientProfileFields = useCallback((snapshot: PatientProfileSnapshot, options?: { force?: boolean }) => {
    const force = Boolean(options?.force);
    if (!force && (resumeDraftRefFromUrl || resumedDraftRef || draftResumeLoading)) {
      return;
    }

    const nextFullName = safePatientNameValue(snapshot.fullName);
    const nextBirthdate = String(snapshot.birthdate || '').trim();
    const nextMedicalNotes = String(snapshot.medicalNotes || '').trim();

    if ((force || !fullNameEditedRef.current) && nextFullName !== safePatientNameValue(fullName)) {
      setFullName(nextFullName);
    }

    if ((force || !birthdateEditedRef.current) && nextBirthdate !== String(birthdate || '').trim()) {
      setBirthdate(nextBirthdate);
    }

    if ((force || !medicalNotesEditedRef.current) && nextMedicalNotes !== String(medicalNotes || '').trim()) {
      setMedicalNotes(nextMedicalNotes);
    }
  }, [birthdate, draftResumeLoading, fullName, medicalNotes, resumeDraftRefFromUrl, resumedDraftRef]);

  useEffect(() => {
    if (stage !== 'form' || resumeDraftRefFromUrl || resumedDraftRef || draftResumeLoading) {
      return;
    }

    hydratePatientProfileFields(resolveLatestPatientProfileSnapshot(config));
  }, [config, config.patientProfile, draftResumeLoading, hydratePatientProfileFields, resumeDraftRefFromUrl, resumedDraftRef, stage]);

  useEffect(() => {
    const handlePatientProfileUpdated = (rawEvent: Event): void => {
      if (stage !== 'form' || resumeDraftRefFromUrl || resumedDraftRef || draftResumeLoading) {
        return;
      }

      const event = rawEvent as CustomEvent<{ profile?: Record<string, unknown> }>;
      const detail = event && typeof event.detail === 'object' ? event.detail : undefined;
      const profile = detail && detail.profile && typeof detail.profile === 'object'
        ? detail.profile as Record<string, unknown>
        : null;
      const snapshot = profile
        ? resolvePatientProfileSnapshotFromSource(profile)
        : resolveLatestPatientProfileSnapshot(config);

      hydratePatientProfileFields(snapshot);
    };

    window.addEventListener('sosprescription:patient-profile-updated', handlePatientProfileUpdated as EventListener);
    return () => {
      window.removeEventListener('sosprescription:patient-profile-updated', handlePatientProfileUpdated as EventListener);
    };
  }, [config, draftResumeLoading, hydratePatientProfileFields, resumeDraftRefFromUrl, resumedDraftRef, stage]);

  useEffect(() => {
    if (resumeDraftRefFromUrl) {
      return;
    }

    const knownEmail = resolveKnownPatientEmail(config);
    if (!knownEmail) {
      return;
    }

    setDraftEmail((current) => normalizeKnownEmailValue(current) || knownEmail);
    setDraftEmailLocked(true);
  }, [config.currentUser?.email, resumeDraftRefFromUrl]);

  useEffect(() => {
    const normalized = normalizeKnownEmailValue(draftEmail);
    if (normalized) {
      writeKnownEmailToBrowserStorage(normalized);
      return;
    }

    if (!resumeDraftRefFromUrl) {
      writeKnownEmailToBrowserStorage(null);
    }
  }, [draftEmail, resumeDraftRefFromUrl]);

  useEffect(() => {
    if (!resumeDraftRefFromUrl) {
      return;
    }

    clearAppBrowserStateStorage();
  }, [resumeDraftRefFromUrl]);
  const selectedAmount = useMemo(() => {
    if (!pricing) {
      return null;
    }
    return priority === 'express' ? pricing.express_cents : pricing.standard_cents;
  }, [pricing, priority]);
  const selectedPriorityEta = useMemo(
    () => describePriorityTurnaround(priority, pricing),
    [priority, pricing],
  );
  const ageLabel = useMemo(() => ageLabelFromBirthdate(birthdate), [birthdate]);

  useEffect(() => {
    const draftRef = resumeDraftRefFromUrl;
    if (!isLoggedIn || !draftRef || resumeDraftConsumedRef.current) {
      return;
    }

    resumeDraftConsumedRef.current = true;
    let cancelled = false;

    async function resumeDraft(): Promise<void> {
      clearAppBrowserStateStorage();
      fullNameEditedRef.current = false;
      birthdateEditedRef.current = false;
      medicalNotesEditedRef.current = false;
      submissionRefStateRef.current = { ref: draftRef };
      setFlow(null);
      setPriority('standard');
      setFullName('');
      setBirthdate('');
      setMedicalNotes('');
      setItems([]);
      setFiles([]);
      setRejectedFiles([]);
      setAnalysisInProgress(false);
      setAnalysisMessage(null);
      setPreparedSubmission(null);
      setSubmissionResult(null);
      setCopiedUid(false);
      setDraftEmail('');
      setDraftSending(false);
      setDraftSent(false);
      setDraftSuccessMessage(null);
      setResumedDraftRef(draftRef);
      setAttestationNoProof(false);
      setConsentTelemedicine(false);
      setConsentTruth(false);
      setConsentCgu(false);
      setConsentPrivacy(false);
      setDraftResumeLoading(true);
      setSubmitError(null);

      try {
        // Repli sécurisé : le reset et l’hydratation du state restent locaux à PublicFormApp.
        const payload = await loadSubmissionDraft(draftRef);
        if (cancelled) {
          return;
        }

        const hydratedDraft = hydrateStoredDraftPayload({
          payload,
          fallbackEmail: resolveKnownPatientEmail(config) || normalizeKnownEmailValue(String(config.currentUser?.email || '').trim()) || '',
        });

        if (hydratedDraft.flow) {
          setFlow(hydratedDraft.flow);
        }
        setPriority(hydratedDraft.priority);
        if (hydratedDraft.fullName) {
          setFullName(hydratedDraft.fullName);
        }
        if (hydratedDraft.birthdate) {
          setBirthdate(hydratedDraft.birthdate);
        }
        setMedicalNotes(hydratedDraft.medicalNotes);
        setItems(hydratedDraft.items);
        setFiles(hydratedDraft.files);
        setRejectedFiles([]);
        setAnalysisMessage(null);
        setPreparedSubmission(null);
        setSubmissionResult(null);
        setDraftEmail(hydratedDraft.draftEmail);
        setDraftEmailLocked(hydratedDraft.draftEmailLocked);
        setDraftSent(false);
        setDraftSuccessMessage(null);
        setAttestationNoProof(hydratedDraft.attestationNoProof);
        setConsentTelemedicine(hydratedDraft.consentTelemedicine);
        setConsentTruth(hydratedDraft.consentTruth);
        setConsentCgu(hydratedDraft.consentCgu);
        setConsentPrivacy(hydratedDraft.consentPrivacy);

        submissionRefStateRef.current = { ref: draftRef };
        setResumedDraftRef(draftRef);
        setStage('priority_selection');

        try {
          const url = new URL(window.location.href);
          url.searchParams.delete('resume_draft');
          window.history.replaceState({}, document.title, url.toString());
        } catch {
          // noop
        }
      } catch (error) {
        if (!cancelled) {
          resumeDraftConsumedRef.current = false;
          setSubmitError('Nous n’avons pas pu reprendre votre brouillon. Merci de demander un nouveau lien de connexion.');
        }
      } finally {
        if (!cancelled) {
          setDraftResumeLoading(false);
        }
      }
    }

    void resumeDraft();

    return () => {
      cancelled = true;
    };
  }, [config.currentUser?.email, isLoggedIn, loadSubmissionDraft, resumeDraftRefFromUrl]);

  const submitBlockInfo = useMemo(() => buildSubmitBlockInfo({
    loggedIn: isLoggedIn,
    flow,
    fullname: fullName,
    birthdate,
    itemsCount: items.length,
    filesCount: files.length,
    attestationNoProof,
    consentRequired,
    consentTelemedicine,
    consentTruth,
    consentCgu,
    consentPrivacy,
    analysisInProgress,
    allowProofWithoutDetectedItems: Boolean(resumedDraftRef),
  }), [
    analysisInProgress,
    attestationNoProof,
    birthdate,
    consentCgu,
    consentPrivacy,
    consentRequired,
    consentTelemedicine,
    consentTruth,
    files.length,
    flow,
    fullName,
    isLoggedIn,
    items.length,
    resumedDraftRef,
  ]);

  const addMedication = useCallback((medication: MedicationSearchResult) => {
    const nextItem: MedicationItem = {
      cis: medication.cis,
      cip13: medication.cip13 || null,
      label: medication.label,
      schedule: normalizeSchedule({
        nb: 1,
        freqUnit: 'jour',
        durationVal: 5,
        durationUnit: 'jour',
        times: ['08:00'],
        doses: ['1'],
        note: '',
        autoTimesEnabled: true,
        start: '08:00',
        end: '20:00',
          }),
    };

    setItems((current) => {
      const exists = current.some((entry) => (
        entry.cis && nextItem.cis
          ? entry.cis === nextItem.cis
          : entry.label.trim().toLowerCase() === nextItem.label.trim().toLowerCase()
      ));
      return exists ? current : [...current, nextItem];
    });
  }, []);

  const updateMedication = useCallback((index: number, patch: Partial<MedicationItem>) => {
    setItems((current) => current.map((item, itemIndex) => (
      itemIndex === index
        ? {
          ...item,
          ...patch,
        }
        : item
    )));
  }, []);

  const removeMedication = useCallback((index: number) => {
    setItems((current) => current.filter((_, itemIndex) => itemIndex !== index));
  }, []);

  const ensureSubmissionRef = useCallback(async (): Promise<string> => {
    const currentRef = String(submissionRefStateRef.current.ref || '').trim();
    if (currentRef) {
      return currentRef;
    }

    if (!clinicalState.flow) {
      throw new Error('Référence de soumission manquante.');
    }

    const initResponse = await createSubmission({
      flow,
      priority,
    });
    const nextRef = String(initResponse?.submission_ref || '').trim();
    if (!nextRef) {
      throw new Error('Référence de soumission manquante.');
    }

    submissionRefStateRef.current = { ref: nextRef };
    return nextRef;
  }, [createSubmission, flow, priority]);

  const handleFilesSelected = useCallback(async (list: FileList | null) => {
    if (!list || list.length === 0 || flow !== 'ro_proof') {
      return;
    }

    const nextUploads = Array.from(list).map(createLocalUpload);
    if (nextUploads.length === 0) {
      return;
    }

    setSubmitError(null);
    setRejectedFiles([]);
    setAnalysisMessage(null);
    setFiles((current) => [...current, ...nextUploads]);

    if (!isLoggedIn) {
      setAnalysisInProgress(false);
      setAnalysisMessage('Les documents seront joints à votre dossier après validation de votre adresse.');
      return;
    }

    setAnalysisInProgress(true);

    const rejected: File[] = [];
    let firstError: string | null = null;
    let mergedInfo = false;

    try {
      const submissionRef = await ensureSubmissionRef();

      // Repli sécurisé : les mutations UI par fichier restent locales pour préserver le timing READY / erreur.
      await uploadIntakeFiles(nextUploads, submissionRef, (result) => {
        if (result.error) {
          rejected.push(result.entry.file);
          if (!firstError) {
            firstError = toPatientSafeArtifactErrorMessage(result.error);
          }
          return;
        }

        const analysis = result.analysis;
        const aiItems = aiMedicationsToItems(Array.isArray(analysis?.medications) ? analysis.medications : []);

        if (Boolean(analysis && analysis.ok === false) || aiItems.length < 1) {
          rejected.push(result.entry.file);
          if (!firstError) {
            firstError = toPatientSafeArtifactErrorMessage(
              typeof analysis?.message === 'string' && analysis.message.trim() !== ''
                ? new Error(analysis.message.trim())
                : new Error('Lecture du document impossible.'),
            );
          }
          return;
        }

        mergedInfo = true;
        setItems((current) => mergeMedicationItems(current, aiItems));
        setFiles((current) => current.map((file) => (
          file.id === result.entry.id
            ? {
              ...file,
              status: 'READY',
            }
            : file
        )));
      });

      setRejectedFiles((current) => mergeRejectedFiles(current, rejected));
      if (mergedInfo) {
        setAnalysisMessage('Traitement détecté et pré-rempli.');
      } else {
        setAnalysisMessage(null);
      }

      if (firstError) {
        setSubmitError(firstError);
      }
    } catch (error) {
      setRejectedFiles((current) => mergeRejectedFiles(current, nextUploads.map((entry) => entry.file)));
      setAnalysisMessage(null);
      const message = toPatientSafeSubmissionErrorMessage(error);
      setSubmitError(
        message.includes('connecter')
          ? message
          : 'Nous n’avons pas pu enregistrer votre document pour le moment. Merci de réessayer.',
      );
    } finally {
      setAnalysisInProgress(false);
    }
  }, [ensureSubmissionRef, flow, isLoggedIn, uploadIntakeFiles]);

  const resetToChoose = useCallback(() => {
    const profileSnapshot = resolveLatestPatientProfileSnapshot(config);
    fullNameEditedRef.current = false;
    birthdateEditedRef.current = false;
    medicalNotesEditedRef.current = false;
    setStage('choose');
    setFlow(null);
    setPriority('standard');
    setFullName(profileSnapshot.fullName);
    setBirthdate(profileSnapshot.birthdate);
    setMedicalNotes(profileSnapshot.medicalNotes);
    setItems([]);
    setFiles([]);
    setRejectedFiles([]);
    setAnalysisMessage(null);
    setSubmitError(null);
    setPreparedSubmission(null);
    setSubmissionResult(null);
    setCopiedUid(false);
    const nextKnownEmail = resolveKnownPatientEmail(config) || normalizeKnownEmailValue(config.currentUser?.email) || '';
    setDraftEmail(nextKnownEmail);
    setDraftEmailLocked(Boolean(nextKnownEmail));
    setDraftSending(false);
    setDraftSent(false);
    setDraftSuccessMessage(null);
    setResumedDraftRef(null);
    submissionRefStateRef.current = { ref: null };
    setAttestationNoProof(false);
    setConsentTelemedicine(false);
    setConsentTruth(false);
    setConsentCgu(false);
    setConsentPrivacy(false);
  }, [config]);

  const copyUid = useCallback(async () => {
    if (!submissionResult?.uid) {
      return;
    }
    try {
      await navigator.clipboard.writeText(submissionResult.uid);
      setCopiedUid(true);
      window.setTimeout(() => setCopiedUid(false), 1500);
    } catch {
      setCopiedUid(false);
    }
  }, [submissionResult?.uid]);

  const handleSelectFlow = useCallback((nextFlow: FlowType) => {
    setFlow(nextFlow);
    setFiles([]);
    setRejectedFiles([]);
    setAnalysisMessage(null);
    setSubmitError(null);
    setPreparedSubmission(null);
    setSubmissionResult(null);
    setDraftSending(false);
    setDraftSent(false);
    setDraftSuccessMessage(null);
    setResumedDraftRef(null);
    submissionRefStateRef.current = { ref: null };
    setStage('form');
  }, []);

  const handleContinueToPriority = useCallback(() => {
    setSubmitError(null);

    if (!submitBlockInfo.ok || !clinicalState.flow) {
      setSubmitError(
        submitBlockInfo.message || 'Le formulaire est incomplet. Merci de vérifier les champs requis.',
      );
      return;
    }

    const patientFullName = safePatientNameValue(clinicalState.fullName);
    const patientName = splitPatientNameValue(patientFullName);
    if (patientFullName.length < 3 || patientName.firstName === '' || patientName.lastName === '') {
      setSubmitError('Merci de saisir le prénom et le nom du patient, et non une adresse e-mail.');
      return null;
    }

    setStage('priority_selection');
  }, [clinicalState.flow, clinicalState.fullName, submitBlockInfo]);

  const handleSendDraftLink = useCallback(async () => {
    setSubmitError(null);
    setDraftSuccessMessage(null);
    setDraftSent(false);

    if (!clinicalState.flow) {
      setSubmitError('Merci de choisir un parcours avant de continuer.');
      return;
    }

    if (!submitBlockInfo.ok) {
      setSubmitError(
        submitBlockInfo.message || 'Le formulaire est incomplet. Merci de vérifier les champs requis.',
      );
      return;
    }

    const patientFullName = safePatientNameValue(clinicalState.fullName);
    const patientName = splitPatientNameValue(patientFullName);
    if (patientFullName.length < 3 || patientName.firstName === '' || patientName.lastName === '') {
      setSubmitError('Merci de saisir le prénom et le nom du patient, et non une adresse e-mail.');
      return;
    }

    const email = String(clinicalState.draftEmail || '').trim().toLowerCase();
    if (!isEmailLikeValue(email)) {
      setSubmitError('Merci de renseigner une adresse e-mail valide.');
      return;
    }

    const activeFlow = clinicalState.flow;
    if (!activeFlow) {
      setSubmitError('Merci de choisir un parcours avant de continuer.');
      return;
    }

    const draftClinicalState: ClinicalState & { flow: TunnelFlowType } = {
      ...clinicalState,
      flow: activeFlow,
      draftEmail: email,
    };
    const fileManifest = buildDraftFileManifest(draftClinicalState.files);

    setDraftSending(true);

    try {
      const response = await saveSubmissionDraft(buildDraftPayload({
        clinicalState: draftClinicalState,
        redirectTo: buildCurrentFormRedirectUrl(),
        consentRequired,
        consentTimestamp: new Date().toISOString(),
        cguVersion: compliance?.cgu_version,
        privacyVersion: compliance?.privacy_version,
        fileManifest,
      }));

      const submissionRef = typeof response.submission_ref === 'string' ? response.submission_ref.trim() : '';
      if (!submissionRef) {
        throw new Error('Référence de brouillon manquante.');
      }

      submissionRefStateRef.current = { ref: submissionRef };

      const uploadableEntries = draftClinicalState.files.filter((entry) => entry.file instanceof File && Number(entry.file.size || 0) > 0);
      const failedUploads: string[] = [];

      // Repli sécurisé : les statuts READY / QUEUED restent pilotés depuis PublicFormApp.
      await uploadDraftArtifacts(uploadableEntries, submissionRef, (result) => {
        if (!result.error) {
          setFiles((current) => current.map((file) => (
            file.id === result.entry.id
              ? {
                ...file,
                status: 'READY',
              }
              : file
          )));
          return;
        }

        failedUploads.push(result.entry.original_name || result.entry.file.name || 'document');
        setFiles((current) => current.map((file) => (
          file.id === result.entry.id
            ? {
              ...file,
              status: 'QUEUED',
            }
            : file
        )));
      });

      setDraftEmail(email);
      setDraftEmailLocked(true);
      setDraftSent(true);

      if (failedUploads.length > 0) {
        setAnalysisMessage('Certains justificatifs devront être ajoutés à nouveau après connexion.');
        setDraftSuccessMessage('Lien de connexion envoyé. Vérifiez vos emails pour valider votre demande. Certains justificatifs devront être ajoutés à nouveau après connexion.');
      } else if (uploadableEntries.length > 0) {
        setAnalysisMessage('Les justificatifs seront vérifiés après connexion.');
        setDraftSuccessMessage('Lien de connexion envoyé. Vérifiez vos emails pour valider votre demande.');
      } else {
        setDraftSuccessMessage('Lien de connexion envoyé. Vérifiez vos emails pour valider votre demande.');
      }
    } catch (error) {
      const message = toPatientSafeSubmissionErrorMessage(error);
      setSubmitError(
        message.includes('connexion')
          ? message
          : 'Le lien de connexion n’a pas pu être envoyé. Merci de réessayer.',
      );
    } finally {
      setDraftSending(false);
    }
  }, [clinicalState, compliance?.cgu_version, compliance?.privacy_version, consentRequired, saveSubmissionDraft, submitBlockInfo, uploadDraftArtifacts]);

  const prepareSubmissionForPayment = useCallback(async (): Promise<SubmissionResult | null> => {
    setSubmitError(null);

    if (workflowState.preparedSubmission && Number(workflowState.preparedSubmission.id) > 0) {
      return workflowState.preparedSubmission;
    }

    setSubmitError(null);

    frontendLog('submit_clicked', 'info', {
      flow: clinicalState.flow || null,
      stage: workflowState.stage,
      logged_in: isLoggedIn,
      meds_count: clinicalState.items.length,
      files_count: clinicalState.files.length,
    });

    if (!submitBlockInfo.ok || !clinicalState.flow) {
      const message = submitBlockInfo.message || 'Le formulaire est incomplet. Merci de vérifier les champs requis.';
      frontendLog('submit_blocked', 'warning', {
        flow: clinicalState.flow || null,
        stage: workflowState.stage,
        reason_code: submitBlockInfo.code || 'unknown',
        reasons: submitBlockInfo.reasons.map((reason) => reason.code),
        message,
      });
      setSubmitError(message);
      return null;
    }

    const patientFullName = safePatientNameValue(clinicalState.fullName);
    const patientName = splitPatientNameValue(patientFullName);
    if (patientFullName.length < 3 || patientName.firstName === '' || patientName.lastName === '') {
      setSubmitError('Merci de saisir le prénom et le nom du patient, et non une adresse e-mail.');
      return null;
    }

    setSubmitLoading(true);

    try {
      const submissionRef = await ensureSubmissionRef();

      const activeFlow = clinicalState.flow;
      if (!activeFlow) {
        throw new Error('Merci de choisir un parcours avant de continuer.');
      }

      const finalizeClinicalState: ClinicalState & { flow: TunnelFlowType } = {
        ...clinicalState,
        flow: activeFlow,
      };
      const finalizePayload = buildFinalizePayload({
        clinicalState: finalizeClinicalState,
        consentRequired,
        consentTimestamp: new Date().toISOString(),
        cguVersion: compliance?.cgu_version,
        privacyVersion: compliance?.privacy_version,
      });

      const allowProofOnlyFinalize = finalizeClinicalState.flow === 'ro_proof' && finalizeClinicalState.files.length > 0 && Boolean(workflowState.resumedDraftRef);
      if ((!Array.isArray(finalizePayload.items) || finalizePayload.items.length < 1) && !allowProofOnlyFinalize) {
        throw new Error(
          finalizeClinicalState.flow === 'ro_proof'
            ? 'Aucun traitement n’a pu être détecté. Merci d’ajouter un document plus lisible.'
            : 'Merci d’ajouter au moins un médicament.',
        );
      }

      frontendLog('submission_finalize_start', 'info', {
        flow: finalizeClinicalState.flow,
        items_count: finalizePayload.items.length,
        files_count: finalizeClinicalState.files.length,
      });

      const finalized = await finalizeSubmission(submissionRef, finalizePayload);
      const localPrescriptionId = Number((finalized as { local_prescription_id?: unknown }).local_prescription_id || finalized.id || 0);
      const result: SubmissionResult = {
        id: Number.isFinite(localPrescriptionId) ? localPrescriptionId : 0,
        uid: String(finalized.uid || ''),
        status: String((finalized as { local_status?: unknown }).local_status || finalized.status || 'payment_pending'),
        created_at: typeof finalized.created_at === 'string' ? finalized.created_at : undefined,
      };

      frontendLog('submission_finalize_ok', 'info', {
        flow: finalizeClinicalState.flow,
        prescription_id: result.id || null,
        uid: result.uid || null,
        status: result.status || null,
      });

      if (result.id < 1) {
        throw new Error('Prescription locale introuvable après préparation du paiement.');
      }

      setPreparedSubmission(result);
      return result;
    } catch (error) {
      const message = toPatientSafeSubmissionErrorMessage(error);
      frontendLog('submission_error', 'error', {
        flow: clinicalState.flow || null,
        stage: workflowState.stage,
        message,
        meds_count: clinicalState.items.length,
        files_count: clinicalState.files.length,
      });
      setSubmitError(message);
      return null;
    } finally {
      setSubmitLoading(false);
    }
  }, [clinicalState, compliance?.cgu_version, compliance?.privacy_version, consentRequired, ensureSubmissionRef, finalizeSubmission, isLoggedIn, submitBlockInfo, workflowState]);

  const handleContinueToPaymentAuth = useCallback(async () => {
    setSubmitError(null);

    if (uiState.pricingLoading) {
      setSubmitError('Le montant de votre demande est en cours de préparation. Merci de patienter quelques instants.');
      return;
    }

    if (!pricing || selectedAmount == null) {
      setSubmitError('Le montant de votre demande n’est pas disponible pour le moment. Merci de réessayer.');
      return;
    }

    if (isDraftMode) {
      setStage('payment_auth');
      return;
    }

    if (!paymentsConfig?.enabled) {
      setSubmitError('La sécurisation bancaire est actuellement indisponible. Merci de réessayer un peu plus tard.');
      return;
    }

    if (workflowState.preparedSubmission && Number(workflowState.preparedSubmission.id) > 0) {
      setStage('payment_auth');
      return;
    }

    const nextSubmission = await prepareSubmissionForPayment();
    if (nextSubmission && Number(nextSubmission.id) > 0) {
      setStage('payment_auth');
    }
  }, [isDraftMode, paymentsConfig?.enabled, prepareSubmissionForPayment, pricing, selectedAmount, uiState.pricingLoading, workflowState.preparedSubmission]);

  const handlePaymentAuthorized = useCallback(() => {
    if (!preparedSubmission || Number(preparedSubmission.id) < 1) {
      setSubmitError('Impossible de finaliser la transmission : demande préparée introuvable.');
      return;
    }

    setSubmitError(null);
    setSubmissionResult({
      ...preparedSubmission,
      status: 'pending',
    });
    setStage('done');
  }, [preparedSubmission]);

  const handleBackToClinicalForm = useCallback(() => {
    setPreparedSubmission(null);
    setSubmitError(null);
    setDraftSent(false);
    setDraftSuccessMessage(null);
    setStage('form');
  }, []);

  const patientPortalUrl = useMemo(() => {
    const base = config.urls?.patientPortal || null;
    if (!submissionResult?.uid || !base) {
      return null;
    }
    return `${base}${base.includes('?') ? '&' : '?'}rx_uid=${encodeURIComponent(String(submissionResult.uid))}`;
  }, [config.urls?.patientPortal, submissionResult?.uid]);

  const stageEntries: Array<{ key: Stage; label: string }> = [
    { key: 'choose', label: 'Type de demande' },
    { key: 'form', label: 'Informations patient' },
    { key: 'priority_selection', label: 'Délai' },
    { key: 'payment_auth', label: isDraftMode ? 'Validation' : 'Paiement sécurisé' },
    { key: 'done', label: 'Confirmation' },
  ];
  const activeStageIndex = stageEntries.findIndex((entry) => entry.key === stage);

  return (
    <div
      className="sp-app-root sp-app-theme"
      data-app="form"
      data-layout="workspace"
      data-flow={flow || 'none'}
      data-stage={stage}
      data-stage-index={activeStageIndex >= 0 ? activeStageIndex + 1 : 0}
    >
      <div
        className="sp-app-container"
        data-stage-surface={
          stage === 'payment_auth'
            ? 'payment'
            : stage === 'priority_selection'
              ? 'priority'
              : stage === 'done'
                ? 'confirmation'
                : stage === 'form'
                  ? 'clinical'
                  : 'choice'
        }
      >
        <header className="sp-app-header">
          <div className="sp-app-header__eyebrow">Médecins inscrits à l’Ordre · Données sécurisées HDS</div>
          <p className="sp-app-header__subtitle">
            Validation médicale sécurisée pour la continuité de votre traitement.
          </p>
        </header>

        <div className="sp-app-stagebar" aria-label="Progression de la demande" role="list">
          {stageEntries.map((entry, index) => (
            <div
              key={entry.key}
              className={cx(
                'sp-app-stagebar__item',
                index < activeStageIndex && 'is-complete',
                index === activeStageIndex && 'is-active',
              )}
              role="listitem"
              aria-current={index === activeStageIndex ? 'step' : undefined}
              aria-label={`Étape ${index + 1} sur ${stageEntries.length} : ${entry.label}`}
            >
              <div className="sp-app-stagebar__badge">{index + 1}</div>
              <div className="sp-app-stagebar__label">{entry.label}</div>
            </div>
          ))}
        </div>

        {noticeEnabled && noticeItems.length > 0 ? (
          <div className="sp-app-block">
            <Notice variant="info">
              {noticeTitle ? <div className="sp-app-notice__title">{noticeTitle}</div> : null}
              <ul className="sp-app-list">
                {noticeItems.map((item, index) => (
                  <li key={`${item}-${index}`}>{item}</li>
                ))}
              </ul>
            </Notice>
          </div>
        ) : null}


        {!isLoggedIn ? (
          <div className="sp-app-block">
            <Notice variant="info">
              Vous pouvez compléter votre dossier sans créer de compte au préalable.
              <br />
              Nous vous demanderons simplement de valider votre adresse e-mail à la fin du parcours pour envoyer votre dossier.
            </Notice>
          </div>
        ) : null}

        {draftResumeLoading ? (
          <div className="sp-app-block">
            <Notice variant="info">Reprise du brouillon en cours…</Notice>
          </div>
        ) : null}

        {submitError ? (
          <div className="sp-app-block">
            <Notice variant="error">{submitError}</Notice>
          </div>
        ) : null}

        {stage === 'choose' ? (
          <StepFlowChoice flow={flow} onSelectFlow={handleSelectFlow} />
        ) : null}

        {stage === 'form' && flow ? (
          <StepClinicalData
            flow={flow}
            isLoggedIn={isLoggedIn}
            analysisInProgress={analysisInProgress}
            fullName={fullName}
            birthdate={birthdate}
            draftEmail={draftEmail}
            draftEmailLocked={draftEmailLocked}
            ageLabel={ageLabel}
            medicalNotes={medicalNotes}
            items={items}
            files={files}
            rejectedFiles={rejectedFiles}
            analysisMessage={analysisMessage}
            attestationNoProof={attestationNoProof}
            consentRequired={consentRequired}
            consentTelemedicine={consentTelemedicine}
            consentTruth={consentTruth}
            consentCgu={consentCgu}
            consentPrivacy={consentPrivacy}
            compliance={compliance}
            submitLoading={submitLoading}
            onBackToChoice={() => setStage('choose')}
            onFullNameChange={handleFullNameChange}
            onBirthdateChange={handleBirthdateChange}
            onDraftEmailChange={setDraftEmail}
            onUnlockDraftEmail={() => setDraftEmailLocked(false)}
            onMedicalNotesChange={handleMedicalNotesChange}
            onFilesSelected={handleFilesSelected}
            onRemoveFile={(fileId) => {
              setFiles((current) => current.filter((entry) => entry.id !== fileId));
            }}
            onAddMedication={addMedication}
            onUpdateMedication={updateMedication}
            onRemoveMedication={removeMedication}
            onAttestationChange={setAttestationNoProof}
            onConsentTelemedicineChange={setConsentTelemedicine}
            onConsentTruthChange={setConsentTruth}
            onConsentCguChange={setConsentCgu}
            onConsentPrivacyChange={setConsentPrivacy}
            onContinue={handleContinueToPriority}
          />
        ) : null}

        {stage === 'priority_selection' && flow ? (
          <StepPrioritySelection
            flow={flow}
            itemsCount={items.length}
            filesCount={files.length}
            pricingLoading={pricingLoading}
            pricing={pricing}
            priority={priority}
            paymentsConfig={paymentsConfig}
            selectedAmount={selectedAmount}
            selectedPriorityEta={selectedPriorityEta}
            onPriorityChange={setPriority}
            onBack={handleBackToClinicalForm}
            onContinue={handleContinueToPaymentAuth}
            continueDisabled={submitLoading || pricingLoading || !pricing}
          />
        ) : null}

        {stage === 'payment_auth' && flow ? (
          isDraftMode ? (
            <StepDraftValidation
              flow={flow}
              fullName={fullName}
              birthdate={birthdate}
              itemsCount={items.length}
              filesCount={files.length}
              priority={priority}
              pricingLoading={pricingLoading}
              pricing={pricing}
              selectedAmount={selectedAmount}
              selectedPriorityEta={selectedPriorityEta}
              draftEmail={draftEmail}
              draftEmailLocked={draftEmailLocked}
              draftSending={draftSending}
              draftSent={draftSent}
              draftSuccessMessage={draftSuccessMessage}
              onDraftEmailChange={setDraftEmail}
              onUnlockDraftEmail={() => setDraftEmailLocked(false)}
              onBack={() => setStage('priority_selection')}
              onSend={handleSendDraftLink}
            />
          ) : (
            <StepPaymentAuth
              flow={flow}
              fullName={fullName}
              birthdate={birthdate}
              itemsCount={items.length}
              filesCount={files.length}
              priority={priority}
              pricingLoading={pricingLoading}
              pricing={pricing}
              selectedAmount={selectedAmount}
              selectedPriorityEta={selectedPriorityEta}
              paymentsConfig={paymentsConfig}
              preparedSubmission={preparedSubmission}
              onBack={() => setStage('priority_selection')}
              onAuthorized={handlePaymentAuthorized}
            />
          )
        ) : null}

        {stage === 'done' && submissionResult ? (
          <StepSuccess
            submissionResult={submissionResult}
            copiedUid={copiedUid}
            patientPortalUrl={patientPortalUrl}
            onCopyUid={copyUid}
            onReset={resetToChoose}
          />
        ) : null}
      </div>
    </div>
  );
}

function renderFatal(container: HTMLElement, message: string): void {
  container.innerHTML = '';
  const notice = document.createElement('div');
  notice.style.padding = '12px';
  notice.style.border = '1px solid #e5e7eb';
  notice.style.borderRadius = '8px';
  notice.style.background = '#fff';
  notice.style.fontFamily = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  notice.style.fontSize = '14px';
  notice.style.color = '#111827';
  notice.textContent = message;
  container.appendChild(notice);
}

type ExternalProfileAccordionOptions = {
  collapsedByDefault: boolean;
};

const EXTERNAL_PROFILE_COPY = 'Ces informations prérempliront votre prochaine demande d’ordonnance.';

function normalizeExternalProfileWording(card: HTMLElement): void {
  if (card.dataset.spProfileCopyFixed === '1') {
    return;
  }

  const helpTargets = Array.from(card.querySelectorAll('p, small, span, div'));
  for (const node of helpTargets) {
    if (!(node instanceof HTMLElement)) {
      continue;
    }

    const text = String(node.textContent || '').trim();
    if (!text || !/proche/i.test(text)) {
      continue;
    }

    node.textContent = EXTERNAL_PROFILE_COPY;
    card.dataset.spProfileCopyFixed = '1';
    return;
  }
}

function installExternalProfileAccordion(options: ExternalProfileAccordionOptions): boolean {
  const collapsedByDefault = !!options.collapsedByDefault;
  const profileRoot = document.getElementById('sp-patient-profile-root');
  const card = profileRoot?.querySelector('.sp-profile-card');
  if (!(card instanceof HTMLElement)) {
    return false;
  }

  normalizeExternalProfileWording(card);

  const header = card.querySelector('.sp-profile-card__header');
  if (!(header instanceof HTMLElement)) {
    return false;
  }

  const setCollapsed = (collapsed: boolean): void => {
    card.classList.toggle('is-collapsed', collapsed);
    card.dataset.spCollapsed = collapsed ? '1' : '0';
    header.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  };

  if (header.dataset.spAccordionBound !== '1') {
    header.addEventListener('click', (event) => {
      if (event.defaultPrevented) {
        return;
      }

      const interactiveTarget = event.target instanceof Element
        ? event.target.closest('a, button, input, select, textarea, label')
        : null;
      if (interactiveTarget && interactiveTarget !== header) {
        return;
      }

      setCollapsed(card.dataset.spCollapsed !== '1');
    });

    header.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }

      event.preventDefault();
      setCollapsed(card.dataset.spCollapsed !== '1');
    });

    if (!header.hasAttribute('tabindex')) {
      header.tabIndex = 0;
    }
    header.setAttribute('role', 'button');
    header.dataset.spAccordionBound = '1';
  }

  if (card.dataset.spAccordionReady !== '1') {
    card.dataset.spAccordionReady = '1';
    setCollapsed(collapsedByDefault);
    return true;
  }

  setCollapsed(card.dataset.spCollapsed === '1');
  return true;
}

function scheduleExternalProfileEnhancements(options: ExternalProfileAccordionOptions): void {
  if (!document.getElementById('sp-patient-profile-root')) {
    return;
  }

  let attempts = 0;
  const maxAttempts = 40;

  const tryInstall = (): void => {
    attempts += 1;
    if (installExternalProfileAccordion(options) || attempts >= maxAttempts) {
      return;
    }

    window.setTimeout(tryInstall, 250);
  };

  tryInstall();
}

function mountPatientConsole(container: HTMLElement): void {
  const formWindow = window as FormWindow;
  formWindow.__SosPrescriptionPatientRoot?.unmount?.();
  const root = createRoot(container);
  formWindow.__SosPrescriptionPatientRoot = root;
  root.render(
    <React.StrictMode>
      <PatientConsole />
    </React.StrictMode>,
  );
}

function mountPublicForm(container: HTMLElement): void {
  const formWindow = window as FormWindow;
  formWindow.__SosPrescriptionPublicFormRoot?.unmount?.();
  const root = createRoot(container);
  formWindow.__SosPrescriptionPublicFormRoot = root;
  root.render(
    <React.StrictMode>
      <PublicFormApp />
    </React.StrictMode>,
  );
}

(function boot() {
  const dedicatedPatientRoot = document.getElementById('sosprescription-root-patient');
  const sharedRoot = document.getElementById('sosprescription-root-form');
  const sharedAppKind = sharedRoot
    ? String(sharedRoot.getAttribute('data-app') || '').trim().toLowerCase()
    : '';
  const shouldCollapseProfile = !!dedicatedPatientRoot || sharedAppKind === 'patient';

  scheduleExternalProfileEnhancements({ collapsedByDefault: shouldCollapseProfile });

  if (dedicatedPatientRoot) {
    mountPatientConsole(dedicatedPatientRoot);
    return;
  }

  if (!sharedRoot) {
    return;
  }

  try {
    getConfigOrThrow();
  } catch (error) {
    renderFatal(
      sharedRoot,
      error instanceof Error
        ? error.message
        : 'Configuration SosPrescription manquante (restBase/nonce).',
    );
    return;
  }

  if (sharedAppKind === 'patient') {
    mountPatientConsole(sharedRoot);
    return;
  }

  mountPublicForm(sharedRoot);
})();
