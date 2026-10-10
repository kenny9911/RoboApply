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

/** Every provider ingest knows: the brand registry's JobProvider plus WP-42's `ats_public`. */
export type IngestProvider = NormalizeProvider;

/** `RAIngestQuery.origin`. */
export type IngestOrigin = 'demand' | 'seo_seed' | 'manual' | 'bank_sync';

/** `RAIngestQuery.params` (contract: `IngestQueryParamsSchema` in jobs/companies/contract.ts). */
export interface IngestQueryParams {
  /** Role text in English (taxonomy L3 label) — '' for bank syncs. */
  q: string;
  taxonomyId?: string;
  /** ISO 3166-1 alpha-2 upper case, or '*' (bank syncs span countries). */
  country: string;
  /** City name (English, from the city table) when the query is city-scoped. */
  city?: string;
  remote?: boolean;
  /** 'all' | 'today' | '3days' | 'week' | 'month'. */
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

export interface JobSourceAdapter {
  readonly provider: IngestProvider;
  readonly kind: 'search' | 'cursor';
  /** Markets whose ingest may use this adapter. */
  readonly markets: readonly Market[];
  /** RAJob.sourceBoard values this adapter writes (maintenance uses them). */
  readonly sourceBoards: readonly string[];
  /** Key present, kill switch off, guards closed (cheap; never throws). */
  isEnabled(): boolean;
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
