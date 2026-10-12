// components/features/marketing/links.ts — pure link builders for the
// marketing site (WP-40). No React, so pages, tests and the server metadata
// can share them.
//
//   buildSignupHref('pricing', '?utm_source=x&job=cm1')  → '/signup?from=pricing&job=cm1&utm_source=x'
//   browseHref({ role: 'Product designer', city: 'Toronto' }) → '/browse/product-designer/toronto'
//
// PRODUCT §3.2: every CTA goes to /signup?from=<page-slug> and preserves
// `job`, `ref` and `utm_*`. Nothing personal travels in the URL: a value that
// looks like an email address, or is not a short token, is dropped.

/** Query keys a CTA carries over from the page URL. */
export const PRESERVED_PARAM_KEYS = ['job', 'ref'] as const;
const UTM_KEY = /^utm_[a-z]{1,20}$/;
/** A carried value: short, printable, no spaces and no email addresses. */
const SAFE_VALUE = /^[\p{L}\p{N}._:~-]{1,100}$/u;

export function isPreservedKey(key: string): boolean {
  return (PRESERVED_PARAM_KEYS as readonly string[]).includes(key) || UTM_KEY.test(key);
}

export type SearchLike = URLSearchParams | string | Record<string, string | string[] | undefined> | null | undefined;

function toParams(search: SearchLike): URLSearchParams {
  if (!search) return new URLSearchParams();
  if (search instanceof URLSearchParams) return search;
  if (typeof search === 'string') return new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(search)) {
    if (Array.isArray(v)) {
      if (v[0] !== undefined) out.append(k, v[0]);
    } else if (v !== undefined) out.append(k, v);
  }
  return out;
}

/** Page slug → a value safe for `from` (lowercase letters, digits, `-`, `_`, `:`). */
export function fromSlug(from: string): string {
  return from.toLowerCase().replace(/[^a-z0-9:_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'site';
}

/** `/signup?from=<slug>` plus the preserved `job`, `ref` and `utm_*` values of the current URL. */
export function buildSignupHref(from: string, search?: SearchLike): string {
  const params = new URLSearchParams();
  params.set('from', fromSlug(from));
  const source = toParams(search);
  const seen = new Set<string>();
  for (const [key, value] of source.entries()) {
    if (seen.has(key) || !isPreservedKey(key)) continue;
    const v = value.trim();
    if (!SAFE_VALUE.test(v) || v.includes('@')) continue;
    seen.add(key);
    params.set(key, v);
  }
  return `/signup?${params.toString()}`;
}

/** Lowercase ASCII/Unicode slug for a browse path segment. */
export function slugify(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export interface QuickSearchInput {
  role: string;
  city?: string;
  country?: string;
  remote?: boolean;
}

/**
 * The public browse page for a quick search (PRODUCT §3.2 browse routes):
 * `/browse/remote/{role}`, `/browse/{role}/{city}`, `/browse/{role}`; a
 * country travels as `?country=XX`. Null when the role is empty.
 */
export function browseHref(input: QuickSearchInput): string | null {
  const role = slugify(input.role);
  if (!role) return null;
  const country = (input.country ?? '').trim().toUpperCase();
  const qs = /^[A-Z]{2}$/.test(country) ? `?country=${country}` : '';
  if (input.remote) return `/browse/remote/${role}${qs}`;
  const city = slugify(input.city ?? '');
  return city ? `/browse/${role}/${city}${qs}` : `/browse/${role}${qs}`;
}

/** The browse page of a taxonomy role (`backend_engineer` → `/browse/backend-engineer`). */
export function popularListHref(taxonomyId: string): string {
  return `/browse/${taxonomyId.replace(/_/g, '-')}`;
}

/** Below this many open roles the hero drops its count clause (client twin of the server's HERO_COUNT_MIN). */
export const HERO_COUNT_MIN = 1000;

/** The hero count, or null when it is unknown or under the floor (the clause is dropped). */
export function heroCount(openRoles: { value: number } | null | undefined): number | null {
  const v = openRoles?.value;
  return typeof v === 'number' && Number.isFinite(v) && v >= HERO_COUNT_MIN ? v : null;
}
