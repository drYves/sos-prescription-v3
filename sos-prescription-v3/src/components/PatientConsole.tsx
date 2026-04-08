// src/components/PatientConsole.tsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import MessageInput from './messaging/MessageInput';
import MessageList from './messaging/MessageList';

type Scope = 'patient' | 'form' | 'admin';

type AppConfig = {
  restBase: string;
  nonce: string;
  currentUser?: {
    id?: number;
    displayName?: string;
    email?: string;
  };
};

type PrescriptionSummary = {
  id: number;
  uid: string;
  status: string;
  created_at: string;
  priority?: string;
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
  priority?: string;
  decision_reason?: string;
  files?: PrescriptionFile[];
  items: PrescriptionItem[];
};

type MessageItem = {
  id: number;
  author_role: string;
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

declare global {
  interface Window {
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
  }
}

function getAppConfig(): AppConfig {
  const cfg = window.SosPrescription || window.SOSPrescription;
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
    const message =
      payload && typeof payload === 'object' && 'message' in payload && typeof (payload as { message?: unknown }).message === 'string'
        ? String((payload as { message: string }).message)
        : `Erreur API (${response.status})`;
    throw new Error(message);
  }

  return payload as T;
}

async function listPatientPrescriptions(): Promise<PrescriptionSummary[]> {
  return apiJson<PrescriptionSummary[]>('/prescriptions', { method: 'GET' }, 'patient');
}

async function getPatientPrescription(id: number): Promise<PrescriptionDetail> {
  return apiJson<PrescriptionDetail>(`/prescriptions/${id}`, { method: 'GET' }, 'patient');
}

async function getPatientMessages(id: number): Promise<MessageItem[]> {
  return apiJson<MessageItem[]>(`/prescriptions/${id}/messages`, { method: 'GET' }, 'patient');
}

async function getPatientPdfStatus(id: number): Promise<PdfState> {
  const payload = await apiJson<{ pdf?: PdfState }>(`/prescriptions/${id}/pdf-status`, { method: 'GET' }, 'patient');
  return payload && payload.pdf ? payload.pdf : {};
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
  return apiJson<MessageItem>(
    `/prescriptions/${id}/messages`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body, attachments }),
    },
    'patient'
  );
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

function statusInfo(status: string): { variant: 'info' | 'success' | 'warning' | 'error'; label: string; hint: string } {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'payment_pending') {
    return {
      variant: 'warning',
      label: 'Paiement à autoriser',
      hint: 'Votre demande est créée. Autorisez le paiement pour l’envoyer en analyse médicale.',
    };
  }
  if (normalized === 'pending' || normalized === 'in_review' || normalized === 'needs_info') {
    return {
      variant: 'info',
      label: 'En cours d’analyse',
      hint: 'Un médecin examine votre dossier. Vous serez notifié ici si une précision est nécessaire.',
    };
  }
  if (normalized === 'approved') {
    return {
      variant: 'success',
      label: 'Validée',
      hint: 'Votre ordonnance sera disponible dans le bloc ci-dessous dès que le PDF sera prêt.',
    };
  }
  if (normalized === 'rejected') {
    return {
      variant: 'error',
      label: 'Refusée',
      hint: 'La demande a été refusée. Le motif (si renseigné) apparaît ci-dessous.',
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
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'approved' || normalized === 'rejected') return 2;
  if (normalized === 'pending' || normalized === 'in_review' || normalized === 'needs_info') return 1;
  return 0;
}

function formatMoney(amountCents: number | null | undefined, currency: string | null | undefined): string {
  const cents = typeof amountCents === 'number' ? amountCents : 0;
  const code = String(currency || 'EUR').toUpperCase();
  return `${(cents / 100).toFixed(2)} ${code}`;
}

let stripeScriptPromise: Promise<void> | null = null;

