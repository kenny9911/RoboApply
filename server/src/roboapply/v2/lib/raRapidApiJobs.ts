// backend/src/roboapply/v2/lib/raRapidApiJobs.ts
//
// JSearch (OpenWeb Ninja via RapidAPI) job-search client + normalizer for the
// RoboApply V2 onboarding chat's external recommendation round.
//
// Mirrors the raWebSearch.ts discipline: self-contained V2-local client
// (the boundary script forbids importing recruiter `services/*`), env-gated
// key read per call, and a hard "NEVER throws to callers" contract — every
// failure path returns `null` + a logger.warn so the recommendation round
// degrades to internal-only silently.
//
// Cost-control layers (the 10k req/month RapidAPI plan is the scarce
// resource — see docs/design-spec-roboapply-onboarding-chat.md §4.2):
//   - in-process LRU response cache (6h TTL, 200 entries) — hits cost zero
//   - the call gate (setCallGate): asked before every upstream call and by
//     isJSearchEnabled(). The inventory pipeline registers it
//     (features/jobs/ingest/quota.ts): ONE budget per provider, read from the
//     plan's own quota headers and counted in RAProviderUsage. This client
//     keeps no call counter of its own (MARKET_STRATEGY §1.2, JI-1)
//   - the quota listener (setQuotaListener): told what every upstream response
//     said about the plan (limit, remaining, reset, plan name); never the key
//   - circuit breaker: 403 not-subscribed / 401 bad-key / monthly 429 open it
//     for a 1h cooldown; per-second burst 429 gets exactly one jittered retry
//   - kill switch: RA_ONBOARDING_EXTERNAL_JOBS_DISABLED=true ⇒ always null
//
// Employer-direct is decided by the link's host (JI-6): the 2026-10-11 probes
// found one apply option per job and `is_direct` true on 0 of 58 rows.
//
// The RAPID_API_KEY value is never logged and never echoed anywhere.

import { logger } from '../../../services/LoggerService.js';
import { atsTypeFromUrl, employmentTypeFromLabel, hostOf, isJobBoardHost, isLinkedInHost, safeUrl } from '../../../features/jobs/normalize/index.js';
import {
  quotaObservationFrom,
  settleQuotaListener,
  type ExternalJobNormalized,
  type ProviderCallGate,
  type ProviderCallPurpose,
  type ProviderQuotaListener,
  type ProviderSearchOptions,
} from './raExternalJobTypes.js';

export type { ExternalJobNormalized } from './raExternalJobTypes.js';

const BASE_URL = 'https://jsearch.p.rapidapi.com';
const RAPIDAPI_HOST = 'jsearch.p.rapidapi.com';
const REQUEST_TIMEOUT_MS = 25_000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;
const BREAKER_COOLDOWN_MS = 60 * 60 * 1000;

// ExternalJobNormalized now lives in raExternalJobTypes.ts (shared across all
// providers). Work-type / employment-type semantics (critic findings E7 + R4):
// the JSearch /search payload carries NO hybrid/onsite signal — only
// `job_is_remote` is trustworthy, and ONLY when it is `true`. Non-remote and
// null values are UNKNOWN, never "onsite".

export interface JSearchSearchParams {
  query: string;
  /** ISO-3166 alpha-2, lowercase (Google for Jobs market). */
  country: string;
  language?: string;
  datePosted?: 'all' | 'today' | '3days' | 'week' | 'month';
  workFromHome?: boolean;
  /** Comma-separated JSearch enums, e.g. 'FULLTIME,CONTRACTOR'. */
  employmentTypes?: string;
  /**
   * Pages per call (10 jobs each). Default 2. What the second page costs is
   * not settled (INTL note §3.1): the quota snapshot's `lastCallCost` shows it.
   */
  numPages?: number;
  page?: number;
}

