// roboapply-app/lib/i18n.ts
//
// next-intl runtime config. RoboApply uses FLAT URLs (no locale prefix),
// so we read the locale from a cookie at request time. Default `en`,
// fallback `en` for any missing key.
//
// The lightweight locale CONSTANTS (LOCALES / RoboLocale / DEFAULT_LOCALE /
// LOCALE_COOKIE / isLocale / READY_LOCALES) live in `./localeConfig` so client
// code can import them WITHOUT dragging the message bundles below into
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
import koMessages from '../i18n/messages/ko.json';
import esMessages from '../i18n/messages/es.json';
import frMessages from '../i18n/messages/fr.json';
import ptMessages from '../i18n/messages/pt.json';
import deMessages from '../i18n/messages/de.json';

type Messages = Record<string, unknown>;

function clone(bundle: unknown): Messages {
  return JSON.parse(JSON.stringify(bundle));
}

/**
 * Deep-merge a (possibly partial) locale bundle over the English base, so
 * every locale can ship incrementally: translated namespaces win, anything
 * missing falls back to `en` key-by-key instead of erroring at render time.
 * Arrays and scalars are replaced wholesale; only plain objects recurse.
 */
function mergeOverEn(base: Messages, override: Messages): Messages {
  const out: Messages = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const prev = out[key];
    if (
      value &&
      prev &&
      typeof value === 'object' &&
      typeof prev === 'object' &&
      !Array.isArray(value) &&
      !Array.isArray(prev)
    ) {
      out[key] = mergeOverEn(prev as Messages, value as Messages);
    } else {
      out[key] = value;
    }
  }
  return out;
}

const EN: Messages = clone(enMessages);

/** Every non-EN bundle is merged over EN — full bundles are unaffected,
 *  partial bundles (ko/es/fr/pt/de today) degrade gracefully to English. */
const MESSAGES: Record<RoboLocale, Messages> = {
  en: EN,
  zh: mergeOverEn(EN, clone(zhMessages)),
  'zh-TW': mergeOverEn(EN, clone(zhTwMessages)),
  ja: mergeOverEn(EN, clone(jaMessages)),
  ko: mergeOverEn(EN, clone(koMessages)),
  es: mergeOverEn(EN, clone(esMessages)),
  fr: mergeOverEn(EN, clone(frMessages)),
  pt: mergeOverEn(EN, clone(ptMessages)),
  de: mergeOverEn(EN, clone(deMessages)),
};

export function loadMessages(
  locale: RoboLocale,
): Record<string, unknown> {
  return MESSAGES[locale] ?? MESSAGES.en;
}
