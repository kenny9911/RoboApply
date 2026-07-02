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
