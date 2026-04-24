import React from 'react';
import { createRoot } from 'react-dom/client';
import { getPocLocaleIslandText } from '../pocLocale/pocTexts';

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

function readRuntimeContract(): LocaleContract | null {
  const pocWindow = window as PocWindow;
  const runtime = pocWindow.SOSPrescription ?? pocWindow.SosPrescription;
  const contract = runtime?.localeContract;

  if (!contract || typeof contract !== 'object') {
    return null;
  }

  return contract;
}

function PocLocaleIsland({ contract }: { contract: LocaleContract }) {
  const activeLocaleCode = contract.activeLocale;
  const title = getPocLocaleIslandText(activeLocaleCode, 'title');
  const activeLocaleLabel = getPocLocaleIslandText(activeLocaleCode, 'activeLocaleLabel');
  const surfaceLabel = getPocLocaleIslandText(activeLocaleCode, 'surfaceLabel');
  const resolutionSourceLabel = getPocLocaleIslandText(activeLocaleCode, 'resolutionSourceLabel');
  const contractVersionLabel = getPocLocaleIslandText(activeLocaleCode, 'contractVersionLabel');
  const activeLocale = contract.activeLocale || '—';
  const surfaceSlug = contract.surface?.slug || '—';
  const resolutionSource = contract.resolutionSource || '—';
  const contractVersion = contract.diagnostics?.contractVersion ?? '—';

  return (
    <aside
      className="sp-poc-locale-island"
      aria-label={title}
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
      <strong>{title}</strong>
      <dl style={{ margin: '0.5rem 0 0', display: 'grid', gap: '0.25rem' }}>
        <div>
          <dt style={{ display: 'inline', fontWeight: 600 }}>{activeLocaleLabel} : </dt>
          <dd style={{ display: 'inline', margin: 0 }}>{activeLocale}</dd>
        </div>
        <div>
          <dt style={{ display: 'inline', fontWeight: 600 }}>{surfaceLabel} : </dt>
          <dd style={{ display: 'inline', margin: 0 }}>{surfaceSlug}</dd>
        </div>
        <div>
          <dt style={{ display: 'inline', fontWeight: 600 }}>{resolutionSourceLabel} : </dt>
          <dd style={{ display: 'inline', margin: 0 }}>{resolutionSource}</dd>
        </div>
        <div>
          <dt style={{ display: 'inline', fontWeight: 600 }}>{contractVersionLabel} : </dt>
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
