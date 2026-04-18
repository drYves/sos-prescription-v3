// src/components/payment/StripePaymentModule.tsx · V8.1.0
import React, { useCallback, useEffect, useRef, useState } from 'react';

export type StripePaymentMode = 'tunnel' | 'patient_space';

export type StripePaymentIntentPayload = {
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

type StripeCardElementInstance = {
  mount: (element: HTMLElement) => void;
  destroy: () => void;
};

type StripeElementsInstance = {
  create: (type: 'card', options?: Record<string, unknown>) => StripeCardElementInstance;
};

type StripeConfirmCardResult = {
  error?: {
    message?: string;
  };
  paymentIntent?: {
    id?: string;
    status?: string;
  };
};

type StripeJsInstance = {
  elements: (options?: Record<string, unknown>) => StripeElementsInstance;
  confirmCardPayment: (
    clientSecret: string,
    payload: Record<string, unknown>,
  ) => Promise<StripeConfirmCardResult>;
};

type StripePaymentWindow = Window & {
  Stripe?: (publishableKey: string) => StripeJsInstance;
};

export type StripePaymentResolutionMeta = {
  mode: StripePaymentMode;
  paymentIntentId: string;
  status: string | null;
  amountCents: number | null;
  currency: string;
};

export type StripePaymentModuleProps = {
  mode: StripePaymentMode;
  title: string;
  intro: string;
  note: string;
  amountCents?: number | null;
  currency?: string | null;
  etaValue?: string | null;
  summaryLoading?: boolean;
  billingName?: string;
  billingEmail?: string;
  fallbackPublishableKey?: string | null;
  prerequisiteError?: string | null;
  createIntent: () => Promise<StripePaymentIntentPayload>;
  confirmIntent: (paymentIntentId: string) => Promise<unknown>;
  onAuthorized: () => void | Promise<void>;
  onIntentReady?: (intent: { amountCents: number; currency: string }) => void;
  onAuthorizedState?: (event: 'resume' | 'authorized', meta: StripePaymentResolutionMeta) => void;
  onErrorState?: (meta: { mode: StripePaymentMode; error: unknown; message: string }) => void;
  safeErrorMessage?: (error: unknown) => string;
  onBack?: () => void;
  backLabel?: string;
  submitIdleLabel?: React.ReactNode;
  submitBusyLabel?: React.ReactNode;
  mountLoadingLabel?: string;
  submittingStatusLabel?: string | null;
};

let stripeScriptPromise: Promise<void> | null = null;

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

function toOptionalNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : null;
}

function normalizeCurrency(value: unknown, fallback = 'EUR'): string {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return normalized !== '' ? normalized : fallback;
}

function normalizeStatus(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function formatMoney(amountCents: number | null | undefined, currency: string | null | undefined): string {
  const cents = typeof amountCents === 'number' ? amountCents : 0;
  const code = normalizeCurrency(currency, 'EUR');

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

export function toMedicalGradePaymentErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || '');
  const message = raw.trim().toLowerCase();

  if (!message) {
    return 'La sécurisation bancaire n’a pas pu aboutir. Merci de réessayer.';
  }

  if (
    message.includes('stripe')
    || message.includes('paymentintent')
    || message.includes('client secret')
    || message.includes('clé publique')
    || message.includes('module bancaire')
    || message.includes('paiement introuvable')
    || message.includes('zone de paiement')
  ) {
    return 'Le formulaire bancaire sécurisé n’a pas pu être chargé. Merci de réessayer dans quelques instants.';
  }

  if (message.includes('refus') || message.includes('carte')) {
    return 'La vérification de votre carte n’a pas pu aboutir. Merci de contrôler les informations saisies ou d’essayer une autre carte.';
  }

  if (message.includes('finalisée') || message.includes('finalise')) {
    return 'La vérification bancaire est encore en cours. Merci de patienter quelques secondes puis de réessayer.';
  }

  return 'La sécurisation bancaire n’a pas pu aboutir. Merci de réessayer.';
}

