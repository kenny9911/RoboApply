// backend/src/roboapply/v2/lib/raFantasticJobs.ts
//
// Fantastic Jobs client: Active Jobs DB → sourceBoard 'activejobs'. Two kinds
// of call share everything below (transport, timeout, circuit breaker, call
// gate, quota listener):
//   - `searchFantasticJobs`  one title × location search, 20 rows (a person's
//     own search, and the ingest search adapter);
//   - `feedRequest`          one page of the licensed feed's new-jobs route or
//     one answer of its expired route (features/jobs/ingest/adapters/
//     fantasticFeed.ts; MARKET_STRATEGY M-2, §1.2 tier 1, JI-7).
//
// The provider's sibling LinkedIn Job Search API shared this client until the
// M3 gate of the market wave. It is removed: LinkedIn is not a source
// (MARKET_STRATEGY M-4, §1.6), so no code here can build a request to it.
//
// Transport (FANTASTIC_TRANSPORT, one for the whole client, so one plan is
// spent and one quota reading describes it):
//   rapidapi (default)  https://active-jobs-db.p.rapidapi.com, headers
//                       x-rapidapi-key (RAPID_API_KEY) and x-rapidapi-host.
//                       Routes /active-ats (verified live 2026-09-12) and
//                       /expired-ats (JOB_SOURCES_INTL §6.2; NOT verified on
//                       the marketplace listing: the free plan was used up).
//   direct              https://data.fantastic.jobs, header
//                       `Authorization: Bearer <FANTASTIC_API_KEY>`, routes
//                       /v1/active-ats and /v1/expired-ats. Read on 2026-10-12
//                       from the vendor's documentation:
//                       developer.fantastic.jobs/documentation/authentication
//                       (last modified 2026-10-09), …/endpoints/new-jobs,
//                       …/endpoints/expired-jobs, …/credit-usage and the
//                       OpenAPI document data.fantastic.jobs/openapi
//                       ("Fantastic.jobs API (v1)").
// FANTASTIC_API_KEY_HEADER overrides the header NAME of the direct key (the
// raw key is then the value); FANTASTIC_FEED_PATH / FANTASTIC_EXPIRED_PATH
// override the two routes on the chosen host (the marketplace listing has
// renamed its routes before: see "Sept 2026 marketplace migration" below).
//
// Mirrors the raRapidApiJobs.ts (JSearch) discipline exactly:
//   - self-contained V2-local client (the boundary script forbids importing
//     recruiter `services/*`);
//   - the key read per call, never cached, never logged, never part of a
//     result or an error text;
//   - hard "NEVER throws to callers" contract — every failure path returns
//     `null` (search) or `{ ok: false, error }` (feed) + a logger.warn;
//   - per-provider cost control: in-process LRU cache (6h, search only),
//     circuit breaker (403/401/monthly-429 → 1h cooldown; burst-429 → one
//     jittered retry; a 401/403 on the feed's EXPIRED route opens nothing and
//     reports nothing: that route may be outside the plan while the key is
//     good for the others), global + per-provider kill switch, and the call gate
//     (setCallGate) asked before every upstream call and by
//     isFantasticJobsEnabled(). The inventory pipeline registers the gate
//     (features/jobs/ingest/quota.ts): ONE budget per provider, read from the
//     plan's own quota headers and counted in RAProviderUsage; this client
//     keeps no call counter of its own (MARKET_STRATEGY §1.2, JI-1);
//   - the quota listener (setQuotaListener) is told what every upstream
//     response said about the plan: requests and jobs limit / remaining, the
//     reset time and, on a 429, the plan's name. Never the key.
//
// Response shape (verified against Fantastic Jobs docs + prospectio-api-mcp):
// the body is a BARE JSON ARRAY (job objects on the new-jobs route, internal
// job ids on the expired route; NO envelope). A 403/429 comes back as
// `{message:"..."}` (the direct API: an RFC 7807 problem object) with a
// non-200 status, so we type-guard for an array before mapping.
//
// Current marketplace contract verified 2026-09-12: GET /active-ats and
// /active-jb, with time_frame/title/location/description_format. Raw response
// fields now use salary, locations, and ai_salary_min_value/unit_text; the v1
// API also renamed date_validthrough → date_valid_through, returns `id` as an
// integer and dropped remote_derived ("Field changes old to new API", read
// 2026-10-12). Legacy field aliases remain supported for cached and older
// records.
//
// Title search (INTL note §6.2): the `title` parameter reads like a Google
// query, so a role is asked as quoted phrases joined by OR ('"product
// manager" OR "product owner"'), never as loose tokens: on a per-job price
// loose tokens buy loosely related postings.

import { logger } from '../../../services/LoggerService.js';
import {
  quotaObservationFrom,
  requestsRemainingFrom,
  settleQuotaListener,
  type ExternalJobNormalized,
  type ExternalSearchParams,
  type ExternalSourceBoard,
  type JobSearchProvider,
  type ProviderCallGate,
  type ProviderCallPurpose,
  type ProviderQuotaListener,
  type ProviderSearchOptions,
} from './raExternalJobTypes.js';

const REQUEST_TIMEOUT_MS = 25_000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;
const BREAKER_COOLDOWN_MS = 60 * 60 * 1000;
const RESULT_LIMIT = 20; // jobs per billed call (Fantastic Jobs bills per row returned)

// ─── Provider config and transport ─────────────────────────────────────────

/** Rows one search call asks for (the plan bills per row returned). */
export const FANTASTIC_SEARCH_LIMIT = RESULT_LIMIT;

