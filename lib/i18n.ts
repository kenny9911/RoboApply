// roboapply-app/lib/i18n.ts
//
// next-intl runtime config. RoboApply uses FLAT URLs (no locale prefix),
// so we read the locale from a cookie at request time. Default `en`,
// fallback `en` for any missing key.
//
// The lightweight locale CONSTANTS (LOCALES / RoboLocale / DEFAULT_LOCALE /
// LOCALE_COOKIE / isLocale / READY_LOCALES) live in `./localeConfig` so client
// code can import them WITHOUT dragging the four message bundles below into
// the browser JS bundle. This module additionally owns `loadMessages`, the
// only piece that imports the (heavy) JSON — it is consumed server-side from
// app/layout.tsx.

export {
  LOCALES,
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  READY_LOCALES,
  isLocale,
} from './localeConfig';
export type { RoboLocale } from './localeConfig';

import type { RoboLocale } from './localeConfig';

/**
 * Statically import all locale bundles so they ship with the server build.
 *
 * Deep-clone via JSON parse/stringify to break the Module Namespace Object
 * wrapping that Next.js + webpack apply to JSON imports. Without this, the
 * namespace object leaks through next-intl's children path during static
 * prerender of /404 and /500 and you get React error #31 ("Objects are
 * not valid as a React child").
 */
import enMessages from '../i18n/messages/en.json';
import zhMessages from '../i18n/messages/zh.json';
import zhTwMessages from '../i18n/messages/zh-TW.json';
import jaMessages from '../i18n/messages/ja.json';

const EN: Record<string, unknown> = JSON.parse(JSON.stringify(enMessages));
const ZH: Record<string, unknown> = JSON.parse(JSON.stringify(zhMessages));
const ZH_TW: Record<string, unknown> = JSON.parse(JSON.stringify(zhTwMessages));
const JA: Record<string, unknown> = JSON.parse(JSON.stringify(jaMessages));

// Locales with a fully-translated bundle today. The remaining LOCALES
// (es / fr / pt / de) fall back to `en` until their bundles land — and are
// hidden from the UI switcher via READY_LOCALES in ./localeConfig.
const MESSAGES: Record<RoboLocale, Record<string, unknown>> = {
  en: EN,
  zh: ZH,
  'zh-TW': ZH_TW,
  ja: JA,
  es: EN,
  fr: EN,
  pt: EN,
  de: EN,
};

export function loadMessages(
  locale: RoboLocale,
): Record<string, unknown> {
  return MESSAGES[locale] ?? MESSAGES.en;
}
