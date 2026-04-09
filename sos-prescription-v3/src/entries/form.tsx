import '../runtime/installFetchPatch';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import PatientConsole from '../components/PatientConsole';

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
};

type PaymentsConfig = {
  enabled: boolean;
  publishable_key?: string;
  provider?: string;
  capture_method?: string;
};

type FlowType = 'ro_proof' | 'depannage_no_proof';
type Stage = 'choose' | 'form' | 'done';
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
  rounding: number;
};

type MedicationSearchResult = {
  cis?: string;
  cip13?: string;
  label: string;
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

declare global {
  interface Window {
    SosPrescription?: AppConfig;
    SOSPrescription?: AppConfig;
    __SosPrescriptionPublicFormRoot?: ReturnType<typeof createRoot>;
    __SosPrescriptionPatientRoot?: ReturnType<typeof createRoot>;
  }
}

function Spinner({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-block h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-transparent ${className}`.trim()}
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
  const variantClass = variant === 'success'
    ? 'border-green-200 bg-green-50 text-green-900'
    : variant === 'warning'
      ? 'border-yellow-200 bg-yellow-50 text-yellow-900'
      : variant === 'error'
        ? 'border-red-200 bg-red-50 text-red-900'
        : 'border-blue-200 bg-blue-50 text-blue-900';

  return (
    <div className={`rounded-lg border px-4 py-3 text-sm ${variantClass}`}>
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
  const baseClass = 'inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';
  const variantClass = variant === 'primary'
    ? 'bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500'
    : variant === 'danger'
      ? 'bg-red-600 text-white hover:bg-red-700 focus:ring-red-500'
      : variant === 'ghost'
        ? 'bg-transparent text-gray-900 hover:bg-gray-100 focus:ring-gray-400'
        : 'border border-gray-300 bg-white text-gray-900 hover:bg-gray-50 focus:ring-gray-400';

  return (
    <button className={`${baseClass} ${variantClass} ${className}`.trim()} {...props}>
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
      className={`w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 ${className}`.trim()}
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
      className={`w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 ${className}`.trim()}
      {...props}
    />
  );
}

function getConfigOrThrow(): AppConfig {
  const cfg = (typeof window !== 'undefined' ? (window.SosPrescription || window.SOSPrescription) : null) || null;
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

async function searchMedicationsApi(query: string, limit = 20): Promise<unknown> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  return sharedApi(`/medications/search?${params.toString()}`, { method: 'GET' }, 'form');
}

async function getPricingApi(): Promise<PricingConfig | null> {
  const payload = await sharedApi('/pricing', { method: 'GET' }, 'form');
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const data = payload as Record<string, unknown>;
  return {
    standard_cents: typeof data.standard_cents === 'number' ? data.standard_cents : 0,
    express_cents: typeof data.express_cents === 'number' ? data.express_cents : 0,
    currency: typeof data.currency === 'string' ? data.currency : 'EUR',
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

async function createSubmissionApi(payload: Record<string, unknown>): Promise<SubmissionInitResponse> {
  return v4Api('/form/submissions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, 'form') as Promise<SubmissionInitResponse>;
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
          : 'Analyse IA impossible.';
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
      throw new Error('L’analyse automatique du document a expiré. Veuillez réessayer ou fournir un document plus net.');
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

function resolveFlowFromUrl(): FlowType | null {
  try {
    const raw = new URLSearchParams(window.location.search).get('type');
    const normalized = String(raw || '').trim().toLowerCase();
    if (normalized === 'renouvellement' || normalized === 'renewal' || normalized === 'ro_proof') {
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

function distributeTimes(count: number, start: string, end: string, rounding: number): {
  times: string[];
  start: string;
  end: string;
  warnings: string[];
  collisionResolved: boolean;
} {
  const warnings: string[] = [];
  const step = clampInt(rounding, 1, 60, 5);
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
  const rounding = clampInt(value?.rounding, 1, 60, 5);
  const autoTimesEnabled = value?.autoTimesEnabled !== false;
  const start = typeof value?.start === 'string' ? value.start : typeof value?.times?.[0] === 'string' ? value.times[0] : '08:00';
  const end = typeof value?.end === 'string' ? value.end : typeof value?.times?.[value?.times?.length ? value.times.length - 1 : 0] === 'string' ? value.times[value.times.length - 1] : '20:00';
  const safeStart = isTimeString(start) ? start : '08:00';
  const safeEnd = isTimeString(end) ? end : '20:00';

  let times = fillArray(value?.times, nb, '');
  const doses = fillArray(value?.doses, nb, '1');

  if (autoTimesEnabled && freqUnit === 'jour') {
    const auto = distributeTimes(nb, safeStart, safeEnd, rounding);
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
      rounding,
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
    rounding,
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
    rounding: 5,
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
  return `${(cents / 100).toFixed(2)} ${(currency || 'EUR').toUpperCase()}`;
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
}): { ok: boolean; reasons: Array<{ code: string; message: string }>; code: string | null; message: string | null } {
  const reasons: Array<{ code: string; message: string }> = [];

  if (!input.loggedIn) {
    reasons.push({
      code: 'auth_missing',
      message: 'Vous devez être connecté pour soumettre une demande.',
    });
  }

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

  if (flow === 'depannage_no_proof' && itemCount < 1) {
    reasons.push({
      code: 'medication_missing',
      message: 'Merci d’ajouter au moins un médicament.',
    });
  }

  if (flow === 'depannage_no_proof' && !input.attestationNoProof) {
    reasons.push({
      code: 'attestation_missing',
      message: 'Merci de confirmer l’attestation de dépannage sans preuve.',
    });
  }

  if (input.consentRequired) {
    const missing: string[] = [];
    if (!input.consentTelemedicine) missing.push('téléconsultation');
    if (!input.consentTruth) missing.push('attestation sur l’honneur');
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
      message: 'Veuillez patienter pendant l’analyse du document.',
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
  disabled = false,
  disabledHint = 'Connectez-vous pour rechercher des médicaments.',
}: {
  onSelect: (item: MedicationSearchResult) => void;
  disabled?: boolean;
  disabledHint?: string;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MedicationSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const canSearch = useMemo(() => query.trim().length >= 2, [query]);
  const hasDisabledResults = useMemo(
    () => results.some((result) => result?.is_selectable === false),
    [results],
  );

  useEffect(() => {
    if (disabled) {
      setResults([]);
      setOpen(false);
      setLoading(false);
      setError(null);
      return;
    }

    if (!canSearch) {
      setResults([]);
      setOpen(false);
      setError(null);
      return;
    }

    const keyword = query.trim();
    setLoading(true);
    setOpen(true);
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
        .catch((reason: unknown) => {
          if (controller.signal.aborted) {
            return;
          }
          setResults([]);
          setError(reason instanceof Error ? reason.message : 'Erreur lors de la recherche');
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
  }, [canSearch, disabled, query]);

  return (
    <div className="relative">
      <TextInput
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={disabled ? disabledHint : 'Rechercher un médicament (nom, CIS, CIP7/13)…'}
        onFocus={() => {
          if (!disabled && query.trim().length >= 2) {
            setOpen(true);
          }
        }}
        disabled={disabled}
      />

      {open && (
        <div className="absolute z-20 mt-2 w-full overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-gray-100 px-3 py-2 text-xs text-gray-600">
            <span>Résultats</span>
            {loading && <Spinner />}
          </div>

          <div className="max-h-64 overflow-auto">
            {!loading && error && (
              <div className="px-3 py-3 text-sm text-red-600">{error}</div>
            )}

            {!loading && !error && results.length === 0 && (
              <div className="px-3 py-3">
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                  <div className="text-sm font-medium text-gray-900">Aucun résultat</div>
                  <div className="mt-1 text-xs text-gray-600">
                    Si votre médicament n’apparaît pas, c’est souvent lié à :
                    <ul className="mt-2 list-disc space-y-1 pl-5">
                      <li>une BDPM non importée / non prête</li>
                      <li>une whitelist qui restreint le périmètre</li>
                      <li>une recherche trop courte (min. 2 caractères, ou CIS/CIP)</li>
                    </ul>
                  </div>
                </div>
              </div>
            )}

            {results.map((result) => {
              const selectable = result?.is_selectable !== false;
              const key = `${result.cip13 || result.cis || result.label}`;
              return (
                <button
                  key={key}
                  type="button"
                  disabled={!selectable}
                  className={selectable
                    ? 'block w-full px-3 py-2 text-left text-sm hover:bg-gray-50'
                    : 'block w-full cursor-not-allowed px-3 py-2 text-left text-sm opacity-60'}
                  onClick={() => {
                    if (!selectable) {
                      return;
                    }
                    onSelect(result);
                    setQuery('');
                    setResults([]);
                    setOpen(false);
                  }}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className={selectable ? 'font-medium text-gray-900' : 'font-medium text-gray-700'}>
                      {result.label}
                    </div>
                    {!selectable && (
                      <span className="shrink-0 text-xs text-gray-400">Non disponible en ligne</span>
                    )}
                  </div>
                  <div className={selectable ? 'mt-0.5 text-xs text-gray-600' : 'mt-0.5 text-xs text-gray-500'}>
                    {result.specialite || result.label}
                    {result.cis ? ` • CIS ${result.cis}` : ''}
                    {result.cip13 ? ` • CIP13 ${result.cip13}` : ''}
                    {result.tauxRemb ? ` • Remb. ${result.tauxRemb}` : ''}
                    {typeof result.prixTTC === 'number' ? ` • ${result.prixTTC.toFixed(2)}€` : ''}
                  </div>
                </button>
              );
            })}
          </div>

          <div className="border-t border-gray-100 px-3 py-2 text-xs text-gray-500">
            {hasDisabledResults
              ? 'Les résultats grisés ne sont pas disponibles en ligne.'
              : 'Cliquez sur un résultat pour l’ajouter.'}
          </div>
        </div>
      )}
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
      || input.rounding == null
    ) {
      onChange(normalized);
    }
  }, []);

  const count = normalized.nb;
  const freqUnit = normalized.freqUnit;
  const autoTimesEnabled = normalized.autoTimesEnabled !== false && freqUnit === 'jour';
  const start = normalized.start || '08:00';
  const end = normalized.end || '20:00';
  const rounding = normalized.rounding ?? 5;
  const autoDistribution = useMemo(
    () => (autoTimesEnabled ? distributeTimes(count, start, end, rounding) : null),
    [autoTimesEnabled, count, start, end, rounding],
  );
  const times = autoDistribution ? autoDistribution.times : fillArray(normalized.times, count, '');
  const doses = fillArray(normalized.doses, count, '1');
  const warnings = autoDistribution ? autoDistribution.warnings : [];

  const update = useCallback((patch: Partial<Schedule>) => {
    onChange({
      ...normalized,
      ...patch,
    });
  }, [normalized, onChange]);

  const updateCount = useCallback((raw: string) => {
    const nextCount = clampInt(raw, 1, freqUnit === 'jour' ? 6 : 12, 1);
    if (autoTimesEnabled) {
      const auto = distributeTimes(nextCount, start, end, rounding);
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
  }, [autoTimesEnabled, end, freqUnit, normalized, onChange, rounding, start]);

  const updateFreqUnit = useCallback((nextFreqUnit: FrequencyUnit) => {
    const safeCount = clampInt(normalized.nb, 1, nextFreqUnit === 'jour' ? 6 : 12, 1);
    if (nextFreqUnit === 'jour') {
      const auto = distributeTimes(safeCount, normalized.start, normalized.end, normalized.rounding);
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
    const auto = distributeTimes(normalized.nb, normalized.start, normalized.end, normalized.rounding);
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
      times: fillArray(times, normalized.nb, ''),
      doses: fillArray(normalized.doses, normalized.nb, '1'),
    });
  }, [normalized, onChange, times]);

  const resetAutomaticTimes = useCallback(() => {
    const auto = distributeTimes(normalized.nb, normalized.start, normalized.end, normalized.rounding);
    onChange({
      ...normalized,
      autoTimesEnabled: true,
      start: auto.start,
      end: auto.end,
      times: auto.times,
      doses: fillArray(normalized.doses, normalized.nb, '1'),
    });
  }, [normalized, onChange]);

  const updateAnchors = useCallback((nextStart: string, nextEnd: string) => {
    const auto = distributeTimes(normalized.nb, nextStart, nextEnd, normalized.rounding);
    onChange({
      ...normalized,
      autoTimesEnabled: true,
      start: auto.start,
      end: auto.end,
      times: auto.times,
      doses: fillArray(normalized.doses, normalized.nb, '1'),
    });
  }, [normalized, onChange]);

  const updateRounding = useCallback((raw: string) => {
    const nextRounding = clampInt(raw, 1, 60, 5);
    if (autoTimesEnabled) {
      const auto = distributeTimes(normalized.nb, normalized.start, normalized.end, nextRounding);
      onChange({
        ...normalized,
        rounding: nextRounding,
        start: auto.start,
        end: auto.end,
        times: auto.times,
      });
      return;
    }

    onChange({
      ...normalized,
      rounding: nextRounding,
    });
  }, [autoTimesEnabled, normalized, onChange]);

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

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700">Nombre de prises</label>
          <TextInput
            type="number"
            min={1}
            max={freqUnit === 'jour' ? 6 : 12}
            value={count}
            onChange={(event) => updateCount(event.target.value)}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700">Périodicité</label>
          <select
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500"
            value={freqUnit}
            onChange={(event) => updateFreqUnit(event.target.value === 'semaine' ? 'semaine' : 'jour')}
          >
            <option value="jour">Par jour</option>
            <option value="semaine">Par semaine</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700">Durée</label>
          <TextInput
            type="number"
            min={1}
            max={3650}
            value={normalized.durationVal}
            onChange={(event) => update({ durationVal: clampInt(event.target.value, 1, 3650, 5) })}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700">Unité</label>
          <select
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500"
            value={normalized.durationUnit}
            onChange={(event) => update({ durationUnit: event.target.value === 'mois' ? 'mois' : event.target.value === 'semaine' ? 'semaine' : 'jour' })}
          >
            <option value="jour">Jour(s)</option>
            <option value="semaine">Semaine(s)</option>
            <option value="mois">Mois</option>
          </select>
        </div>
      </div>

      {freqUnit === 'jour' && (
        <div className="mt-4 rounded-lg border border-gray-100 bg-gray-50 p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm font-medium text-gray-900">
              {autoTimesEnabled ? 'Horaires auto (répartis entre la 1ère et la dernière prise)' : 'Horaires personnalisés'}
            </div>
            <div className="flex gap-2">
              {autoTimesEnabled ? (
                <Button type="button" variant="secondary" onClick={resetAutomaticTimes}>
                  Réinitialiser les horaires
                </Button>
              ) : (
                <Button type="button" variant="secondary" onClick={enableAutomaticTimes}>
                  Horaires auto
                </Button>
              )}
              {autoTimesEnabled && (
                <Button type="button" variant="secondary" onClick={disableAutomaticTimes}>
                  Personnaliser
                </Button>
              )}
            </div>
          </div>

          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">1ère prise</label>
              <TextInput
                type="time"
                step={300}
                value={normalized.start}
                onChange={(event) => updateAnchors(event.target.value, normalized.end)}
                disabled={!autoTimesEnabled}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">Dernière prise</label>
              <TextInput
                type="time"
                step={300}
                value={normalized.end}
                onChange={(event) => updateAnchors(normalized.start, event.target.value)}
                disabled={!autoTimesEnabled}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">Arrondi (min)</label>
              <TextInput
                type="number"
                min={1}
                max={60}
                value={rounding}
                onChange={(event) => updateRounding(event.target.value)}
              />
            </div>
          </div>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="mt-3">
          <Notice variant="warning">
            <ul className="list-disc pl-5">
              {warnings.map((warning, index) => (
                <li key={`${warning}-${index}`}>{warning}</li>
              ))}
            </ul>
          </Notice>
        </div>
      )}

      <div className="mt-3 space-y-2">
        {Array.from({ length: count }).map((_, index) => {
          const isFirst = index === 0;
          const isLast = index === count - 1 && count > 1;
          const label = isFirst ? '1ère prise' : isLast ? 'Dernière prise' : `Prise ${index + 1}`;
          return (
            <div key={index} className="grid grid-cols-1 gap-2 md:grid-cols-3">
              <div className="text-sm text-gray-800 md:pt-2">
                <span className="font-medium">{label}</span>
                {autoTimesEnabled && (isFirst || isLast) && (
                  <span className="ml-2 text-xs text-gray-500">(ancre)</span>
                )}
              </div>
              <TextInput
                type="time"
                step={300}
                value={times[index] || ''}
                onChange={(event) => updateTime(index, event.target.value)}
              />
              <TextInput
                type="text"
                placeholder="Dose"
                value={doses[index] || '1'}
                onChange={(event) => updateDose(index, event.target.value)}
              />
            </div>
          );
        })}
      </div>
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

  const initialFlow = useMemo<FlowType | null>(() => resolveFlowFromUrl(), []);
  const [stage, setStage] = useState<Stage>(initialFlow ? 'form' : 'choose');
  const [pricing, setPricing] = useState<PricingConfig | null>(null);
  const [paymentsConfig, setPaymentsConfig] = useState<PaymentsConfig | null>(null);
  const [pricingLoading, setPricingLoading] = useState(true);

  const [flow, setFlow] = useState<FlowType | null>(initialFlow);
  const [priority, setPriority] = useState<'standard' | 'express'>('standard');

  const [fullName, setFullName] = useState<string>(() => safePatientNameValue(config.patientProfile?.fullname || ''));
  const [birthdate, setBirthdate] = useState<string>(() => {
    const value = config.patientProfile?.birthdate_fr;
    return value ? String(value) : '';
  });
  const [medicalNotes, setMedicalNotes] = useState<string>(() => {
    return String(
      config.patientProfile?.note
      || config.patientProfile?.medical_notes
      || config.patientProfile?.medicalNotes
      || '',
    ).trim();
  });

  const [items, setItems] = useState<MedicationItem[]>([]);
  const [files, setFiles] = useState<LocalUpload[]>([]);
  const [analysisInProgress, setAnalysisInProgress] = useState(false);
  const [analysisMessage, setAnalysisMessage] = useState<string | null>(null);
  const [rejectedFiles, setRejectedFiles] = useState<File[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitLoading, setSubmitLoading] = useState(false);
  const [submissionResult, setSubmissionResult] = useState<SubmissionResult | null>(null);
  const [copiedUid, setCopiedUid] = useState(false);

  const compliance = config.compliance || {};
  const consentRequired = Boolean(compliance.consent_required);
  const [attestationNoProof, setAttestationNoProof] = useState(false);
  const [consentTelemedicine, setConsentTelemedicine] = useState(false);
  const [consentTruth, setConsentTruth] = useState(false);
  const [consentCgu, setConsentCgu] = useState(false);
  const [consentPrivacy, setConsentPrivacy] = useState(false);

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
  const selectedAmount = useMemo(() => {
    if (!pricing) {
      return null;
    }
    return priority === 'express' ? pricing.express_cents : pricing.standard_cents;
  }, [pricing, priority]);
  const ageLabel = useMemo(() => ageLabelFromBirthdate(birthdate), [birthdate]);

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
        rounding: 5,
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

  const handleFilesSelected = useCallback((list: FileList | null) => {
    if (!list || list.length === 0) {
      return;
    }
    setSubmitError(null);
    setRejectedFiles([]);
    setAnalysisMessage('Documents ajoutés. L’analyse automatique sera lancée lors de la soumission.');
    const nextUploads = Array.from(list).map(createLocalUpload);
    setFiles((current) => [...current, ...nextUploads]);
  }, []);

  const resetToChoose = useCallback(() => {
    setStage('choose');
    setFlow(null);
    setPriority('standard');
    setFullName(safePatientNameValue(config.patientProfile?.fullname || ''));
    setBirthdate(String(config.patientProfile?.birthdate_fr || ''));
    setMedicalNotes(String(
      config.patientProfile?.note
      || config.patientProfile?.medical_notes
      || config.patientProfile?.medicalNotes
      || '',
    ).trim());
    setItems([]);
    setFiles([]);
    setRejectedFiles([]);
    setAnalysisMessage(null);
    setSubmitError(null);
    setSubmissionResult(null);
    setCopiedUid(false);
    setAttestationNoProof(false);
    setConsentTelemedicine(false);
    setConsentTruth(false);
    setConsentCgu(false);
    setConsentPrivacy(false);
  }, [config.patientProfile]);

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

  const handleSubmit = useCallback(async () => {
    setSubmitError(null);

    frontendLog('submit_clicked', 'info', {
      flow: flow || null,
      stage,
      logged_in: isLoggedIn,
      meds_count: items.length,
      files_count: files.length,
    });

    if (!submitBlockInfo.ok || !flow) {
      const message = submitBlockInfo.message || 'Le formulaire est incomplet. Merci de vérifier les champs requis.';
      frontendLog('submit_blocked', 'warning', {
        flow: flow || null,
        stage,
        reason_code: submitBlockInfo.code || 'unknown',
        reasons: submitBlockInfo.reasons.map((reason) => reason.code),
        message,
      });
      setSubmitError(message);
      return;
    }

    const patientFullName = safePatientNameValue(fullName);
    const patientName = splitPatientNameValue(patientFullName);
    if (patientFullName.length < 3 || patientName.firstName === '' || patientName.lastName === '') {
      setSubmitError('Merci de saisir le prénom et le nom du patient, et non une adresse e-mail.');
      return;
    }

    setSubmitLoading(true);

    try {
      frontendLog('submission_init_start', 'info', {
        flow,
        priority,
        meds_count: items.length,
        files_count: files.length,
      });

      const initResponse = await createSubmissionApi({
        flow,
        priority,
      });
      const submissionRef = String(initResponse?.submission_ref || '').trim();
      if (!submissionRef) {
        throw new Error('Référence de soumission manquante.');
      }

      frontendLog('submission_init_ok', 'info', {
        flow,
        submission_ref_present: true,
      });

      let finalItems = Array.isArray(items) ? items.slice() : [];

      if (flow === 'ro_proof') {
        const proofs = Array.isArray(files) ? files.filter((entry) => entry && entry.file instanceof File) : [];
        const rejected: File[] = [];
        const analysisErrors: string[] = [];
        let recognizedCount = 0;
        let mergedInfo = false;

        setAnalysisInProgress(true);
        setAnalysisMessage(null);
        setRejectedFiles([]);
        setSubmitError(null);

        try {
          for (const entry of proofs) {
            try {
              frontendLog('submission_artifact_start', 'debug', {
                flow,
                original_name: entry.file?.name ? String(entry.file.name) : 'upload.bin',
              });

              const uploaded = await directSubmissionArtifactUpload(entry.file, submissionRef, 'PROOF');

              frontendLog('submission_artifact_uploaded', 'info', {
                flow,
                artifact_id: uploaded.id,
              });

              const analysis = await analyzeArtifactApi(uploaded.id);
              const analysisFailed = Boolean(analysis && analysis.ok === false);
              const aiItems = aiMedicationsToItems(Array.isArray(analysis?.medications) ? analysis.medications : []);
              const recognized = Boolean(analysis && (analysis.is_prescription === true || aiItems.length > 0));

              frontendLog('submission_artifact_analyzed', 'info', {
                flow,
                artifact_id: uploaded.id,
                is_prescription: Boolean(analysis?.is_prescription === true),
                medications_count: Array.isArray(analysis?.medications) ? analysis.medications.length : 0,
              });

              if (analysisFailed) {
                rejected.push(entry.file);
                analysisErrors.push(typeof analysis?.message === 'string' && analysis.message.trim()
                  ? analysis.message.trim()
                  : 'L’analyse automatique du document a échoué. Veuillez réessayer ou fournir un document plus net.');
                continue;
              }

              if (recognized) {
                recognizedCount += 1;
                if (aiItems.length > 0) {
                  finalItems = mergeMedicationItems(finalItems, aiItems);
                  mergedInfo = true;
                }
              } else {
                rejected.push(entry.file);
              }
            } catch (error) {
              rejected.push(entry.file);
              analysisErrors.push(error instanceof Error ? error.message : 'L’analyse automatique du document a échoué. Veuillez réessayer ou fournir un document plus net.');
              frontendLog('submission_artifact_error', 'warning', {
                flow,
                message: error instanceof Error ? error.message : 'artifact_error',
              });
            }
          }
        } finally {
          setAnalysisInProgress(false);
        }

        setRejectedFiles(rejected);
        if (mergedInfo) {
          setAnalysisMessage('✅ Document reconnu. Les médicaments ont été ajoutés automatiquement.');
        } else if (recognizedCount > 0) {
          setAnalysisMessage('✅ Document reconnu.');
        }

        if (analysisErrors.length > 0 && !submitError) {
          setSubmitError(analysisErrors[0]);
        }

        if (finalItems.length > 0) {
          setItems(finalItems);
        }

        if (recognizedCount < 1) {
          frontendLog('submit_blocked', 'warning', {
            flow,
            stage,
            reason_code: 'proof_upload_missing',
            message: analysisErrors[0] || 'Aucun document exploitable n’a été accepté.',
            files_count: files.length,
          });
          throw new Error(analysisErrors[0] || 'Aucun document exploitable n’a été accepté.');
        }
      }

      const finalizePayload = {
        patient: {
          fullname: patientFullName,
          firstName: patientName.firstName,
          lastName: patientName.lastName,
          birthdate: birthdate.trim(),
          birthDate: birthdate.trim(),
          note: medicalNotes.trim() || undefined,
          medical_notes: medicalNotes.trim() || undefined,
          medicalNotes: medicalNotes.trim() || undefined,
        },
        items: finalItems.map((item) => {
          const payload: Record<string, unknown> = {
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
        }),
        privateNotes: medicalNotes.trim() || undefined,
        consent: consentRequired ? {
          telemedicine: consentTelemedicine,
          truth: consentTruth,
          cgu: consentCgu,
          privacy: consentPrivacy,
          timestamp: new Date().toISOString(),
          cgu_version: compliance?.cgu_version ? String(compliance.cgu_version) : '',
          privacy_version: compliance?.privacy_version ? String(compliance.privacy_version) : '',
        } : undefined,
        attestation_no_proof: flow === 'depannage_no_proof' ? attestationNoProof : undefined,
      };

      if (!Array.isArray(finalizePayload.items) || finalizePayload.items.length < 1) {
        throw new Error(
          flow === 'ro_proof'
            ? 'Aucun médicament n’a pu être identifié. Merci d’importer un document plus net ou d’utiliser la saisie manuelle.'
            : 'Merci d’ajouter au moins un médicament.',
        );
      }

      frontendLog('submission_finalize_start', 'info', {
        flow,
        items_count: finalizePayload.items.length,
        files_count: files.length,
      });

      const finalized = await finalizeSubmissionApi(submissionRef, finalizePayload);
      const result: SubmissionResult = {
        id: Number((finalized.prescription_id as number) || finalized.id || 0),
        uid: String(finalized.uid || ''),
        status: String(finalized.status || ''),
        created_at: typeof finalized.created_at === 'string' ? finalized.created_at : undefined,
      };

      frontendLog('submission_finalize_ok', 'info', {
        flow,
        prescription_id: result.id || null,
        uid: result.uid || null,
        status: result.status || null,
      });

      setSubmissionResult(result);
      setStage('done');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erreur soumission';
      frontendLog('submission_error', 'error', {
        flow: flow || null,
        stage,
        message,
        meds_count: items.length,
        files_count: files.length,
      });
      setSubmitError(message);
    } finally {
      setSubmitLoading(false);
    }
  }, [
    attestationNoProof,
    birthdate,
    compliance?.cgu_version,
    compliance?.privacy_version,
    consentCgu,
    consentPrivacy,
    consentRequired,
    consentTelemedicine,
    consentTruth,
    files,
    flow,
    fullName,
    isLoggedIn,
    items,
    medicalNotes,
    priority,
    stage,
    submitBlockInfo,
    submitError,
  ]);

  const patientPortalUrl = useMemo(() => {
    const base = config.urls?.patientPortal || null;
    if (!submissionResult?.uid || !base) {
      return null;
    }
    return `${base}${base.includes('?') ? '&' : '?'}rx_uid=${encodeURIComponent(String(submissionResult.uid))}`;
  }, [config.urls?.patientPortal, submissionResult?.uid]);

  return (
    <div className="mx-auto max-w-3xl p-4">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <div className="text-xl font-semibold text-gray-900">SOS Prescription</div>
          <div className="text-sm text-gray-600">Évaluation médicale asynchrone • formulaire sécurisé</div>
        </div>

        <div className="flex flex-col items-end gap-2">
          <div className={`inline-flex items-center gap-2 rounded-full border px-2 py-1 text-xs ${isLoggedIn ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
            <span className="font-semibold">{isLoggedIn ? 'Connecté' : 'Non connecté'}</span>
            {isLoggedIn && config.currentUser?.displayName && (
              <span className="text-emerald-900">{config.currentUser.displayName}</span>
            )}
          </div>

          {pricing && (
            <div className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-700">
              <div className="font-semibold">Tarif</div>
              <div>
                Standard : {formatMoney(pricing.standard_cents, pricing.currency)}
                <br />
                Express : {formatMoney(pricing.express_cents, pricing.currency)}
              </div>
            </div>
          )}
        </div>
      </div>

      {noticeEnabled && noticeItems.length > 0 && (
        <div className="mb-4">
          <Notice variant="info">
            {noticeTitle && <div className="font-semibold">{noticeTitle}</div>}
            <ul className={noticeTitle ? 'mt-2 list-disc space-y-1 pl-5' : 'list-disc space-y-1 pl-5'}>
              {noticeItems.map((item, index) => (
                <li key={`${item}-${index}`}>{item}</li>
              ))}
            </ul>
          </Notice>
        </div>
      )}

      <div className="mb-4">
        <Notice variant="warning">
          Service réservé au <strong>renouvellement / continuité d’un traitement déjà connu</strong>.
          <br />
          Aucune urgence vitale, pas d’arrêt de travail, et aucun médicament classé comme stupéfiant.
        </Notice>
      </div>

      {!isLoggedIn && (
        <div className="mb-4">
          <Notice variant="info">
            Vous êtes en <strong>mode aperçu</strong>. Connectez-vous (ou créez un compte) pour soumettre votre demande.
            <br />
            La recherche de médicaments et l’import de justificatifs sont désactivés tant que vous n’êtes pas connecté.
          </Notice>
        </div>
      )}

      {submitError && (
        <div className="mb-4">
          <Notice variant="error">{submitError}</Notice>
        </div>
      )}

      {stage === 'choose' && (
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="mb-3 text-sm font-semibold text-gray-900">Choisissez votre demande</div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <button
              type="button"
              className={`rounded-xl border p-4 text-left transition hover:bg-gray-50 ${flow === 'ro_proof' ? 'border-gray-900' : 'border-gray-200'}`}
              onClick={() => {
                setFlow('ro_proof');
                setFiles([]);
                setRejectedFiles([]);
                setAnalysisMessage(null);
                setSubmitError(null);
                setSubmissionResult(null);
                setStage('form');
              }}
            >
              <div className="text-sm font-semibold text-gray-900">Renouvellement avec preuve</div>
              <div className="mt-1 text-sm text-gray-600">Vous avez une ancienne ordonnance ou une photo de la boîte.</div>
              <div className="mt-2 text-xs text-gray-500">Temps estimé : ~ 3 min</div>
            </button>

            <button
              type="button"
              className={`rounded-xl border p-4 text-left transition hover:bg-gray-50 ${flow === 'depannage_no_proof' ? 'border-gray-900' : 'border-gray-200'}`}
              onClick={() => {
                setFlow('depannage_no_proof');
                setFiles([]);
                setRejectedFiles([]);
                setAnalysisMessage(null);
                setSubmitError(null);
                setSubmissionResult(null);
                setStage('form');
              }}
            >
              <div className="text-sm font-semibold text-gray-900">Dépannage sans preuve</div>
              <div className="mt-1 text-sm text-gray-600">En cas de perte, d’oubli ou de voyage (traitement habituel).</div>
              <div className="mt-2 text-xs text-gray-500">Temps estimé : ~ 5 min</div>
            </button>
          </div>
        </div>
      )}

      {stage === 'form' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="text-sm font-semibold text-gray-900">Informations patient</div>
              <Button type="button" variant="secondary" onClick={() => setStage('choose')}>
                Modifier le type
              </Button>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="relative">
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
                <label className="mb-1 block text-xs font-medium text-gray-700" htmlFor="sp-patient-fullname">
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
                  onChange={(event) => setFullName(event.target.value)}
                  placeholder="Prénom NOM"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-gray-700" htmlFor="sp-patient-birthdate">
                  Date de naissance (JJ/MM/AAAA)
                </label>
                <TextInput
                  id="sp-patient-birthdate"
                  name="sp_patient_identity_birthdate"
                  inputMode="numeric"
                  pattern="[0-9]{2}/[0-9]{2}/[0-9]{4}"
                  value={birthdate}
                  onChange={(event) => setBirthdate(formatBirthdateInput(event.target.value))}
                  placeholder="JJ/MM/AAAA"
                />
                {ageLabel && (
                  <div className="mt-1 text-xs text-gray-500">Âge estimé : {ageLabel}</div>
                )}
              </div>
            </div>

            <div className="mt-3">
              <label className="mb-1 block text-xs font-medium text-gray-700" htmlFor="sp-patient-medical-notes">
                Précisions médicales (optionnel)
              </label>
              <TextareaField
                id="sp-patient-medical-notes"
                name="medical_notes"
                value={medicalNotes}
                onChange={(event) => setMedicalNotes(event.target.value)}
                placeholder="Allergies, antécédents, contre-indications ou toute information utile au médecin..."
              />
            </div>
          </div>

          {flow === 'ro_proof' && (
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <div className="mb-1 text-sm font-semibold text-gray-900">Justificatifs médicaux (Obligatoire)</div>
              <div className="text-sm text-gray-600">
                Importez votre ordonnance ou une photo de la boîte. Cela nous permet de vérifier votre traitement et de pré-remplir le formulaire.
              </div>

              <div className="mt-3">
                <input
                  id="sp-evidence-input"
                  type="file"
                  className="hidden"
                  accept="image/jpeg,image/png,application/pdf"
                  multiple
                  disabled={!isLoggedIn || analysisInProgress}
                  onChange={(event) => {
                    handleFilesSelected(event.target.files);
                    event.currentTarget.value = '';
                  }}
                />

                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    type="button"
                    variant="secondary"
                    className="border-blue-600 text-blue-700 hover:!text-blue-700 hover:bg-blue-50"
                    disabled={!isLoggedIn || analysisInProgress}
                    onClick={() => {
                      document.getElementById('sp-evidence-input')?.click();
                    }}
                  >
                    {analysisInProgress ? 'Import en cours…' : 'Ajouter un document'}
                  </Button>

                  {analysisInProgress && (
                    <div className="flex items-center gap-2 text-sm text-gray-600">
                      <Spinner />
                      Analyse automatique…
                    </div>
                  )}
                </div>

                <div className="mt-1 text-xs text-gray-400">JPG, PNG ou PDF (Max 5 Mo)</div>
                {!isLoggedIn && (
                  <div className="mt-2 text-xs text-amber-700">
                    Connectez-vous pour importer un justificatif.
                  </div>
                )}
              </div>

              {files.length > 0 && (
                <div className="mt-3 space-y-2">
                  {files.map((file) => (
                    <div
                      key={file.id}
                      className="flex items-center justify-between rounded-lg border border-gray-100 bg-gray-50 px-3 py-2"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-gray-900">{file.original_name}</div>
                        <div className="text-xs text-gray-600">
                          {file.mime} • {Math.round((file.size_bytes || 0) / 1024)} Ko
                        </div>
                      </div>

                      <button
                        type="button"
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-700 hover:bg-gray-100"
                        aria-label="Retirer ce document"
                        title="Retirer"
                        onClick={() => {
                          setFiles((current) => current.filter((entry) => entry.id !== file.id));
                        }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {analysisMessage && (
                <div className="mt-3">
                  <Notice variant={analysisMessage.startsWith('✅') ? 'success' : 'warning'}>
                    {analysisMessage}
                  </Notice>
                </div>
              )}

              {rejectedFiles.length > 0 && (
                <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-amber-900">Document refusé par l’analyse IA</div>
                      <div className="text-xs text-amber-900/80">
                        L’intelligence artificielle n’a détecté aucune prescription médicale lisible sur ce document. Veuillez retirer ce fichier et importer une photo nette de votre ordonnance.
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={analysisInProgress}
                        onClick={() => {
                          setFlow('depannage_no_proof');
                          setFiles([]);
                          setRejectedFiles([]);
                          setAnalysisMessage(null);
                        }}
                      >
                        Saisie manuelle (Dépannage)
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={analysisInProgress}
                        onClick={() => {
                          setRejectedFiles([]);
                          setAnalysisMessage(null);
                        }}
                      >
                        Retirer
                      </Button>
                    </div>
                  </div>

                  <ul className="mt-2 list-disc pl-5 text-xs text-amber-900/90">
                    {rejectedFiles.map((file, index) => (
                      <li key={`${file.name}-${index}`}>{file?.name || 'Document'}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {(flow !== 'ro_proof' || items.length > 0) && (
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <div className="mb-2 text-sm font-semibold text-gray-900">Médicaments</div>
              <div className="text-sm text-gray-600">
                {flow === 'ro_proof' && items.length > 0
                  ? 'Médicaments reconnus par l’IA'
                  : 'Recherchez et ajoutez les médicaments concernés.'}
              </div>

              {flow !== 'ro_proof' && (
                <div className="mt-3">
                  <MedicationSearch onSelect={addMedication} disabled={!isLoggedIn} />
                </div>
              )}

              {items.length > 0 && (
                <div className="mt-4 space-y-3">
                  {items.map((item, index) => (
                    <div key={`${item.cis || item.cip13 || item.label}-${index}`} className="rounded-xl border border-gray-100 bg-gray-50 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-gray-900">{item.label}</div>
                          <div className="mt-0.5 text-xs text-gray-600">
                            {item.cis ? `CIS ${item.cis}` : ''}
                            {item.cip13 ? ` • CIP13 ${item.cip13}` : ''}
                          </div>
                        </div>

                        <Button type="button" variant="secondary" onClick={() => removeMedication(index)}>
                          Retirer
                        </Button>
                      </div>

                      <div className="mt-4">
                        <div className="mb-2 text-xs font-medium text-gray-700">Posologie</div>
                        <ScheduleEditor
                          value={item.schedule || {}}
                          onChange={(nextSchedule) => {
                            updateMedication(index, { schedule: nextSchedule });
                          }}
                        />
                        <div className="mt-3 text-xs text-gray-500">
                          Les champs CIS/CIP sont enregistrés pour traçabilité.
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <div className="mb-2 text-sm font-semibold text-gray-900">Délai & tarif</div>

            {pricingLoading ? (
              <div className="flex items-center gap-2 text-sm text-gray-600">
                <Spinner />
                Chargement…
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <button
                    type="button"
                    className={`rounded-xl border p-4 text-left transition hover:bg-gray-50 ${priority === 'standard' ? 'border-gray-900' : 'border-gray-200'}`}
                    onClick={() => setPriority('standard')}
                  >
                    <div className="text-sm font-semibold text-gray-900">Standard</div>
                    <div className="mt-1 text-sm text-gray-600">Traitement en file normale</div>
                    {pricing && (
                      <div className="mt-2 text-xs text-gray-500">
                        {formatMoney(pricing.standard_cents, pricing.currency)}
                      </div>
                    )}
                  </button>

                  <button
                    type="button"
                    className={`rounded-xl border p-4 text-left transition hover:bg-gray-50 ${priority === 'express' ? 'border-gray-900' : 'border-gray-200'}`}
                    onClick={() => setPriority('express')}
                  >
                    <div className="text-sm font-semibold text-gray-900">Express</div>
                    <div className="mt-1 text-sm text-gray-600">Prioritaire (selon disponibilité)</div>
                    {pricing && (
                      <div className="mt-2 text-xs text-gray-500">
                        {formatMoney(pricing.express_cents, pricing.currency)}
                      </div>
                    )}
                  </button>
                </div>

                {paymentsConfig?.enabled ? (
                  <Notice variant="info">
                    Paiement : une <strong>autorisation</strong> peut être demandée à la soumission. La carte n’est débitée qu’après validation médicale.
                  </Notice>
                ) : (
                  <Notice variant="info">
                    Paiement désactivé (mode test).
                  </Notice>
                )}
              </div>
            )}
          </div>

          {flow === 'depannage_no_proof' && (
            <div className="rounded-xl border border-yellow-200 bg-yellow-50 p-4">
              <div className="text-sm font-semibold text-gray-900">Attestation sur l’honneur (Obligatoire)</div>
              <div className="mt-1 text-sm text-gray-700">
                En cas de perte, d’oubli ou de voyage, vous devez certifier que ce traitement vous a déjà été prescrit.
              </div>

              <label className="mt-3 flex items-start gap-2 text-sm text-gray-900">
                <input
                  type="checkbox"
                  checked={attestationNoProof}
                  onChange={(event) => setAttestationNoProof(event.target.checked)}
                  className="mt-1 h-4 w-4"
                />
                <span>
                  Je certifie sur l’honneur que les informations renseignées sont exactes et que ce traitement m’a déjà été prescrit par un médecin.
                </span>
              </label>
            </div>
          )}

          {consentRequired && (
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <div className="text-sm font-semibold text-gray-900">Consentements requis</div>
              <div className="mt-1 text-xs text-gray-600">
                Avant de soumettre, vous devez accepter les points ci-dessous.
              </div>

              <div className="mt-4 space-y-3">
                <label className="flex items-start gap-2 text-sm text-gray-900">
                  <input
                    id="sp-consent-medical"
                    type="checkbox"
                    className="mt-1 h-4 w-4 rounded border-gray-300"
                    checked={consentTelemedicine}
                    onChange={(event) => setConsentTelemedicine(event.target.checked)}
                  />
                  <span>
                    J’accepte que ma demande et mes informations médicales soient traitées dans le cadre de la téléconsultation.
                  </span>
                </label>

                <label className="flex items-start gap-2 text-sm text-gray-900">
                  <input
                    id="sp-consent-truth"
                    type="checkbox"
                    className="mt-1 h-4 w-4 rounded border-gray-300"
                    checked={consentTruth}
                    onChange={(event) => setConsentTruth(event.target.checked)}
                  />
                  <span>Je certifie que les informations renseignées sont exactes.</span>
                </label>

                <label className="flex items-start gap-2 text-sm text-gray-900">
                  <input
                    id="sp-consent-cgu"
                    type="checkbox"
                    className="mt-1 h-4 w-4 rounded border-gray-300"
                    checked={consentCgu}
                    onChange={(event) => setConsentCgu(event.target.checked)}
                  />
                  <span>
                    J’ai lu et j’accepte{' '}
                    <a
                      href={compliance?.cgu_url || '#'}
                      target="_blank"
                      rel="noreferrer"
                      className="underline"
                    >
                      les CGU
                    </a>
                    .
                  </span>
                </label>

                <label className="flex items-start gap-2 text-sm text-gray-900">
                  <input
                    id="sp-consent-privacy"
                    type="checkbox"
                    className="mt-1 h-4 w-4 rounded border-gray-300"
                    checked={consentPrivacy}
                    onChange={(event) => setConsentPrivacy(event.target.checked)}
                  />
                  <span>
                    J’ai lu{' '}
                    <a
                      href={compliance?.privacy_url || '#'}
                      target="_blank"
                      rel="noreferrer"
                      className="underline"
                    >
                      la politique de confidentialité
                    </a>
                    .
                  </span>
                </label>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between gap-3">
            <Button type="button" variant="secondary" onClick={() => setStage('choose')} disabled={submitLoading}>
              Retour
            </Button>

            <Button type="button" onClick={handleSubmit} disabled={submitLoading}>
              {submitLoading ? (
                <>
                  <Spinner />
                  {' '}Soumission…
                </>
              ) : (
                'Soumettre au médecin'
              )}
            </Button>
          </div>

          {selectedAmount != null && pricing && (
            <div className="text-xs text-gray-500">
              Montant sélectionné : {formatMoney(selectedAmount, pricing.currency)}
            </div>
          )}
        </div>
      )}

      {stage === 'done' && submissionResult && (
        <div className="space-y-5">
          <div className="rounded-2xl border border-green-200 bg-green-50 p-6 text-center text-green-950">
            <div className="text-lg font-semibold">Merci ! Votre demande est enregistrée.</div>
            <div className="mt-4 text-sm text-green-900/80">Numéro de dossier</div>
            <div className="mt-1 flex items-center justify-center gap-2">
              <div className="font-mono text-3xl font-extrabold tracking-wider">{submissionResult.uid}</div>
              <button
                type="button"
                className="rounded-md border border-green-300 bg-white px-2 py-1 text-xs font-medium text-green-900 hover:bg-green-100"
                onClick={() => {
                  void copyUid();
                }}
                aria-label="Copier le numéro de dossier"
                title="Copier"
              >
                {copiedUid ? 'Copié' : 'Copier'}
              </button>
            </div>
            <div className="mt-4 text-sm text-green-900/80">
              Conservez ce numéro. Il vous permettra de retrouver votre dossier et d’échanger avec le médecin.
            </div>
          </div>

          {patientPortalUrl && (
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <div className="text-sm font-semibold text-gray-900">Suite de la demande</div>
              <div className="mt-1 text-sm text-gray-600">
                Vous pouvez suivre votre dossier et échanger avec le médecin depuis votre espace patient.
              </div>
              <div className="mt-3">
                <a
                  href={patientPortalUrl}
                  className="inline-flex items-center justify-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                >
                  Ouvrir l’espace patient
                </a>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between gap-3">
            <Button type="button" variant="secondary" onClick={resetToChoose}>
              Nouvelle demande
            </Button>
            <div className="text-xs text-gray-500">
              Vous pourrez toujours compléter via la messagerie patient.
            </div>
          </div>
        </div>
      )}
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

function mountPatientConsole(container: HTMLElement): void {
  window.__SosPrescriptionPatientRoot?.unmount?.();
  const root = createRoot(container);
  window.__SosPrescriptionPatientRoot = root;
  root.render(
    <React.StrictMode>
      <PatientConsole />
    </React.StrictMode>,
  );
}

function mountPublicForm(container: HTMLElement): void {
  window.__SosPrescriptionPublicFormRoot?.unmount?.();
  const root = createRoot(container);
  window.__SosPrescriptionPublicFormRoot = root;
  root.render(
    <React.StrictMode>
      <PublicFormApp />
    </React.StrictMode>,
  );
}

(function boot() {
  const dedicatedPatientRoot = document.getElementById('sosprescription-root-patient');
  if (dedicatedPatientRoot) {
    mountPatientConsole(dedicatedPatientRoot);
    return;
  }

  const sharedRoot = document.getElementById('sosprescription-root-form');
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

  const appKind = String(sharedRoot.getAttribute('data-app') || '').trim().toLowerCase();
  if (appKind === 'patient') {
    mountPatientConsole(sharedRoot);
    return;
  }

  mountPublicForm(sharedRoot);
})();
