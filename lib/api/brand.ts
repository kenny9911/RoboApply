// lib/api/brand.ts — the requesting host's brand and its capabilities.
//
// Thin typed wrapper (FND-7). Owner: WP-12 (it also moves the
// LanguageSwitcher's locale-preference call here). The path constant stays in
// lib/api/client.ts (`PUBLIC_BRAND_PATH`) because lib/flags.ts reads it too.
//
// Endpoints:
//   GET    /api/v1/public/brand

import { PUBLIC_BRAND_PATH } from './client';
import { call, type CallOptions } from './contracts/wire';
import type * as BR from './contracts/brand';

/** `brand.public` — GET /api/v1/public/brand (any visitor; Cache-Control 5 min). */
export function getPublicBrand(opts?: CallOptions): Promise<BR.PublicBrand> {
  return call<BR.PublicBrand>('GET', PUBLIC_BRAND_PATH, opts);
}

/** Every wrapper of this area, for callers that prefer one import. */
export const brandApi = {
  getPublicBrand,
};
