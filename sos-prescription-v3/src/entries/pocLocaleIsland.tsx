import React from 'react';
import { createRoot } from 'react-dom/client';

type LocaleContract = {
  activeLocale?: string;
  defaultLocale?: string;
  supportedLocales?: string[];
  resolutionSource?: string;
  surface?: {
    slug?: string;
    kind?: string;
    isPocSurface?: boolean;
  };
  diagnostics?: {
    contractVersion?: number;
  };
};

type RuntimeConfig = {
  localeContract?: LocaleContract;
};

type PocWindow = Window & {
  SOSPrescription?: RuntimeConfig;
  SosPrescription?: RuntimeConfig;
  __SosPrescriptionPocLocaleIslandRoot?: ReturnType<typeof createRoot>;
};

const MOUNT_ID = 'sosprescription-poc-locale-island';

const COPY = {
  'fr-FR': {
    title: 'Contrat de langue reçu',
    activeLocale: 'Locale active',
    surface: 'Surface',
    resolutionSource: 'Source de résolution',
    contractVersion: 'Version du contrat',
  },
  'en-GB': {
    title: 'Locale contract received',
    activeLocale: 'Active locale',
    surface: 'Surface',
    resolutionSource: 'Resolution source',
    contractVersion: 'Contract version',
  },
} as const;

function readRuntimeContract(): LocaleContract | null {
  const pocWindow = window as PocWindow;
  const runtime = pocWindow.SOSPrescription ?? pocWindow.SosPrescription;
  const contract = runtime?.localeContract;

  if (!contract || typeof contract !== 'object') {
    return null;
  }

  return contract;
}

function copyFor(contract: LocaleContract): (typeof COPY)['fr-FR'] {
  return contract.activeLocale === 'en-GB' ? COPY['en-GB'] : COPY['fr-FR'];
}

function PocLocaleIsland({ contract }: { contract: LocaleContract }) {
  const copy = copyFor(contract);
  const activeLocale = contract.activeLocale || '—';
  const surfaceSlug = contract.surface?.slug || '—';
  const resolutionSource = contract.resolutionSource || '—';
  const contractVersion = contract.diagnostics?.contractVersion ?? '—';

  return (
    <aside
      className="sp-poc-locale-island"
      aria-label={copy.title}
      style={{
        marginTop: '1rem',
        padding: '0.75rem 1rem',
        border: '1px solid rgba(15, 23, 42, 0.14)',
        borderRadius: '0.75rem',
        fontSize: '0.875rem',
        lineHeight: 1.5,
      }}
      data-poc-locale-island="1"
      data-active-locale={activeLocale}
      data-surface-slug={surfaceSlug}
    >
      <strong>{copy.title}</strong>
      <dl style={{ margin: '0.5rem 0 0', display: 'grid', gap: '0.25rem' }}>
        <div>
          <dt style={{ display: 'inline', fontWeight: 600 }}>{copy.activeLocale} : </dt>
          <dd style={{ display: 'inline', margin: 0 }}>{activeLocale}</dd>
        </div>
        <div>
          <dt style={{ display: 'inline', fontWeight: 600 }}>{copy.surface} : </dt>
          <dd style={{ display: 'inline', margin: 0 }}>{surfaceSlug}</dd>
        </div>
        <div>
          <dt style={{ display: 'inline', fontWeight: 600 }}>{copy.resolutionSource} : </dt>
          <dd style={{ display: 'inline', margin: 0 }}>{resolutionSource}</dd>
        </div>
        <div>
          <dt style={{ display: 'inline', fontWeight: 600 }}>{copy.contractVersion} : </dt>
          <dd style={{ display: 'inline', margin: 0 }}>{contractVersion}</dd>
        </div>
      </dl>
    </aside>
  );
}

(function boot() {
  const container = document.getElementById(MOUNT_ID);
  if (!(container instanceof HTMLElement)) {
    return;
  }

  const contract = readRuntimeContract();
  if (!contract) {
    return;
  }

  const pocWindow = window as PocWindow;
  pocWindow.__SosPrescriptionPocLocaleIslandRoot?.unmount?.();

  const root = createRoot(container);
  pocWindow.__SosPrescriptionPocLocaleIslandRoot = root;
  root.render(
    <React.StrictMode>
      <PocLocaleIsland contract={contract} />
    </React.StrictMode>,
  );
})();
