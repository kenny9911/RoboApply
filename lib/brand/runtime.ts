// lib/brand/runtime.ts
//
// Env-dependent brand resolution for the web tier: proxy.ts and the server
// helpers in lib/server/brand.ts (ARCHITECTURE.md §1.3, §1.5). The twin of
// server/src/platform/brand/runtime.ts; the rules are identical so a page and
// the API it calls always agree on the brand.
//
//   resolveBrand(request):
//     host = first(x-forwarded-host) ?? host            # port stripped, lowercase
//     id   = BRAND_HOST_MAP[host] ?? brandIdFromHost(host)
//     if isDevOrPreviewHost(host):                      # never on production hosts
//         override = query __brand   (proxy only; it sets cookie ra_brand_override, 7 d, host-only)
//                 ?? cookie ra_brand_override
//                 ?? env BRAND_FORCE
//         id = override ?? id
//     id ?? lockedBrand ?? DEFAULT_BRAND
//
// The proxy never reads a client-sent `x-ra-brand`: it deletes the inbound
// header and stamps its own (anti-spoofing). Production hosts never honour
// the query, the cookie or BRAND_FORCE.
//
// Deployment scope (same env as Express): ALLOWED_BRANDS (comma list;
// `intl`/`cn` accepted) and BRAND_LOCK. With neither set a deployment serves
// both brands in every environment (D5, GOAPPLY_PARITY_PLAN.md §3.2); the two
// variables narrow it (ALLOWED_BRANDS=roboapply keeps GoApply closed, the
// mainland kit sets ALLOWED_BRANDS=goapply). A scope variable that is set but
// names no brand (a typo) serves the default brand only, never both.
//
// Pure functions over an explicit `env`, so tests pass a table instead of
// mutating process.env. Do NOT import this module from client components:
// the client gets its brand from <BrandProvider> (lib/brand/BrandProvider.tsx).

import {
  ALL_LOCALES,
  BRAND_IDS,
  DEFAULT_BRAND,
  brandIdFromHost,
  getBrand,
  isDevOrPreviewHost,
  normalizeHost,
  parseBrandId,
  type BrandId,
  type ProductBrand,
} from './registry.generated';

export type EnvSource = Record<string, string | undefined>;

/** Dev/preview override cookie (shared with Express, server/src/platform/brand/runtime.ts). */
export const BRAND_OVERRIDE_COOKIE = 'ra_brand_override';
/** Query parameter that sets (or clears) the override cookie on dev/preview hosts. */
export const BRAND_QUERY_PARAM = '__brand';
/** Request header the proxy stamps for server components (and Express accepts on dev hosts). */
export const BRAND_HEADER = 'x-ra-brand';
/** Request header carrying the request path for server layouts. */
export const PATHNAME_HEADER = 'x-pathname';
/** Seven days (ARCH §1.3). */
export const BRAND_OVERRIDE_MAX_AGE_SEC = 7 * 24 * 60 * 60;
/** `?__brand=` values that delete the override cookie. */
const CLEAR_VALUES = new Set(['', 'clear', 'reset', 'off', 'none', 'auto']);

export type WebBrandSource =
  | 'host_map'
  | 'host'
  | 'override_query'
  | 'override_cookie'
  | 'brand_force'
  | 'lock'
  | 'default';

export interface WebBrandInput {
  /** Host header. */
  host?: string | null;
  /** x-forwarded-host header (Next dev proxy, Vercel); wins over host. */
  forwardedHost?: string | null;
  /** `?__brand=` value; null when the parameter is absent. */
  queryOverride?: string | null;
  /** `ra_brand_override` cookie value. */
  cookieOverride?: string | null;
}

export interface WebBrandResolution {
  /** The brand to serve, or the refused brand when `allowed` is false. */
  brandId: BrandId;
  /** Normalized host the decision was made on. */
  host: string;
  source: WebBrandSource;
  /** False when this deployment does not serve the brand (ALLOWED_BRANDS / BRAND_LOCK). */
  allowed: boolean;
  /**
   * What the proxy must do with the override cookie on this response:
   * a brand id to set it, 'clear' to delete it, null to leave it alone.
   * Only ever non-null on a dev/preview host.
   */
  overrideCookie: BrandId | 'clear' | null;
}

