// server/src/platform/brand/runtime.ts
//
// Env-dependent brand resolution for Express (ARCHITECTURE.md §1.2–§1.3,
// TASK_PLAN.md R-01/R-03). The registry stays pure; everything that reads
// process.env lives here. Every function takes an optional `env` so tests can
// pass a fixed table instead of mutating process.env.
//
// resolveBrand(request):
//   host = first(x-forwarded-host) ?? host                 # port stripped, lowercase
//   id   = BRAND_HOST_MAP[host] ?? brandIdFromHost(host)
//   if isDevOrPreviewHost(host):                           # never on production hosts
//       override = cookie ra_brand_override
//               ?? header x-ra-brand
//               ?? env BRAND_FORCE
//       id = override ?? id
//   else if X-RA-Internal == INTERNAL_API_SECRET:          # server-to-server only
//       id = header x-ra-brand ?? id
//   id ?? lockedBrand ?? DEFAULT_BRAND
//
// Deployment scope: ALLOWED_BRANDS (comma list; `intl`/`cn` accepted as
// aliases) and BRAND_LOCK (a single brand). A request that resolves to a
// brand this deployment does not serve is refused by the middleware. With
// one allowed brand, unknown hosts (crons, the *.vercel.app host) resolve to
// it. Unset ALLOWED_BRANDS = both brands outside production, RoboApply only
// in production, so goapply.top cannot go live by accident.

import { timingSafeEqual } from 'node:crypto';
import {
  BRAND_IDS,
  DEFAULT_BRAND,
  brandIdFromHost,
  getBrand,
  isDevOrPreviewHost,
  normalizeHost,
  parseBrandId,
  type BrandId,
  type ProductBrand,
} from './registry.js';
import { brandEnv, type EnvSource } from './brandEnv.js';

export const BRAND_OVERRIDE_COOKIE = 'ra_brand_override';
export const BRAND_HEADER = 'x-ra-brand';
export const INTERNAL_HEADER = 'x-ra-internal';

export interface BrandRequestLike {
  headers: Record<string, string | string[] | undefined>;
  cookies?: Record<string, string | undefined>;
}

export interface BrandResolution {
  /** The brand to serve, or the refused brand when `allowed` is false. */
  brandId: BrandId;
  /** Normalized host the decision was made on. */
  host: string;
  /** How the id was found. */
  source: 'host_map' | 'host' | 'override_cookie' | 'override_header' | 'brand_force' | 'internal_header' | 'lock' | 'default';
  /** False when this deployment does not serve the brand (ALLOWED_BRANDS / BRAND_LOCK). */
  allowed: boolean;
}