interface FantasticConfig {
  /** sourceBoard + externalId prefix. */
  readonly board: Extract<ExternalSourceBoard, 'activejobs'>;
  /** Per-provider kill-switch env var name. */
  readonly disableEnv: string;
}

const ACTIVE_JOBS_CONFIG: FantasticConfig = {
  board: 'activejobs',
  disableEnv: 'RA_ONBOARDING_ACTIVEJOBS_DISABLED',
};

type Env = Readonly<Record<string, string | undefined>>;

/** How the client reaches Active Jobs DB (see the header). */
export type FantasticTransport = 'rapidapi' | 'direct';
/** The two routes of the licensed feed; `active` is also the search route. */
export type FantasticRoute = 'active' | 'expired';

const RAPIDAPI_HOST = 'active-jobs-db.p.rapidapi.com';
const DIRECT_HOST = 'data.fantastic.jobs';
/** The direct API's documented key header (`Authorization: Bearer <key>`; vendor "Authentication" page, read 2026-10-12). */
const DIRECT_KEY_HEADER = 'Authorization';
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
/** A plain path: segments of letters, digits, '_', '.', '-' (no empty segment, no query, no host). */
const ROUTE_PATH = /^(?:\/[A-Za-z0-9_.-]{1,40}){1,6}$/;

const DEFAULT_PATHS: Readonly<Record<FantasticTransport, Readonly<Record<FantasticRoute, string>>>> = {
  rapidapi: { active: '/active-ats', expired: '/expired-ats' },
  direct: { active: '/v1/active-ats', expired: '/v1/expired-ats' },
};
const PATH_ENV: Readonly<Record<FantasticRoute, string>> = { active: 'FANTASTIC_FEED_PATH', expired: 'FANTASTIC_EXPIRED_PATH' };

/** FANTASTIC_TRANSPORT: 'direct' for a Fantastic.jobs key, anything else the RapidAPI marketplace. */
export function fantasticTransport(env: Env = process.env): FantasticTransport {
  return env.FANTASTIC_TRANSPORT?.trim().toLowerCase() === 'direct' ? 'direct' : 'rapidapi';
}

/** Is the key of the chosen transport set? (Presence only: the value is never read here.) */
export function fantasticKeyPresent(env: Env = process.env): boolean {
  return !!(fantasticTransport(env) === 'direct' ? env.FANTASTIC_API_KEY : env.RAPID_API_KEY)?.trim();
}

/** The path of a route on the chosen transport's host: the operator's override when it is a plain path, else the default. */
export function fantasticRoutePath(route: FantasticRoute, env: Env = process.env): string {
  const override = env[PATH_ENV[route]]?.trim();
  return override && ROUTE_PATH.test(override) ? override : DEFAULT_PATHS[fantasticTransport(env)][route];
}

interface ResolvedTransport {
  kind: FantasticTransport;
  host: string;
  /** Request headers, the key among them: never logged, never returned to a caller. */
  headers: Record<string, string>;
}

