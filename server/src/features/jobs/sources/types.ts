// server/src/features/jobs/sources/types.ts — the job-source adapter interface (WP-16b).
//
// Every inventory source plugs into ingest through one shape:
//   - 'search' adapters run one planned query (RAIngestQuery) against a paid
//     or public API (Active Jobs DB, LinkedIn Job Search API, JSearch, and
//     WP-42's public ATS boards as `ats_public`);
//   - 'cursor' adapters sync a recruiter bank (RoboHire / GoHire) from a
//     cursor kept in `RAIngestQuery.params.cursor`.
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
}

/** RAJob.closeReason values a source's own closure may write. */
export type SourceCloseReason = 'bank_closed' | 'source_removed';

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
  /** Never throws: failures come back as `{ jobs: [], calls, error }`. */
  fetch(query: SourceQuery, ctx: SourceFetchContext): Promise<SourceFetchResult>;
}
