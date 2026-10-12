// server/src/job-search/index-provider.ts
//
// GoApply's job-search source: our own index of market `cn` postings (employer
// boards read through the public ATS APIs, and the GoHire bank once it has a
// candidate-facing posting page). No mainland source offers lawful keyword
// search over the market, so GoApply ingests and searches its own rows
// (GOAPPLY_PARITY_PLAN §3.9, §3.10). This provider makes no outbound call.
//
// It reads through the feed's `preview` seam with the session user (or the
// key's owner) as the reader, so the signed-in visibility rules, the
// recruitment-info mode and the user's own hidden jobs apply. The user's saved
// search filters do NOT apply: a keyword search states its own filters.
//
// One retrieval pipeline (MARKET_STRATEGY §2.3 step 8; SEARCH_RETRIEVE_MATCH
// §4.10): the request's query goes to the feed as `q` and the planner's
// relevance terms as `relevance`, so an API search and an in-app search of the
// same words run the same legs and the same fusion. Nothing here ranks: the
// rows are handed on in the order the feed returned them.
//
// Whether the terms took part in that order is the FEED's to say, per read
// (`previewOrdered` → `relevanceApplied`; see `orderedPreview`). This provider
// passes the answer on and never assumes it: a feed that does not report (its
// plain `preview`, which answers rows only) is taken as "not applied", so the
// API never names an order nobody applied (D3). The feed applies `relevance`
// only where its retrieval reads it; with a typed `q` that is the feed's rule
// to state, not this file's.
//
// Contract fields (PAR-11): `apply.url`, `apply.target`, `source.original`,
// `source.url`, `source.lastVerifiedAt`, `source.via`. Each is read with a
// safe default. A row with no apply link is dropped by `normalizeJob`, as on
// RoboApply (D1: the link opens the original posting; nothing is submitted).

import type { ExternalSearchParams } from '../roboapply/v2/lib/raExternalJobTypes.js';
import type { ProviderJob } from './normalization.js';
import type { SearchInput } from './types.js';

export const INDEX_PROVIDER_ID = 'index';

/** The part of a feed item this provider reads. Every contract field is optional. */
export interface IndexFeedItem {
  jobId: string;
  title: string;
  company: { name: string; logoUrl?: string | null };
  location?: string | null;
  workModel?: string | null;
  employmentType?: string | null;
  pay?: { min: number | null; max: number | null; currency?: string | null; period?: string | null } | null;
  postedAt?: string | null;
  postedAtEstimated?: boolean;
  lastSeenAt?: string | null;
  fromRecruiterBank?: boolean;
  source?: {
    name?: string | null;
    kind?: string | null;
    original?: string | null;
    url?: string | null;
    lastVerifiedAt?: string | null;
    via?: string | null;
  } | null;
  apply?: { url?: string | null; target?: string | null } | null;
}

/** What one read of the index asks of the feed. `relevance`: free text the list may be ordered by, never a filter (feed `FeedPreviewInput.relevance`). */
export interface IndexPreviewInput {
  q?: string;
  filters?: Record<string, unknown>;
  limit: number;
  relevance?: string;
}

/** The rows of one read, and whether `relevance` took part in their order. */
export interface OrderedPreview {
  items: IndexFeedItem[];
  relevanceApplied: boolean;
}

/**
 * The read function. It answers the rows alone (nothing is then known about
 * the order: taken as "relevance not applied") or the rows with the feed's own
 * statement about the order.
 */
export type IndexPreview = (userId: string, input: IndexPreviewInput) => Promise<IndexFeedItem[] | { items: IndexFeedItem[]; relevanceApplied?: boolean }>;

/**
 * The feed's preview seam as this provider reads it. `previewOrdered` is the
 * contract by which the feed says whether `relevance` took part in the order
 * of the rows it returned (requested of the feed's owner in the MKT-4H
 * handoff). It is optional here so the read works before and after the feed
 * offers it.
 */
export interface PreviewSeam<Reader> {
  preview(reader: Reader, input: never): Promise<unknown>;
  previewOrdered?: (reader: Reader, input: never) => Promise<{ items: unknown; relevanceApplied?: unknown }>;
}

/**
 * One read of the feed's preview seam: through `previewOrdered` when the feed
 * offers it, else through `preview`. The order is claimed only on the feed's
 * explicit `relevanceApplied: true`; a feed that says nothing did not apply it.
 */
export async function orderedPreview<Reader>(feed: PreviewSeam<Reader>, reader: Reader, input: IndexPreviewInput): Promise<OrderedPreview> {
  if (typeof feed.previewOrdered === 'function') {
    const answer = await feed.previewOrdered(reader, input as never);
    // An answer that is not rows is no rows, and says nothing about an order.
    if (!Array.isArray(answer?.items)) return { items: [], relevanceApplied: false };
    return { items: answer.items as IndexFeedItem[], relevanceApplied: answer.relevanceApplied === true };
  }
  return { items: (await feed.preview(reader, input as never)) as IndexFeedItem[], relevanceApplied: false };
}

