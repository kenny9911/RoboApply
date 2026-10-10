// components/features/campus/serverData.ts — SERVER-ONLY reads for the /campus
// route files (WP-58). Not exported from index.ts (it reads next/headers).
//
// The pages render the public campus API on the server so crawlers get the
// programmes (F-SEO-07 cn) and so a capability that is off answers 404 (R-04):
// the API's `404 feature_disabled` becomes the page's notFound(). The request
// goes to a trusted origin only (see trustedApiOrigin) with the visitor's host
// as the brand hint, so the API resolves the same brand as the page.
// A network failure is not a 404: the client list loads and shows its error.

import type { Metadata } from 'next';
import { cache } from 'react';
import { headers } from 'next/headers';

import { campusPublicPaths, type CampusCompanyResponse, type CampusEventList } from '../../../lib/api/campus';
import { BRAND_HEADER, parseBrandHostMap } from '../../../lib/brand/runtime';
import { BRAND_IDS, getBrand, normalizeHost } from '../../../lib/brand/registry.generated';
import { getServerBrandId } from '../../../lib/server/brand';
import { resolveLocale } from '../../../lib/serverLocale';
import { marketingMetadata, messageAt } from '../../../lib/seo';

export type ServerRead<T> = { status: 'ok'; data: T } | { status: 'disabled' } | { status: 'not_found' } | { status: 'error' };

export const SERVER_FETCH_TIMEOUT_MS = 4_000;

const SAFE_HOST = /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:]+\])(?::\d{1,5})?$/;

/** The visitor's host as sent (first value, lower case, port kept), or null when it is not a plain host. */
function rawHostOf(value: string | null | undefined): string | null {
  const host = (value ?? '').split(',')[0]!.trim().toLowerCase();
  return host && SAFE_HOST.test(host) ? host : null;
}

/**
 * Where the server-side read goes. Never an origin built from an arbitrary
 * request header: a spoofed Host / X-Forwarded-Host must not make the Next
 * server fetch (and render) someone else's JSON. In order:
 *   1. INTERNAL_API_ORIGIN (server-only, .env.example) or NEXT_PUBLIC_API_URL;
 *   2. the visitor's host, only when it is a configured brand host (registry
 *      hosts, BRAND_HOST_MAP, this deployment's VERCEL_URL; registry devHosts
 *      outside production only);
 *   3. this deployment's VERCEL_URL;
 *   else none (the page renders and the client list loads on its own).
 * The visitor's host still goes along as the brand hint in every case.
 */
export function trustedApiOrigin(visitorHost: string | null | undefined, env: Record<string, string | undefined> = process.env): string | null {
  const configured = (env.INTERNAL_API_ORIGIN || env.NEXT_PUBLIC_API_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  const raw = rawHostOf(visitorHost);
  const host = normalizeHost(raw);
  const vercel = normalizeHost(env.VERCEL_URL);
  if (raw && host) {
    // Dev hosts only outside production: a spoofed "localhost:<port>" must not reach a local service in production.
    const isDev = env.NODE_ENV !== 'production' && BRAND_IDS.some((id) => getBrand(id).devHosts.includes(host));
    const known =
      isDev || BRAND_IDS.some((id) => getBrand(id).hosts.includes(host)) || parseBrandHostMap(env.BRAND_HOST_MAP).has(host) || (!!vercel && host === vercel);
    // A production host keeps the default https port: the visitor never picks a port there.
    if (known) return isDev ? `http://${raw}` : `https://${host}`;
  }
  return vercel ? `https://${vercel}` : null;
}

async function visitorHost(): Promise<string | null> {
  try {
    const h = await headers();
    return rawHostOf(h.get('x-forwarded-host') || h.get('host'));
  } catch {
    return null;
  }
}

export async function readPublicCampus<T>(path: string): Promise<ServerRead<T>> {
  const host = await visitorHost();
  const origin = trustedApiOrigin(host);
  if (!origin) return { status: 'error' };
  const brandId = await getServerBrandId();
  try {
    const res = await fetch(`${origin}${path}`, {
      method: 'GET',
      cache: 'no-store',
      headers: { accept: 'application/json', ...(host ? { 'x-forwarded-host': host } : {}), [BRAND_HEADER]: brandId },
      signal: AbortSignal.timeout(SERVER_FETCH_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => null)) as { success?: boolean; data?: T; code?: string } | null;
    if (res.status === 404) return { status: body?.code === 'feature_disabled' || body?.code === 'brand_unavailable' ? 'disabled' : 'not_found' };
    if (!res.ok || !body || body.data === undefined) return { status: 'error' };
    return { status: 'ok', data: body.data };
  } catch {
    return { status: 'error' };
  }
}

export interface CampusSearch {
  class?: number;
  role?: string;
  city?: string;
  openNow?: boolean;
}

/** Page search params → the list filter (invalid values dropped). */
export function campusSearch(sp: Record<string, string | string[] | undefined>): CampusSearch {
  const one = (k: string) => {
    const v = sp[k];
    return (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
  };
  const cls = Number(one('class'));
  const role = one('role')?.slice(0, 80);
  const city = one('city')?.slice(0, 40);
  return {
    ...(Number.isInteger(cls) && cls >= 2025 && cls <= 2030 ? { class: cls } : {}),
    ...(role ? { role } : {}),
    ...(city ? { city } : {}),
    ...(one('openNow') === 'true' ? { openNow: true } : {}),
  };
}

function qs(f: CampusSearch): string {
  const q = new URLSearchParams();
  if (f.class) q.set('class', String(f.class));
  if (f.role) q.set('role', f.role);
  if (f.city) q.set('city', f.city);
  if (f.openNow) q.set('openNow', 'true');
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** One read per request, shared by generateMetadata and the page. */
export const readCampusList = cache((query: string) => readPublicCampus<CampusEventList>(campusPublicPaths.list(query)));
export const readCampusCompany = cache((slug: string) => readPublicCampus<CampusCompanyResponse>(campusPublicPaths.company(slug)));

export function campusListQuery(f: CampusSearch): string {
  return qs(f);
}

// ── Metadata ──

const fill = (s: string, vars: Record<string, string>) => s.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);

/** `<title> | <brand>` metadata for a campus page; noindex unless the read succeeded. */
export async function campusMetadata(input: { path: string; titleKey: string; descriptionKey: string; vars?: Record<string, string>; indexable: boolean }): Promise<Metadata> {
  const brand = getBrand(await getServerBrandId());
  const locale = await resolveLocale(brand);
  const vars = input.vars ?? {};
  const title = `${fill(messageAt(locale, brand.id, input.titleKey, brand.name), vars)} | ${brand.name}`;
  return marketingMetadata({
    brandId: brand.id,
    locale,
    path: input.path,
    title,
    description: fill(messageAt(locale, brand.id, input.descriptionKey), vars),
    noindex: !input.indexable,
  });
}
