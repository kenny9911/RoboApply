// backend/src/roboapply/v2/lib/raFantasticJobs.ts
//
// Fantastic Jobs job-search client — ONE parameterized implementation for the
// two sibling RapidAPI APIs by the same provider, which share a schema:
//   • Active Jobs DB      (active-jobs-db.p.rapidapi.com)          → sourceBoard 'activejobs'
//   • LinkedIn Job Search (linkedin-job-search-api.p.rapidapi.com) → sourceBoard 'linkedin'
//
// Mirrors the raRapidApiJobs.ts (JSearch) discipline exactly:
//   - self-contained V2-local client (the boundary script forbids importing
//     recruiter `services/*`);
//   - RAPID_API_KEY read per call, never cached, never logged;
//   - hard "NEVER throws to callers" contract — every failure path returns
//     `null` + a logger.warn so the recommendation round degrades to
//     internal-only silently;
//   - per-provider cost control: in-process LRU cache (6h), circuit breaker
//     (403/401/monthly-429 → 1h cooldown; burst-429 → one jittered retry), and
//     a per-process daily billed-call budget; global + per-provider kill switch.
//
// Response shape (verified against Fantastic Jobs docs + prospectio-api-mcp):
// the body is a BARE JSON ARRAY of job objects (NO envelope). A 403/429 comes
// back as `{message:"..."}` with a non-200 status, so we type-guard for an
// array before mapping.
//
// Field-spelling caveat: the raw RapidAPI field names differ from the Apify /
// Context7 mirror (e.g. `directapply`/`description_text`/`ai_salary_minvalue`,
// NOT `direct_apply`/`job_description`/`ai_salary_min_value`). The CORE fields
// mapped below are stable across sources; the `ai_*` fallbacks are secondary
// (a wrong spelling there just yields null, never a crash). Smoke-test one live
// call per host after subscribing to lock the `ai_*` spellings.

import { logger } from '../../../services/LoggerService.js';
import type {
  ExternalJobNormalized,
  ExternalSearchParams,
  ExternalSourceBoard,
  JobSearchProvider,
} from './raExternalJobTypes.js';

const REQUEST_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;
const BREAKER_COOLDOWN_MS = 60 * 60 * 1000;
const DEFAULT_DAILY_BUDGET = 300;
const RESULT_LIMIT = 20; // jobs per billed call (Fantastic Jobs bills per row returned)

// ─── Provider configs ──────────────────────────────────────────────────────

interface FantasticConfig {
  /** sourceBoard + externalId prefix. */
  readonly board: Extract<ExternalSourceBoard, 'activejobs' | 'linkedin'>;
  readonly host: string;
  /** Path prefix; the freshness window (`24h`/`7d`) is appended per env. */
  readonly pathPrefix: string;
  /** Per-provider kill-switch + daily-budget env var names. */
  readonly disableEnv: string;
  readonly budgetEnv: string;
}

const ACTIVE_JOBS_CONFIG: FantasticConfig = {
  board: 'activejobs',
  host: 'active-jobs-db.p.rapidapi.com',
  pathPrefix: '/active-ats-',
  disableEnv: 'RA_ONBOARDING_ACTIVEJOBS_DISABLED',
  budgetEnv: 'RA_ONBOARDING_ACTIVEJOBS_DAILY_BUDGET',
};

const LINKEDIN_CONFIG: FantasticConfig = {
  board: 'linkedin',
  host: 'linkedin-job-search-api.p.rapidapi.com',
  pathPrefix: '/active-jb-',
  disableEnv: 'RA_ONBOARDING_LINKEDIN_JOBS_DISABLED',
  budgetEnv: 'RA_ONBOARDING_LINKEDIN_JOBS_DAILY_BUDGET',
};

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
  WEEK: null,
  DAY: null,
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

  const sr = j.salary_raw ?? {};
  const bareVal = typeof sr.value === 'number' ? sr.value : undefined;
  const unit = String(sr?.value?.unitText ?? sr?.unitText ?? j.ai_salary_unittext ?? '').toUpperCase();
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

  const salaryMin = toFiniteNumber(sr?.value?.minValue ?? sr?.minValue ?? bareVal ?? j.ai_salary_minvalue);
  const salaryMax = toFiniteNumber(sr?.value?.maxValue ?? sr?.maxValue ?? bareVal ?? j.ai_salary_maxvalue);
  const hasSalary = salaryMin != null || salaryMax != null;

  // addressCountry is usually an ISO alpha-2 string ("US") but schema.org also
  // allows a Country object ({ "@type":"Country", name:"United States" }). A raw
  // truthy object would short-circuit the ?? chain and then fail the string
  // guard below → null, discarding the countries_derived fallback. Narrow first.
  const rawCountry = j.locations_raw?.[0]?.address?.addressCountry;
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
    applyUrl,
    // Active Jobs DB `url` is the employer/ATS posting (source_type 'ats') → direct.
    // LinkedIn `url` is a linkedin.com/jobs/view page (source_type 'jobboard') → not direct.
    applyIsDirect: j.source_type === 'ats',
    description: descriptionRaw,
    sourcePublisher: prettifySource(j.source) ?? hostOf(j.source_domain),
  });
}

