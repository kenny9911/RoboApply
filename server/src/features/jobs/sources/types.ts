// server/src/features/jobs/sources/types.ts — the job-source adapter interface (WP-16b).
//
// Every inventory source plugs into ingest through one shape:
//   - 'search' adapters run one planned query (RAIngestQuery) against a paid
//     API (Active Jobs DB, JSearch);
//   - 'cursor' adapters sync a recruiter bank (RoboHire / GoHire) or the
//     public employer boards (`ats_public`) from a cursor kept in
//     `RAIngestQuery.params.cursor`.
// An adapter only FETCHES. It never writes: normalize → upsert → dedupe →
// enrich is ingest's job (features/jobs/ingest/pipeline.ts).
//
// Review rule (TASK_PLAN.md WP-16b): no adapter ever fetches HTML from a job
// board (BOSS直聘, 智联, 猎聘, 51job, 104, 1111, Cake, Yourator, LinkedIn,
// Indeed …). Only documented JSON APIs and our own bank databases.

import type { Market } from '../../../platform/brand/index.js';
import type { NormalizeProvider, ProviderJobInput } from '../normalize/index.js';
import type { QueryLanguage } from '../taxonomy/index.js';

/**
 * Every provider ingest knows: the brand registry's JobProvider plus the
 * sources that join a brand through their market (`ats_public`,
 * `tw_open_data`, `tw_gov_jobs`, `usajobs`, `activejobs_feed`).
 */
export type IngestProvider = NormalizeProvider;

/** `RAIngestQuery.origin`. */
export type IngestOrigin = 'demand' | 'seo_seed' | 'manual' | 'bank_sync';

/** `RAIngestQuery.params` (contract: `IngestQueryParamsSchema` in jobs/companies/contract.ts). */
export interface IngestQueryParams {
  /**
   * Role text in the query language (English, Traditional Chinese for a
   * Taiwan variant, Simplified Chinese for a mainland query): a taxonomy role
   * label, or the title a user typed. '' for bank syncs. The script of the
   * text is the only statement of its language: the params carry no language
   * field.
   */
  q: string;
  taxonomyId?: string;
  /** ISO 3166-1 alpha-2 upper case, or '*' (bank syncs span countries). */
  country: string;
  /** City name (English, from the city table) when the query is city-scoped. */
  city?: string;
  remote?: boolean;
  /**
   * 'all' | 'today' | '3days' | 'week' | 'month': the window the source is
   * really asked for. Not part of a planned query's identity: the planner
   * widens or narrows it in place as the demand behind the query changes
   * (ingest/planner.ts `datePostedFor`), and stores the window the adapter
   * applies (`adapterDateWindow`), never one it would ignore: the
   * missed-refresh rule (ingest/tracking.ts) trusts this value to know which
   * postings the query could still return.
   */
  datePosted: string;
  /** Cursor adapters only: where the last sync stopped. */
  cursor?: string;
}

/** A leased query as an adapter sees it. */
export interface SourceQuery {
  id: string;
  provider: IngestProvider;
  market: Market;
  origin: IngestOrigin;
  params: IngestQueryParams;
}

export interface SourceFetchContext {
  now: Date;
  signal?: AbortSignal;
  requestId?: string;
  /**
   * Milliseconds the caller can still give this fetch (the ingest tick's
   * remaining budget, less its reserve). A source that makes several requests
   * per fetch stops within it and reports where to resume. Absent = no limit
   * from the caller (the source's own caps apply).
   */
  budgetMs?: number;
}

/**
 * RAJob.closeReason values a source's own closure may write. All three are
 * revived by the upsert when the source lists the posting again:
 *   'bank_closed'      a recruiter bank closed, unpublished or re-drafted the job;
 *   'source_removed'   a public job board stopped listing it;
 *   'no_apply_target'  the posting has no page a candidate can open (a bank
 *                      row whose bank has no candidate-facing posting page).
 */
export type SourceCloseReason = 'bank_closed' | 'source_removed' | 'no_apply_target';

/** How an adapter reaches its source (shown in the admin sources panel). */
export type SourceTransport = 'db' | 'api' | 'syndication' | 'board_api' | 'rapidapi' | 'off';

