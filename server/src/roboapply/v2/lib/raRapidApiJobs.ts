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
//   - per-process daily billed-call budget (RA_ONBOARDING_JSEARCH_DAILY_BUDGET,
//     default 300), reset on UTC date change
//   - circuit breaker: 403 not-subscribed / 401 bad-key / monthly 429 open it
//     for a 1h cooldown; per-second burst 429 gets exactly one jittered retry
//   - kill switch: RA_ONBOARDING_EXTERNAL_JOBS_DISABLED=true ⇒ always null
//
// The RAPID_API_KEY value is never logged and never echoed anywhere.

import { logger } from '../../../services/LoggerService.js';

const BASE_URL = 'https://jsearch.p.rapidapi.com';
const RAPIDAPI_HOST = 'jsearch.p.rapidapi.com';
const REQUEST_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;
const BREAKER_COOLDOWN_MS = 60 * 60 * 1000;
const DEFAULT_DAILY_BUDGET = 300;

/**
 * Normalized external job. Self-contained type — downstream code (the blend /
 * prefilter in RAOnboardingRecommendService) maps this onto RAJob.
 *
 * Work-type / employment-type semantics (critic findings E7 + R4): the JSearch
 * /search payload carries NO hybrid/onsite signal — only `job_is_remote` is
 * trustworthy, and ONLY when it is `true`. Non-remote and null values are
 * UNKNOWN, never "onsite": downstream hard filters must null-pass these
 * instead of dropping every TW/hybrid row.
 */
export interface ExternalJobNormalized {
  externalId: string; // `jsearch:${job_id}`
  title: string;
  company: string;
  companyLogoUrl: string | null;
  location: string | null;
  locationCity: string | null;
  locationCountry: string | null;
  /** 'remote' only when job_is_remote === true; everything else is 'unknown'. */
  workType: 'remote' | 'unknown';
  /** 'full_time' | 'contract' | 'part_time' | 'internship'; null = unknown (null-pass). */
  employmentType: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  /** Inferred from the REQUEST country, only when a salary is present. Never USD-default. */
  salaryCurrency: string | null;
  salaryPeriod: string | null;
  /** ISO datetime. Fallback chain ends at fetch time, so never null. */
  postedAt: string;
  applyUrl: string | null;
  applyIsDirect: boolean;
  description: string;
  /** "LinkedIn", "104人力銀行", … — rendered as "via X" attribution. */
  sourcePublisher: string | null;
}