export interface IndexProviderDeps {
  /** Default: `feedService.preview` run for GoApply. */
  preview?: IndexPreview;
  /** Default: every field of the feed's filter set. */
  filterFields?: () => Promise<readonly string[]>;
}

const POSTED_WITHIN: Record<string, number> = { today: 1, '3days': 3, week: 7, month: 30 };

const defaultPreview: IndexPreview = async (userId, input) => {
  const [{ feedService }, { runWithBrand }] = await Promise.all([
    import('../features/feed/index.js'),
    import('../lib/requestContext.js'),
  ]);
  // The index is GoApply's source: read it as GoApply whatever the caller's context.
  return runWithBrand('goapply', () => orderedPreview(feedService as PreviewSeam<string>, userId, input));
};

const defaultFilterFields = async (): Promise<readonly string[]> =>
  (await import('../features/search/contract.js')).FILTER_FIELDS;

/**
 * Filters for one keyword search. Every saved filter of the reader is cleared
 * first (the feed merges overrides over the user's saved search), then only
 * what the request states is set.
 */
export function indexFilters(input: SearchInput, fields: readonly string[]): Record<string, unknown> {
  const filters: Record<string, unknown> = Object.fromEntries(fields.map((field) => [field, undefined]));
  if (input.location) filters.locations = [{ label: input.location, radiusKm: 0 }];
  if (input.remote) filters.workModels = ['remote'];
  if (input.employmentTypes?.length) filters.jobTypes = input.employmentTypes;
  const days = input.datePosted ? POSTED_WITHIN[input.datePosted] : undefined;
  if (days) filters.postedWithinDays = days;
  return filters;
}

/** A feed item as the shared normaliser reads it; null for a private row. */
export function indexRow(item: IndexFeedItem): ProviderJob | null {
  const source = item.source ?? {};
  // The user's own imports are private to them: never a search result.
  if (source.kind === 'user_import' || source.via === 'import') return null;
  const target = item.apply?.target;
  const direct = target ? target === 'employer' : !item.fromRecruiterBank && source.kind === 'ats_public';
  const posted = item.postedAt ?? null;
  const verified = source.lastVerifiedAt ?? item.lastSeenAt ?? undefined;
  return {
    externalId: `${INDEX_PROVIDER_ID}:${item.jobId}`,
    sourceBoard: INDEX_PROVIDER_ID,
    title: item.title,
    company: item.company?.name ?? '',
    companyLogoUrl: item.company?.logoUrl ?? null,
    location: item.location ?? null,
    locationCity: null,
    // The card carries no country field. Unknown stays unknown (D3).
    locationCountry: null,
    workType: item.workModel === 'remote' ? 'remote' : 'unknown',
    employmentType: item.employmentType ?? null,
    salaryMin: item.pay?.min ?? null,
    salaryMax: item.pay?.max ?? null,
    salaryCurrency: item.pay?.currency ?? null,
    salaryPeriod: item.pay?.period ?? null,
    postedAt: posted ?? verified ?? new Date(0).toISOString(),
    postedAtEstimated: item.postedAtEstimated === true || !posted,
    fetchedAt: verified,
    applyUrl: item.apply?.url ?? null,
    sourceUrl: source.url ?? null,
    applyIsDirect: direct,
    // The card has no posting text. The apply link opens the full posting.
    description: '',
    sourcePublisher: source.original ?? source.name ?? null,
  };
}

export function createIndexProvider(deps: IndexProviderDeps = {}) {
  const preview = deps.preview ?? defaultPreview;
  const filterFields = deps.filterFields ?? defaultFilterFields;
  return {
    id: INDEX_PROVIDER_ID,
    /** Results depend on the reader (hidden jobs, mode, visibility). */
    perUser: true,
    /**
     * The feed can order the rows by closeness to `opts.relevance` (its lexical
     * and dense legs), so this source is handed the text. Whether a search WAS
     * ordered by it is answered per search, from the feed's own report.
     */
    readsRelevance: true,
    isEnabled: () => true,
    async search(
      params: ExternalSearchParams,
      opts: { requestId?: string; signal?: AbortSignal; userId?: string; input?: SearchInput; relevance?: string } = {},
    ): Promise<{ jobs: ProviderJob[]; rankedByRelevance: boolean } | null> {
      // No reader, no visibility rules: fail closed rather than read as nobody.
      if (!opts.userId) return null;
      const input: SearchInput = opts.input ?? { query: params.titleQuery ?? params.query, country: params.country };
      // The index holds postings located in mainland China only.
      if (input.country && input.country.toLowerCase() !== 'cn') return { jobs: [], rankedByRelevance: false };
      const relevance = opts.relevance?.trim();
      const answer = await preview(opts.userId, {
        q: input.query,
        filters: indexFilters(input, await filterFields()),
        limit: 50,
        ...(relevance ? { relevance } : {}),
      });
      const items = Array.isArray(answer) ? answer : answer.items;
      return {
        jobs: items.map(indexRow).filter((row): row is ProviderJob => row !== null),
        // Only what the feed said of this read; rows alone say nothing about their order.
        rankedByRelevance: !!relevance && !Array.isArray(answer) && answer.relevanceApplied === true,
      };
    },
  };
}