// ---------------------------------------------------------------------------
// Postgres-safety helpers — forked from lib/candidateResumeIngest.ts (those
// are module-private there; fork-don't-cross per the raLocale.ts convention).
// PostgreSQL rejects NUL (0x00) in TEXT and jsonb; scraped job text can carry
// NUL + other C0 control chars. Tab/newline/CR are preserved.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** JSearch enum + display-string → V2 employment enum. Unknown ⇒ null (null-pass). */
function mapEmployment(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const key = raw.toUpperCase().replace(/[^A-Z]/g, '');
  if (key === 'FULLTIME') return 'full_time';
  if (key === 'PARTTIME') return 'part_time';
  if (key === 'CONTRACTOR' || key === 'CONTRACT') return 'contract';
  if (key.startsWith('INTERN')) return 'internship';
  // Chinese display strings (全职, 兼职, 实习, 合同 / 劳务): the one mapping in features/jobs/normalize/level.ts.
  return employmentTypeFromLabel(raw);
}

// The /search payload has NO currency field — infer from the request country,
// and ONLY when the posting actually states a salary. Unknown market ⇒ null;
// never assume USD (a TWD 1.6M floor compared against a fake-USD row would be
// silently catastrophic).
const COUNTRY_CURRENCY: Record<string, string> = {
  us: 'USD', tw: 'TWD', jp: 'JPY', cn: 'CNY', hk: 'HKD', sg: 'SGD',
  gb: 'GBP', uk: 'GBP', de: 'EUR', fr: 'EUR', es: 'EUR', pt: 'EUR',
  it: 'EUR', nl: 'EUR', ie: 'EUR', ca: 'CAD', au: 'AUD', nz: 'NZD',
  in: 'INR', kr: 'KRW', br: 'BRL', mx: 'MXN', ch: 'CHF',
};

function currencyForCountry(country: string | null | undefined): string | null {
  if (!country) return null;
  return COUNTRY_CURRENCY[country.trim().toLowerCase()] ?? null;
}

const RELATIVE_UNIT_MS: Record<string, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
};

/**
 * Parse JSearch's localized relative `job_posted_at` strings ("2 days ago",
 * "19 小時前", "19 小时前", "3日前", "2週間前") relative to fetch time.
 * Verified TW reality: `job_posted_at_datetime_utc` is null 10/10, so this is
 * the only date signal there. Unparseable ⇒ null (caller falls back to fetch time).
 */
function parseRelativePostedAt(raw: unknown, fetchedAt: Date): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;

  let value: number | null = null;
  let unit: string | null = null;

  const en = text.match(/(\d+)\s*(minute|hour|day|week|month)s?\s+ago/i);
  if (en) {
    value = parseInt(en[1], 10);
    unit = en[2].toLowerCase();
  } else {
    // zh: 小时/天/周/个月 · zh-TW: 小時/天/週/個月 · ja: 分/時間/日/週間/ヶ月
    const cjk = text.match(/(\d+)\s*(分鐘|分钟|分|時間|小時|小时|日|天|週間|週|周|個月|个月|ヶ月|か月)\s*前/);
    if (cjk) {
      value = parseInt(cjk[1], 10);
      const u = cjk[2];
      if (u === '分鐘' || u === '分钟' || u === '分') unit = 'minute';
      else if (u === '時間' || u === '小時' || u === '小时') unit = 'hour';
      else if (u === '日' || u === '天') unit = 'day';
      else if (u === '週間' || u === '週' || u === '周') unit = 'week';
      else unit = 'month';
    }
  }

  if (value == null || unit == null || !Number.isFinite(value)) return null;
  const ms = RELATIVE_UNIT_MS[unit];
  if (!ms) return null;
  return new Date(fetchedAt.getTime() - value * ms).toISOString();
}

/** Where an apply link leads: the employer (its own site or its ATS), a job board, or LinkedIn. */
type LinkKind = 'employer' | 'board' | 'linkedin';

function linkKind(url: string): LinkKind | null {
  const host = hostOf(url);
  if (!host) return null;
  if (isLinkedInHost(host)) return 'linkedin';
  // An ATS host or a host we do not know is the employer's; a job board or aggregator is not.
  if (atsTypeFromUrl(url) !== null) return 'employer';
  return isJobBoardHost(host) ? 'board' : null;
}

