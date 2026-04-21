import React from 'react';
import StripePaymentModule, {
  type StripePaymentModuleProps,
} from '../../components/payment/StripePaymentModule';
import type {
  FlowType,
  PricingConfig,
} from '../formTunnel/types';
import { describePriorityTurnaround, formatMoney } from './helpers';

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

type LucideIconProps = {
  className?: string;
};

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

function getFlowLabel(flow: FlowType): string {
  return flow === 'ro_proof'
    ? 'Renouvellement habituel · Avec justificatif'
    : 'Dépannage SOS · Sans justificatif';
}

export type CheckoutPrioritySectionProps = {
  flow: FlowType;
  itemsCount: number;
  filesCount: number;
  pricingLoading: boolean;
  pricing: PricingConfig | null;
  priority: 'standard' | 'express';
  selectedAmount: number | null;
  selectedPriorityEta: string;
  onPriorityChange: (priority: 'standard' | 'express') => void;
  onBack: () => void;
  onContinue: () => void;
  continueDisabled: boolean;
};

export type CheckoutStripeProps = Pick<
  StripePaymentModuleProps,
  | 'billingName'
  | 'billingEmail'
  | 'fallbackPublishableKey'
  | 'prerequisiteError'
  | 'createIntent'
  | 'confirmIntent'
  | 'onAuthorized'
  | 'onAuthorizedState'
  | 'onErrorState'
  | 'safeErrorMessage'
>;

export type CheckoutPaymentSectionProps = {
  priority: 'standard' | 'express';
  pricingLoading: boolean;
  pricing: PricingConfig | null;
  selectedAmount: number | null;
  selectedPriorityEta: string;
  stripeProps: CheckoutStripeProps;
  onBack: () => void;
};

export type CheckoutSectionProps =
  | {
    mode: 'priority';
    priorityProps: CheckoutPrioritySectionProps;
  }
  | {
    mode: 'payment';
    paymentProps: CheckoutPaymentSectionProps;
  };

export function CheckoutSection(props: CheckoutSectionProps) {
  if (props.mode === 'payment') {
    const { paymentProps } = props;

    return (
      <StripePaymentModule
        mode="tunnel"
        title="Paiement sécurisé"
        intro="Votre carte est uniquement autorisée avant la transmission au médecin. Aucun débit n’est réalisé avant validation médicale."
        note="Carte bancaire sécurisée par Stripe • Autorisation uniquement • Aucun débit avant validation médicale"
        amountCents={paymentProps.selectedAmount}
        currency={paymentProps.pricing?.currency || 'EUR'}
        etaValue={paymentProps.selectedPriorityEta || null}
        summaryLoading={paymentProps.pricingLoading}
        onBack={paymentProps.onBack}
        backLabel="Modifier mon choix"
        submitIdleLabel="Valider et envoyer ma demande"
        submitBusyLabel="Validation sécurisée en cours…"
        mountLoadingLabel="Chargement du formulaire bancaire sécurisé…"
        submittingStatusLabel="Validation bancaire sécurisée en cours. Ne fermez pas la page et ne cliquez pas une seconde fois."
        {...paymentProps.stripeProps}
      />
    );
  }

  const { priorityProps } = props;

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
            <div className="sp-app-summary-card__value">{getFlowLabel(priorityProps.flow)}</div>
          </div>
          <div className="sp-app-summary-card">
            <div className="sp-app-summary-card__label">Médicaments</div>
            <div className="sp-app-summary-card__value">{priorityProps.itemsCount}</div>
          </div>
          <div className="sp-app-summary-card">
            <div className="sp-app-summary-card__label">Justificatifs</div>
            <div className="sp-app-summary-card__value">{priorityProps.filesCount}</div>
          </div>
        </div>

        {priorityProps.pricingLoading ? (
          <div className="sp-app-inline-status">
            <Spinner />
            <span>Chargement du montant de la demande…</span>
          </div>
        ) : priorityProps.pricing ? (
          <div className="sp-app-choice-grid" role="radiogroup" aria-label="Choisir le délai de traitement">
            <button
              type="button"
              role="radio"
              aria-checked={priorityProps.priority === 'standard'}
              data-selected={priorityProps.priority === 'standard' ? 'true' : 'false'}
              className={cx('sp-app-choice-card', priorityProps.priority === 'standard' && 'is-selected')}
              onClick={() => priorityProps.onPriorityChange('standard')}
            >
              <div className="sp-app-choice-card__header">
                <span className="sp-app-choice-card__icon" aria-hidden="true">
                  <Clock2Icon />
                </span>
                <div className="sp-app-choice-card__title">Standard</div>
              </div>
              <div className="sp-app-choice-card__text">{describePriorityTurnaround('standard', priorityProps.pricing)}</div>
              <div className="sp-app-choice-card__meta">
                {formatMoney(priorityProps.pricing.standard_cents, priorityProps.pricing.currency)}
              </div>
            </button>

            <button
              type="button"
              role="radio"
              aria-checked={priorityProps.priority === 'express'}
              data-selected={priorityProps.priority === 'express' ? 'true' : 'false'}
              className={cx('sp-app-choice-card', priorityProps.priority === 'express' && 'is-selected')}
              onClick={() => priorityProps.onPriorityChange('express')}
            >
              <div className="sp-app-choice-card__header">
                <span className="sp-app-choice-card__icon" aria-hidden="true">
                  <TimerIcon />
                </span>
                <div className="sp-app-choice-card__title">Express</div>
              </div>
              <div className="sp-app-choice-card__text">{describePriorityTurnaround('express', priorityProps.pricing)}</div>
              <div className="sp-app-choice-card__meta">
                {formatMoney(priorityProps.pricing.express_cents, priorityProps.pricing.currency)}
              </div>
            </button>
          </div>
        ) : (
          <Notice variant="error">
            Nous n’avons pas pu charger le montant de la demande. Merci de réessayer avant de poursuivre.
          </Notice>
        )}

        {priorityProps.selectedAmount != null && priorityProps.pricing ? (
          <div className="sp-app-inline-note">
            Sélection actuelle : <strong>{priorityProps.priority === 'express' ? 'Express' : 'Standard'}</strong> · {priorityProps.selectedPriorityEta} · {formatMoney(priorityProps.selectedAmount, priorityProps.pricing.currency)}
          </div>
        ) : null}
      </section>

      <div className="sp-app-actions">
        <Button type="button" variant="secondary" onClick={priorityProps.onBack}>
          Modifier mes informations
        </Button>

        <Button type="button" onClick={priorityProps.onContinue} disabled={priorityProps.continueDisabled}>
          Continuer
        </Button>
      </div>
    </div>
  );
}
