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
import { DEFAULT_BRAND, type BrandId } from './brand/registry.generated';
import { substituteBrandTokens } from './brand/tokens';

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
// Staged English from the feature waves (ARCHITECTURE.md §10.1.2). Generated
// by scripts/i18n-merge-staging.mjs; empty namespaces until a WP writes keys.
import { STAGING_EN } from '../i18n/staging/index';

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

/**
 * English = en.json with the staged English merged over it (staging wins), so
 * a key a feature WP adds during the waves renders — in English, in every
 * locale — instead of the raw dotted path. INT merges staging into en.json
 * and translates it (scripts/i18n-merge-staging.mjs, WP-91).
 */
const EN: Messages = mergeOverEn(clone(enMessages), clone(STAGING_EN));

/** Every non-EN bundle is merged over EN — full bundles are unaffected,
 *  partial bundles degrade gracefully to English (staged keys included).
 *  These still carry the `%BRAND%` / `%OTHER_BRAND%` tokens; loadMessages
 *  substitutes them. */
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

/** Substituted bundles, memoized per brand × locale (at most 18 entries). */
const BRANDED = new Map<string, Messages>();

/**
 * The message bundle for a locale with the brand tokens replaced
 * (ARCHITECTURE.md §1.7): `%BRAND%` → the brand's product name,
 * `%OTHER_BRAND%` → the other brand's. Bundles never carry a literal brand
 * name. `brandId` defaults to RoboApply for callers that predate brands
 * (lib/seo.ts, metadata helpers); pages get the request's brand from
 * app/layout.tsx.
 */
export function loadMessages(
  locale: RoboLocale,
  brandId: BrandId = DEFAULT_BRAND,
): Record<string, unknown> {
  const key = `${brandId}:${MESSAGES[locale] ? locale : 'en'}`;
  let out = BRANDED.get(key);
  if (!out) {
    out = substituteBrandTokens(MESSAGES[locale] ?? MESSAGES.en, brandId);
    BRANDED.set(key, out);
  }
  return out;
}
