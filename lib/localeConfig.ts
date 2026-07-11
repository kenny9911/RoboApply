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
export function localePath(locale: RoboLocale): string {
  return locale === DEFAULT_LOCALE ? '/' : `/${locale}`;
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
export function matchLocale(tags: readonly string[]): RoboLocale | null {
  for (const raw of tags) {
    const tag = raw.trim();
    if (!tag) continue;
    if (isLocale(tag)) return tag;
    const lower = tag.toLowerCase();
    if (lower.startsWith('zh')) {
      // Traditional-script regions and explicit Hant → zh-TW; rest → zh.
      if (/hant|tw|hk|mo/.test(lower)) return 'zh-TW';
      return 'zh';
    }
    const base = lower.split('-')[0];
    if (isLocale(base)) return base;
  }
  return null;
}

/**
 * The locales the in-app language switcher offers, with native display
 * labels. This is the user-facing subset of LOCALES — extend it as each
 * additional bundle is completed. (es / fr / pt / de are declared in LOCALES
 * for forward-compat but fall back to `en` and are intentionally hidden here.)
 */
export const READY_LOCALES: { code: RoboLocale; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'zh', label: '简体中文' },
  { code: 'zh-TW', label: '繁體中文' },
  { code: 'ja', label: '日本語' },
];
