// lib/api/brand.ts — the requesting host's brand and its capabilities, plus
// the UI-language preference the brand's language switchers persist.
//
// Thin typed wrapper (FND-7; filled by WP-12). The public-brand path constant
// stays in lib/api/client.ts (`PUBLIC_BRAND_PATH`) because lib/flags.ts reads
// it too.
//
// Endpoints:
//   GET    /api/v1/public/brand
//   PUT    /api/v1/roboapply/v2/preferences/locale

import { PUBLIC_BRAND_PATH } from './client';
import { call, type CallOptions } from './contracts/wire';
import type * as BR from './contracts/brand';
import type { RoboLocale } from '../localeConfig';

/** The legacy V2 route that stores the UI language on the seeker profile. */
const LOCALE_PREFERENCE_PATH = '/api/v1/roboapply/v2/preferences/locale';

/** `brand.public` — GET /api/v1/public/brand (any visitor; Cache-Control 5 min). */
export function getPublicBrand(opts?: CallOptions): Promise<BR.PublicBrand> {
  return call<BR.PublicBrand>('GET', PUBLIC_BRAND_PATH, opts);
}

/**
 * PUT /api/v1/roboapply/v2/preferences/locale — persist the chosen UI
 * language so requestless jobs (digests, score refresh) write in it. Signed-in
 * users only (401 otherwise); the `robo_locale` cookie stays authoritative
 * for the live UI, so callers treat this as best-effort.
 */
export function setLocalePreference(locale: RoboLocale, opts?: CallOptions): Promise<{ locale: string }> {
  return call<{ locale: string }>('PUT', LOCALE_PREFERENCE_PATH, { ...opts, body: { locale } });
}

/** Every wrapper of this area, for callers that prefer one import. */
export const brandApi = {
  getPublicBrand,
  setLocalePreference,
};