function buildPaymentResolutionMeta(
  mode: StripePaymentMode,
  paymentIntentId: string,
  status: string | null,
  amountCents: number | null,
  currency: string,
): StripePaymentResolutionMeta {
  return {
    mode,
    paymentIntentId,
    status,
    amountCents,
    currency,
  };
}

function extractConfirmStatus(payload: unknown): string {
  if (payload && typeof payload === 'object' && 'status' in payload) {
    return normalizeStatus((payload as { status?: unknown }).status);
  }

  return '';
}

async function ensureStripeJs(): Promise<void> {
  const currentWindow = (typeof window !== 'undefined' ? window : null) as StripePaymentWindow | null;
  if (currentWindow && typeof currentWindow.Stripe === 'function') {
    return Promise.resolve();
  }

  if (!stripeScriptPromise) {
    stripeScriptPromise = new Promise<void>((resolve, reject) => {
      const onError = (): void => {
        stripeScriptPromise = null;
        reject(new Error('Impossible de charger Stripe.js'));
      };

      const existing = document.querySelector<HTMLScriptElement>('script[data-stripe-js="1"]');
      if (existing) {
        const refreshedWindow = window as StripePaymentWindow;
        if (typeof refreshedWindow.Stripe === 'function') {
          resolve();
          return;
        }

        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener('error', onError, { once: true });
        return;
      }

      const script = document.createElement('script');
      script.src = 'https://js.stripe.com/v3/';
      script.async = true;
      script.dataset.stripeJs = '1';
      script.addEventListener('load', () => resolve(), { once: true });
      script.addEventListener('error', onError, { once: true });
      document.body.appendChild(script);
    });
  }

  return stripeScriptPromise;
}

function LoadingSpinner({ mode, className = '' }: { mode: StripePaymentMode; className?: string }) {
  return <span className={cx(mode === 'tunnel' ? 'sp-app-spinner' : 'sp-spinner', className)} aria-label="Chargement" />;
}

function ErrorNotice({ mode, message }: { mode: StripePaymentMode; message: string }) {
  if (mode === 'tunnel') {
    return <div className="sp-app-notice sp-app-notice--error">{message}</div>;
  }

  return <div className="sp-alert sp-alert--error">{message}</div>;
}

function ActionButton({
  mode,
  variant = 'primary',
  className = '',
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  mode: StripePaymentMode;
  variant?: 'primary' | 'secondary';
}) {
  if (mode === 'tunnel') {
    const variantClass = variant === 'primary' ? 'sp-app-button--primary' : 'sp-app-button--secondary';
    return (
      <button className={cx('sp-app-button', variantClass, className)} {...props}>
        {children}
      </button>
    );
  }

  return (
    <button
      className={cx('sp-button', variant === 'primary' ? 'sp-button--primary' : 'sp-button--secondary', className)}
      {...props}
    >
      {children}
    </button>
  );
}