/** One group of postings a source closed, with its own reason. */
export interface SourceClosure {
  externalIds: string[];
  reason: SourceCloseReason;
}

/**
 * The source's complete listing right now. Ingest archives the open public
 * rows of the adapter's boards in the run's market whose externalId is not in
 * `externalIds` (the listing diff the employer boards use). Only a pass that
 * read the listing to its end may report one: a failed or cut-short pass
 * reports none and closes nothing.
 */
export interface SourceListing {
  externalIds: string[];
  /** Why a row missing from the listing is closed (default 'bank_closed'). */
  reason?: SourceCloseReason;
}

export interface SourceFetchResult {
  /** Postings in the normalizer's input shape. */
  jobs: ProviderJobInput[];
  /** Billed / outbound calls this fetch made (for RAProviderUsage). */
  calls: number;
  /** Cursor adapters: the next cursor (stored in params.cursor). */
  cursor?: string | null;
  /** Cursor adapters: true when the source has no more rows after `cursor` right now. */
  exhausted?: boolean;
  /**
   * Cursor adapters: postings the source closed, unpublished or turned back
   * into drafts since the last cursor. Their RAJob rows are archived with
   * `closeReason` (below).
   */
  closedExternalIds?: string[];
  /**
   * Why `closedExternalIds` were closed, stored as RAJob.closeReason:
   * 'bank_closed' (the default: a recruiter bank closed the job) or
   * 'source_removed' (a public job board stopped listing it). Both are
   * revived if the source lists the posting again.
   */
  closeReason?: SourceCloseReason;
  /** More closures, each with its own reason (a fetch may close for two reasons at once). */
  closures?: SourceClosure[];
  /** The complete listing of the source, for the listing diff (see SourceListing). */
  listing?: SourceListing | null;
  /**
   * Skip tallies of this fetch, by reason ('bank_unpublished', 'bank_no_company',
   * 'bank_test_posting', 'bank_no_public_page', 'wrong_market' …) plus
   * informational counters ('bank_synced'). Counts only: never a posting field.
   */
  notes?: Record<string, number>;
  /** Set when the source was unavailable; the query is retried later and nothing is written. */
  error?: string | null;
}

/**
 * What a call to the source costs us (MARKET_STRATEGY §1.2, JI-2):
 *   'free'         no metered plan (our own bank databases, public employer
 *                  boards, government open data);
 *   'per_job'      the plan counts the postings returned (Active Jobs DB);
 *   'per_request'  the plan counts requests (JSearch): never spent on SEO
 *                  seed queries, only on a user's own demand.
 */
export type SourceCostModel = 'free' | 'per_job' | 'per_request';

/** A language a search adapter can be asked in (the planner's query variants: taxonomy `providerQueryLabels`). */
export type SourceQueryLanguage = QueryLanguage;

export interface JobSourceAdapter {
  readonly provider: IngestProvider;
  readonly kind: 'search' | 'cursor';
  /** Markets whose ingest may use this adapter. */
  readonly markets: readonly Market[];
  /** What a call costs (see SourceCostModel). Absent: `adapterCostModel` decides by provider id. */
  readonly costModel?: SourceCostModel;
  /**
   * Search adapters: the languages a role label may be sent in. Absent:
   * `adapterQueryLanguages` decides by provider id (English only, unless the
   * provider is known to search other text). A title a user typed is sent as
   * typed to every search adapter, whatever this says.
   */
  readonly queryLanguages?: readonly SourceQueryLanguage[];
  /**
   * Search adapters: the `datePosted` values the source really applies. A
   * value outside the list is asked as the FIRST entry (the source's own
   * window). Absent: `adapterDateWindow` decides by provider id (any value is
   * honoured, unless the provider is known to ask one fixed window). A list
   * that holds '3days' must hold 'week' too: a query nobody asks for any more
   * is widened to a week in place.
   */
  readonly dateWindows?: readonly string[];
  /** RAJob.sourceBoard values this adapter writes (maintenance uses them). */
  readonly sourceBoards: readonly string[];
  /** Key present, kill switch off, guards closed (cheap; never throws). */
  isEnabled(): boolean;
  /**
   * The same question for one market, for an adapter that serves several and
   * is on for some of them only (a quota gate or a flag per market). Absent:
   * `isEnabled()` answers for every market. Read through `adapterEnabledFor`.
   */
  isEnabledFor?(market: Market): boolean;
  /** Search adapters: can this source search the country (ISO alpha-2)? */
  supportsCountry(country: string): boolean;
  /** Daily outbound-call budget (RAProviderUsage); null = not metered (our own bank DBs). */
  dailyCallLimit(): number | null;
  /** How the adapter reaches its source right now (default: by kind). */
  transport?(): SourceTransport;
  /** Why the adapter is off, as a short code ('tls_required', 'no_key', 'kill_switch' …); null when on or unknown. */
  disabledReason?(): string | null;
  /** Never throws: failures come back as `{ jobs: [], calls, error }`. */
  fetch(query: SourceQuery, ctx: SourceFetchContext): Promise<SourceFetchResult>;
}

