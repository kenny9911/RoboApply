// lib/server/brand.ts
//
// The brand of the current request, for server components, layouts,
// generateMetadata and route handlers (ARCHITECTURE.md §1.5).
//
//   const brand = await getServerBrand();          // ProductBrand
//   const client = await getServerClientBrand();   // ClientBrand for <Providers>
//
// Source of truth, in order:
//   1. On a dev/preview host: the `x-ra-brand` request header the proxy
//      stamped. It carries the `?__brand=` override on the very request that
//      sets the cookie, which a recomputation from cookies could not see.
//   2. Otherwise (and as the fallback): recompute from the host with the same
//      rules as the proxy (lib/brand/runtime.ts). On a production host this is
//      exactly what the proxy stamped, and it cannot be spoofed by a client
//      header on paths the proxy matcher skips (app/api/*).
//   3. Outside a request (static prerender): the deployment's locked brand,
//      else RoboApply.
//
// Server-only (reads next/headers). Client components use useBrand().

import { cookies, headers } from 'next/headers';

import { publicBrand, type ClientBrand } from '../brand/client';
import {
  DEFAULT_BRAND,
  getBrand,
  isDevOrPreviewHost,
  normalizeHost,
  parseBrandId,
  type BrandId,
  type ProductBrand,
} from '../brand/registry.generated';
import {
  BRAND_HEADER,
  BRAND_OVERRIDE_COOKIE,
  brandLock,
  resolveWebBrand,
  type EnvSource,
} from '../brand/runtime';

/** Headers that carry the visitor's country (Vercel, Cloudflare, generic proxies). */
const COUNTRY_HEADERS = ['x-vercel-ip-country', 'cf-ipcountry', 'x-country', 'x-geo-country'];

export interface HeaderBag {
  get(name: string): string | null;
}
export interface CookieBag {
  get(name: string): { value: string } | undefined;
}

/** Pure core of getServerBrandId (exported for tests). */
export function brandIdFromRequestParts(h: HeaderBag, c: CookieBag | null, env: EnvSource = process.env): BrandId {
  const host = normalizeHost(h.get('x-forwarded-host') || h.get('host'));
  if (isDevOrPreviewHost(host)) {
    const stamped = parseBrandId(h.get(BRAND_HEADER));
    if (stamped) return stamped;
  }
  return resolveWebBrand(
    {
      host: h.get('host'),
      forwardedHost: h.get('x-forwarded-host'),
      cookieOverride: c?.get(BRAND_OVERRIDE_COOKIE)?.value ?? null,
    },
    env,
  ).brandId;
}

export async function getServerBrandId(): Promise<BrandId> {
  try {
    const h = await headers();
    let c: CookieBag | null = null;
    try {
      c = await cookies();
    } catch {
      c = null;
    }
    return brandIdFromRequestParts(h, c);
  } catch {
    // No request (static prerender of /404, /500): serve the locked brand.
    return brandLock(process.env) ?? DEFAULT_BRAND;
  }
}

export async function getServerBrand(): Promise<ProductBrand> {
  return getBrand(await getServerBrandId());
}

/** The client view of the current brand, for <Providers brand=…>. */
export async function getServerClientBrand(): Promise<ClientBrand> {
  return publicBrand(await getServerBrand());
}

/** ISO-3166 alpha-2 country of the visitor (uppercase), or null. Feeds the wrong-market nudge. */
export async function getRequestCountry(): Promise<string | null> {
  try {
    const h = await headers();
    for (const name of COUNTRY_HEADERS) {
      const value = h.get(name);
      if (value && /^[a-z]{2}$/i.test(value.trim())) return value.trim().toUpperCase();
    }
  } catch {
    /* prerender: no request */
  }
  return null;
}
