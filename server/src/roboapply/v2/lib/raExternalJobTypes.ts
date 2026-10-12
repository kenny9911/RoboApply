// backend/src/roboapply/v2/lib/raExternalJobTypes.ts
//
// Shared contract for the external RapidAPI job-search providers consumed by
// the onboarding recommendation round. PURE TYPES + tiny constants and pure
// helpers, zero provider imports — this file breaks the client↔seam import cycle so every
// client (JSearch, Fantastic Jobs) can carry its own `sourceBoard` on its
// output without importing the seam, and the seam can aggregate them.
//
// One RAPID_API_KEY authenticates all three services; each must be separately
// SUBSCRIBED on the RapidAPI app (AppID 8974502). The two Fantastic Jobs APIs
// (Active Jobs DB + LinkedIn Job Search) share a schema and one client.

/**
 * `RAJob.sourceBoard` values that mark an externally-sourced (RapidAPI) job.
 * `jsearch`   → JSearch (OpenWeb Ninja) Google-for-Jobs aggregator.
 * `activejobs` → Active Jobs DB (Fantastic Jobs) direct-from-employer ATS feed.
 * `linkedin`  → LinkedIn Job Search API (Fantastic Jobs).
 */
export type ExternalSourceBoard = 'jsearch' | 'activejobs' | 'linkedin';

/**
 * Every `RAJob.sourceBoard` that is an external RapidAPI provider. The consumer
 * (RAOnboardingRecommendService) uses this to generalize the behaviours that
 * were previously hard-coded to `'jsearch'`: `isExternal` classification, the
 * lazy staleness sweep, and the "non-remote workType is UNKNOWN, never onsite"
 * distrust rule (only `workType === 'remote'` is a trusted signal for any
 * external board — their payloads carry no reliable hybrid/onsite signal).
 */
export const EXTERNAL_SOURCE_BOARDS: readonly ExternalSourceBoard[] = [
  'jsearch',
  'activejobs',
  'linkedin',
];

/** O(1) membership test over EXTERNAL_SOURCE_BOARDS (accepts any string). */
export const EXTERNAL_SOURCE_BOARD_SET: ReadonlySet<string> = new Set(EXTERNAL_SOURCE_BOARDS);

/** True when a RAJob row was materialized from an external RapidAPI provider. */
export function isExternalSourceBoard(board: string | null | undefined): boolean {
  return board != null && EXTERNAL_SOURCE_BOARD_SET.has(board);
}

/**
 * The taxonomy labels Fantastic Jobs assigns to a posting (`ai_taxonomies_a`,
 * up to five per row, the first the primary one) and accepts as the filter of
 * the same name. EXACTLY the 33 values the vendor documents: the enum of the
 * `ai_taxonomies_a` parameter in its OpenAPI document
 * (https://data.fantastic.jobs/openapi, "Fantastic.jobs API (v1)"), read
 * 2026-10-12. Never typed from memory; a label that is not here is not sent
 * as a filter and maps to nothing.
 */
export const FANTASTIC_TAXONOMY_LABELS = [
  'Technology',
  'Healthcare',
  'Management & Leadership',
  'Finance & Accounting',
  'Human Resources',
  'Sales',
  'Marketing',
  'Customer Service & Support',
  'Education',
  'Legal',
  'Engineering',
  'Science & Research',
  'Trades',
  'Construction',
  'Manufacturing',
  'Logistics',
  'Creative & Media',
  'Hospitality',
  'Environmental & Sustainability',
  'Retail',
  'Data & Analytics',
  'Software',
  'Energy',
  'Agriculture',
  'Social Services',
  'Administrative',
  'Government & Public Sector',
  'Art & Design',
  'Food & Beverage',
  'Transportation',
  'Consulting',
  'Sports & Recreation',
  'Security & Safety',
] as const;
export type FantasticTaxonomyLabel = (typeof FANTASTIC_TAXONOMY_LABELS)[number];

/**
 * Normalized external job — the common shape every provider client maps its
 * raw payload onto. Downstream (the blend/prefilter/upsert in
 * RAOnboardingRecommendService) maps this onto RAJob.
 *
 * Work-type semantics: `workType` is `'remote'` ONLY when the provider clearly
 * marks the posting remote; everything else is `'unknown'` (NEVER `'onsite'`).
 * The onboarding prefilter null-passes unknown work modes so TW/hybrid rows are
 * not silently dropped.
 */