/** `BRAND_HOST_MAP=staging.example.com=goapply,beta.example.com=roboapply`. */
export function parseBrandHostMap(raw: string | undefined): Map<string, BrandId> {
  const map = new Map<string, BrandId>();
  if (!raw) return map;
  for (const pair of raw.split(',')) {
    const [h, b] = pair.split('=');
    const host = normalizeHost(h);
    const id = parseBrandId(b);
    if (host && id) map.set(host, id);
  }
  return map;
}

/** A deployment-scope value that names no brand (a typo such as `roboaply`). */
export interface AllowedBrandsProblem {
  /** Each token that is not a brand id or alias, with the variable it was read from. */
  invalid: { variable: 'BRAND_LOCK' | 'ALLOWED_BRANDS'; token: string }[];
  /** True when no valid id was left, so the deployment closed to the default brand alone. */
  failedClosed: boolean;
  /** The brands the deployment serves as a result. */
  serves: BrandId[];
}

/**
 * The deployment scope and what was wrong with it. One reading for
 * `allowedBrands` and `allowedBrandsProblem`, so they cannot disagree.
 *
 * A scope variable that is SET but names no brand is a typo, not "unset": the
 * deployment then serves the default brand only (fail closed). Without this
 * rule `ALLOWED_BRANDS=roboaply` would open GoApply, its crons and its queue
 * drains, because unset means both brands. On the mainland kit the same typo
 * leaves RoboApply as the only brand, which the residency check refuses at
 * boot (`intl_brand_on_mainland`): loud, not silent.
 */
function readScope(env: EnvSource): AllowedBrandsProblem {
  const invalid: AllowedBrandsProblem['invalid'] = [];

  const lockRaw = (env.BRAND_LOCK ?? '').trim();
  if (lockRaw) {
    const lock = parseBrandId(lockRaw);
    if (lock) return { invalid, failedClosed: false, serves: [lock] };
    invalid.push({ variable: 'BRAND_LOCK', token: lockRaw });
  }

  const listRaw = (env.ALLOWED_BRANDS ?? '').trim();
  const ids: BrandId[] = [];
  for (const part of listRaw.split(',')) {
    const token = part.trim();
    if (!token) continue;
    const id = parseBrandId(token);
    if (!id) invalid.push({ variable: 'ALLOWED_BRANDS', token });
    else if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length > 0) return { invalid, failedClosed: false, serves: ids };
  // Set, yet nothing but separators (`,`): still not a brand.
  if (listRaw && !invalid.some((entry) => entry.variable === 'ALLOWED_BRANDS')) {
    invalid.push({ variable: 'ALLOWED_BRANDS', token: listRaw });
  }
  if (invalid.length > 0) return { invalid, failedClosed: true, serves: [DEFAULT_BRAND] };
  return { invalid, failedClosed: false, serves: [...BRAND_IDS] };
}

/**
 * Brands this deployment serves: BRAND_LOCK, else ALLOWED_BRANDS, else both
 * brands (in every environment, production included). A scope variable that is
 * set but names no brand closes the deployment to the default brand
 * (`allowedBrandsProblem` says why).
 */
export function allowedBrands(env: EnvSource = process.env): BrandId[] {
  return readScope(env).serves;
}

/**
 * What is wrong with BRAND_LOCK / ALLOWED_BRANDS, or null when every token
 * names a brand. Startup logs it: a partly wrong list (`roboapply,gopply`) is
 * narrowed to its valid ids, and a list with no valid id closes the deployment
 * to the default brand. Tokens are brand names, never secrets.
 */
export function allowedBrandsProblem(env: EnvSource = process.env): AllowedBrandsProblem | null {
  const scope = readScope(env);
  return scope.invalid.length > 0 ? scope : null;
}

