// server/src/platform/brand/runtime.ts
//
// Env-dependent brand resolution for Express (ARCHITECTURE.md §1.2–§1.3,
// TASK_PLAN.md R-01; deployment scope per GOAPPLY_PARITY_PLAN.md §3.2). The registry stays pure; everything that reads
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
// it. With neither variable set a deployment serves BOTH brands in every
// environment (D5): goapply.top is served as soon as its DNS points here.
// ALLOWED_BRANDS and BRAND_LOCK narrow a deployment: ALLOWED_BRANDS=roboapply
// keeps GoApply closed, and the mainland kit sets ALLOWED_BRANDS=goapply.
// A scope variable that is set but names no brand (a typo) is not "unset": the
// deployment serves the default brand only, and `allowedBrandsProblem` names
// the bad tokens for the startup log.

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
 * Cookie domain for a brand on a host (`COOKIE_DOMAIN` for RoboApply,
 * `CN_COOKIE_DOMAIN` for GoApply; a brand-own name, so it never falls back
 * across brands).
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

/**
 * No preview pattern is built in. Any host under `vercel.app` whose shape is
 * `<project>-<anything>-<team>.vercel.app` can be claimed by another Vercel
 * account (a project name is free text), so a default glob would hand a
 * credentialed CORS grant to a host this project does not control. The
 * deployment's own hosts are allowed exactly through VERCEL_URL /
 * VERCEL_BRANCH_URL, and a preview page calls its own `/api/*` same-origin.
 */
export const DEFAULT_CORS_PREVIEW_HOSTS = '';

const PREVIEW_GLOB = /^[a-z0-9*-]+(\.[a-z0-9-]+)+$/;

/**
 * One origin pattern per host glob in `CORS_PREVIEW_HOSTS` (comma list). This
 * is an explicit opt-in: unset, blank, `none` or `off` = no preview origins.
 * `*` stands for one run of letters, digits and hyphens inside a label (never
 * a dot). A glob is refused when its first label has no literal text left of
 * the registrable suffix (`*.vercel.app`, `**.vercel.app`): that would re-open
 * every Vercel customer's deployment as a credentialed origin. Whoever sets a
 * pattern under a shared suffix accepts that another account can register a
 * host that matches it.
 */
export function corsPreviewPatterns(env: EnvSource = process.env): RegExp[] {
  const raw = env.CORS_PREVIEW_HOSTS === undefined || env.CORS_PREVIEW_HOSTS.trim() === '' ? DEFAULT_CORS_PREVIEW_HOSTS : env.CORS_PREVIEW_HOSTS;
  const lowered = raw.trim().toLowerCase();
  if (lowered === '' || lowered === 'none' || lowered === 'off') return [];
  const patterns: RegExp[] = [];
  for (const part of lowered.split(',')) {
    const glob = part.trim();
    if (!glob || !PREVIEW_GLOB.test(glob)) continue;
    const firstLabel = glob.split('.')[0]!;
    // At least 3 literal characters in the project label, so `*`, `a*` and `*-*` are refused.
    if (firstLabel.replace(/[*-]/g, '').length < 3) continue;
    const body = glob
      .split('*')
      .map((piece) => piece.replace(/[.]/g, '\\.'))
      .join('[a-z0-9-]+');
    patterns.push(new RegExp(`^https://${body}$`, 'i'));
  }
  return patterns;
}

/** `https://<host>` for a Vercel system variable that holds a bare host (VERCEL_URL …). */
function vercelOrigin(value: string | undefined): string | null {
  const host = normalizeHost(value);
  return host && /^[a-z0-9.-]+$/.test(host) ? `https://${host}` : null;
}

/**
 * CORS allowlist from the registry (ARCH §1.6). In production: the registry
 * hosts of the brands this deployment serves, NEXT_PUBLIC_ROBOAPPLY_URL,
 * FRONTEND_URLS, this deployment's own Vercel hosts (exact) and, only when
 * CORS_PREVIEW_HOSTS is set, the preview patterns it names
 * (`corsPreviewPatterns`). Any other `*.vercel.app` origin is refused, so a
 * credentialed cross-origin POST (e.g. /auth/wechat/start) from a page anyone
 * can deploy gets no CORS grant.
 */
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
  origins.push(...fromEnv);
  for (const own of [env.VERCEL_URL, env.VERCEL_BRANCH_URL, env.VERCEL_PROJECT_PRODUCTION_URL]) {
    const origin = vercelOrigin(own);
    if (origin) origins.push(origin);
  }
  const unique: (string | RegExp)[] = [...new Set(origins)];
  return [...unique, ...corsPreviewPatterns(env)];
}

/** Whether an Origin header value gets a credentialed CORS grant (the same rule the `cors` middleware applies). */
export function isCorsOriginAllowed(origin: string, env: EnvSource = process.env): boolean {
  return corsOrigins(env).some((o) => (typeof o === 'string' ? o === origin : o.test(origin)));
}