export interface ExternalJobNormalized {
  /** `${sourceBoard}:${apiJobId}` — globally unique across providers. */
  externalId: string;
  /** Which RapidAPI provider produced this row → written to RAJob.sourceBoard. */
  sourceBoard: ExternalSourceBoard;
  title: string;
  company: string;
  companyLogoUrl: string | null;
  location: string | null;
  locationCity: string | null;
  locationCountry: string | null;
  /** `'remote'` only when the provider clearly says remote; else `'unknown'`. */
  workType: 'remote' | 'unknown';
  /** `'full_time' | 'contract' | 'part_time' | 'internship'`; null = unknown (null-pass). */
  employmentType: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  /** ISO currency; null when the posting states no salary or the market is unknown. */
  salaryCurrency: string | null;
  /** `'year' | 'month' | 'hour'` lowercased; null = unknown. */
  salaryPeriod: string | null;
  /** ISO datetime. Every client's fallback chain ends at fetch time, so never null. */
  postedAt: string;
  /** Distinguishes legacy fetch-time fallbacks from actual source publication dates. */
  postedAtEstimated?: boolean;
  /** Original fetch time, retained when a provider response is served from cache. */
  fetchedAt?: string;
  /** Existing onboarding inference is not exposed as source evidence by the public API. */
  salaryCurrencyInferred?: boolean;
  locationCountryEstimated?: boolean;
  applyUrl: string | null;
  /** Original publisher posting, retained when application prefers an employer link. */
  sourceUrl?: string | null;
  /** True when applying goes straight to the employer/ATS (not an aggregator). */
  applyIsDirect: boolean;
  description: string;
  /** "LinkedIn", "Greenhouse", "104人力銀行", … — rendered as "via X" attribution. */
  sourcePublisher: string | null;

  // ── Provider-stated extras (WP-16b ingest; optional, additive) ──────────
  // Consumers that predate the inventory pipeline ignore them. Each is copied
  // only when the provider states it; nothing is inferred here (D3). The
  // ingest normalizer (features/jobs/normalize) maps them first so the
  // enrichment LLM can be skipped for fields the provider already covers.
  /** The provider's own work-arrangement label ('Hybrid', 'On-site', 'Remote OK'). Never guessed. */
  workModel?: string | null;
  /** Provider experience band ('0-2', '2-5', '5-10', '10+'). */
  experienceLevel?: string | null;
  /** Required experience in months (JSearch). */
  experienceMonths?: number | null;
  /** Provider-extracted skills, as given. */
  skills?: string[] | null;
  /** Provider expiry (schema.org validThrough / JSearch offer expiration), ISO. */
  expiresAt?: string | null;
  /** The employer's website as the provider states it. */
  companyWebsite?: string | null;
  /**
   * The provider's own reading that the posting offers visa sponsorship
   * (Active Jobs DB `ai_visa_sponsorship: true`). A reading, never a fact: the
   * ingest upsert stores it as "the provider's reading" and never over a
   * posting quote (MARKET_STRATEGY §1.5 "Provider fields first"). Absent or
   * null: the provider states none. The provider's `false` only says that the
   * description does not mention sponsorship, so it is never copied as
   * 'not_offered'.
   */
  sponsorshipProvider?: 'offered' | 'not_offered' | null;
}

/**
 * Provider-agnostic search intent. Each client maps these onto its own wire
 * params. The JSearch fields (`query`/`country`/`language`/…) drive the
 * Google-for-Jobs aggregator; the Fantastic Jobs client prefers the structured
 * `titleQuery`/`locationText` (its API wants a title filter + location filter,
 * not one free-text "role in place" string), falling back to `query`/`country`.
 */
export interface ExternalSearchParams {
  /** JSearch free-text query, e.g. "資深後端工程師 台北" (market language). */
  query: string;
  /** ISO-3166 alpha-2, lowercase (JSearch `country`, market default). */
  country: string;
  language?: string;
  datePosted?: 'all' | 'today' | '3days' | 'week' | 'month';
  workFromHome?: boolean;
  /** Comma-separated JSearch enums, e.g. 'FULLTIME,CONTRACTOR'. */
  employmentTypes?: string;
  /** Pages per billed JSearch call (extra pages are free). Default 2 → 20 jobs. */
  numPages?: number;
  /** Fantastic Jobs `title_filter` — the role/title text (English). Falls back to `query`. */
  titleQuery?: string;
  /**
   * Other names of the same role (a taxonomy role's synonyms; never text a
   * user typed). Active Jobs DB asks for the title and at most two of them as
   * quoted phrases joined by OR. Ignored by JSearch.
   */
  titleSynonyms?: string[];
  /** Fantastic Jobs `location_filter` — free-text location (city or country name). */
  locationText?: string;
}

