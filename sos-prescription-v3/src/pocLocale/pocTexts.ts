// This module is strictly scoped to the POC locale island and is not a global i18n system.

export const POC_SUPPORTED_LOCALES = ['fr-FR', 'en-GB'] as const;

export type PocSupportedLocale = (typeof POC_SUPPORTED_LOCALES)[number];
export type PocTextNamespace = 'localeIsland';
export type PocLocaleIslandTextKey =
  | 'title'
  | 'activeLocaleLabel'
  | 'surfaceLabel'
  | 'resolutionSourceLabel'
  | 'contractVersionLabel';

export const POC_LOCALE_TEXTS = {
  localeIsland: {
    title: {
      'fr-FR': 'Contrat de langue reçu',
      'en-GB': 'Locale contract received',
    },
    activeLocaleLabel: {
      'fr-FR': 'Locale active',
      'en-GB': 'Active locale',
    },
    surfaceLabel: {
      'fr-FR': 'Surface',
      'en-GB': 'Surface',
    },
    resolutionSourceLabel: {
      'fr-FR': 'Source de résolution',
      'en-GB': 'Resolution source',
    },
    contractVersionLabel: {
      'fr-FR': 'Version du contrat',
      'en-GB': 'Contract version',
    },
  },
} as const;

function isSupportedLocale(locale: string): locale is PocSupportedLocale {
  return (POC_SUPPORTED_LOCALES as readonly string[]).includes(locale);
}

function resolvePocTextLocale(locale: string | null | undefined): PocSupportedLocale {
  return isSupportedLocale(String(locale ?? '')) ? (locale as PocSupportedLocale) : 'fr-FR';
}

export function getPocLocaleIslandText(
  locale: string | null | undefined,
  key: PocLocaleIslandTextKey,
): string {
  const requestedLocale = resolvePocTextLocale(locale);
  const entry = POC_LOCALE_TEXTS.localeIsland[key];

  if (entry[requestedLocale]) {
    return entry[requestedLocale];
  }

  if (entry['fr-FR']) {
    return entry['fr-FR'];
  }

  return `[missing:pocLocale.localeIsland.${key}]`;
}
