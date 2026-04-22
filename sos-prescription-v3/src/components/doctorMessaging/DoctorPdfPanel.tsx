import React from 'react';

type DoctorPdfPanelProps = {
  detail: Record<string, unknown> | null;
  pdf: Record<string, unknown> | null;
  loading?: boolean;
};

function normalizeText(value: unknown): string {
  return String(value == null ? '' : value).trim();
}

function firstText(values: unknown[]): string {
  for (const value of values) {
    const text = normalizeText(value);
    if (text) {
      return text;
    }
  }
  return '';
}

function iframeSrcFromDownloadUrl(url: string): string {
  const raw = normalizeText(url);
  if (!raw) {
    return '';
  }

  try {
    const parsed = new URL(raw, window.location.href);
    parsed.hash = 'toolbar=0&view=FitH';
    return parsed.toString();
  } catch {
    return `${raw.split('#')[0]}#toolbar=0&view=FitH`;
  }
}

export default function DoctorPdfPanel({ detail, pdf, loading = false }: DoctorPdfPanelProps) {
  if (!detail) {
    return loading ? <div className="dc-loading">Chargement du PDF…</div> : null;
  }

  const decisionStatus = normalizeText(detail.status).toLowerCase();
  if (decisionStatus !== 'approved') {
    return (
      <div className="dc-pdf-card">
        <div className="dc-card__title">Ordonnance PDF</div>
        <div className="dc-pdf-placeholder">PDF disponible après validation.</div>
      </div>
    );
  }

  const status = normalizeText(pdf?.status || 'pending').toLowerCase();
  const downloadUrl = normalizeText(pdf?.download_url);
  const message = firstText([
    pdf?.message,
    pdf?.last_error_message,
    status === 'done'
      ? 'PDF prêt.'
      : (loading ? 'Chargement du PDF…' : (status === 'failed' ? 'Le PDF n’est pas disponible.' : 'PDF en cours de génération.')),
  ]);

  if (!downloadUrl) {
    return (
      <div className="dc-pdf-card">
        <div className="dc-card__title">Ordonnance PDF</div>
        <div className="dc-pdf-placeholder">{message}</div>
      </div>
    );
  }

  return (
    <div className="dc-pdf-card">
      <div className="dc-card__title">Ordonnance PDF</div>
      <div className="dc-pdf-actions">
        <a
          className="sp-button sp-button--secondary dc-pdf-open"
          href={downloadUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          Ouvrir le PDF
        </a>
      </div>
      <iframe
        className="dc-pdf-frame"
        src={iframeSrcFromDownloadUrl(downloadUrl)}
        loading="lazy"
        title="Ordonnance PDF"
      />
    </div>
  );
}