/**
 * The apply link of a row, decided by the links' hosts (JI-6). `is_direct` is
 * not usable: the provider sends one apply option per job and never sets it.
 * Every valid http(s) link is a candidate (`job_apply_link` first, then
 * `apply_options` in their order); the first on an employer or ATS host wins,
 * then a link on a job board other than LinkedIn (one the provider itself
 * flagged as direct before the others), then a LinkedIn link.
 * `isDirect` is true exactly when the chosen link is on an employer or ATS
 * host, or it is a job-board link the provider itself flagged as direct. A
 * LinkedIn link is never direct, whatever the flag says.
 */
function pickApplyUrl(j: any): { url: string | null; isDirect: boolean } {
  const candidates: Array<{ url: string; kind: LinkKind; flagged: boolean }> = [];
  const add = (link: unknown, flagged: boolean): void => {
    if (typeof link !== 'string' || !safeUrl(link)) return;
    const kind = linkKind(link);
    if (kind) candidates.push({ url: link, kind, flagged });
  };
  add(j?.job_apply_link, j?.job_apply_is_direct === true);
  for (const option of Array.isArray(j?.apply_options) ? j.apply_options : []) add(option?.apply_link, option?.is_direct === true);
  const chosen =
    candidates.find((c) => c.kind === 'employer') ??
    candidates.find((c) => c.kind === 'board' && c.flagged) ??
    candidates.find((c) => c.kind === 'board') ??
    candidates.find((c) => c.kind === 'linkedin') ??
    null;
  if (!chosen) return { url: null, isDirect: false };
  return { url: chosen.url, isDirect: chosen.kind === 'employer' || (chosen.kind === 'board' && chosen.flagged) };
}

/**
 * The posting's page at its publisher, kept apart from the best application
 * destination: the first valid link (`job_apply_link`, then `apply_options`
 * in their order) that is not on a LinkedIn host. Never a LinkedIn URL
 * (MARKET_STRATEGY §1.5: no LinkedIn name, logo or URL on any source field);
 * null when LinkedIn is the row's only link.
 */
function pickSourceUrl(j: any): string | null {
  const original = typeof j?.job_apply_link === 'string' ? j.job_apply_link : null;
  const options = Array.isArray(j?.apply_options) ? j.apply_options : [];
  const links: unknown[] = [original, ...options.map((option: any) => option?.apply_link)];
  for (const link of links) {
    if (typeof link !== 'string' || !safeUrl(link)) continue;
    if (!isLinkedInHost(hostOf(link))) return link;
  }
  return null;
}

/**
 * Normalize one raw /search job. Returns null for rows missing the identity
 * fields (id / title / employer) — normalize-and-drop, CustomHttpDriver style.
 */