export default function StripePaymentModule({
  mode,
  title,
  intro,
  note,
  amountCents: initialAmountCents = null,
  currency: initialCurrency = 'EUR',
  etaValue = null,
  summaryLoading = false,
  billingName,
  billingEmail,
  fallbackPublishableKey = null,
  prerequisiteError = null,
  createIntent,
  confirmIntent,
  onAuthorized,
  onIntentReady,
  onAuthorizedState,
  onErrorState,
  safeErrorMessage = toMedicalGradePaymentErrorMessage,
  onBack,
  backLabel = 'Retour',
  submitIdleLabel,
  submitBusyLabel,
  mountLoadingLabel,
  submittingStatusLabel,
}: StripePaymentModuleProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const stripeRef = useRef<StripeJsInstance | null>(null);
  const cardRef = useRef<StripeCardElementInstance | null>(null);

  const [initializing, setInitializing] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);
  const [amountCents, setAmountCents] = useState<number | null>(toOptionalNumber(initialAmountCents));
  const [currency, setCurrency] = useState<string>(normalizeCurrency(initialCurrency, 'EUR'));

  useEffect(() => {
    let disposed = false;

    async function boot(): Promise<void> {
      setError(null);
      setInitializing(true);
      setSubmitting(false);
      setClientSecret(null);
      setPaymentIntentId(null);
      setAmountCents(toOptionalNumber(initialAmountCents));
      setCurrency(normalizeCurrency(initialCurrency, 'EUR'));

      if (prerequisiteError) {
        setError(prerequisiteError);
        setInitializing(false);
        return;
      }

      try {
        const intent = await createIntent();
        if (disposed) {
          return;
        }

        const nextClientSecret = typeof intent.client_secret === 'string' ? intent.client_secret.trim() : '';
        const nextPaymentIntentId = typeof intent.payment_intent_id === 'string' ? intent.payment_intent_id.trim() : '';
        const nextStatus = normalizeStatus(intent.status);
        const nextPublishableKey = typeof intent.publishable_key === 'string' && intent.publishable_key.trim() !== ''
          ? intent.publishable_key.trim()
          : String(fallbackPublishableKey || '').trim();
        const nextAmount = toOptionalNumber(intent.amount_cents) ?? toOptionalNumber(initialAmountCents);
        const nextCurrency = normalizeCurrency(intent.currency, normalizeCurrency(initialCurrency, 'EUR'));

        setClientSecret(nextClientSecret || null);
        setPaymentIntentId(nextPaymentIntentId || null);
        setAmountCents(nextAmount);
        setCurrency(nextCurrency);

        if (typeof nextAmount === 'number') {
          onIntentReady?.({
            amountCents: nextAmount,
            currency: nextCurrency,
          });
        }

        if (nextPaymentIntentId && (nextStatus === 'requires_capture' || nextStatus === 'succeeded')) {
          const confirmed = await confirmIntent(nextPaymentIntentId);
          if (disposed) {
            return;
          }

          const confirmedStatus = extractConfirmStatus(confirmed) || nextStatus;
          if (confirmedStatus === 'requires_capture' || confirmedStatus === 'succeeded') {
            onAuthorizedState?.('resume', buildPaymentResolutionMeta(mode, nextPaymentIntentId, confirmedStatus || null, nextAmount, nextCurrency));
            await Promise.resolve(onAuthorized());
            return;
          }
        }

        if (!nextClientSecret) {
          throw new Error('Le formulaire bancaire sécurisé n’a pas pu être préparé.');
        }

        if (!nextPublishableKey) {
          throw new Error('Le formulaire bancaire sécurisé n’est pas disponible pour le moment.');
        }

        await ensureStripeJs();
        if (disposed) {
          return;
        }

        const currentWindow = window as StripePaymentWindow;
        if (typeof currentWindow.Stripe !== 'function') {
          throw new Error('Le formulaire bancaire sécurisé n’a pas pu être chargé.');
        }

        if (!mountRef.current) {
          throw new Error('La zone de saisie bancaire n’est pas disponible pour le moment.');
        }

        if (cardRef.current) {
          try {
            cardRef.current.destroy();
          } catch {
            // noop
          }
          cardRef.current = null;
        }

        mountRef.current.innerHTML = '';
        stripeRef.current = currentWindow.Stripe(nextPublishableKey);
        const elements = stripeRef.current.elements();
        const card = elements.create('card');
        card.mount(mountRef.current);
        cardRef.current = card;
      } catch (bootError) {
        if (!disposed) {
          const message = safeErrorMessage(bootError);
          setError(message);
          onErrorState?.({ mode, error: bootError, message });
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
          // noop
        }
        cardRef.current = null;
      }
    };
  }, [
    createIntent,
    safeErrorMessage,
    confirmIntent,
    fallbackPublishableKey,
    initialAmountCents,
    initialCurrency,
    mode,
    onAuthorized,
    onAuthorizedState,
    onErrorState,
    onIntentReady,
    prerequisiteError,
  ]);

  const handleAuthorize = useCallback(async (): Promise<void> => {
    setError(null);

    if (!clientSecret) {
      setError('Le formulaire bancaire sécurisé n’est pas encore prêt. Merci de patienter quelques secondes.');
      return;
    }

    if (!stripeRef.current || !cardRef.current) {
      setError('Le formulaire bancaire sécurisé n’est pas encore prêt. Merci de patienter quelques secondes.');
      return;
    }

    setSubmitting(true);

    try {
      const result = await stripeRef.current.confirmCardPayment(clientSecret, {
        payment_method: {
          card: cardRef.current,
          billing_details: {
            name: billingName || undefined,
            email: billingEmail || undefined,
          },
        },
      });

      if (result?.error) {
        throw new Error(result.error.message || 'La vérification de votre carte n’a pas pu aboutir.');
      }

      const confirmedPaymentIntentId = typeof result?.paymentIntent?.id === 'string' && result.paymentIntent.id.trim() !== ''
        ? result.paymentIntent.id.trim()
        : paymentIntentId;

      if (!confirmedPaymentIntentId) {
        throw new Error('La vérification bancaire n’a pas pu être finalisée.');
      }

      const confirmPayload = await confirmIntent(confirmedPaymentIntentId);
      const confirmStatus = extractConfirmStatus(confirmPayload);

      if (confirmStatus !== '' && confirmStatus !== 'requires_capture' && confirmStatus !== 'succeeded') {
        throw new Error('La vérification bancaire est encore en cours. Merci de patienter quelques secondes puis de réessayer.');
      }

      onAuthorizedState?.(
        'authorized',
        buildPaymentResolutionMeta(
          mode,
          confirmedPaymentIntentId,
          confirmStatus || normalizeStatus(result?.paymentIntent?.status) || null,
          amountCents,
          currency,
        ),
      );
      await Promise.resolve(onAuthorized());
    } catch (authorizationError) {
      const message = safeErrorMessage(authorizationError);
      setError(message);
      onErrorState?.({ mode, error: authorizationError, message });
    } finally {
      setSubmitting(false);
    }
  }, [amountCents, billingEmail, billingName, clientSecret, confirmIntent, currency, mode, onAuthorized, onAuthorizedState, onErrorState, paymentIntentId, safeErrorMessage]);

  const resolvedSubmitIdleLabel = submitIdleLabel || (mode === 'tunnel' ? 'Valider et envoyer ma demande' : (amountCents ? `Finaliser mon paiement — ${formatMoney(amountCents, currency)}` : 'Finaliser mon paiement'));
  const resolvedSubmitBusyLabel = submitBusyLabel || 'Validation sécurisée en cours…';
  const resolvedMountLoadingLabel = mountLoadingLabel || (mode === 'tunnel' ? 'Chargement du formulaire bancaire sécurisé…' : 'Chargement du formulaire de paiement sécurisé…');
  const resolvedSubmittingStatusLabel = submittingStatusLabel || 'Validation bancaire sécurisée en cours. Ne fermez pas la page et ne cliquez pas une seconde fois.';

  if (mode === 'tunnel') {
    return (
      <div className="sp-app-stack">
        <section className="sp-app-card sp-app-card--payment">
          <div className="sp-app-section__header">
            <div>
              <h2 className="sp-app-section__title">{title}</h2>
              <p className="sp-app-section__hint">{intro}</p>
            </div>
          </div>

          {summaryLoading ? (
            <div className="sp-app-inline-status">
              <LoadingSpinner mode={mode} />
              <span>Préparation du montant de votre demande…</span>
            </div>
          ) : null}

          <div className="sp-app-payment-summary" role="list" aria-label="Récapitulatif avant paiement">
            <div className="sp-app-payment-summary__item" role="listitem">
              <span className="sp-app-payment-summary__label">Montant</span>
              <strong className="sp-app-payment-summary__value">{formatMoney(amountCents, currency)}</strong>
            </div>
            <div className="sp-app-payment-summary__item" role="listitem">
              <span className="sp-app-payment-summary__label">Délai</span>
              <strong className="sp-app-payment-summary__value">{etaValue || '—'}</strong>
            </div>
          </div>

          <div className="sp-app-payment-panel" data-loading={submitting ? 'true' : initializing ? 'setup' : 'false'} aria-busy={initializing || submitting}>
            <div className="sp-app-inline-note sp-app-inline-note--payment">{note}</div>

            {error ? (
              <div className="sp-app-block">
                <ErrorNotice mode={mode} message={error} />
              </div>
            ) : null}

            <div className="sp-app-payment-panel__mount-frame">
              {initializing ? (
                <div className="sp-app-inline-status">
                  <LoadingSpinner mode={mode} />
                  <span>{resolvedMountLoadingLabel}</span>
                </div>
              ) : null}
              <div ref={mountRef} data-sp-stripe-mount="1" />
            </div>
          </div>
        </section>

        <div className="sp-app-actions">
          {onBack ? (
            <ActionButton type="button" mode={mode} variant="secondary" onClick={onBack} disabled={submitting}>
              {backLabel}
            </ActionButton>
          ) : null}
          <ActionButton
            type="button"
            mode={mode}
            onClick={() => { void handleAuthorize(); }}
            disabled={initializing || submitting || Boolean(prerequisiteError)}
            aria-busy={submitting}
            data-loading={submitting ? 'true' : 'false'}
          >
            {submitting ? (
              <>
                <LoadingSpinner mode={mode} />
                <span>{resolvedSubmitBusyLabel}</span>
              </>
            ) : (
              resolvedSubmitIdleLabel
            )}
          </ActionButton>
        </div>

        {submitting ? (
          <div className="sp-app-inline-status sp-app-inline-status--payment" role="status" aria-live="polite">
            <LoadingSpinner mode={mode} />
            <span>{resolvedSubmittingStatusLabel}</span>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="sp-card sp-payment-card" aria-busy={initializing || submitting}>
      <div className="sp-stack sp-stack--compact">
        <div>
          <div className="sp-section__title">{title}</div>
          <p className="sp-field__help">{intro}</p>
        </div>

        {summaryLoading ? (
          <div className="sp-loading-row">
            <LoadingSpinner mode={mode} />
            <span>Préparation du montant de votre dossier…</span>
          </div>
        ) : null}

        <div className="sp-payment-card__summary">
          Montant : <span className="sp-text-strong">{formatMoney(amountCents, currency)}</span>
        </div>
        {etaValue ? <div className="sp-payment-card__summary">Délai estimé : <span className="sp-text-strong">{etaValue}</span></div> : null}
        <div className="sp-payment-card__notice">{note}</div>

        {error ? (
          <div className="sp-inline-note">
            <ErrorNotice mode={mode} message={error} />
          </div>
        ) : null}

        <div className="sp-payment-card__mount">
          {initializing ? (
            <div className="sp-loading-row">
              <LoadingSpinner mode={mode} />
              <span>{resolvedMountLoadingLabel}</span>
            </div>
          ) : null}
          <div ref={mountRef} data-sp-stripe-mount="1" />
        </div>

        <div className="sp-payment-card__footer">
          <ActionButton
            type="button"
            mode={mode}
            onClick={() => { void handleAuthorize(); }}
            disabled={initializing || submitting || Boolean(prerequisiteError)}
            aria-busy={submitting}
          >
            {submitting ? (
              <>
                <LoadingSpinner mode={mode} />
                <span>{resolvedSubmitBusyLabel}</span>
              </>
            ) : (
              resolvedSubmitIdleLabel
            )}
          </ActionButton>
        </div>

        {submitting ? (
          <div className="sp-loading-row" role="status" aria-live="polite">
            <LoadingSpinner mode={mode} />
            <span>{resolvedSubmittingStatusLabel}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