/**
 * The provider seam. `null` from `search()` means unavailable/failed and MUST
 * NEVER throw — callers degrade to internal-only. `isEnabled()` is a cheap
 * pre-check (key present && kill switch off && circuit breaker closed && the
 * call gate open) so the orchestrator can skip a doomed fetch.
 */
export interface JobSearchProvider {
  readonly id: ExternalSourceBoard;
  isEnabled(): boolean;
  search(params: ExternalSearchParams, opts?: ProviderSearchOptions): Promise<ExternalJobNormalized[] | null>;
}

/** Options of one `search()` call. */
export interface ProviderSearchOptions {
  requestId?: string;
  signal?: AbortSignal;
  /**
   * True when the inventory pipeline makes the call: ingest has already
   * counted it in today's RAProviderUsage row, so the call gate must not count
   * it a second time. Every other caller (a person's own search) leaves it
   * unset and the gate counts the call.
   */
  reservedByIngest?: boolean;
}

// ── Monthly quota and the call gate (MARKET_STRATEGY §1.2, JI-1) ────────────
// A RapidAPI plan is a MONTHLY quota shared by every caller of a provider.
// The clients state what each upstream response said about it (listener) and
// ask before each upstream call (gate). Both are registered by the inventory
// pipeline (features/jobs/ingest/quota.ts); with nothing registered a client
// behaves as if the quota were unknown and every call allowed. The clients
// keep no counter of their own.

/** Who makes a provider call: the inventory pipeline, or a person's own search. */
export type ProviderCallPurpose = 'ingest' | 'interactive';

/**
 * Asked before every upstream call (never for a cache hit): false refuses the
 * call. With `probe: true` it only answers whether a call would be allowed
 * right now and counts nothing (`isEnabled()` asks this way).
 */
export type ProviderCallGate = (provider: ExternalSourceBoard, purpose: ProviderCallPurpose, opts?: { probe?: boolean }) => boolean;

/** What one upstream response said about the plan's quota. A value the response did not state is null. */
export interface ProviderQuotaObservation {
  provider: ExternalSourceBoard;
  /** HTTP status of the response. */
  status: number;
  /** `x-ratelimit-requests-limit` / `-remaining` (the direct API: `x-api-requests-*`). */
  requestsLimit: number | null;
  requestsRemaining: number | null;
  /** `x-ratelimit-requests-reset`: seconds until the quota resets (the direct API: the time to `x-api-next-billing-date`). */
  resetSeconds: number | null;
  /** `x-ratelimit-jobs-limit` / `-remaining` (plans that count postings; the direct API: `x-api-jobs-*`). */
  jobsLimit: number | null;
  jobsRemaining: number | null;
  /** The plan's name as a 429 body states it ("… on your current plan, BASIC"). */
  plan: string | null;
  /** What a refusal's body says: the period's quota is used up, or the key has no subscription to this API. */
  reason: 'monthly_quota' | 'not_subscribed' | null;
  /** When the response arrived. */
  at: Date;
}

/**
 * Called once per upstream response (never for a cache hit). The API key is
 * never part of it. The listener may answer with a promise when the reading
 * must be stored before the caller's work ends (it closed or reopened the
 * provider for every process): a client serving a person's own search waits
 * for it, at most QUOTA_LISTENER_WAIT_MS (`settleQuotaListener`). An ingest
 * call does not wait: the tick awaits its writes itself.
 */
export type ProviderQuotaListener = (observation: ProviderQuotaObservation) => unknown;

/** The longest a person's search waits for the listener to store a reading. */
export const QUOTA_LISTENER_WAIT_MS = 500;

/**
 * Waits for what a quota listener answered, when it is a promise, at most
 * `maxMs`; a listener that answered nothing is not waited for (no timer is
 * set). Never throws.
 */