function ensureStripeJs(): Promise<void> {
  if (typeof window !== 'undefined' && typeof window.Stripe === 'function') {
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

function Spinner({ className = '' }: { className?: string }) {
  return <span className={`inline-block h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-transparent ${className}`} aria-label="Chargement" />;
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
  const tone =
    variant === 'success'
      ? 'border-green-200 bg-green-50 text-green-900'
      : variant === 'warning'
      ? 'border-yellow-200 bg-yellow-50 text-yellow-900'
      : variant === 'error'
      ? 'border-red-200 bg-red-50 text-red-900'
      : 'border-blue-200 bg-blue-50 text-blue-900';

  return (
    <div className={`rounded-2xl border px-4 py-3 text-sm ${tone}`}>
      {title ? <div className="font-semibold">{title}</div> : null}
      <div className={title ? 'mt-1' : undefined}>{children}</div>
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
  const base = 'inline-flex items-center justify-center rounded-2xl px-4 py-2 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed';
  const tone =
    variant === 'primary'
      ? 'bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500'
      : variant === 'danger'
      ? 'bg-red-600 text-white hover:bg-red-700 focus:ring-red-500'
      : 'bg-white text-gray-900 border border-gray-300 hover:bg-gray-50 hover:text-gray-900 hover:border-gray-400 focus:ring-gray-400';

  return (
    <button className={`${base} ${tone} ${className}`.trim()} {...rest}>
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
  const base = 'inline-flex items-center justify-center rounded-2xl px-4 py-2 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-offset-2';
  const tone =
    variant === 'primary'
      ? 'bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500'
      : 'bg-white text-gray-900 border border-gray-300 hover:bg-gray-50 hover:text-gray-900 hover:border-gray-400 focus:ring-gray-400';

  return (
    <a className={`${base} ${tone} ${className}`.trim()} href={href} target={target} rel="noopener noreferrer">
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
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
      {steps.map((step, index) => {
        const reached = index <= currentStep;
        const active = index === currentStep;
        return (
          <div key={step.key} className="flex items-center gap-3">
            <div
              aria-hidden="true"
              className={`flex h-7 w-7 items-center justify-center rounded-full border text-xs font-semibold ${
                reached ? 'border-blue-600 bg-blue-600 text-white' : 'border-gray-300 bg-white text-gray-500'
              }`}
            >
              {index + 1}
            </div>
            <div className={`text-sm ${reached ? 'text-gray-900' : 'text-gray-400'}${active ? ' font-semibold' : ''}`}>
              {step.label}
            </div>
            {index < steps.length - 1 ? (
              <div className={`hidden h-px w-10 sm:block ${index < currentStep ? 'bg-blue-600' : 'bg-gray-200'}`} aria-hidden="true" />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function PaymentCard({
  prescriptionId,
  priority,
  onPaid,
}: {
  prescriptionId: number;
  priority: 'express' | 'standard';
  onPaid: () => void;
}) {
  const cfg = getAppConfig();
  const mountRef = useRef<HTMLDivElement | null>(null);
  const stripeRef = useRef<ReturnType<NonNullable<typeof window.Stripe>> | null>(null);
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

        if (!intent.publishable_key) {
          throw new Error('Stripe n’est pas configuré (clé publique manquante).');
        }

        await ensureStripeJs();
        if (disposed) return;
        if (typeof window.Stripe !== 'function') {
          throw new Error('Stripe.js indisponible.');
        }
        if (!mountRef.current) {
          throw new Error('Zone de paiement introuvable.');
        }

        stripeRef.current = stripeRef.current || window.Stripe(intent.publishable_key);
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
  }, [prescriptionId, priority]);

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
    <div className="rounded-2xl border border-gray-200 bg-white p-4">
      <div className="mb-2 text-sm font-semibold text-gray-900">Paiement sécurisé</div>
      <div className="mb-3 text-sm text-gray-700">
        Montant : <span className="font-semibold">{formatMoney(amountCents, currency)}</span>
      </div>
      {error ? (
        <div className="mb-3">
          <Notice variant="error">{error}</Notice>
        </div>
      ) : null}
      <div className="rounded-2xl border border-gray-300 bg-white p-3">
        {initializing ? (
          <div className="flex items-center gap-2 text-sm text-gray-600">
            <Spinner /> Initialisation…
          </div>
        ) : (
          <div ref={mountRef} />
        )}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button type="button" onClick={handleSubmit} disabled={initializing || submitting}>
          {submitting ? <Spinner /> : 'Autoriser le paiement'}
        </Button>
        {paymentIntentId ? <div className="text-xs text-gray-500">Intent : {paymentIntentId}</div> : null}
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
      <div className="rounded-2xl border border-green-200 bg-green-50 p-4">
        <div className="text-sm font-semibold text-green-900">Ordonnance</div>
        <div className="mt-1 text-sm text-green-800">Votre ordonnance est prête. Le lien est sécurisé et régénéré automatiquement.</div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
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
      <div className="flex items-center gap-2">
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
  const [pdfStates, setPdfStates] = useState<Record<number, PdfState>>({});


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

  const selectedStatus = String(detail?.status || selectedSummary?.status || '').toLowerCase();
  const selectedPdf = selectedId ? pdfStates[selectedId] || null : null;

  const fileIndex = useMemo(() => {
    const index: Record<number, PrescriptionFile> = {};
    (detail?.files || []).forEach((file) => {
      index[file.id] = file;
    });
    return index;
  }, [detail?.files]);

  const refreshList = useCallback(async () => {
    setError(null);
    setListLoading(true);
    try {
      const rows = await listPatientPrescriptions();
      setPrescriptions(rows || []);
      setSelectedId((current) => {
        if (current && (rows || []).some((row) => Number(row.id) === Number(current))) {
          return current;
        }
        if (requestedId && (rows || []).some((row) => Number(row.id) === Number(requestedId))) {
          return requestedId;
        }
        return (rows || []).length > 0 ? Number((rows || [])[0].id) : null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur chargement');
      setPrescriptions([]);
    } finally {
      setListLoading(false);
    }
  }, [requestedId]);

  const loadDetail = useCallback(async (id: number) => {
    setError(null);
    setDetailLoading(true);
    try {
      const payload = await getPatientPrescription(id);
      setDetail(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur chargement');
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const loadMessages = useCallback(async (id: number, silent = false) => {
    if (!silent) {
      setError(null);
      setMessagesLoading(true);
    }
    try {
      const payload = await getPatientMessages(id);
      setMessages(payload || []);
    } catch (err) {
      if (!silent) {
        setError(err instanceof Error ? err.message : 'Erreur messagerie');
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
      const pdf = await getPatientPdfStatus(id);
      setPdfStates((current) => ({
        ...current,
        [id]: pdf || {},
      }));
    } catch (err) {
      if (!silent) {
        setError(err instanceof Error ? err.message : 'Erreur document');
      }
      setPdfStates((current) => ({
        ...current,
        [id]: {
          status: 'failed',
          message: 'Impossible de récupérer le statut PDF.',
          last_error_message: err instanceof Error ? err.message : 'Erreur document',
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
      setMessages((current) => [...current, message]);
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
      <div className="mx-auto max-w-3xl p-4">
        <Notice variant="warning">Connexion requise. Merci de vous connecter pour accéder à votre espace patient.</Notice>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl p-4">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xl font-semibold text-gray-900">Espace patient</div>
          <div className="text-sm text-gray-600">Suivi de vos demandes • messagerie asynchrone</div>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="secondary" onClick={() => void refreshAll()} disabled={listLoading}>
            {listLoading ? <Spinner /> : 'Rafraîchir'}
          </Button>
        </div>
      </div>

      {error ? (
        <div className="mb-4">
          <Notice variant="error">{error}</Notice>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-1">
          <div className="rounded-2xl border border-gray-200 bg-white">
            <div className="border-b border-gray-100 px-4 py-3 text-sm font-semibold text-gray-900">Mes demandes</div>
            <div className="max-h-[560px] overflow-auto">
              {prescriptions.length === 0 ? (
                <div className="px-4 py-3 text-sm text-gray-600">{listLoading ? 'Chargement…' : 'Aucune demande.'}</div>
              ) : null}

              {prescriptions.map((row) => {
                const info = statusInfo(row.status);
                const selected = Number(selectedId) === Number(row.id);
                return (
                  <button
                    key={row.id}
                    type="button"
                    className={`block w-full border-b border-gray-100 px-4 py-3 text-left hover:bg-gray-50 ${selected ? 'bg-blue-50' : ''}`}
                    onClick={() => setSelectedId(row.id)}
                  >
                    <div className="text-sm font-semibold text-gray-900">{row.uid}</div>
                    <div className="mt-1 text-xs text-gray-600">{info.label}</div>
                    <div className="mt-1 text-xs text-gray-500">{row.created_at}</div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="lg:col-span-2">
          <div className="rounded-2xl border border-gray-200 bg-white p-4">
            {!selectedId ? <div className="text-sm text-gray-600">Sélectionnez une demande à gauche.</div> : null}

            {selectedId && detailLoading ? (
              <div className="flex items-center gap-2 text-sm text-gray-600">
                <Spinner /> Chargement…
              </div>
            ) : null}

            {selectedId && detail ? (
              <div className="space-y-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-lg font-semibold text-gray-900">Demande {detail.uid}</div>
                  </div>
                </div>

                <Notice variant={statusInfo(detail.status).variant}>
                  <div className="flex flex-col gap-3">
                    <StatusTimeline status={detail.status} />
                    <div>
                      <div className="font-semibold">{statusInfo(detail.status).label}</div>
                      {statusInfo(detail.status).hint ? <div className="mt-1">{statusInfo(detail.status).hint}</div> : null}
                    </div>
                  </div>
                </Notice>

                <PdfCard status={detail.status} pdf={selectedPdf} />

                {detail.status === 'payment_pending' ? (
                  <PaymentCard
                    prescriptionId={detail.id}
                    priority={(selectedSummary?.priority || detail.priority || '').toLowerCase() === 'express' ? 'express' : 'standard'}
                    onPaid={() => {
                      void loadDetail(detail.id);
                      void refreshList();
                    }}
                  />
                ) : null}

                {detail.status === 'rejected' && detail.decision_reason ? (
                  <Notice variant="error" title="Motif">
                    <div className="whitespace-pre-wrap">{detail.decision_reason}</div>
                  </Notice>
                ) : null}

                <div>
                  <div className="mb-2 text-sm font-semibold text-gray-900">Documents</div>
                  {(detail.files || []).length === 0 ? (
                    <div className="text-sm text-gray-600">Aucun document pour le moment.</div>
                  ) : (
                    <div className="space-y-2">
                      {(detail.files || []).map((file) => (
                        <div key={file.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-gray-100 bg-gray-50 px-3 py-2">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-gray-900">{file.original_name}</div>
                            <div className="text-xs text-gray-600">
                              {filePurposeLabel(file.purpose)} • {file.mime || 'application/octet-stream'} • {Math.round((file.size_bytes || 0) / 1024)} Ko
                            </div>
                          </div>
                          <Button type="button" variant="secondary" onClick={() => void downloadProtectedFile(file.download_url, file.original_name)}>
                            Télécharger
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <div className="mb-2 text-sm font-semibold text-gray-900">Médicaments</div>
                  <div className="space-y-2">
                    {detail.items.map((item, index) => (
                      <div key={`${item.denomination}-${index}`} className="rounded-2xl border border-gray-100 bg-gray-50 p-3">
                        <div className="text-sm font-semibold text-gray-900">{item.denomination}</div>
                        {item.posologie ? <div className="mt-1 text-sm text-gray-700">Posologie : {item.posologie}</div> : null}
                        {item.quantite ? <div className="mt-1 text-sm text-gray-700">Quantité : {item.quantite}</div> : null}
                      </div>
                    ))}
                    {detail.items.length === 0 ? <div className="text-sm text-gray-600">—</div> : null}
                  </div>
                </div>

                <div>
                  <div className="mb-2 text-sm font-semibold text-gray-900">Messagerie</div>
                  {messagesLoading ? (
                    <div className="flex items-center gap-2 text-sm text-gray-600">
                      <Spinner /> Chargement…
                    </div>
                  ) : messages.length === 0 ? (
                    <div className="rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-600">
                      Espace d’échange sécurisé avec le médecin. Vous pouvez envoyer un message à tout moment.
                    </div>
                  ) : (
                    <MessageList
                      messages={messages}
                      viewerRole="PATIENT"
                      fileIndex={fileIndex}
                      onDownloadFile={handleMessageAttachmentDownload}
                    />
                  )}

                  {detail.status !== 'approved' && detail.status !== 'rejected' ? (
                    <div className="mt-4">
                      <MessageInput
                        prescriptionId={detail.id}
                        viewerRole="PATIENT"
                        uploadFile={uploadPatientFile}
                        postMessage={postPatientMessage}
                        onUploadsRegistered={registerUploadedFiles}
                        onMessageCreated={handleMessageCreated}
                        onSurfaceError={setError}
                      />
                    </div>
                  ) : (
                    <div className="mt-4">
                      <Notice variant="info">La messagerie est en lecture seule pour cette demande.</Notice>
                    </div>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
