import '../runtime/installFetchPatch';
import '../styles/medical-grade-aura.css';
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
  standard_eta_minutes?: number | null;
  express_eta_minutes?: number | null;
};

type PaymentsConfig = {
  enabled: boolean;
  publishable_key?: string;
  provider?: string;
  capture_method?: string;
};

type FlowType = 'ro_proof' | 'depannage_no_proof';
type Stage = 'choose' | 'form' | 'priority_selection' | 'done';
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
      className={cx('sp-app-input', className)}
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
      className={cx('sp-app-textarea', className)}
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

function formatEtaMinutes(minutes: number | null | undefined): string | null {
  const value = typeof minutes === 'number' ? Math.trunc(minutes) : 0;
  if (!Number.isFinite(value) || value < 1) {
    return null;
  }
  if (value < 60) {
    return `${value} min`;
  }
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  if (rest < 1) {
    return `${hours} h`;
  }
  return `${hours} h ${rest} min`;
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
      ? `Priorité absolue : ${eta}`
      : `Traitement sous ${eta}`;
  }

  return priority === 'express'
    ? 'Priorité absolue selon disponibilité médicale.'
    : 'Traitement selon la file médicale en cours.';
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
    <div className="sp-app-search">
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

      {open ? (
        <div className="sp-app-search__results">
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
                    Si votre médicament n’apparaît pas, c’est souvent lié à :
                    <ul className="sp-app-list">
                      <li>une BDPM non importée / non prête</li>
                      <li>une whitelist qui restreint le périmètre</li>
                      <li>une recherche trop courte (min. 2 caractères, ou CIS/CIP)</li>
                    </ul>
                  </div>
                </div>
              </div>
            ) : null}

            {results.map((result) => {
              const selectable = result?.is_selectable !== false;
              const key = `${result.cip13 || result.cis || result.label}`;
              return (
                <button
                  key={key}
                  type="button"
                  disabled={!selectable}
                  className={cx(
                    'sp-app-search__item',
                    selectable ? 'is-selectable' : 'is-disabled',
                  )}
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
                  <div className="sp-app-search__item-row">
                    <div className="sp-app-search__item-title">{result.label}</div>
                    {!selectable ? (
                      <span className="sp-app-search__badge">Non disponible en ligne</span>
                    ) : null}
                  </div>
                  <div className="sp-app-search__item-meta">
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

          <div className="sp-app-search__foot">
            {hasDisabledResults
              ? 'Les résultats grisés ne sont pas disponibles en ligne.'
              : 'Cliquez sur un résultat pour l’ajouter.'}
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
      || input.rounding == null
    ) {
      onChange(normalized);
    }
  }, []);

  const count = normalized.nb;
  const freqUnit = normalized.freqUnit;
  const autoTimesEnabled = normalized.autoTimesEnabled !== false && freqUnit === 'jour';
  const startTime = normalized.start || '08:00';
  const endTime = normalized.end || '20:00';
  const rounding = normalized.rounding ?? 5;
  const autoDistribution = useMemo(
    () => (autoTimesEnabled ? distributeTimes(count, startTime, endTime, rounding) : null),
    [autoTimesEnabled, count, startTime, endTime, rounding],
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
      const auto = distributeTimes(nextCount, startTime, endTime, rounding);
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
  }, [autoTimesEnabled, endTime, freqUnit, normalized, onChange, rounding, startTime]);

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
      times: fillArray(normalized.times, normalized.nb, ''),
      doses: fillArray(normalized.doses, normalized.nb, '1'),
    });
  }, [normalized, onChange]);

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
    const safeStart = isTimeString(nextStart) ? nextStart : normalized.start;
    const safeEnd = isTimeString(nextEnd) ? nextEnd : normalized.end;
    const auto = distributeTimes(normalized.nb, safeStart, safeEnd, normalized.rounding);
    onChange({
      ...normalized,
      autoTimesEnabled: true,
      start: auto.start,
      end: auto.end,
      times: auto.times,
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
    <div className="sp-app-card sp-app-card--nested">
      <div className="sp-app-grid sp-app-grid--two">
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
            className="sp-app-select"
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
            className="sp-app-select"
            value={normalized.durationUnit}
            onChange={(event) => update({ durationUnit: event.target.value === 'mois' ? 'mois' : event.target.value === 'semaine' ? 'semaine' : 'jour' })}
          >
            <option value="jour">Jour(s)</option>
            <option value="semaine">Semaine(s)</option>
            <option value="mois">Mois</option>
          </select>
        </div>
      </div>

      {freqUnit === 'jour' ? (
        <div className="sp-app-schedule">
          <div className="sp-app-schedule__header">
            <div className="sp-app-schedule__title">
              {autoTimesEnabled ? 'Horaires auto (répartis entre la 1ère et la dernière prise)' : 'Horaires personnalisés'}
            </div>
            <div className="sp-app-schedule__actions">
              {autoTimesEnabled ? (
                <Button type="button" variant="secondary" onClick={resetAutomaticTimes}>
                  Réinitialiser les horaires
                </Button>
              ) : (
                <Button type="button" variant="secondary" onClick={enableAutomaticTimes}>
                  Horaires auto
                </Button>
              )}
              {autoTimesEnabled ? (
                <Button type="button" variant="secondary" onClick={disableAutomaticTimes}>
                  Personnaliser
                </Button>
              ) : null}
            </div>
          </div>

          <div className="sp-app-grid sp-app-grid--three">
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
            <div className="sp-app-field">
              <label className="sp-app-field__label">Arrondi (min)</label>
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
      ) : null}

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

      <div className="sp-app-dose-list">
        {Array.from({ length: count }).map((_, index) => {
          const isFirst = index === 0;
          const isLast = index === count - 1 && count > 1;
          const label = isFirst ? '1ère prise' : isLast ? 'Dernière prise' : `Prise ${index + 1}`;
          return (
            <div key={index} className="sp-app-dose-row">
              <div className="sp-app-dose-row__label">
                <span>{label}</span>
                {autoTimesEnabled && (isFirst || isLast) ? (
                  <span className="sp-app-dose-row__hint">(ancre)</span>
                ) : null}
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
  const selectedPriorityEta = useMemo(
    () => describePriorityTurnaround(priority, pricing),
    [priority, pricing],
  );
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

  const handleContinueToPriority = useCallback(() => {
    setSubmitError(null);

    if (!submitBlockInfo.ok || !flow) {
      setSubmitError(
        submitBlockInfo.message || 'Le formulaire est incomplet. Merci de vérifier les champs requis.',
      );
      return;
    }

    const patientFullName = safePatientNameValue(fullName);
    const patientName = splitPatientNameValue(patientFullName);
    if (patientFullName.length < 3 || patientName.firstName === '' || patientName.lastName === '') {
      setSubmitError('Merci de saisir le prénom et le nom du patient, et non une adresse e-mail.');
      return;
    }

    setStage('priority_selection');
  }, [flow, fullName, submitBlockInfo]);

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
    <div className="sp-app-root sp-app-theme">
      <div className="sp-app-container">
        <header className="sp-app-header">
          <div className="sp-app-header__eyebrow">Medical-Grade Aura</div>
          <h1 className="sp-app-header__title">SOS Prescription</h1>
          <p className="sp-app-header__subtitle">
            Évaluation médicale asynchrone sécurisée pour le renouvellement ou la continuité d’un traitement déjà connu.
          </p>
        </header>

        <div className="sp-app-stagebar" aria-label="Progression de la demande">
          {[
            { key: 'choose', label: 'Type de demande' },
            { key: 'form', label: 'Saisie médicale' },
            { key: 'priority_selection', label: 'Priorité' },
            { key: 'done', label: 'Confirmation' },
          ].map((entry, index) => {
            const order: Stage[] = ['choose', 'form', 'priority_selection', 'done'];
            const activeIndex = order.indexOf(stage);
            const currentIndex = order.indexOf(entry.key as Stage);
            return (
              <div
                key={entry.key}
                className={cx(
                  'sp-app-stagebar__item',
                  currentIndex <= activeIndex && 'is-complete',
                  currentIndex === activeIndex && 'is-active',
                )}
              >
                <div className="sp-app-stagebar__badge">{index + 1}</div>
                <div className="sp-app-stagebar__label">{entry.label}</div>
              </div>
            );
          })}
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

        <div className="sp-app-block">
          <Notice variant="warning">
            Service réservé au <strong>renouvellement / continuité d’un traitement déjà connu</strong>.
            <br />
            Aucune urgence vitale, pas d’arrêt de travail, et aucun médicament classé comme stupéfiant.
          </Notice>
        </div>

        {!isLoggedIn ? (
          <div className="sp-app-block">
            <Notice variant="info">
              Vous êtes en <strong>mode aperçu</strong>. Connectez-vous (ou créez un compte) pour soumettre votre demande.
              <br />
              La recherche de médicaments et l’import de justificatifs sont désactivés tant que vous n’êtes pas connecté.
            </Notice>
          </div>
        ) : null}

        {submitError ? (
          <div className="sp-app-block">
            <Notice variant="error">{submitError}</Notice>
          </div>
        ) : null}

        {stage === 'choose' ? (
          <section className="sp-app-card">
            <div className="sp-app-section__header">
              <div>
                <h2 className="sp-app-section__title">Choisissez le scénario médical</h2>
                <p className="sp-app-section__hint">
                  Nous vous guiderons ensuite vers la saisie adaptée.
                </p>
              </div>
            </div>

            <div className="sp-app-choice-grid">
              <button
                type="button"
                className={cx('sp-app-choice-card', flow === 'ro_proof' && 'is-selected')}
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
                <div className="sp-app-choice-card__title">Renouvellement avec preuve</div>
                <div className="sp-app-choice-card__text">
                  Vous disposez d’une ordonnance antérieure, d’une photo de boîte ou d’un justificatif médical.
                </div>
                <div className="sp-app-choice-card__meta">Pré-remplissage assisté possible.</div>
              </button>

              <button
                type="button"
                className={cx('sp-app-choice-card', flow === 'depannage_no_proof' && 'is-selected')}
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
                <div className="sp-app-choice-card__title">Dépannage sans preuve</div>
                <div className="sp-app-choice-card__text">
                  En cas de perte, d’oubli ou de voyage pour un traitement habituel déjà connu.
                </div>
                <div className="sp-app-choice-card__meta">Attestation sur l’honneur requise.</div>
              </button>
            </div>
          </section>
        ) : null}

        {stage === 'form' ? (
          <div className="sp-app-stack">
            <section className="sp-app-card">
              <div className="sp-app-section__header">
                <div>
                  <h2 className="sp-app-section__title">Informations patient</h2>
                  <p className="sp-app-section__hint">
                    Renseignez les éléments indispensables au contrôle médical.
                  </p>
                </div>
                <div className="sp-app-section__actions">
                  <Button type="button" variant="secondary" onClick={() => setStage('choose')}>
                    Modifier le type
                  </Button>
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
                    onChange={(event) => setFullName(event.target.value)}
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
                    onChange={(event) => setBirthdate(formatBirthdateInput(event.target.value))}
                    placeholder="JJ/MM/AAAA"
                  />
                  {ageLabel ? <div className="sp-app-field__hint">Âge estimé : {ageLabel}</div> : null}
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
                  onChange={(event) => setMedicalNotes(event.target.value)}
                  placeholder="Allergies, antécédents, contre-indications ou toute information utile au médecin..."
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
                    disabled={!isLoggedIn || analysisInProgress}
                    onChange={(event) => {
                      handleFilesSelected(event.target.files);
                      event.currentTarget.value = '';
                    }}
                  />

                  <div className="sp-app-upload__actions">
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={!isLoggedIn || analysisInProgress}
                      onClick={() => {
                        document.getElementById('sp-evidence-input')?.click();
                      }}
                    >
                      {analysisInProgress ? 'Import en cours…' : 'Ajouter un document'}
                    </Button>

                    {analysisInProgress ? (
                      <div className="sp-app-inline-status">
                        <Spinner />
                        <span>Analyse automatique…</span>
                      </div>
                    ) : null}
                  </div>

                  <div className="sp-app-field__hint">JPG, PNG ou PDF (Max 5 Mo)</div>
                  {!isLoggedIn ? (
                    <div className="sp-app-field__hint sp-app-field__hint--warning">
                      Connectez-vous pour importer un justificatif.
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
                          className="sp-app-icon-button"
                          onClick={() => {
                            setFiles((current) => current.filter((entry) => entry.id !== file.id));
                          }}
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
                        Certains fichiers n’ont pas pu être exploités automatiquement.
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

            <section className="sp-app-card">
              <div className="sp-app-section__header">
                <div>
                  <h2 className="sp-app-section__title">Traitement demandé</h2>
                  <p className="sp-app-section__hint">
                    Ajoutez chaque médicament puis ajustez la posologie si nécessaire.
                  </p>
                </div>
              </div>

              <div className="sp-app-field">
                <label className="sp-app-field__label">Recherche médicament</label>
                <MedicationSearch onSelect={addMedication} disabled={!isLoggedIn} />
              </div>

              {items.length > 0 ? (
                <div className="sp-app-medication-list">
                  {items.map((item, index) => (
                    <div key={`${item.label}-${index}`} className="sp-app-medication-card">
                      <div className="sp-app-medication-card__head">
                        <div className="sp-app-medication-card__content">
                          <div className="sp-app-medication-card__title">{item.label}</div>
                          <div className="sp-app-medication-card__meta">
                            {item.cis ? `CIS ${item.cis}` : ''}
                            {item.cip13 ? ` • CIP13 ${item.cip13}` : ''}
                          </div>
                        </div>

                        <Button type="button" variant="secondary" onClick={() => removeMedication(index)}>
                          Retirer
                        </Button>
                      </div>

                      <div className="sp-app-block">
                        <div className="sp-app-field__label">Posologie</div>
                        <ScheduleEditor
                          value={item.schedule || {}}
                          onChange={(nextSchedule) => {
                            updateMedication(index, { schedule: nextSchedule });
                          }}
                        />
                        <div className="sp-app-field__hint">
                          Les champs CIS/CIP sont enregistrés pour traçabilité.
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="sp-app-empty">Aucun médicament ajouté pour le moment.</div>
              )}
            </section>

            {flow === 'depannage_no_proof' ? (
              <section className="sp-app-card sp-app-card--warning">
                <div className="sp-app-section__header">
                  <div>
                    <h2 className="sp-app-section__title">Attestation sur l’honneur</h2>
                    <p className="sp-app-section__hint">
                      En cas de perte, d’oubli ou de voyage, vous devez certifier que ce traitement vous a déjà été prescrit.
                    </p>
                  </div>
                </div>

                <label className="sp-app-checkbox">
                  <input
                    type="checkbox"
                    checked={attestationNoProof}
                    onChange={(event) => setAttestationNoProof(event.target.checked)}
                  />
                  <span>
                    Je certifie sur l’honneur que les informations renseignées sont exactes et que ce traitement m’a déjà été prescrit par un médecin.
                  </span>
                </label>
              </section>
            ) : null}

            {consentRequired ? (
              <section className="sp-app-card">
                <div className="sp-app-section__header">
                  <div>
                    <h2 className="sp-app-section__title">Consentements requis</h2>
                    <p className="sp-app-section__hint">
                      Avant de poursuivre, vous devez valider les points ci-dessous.
                    </p>
                  </div>
                </div>

                <div className="sp-app-stack sp-app-stack--compact">
                  <label className="sp-app-checkbox">
                    <input
                      id="sp-consent-medical"
                      type="checkbox"
                      checked={consentTelemedicine}
                      onChange={(event) => setConsentTelemedicine(event.target.checked)}
                    />
                    <span>
                      J’accepte que ma demande et mes informations médicales soient traitées dans le cadre de la téléconsultation.
                    </span>
                  </label>

                  <label className="sp-app-checkbox">
                    <input
                      id="sp-consent-truth"
                      type="checkbox"
                      checked={consentTruth}
                      onChange={(event) => setConsentTruth(event.target.checked)}
                    />
                    <span>Je certifie que les informations renseignées sont exactes.</span>
                  </label>

                  <label className="sp-app-checkbox">
                    <input
                      id="sp-consent-cgu"
                      type="checkbox"
                      checked={consentCgu}
                      onChange={(event) => setConsentCgu(event.target.checked)}
                    />
                    <span>
                      J’ai lu et j’accepte{' '}
                      <a
                        href={compliance?.cgu_url || '#'}
                        target="_blank"
                        rel="noreferrer"
                        className="sp-app-link"
                      >
                        les CGU
                      </a>
                      .
                    </span>
                  </label>

                  <label className="sp-app-checkbox">
                    <input
                      id="sp-consent-privacy"
                      type="checkbox"
                      checked={consentPrivacy}
                      onChange={(event) => setConsentPrivacy(event.target.checked)}
                    />
                    <span>
                      J’ai lu{' '}
                      <a
                        href={compliance?.privacy_url || '#'}
                        target="_blank"
                        rel="noreferrer"
                        className="sp-app-link"
                      >
                        la politique de confidentialité
                      </a>
                      .
                    </span>
                  </label>
                </div>
              </section>
            ) : null}

            <div className="sp-app-actions">
              <Button type="button" variant="secondary" onClick={() => setStage('choose')} disabled={submitLoading}>
                Retour
              </Button>

              <Button type="button" onClick={handleContinueToPriority} disabled={submitLoading}>
                Continuer vers la priorité
              </Button>
            </div>
          </div>
        ) : null}

        {stage === 'priority_selection' ? (
          <div className="sp-app-stack">
            <section className="sp-app-card">
              <div className="sp-app-section__header">
                <div>
                  <h2 className="sp-app-section__title">Choisissez la priorité de traitement</h2>
                  <p className="sp-app-section__hint">
                    Cette étape intervient après la saisie médicale et avant l’autorisation de paiement.
                  </p>
                </div>
              </div>

              <div className="sp-app-summary-grid">
                <div className="sp-app-summary-card">
                  <div className="sp-app-summary-card__label">Scénario</div>
                  <div className="sp-app-summary-card__value">
                    {flow === 'ro_proof' ? 'Renouvellement avec preuve' : 'Dépannage sans preuve'}
                  </div>
                </div>
                <div className="sp-app-summary-card">
                  <div className="sp-app-summary-card__label">Médicaments</div>
                  <div className="sp-app-summary-card__value">{items.length}</div>
                </div>
                <div className="sp-app-summary-card">
                  <div className="sp-app-summary-card__label">Justificatifs</div>
                  <div className="sp-app-summary-card__value">{files.length}</div>
                </div>
              </div>

              {pricingLoading ? (
                <div className="sp-app-inline-status">
                  <Spinner />
                  <span>Chargement de la tarification…</span>
                </div>
              ) : pricing ? (
                <div className="sp-app-choice-grid">
                  <button
                    type="button"
                    className={cx('sp-app-choice-card', priority === 'standard' && 'is-selected')}
                    onClick={() => setPriority('standard')}
                  >
                    <div className="sp-app-choice-card__title">Standard</div>
                    <div className="sp-app-choice-card__text">{describePriorityTurnaround('standard', pricing)}</div>
                    <div className="sp-app-choice-card__meta">
                      {formatMoney(pricing.standard_cents, pricing.currency)}
                    </div>
                  </button>

                  <button
                    type="button"
                    className={cx('sp-app-choice-card', priority === 'express' && 'is-selected')}
                    onClick={() => setPriority('express')}
                  >
                    <div className="sp-app-choice-card__title">Express</div>
                    <div className="sp-app-choice-card__text">{describePriorityTurnaround('express', pricing)}</div>
                    <div className="sp-app-choice-card__meta">
                      {formatMoney(pricing.express_cents, pricing.currency)}
                    </div>
                  </button>
                </div>
              ) : (
                <Notice variant="error">
                  Impossible de charger la tarification dynamique depuis l’API. Merci de réessayer avant de poursuivre.
                </Notice>
              )}

              {paymentsConfig?.enabled ? (
                <div className="sp-app-block">
                  <Notice variant="info">
                    La priorité sélectionnée sera reprise dans le tunnel de paiement sécurisé.
                  </Notice>
                </div>
              ) : (
                <div className="sp-app-block">
                  <Notice variant="info">Paiement désactivé (mode test).</Notice>
                </div>
              )}

              {selectedAmount != null && pricing ? (
                <div className="sp-app-priority-selection__summary">
                  <strong>Montant sélectionné :</strong> {formatMoney(selectedAmount, pricing.currency)}
                  <br />
                  <span>{selectedPriorityEta}</span>
                </div>
              ) : null}
            </section>

            <div className="sp-app-actions">
              <Button type="button" variant="secondary" onClick={() => setStage('form')} disabled={submitLoading}>
                Retour à la saisie
              </Button>

              <Button type="button" onClick={handleSubmit} disabled={submitLoading || !pricing}>
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
          </div>
        ) : null}

        {stage === 'done' && submissionResult ? (
          <div className="sp-app-stack">
            <section className="sp-app-card sp-app-card--success">
              <div className="sp-app-confirmation">
                <div className="sp-app-confirmation__title">Merci ! Votre demande est enregistrée.</div>
                <div className="sp-app-confirmation__label">Numéro de dossier</div>
                <div className="sp-app-confirmation__uid-row">
                  <div className="sp-app-confirmation__uid">{submissionResult.uid}</div>
                  <button
                    type="button"
                    className="sp-app-icon-button"
                    onClick={() => {
                      void copyUid();
                    }}
                    aria-label="Copier le numéro de dossier"
                    title="Copier"
                  >
                    {copiedUid ? 'Copié' : 'Copier'}
                  </button>
                </div>
                <div className="sp-app-confirmation__text">
                  Conservez ce numéro. Il vous permettra de retrouver votre dossier et d’échanger avec le médecin.
                </div>
              </div>
            </section>

            {patientPortalUrl ? (
              <section className="sp-app-card">
                <div className="sp-app-section__header">
                  <div>
                    <h2 className="sp-app-section__title">Suite de la demande</h2>
                    <p className="sp-app-section__hint">
                      Vous pourrez suivre votre dossier et échanger avec le médecin depuis votre espace patient.
                    </p>
                  </div>
                </div>
                <div className="sp-app-actions sp-app-actions--start">
                  <a href={patientPortalUrl} className="sp-app-button sp-app-button--primary">
                    Ouvrir l’espace patient
                  </a>
                </div>
              </section>
            ) : null}

            <div className="sp-app-actions">
              <Button type="button" variant="secondary" onClick={resetToChoose}>
                Nouvelle demande
              </Button>
              <div className="sp-app-inline-note">
                Vous pourrez toujours compléter via la messagerie patient.
              </div>
            </div>
          </div>
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