export function settleQuotaListener(answer: unknown, maxMs: number = QUOTA_LISTENER_WAIT_MS): Promise<void> | undefined {
  if (!answer || typeof (answer as PromiseLike<unknown>).then !== 'function') return undefined;
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, maxMs));
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    try {
      (answer as PromiseLike<unknown>).then(done, done);
    } catch {
      done();
    }
  });
}

/** A stated count from a response header: a finite number that is not negative, else null. */
function headerCount(headers: { get(name: string): string | null }, name: string): number | null {
  const raw = headers.get(name);
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** The first of these headers that states a count. */
function firstHeaderCount(headers: { get(name: string): string | null }, names: readonly string[]): number | null {
  for (const name of names) {
    const n = headerCount(headers, name);
    if (n !== null) return n;
  }
  return null;
}

/**
 * The two header families a plan's quota is stated in:
 *   RapidAPI marketplace   `x-ratelimit-requests-limit` / `-remaining` / `-reset` (seconds),
 *                          `x-ratelimit-jobs-limit` / `-remaining`;
 *   Fantastic.jobs direct  `x-api-requests-limit` / `-remaining`, `x-api-jobs-limit` /
 *                          `-remaining`, `x-api-next-billing-date` (ISO 8601, UTC): vendor
 *                          documentation "Plans, Limits & Upgrades", read 2026-10-12.
 * A response carries one family; the marketplace's is read first.
 */
const QUOTA_HEADERS = {
  requestsLimit: ['x-ratelimit-requests-limit', 'x-api-requests-limit'],
  requestsRemaining: ['x-ratelimit-requests-remaining', 'x-api-requests-remaining'],
  jobsLimit: ['x-ratelimit-jobs-limit', 'x-api-jobs-limit'],
  jobsRemaining: ['x-ratelimit-jobs-remaining', 'x-api-jobs-remaining'],
} as const;

/** Seconds until the quota resets: the marketplace's own header, else the time to the direct API's next billing date. */
function resetSecondsFrom(headers: { get(name: string): string | null }, at: Date): number | null {
  const seconds = headerCount(headers, 'x-ratelimit-requests-reset');
  if (seconds !== null) return seconds;
  const raw = headers.get('x-api-next-billing-date');
  const next = raw ? Date.parse(raw) : Number.NaN;
  const now = at.getTime();
  if (!Number.isFinite(next) || !Number.isFinite(now)) return null;
  return Math.max(0, Math.round((next - now) / 1000));
}

/** Requests the plan has left, as either header family states it (null: not stated). */
export function requestsRemainingFrom(headers: { get(name: string): string | null }): number | null {
  return firstHeaderCount(headers, QUOTA_HEADERS.requestsRemaining);
}

/** The plan name in a quota refusal: the token after "current plan," ("… on your current plan, BASIC. Upgrade …"), or null. */
export function planFromQuotaBody(bodyText: string): string | null {
  const m = /current plan,\s*([A-Za-z0-9][A-Za-z0-9_-]{0,39})/i.exec(bodyText);
  return m?.[1]?.trim() || null;
}

/**
 * One response as a quota observation (pure: headers, status and the refusal
 * text only). `bodyText` is the body of a 429 / 403 / 401 and '' otherwise.
 */
export function quotaObservationFrom(
  provider: ExternalSourceBoard,
  response: { status: number; headers: { get(name: string): string | null } },
  bodyText: string,
  at: Date,
): ProviderQuotaObservation {
  const requestsRemaining = requestsRemainingFrom(response.headers);
  const monthly = response.status === 429 && (/monthly|quota/i.test(bodyText) || requestsRemaining === 0);
  const reason = monthly ? 'monthly_quota' : response.status === 403 && /not subscribed/i.test(bodyText) ? 'not_subscribed' : null;
  return {
    provider,
    status: response.status,
    requestsLimit: firstHeaderCount(response.headers, QUOTA_HEADERS.requestsLimit),
    requestsRemaining,
    resetSeconds: resetSecondsFrom(response.headers, at),
    jobsLimit: firstHeaderCount(response.headers, QUOTA_HEADERS.jobsLimit),
    jobsRemaining: firstHeaderCount(response.headers, QUOTA_HEADERS.jobsRemaining),
    plan: response.status === 429 ? planFromQuotaBody(bodyText) : null,
    reason,
    at,
  };
}
