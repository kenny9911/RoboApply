// server/src/interview-engine/prep/jobFinder.ts
//
// "Which job are you interviewing for?" — from whatever the candidate types
// ("AI FDE", "前端工程师", "資料科學家") to real postings in their job market.
//
//   1. Read the text: the job taxonomy (instant, CJK-aware synonyms) and the
//      RoleResolverAgent (abbreviations, market-language queries), cached.
//   2. Search, in parallel where it can:
//        index      our own postings (employer boards, banks, imports) through
//                   the feed — both brands, no outbound call, no quota;
//        providers  the licensed job boards of the brand (JSearch and Active
//                   Jobs DB on RoboApply; GoApply's source is its own index, so
//                   nothing more is asked there), under the job-search quota,
//                   and only when our index found fewer than PROVIDER_MIN_INDEX;
//        web        open career sites (prep/webSearch.ts) when the two above
//                   found little — never a board whose terms forbid reading.
//   3. Merge, de-duplicate and rank by how closely the title matches what the
//      candidate meant, then by company (when one was named) and freshness.
//
// The answer always carries role suggestions, so a candidate with no posting
// in sight can still practice the role itself.

import { logger } from '../../services/LoggerService.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import { searchTaxonomy } from '../../features/jobs/taxonomy/index.js';
import { createTtlCache, keyPart } from './cache.js';
import { clip, clipBlock, type PrepPosting, type PrepRoleSuggestion, type PrepSearchResult, type PrepSourceStatus } from './contract.js';
import { roleResolverAgent, type RoleResolverOutput } from './agents.js';
import { searchWebPostings } from './webSearch.js';
import { countryFromLocation, type PrepMarketContext } from './marketContext.js';

export interface JobFinderInput {
  userId: string;
  locale: string;
  query: string;
  company?: string | null;
  industry?: string | null;
  /** Ask the job boards and the web too (default true). */
  external?: boolean;
  requestId?: string;
}

export interface SourceAnswer {
  status: PrepSourceStatus;
  postings: PrepPosting[];
}

export interface JobFinderDeps {
  resolve: (input: { query: string; company: string | null; industry: string | null; locale: string; ctx: PrepMarketContext; requestId?: string }) => Promise<RoleResolverOutput | null>;
  /** `country`: only postings in that country (or remote and open to it); null = no country filter. */
  searchIndex: (input: { userId: string; query: string; locale: string; limit: number; country: string | null }) => Promise<SourceAnswer>;
  searchProviders: (input: { userId: string; query: string; ctx: PrepMarketContext; requestId?: string }) => Promise<SourceAnswer>;
  searchWeb: (input: { title: string; company: string | null; ctx: PrepMarketContext; locale: string }) => Promise<SourceAnswer>;
  taxonomy: (query: string, locale: string) => PrepRoleSuggestion[];
}

/** A board's location without the listing site it appends ("東京都 • 提供元: X", "Austin, TX • via Y"). */
export function cleanBoardLocation(value: string | null | undefined): string | null {
  const text = clip(value, 200).replace(/\s*[•·]\s*(提供元|via|来源|來源|출처|fonte|fuente|source|quelle)\s*[:：]?.*$/iu, '');
  return clip(text, 160) || null;
}

/** An http(s) link of a sane length, else null (never a cut URL). */
function safeLink(value: string | null | undefined): string | null {
  const url = (value ?? '').trim();
  return url && url.length <= 2048 && /^https?:\/\//i.test(url) ? url : null;
}

const RESOLVE_TIMEOUT_MS = 12_000;
const POSTING_LIMIT = 10;
/** Below this many postings from our index, the job boards are asked too. */
export const PROVIDER_MIN_INDEX = 6;

// ─── Default sources ───────────────────────────────────────────────────────

const resolveCache = createTtlCache<RoleResolverOutput>({ ttlMs: 24 * 60 * 60 * 1000, max: 2000 });

/** Test seam. */
export function clearJobFinderCache(): void {
  resolveCache.clear();
}