export function normalizeJSearchJob(
  j: any,
  req: { country: string; fetchedAt: Date },
): ExternalJobNormalized | null {
  if (!j || typeof j !== 'object') return null;
  if (typeof j.job_id !== 'string' || !j.job_id) return null;
  if (typeof j.job_title !== 'string' || !j.job_title.trim()) return null;
  if (typeof j.employer_name !== 'string' || !j.employer_name.trim()) return null;

  const hasSalary = j.job_min_salary != null || j.job_max_salary != null;
  const apply = pickApplyUrl(j);
  const absoluteDate = typeof j.job_posted_at_datetime_utc === 'string'
    ? Date.parse(j.job_posted_at_datetime_utc)
    : typeof j.job_posted_at_timestamp === 'number' ? j.job_posted_at_timestamp * 1000 : NaN;
  const sourcePostedAt = Number.isFinite(absoluteDate) && Math.abs(absoluteDate) <= 8.64e15
    ? new Date(absoluteDate).toISOString()
    : parseRelativePostedAt(j.job_posted_at, req.fetchedAt);

  return deepClean({
    externalId: `jsearch:${j.job_id}`,
    sourceBoard: 'jsearch' as const,
    title: j.job_title,
    company: j.employer_name,
    companyLogoUrl: typeof j.employer_logo === 'string' ? j.employer_logo : null,
    location: (j.job_city && j.job_country)
      ? [j.job_city, j.job_state, j.job_country].filter(Boolean).join(', ')
      : (typeof j.job_location === 'string' ? j.job_location : null), // TW reality: city/country null 10/10
    locationCity: typeof j.job_city === 'string' ? j.job_city : null,
    locationCountry: typeof j.job_country === 'string'
      ? j.job_country
      : (req.country ? req.country.toUpperCase() : null),
    locationCountryEstimated: typeof j.job_country !== 'string' || !j.job_country.trim(),
    workType: j.job_is_remote === true ? 'remote' : 'unknown', // only true is trusted; never 'onsite'
    employmentType: mapEmployment(
      (Array.isArray(j.job_employment_types) ? j.job_employment_types[0] : undefined)
        ?? j.job_employment_type,
    ),
    salaryMin: j.job_min_salary != null ? Math.round(Number(j.job_min_salary)) : null,
    salaryMax: j.job_max_salary != null ? Math.round(Number(j.job_max_salary)) : null,
    salaryCurrency: hasSalary ? (typeof j.job_salary_currency === 'string' ? j.job_salary_currency : currencyForCountry(req.country)) : null,
    salaryCurrencyInferred: hasSalary && typeof j.job_salary_currency !== 'string',
    salaryPeriod: typeof j.job_salary_period === 'string' ? j.job_salary_period.toLowerCase() : null,
    postedAt: sourcePostedAt ?? req.fetchedAt.toISOString(),
    postedAtEstimated: sourcePostedAt === null,
    fetchedAt: req.fetchedAt.toISOString(),
    applyUrl: apply.url,
    sourceUrl: pickSourceUrl(j),
    applyIsDirect: apply.isDirect,
    description: typeof j.job_description === 'string' ? j.job_description : '',
    sourcePublisher: typeof j.job_publisher === 'string' ? j.job_publisher : null,
    // Provider-stated extras for the WP-16b ingest normalizer (absent = not stated).
    ...jsearchExtras(j),
  });
}

