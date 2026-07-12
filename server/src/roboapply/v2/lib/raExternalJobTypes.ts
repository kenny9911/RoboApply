// backend/src/roboapply/v2/lib/raExternalJobTypes.ts
//
// Shared contract for the external RapidAPI job-search providers consumed by
// the onboarding recommendation round. PURE TYPES + tiny constants, zero
// provider imports — this file breaks the client↔seam import cycle so every
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
  applyUrl: string | null;
  /** True when applying goes straight to the employer/ATS (not an aggregator). */
  applyIsDirect: boolean;
  description: string;
  /** "LinkedIn", "Greenhouse", "104人力銀行", … — rendered as "via X" attribution. */
  sourcePublisher: string | null;
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
  /** Fantastic Jobs `location_filter` — free-text location (city or country name). */
  locationText?: string;
}

/**
 * The provider seam. `null` from `search()` means unavailable/failed and MUST
 * NEVER throw — callers degrade to internal-only. `isEnabled()` is a cheap
 * pre-check (key present && kill switch off && circuit breaker closed && daily
 * budget left) so the orchestrator can skip a doomed fetch.
 */
export interface JobSearchProvider {
  readonly id: ExternalSourceBoard;
  isEnabled(): boolean;
  search(
    params: ExternalSearchParams,
    opts?: { requestId?: string; signal?: AbortSignal },
  ): Promise<ExternalJobNormalized[] | null>;
}
