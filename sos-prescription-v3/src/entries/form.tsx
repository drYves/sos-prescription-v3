// src/entries/form.tsx · V8.6.0
import '../runtime/installFetchPatch';
import '../styles/medical-grade-aura.css';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import PatientConsole from '../components/PatientConsole';
import { buildDraftFileManifest, buildDraftPayload } from './formTunnel/builders';
import { hydrateStoredDraftPayload } from './formTunnel/hydrators';
import type {
  AnalyzeMedication,
  ArtifactAnalysis,
  ClinicalState,
  DraftSaveResponse,
  FlowType,
  FrequencyUnit,
  LocalUpload,
  MedicationItem,
  MedicationSearchResult,
  MedEditorState,
  PaymentsConfig,
  PricingConfig,
  Schedule,
  Stage,
  StoredDraftPayload,
  SubmissionInitResponse,
  SubmissionRefState,
  SubmissionResult,
  UIState,
  UploadedArtifact,
  WorkflowState,
  DurationUnit,
} from './formTunnel/types';
import { useDraftNetwork } from './formTunnel/useDraftNetwork';
import { useSubmissionNetwork } from './formTunnel/useSubmissionNetwork';
import { CheckoutSection } from './formCheckout/CheckoutSection';
import { formatMoney } from './formCheckout/helpers';
import { useCheckout } from './formCheckout/useCheckout';
import { MedicationRequestSection } from './formMedication/MedicationRequestSection';
import { buildMedicationItemFromSearchResult } from './formMedication/buildMedicationItemFromSearchResult';
import { clampInt, fillArray, normalizeSchedule } from './formMedication/schedule';
import { IntakeSection } from './formIntake/IntakeSection';
import { useIntake } from './formIntake/useIntake';

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
        <IntakeSection
          isLoggedIn={isLoggedIn}
          files={files}
          rejectedFiles={rejectedFiles}
          analysisInProgress={analysisInProgress}
          analysisMessage={analysisMessage}
          onFilesSelected={onFilesSelected}
          onRemoveFile={onRemoveFile}
        />
      ) : null}


      <MedicationRequestSection
        flow={flow}
        items={items}
        rejectedFiles={rejectedFiles}
        onAddMedication={onAddMedication}
        onUpdateMedication={onUpdateMedication}
        onRemoveMedication={onRemoveMedication}
      />

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
        <Button type="button" variant="secondary" onClick={onBackToChoice} disabled={submitLoading}>
          Retour
        </Button>

        <Button type="button" onClick={onContinue} disabled={submitLoading}>
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
  const artifactResyncFileIdsRef = useRef<string[]>([]);

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
      artifactResyncFileIdsRef.current = [];
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
    const nextItem = buildMedicationItemFromSearchResult(medication);

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

  const {
    selectedAmount,
    selectedPriorityEta,
    invalidatePreparedSubmission,
    prioritySectionProps,
    paymentSectionProps,
  } = useCheckout({
    config,
    clinicalState,
    workflowState,
    pricingLoading,
    submitLoading,
    isLoggedIn,
    isDraftMode,
    submitBlockInfo,
    consentRequired,
    cguVersion: compliance?.cgu_version,
    privacyVersion: compliance?.privacy_version,
    submissionRefStateRef,
    artifactResyncFileIdsRef,
    setPriority,
    setStage,
    setSubmitError,
    setSubmitLoading,
    setPreparedSubmission,
    setSubmissionResult,
    setFiles,
    ensureSubmissionRef,
    uploadDraftArtifacts,
    finalizeSubmission,
    createPaymentIntent: createPaymentIntentApi,
    confirmPaymentIntent: confirmPaymentIntentApi,
    frontendLog,
    toPatientSafeSubmissionErrorMessage,
    safePatientNameValue,
    splitPatientNameValue,
  });

  const {
    handleFilesSelected,
    handleRemoveFile,
    invalidateAsyncContext: invalidateIntakeAsyncContext,
  } = useIntake({
    flow,
    isLoggedIn,
    files,
    resumedDraftRef,
    submissionRefStateRef,
    artifactResyncFileIdsRef,
    setFiles,
    setItems,
    setRejectedFiles,
    setAnalysisInProgress,
    setAnalysisMessage,
    setSubmitError,
    setResumedDraftRef,
    invalidatePreparedSubmission,
    ensureSubmissionRef,
    uploadIntakeFiles,
    toPatientSafeSubmissionErrorMessage,
    resolveAnalyzedItems: (analysis) => aiMedicationsToItems(Array.isArray(analysis?.medications) ? analysis.medications : []),
    mergeMedicationItems,
  });
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
    artifactResyncFileIdsRef.current = [];
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

  const handleBackToChoice = useCallback(() => {
    invalidateIntakeAsyncContext();
    setSubmitError(null);
    setStage('choose');
  }, [invalidateIntakeAsyncContext]);

  const handleSelectFlow = useCallback((nextFlow: FlowType) => {
    if (nextFlow === flow) {
      setSubmitError(null);
      setStage('form');
      return;
    }

    invalidateIntakeAsyncContext();
    artifactResyncFileIdsRef.current = [];
    setFlow(nextFlow);
    setFiles([]);
    setRejectedFiles([]);
    setAnalysisMessage(null);
    setSubmitError(null);
    invalidatePreparedSubmission();
    setSubmissionResult(null);
    setDraftSending(false);
    setDraftSent(false);
    setDraftSuccessMessage(null);
    setResumedDraftRef(null);
    submissionRefStateRef.current = { ref: null };
    setStage('form');
  }, [flow, invalidateIntakeAsyncContext, invalidatePreparedSubmission]);

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

    const draftClinicalState: ClinicalState & { flow: FlowType } = {
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

  const handleBackToClinicalForm = useCallback(() => {
    invalidatePreparedSubmission();
    setSubmitError(null);
    setDraftSent(false);
    setDraftSuccessMessage(null);
    setStage('form');
  }, [invalidatePreparedSubmission]);

  const handleBackFromPayment = useCallback(() => {
    invalidatePreparedSubmission();
    setSubmitError(null);
    setStage('priority_selection');
  }, [invalidatePreparedSubmission]);

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
            onBackToChoice={handleBackToChoice}
            onFullNameChange={handleFullNameChange}
            onBirthdateChange={handleBirthdateChange}
            onDraftEmailChange={setDraftEmail}
            onUnlockDraftEmail={() => setDraftEmailLocked(false)}
            onMedicalNotesChange={handleMedicalNotesChange}
            onFilesSelected={handleFilesSelected}
            onRemoveFile={handleRemoveFile}
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
          <CheckoutSection
            mode="priority"
            priorityProps={{
              ...prioritySectionProps,
              flow,
              onBack: handleBackToClinicalForm,
            }}
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
            <CheckoutSection
              mode="payment"
              paymentProps={{
                ...paymentSectionProps,
                onBack: handleBackFromPayment,
              }}
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