/** JSearch fields the provider states that the onboarding consumer never read. */
function jsearchExtras(j: any): Partial<ExternalJobNormalized> {
  const out: Partial<ExternalJobNormalized> = {};
  const exp = j.job_required_experience && typeof j.job_required_experience === 'object' ? j.job_required_experience : null;
  if (exp?.no_experience_required === true) out.experienceMonths = 0;
  else if (typeof exp?.required_experience_in_months === 'number' && Number.isFinite(exp.required_experience_in_months)) {
    out.experienceMonths = exp.required_experience_in_months;
  }
  const skills = Array.isArray(j.job_required_skills)
    ? j.job_required_skills.filter((s: unknown): s is string => typeof s === 'string' && s.trim() !== '')
    : [];
  if (skills.length) out.skills = skills;
  if (typeof j.job_offer_expiration_datetime_utc === 'string' && Number.isFinite(Date.parse(j.job_offer_expiration_datetime_utc))) {
    out.expiresAt = j.job_offer_expiration_datetime_utc;
  }
  if (typeof j.employer_website === 'string' && /^https?:\/\//i.test(j.employer_website)) out.companyWebsite = j.employer_website;
  return out;
}

// ---------------------------------------------------------------------------
// Module state: LRU response cache and circuit breaker (per process), plus the
// call gate and the quota listener the inventory pipeline registers. There is
// no call counter here: the one budget is the pipeline's (RAProviderUsage and
// the plan's own quota headers).
// ---------------------------------------------------------------------------

const responseCache = new Map<string, { at: number; jobs: ExternalJobNormalized[] }>();

let breakerOpenedAt: number | null = null;

let callGate: ProviderCallGate | null = null;
let quotaListener: ProviderQuotaListener | null = null;

/** Registers (or, with null, removes) the gate asked before every upstream call and by `isJSearchEnabled()`. */
export function setCallGate(gate: ProviderCallGate | null): void {
  callGate = gate;
}

/** Registers (or, with null, removes) the listener told what every upstream response said about the plan's quota. */
export function setQuotaListener(listener: ProviderQuotaListener | null): void {
  quotaListener = listener;
}

/** The gate's answer; no gate, or a gate that throws, allows the call. */
function gateAllows(purpose: ProviderCallPurpose, probe: boolean): boolean {
  if (!callGate) return true;
  try {
    return callGate('jsearch', purpose, probe ? { probe: true } : undefined) !== false;
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
async function reportQuota(response: Response, bodyText: string, purpose: ProviderCallPurpose): Promise<void> {
  if (!quotaListener) return;
  try {
    const answer = quotaListener(quotaObservationFrom('jsearch', response, bodyText, new Date()));
    if (purpose === 'interactive') await settleQuotaListener(answer);
  } catch {
    // The reading is lost; the search goes on.
  }
}

function buildCacheKey(p: JSearchSearchParams): string {
  return [
    p.query.trim().toLowerCase(),
    p.country.trim().toLowerCase(),
    p.datePosted ?? 'all',
    p.workFromHome === true ? 'wfh' : 'any',
    p.employmentTypes ?? '',
    p.page ?? 1,
    p.numPages ?? 2,
    p.language ?? '',
  ].join('|');
}

function cacheGet(key: string, now: number): ExternalJobNormalized[] | null {
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (now - entry.at > CACHE_TTL_MS) {
    responseCache.delete(key);
    return null;
  }
  // Refresh recency (Map preserves insertion order → oldest entry is first key).
  responseCache.delete(key);
  responseCache.set(key, entry);
  return entry.jobs;
}

function cacheSet(key: string, jobs: ExternalJobNormalized[], now: number): void {
  responseCache.delete(key);
  responseCache.set(key, { at: now, jobs });
  while (responseCache.size > CACHE_MAX_ENTRIES) {
    const oldest = responseCache.keys().next().value;
    if (oldest === undefined) break;
    responseCache.delete(oldest);
  }
}

function breakerIsOpen(now: number): boolean {
  if (breakerOpenedAt == null) return false;
  if (now - breakerOpenedAt >= BREAKER_COOLDOWN_MS) {
    breakerOpenedAt = null;
    return false;
  }
  return true;
}

function openBreaker(
  reason: '403_not_subscribed' | '429_monthly' | '401',
  httpStatus: number,
  requestId?: string,
): void {
  if (breakerOpenedAt != null) return; // warn once per opening
  breakerOpenedAt = Date.now();
  logger.warn('RA_V2_JSEARCH_BREAKER_OPEN', 'JSearch circuit breaker opened', {
    reason,
    httpStatus,
    cooldownUntil: new Date(breakerOpenedAt + BREAKER_COOLDOWN_MS).toISOString(),
    requestId,
  });
}

/**
 * Whether a billed JSearch call could succeed right now: key present, kill
 * switch off, circuit breaker closed, and the call gate open for a person's
 * own search (asked without counting a call). The provider seam
 * (raJobProviders.ts) exposes this so the orchestrator can plan an
 * internal-only round without burning a turn on a doomed fetch.
 */
export function isJSearchEnabled(): boolean {
  if (process.env.RA_ONBOARDING_EXTERNAL_JOBS_DISABLED === 'true') return false;
  if (!process.env.RAPID_API_KEY?.trim()) return false;
  if (breakerIsOpen(Date.now())) return false;
  return gateAllows('interactive', true);
}

function headerNum(res: Response, name: string): number | null {
  const raw = res.headers.get(name);
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Monthly-quota 429s must open the breaker; per-second burst 429s may retry once. */
function isMonthlyQuota429(bodyText: string, res: Response): boolean {
  if (/monthly|quota/i.test(bodyText)) return true;
  return headerNum(res, 'x-ratelimit-requests-remaining') === 0;
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

/**
 * Run one JSearch /search. Returns `null` (NEVER throws) when disabled,
 * unconfigured, refused by the call gate, breaker-open, or failed — callers
 * treat `null` as "external jobs unavailable" and degrade to internal-only.
 */
export async function searchJSearchJobs(
  params: JSearchSearchParams,
  opts?: ProviderSearchOptions,
): Promise<ExternalJobNormalized[] | null> {
  if (process.env.RA_ONBOARDING_EXTERNAL_JOBS_DISABLED === 'true') return null;
  const apiKey = process.env.RAPID_API_KEY?.trim(); // read per call — never cached, never logged
  if (!apiKey) return null;
  if (!params.query?.trim() || !params.country?.trim()) return null;
  if (opts?.signal?.aborted) return null;

  const now = Date.now();
  if (breakerIsOpen(now)) return null;

  const cacheKey = buildCacheKey(params);
  const cached = cacheGet(cacheKey, now);
  if (cached) {
    logger.info('RA_V2_JSEARCH_CALL', 'JSearch search served from cache', {
      requestId: opts?.requestId,
      query: params.query.slice(0, 120),
      country: params.country,
      cacheHit: true,
      jobs: cached.length,
    });
    return [...cached];
  }

  // One budget per provider: the gate decides (and counts a call ingest has not already counted).
  // A cache hit above never reaches it.
  const purpose: ProviderCallPurpose = opts?.reservedByIngest === true ? 'ingest' : 'interactive';
  if (!gateAllows(purpose, false)) return null;

  const numPages = params.numPages ?? 2;
  const search = new URLSearchParams();
  search.set('query', params.query.trim());
  search.set('page', String(params.page ?? 1));
  search.set('num_pages', String(numPages));
  search.set('country', params.country.trim().toLowerCase());
  if (params.language?.trim()) search.set('language', params.language.trim());
  if (params.datePosted && params.datePosted !== 'all') search.set('date_posted', params.datePosted);
  if (params.workFromHome === true) search.set('work_from_home', 'true');
  if (params.employmentTypes?.trim()) search.set('employment_types', params.employmentTypes.trim());
  // OpenWeb Ninja versioned the search endpoint: the legacy `/search` (page-
  // based) is no longer published on the current listing and 404s at the proxy
  // ("Endpoint '/search' does not exist"). `/search-v2` is the live endpoint —
  // same job-field schema, but the jobs array is nested under `data.jobs`
  // (classic `/search` returned a bare `data[]`). `num_pages` still expands the
  // result set (10 jobs/page); `page`/`country`/`date_posted`/`work_from_home`/
  // `employment_types`/`language` are unchanged. Verified live 2026-07-13.
  const url = `${BASE_URL}/search-v2?${search.toString()}`;

  const headers = {
    'x-rapidapi-key': apiKey,
    'x-rapidapi-host': RAPIDAPI_HOST,
  };

  const controller = new AbortController();
  const abortHandler = () => controller.abort();
  opts?.signal?.addEventListener('abort', abortHandler);
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    let response = await fetch(url, { method: 'GET', headers, signal: controller.signal });

    if (response.status === 429) {
      const bodyText = await response.text().catch(() => '');
      await reportQuota(response, bodyText, purpose);
      if (isMonthlyQuota429(bodyText, response)) {
        openBreaker('429_monthly', 429, opts?.requestId);
        return null;
      }
      // Per-second burst — exactly one jittered retry (a second upstream call: the gate is asked again).
      await jitteredDelay(300 + Math.random() * 500, controller.signal);
      if (!gateAllows(purpose, false)) return null;
      response = await fetch(url, { method: 'GET', headers, signal: controller.signal });
      if (response.status === 429) {
        const retryText = await response.text().catch(() => '');
        await reportQuota(response, retryText, purpose);
        if (isMonthlyQuota429(retryText, response)) {
          openBreaker('429_monthly', 429, opts?.requestId);
        } else {
          logger.warn('RA_V2_JSEARCH_RATE_LIMITED', 'JSearch burst rate limit persisted after one retry', {
            requestId: opts?.requestId,
            query: params.query.slice(0, 120),
          });
        }
        return null;
      }
    }

    if (response.status === 403 || response.status === 401) {
      // The body says whether the key has no subscription to this API or was refused for another reason.
      await reportQuota(response, await response.text().catch(() => ''), purpose);
      openBreaker(response.status === 403 ? '403_not_subscribed' : '401', response.status, opts?.requestId);
      return null;
    }
    await reportQuota(response, '', purpose);

    const rlLimit = headerNum(response, 'x-ratelimit-requests-limit');
    const rlRemaining = headerNum(response, 'x-ratelimit-requests-remaining');
    const rlResetSec = headerNum(response, 'x-ratelimit-requests-reset');

    if (!response.ok) {
      logger.warn('RA_V2_JSEARCH_HTTP_ERROR', `JSearch HTTP ${response.status}`, {
        requestId: opts?.requestId,
        httpStatus: response.status,
        query: params.query.slice(0, 120),
      });
      return null;
    }

    const body = (await response.json().catch(() => null)) as
      | { status?: string; data?: { jobs?: unknown[] } | unknown[] }
      | null;

    // JSearch can return `"status":"ERROR"` inside an HTTP 200 — treat as failure.
    if (!body || body.status !== 'OK') {
      logger.warn('RA_V2_JSEARCH_ENVELOPE_ERROR', 'JSearch returned a non-OK envelope', {
        requestId: opts?.requestId,
        envelopeStatus: body?.status ?? 'unparseable',
        query: params.query.slice(0, 120),
      });
      return null;
    }

    // /search-v2 nests the array under `data.jobs`; tolerate the legacy bare
    // `data[]` shape too so a future/rolled-back listing keeps working.
    const nestedJobs = (body.data as { jobs?: unknown[] })?.jobs;
    const rawJobs: unknown[] = Array.isArray(nestedJobs)
      ? nestedJobs
      : Array.isArray(body.data)
        ? (body.data as unknown[])
        : [];

    // status==='OK' but the jobs array is under an unrecognized key ⇒ the
    // endpoint's response shape drifted (a silent [] would masquerade as a
    // genuinely empty market at info level). Surface it so alerting can catch it.
    if (!Array.isArray(nestedJobs) && !Array.isArray(body.data)) {
      logger.warn('RA_V2_JSEARCH_SHAPE_UNRECOGNIZED', 'JSearch OK envelope but no jobs array found', {
        requestId: opts?.requestId,
        query: params.query.slice(0, 120),
        topLevelKeys: Object.keys(body).slice(0, 12),
        dataKeys:
          body.data && typeof body.data === 'object'
            ? Object.keys(body.data as Record<string, unknown>).slice(0, 12)
            : typeof body.data,
      });
      return null;
    }

    const fetchedAt = new Date();
    const jobs = rawJobs
      .map((j) => normalizeJSearchJob(j, { country: params.country, fetchedAt }))
      .filter((j): j is ExternalJobNormalized => j !== null);
    if (rawJobs.length > 0 && jobs.length === 0) return null;

    logger.info('RA_V2_JSEARCH_CALL', 'JSearch search completed', {
      requestId: opts?.requestId,
      query: params.query.slice(0, 120),
      country: params.country,
      page: `1-${numPages}`,
      httpStatus: response.status,
      envelopeStatus: 'OK',
      jobs: jobs.length,
      cacheHit: false,
      rlLimit,
      rlRemaining,
      rlResetSec,
      durationMs: Date.now() - startedAt,
    });

    if (rlLimit != null && rlRemaining != null && rlRemaining < rlLimit * 0.1) {
      logger.warn('RA_V2_JSEARCH_QUOTA_LOW', 'JSearch monthly quota below 10% remaining', {
        requestId: opts?.requestId,
        rlLimit,
        rlRemaining,
        rlResetSec,
      });
    }

    cacheSet(cacheKey, [...jobs], Date.now()); // own copy — callers can't mutate the cache
    return jobs;
  } catch (err) {
    logger.warn('RA_V2_JSEARCH_FAILED', 'JSearch search failed; continuing without external jobs', {
      requestId: opts?.requestId,
      query: params.query.slice(0, 120),
      errorType: err instanceof Error ? err.name : 'UnknownError',
    });
    return null;
  } finally {
    clearTimeout(timeout);
    opts?.signal?.removeEventListener('abort', abortHandler);
  }
}

/** Test seam — resets the per-process state vitest can't otherwise reach. */
export const __test = {
  reset(): void {
    responseCache.clear();
    breakerOpenedAt = null;
  },
  state(): { breakerOpen: boolean; cacheSize: number } {
    return {
      breakerOpen: breakerOpenedAt != null,
      cacheSize: responseCache.size,
    };
  },
  pickApplyUrl,
  parseRelativePostedAt,
  mapEmployment,
  currencyForCountry,
  buildCacheKey,
};
