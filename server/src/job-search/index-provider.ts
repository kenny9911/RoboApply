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

export type IndexPreview = (
  userId: string,
  input: { q?: string; filters?: Record<string, unknown>; limit: number },
) => Promise<IndexFeedItem[]>;

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
  return runWithBrand('goapply', () =>
    feedService.preview(userId, input as Parameters<typeof feedService.preview>[1]),
  ) as unknown as Promise<IndexFeedItem[]>;
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
    isEnabled: () => true,
    async search(
      params: ExternalSearchParams,
      opts: { requestId?: string; signal?: AbortSignal; userId?: string; input?: SearchInput } = {},
    ): Promise<ProviderJob[] | null> {
      // No reader, no visibility rules: fail closed rather than read as nobody.
      if (!opts.userId) return null;
      const input: SearchInput = opts.input ?? { query: params.titleQuery ?? params.query, country: params.country };
      // The index holds postings located in mainland China only.
      if (input.country && input.country.toLowerCase() !== 'cn') return [];
      const items = await preview(opts.userId, {
        q: input.query,
        filters: indexFilters(input, await filterFields()),
        limit: 50,
      });
      return items.map(indexRow).filter((row): row is ProviderJob => row !== null);
    },
  };
}