function headerValue(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function isProduction(env: EnvSource): boolean {
  return env.NODE_ENV === 'production';
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

/** BRAND_LOCK, or the single entry of ALLOWED_BRANDS; null when the deployment serves several brands. */
export function brandLock(env: EnvSource = process.env): BrandId | null {
  const lock = parseBrandId(env.BRAND_LOCK);
  if (lock) return lock;
  const allowed = allowedBrands(env);
  return allowed.length === 1 ? allowed[0]! : null;
}

/** Brands this deployment serves. */
export function allowedBrands(env: EnvSource = process.env): BrandId[] {
  const lock = parseBrandId(env.BRAND_LOCK);
  if (lock) return [lock];
  const raw = env.ALLOWED_BRANDS;
  if (raw && raw.trim()) {
    const ids = raw
      .split(',')
      .map((s) => parseBrandId(s))
      .filter((id): id is BrandId => id !== null);
    const unique = [...new Set(ids)];
    if (unique.length > 0) return unique;
  }
  return isProduction(env) ? [DEFAULT_BRAND] : [...BRAND_IDS];
}

export function isBrandAllowed(id: BrandId, env: EnvSource = process.env): boolean {
  return allowedBrands(env).includes(id);
}

function internalSecretMatches(req: BrandRequestLike, env: EnvSource): boolean {
  const secret = env.INTERNAL_API_SECRET;
  const sent = headerValue(req.headers[INTERNAL_HEADER]);
  if (!secret || !sent) return false;
  const a = Buffer.from(secret);
  const b = Buffer.from(sent);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The host the client asked for: first x-forwarded-host (Next dev proxy, Vercel), else Host. */
export function requestHost(req: BrandRequestLike): string {
  return normalizeHost(headerValue(req.headers['x-forwarded-host']) ?? headerValue(req.headers.host));
}

export function resolveBrandFromRequest(req: BrandRequestLike, env: EnvSource = process.env): BrandResolution {
  const host = requestHost(req);
  const lock = brandLock(env);
  const finish = (brandId: BrandId, source: BrandResolution['source']): BrandResolution => ({
    brandId,
    host,
    source,
    allowed: isBrandAllowed(brandId, env),
  });

  const mapped = parseBrandHostMap(env.BRAND_HOST_MAP).get(host);
  let id: BrandId | null = mapped ?? brandIdFromHost(host);
  let source: BrandResolution['source'] = mapped ? 'host_map' : 'host';

  if (isDevOrPreviewHost(host)) {
    // On a production NODE_ENV, BRAND_FORCE is honoured only on preview hosts
    // (this branch); production hosts never reach it.
    const fromCookie = parseBrandId(req.cookies?.[BRAND_OVERRIDE_COOKIE]);
    const fromHeader = parseBrandId(headerValue(req.headers[BRAND_HEADER]));
    const fromEnv = parseBrandId(env.BRAND_FORCE);
    if (fromCookie) return finish(fromCookie, 'override_cookie');
    if (fromHeader) return finish(fromHeader, 'override_header');
    if (fromEnv) return finish(fromEnv, 'brand_force');
  } else if (internalSecretMatches(req, env)) {
    const fromHeader = parseBrandId(headerValue(req.headers[BRAND_HEADER]));
    if (fromHeader) return finish(fromHeader, 'internal_header');
  }

  if (id) return finish(id, source);
  if (lock) return finish(lock, 'lock');
  const allowed = allowedBrands(env);
  id = allowed.includes(DEFAULT_BRAND) ? DEFAULT_BRAND : allowed[0]!;
  return finish(id, 'default');
}

export function resolveBrand(req: BrandRequestLike, env: EnvSource = process.env): ProductBrand {
  return getBrand(resolveBrandFromRequest(req, env).brandId);
}

function stripLeadingDot(domain: string): string {
  return domain.startsWith('.') ? domain.slice(1) : domain;
}

/**
 * Cookie domain for a brand on a host (R-03: `COOKIE_DOMAIN` for RoboApply,
 * `CN_COOKIE_DOMAIN` for GoApply, no fallback across brands).
 *  - Unset → undefined (host-only cookie; today's behaviour when unset).
 *  - Set and the host ends with it → the configured domain.
 *  - Set but the host does not match (previews, localhost) → undefined, so
 *    preview logins get a host-only cookie the browser accepts.
 *  - No host known (outside a request) → the configured domain (legacy).
 */
export function cookieDomainFor(
  brand: BrandId | ProductBrand,
  host: string | null | undefined,
  env: EnvSource = process.env,
): string | undefined {
  const configured = brandEnv(brand, 'COOKIE_DOMAIN', env);
  if (!configured) return undefined;
  const h = normalizeHost(host);
  if (!h) return configured;
  const bare = stripLeadingDot(configured.toLowerCase());
  return h === bare || h.endsWith(`.${bare}`) ? configured : undefined;
}

/** CORS allowlist from the registry (ARCH §1.6). */
export function corsOrigins(env: EnvSource = process.env): (string | RegExp)[] {
  const fromEnv = (env.FRONTEND_URLS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (!isProduction(env)) {
    const devPorts = ['3611', '3621', '3000'];
    const origins: string[] = [];
    for (const port of devPorts) {
      origins.push(`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://goapply.localhost:${port}`);
    }
    return [...origins, ...fromEnv];
  }
  const origins: (string | RegExp)[] = [];
  for (const id of allowedBrands(env)) {
    for (const host of getBrand(id).hosts) origins.push(`https://${host}`);
  }
  if (env.NEXT_PUBLIC_ROBOAPPLY_URL) origins.push(env.NEXT_PUBLIC_ROBOAPPLY_URL);
  origins.push(...fromEnv, /^https:\/\/[a-z0-9-]+\.vercel\.app$/i);
  return [...new Set(origins)];
}