/** Cost model by provider id, for an adapter that declares none. Every other provider is free. */
const DEFAULT_COST_MODEL: Readonly<Partial<Record<IngestProvider, SourceCostModel>>> = {
  jsearch: 'per_request',
  activejobs: 'per_job',
  activejobs_feed: 'per_job',
};

/** The adapter's cost model: its declared value, else the default for its provider id, else 'free'. */
export function adapterCostModel(adapter: Pick<JobSourceAdapter, 'provider' | 'costModel'>): SourceCostModel {
  return adapter.costModel ?? DEFAULT_COST_MODEL[adapter.provider] ?? 'free';
}

/**
 * Query languages by provider id, for an adapter that declares none. JSearch
 * reads Google's job index, which answers Traditional Chinese text for Taiwan
 * (MARKET_STRATEGY §1.3); every other provider searches English postings.
 */
const DEFAULT_QUERY_LANGUAGES: Readonly<Partial<Record<IngestProvider, readonly SourceQueryLanguage[]>>> = {
  jsearch: ['en', 'zh-TW'],
};
const ENGLISH_ONLY: readonly SourceQueryLanguage[] = ['en'];

/** The languages a role label may be sent to the adapter in: its declared list, else the default for its provider id, else English. */
export function adapterQueryLanguages(adapter: Pick<JobSourceAdapter, 'provider' | 'queryLanguages'>): readonly SourceQueryLanguage[] {
  return adapter.queryLanguages ?? DEFAULT_QUERY_LANGUAGES[adapter.provider] ?? ENGLISH_ONLY;
}

/**
 * Posting windows by provider id, for an adapter that declares none. The
 * Active Jobs DB client asks one fixed frame whatever `datePosted` says (seven
 * days by default: raFantasticJobs.ts `windowSuffix`), on the search route and
 * on the feed. Every other provider honours the value it is given.
 */
const DEFAULT_DATE_WINDOWS: Readonly<Partial<Record<IngestProvider, readonly string[]>>> = {
  activejobs: ['week'],
  activejobs_feed: ['week'],
};

/**
 * The window a query on this adapter is stored and asked with when the
 * planner wants `wanted`: `wanted` itself when the adapter applies it (or
 * states no list), else the adapter's own window (the first of its list).
 * One rule for the planner and for anything that reads a stored window.
 */
export function adapterDateWindow(adapter: Pick<JobSourceAdapter, 'provider' | 'dateWindows'>, wanted: string): string {
  const applied = adapter.dateWindows ?? DEFAULT_DATE_WINDOWS[adapter.provider];
  if (!applied || applied.length === 0 || applied.includes(wanted)) return wanted;
  return applied[0]!;
}

/**
 * Is the adapter on for this market right now? `isEnabledFor(market)` when the
 * adapter has it, else `isEnabled()`. Never throws: an adapter that throws
 * while answering is off. Whether the adapter serves the market at all is
 * `adapter.markets` (the source registry's rule), not this function's.
 */
export function adapterEnabledFor(adapter: Pick<JobSourceAdapter, 'isEnabled' | 'isEnabledFor'>, market: Market): boolean {
  try {
    return (adapter.isEnabledFor ? adapter.isEnabledFor(market) : adapter.isEnabled()) === true;
  } catch {
    return false;
  }
}