// ─── Per-provider guard: LRU cache, circuit breaker, daily budget ──────────
// One instance per config (activejobs / linkedin) so their budgets + breakers
// are fully independent.

class ProviderState {
  private cache = new Map<string, { at: number; jobs: ExternalJobNormalized[] }>();
  private breakerOpenedAt: number | null = null;
  private daily = { day: '', used: 0, warned: false };

  constructor(private readonly cfg: FantasticConfig) {}

  private budget(): number {
    const raw = Number(process.env[this.cfg.budgetEnv] ?? '');
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_DAILY_BUDGET;
  }

  private rollDay(now: number): void {
    const day = new Date(now).toISOString().slice(0, 10);
    if (this.daily.day !== day) this.daily = { day, used: 0, warned: false };
  }

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

  /** Key present && kill switches off && breaker closed && daily budget left. */
  isEnabled(): boolean {
    if (process.env.RA_ONBOARDING_EXTERNAL_JOBS_DISABLED === 'true') return false;
    if (process.env[this.cfg.disableEnv] === 'true') return false;
    if (!process.env.RAPID_API_KEY?.trim()) return false;
    const now = Date.now();
    if (this.breakerIsOpen(now)) return false;
    this.rollDay(now);
    return this.daily.used < this.budget();
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

  /** Whether a billed call may proceed now; increments the daily counter. */
  claimDailyTicket(now: number): boolean {
    this.rollDay(now);
    if (this.daily.used >= this.budget()) {
      if (!this.daily.warned) {
        this.daily.warned = true;
        logger.warn('RA_V2_FANTASTIC_DAILY_BUDGET_EXHAUSTED', 'Fantastic Jobs daily budget exhausted', {
          board: this.cfg.board,
          used: this.daily.used,
          budget: this.budget(),
        });
      }
      return false;
    }
    this.daily.used += 1;
    return true;
  }

  reset(): void {
    this.cache.clear();
    this.breakerOpenedAt = null;
    this.daily = { day: '', used: 0, warned: false };
  }

  snapshot() {
    return {
      breakerOpen: this.breakerOpenedAt != null,
      dailyUsed: this.daily.used,
      cacheSize: this.cache.size,
    };
  }
}

const STATE: Record<FantasticConfig['board'], ProviderState> = {
  activejobs: new ProviderState(ACTIVE_JOBS_CONFIG),
  linkedin: new ProviderState(LINKEDIN_CONFIG),
};

const CONFIG: Record<FantasticConfig['board'], FantasticConfig> = {
  activejobs: ACTIVE_JOBS_CONFIG,
  linkedin: LINKEDIN_CONFIG,
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

// ─── Request building ──────────────────────────────────────────────────────

// Fantastic Jobs `title_filter` ANDs every space-separated token against the job
// TITLE. The planner's role text is tuned for OR-overlap (2-6 tokens incl.
// seniority modifiers), so passing it verbatim would AND e.g. "senior backend
// software engineer" → near-zero hits. Reduce to the distinctive role noun(s):
// drop seniority/level/stopword modifiers and cap the AND-width so recall stays
// sane. The role noun tends to sit at the END of an English title, so keep the tail.
const TITLE_STOPWORDS = new Set([
  'senior', 'junior', 'sr', 'jr', 'lead', 'staff', 'principal', 'entry', 'mid',
  'level', 'i', 'ii', 'iii', 'iv', 'the', 'a', 'an', 'of', 'and', 'for', 'to', 'in',
]);
const TITLE_MAX_TOKENS = 3;

function titleFilterFrom(raw: string): string {
  const tokens = raw
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9+#.]/g, ''))
    .filter(Boolean);
  if (tokens.length === 0) return '';
  const meaningful = tokens.filter((t) => !TITLE_STOPWORDS.has(t));
  const chosen = (meaningful.length > 0 ? meaningful : tokens).slice(-TITLE_MAX_TOKENS);
  return chosen.join(' ');
}

function buildQuery(params: ExternalSearchParams): URLSearchParams {
  const q = new URLSearchParams();
  const title = titleFilterFrom((params.titleQuery ?? params.query ?? '').trim());
  if (title) q.set('title_filter', title);
  const location = (params.locationText ?? '').trim() || countryName(params.country) || '';
  if (location) q.set('location_filter', location);
  q.set('description_type', 'text'); // required or no description field is returned
  q.set('limit', String(RESULT_LIMIT));
  if (params.workFromHome === true) q.set('remote', 'true');
  return q;
}

function cacheKeyFor(board: FantasticConfig['board'], q: URLSearchParams): string {
  return [board, windowSuffix(), q.get('title_filter') ?? '', q.get('location_filter') ?? '', q.get('remote') ?? '']
    .join('|')
    .toLowerCase();
}

// ─── Search ────────────────────────────────────────────────────────────────

/**
 * Run one Fantastic Jobs search for `board`. Returns `null` (NEVER throws) when
 * disabled, unconfigured, budget-exhausted, breaker-open, or failed.
 */
export async function searchFantasticJobs(
  board: FantasticConfig['board'],
  params: ExternalSearchParams,
  opts?: { requestId?: string; signal?: AbortSignal },
): Promise<ExternalJobNormalized[] | null> {
  const cfg = CONFIG[board];
  const state = STATE[board];
  if (process.env.RA_ONBOARDING_EXTERNAL_JOBS_DISABLED === 'true') return null;
  if (process.env[cfg.disableEnv] === 'true') return null;
  const apiKey = process.env.RAPID_API_KEY?.trim(); // read per call — never cached, never logged
  if (!apiKey) return null;
  const title = (params.titleQuery ?? params.query ?? '').trim();
  if (!title) return null; // no title filter ⇒ the whole window; refuse (too broad + costly)
  if (opts?.signal?.aborted) return null;

  const now = Date.now();
  if (state.breakerIsOpen(now)) return null;

  const q = buildQuery(params);
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

  if (!state.claimDailyTicket(now)) return null;

  const url = `https://${cfg.host}${cfg.pathPrefix}${windowSuffix()}?${q.toString()}`;
  const headers = { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': cfg.host };

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
        state.openBreaker('429_monthly', 429, opts?.requestId);
        return null;
      }
      await jitteredDelay(300 + Math.random() * 500, controller.signal);
      response = await fetch(url, { method: 'GET', headers, signal: controller.signal });
      if (response.status === 429) {
        const retryText = await response.text().catch(() => '');
        if (isMonthlyQuota429(retryText, response)) {
          state.openBreaker('429_monthly', 429, opts?.requestId);
        } else {
          logger.warn('RA_V2_FANTASTIC_RATE_LIMITED', 'Fantastic Jobs burst rate limit persisted', {
            requestId: opts?.requestId,
            board,
          });
        }
        return null;
      }
    }

    if (response.status === 403 || response.status === 401) {
      // 403 also covers "endpoint not on plan" for a gated window (e.g. 7d).
      state.openBreaker(response.status === 403 ? '403_not_subscribed' : '401', response.status, opts?.requestId);
      return null;
    }

    const rlLimit = headerNum(response, 'x-ratelimit-requests-limit');
    const rlRemaining = headerNum(response, 'x-ratelimit-requests-remaining');

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      logger.warn('RA_V2_FANTASTIC_HTTP_ERROR', `Fantastic Jobs HTTP ${response.status}`, {
        requestId: opts?.requestId,
        board,
        httpStatus: response.status,
        title: title.slice(0, 120),
        error: errText.slice(0, 200),
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

    logger.info('RA_V2_FANTASTIC_CALL', 'Fantastic Jobs search completed', {
      requestId: opts?.requestId,
      board,
      window: windowSuffix(),
      title: title.slice(0, 120),
      location: q.get('location_filter') ?? '',
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
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    clearTimeout(timeout);
    opts?.signal?.removeEventListener('abort', abortHandler);
  }
}

export function isFantasticJobsEnabled(board: FantasticConfig['board']): boolean {
  return STATE[board].isEnabled();
}

// ─── Providers ─────────────────────────────────────────────────────────────

export const activeJobsDbProvider: JobSearchProvider = {
  id: 'activejobs',
  isEnabled: () => isFantasticJobsEnabled('activejobs'),
  search: (params, opts) => searchFantasticJobs('activejobs', params, opts),
};

export const linkedInJobsProvider: JobSearchProvider = {
  id: 'linkedin',
  isEnabled: () => isFantasticJobsEnabled('linkedin'),
  search: (params, opts) => searchFantasticJobs('linkedin', params, opts),
};

// ─── Test seam ─────────────────────────────────────────────────────────────

export const __test = {
  reset(): void {
    STATE.activejobs.reset();
    STATE.linkedin.reset();
  },
  state(board: FantasticConfig['board']) {
    return STATE[board].snapshot();
  },
  normalizeFantasticJob,
  toIsoUtc,
  countryName,
  buildQuery,
  titleFilterFrom,
  windowSuffix,
};
