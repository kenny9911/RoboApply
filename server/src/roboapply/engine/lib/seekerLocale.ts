// backend/src/seeker/lib/seekerLocale.ts
//
// Locale + market helpers scoped to the seeker product. Mirrors
// `marketFromAcceptLanguage` from the shared CurrencyService so the seeker
// boundary stays clean — seeker code can't reach into backend/src/services/.
//
// Keep the closed-list of supported locales aligned with the i18n surface
// in frontend/src/i18n/locales/.

export type SeekerLocale =
  | 'en'
  | 'zh'
  | 'zh-TW'
  | 'ja'
  | 'es'
  | 'fr'
  | 'pt'
  | 'de';

export const SEEKER_SUPPORTED_LOCALES: readonly SeekerLocale[] = [
  'en',
  'zh',
  'zh-TW',
  'ja',
  'es',
  'fr',
  'pt',
  'de',
];

export type SeekerMarket = 'cn' | 'tw' | 'jp' | 'other';

/**
 * Normalise a free-form locale or Accept-Language value to one of our 8
 * supported locales, or null when no acceptable match is found.
 */
export function normalizeLocale(input: string | undefined | null): SeekerLocale | null {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  if ((SEEKER_SUPPORTED_LOCALES as readonly string[]).includes(trimmed)) {
    return trimmed as SeekerLocale;
  }
  // Case-insensitive zh-TW / zh-tw match.
  const lowered = trimmed.toLowerCase();
  if (lowered === 'zh-tw') return 'zh-TW';
  // Strip subtag (e.g. en-US → en, pt-BR → pt).
  const base = trimmed.split('-')[0];
  if ((SEEKER_SUPPORTED_LOCALES as readonly string[]).includes(base)) {
    return base as SeekerLocale;
  }
  return null;
}

/**
 * Map an Accept-Language header to one of the closed-list markets used for
 * regional pricing. Mirrors the shared `marketFromAcceptLanguage` so behavior
 * is identical without a cross-boundary import.
 */
export function marketFromAcceptLanguage(header: string | undefined | null): SeekerMarket {
  if (!header || typeof header !== 'string') return 'other';
  const primary = header.split(',')[0]?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!primary) return 'other';
  if (primary.startsWith('zh-tw') || primary.startsWith('zh-hk') || primary.startsWith('zh-hant')) {
    return 'tw';
  }
  if (primary.startsWith('zh')) return 'cn';
  if (primary.startsWith('ja')) return 'jp';
  return 'other';
}