/** BRAND_LOCK, or the single entry of ALLOWED_BRANDS; null when the deployment serves several brands. */
export function brandLock(env: EnvSource = process.env): BrandId | null {
  const lock = parseBrandId(env.BRAND_LOCK);
  if (lock) return lock;
  const allowed = allowedBrands(env);
  return allowed.length === 1 ? allowed[0]! : null;
}

export function isBrandAllowed(id: BrandId, env: EnvSource = process.env): boolean {
  return allowedBrands(env).includes(id);
}

/**
 * Interpret a `?__brand=` value: a brand id (or the `intl`/`cn` alias) sets
 * the override, a clear word (or an empty value) deletes it, anything else
 * is ignored (null).
 */
export function parseBrandQuery(value: string | null | undefined): BrandId | 'clear' | null {
  if (value === null || value === undefined) return null;
  const v = value.trim().toLowerCase();
  if (CLEAR_VALUES.has(v)) return 'clear';
  return parseBrandId(v);
}

export function resolveWebBrand(input: WebBrandInput, env: EnvSource = process.env): WebBrandResolution {
  const host = normalizeHost(input.forwardedHost || input.host);
  const finish = (
    brandId: BrandId,
    source: WebBrandSource,
    overrideCookie: WebBrandResolution['overrideCookie'] = null,
  ): WebBrandResolution => ({ brandId, host, source, allowed: isBrandAllowed(brandId, env), overrideCookie });

  const mapped = parseBrandHostMap(env.BRAND_HOST_MAP).get(host);
  const fromHost: BrandId | null = mapped ?? brandIdFromHost(host);
  const hostSource: WebBrandSource = mapped ? 'host_map' : 'host';

  if (isDevOrPreviewHost(host)) {
    const query = parseBrandQuery(input.queryOverride);
    if (query && query !== 'clear') return finish(query, 'override_query', query);
    const cookieWrite = query === 'clear' ? 'clear' : null;
    // A clear request ignores the cookie it is about to delete.
    const fromCookie = query === 'clear' ? null : parseBrandId(input.cookieOverride);
    if (fromCookie) return finish(fromCookie, 'override_cookie');
    const fromEnv = parseBrandId(env.BRAND_FORCE);
    if (fromEnv) return finish(fromEnv, 'brand_force', cookieWrite);
    if (fromHost) return finish(fromHost, hostSource, cookieWrite);
    return finishDefault(finish, env, cookieWrite);
  }

  if (fromHost) return finish(fromHost, hostSource);
  return finishDefault(finish, env, null);
}

function finishDefault(
  finish: (id: BrandId, source: WebBrandSource, cookie?: WebBrandResolution['overrideCookie']) => WebBrandResolution,
  env: EnvSource,
  cookieWrite: WebBrandResolution['overrideCookie'],
): WebBrandResolution {
  const lock = brandLock(env);
  if (lock) return finish(lock, 'lock', cookieWrite);
  const allowed = allowedBrands(env);
  return finish(allowed.includes(DEFAULT_BRAND) ? DEFAULT_BRAND : allowed[0]!, 'default', cookieWrite);
}

/** Convenience: the brand object for a resolution input. */
export function resolveWebBrandObject(input: WebBrandInput, env: EnvSource = process.env): ProductBrand {
  return getBrand(resolveWebBrand(input, env).brandId);
}

/**
 * Locale clamp (ARCH §1.5 step 3). When the path's first segment is a locale
 * the brand does not serve, return the same path under the brand's default
 * locale (`/zh-TW/x` on GoApply → `/zh/x`); otherwise null. Only the first
 * segment is inspected and only known locale codes count, so ordinary routes
 * (`/jobs`, `/login`) are never touched. This is a locale redirect, not a
 * destination router (ruling C29).
 */
export function clampLocalePath(pathname: string, brand: ProductBrand): string | null {
  const match = /^\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!match) return null;
  const segment = match[1]!;
  if (!(ALL_LOCALES as readonly string[]).includes(segment)) return null;
  if ((brand.locales as readonly string[]).includes(segment)) return null;
  return `/${brand.defaultLocale}${match[2] ?? ''}`;
}