async function defaultResolve(input: Parameters<JobFinderDeps['resolve']>[0]): Promise<RoleResolverOutput | null> {
  const key = [keyPart(input.query), keyPart(input.company), keyPart(input.industry), input.locale, input.ctx.marketKey, input.ctx.country ?? ''].join('|');
  try {
    return await resolveCache.getOrCompute(key, () =>
      roleResolverAgent.run(
        {
          query: input.query,
          company: input.company,
          industry: input.industry,
          locale: input.locale,
          marketLabel: input.ctx.marketLabel,
          country: input.ctx.country,
        },
        { requestId: input.requestId, signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS) },
      ),
    );
  } catch (err) {
    logger.warn('INTERVIEW_PREP', 'role resolver failed; using the typed text', {
      requestId: input.requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function defaultSearchIndex(input: Parameters<JobFinderDeps['searchIndex']>[0]): Promise<SourceAnswer> {
  try {
    const { feedService } = await import('../../features/feed/index.js');
    const { items } = await feedService.previewOrdered(input.userId, {
      q: input.query,
      limit: input.limit,
      locale: input.locale,
      ...(input.country ? { filters: { country: input.country } } : {}),
    });
    const postings: PrepPosting[] = items.map((item) => ({
      ref: `job:${item.jobId}`,
      source: 'index',
      provider: item.source?.name ?? null,
      jobId: item.jobId,
      title: clip(item.title, 160),
      company: clip(item.company?.name, 120) || null,
      location: clip(item.location, 160) || null,
      postedAt: item.postedAt ?? null,
      url: safeLink(item.apply?.url),
      snippet: null,
      description: null,
    }));
    return { status: postings.length ? 'ok' : 'empty', postings };
  } catch (err) {
    logger.warn('INTERVIEW_PREP', 'job index search failed', { error: err instanceof Error ? err.message : String(err) });
    return { status: 'error', postings: [] };
  }
}

async function defaultSearchProviders(input: Parameters<JobFinderDeps['searchProviders']>[0]): Promise<SourceAnswer> {
  // GoApply's job-search source is its own index, already searched above.
  if (input.ctx.brand.market === 'cn') return { status: 'skipped', postings: [] };
  const [{ jobSearchService }, { jobSearchQuota, SearchQuotaError }] = await Promise.all([
    import('../../job-search/service.js'),
    import('../../job-search/quota.js'),
  ]);
  let reservation: string | null = null;
  const started = Date.now();
  let status = 200;
  try {
    reservation = await jobSearchQuota.reserve(input.userId, undefined, input.requestId, input.ctx.brand);
    const result = await jobSearchService.search(
      { query: clip(input.query, 160), country: (input.ctx.country ?? input.ctx.brand.defaultCountry).toLowerCase(), limit: POSTING_LIMIT },
      { audience: 'website', brand: input.ctx.brand, userId: input.userId, requestId: input.requestId, signal: AbortSignal.timeout(20_000) },
    );
    const postings: PrepPosting[] = result.jobs.map((job) => ({
      ref: `ext:${job.provider}:${job.id}`.slice(0, 120),
      source: 'provider',
      provider: job.provider,
      jobId: null,
      title: clip(job.title, 160),
      company: clip(job.company, 120) || null,
      location: cleanBoardLocation(job.location),
      postedAt: job.postedAt,
      url: safeLink(job.applyUrl) ?? safeLink(job.sourceUrl),
      snippet: clip(job.description, 280) || null,
      description: clipBlock(job.description, 4000) || null,
    }));
    return { status: postings.length ? 'ok' : 'empty', postings };
  } catch (err) {
    status = err instanceof SearchQuotaError ? 429 : 500;
    const unavailable = err instanceof SearchQuotaError || (err instanceof Error && /disabled|unavailable|credential|licens/i.test(err.message));
    logger.info('INTERVIEW_PREP', 'job board search unavailable', {
      requestId: input.requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: unavailable ? 'unavailable' : 'error', postings: [] };
  } finally {
    if (reservation) {
      await jobSearchQuota.finish(reservation, status, Date.now() - started).catch(() => undefined);
    }
  }
}

async function defaultSearchWeb(input: Parameters<JobFinderDeps['searchWeb']>[0]): Promise<SourceAnswer> {
  const postings = await searchWebPostings(input.ctx.brand, {
    title: input.title,
    company: input.company,
    country: input.ctx.country,
    language: input.locale,
  });
  if (postings === null) return { status: 'unavailable', postings: [] };
  return { status: postings.length ? 'ok' : 'empty', postings };
}

function defaultTaxonomy(query: string, locale: string): PrepRoleSuggestion[] {
  return searchTaxonomy(query, { locale, limit: 4, levels: [3] }).map((hit) => ({
    title: hit.label,
    titleEn: null,
    source: 'taxonomy' as const,
    context: hit.context,
    taxonomyId: hit.id,
  }));
}

export const defaultJobFinderDeps: JobFinderDeps = {
  resolve: defaultResolve,
  searchIndex: defaultSearchIndex,
  searchProviders: defaultSearchProviders,
  searchWeb: defaultSearchWeb,
  taxonomy: defaultTaxonomy,
};

// ─── Ranking ───────────────────────────────────────────────────────────────

const CJK = /[぀-ヿ㐀-鿿가-힯]/;

/** Word tokens; CJK text as character bigrams (no spaces between its words). */
export function titleTokens(text: string): Set<string> {
  const lower = text.normalize('NFKC').toLowerCase();
  const out = new Set<string>();
  for (const word of lower.split(/[^\p{L}\p{N}+#]+/u).filter(Boolean)) {
    if (CJK.test(word)) {
      const chars = [...word];
      if (chars.length === 1) out.add(word);
      for (let i = 0; i < chars.length - 1; i += 1) out.add(chars[i] + chars[i + 1]);
    } else if (word.length > 1 || /\d/.test(word)) {
      out.add(word);
    }
  }
  return out;
}

/** 0..1: how much of the wanted title the posting title covers. */
export function titleSimilarity(posting: string, wanted: string): number {
  const a = titleTokens(posting);
  const b = titleTokens(wanted);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of b) if (a.has(token)) shared += 1;
  return shared / b.size;
}

function freshness(postedAt: string | null): number {
  if (!postedAt) return 0;
  const age = (Date.now() - new Date(postedAt).getTime()) / 86_400_000;
  if (!Number.isFinite(age) || age < 0) return 0;
  return age <= 7 ? 1 : age <= 30 ? 0.6 : age <= 90 ? 0.3 : 0;
}

export function rankPostings(postings: PrepPosting[], wanted: string[], company: string | null, country: string | null = null): PrepPosting[] {
  const companyKey = keyPart(company);
  const seen = new Set<string>();
  const scored = postings
    .map((posting) => {
      const titleScore = Math.max(0, ...wanted.map((title) => titleSimilarity(posting.title, title)));
      const companyScore = companyKey && keyPart(posting.company).includes(companyKey) ? 1 : 0;
      const sourceScore = posting.source === 'index' ? 0.1 : posting.source === 'provider' ? 0.05 : 0;
      // A posting in the candidate's own market ranks above one "open anywhere".
      const localScore = country && countryFromLocation(posting.location) === country ? 0.08 : 0;
      return { posting, score: titleScore * 0.65 + companyScore * 0.25 + freshness(posting.postedAt) * 0.05 + sourceScore + localScore };
    })
    // A posting that shares nothing with the wanted title is noise, whatever its source.
    .filter((row) => wanted.length === 0 || row.score >= 0.2)
    .sort((a, b) => b.score - a.score);
  const out: PrepPosting[] = [];
  for (const { posting } of scored) {
    const key = [keyPart(posting.company), keyPart(posting.title), keyPart(posting.location)].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(posting);
    if (out.length >= POSTING_LIMIT) break;
  }
  return out;
}

function mergeRoles(understood: RoleResolverOutput | null, taxonomy: PrepRoleSuggestion[]): PrepRoleSuggestion[] {
  const out: PrepRoleSuggestion[] = [];
  for (const title of understood?.titles ?? []) {
    out.push({ title: title.title, titleEn: title.titleEn !== title.title ? title.titleEn : null, source: 'ai', context: null });
  }
  for (const suggestion of taxonomy) {
    if (out.some((row) => keyPart(row.title) === keyPart(suggestion.title) || keyPart(row.titleEn) === keyPart(suggestion.title))) continue;
    out.push(suggestion);
  }
  return out.slice(0, 6);
}

// ─── Orchestration ─────────────────────────────────────────────────────────

export async function findJobs(input: JobFinderInput, ctx: PrepMarketContext, deps: JobFinderDeps = defaultJobFinderDeps): Promise<PrepSearchResult> {
  const query = clip(input.query, 160);
  const company = clip(input.company, 120) || null;
  const industry = clip(input.industry, 80) || null;
  const external = input.external !== false;

  // Postings in the candidate's job market only. GoApply's index is its own
  // market already, and mainland rows often state no country.
  const country = ctx.brand.market === 'cn' ? null : ctx.country;
  // The typed text goes to the index at once; its reading may add a better query below.
  const [understood, firstIndex] = await Promise.all([
    deps.resolve({ query, company, industry, locale: input.locale, ctx, requestId: input.requestId }),
    deps.searchIndex({ userId: input.userId, query, locale: input.locale, limit: POSTING_LIMIT, country }),
  ]);
  const taxonomy = deps.taxonomy(query, input.locale);
  const titlesEn = (understood?.titles ?? []).map((title) => title.titleEn).filter(Boolean);
  const titlesShown = (understood?.titles ?? []).map((title) => title.title);
  const primary = titlesEn[0] ?? taxonomy[0]?.title ?? query;
  const marketQuery = understood?.searchQueries[0] ?? primary;
  const wanted = [...new Set([query, ...titlesShown, ...titlesEn, ...(understood?.searchQueries ?? []), ...taxonomy.map((row) => row.title)])].filter(Boolean);

  const needsSecondIndex = keyPart(primary) !== keyPart(query);
  const secondIndex: SourceAnswer = needsSecondIndex
    ? await deps.searchIndex({ userId: input.userId, query: primary, locale: input.locale, limit: POSTING_LIMIT, country })
    : { status: 'skipped', postings: [] };
  const indexPostings = [...firstIndex.postings, ...secondIndex.postings];
  // Remote roles "open anywhere" pass the country filter but are not the local
  // market: only postings located in the country count as enough.
  const localIndex = country ? indexPostings.filter((posting) => countryFromLocation(posting.location) === country) : indexPostings;

  // The job boards are asked only when our own index is thin: they are metered,
  // and their daily budget is shared with the job search itself.
  const providers: SourceAnswer =
    external && localIndex.length < PROVIDER_MIN_INDEX
      ? await deps.searchProviders({ userId: input.userId, query: company ? `${marketQuery} ${company}` : marketQuery, ctx, requestId: input.requestId })
      : { status: 'skipped', postings: [] };

  const found = indexPostings.length + providers.postings.length;
  const web: SourceAnswer =
    external && found < 4
      ? await deps.searchWeb({ title: understood?.searchQueries[0] ?? primary, company, ctx, locale: input.locale })
      : { status: 'skipped', postings: [] };

  const postings = rankPostings([...indexPostings, ...providers.postings, ...web.postings], wanted, company, country);
  const indexStatus: PrepSourceStatus =
    firstIndex.status === 'ok' || secondIndex.status === 'ok' ? 'ok' : firstIndex.status === 'error' && secondIndex.status !== 'empty' ? 'error' : 'empty';

  logger.info('INTERVIEW_PREP', 'job search', {
    requestId: input.requestId,
    market: ctx.marketKey,
    understood: Boolean(understood),
    index: indexPostings.length,
    providers: providers.status,
    web: web.status,
    returned: postings.length,
  });

  return {
    query,
    understood: {
      titles: titlesShown.length ? titlesShown : taxonomy.map((row) => row.title).slice(0, 1),
      seniority: understood?.seniority ?? null,
      industry: understood?.industry ?? industry,
    },
    roles: mergeRoles(understood, taxonomy),
    postings,
    market: { key: ctx.marketKey, country: ctx.country },
    sources: [
      { id: 'index', status: indexStatus, count: postings.filter((p) => p.source === 'index').length },
      { id: 'providers', status: providers.status, count: postings.filter((p) => p.source === 'provider').length },
      { id: 'web', status: web.status, count: postings.filter((p) => p.source === 'web').length },
    ],
  };
}
