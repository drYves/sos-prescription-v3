import React from 'react';

export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <span
      className={cx('sp-app-spinner', className)}
      aria-label="Chargement"
    />
  );
}

export function Notice({
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

export function Button({
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

export function TextInput({
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

type LucideIconProps = {
  className?: string;
};

export function Settings2Icon({ className = '' }: LucideIconProps) {
  return (
    <svg className={cx('sp-lucide', className)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 17H5" />
      <path d="M19 7h-9" />
      <circle cx="17" cy="17" r="3" />
      <circle cx="7" cy="7" r="3" />
    </svg>
  );
}

export function XIcon({ className = '' }: LucideIconProps) {
  return (
    <svg className={cx('sp-lucide', className)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

export function formatAmountValue(amount: number | null | undefined, currency: string | undefined): string {
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