/** Host and headers of the chosen transport; null without its key (read per call, never cached). */
function resolveTransport(env: Env = process.env): ResolvedTransport | null {
  if (fantasticTransport(env) === 'direct') {
    const key = env.FANTASTIC_API_KEY?.trim();
    if (!key) return null;
    const override = env.FANTASTIC_API_KEY_HEADER?.trim();
    const name = override && HEADER_NAME.test(override) ? override : DIRECT_KEY_HEADER;
    return { kind: 'direct', host: DIRECT_HOST, headers: { [name]: name.toLowerCase() === 'authorization' ? `Bearer ${key}` : key } };
  }
  const key = env.RAPID_API_KEY?.trim();
  if (!key) return null;
  return { kind: 'rapidapi', host: RAPIDAPI_HOST, headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': RAPIDAPI_HOST } };
}

/** Is a kill switch of this provider on (the shared one or its own)? */
function killed(cfg: FantasticConfig, env: Env = process.env): boolean {
  return env.RA_ONBOARDING_EXTERNAL_JOBS_DISABLED === 'true' || env[cfg.disableEnv] === 'true';
}

/**
 * Freshness window suffix. Default '7d' (a title+location query in a 24h window
 * is often too sparse for a good recommendation pool; onboarding runs are
 * cached 6h and capped at 2 external rounds/session, so the heavier window is
 * affordable). Set RA_ONBOARDING_FANTASTIC_WINDOW=24h if your plan does not
 * expose the 7-day endpoint (it degrades to null silently otherwise).
 */
function windowSuffix(): '24h' | '7d' {
  return process.env.RA_ONBOARDING_FANTASTIC_WINDOW === '24h' ? '24h' : '7d';
}

/** The one frame every search call asks, as an ingest `datePosted` value ('7d' → 'week', '24h' → 'today'). */
export function fantasticSearchDateWindow(): 'week' | 'today' {
  return windowSuffix() === '24h' ? 'today' : 'week';
}

// ─── Postgres-safety helpers (forked, raRapidApiJobs.ts precedent) ─────────
// PostgreSQL rejects NUL (0x00) in TEXT/jsonb; scraped job text can carry NUL +
// other C0 control chars. Tab/newline/CR preserved.

function stripControl(input: string): string {
  let out = '';
  for (let k = 0; k < input.length; k += 1) {
    const c = input.charCodeAt(k);
    if (c === 9 || c === 10 || c === 13 || c > 31) out += input[k];
  }
  return out;
}

function deepClean<T>(value: T): T {
  if (typeof value === 'string') return stripControl(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => deepClean(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = deepClean((value as Record<string, unknown>)[key]);
    }
    return out as unknown as T;
  }
  return value;
}

// ─── Normalization ─────────────────────────────────────────────────────────

const EMPLOYMENT_MAP: Record<string, string> = {
  FULL_TIME: 'full_time',
  PART_TIME: 'part_time',
  CONTRACTOR: 'contract',
  CONTRACT: 'contract',
  TEMPORARY: 'contract',
  INTERN: 'internship',
  INTERNSHIP: 'internship',
};

const PERIOD_MAP: Record<string, string | null> = {
  YEAR: 'year',
  YEARLY: 'year',
  MONTH: 'month',
  MONTHLY: 'month',
  HOUR: 'hour',
  HOURLY: 'hour',
  WEEK: 'week',
  WEEKLY: 'week',
  DAY: 'day',
  DAILY: 'day',
};

/** ISO-3166 alpha-2 → full country name for Fantastic Jobs `location_filter`
 *  (the API matches derived-location TEXT; ISO codes silently return nothing). */
const COUNTRY_NAME: Record<string, string> = {
  us: 'United States', gb: 'United Kingdom', uk: 'United Kingdom', ca: 'Canada',
  au: 'Australia', nz: 'New Zealand', ie: 'Ireland', in: 'India', sg: 'Singapore',
  tw: 'Taiwan', hk: 'Hong Kong', jp: 'Japan', cn: 'China', kr: 'South Korea',
  de: 'Germany', fr: 'France', es: 'Spain', pt: 'Portugal', it: 'Italy',
  nl: 'Netherlands', be: 'Belgium', ch: 'Switzerland', se: 'Sweden', no: 'Norway',
  dk: 'Denmark', fi: 'Finland', pl: 'Poland', br: 'Brazil', mx: 'Mexico',
  ar: 'Argentina', ae: 'United Arab Emirates', za: 'South Africa', il: 'Israel',
};

function countryName(code: string | null | undefined): string | null {
  if (!code) return null;
  return COUNTRY_NAME[code.trim().toLowerCase()] ?? null;
}

/**
 * The `location_filter` country name Fantastic Jobs matches for an ISO code,
 * or null when the client cannot scope a search to that country (the API
 * would then search everywhere). WP-16b's planner only plans Fantastic Jobs
 * queries for countries this returns a name for.
 */
export function fantasticCountryName(code: string | null | undefined): string | null {
  return countryName(code);
}

function firstString(arr: unknown): string | null {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const v = arr[0];
  return typeof v === 'string' && v.trim() ? v : null;
}

function toFiniteNumber(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Coerce a Fantastic Jobs timestamp to an ISO UTC string. Active Jobs DB often
 *  omits the zone ("2025-01-15T00:00:00") → treat as UTC (append 'Z'). */
function toIsoUtc(raw: unknown, fetchedAt: Date): string {
  if (typeof raw === 'string' && raw.trim()) {
    const s = raw.trim();
    const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s);
    const iso = hasZone ? s : `${s}Z`;
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return fetchedAt.toISOString();
}

function prettifySource(source: unknown): string | null {
  if (typeof source !== 'string' || !source.trim()) return null;
  const s = source.trim().toLowerCase();
  if (s === 'linkedin') return 'LinkedIn';
  // greenhouse → Greenhouse, workday → Workday, "smart recruiters" → "Smart Recruiters"
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function hostOf(domain: unknown): string | null {
  if (typeof domain !== 'string' || !domain.trim()) return null;
  return domain.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '') || null;
}

/**
 * Normalize one raw Fantastic Jobs job object. Returns null for rows missing the
 * identity fields (id / title / organization) — normalize-and-drop. Shared by
 * both APIs; `board` picks the externalId prefix + sourceBoard.
 */
export function normalizeFantasticJob(
  j: any,
  board: FantasticConfig['board'],
  fetchedAt: Date,
): ExternalJobNormalized | null {
  if (!j || typeof j !== 'object') return null;
  const id = j.id;
  if (id == null || String(id).trim() === '') return null;
  if (typeof j.title !== 'string' || !j.title.trim()) return null;
  if (typeof j.organization !== 'string' || !j.organization.trim()) return null;

  const sr = j.salary ?? j.salary_raw ?? {};
  const bareVal = typeof sr.value === 'number' ? sr.value : undefined;
  const unit = String(sr?.value?.unitText ?? sr?.unitText ?? j.ai_salary_unit_text ?? j.ai_salary_unittext ?? '').toUpperCase();
  const empRaw = String(
    firstString(j.employment_type) ?? firstString(j.ai_employment_type) ?? '',
  )
    .toUpperCase()
    .replace(/[^A-Z_]/g, '');
  const workArrangement = String(
    Array.isArray(j.ai_work_arrangement) ? j.ai_work_arrangement[0] : (j.ai_work_arrangement ?? ''),
  );

  const isRemote =
    j.remote_derived === true ||
    j.location_type === 'TELECOMMUTE' ||
    workArrangement.startsWith('Remote');

  const salaryMin = toFiniteNumber(sr?.value?.minValue ?? sr?.minValue ?? bareVal ?? j.ai_salary_min_value ?? j.ai_salary_minvalue ?? j.ai_salary_value);
  const salaryMax = toFiniteNumber(sr?.value?.maxValue ?? sr?.maxValue ?? bareVal ?? j.ai_salary_max_value ?? j.ai_salary_maxvalue ?? j.ai_salary_value);
  const hasSalary = salaryMin != null || salaryMax != null;

  // addressCountry is usually an ISO alpha-2 string ("US") but schema.org also
  // allows a Country object ({ "@type":"Country", name:"United States" }). A raw
  // truthy object would short-circuit the ?? chain and then fail the string
  // guard below → null, discarding the countries_derived fallback. Narrow first.
  const rawCountry = (j.locations ?? j.locations_raw)?.[0]?.address?.addressCountry;
  const country =
    (typeof rawCountry === 'string' && rawCountry.trim() ? rawCountry : null) ??
    (rawCountry && typeof rawCountry === 'object' && typeof rawCountry.name === 'string'
      ? rawCountry.name
      : null) ??
    firstString(j.countries_derived) ??
    null;

  const applyUrl = typeof j.url === 'string' && j.url.trim() ? j.url : null;
  const descriptionRaw =
    (typeof j.description_text === 'string' && j.description_text) ||
    (typeof j.description_html === 'string' && j.description_html) ||
    '';

  return deepClean({
    externalId: `${board}:${String(id)}`,
    sourceBoard: board,
    title: j.title,
    company: j.organization,
    companyLogoUrl: typeof j.organization_logo === 'string' ? j.organization_logo : null,
    location: firstString(j.locations_derived),
    locationCity: firstString(j.cities_derived),
    locationCountry: typeof country === 'string' && country.trim() ? country : null,
    workType: isRemote ? 'remote' : 'unknown',
    employmentType: EMPLOYMENT_MAP[empRaw] ?? null,
    salaryMin,
    salaryMax: salaryMax ?? salaryMin, // single-value postings → mirror into max
    salaryCurrency: hasSalary
      ? (typeof sr?.currency === 'string' ? sr.currency : null) ??
        (typeof j.ai_salary_currency === 'string' ? j.ai_salary_currency : null)
      : null,
    salaryPeriod: hasSalary && unit ? (PERIOD_MAP[unit] ?? null) : null,
    postedAt: toIsoUtc(j.date_posted ?? j.date_created, fetchedAt),
    postedAtEstimated: typeof j.date_posted !== 'string' || !Number.isFinite(Date.parse(j.date_posted)),
    fetchedAt: fetchedAt.toISOString(),
    applyUrl,
    // Active Jobs DB `url` is the employer/ATS posting (source_type 'ats') → direct.
    // A row the provider read from a job board (source_type 'jobboard') → not direct.
    applyIsDirect: j.source_type === 'ats',
    description: descriptionRaw,
    sourcePublisher: prettifySource(j.source) ?? hostOf(j.source_domain),
    // Provider-stated extras for the WP-16b ingest normalizer (absent = not stated).
    ...fantasticExtras(j, workArrangement),
  });
}

/** Active Jobs DB / LinkedIn AI-enrichment fields the provider states (ARCH §4.2: map them first). */
function fantasticExtras(j: any, workArrangement: string): Partial<ExternalJobNormalized> {
  const out: Partial<ExternalJobNormalized> = {};
  if (workArrangement.trim()) out.workModel = workArrangement.trim();
  const level = typeof j.ai_experience_level === 'string' && j.ai_experience_level.trim() ? j.ai_experience_level.trim() : firstString(j.ai_experience_level);
  if (level) out.experienceLevel = level;
  const skills = Array.isArray(j.ai_key_skills)
    ? j.ai_key_skills.filter((s: unknown): s is string => typeof s === 'string' && s.trim() !== '')
    : [];
  if (skills.length) out.skills = skills;
  // `date_valid_through` is the v1 name; the two others are what older responses and cached rows carry.
  const validThrough = [j.date_valid_through, j.date_validthrough, j.valid_through].find((v): v is string => typeof v === 'string' && v.trim() !== '') ?? null;
  if (validThrough && Number.isFinite(Date.parse(validThrough))) out.expiresAt = validThrough;
  // The provider's reading, never a fact. `false` only says the description does not mention sponsorship
  // (vendor field description, read 2026-10-12), so it is not copied as "not offered".
  if (j.ai_visa_sponsorship === true) out.sponsorshipProvider = 'offered';
  const website =
    typeof j.organization_url === 'string' && /^https?:\/\//i.test(j.organization_url)
      ? j.organization_url
      : typeof j.domain_derived === 'string' && j.domain_derived.trim()
        ? `https://${j.domain_derived.trim()}`
        : null;
  if (website) out.companyWebsite = website;
  return out;
}

// ─── The call gate and the quota listener (one budget per provider) ────────
// Registered by the inventory pipeline (features/jobs/ingest/quota.ts). With
// nothing registered every call is allowed and no reading is reported.

let callGate: ProviderCallGate | null = null;
let quotaListener: ProviderQuotaListener | null = null;

/** Registers (or, with null, removes) the gate asked before every upstream call and by `isFantasticJobsEnabled()`. */
export function setCallGate(gate: ProviderCallGate | null): void {
  callGate = gate;
}

/** Registers (or, with null, removes) the listener told what every upstream response said about the plan's quota. */
export function setQuotaListener(listener: ProviderQuotaListener | null): void {
  quotaListener = listener;
}

/** The gate's answer; no gate, or a gate that throws, allows the call. */
function gateAllows(board: FantasticConfig['board'], purpose: ProviderCallPurpose, probe: boolean): boolean {
  if (!callGate) return true;
  try {
    return callGate(board, purpose, probe ? { probe: true } : undefined) !== false;
  } catch {
    return true;
  }
}

/**
 * Tells the listener what one upstream response said. A listener that throws
 * is swallowed. When the listener answers with a promise (the reading closed
 * or reopened the provider and is being stored), a person's own search gets
 * that wait back, bounded by QUOTA_LISTENER_WAIT_MS; an ingest call never
 * waits (its tick awaits the writes).
 */
async function reportQuota(board: FantasticConfig['board'], response: Response, bodyText: string, purpose: ProviderCallPurpose): Promise<void> {
  if (!quotaListener) return;
  try {
    const answer = quotaListener(quotaObservationFrom(board, response, bodyText, new Date()));
    if (purpose === 'interactive') await settleQuotaListener(answer);
  } catch {
    // The reading is lost; the search goes on.
  }
}

// ─── Per-provider guard: LRU cache, circuit breaker ────────────────────────
// One instance per config, so caches and breakers stay independent if a second
// board is ever added. No call counter: the gate above is the one budget.

class ProviderState {
  private cache = new Map<string, { at: number; jobs: ExternalJobNormalized[] }>();
  private breakerOpenedAt: number | null = null;

  constructor(private readonly cfg: FantasticConfig) {}

  breakerIsOpen(now: number): boolean {
    if (this.breakerOpenedAt == null) return false;
    if (now - this.breakerOpenedAt >= BREAKER_COOLDOWN_MS) {
      this.breakerOpenedAt = null;
      return false;
    }
    return true;
  }

  openBreaker(reason: string, httpStatus: number, requestId?: string): void {
    if (this.breakerOpenedAt != null) return; // warn once per opening
    this.breakerOpenedAt = Date.now();
    logger.warn('RA_V2_FANTASTIC_BREAKER_OPEN', 'Fantastic Jobs circuit breaker opened', {
      board: this.cfg.board,
      reason,
      httpStatus,
      cooldownUntil: new Date(this.breakerOpenedAt + BREAKER_COOLDOWN_MS).toISOString(),
      requestId,
    });
  }

  /** Key of the chosen transport present && kill switches off && breaker closed: the client can be called at all. */
  isUsable(): boolean {
    if (killed(this.cfg)) return false;
    if (!fantasticKeyPresent()) return false;
    return !this.breakerIsOpen(Date.now());
  }

  /** Usable && the call gate open for a person's own search (asked without counting a call). */
  isEnabled(): boolean {
    return this.isUsable() && gateAllows(this.cfg.board, 'interactive', true);
  }

  cacheGet(key: string, now: number): ExternalJobNormalized[] | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (now - entry.at > CACHE_TTL_MS) {
      this.cache.delete(key);
      return null;
    }
    this.cache.delete(key);
    this.cache.set(key, entry); // refresh recency (Map preserves insertion order)
    return entry.jobs;
  }

  cacheSet(key: string, jobs: ExternalJobNormalized[], now: number): void {
    this.cache.delete(key);
    this.cache.set(key, { at: now, jobs });
    while (this.cache.size > CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  reset(): void {
    this.cache.clear();
    this.breakerOpenedAt = null;
  }

  snapshot() {
    return {
      breakerOpen: this.breakerOpenedAt != null,
      cacheSize: this.cache.size,
    };
  }
}

const STATE: Record<FantasticConfig['board'], ProviderState> = {
  activejobs: new ProviderState(ACTIVE_JOBS_CONFIG),
};

const CONFIG: Record<FantasticConfig['board'], FantasticConfig> = {
  activejobs: ACTIVE_JOBS_CONFIG,
};

// ─── HTTP helpers (forked, raRapidApiJobs.ts precedent) ────────────────────

function headerNum(res: Response, name: string): number | null {
  const raw = res.headers.get(name);
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function isMonthlyQuota429(bodyText: string, res: Response): boolean {
  if (/monthly|quota/i.test(bodyText)) return true;
  return requestsRemainingFrom(res.headers) === 0;
}

function jitteredDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ─── Request building ──────────────────────────────────────────────────────

// The `title` parameter reads like a Google query: bare words are ANDed
// loosely, a double-quoted string is an exact phrase, OR joins alternatives
// (vendor documentation "New Jobs", parameter `title`, read 2026-10-12). A
// role is therefore asked as its own name and up to two other names of the
// same role, each an exact phrase: '"product manager" OR "product owner"'.
// Bare tokens ("backend software engineer" as three words) match loosely
// related titles, and every row returned is billed.

/** Characters a phrase may not carry: every kind of double quote, and the backslash. */
const PHRASE_QUOTES = /["\u201c\u201d\u201e\u201f\u00ab\u00bb\uff02\\]/g;
/** Longest phrase sent (characters). */
export const TITLE_PHRASE_MAX = 60;
/** Other names of the role sent beside its own. */
export const TITLE_SYNONYMS_MAX = 2;

/** One role name as the text of a phrase: no quotes, no control characters, single spaces, lower case, at most 60 characters; '' when nothing nameable is left. */
function titlePhrase(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let cleaned = '';
  for (const ch of raw.replace(PHRASE_QUOTES, ' ')) {
    const c = ch.codePointAt(0) ?? 0;
    cleaned += c < 32 || c === 127 ? ' ' : ch;
  }
  const phrase = cleaned.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, TITLE_PHRASE_MAX).trim();
  // A phrase with no letter and no digit ("---") names no role: it must never become a paid scan.
  return /[\p{L}\p{N}]/u.test(phrase) ? phrase : '';
}

/**
 * The `title` parameter for a role: its name and up to two synonyms as quoted
 * phrases joined by OR. '' when the role text names nothing (the caller then
 * makes no request).
 */
function titleFilterFrom(raw: string, synonyms: readonly string[] = []): string {
  const first = titlePhrase(raw);
  if (!first) return '';
  const phrases = [first];
  for (const synonym of synonyms) {
    if (phrases.length > TITLE_SYNONYMS_MAX) break;
    const phrase = titlePhrase(synonym);
    if (phrase && !phrases.includes(phrase)) phrases.push(phrase);
  }
  return phrases.map((p) => `"${p}"`).join(' OR ');
}

function buildQuery(params: ExternalSearchParams): URLSearchParams {
  const q = new URLSearchParams();
  const title = titleFilterFrom((params.titleQuery ?? params.query ?? '').trim(), Array.isArray(params.titleSynonyms) ? params.titleSynonyms : []);
  if (title) q.set('title', title);
  const location = (params.locationText ?? '').trim() || countryName(params.country) || '';
  if (location) q.set('location', location);
  q.set('time_frame', windowSuffix());
  q.set('description_format', 'text'); // required or no description field is returned
  q.set('limit', String(RESULT_LIMIT));
  if (params.workFromHome === true) q.set('ai_work_arrangement', 'Remote Solely,Remote OK');
  return q;
}

/** The whole title expression is part of the key: a page cached for the old token form is never served for a phrase query. */
function cacheKeyFor(board: FantasticConfig['board'], q: URLSearchParams): string {
  return [board, windowSuffix(), q.get('title') ?? '', q.get('location') ?? '', q.get('ai_work_arrangement') ?? '']
    .join('|')
    .toLowerCase();
}

// ─── One upstream GET (shared by the search and the feed) ──────────────────

type UpstreamAnswer =
  | { ok: true; response: Response }
  /** quota: the period's quota is used up; rate_limited: a burst limit persisted; refused: 401 / 403; gate: the call gate refused the retry. */
  | { ok: false; reason: 'quota' | 'rate_limited' | 'refused' | 'gate'; status: number | null };

/**
 * One GET with the provider's guards: a monthly-quota 429 and a 401 / 403
 * open the breaker; a burst 429 gets one jittered retry (a second upstream
 * call, so the gate is asked again); every upstream response is reported to
 * the quota listener. Throws only what `fetch` throws (network, abort): the
 * caller's own catch turns that into its "unavailable" answer.
 *
 * One exception, by route. A 401 / 403 on the EXPIRED route is a refusal of
 * that route, not of the key: the marketplace answers 403 for a part of the
 * API a plan does not include, and that route's path is not verified there.
 * The search and the new-jobs route are on `active`, and a refused key shows
 * itself there. So for `expired` the answer is 'refused' and nothing else
 * happens: the breaker stays closed (a person's own search is not stopped for
 * an hour) and the quota listener is not told the key is refused (the plan's
 * stated size is kept, so the feed's gate does not close).
 */
async function getUpstream(
  state: ProviderState,
  board: FantasticConfig['board'],
  url: string,
  headers: Record<string, string>,
  purpose: ProviderCallPurpose,
  signal: AbortSignal,
  requestId?: string,
  route: FantasticRoute = 'active',
): Promise<UpstreamAnswer> {
  let response = await fetch(url, { method: 'GET', headers, signal });

  if (response.status === 429) {
    const bodyText = await response.text().catch(() => '');
    await reportQuota(board, response, bodyText, purpose);
    if (isMonthlyQuota429(bodyText, response)) {
      state.openBreaker('429_monthly', 429, requestId);
      return { ok: false, reason: 'quota', status: 429 };
    }
    // Per-second burst: one jittered retry (a second upstream call, so the gate is asked again).
    await jitteredDelay(300 + Math.random() * 500, signal);
    if (!gateAllows(board, purpose, false)) return { ok: false, reason: 'gate', status: null };
    response = await fetch(url, { method: 'GET', headers, signal });
    if (response.status === 429) {
      const retryText = await response.text().catch(() => '');
      await reportQuota(board, response, retryText, purpose);
      if (isMonthlyQuota429(retryText, response)) {
        state.openBreaker('429_monthly', 429, requestId);
        return { ok: false, reason: 'quota', status: 429 };
      }
      logger.warn('RA_V2_FANTASTIC_RATE_LIMITED', 'Fantastic Jobs burst rate limit persisted', { requestId, board });
      return { ok: false, reason: 'rate_limited', status: 429 };
    }
  }

  if (response.status === 403 || response.status === 401) {
    if (route === 'expired') {
      await response.text().catch(() => '');
      logger.warn('RA_V2_FANTASTIC_ROUTE_REFUSED', 'Fantastic Jobs refused the expired route; the search and the new-jobs route are not affected', { requestId, board, route, httpStatus: response.status });
      return { ok: false, reason: 'refused', status: response.status };
    }
    // 403 also covers "endpoint not on plan" for a gated window (e.g. 7d); the body says which.
    await reportQuota(board, response, await response.text().catch(() => ''), purpose);
    state.openBreaker(response.status === 403 ? '403_not_subscribed' : '401', response.status, requestId);
    return { ok: false, reason: 'refused', status: response.status };
  }
  await reportQuota(board, response, '', purpose);
  return { ok: true, response };
}

/** A request's abort wiring: the caller's signal and the client's own timeout on one controller. */
function withTimeout(signal: AbortSignal | undefined): { controller: AbortController; release(): void } {
  const controller = new AbortController();
  const abortHandler = () => controller.abort();
  signal?.addEventListener('abort', abortHandler);
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return {
    controller,
    release() {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortHandler);
    },
  };
}

// ─── Search ────────────────────────────────────────────────────────────────

/**
 * Run one Fantastic Jobs search for `board`. Returns `null` (NEVER throws) when
 * disabled, unconfigured, refused by the call gate, breaker-open, or failed.
 */
export async function searchFantasticJobs(
  board: FantasticConfig['board'],
  params: ExternalSearchParams,
  opts?: ProviderSearchOptions,
): Promise<ExternalJobNormalized[] | null> {
  const cfg = CONFIG[board];
  const state = STATE[board];
  // A board this client has no config for (an untyped caller naming a dropped one) is never called and never throws.
  if (!cfg || !state) return null;
  if (killed(cfg)) return null;
  const transport = resolveTransport(); // the key is read per call — never cached, never logged
  if (!transport) return null;
  const title = (params.titleQuery ?? params.query ?? '').trim();
  if (!title) return null; // no title filter ⇒ the whole window; refuse (too broad + costly)
  if (opts?.signal?.aborted) return null;

  const now = Date.now();
  if (state.breakerIsOpen(now)) return null;

  const q = buildQuery(params);
  // A nonempty punctuation-only query must never become a paid full-window scan.
  if (!q.get('title')) return null;
  const cacheKey = cacheKeyFor(board, q);
  const cached = state.cacheGet(cacheKey, now);
  if (cached) {
    logger.info('RA_V2_FANTASTIC_CALL', 'Fantastic Jobs served from cache', {
      requestId: opts?.requestId,
      board,
      title: title.slice(0, 120),
      cacheHit: true,
      jobs: cached.length,
    });
    return [...cached];
  }

  // One budget per provider: the gate decides (and counts a call ingest has not already counted).
  // A cache hit above never reaches it.
  const purpose: ProviderCallPurpose = opts?.reservedByIngest === true ? 'ingest' : 'interactive';
  if (!gateAllows(board, purpose, false)) return null;

  // Sept 2026 marketplace migration: old /active-ats-7d /active-jb-7d
  // routes now 404. Current contracts use /active-ats or /active-jb with
  // time_frame/title/location/description_format. Verified live 2026-09-12.
  const url = `https://${transport.host}${fantasticRoutePath('active')}?${q.toString()}`;

  const { controller, release } = withTimeout(opts?.signal);
  const startedAt = Date.now();

  try {
    const answer = await getUpstream(state, board, url, transport.headers, purpose, controller.signal, opts?.requestId);
    if (!answer.ok) return null;
    const response = answer.response;

    const rlLimit = headerNum(response, 'x-ratelimit-requests-limit') ?? headerNum(response, 'x-api-requests-limit');
    const rlRemaining = requestsRemainingFrom(response.headers);

    if (!response.ok) {
      logger.warn('RA_V2_FANTASTIC_HTTP_ERROR', `Fantastic Jobs HTTP ${response.status}`, {
        requestId: opts?.requestId,
        board,
        httpStatus: response.status,
        title: title.slice(0, 120),
      });
      return null;
    }

    const body = (await response.json().catch(() => null)) as unknown;
    // Bare array on success; an error object ({message}) means failure.
    if (!Array.isArray(body)) {
      logger.warn('RA_V2_FANTASTIC_ENVELOPE_ERROR', 'Fantastic Jobs returned a non-array body', {
        requestId: opts?.requestId,
        board,
        title: title.slice(0, 120),
      });
      return null;
    }

    const fetchedAt = new Date();
    const jobs = body
      .map((j) => normalizeFantasticJob(j, board, fetchedAt))
      .filter((j): j is ExternalJobNormalized => j !== null);
    if (body.length > 0 && jobs.length === 0) return null;

    logger.info('RA_V2_FANTASTIC_CALL', 'Fantastic Jobs search completed', {
      requestId: opts?.requestId,
      board,
      transport: transport.kind,
      window: windowSuffix(),
      title: title.slice(0, 120),
      location: q.get('location') ?? '',
      httpStatus: response.status,
      rawRows: body.length,
      jobs: jobs.length,
      cacheHit: false,
      rlLimit,
      rlRemaining,
      durationMs: Date.now() - startedAt,
    });

    state.cacheSet(cacheKey, [...jobs], Date.now());
    return jobs;
  } catch (err) {
    logger.warn('RA_V2_FANTASTIC_FAILED', 'Fantastic Jobs search failed; continuing without it', {
      requestId: opts?.requestId,
      board,
      errorType: err instanceof Error ? err.name : 'UnknownError',
    });
    return null;
  } finally {
    release();
  }
}

export function isFantasticJobsEnabled(board: FantasticConfig['board']): boolean {
  return STATE[board]?.isEnabled() ?? false;
}

/**
 * Can the client be called at all (the key of the chosen transport, the kill
 * switches, the breaker)? The call gate is NOT asked: whoever plans an ingest
 * call asks the quota itself, for its own market and purpose.
 */
export function isFantasticJobsUsable(board: FantasticConfig['board'] = 'activejobs'): boolean {
  return STATE[board]?.isUsable() ?? false;
}

/**
 * Why the client is off by configuration, as the short code the job-source
 * registry shows: a kill switch (the shared one or its own) first, then the
 * key of the chosen transport. Null when neither applies.
 */
export function fantasticJobsOffReason(env: Env = process.env): 'kill_switch' | 'no_api_key' | null {
  if (killed(ACTIVE_JOBS_CONFIG, env)) return 'kill_switch';
  return fantasticKeyPresent(env) ? null : 'no_api_key';
}

// ─── The licensed feed's two routes ────────────────────────────────────────

/** A response body larger than this is not read (the expired route's monthly answer is "very large": vendor documentation). */
export const FEED_RESPONSE_MAX_BYTES = 96 * 1024 * 1024;

export interface FeedRequestOptions {
  signal?: AbortSignal;
  requestId?: string;
}

/**
 * The answer of one feed request. `called` says whether an upstream request
 * was made at all (a refusal by a switch, the key, the breaker or the gate
 * makes none). `error` is a short code, never a URL, a header or a key:
 * 'refused' is a 401 / 403 (on the expired route it concerns that route only
 * and opens no breaker: see `getUpstream`).
 */
export type FeedResponse =
  | { ok: true; status: number; body: unknown[]; called: true }
  | { ok: false; error: string; status: number | null; called: boolean };

/** What a feed transport is: the client's own `feedRequest`, or a test's stand-in. */
export type FeedRequestFn = (route: FantasticRoute, params: Readonly<Record<string, string>>, opts?: FeedRequestOptions) => Promise<FeedResponse>;

/**
 * One GET of the licensed feed: a page of the new-jobs route (`active`) or the
 * ids of the expired route. Shares the search's transport, 25 s timeout,
 * breaker, call gate (asked as ingest: the feed is the pipeline's own call)
 * and quota listener. NEVER throws. The parameters are sent as given: the
 * feed adapter builds them from an allow-list of documented names (the direct
 * API answers 400 to a name it does not know).
 */
export const feedRequest: FeedRequestFn = async (route, params, opts) => {
  const board = ACTIVE_JOBS_CONFIG.board;
  const state = STATE[board];
  if (killed(ACTIVE_JOBS_CONFIG)) return { ok: false, error: 'disabled', status: null, called: false };
  const transport = resolveTransport(); // the key is read per call — never cached, never logged
  if (!transport) return { ok: false, error: 'no_key', status: null, called: false };
  if (opts?.signal?.aborted) return { ok: false, error: 'aborted', status: null, called: false };
  if (state.breakerIsOpen(Date.now())) return { ok: false, error: 'breaker_open', status: null, called: false };
  if (!gateAllows(board, 'ingest', false)) return { ok: false, error: 'quota', status: null, called: false };

  const url = `https://${transport.host}${fantasticRoutePath(route)}?${new URLSearchParams(params).toString()}`;
  const { controller, release } = withTimeout(opts?.signal);
  const startedAt = Date.now();
  try {
    const answer = await getUpstream(state, board, url, transport.headers, 'ingest', controller.signal, opts?.requestId, route);
    if (!answer.ok) return { ok: false, error: answer.reason, status: answer.status, called: true };
    const response = answer.response;
    if (!response.ok) {
      logger.warn('RA_V2_FANTASTIC_HTTP_ERROR', `Fantastic Jobs feed HTTP ${response.status}`, { requestId: opts?.requestId, board, route, httpStatus: response.status });
      return { ok: false, error: `http_${response.status}`, status: response.status, called: true };
    }
    const stated = headerNum(response, 'content-length');
    if (stated !== null && stated > FEED_RESPONSE_MAX_BYTES) {
      logger.warn('RA_V2_FANTASTIC_FEED_TOO_LARGE', 'Fantastic Jobs feed answer is larger than the client reads', { requestId: opts?.requestId, board, route, bytes: stated });
      return { ok: false, error: 'too_large', status: response.status, called: true };
    }
    const body = (await response.json().catch(() => null)) as unknown;
    if (!Array.isArray(body)) {
      logger.warn('RA_V2_FANTASTIC_ENVELOPE_ERROR', 'Fantastic Jobs feed returned a non-array body', { requestId: opts?.requestId, board, route });
      return { ok: false, error: 'bad_shape', status: response.status, called: true };
    }
    logger.info('RA_V2_FANTASTIC_FEED', 'Fantastic Jobs feed request completed', {
      requestId: opts?.requestId,
      board,
      route,
      transport: transport.kind,
      timeFrame: params.time_frame ?? null,
      offset: params.offset ?? null,
      httpStatus: response.status,
      rows: body.length,
      durationMs: Date.now() - startedAt,
    });
    return { ok: true, status: response.status, body, called: true };
  } catch (err) {
    const name = (err as { name?: unknown } | null)?.name;
    logger.warn('RA_V2_FANTASTIC_FAILED', 'Fantastic Jobs feed request failed', { requestId: opts?.requestId, board, route, errorType: typeof name === 'string' ? name.slice(0, 40) : 'UnknownError' });
    return { ok: false, error: (err as { name?: unknown } | null)?.name === 'AbortError' ? 'timeout' : 'network', status: null, called: true };
  } finally {
    release();
  }
};

// ─── Providers ─────────────────────────────────────────────────────────────

export const activeJobsDbProvider: JobSearchProvider = {
  id: 'activejobs',
  isEnabled: () => isFantasticJobsEnabled('activejobs'),
  search: (params, opts) => searchFantasticJobs('activejobs', params, opts),
};

// ─── Test seam ─────────────────────────────────────────────────────────────

export const __test = {
  reset(): void {
    STATE.activejobs.reset();
  },
  state(board: FantasticConfig['board']) {
    return STATE[board].snapshot();
  },
  normalizeFantasticJob,
  toIsoUtc,
  countryName,
  buildQuery,
  cacheKeyFor,
  titleFilterFrom,
  titlePhrase,
  windowSuffix,
  resolveTransport,
};
