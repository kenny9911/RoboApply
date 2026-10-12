// roboapply/lib/localeConfig.ts
//
// Lightweight locale constants — NO message-bundle imports. This is the
// module client code is allowed to import (the language switcher, the API
// client's header injector, the cookie helper). Keeping it free of the heavy
// JSON `import enMessages from '...'` graph means pulling a locale constant
// into a client component does NOT drag all four ~70 KB message bundles into
// the browser JS bundle.
//
// `lib/i18n.ts` re-exports everything here and adds the server-side message
// loader (`loadMessages`), which is the only piece that imports the bundles.

export const LOCALES = [
  'en',
  'zh',
  'zh-TW',
  'ja',
  'ko',
  'es',
  'fr',
  'pt',
  'de',
] as const;
export type RoboLocale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: RoboLocale = 'en';
export const LOCALE_COOKIE = 'robo_locale';

export function isLocale(value: string | undefined): value is RoboLocale {
  return !!value && (LOCALES as readonly string[]).includes(value);
}

/**
 * Canonical landing path for a locale — `/` for English (the x-default),
 * `/{locale}` for everything else. Lives here (not lib/seo.ts) so client
 * components can build crawlable language links without importing the
 * message bundles.
 */
export function localePath(
  locale: RoboLocale,
  defaultLocale: RoboLocale = DEFAULT_LOCALE,
): string {
  return locale === defaultLocale ? '/' : `/${locale}`;
}

// ── Brand clamp helpers ─────────────────────────────────────────────────────
//
// Each product brand serves a subset of LOCALES (lib/brand: RoboApply all 9,
// default `en`; GoApply `zh` + `en`, default `zh`). These helpers take the
// brand's list explicitly (`brand.locales`, `brand.defaultLocale`) so this
// module stays free of brand and bundle imports and remains client-safe.

/** True when `value` is one of `allowed`. */
export function isLocaleIn(
  value: string | null | undefined,
  allowed: readonly RoboLocale[],
): value is RoboLocale {
  return !!value && (allowed as readonly string[]).includes(value);
}

/** Narrow `value` to `allowed`, else `fallback` (the brand's default locale). */
export function clampLocale(
  value: string | null | undefined,
  allowed: readonly RoboLocale[],
  fallback: RoboLocale,
): RoboLocale {
  return isLocaleIn(value, allowed) ? value : fallback;
}

/** Native display label for every locale (landing language menu + SEO). */
export const LOCALE_LABELS: Record<RoboLocale, string> = {
  en: 'English',
  zh: '简体中文',
  'zh-TW': '繁體中文',
  ja: '日本語',
  ko: '한국어',
  es: 'Español',
  fr: 'Français',
  pt: 'Português',
  de: 'Deutsch',
};

/**
 * Locales whose LANDING page is actually translated (landing + meta
 * namespaces). Only these join the hreflang cluster, the sitemap, and get
 * indexed at /{locale} — an untranslated locale URL serving English content
 * under a foreign hreflang tag would poison the whole cluster. Extend as
 * landing translations land.
 */
export const SEO_READY_LOCALES: readonly RoboLocale[] = [
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

/**
 * hreflang value per locale — script subtags for Chinese (zh-Hans / zh-Hant
 * per Google's guidance) while URLs keep the short internal codes.
 */
export const HREFLANG: Record<RoboLocale, string> = {
  en: 'en',
  zh: 'zh-Hans',
  'zh-TW': 'zh-Hant',
  ja: 'ja',
  ko: 'ko',
  es: 'es',
  fr: 'fr',
  pt: 'pt',
  de: 'de',
};

/**
 * Best-match a browser Accept-Language tag list against our locales.
 * Handles script/region variants (zh-Hant / zh-HK / zh-MO → zh-TW,
 * anything zh-* else → zh; pt-BR/pt-PT → pt; en-GB → en; …).
 * Tags are assumed to be in preference order (q-values pre-sorted or ignored).
 */
export function matchLocale(
  tags: readonly string[],
  allowed: readonly RoboLocale[] = LOCALES,
): RoboLocale | null {
  for (const raw of tags) {
    const candidate = matchOneTag(raw);
    // A brand that does not serve the matched locale skips to the next tag.
    if (candidate && isLocaleIn(candidate, allowed)) return candidate;
  }
  return null;
}

function matchOneTag(raw: string): RoboLocale | null {
  const tag = raw.trim();
  if (!tag) return null;
  if (isLocale(tag)) return tag;
  const lower = tag.toLowerCase();
  if (lower.startsWith('zh')) {
    // Traditional-script regions and explicit Hant → zh-TW; rest → zh.
    if (/hant|tw|hk|mo/.test(lower)) return 'zh-TW';
    return 'zh';
  }
  const base = lower.split('-')[0];
  return isLocale(base) ? base : null;
}

/**
 * THE language-switcher list — one list for every switcher (the in-app
 * LanguageSwitcher, AuthShell and the landing LanguageMenu; ARCHITECTURE.md
 * §1.6). Pass the brand's locales (`useBrand().locales`) so GoApply offers
 * only 简体中文 + English; with no argument it is every locale (RoboApply).
 * Order follows LOCALES; labels are native names.
 */
export function switcherLocales(
  allowed: readonly RoboLocale[] = LOCALES,
): { code: RoboLocale; label: string }[] {
  return LOCALES.filter((code) => isLocaleIn(code, allowed)).map((code) => ({
    code,
    label: LOCALE_LABELS[code],
  }));
}

/**
 * RoboApply's switcher list (all nine bundles are complete). Kept as a
 * constant for existing importers; new code calls
 * `switcherLocales(brand.locales)` so the list follows the brand.
 */
export const READY_LOCALES: { code: RoboLocale; label: string }[] =
  switcherLocales(LOCALES);

/**
 * The languages a MOCK INTERVIEW can be conducted in. This is a different
 * question from READY_LOCALES: the interview language picks the voice, the STT
 * pinning and the interviewer's spoken language — it does not depend on the app
 * chrome being translated. The voice engine supports all nine natively
 * (`SupportedLocale` in server/src/interview-engine/voice/voiceCatalog.ts, plus
 * LANGUAGE_NAMES in prompt/voiceSystemPrompt.ts), so this list MUST match that
 * union.
 *
 * The practice launcher used to seed and render from READY_LOCALES, which
 * silently downgraded a ko / es / fr / pt / de user to an English-speaking
 * interviewer with no way to change it.
 */
export const INTERVIEW_LOCALES: { code: RoboLocale; label: string }[] =
  LOCALES.map((code) => ({ code, label: LOCALE_LABELS[code] }));