export interface JSearchSearchParams {
  query: string;
  /** ISO-3166 alpha-2, lowercase (Google for Jobs market). */
  country: string;
  language?: string;
  datePosted?: 'all' | 'today' | '3days' | 'week' | 'month';
  workFromHome?: boolean;
  /** Comma-separated JSearch enums, e.g. 'FULLTIME,CONTRACTOR'. */
  employmentTypes?: string;
  /** Extra pages are free — one billed request returns numPages×10 jobs. Default 2. */
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
  if (!key) return null;
  if (key === 'FULLTIME') return 'full_time';
  if (key === 'PARTTIME') return 'part_time';
  if (key === 'CONTRACTOR' || key === 'CONTRACT') return 'contract';
  if (key.startsWith('INTERN')) return 'internship';
  return null;
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

/** Prefer a publisher-direct apply link over the aggregator default. */
function pickApplyUrl(j: any): { url: string | null; isDirect: boolean } {
  const options = Array.isArray(j?.apply_options) ? j.apply_options : [];
  const direct = options.find((o: any) => o?.is_direct === true && typeof o?.apply_link === 'string');
  if (direct) return { url: direct.apply_link, isDirect: true };
  const fallback = typeof j?.job_apply_link === 'string' ? j.job_apply_link : null;
  return { url: fallback, isDirect: j?.job_apply_is_direct === true };
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

  return deepClean({
    externalId: `jsearch:${j.job_id}`,
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
    workType: j.job_is_remote === true ? 'remote' : 'unknown', // only true is trusted; never 'onsite'
    employmentType: mapEmployment(
      (Array.isArray(j.job_employment_types) ? j.job_employment_types[0] : undefined)
        ?? j.job_employment_type,
    ),
    salaryMin: j.job_min_salary != null ? Math.round(Number(j.job_min_salary)) : null,
    salaryMax: j.job_max_salary != null ? Math.round(Number(j.job_max_salary)) : null,
    salaryCurrency: hasSalary ? currencyForCountry(req.country) : null,
    salaryPeriod: typeof j.job_salary_period === 'string' ? j.job_salary_period.toLowerCase() : null,
    postedAt: (typeof j.job_posted_at_datetime_utc === 'string' ? j.job_posted_at_datetime_utc : null)
      ?? (typeof j.job_posted_at_timestamp === 'number'
        ? new Date(j.job_posted_at_timestamp * 1000).toISOString()
        : null)
      ?? parseRelativePostedAt(j.job_posted_at, req.fetchedAt)
      ?? req.fetchedAt.toISOString(),
    applyUrl: apply.url,
    applyIsDirect: apply.isDirect,
    description: typeof j.job_description === 'string' ? j.job_description : '',
    sourcePublisher: typeof j.job_publisher === 'string' ? j.job_publisher : null,
  });
}

// ---------------------------------------------------------------------------
// Module state: LRU response cache, circuit breaker, daily budget counter.
// Per-process by design — acceptable at single-instance Render scale because
// the per-session JSearch cap is DB-persisted on RAOnboardingSession.
// ---------------------------------------------------------------------------

const responseCache = new Map<string, { at: number; jobs: ExternalJobNormalized[] }>();

let breakerOpenedAt: number | null = null;

let dailyState = { day: '', used: 0, warned: false };

function buildCacheKey(p: JSearchSearchParams): string {
  return [
    p.query.trim().toLowerCase(),
    p.country.trim().toLowerCase(),
    p.datePosted ?? 'all',
    p.workFromHome === true ? 'wfh' : 'any',
    p.employmentTypes ?? '',
    p.page ?? 1,
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

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function dailyBudget(): number {
  const raw = Number(process.env.RA_ONBOARDING_JSEARCH_DAILY_BUDGET ?? '');
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_DAILY_BUDGET;
}

function rollDailyWindow(now: number): void {
  const day = utcDay(now);
  if (dailyState.day !== day) dailyState = { day, used: 0, warned: false };
}

/**
 * Whether a billed JSearch call could succeed right now: key present, kill
 * switch off, circuit breaker closed, daily budget left. The provider seam
 * (raJobProviders.ts) exposes this so the orchestrator can plan an
 * internal-only round without burning a turn on a doomed fetch.
 */
export function isJSearchEnabled(): boolean {
  if (process.env.RA_ONBOARDING_EXTERNAL_JOBS_DISABLED === 'true') return false;
  if (!process.env.RAPID_API_KEY?.trim()) return false;
  const now = Date.now();
  if (breakerIsOpen(now)) return false;
  rollDailyWindow(now);
  return dailyState.used < dailyBudget();
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
 * unconfigured, budget-exhausted, breaker-open, or failed — callers treat
 * `null` as "external jobs unavailable" and degrade to internal-only.
 */
export async function searchJSearchJobs(
  params: JSearchSearchParams,
  opts?: { requestId?: string; signal?: AbortSignal },
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

  rollDailyWindow(now);
  if (dailyState.used >= dailyBudget()) {
    if (!dailyState.warned) {
      dailyState.warned = true;
      logger.warn('RA_V2_JSEARCH_DAILY_BUDGET_EXHAUSTED', 'JSearch daily budget exhausted; external jobs paused until UTC midnight', {
        used: dailyState.used,
        budget: dailyBudget(),
        requestId: opts?.requestId,
      });
    }
    return null;
  }
  dailyState.used += 1; // count the billed attempt up front — a burst retry rides the same ticket

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
  const url = `${BASE_URL}/search?${search.toString()}`;

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
      if (isMonthlyQuota429(bodyText, response)) {
        openBreaker('429_monthly', 429, opts?.requestId);
        return null;
      }
      // Per-second burst — exactly one jittered retry.
      await jitteredDelay(300 + Math.random() * 500, controller.signal);
      response = await fetch(url, { method: 'GET', headers, signal: controller.signal });
      if (response.status === 429) {
        const retryText = await response.text().catch(() => '');
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
      openBreaker(response.status === 403 ? '403_not_subscribed' : '401', response.status, opts?.requestId);
      return null;
    }

    const rlLimit = headerNum(response, 'x-ratelimit-requests-limit');
    const rlRemaining = headerNum(response, 'x-ratelimit-requests-remaining');
    const rlResetSec = headerNum(response, 'x-ratelimit-requests-reset');

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      logger.warn('RA_V2_JSEARCH_HTTP_ERROR', `JSearch HTTP ${response.status}`, {
        requestId: opts?.requestId,
        httpStatus: response.status,
        query: params.query.slice(0, 120),
        error: errText.slice(0, 200),
      });
      return null;
    }

    const body = (await response.json().catch(() => null)) as
      | { status?: string; data?: unknown[] }
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

    const fetchedAt = new Date();
    const jobs = (Array.isArray(body.data) ? body.data : [])
      .map((j) => normalizeJSearchJob(j, { country: params.country, fetchedAt }))
      .filter((j): j is ExternalJobNormalized => j !== null);

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
      error: err instanceof Error ? err.message : String(err),
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
    dailyState = { day: '', used: 0, warned: false };
  },
  state(): { breakerOpen: boolean; dailyUsed: number; cacheSize: number } {
    return {
      breakerOpen: breakerOpenedAt != null,
      dailyUsed: dailyState.used,
      cacheSize: responseCache.size,
    };
  },
  parseRelativePostedAt,
  mapEmployment,
  currencyForCountry,
  buildCacheKey,
};
