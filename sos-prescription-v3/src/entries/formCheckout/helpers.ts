import type { PricingConfig } from '../formTunnel/types';

export function formatMoney(amountCents: number | null | undefined, currency: string | undefined): string {
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

export function formatEtaMinutes(minutes: number | null | undefined): string | null {
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

export function describePriorityTurnaround(
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
