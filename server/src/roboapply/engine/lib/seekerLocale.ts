// backend/src/seeker/lib/seekerLocale.ts
//
// Locale + market helpers scoped to the seeker product. Mirrors
// `marketFromAcceptLanguage` from the shared CurrencyService so the seeker
// boundary stays clean — seeker code can't reach into backend/src/services/.
//
// Keep the closed-list of supported locales aligned with the i18n surface
// in frontend/src/i18n/locales/.

// Keep in lockstep with RA_LOCALES (roboapply/v2/lib/raLocale.ts) and LOCALES
// (roboapply/lib/localeConfig.ts). This union is what gets PERSISTED to
// SeekerProfile.locale at signup, so a locale missing here is permanently
// stored as null and every requestless job falls back to English.
export type SeekerLocale =
  | 'en'
  | 'zh'
  | 'zh-TW'
  | 'ja'
  | 'ko'
  | 'es'
  | 'fr'
  | 'pt'
  | 'de';

export const SEEKER_SUPPORTED_LOCALES: readonly SeekerLocale[] = [
  'en',
  'zh',
  'zh-TW',
  'ja',
  'ko',
  'es',
  'fr',
  'pt',
  'de',
];

export type SeekerMarket = 'cn' | 'tw' | 'jp' | 'other';

/** Normalise ONE tag (no commas) to a supported locale, or null. */
function normalizeTag(tag: string): SeekerLocale | null {
  const trimmed = tag.trim();
  if (!trimmed) return null;
  if ((SEEKER_SUPPORTED_LOCALES as readonly string[]).includes(trimmed)) {
    return trimmed as SeekerLocale;
  }
  const lowered = trimmed.toLowerCase().replace('_', '-');
  // Traditional-Chinese variants → zh-TW. Same /hant|tw|hk|mo/ test as
  // normalizeRaLocale and localeConfig.matchLocale — all three must agree or
  // the UI language and the LLM's output language diverge.
  if (lowered.startsWith('zh')) {
    return /hant|tw|hk|mo/.test(lowered) ? 'zh-TW' : 'zh';
  }
  // Strip subtag (e.g. en-US → en, pt-BR → pt).
  const base = lowered.split('-')[0];
  if ((SEEKER_SUPPORTED_LOCALES as readonly string[]).includes(base)) {
    return base as SeekerLocale;
  }
  return null;
}

/**
 * Normalise a free-form locale OR a full `Accept-Language` header to one of our
 * supported locales, or null when no acceptable match is found.
 *
 * Callers pass both shapes — SeekerAuthService.signup does
 * `normalizeLocale(locale ?? acceptLanguage)` — so the q-ordered comma list has
 * to be walked, not treated as a single tag. It previously wasn't: a header of
 * `"zh-TW,zh;q=0.9,en;q=0.8"` matched no branch (the whole string isn't a tag,
 * and `split('-')[0]` is `"zh-TW,zh;q=0.9,en;q=0"`)… except the *first* tag was
 * salvaged by the base-split only for simple headers, so Traditional-Chinese
 * signups landed on Simplified `zh` — or on null, which persists as English.
 */
export function normalizeLocale(input: string | undefined | null): SeekerLocale | null {
  if (!input || typeof input !== 'string') return null;
  // Walk the q-ordered list and take the first supported tag. A bare locale
  // string ("zh-TW") is just a one-element list, so this covers both shapes.
  for (const part of input.split(',')) {
    const match = normalizeTag(part.split(';')[0] ?? '');
    if (match) return match;
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
