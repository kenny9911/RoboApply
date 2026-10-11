// @vitest-environment node
//
// MKT-4H gate: a planned GoApply search over the REAL feed service
// (`createFeedQueryService` on the feed's own in-memory repo), not over a fake
// of its read function. The other job-search tests prove what this area does
// with the feed's answer; this one proves the answer it is given, so a claim
// the feed does not honour cannot pass (review of MKT-4H, high finding).
//
// What must hold whatever the feed does with `relevance`:
//   1. the API returns the feed's rows in the feed's order (no ranking here);
//   2. `agent.rankedBy` names the topics exactly when the feed SAID they took
//      part in the order (`previewOrdered` → `relevanceApplied: true`), and
//      then a row that mentions them really precedes an equally recent row it
//      would otherwise follow;
//   3. otherwise the topics are listed in `agent.unverifiedPreferences`.
//
// The feed's side of the contract is requested in the MKT-4H handoff (the
// query text of its lexical and dense legs is `q` and `relevance` together,
// and `previewOrdered` reports the applied order). Until the feed offers it,
// branch 3 is what runs: the feed takes `relevance` and says nothing, so the
// API claims nothing. Branch 2 becomes live with no edit here.
//
// No database, no network, no model: the feed's FakeFeedRepo and fake match.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../lib/prisma.js', () => ({ default: {} }));

import { getBrand } from '../platform/brand/registry.js';
import { buildMatchUser } from '../features/match/index.js';
import { createFeedQueryService } from '../features/feed/FeedQueryService.js';
import { FakeFeedRepo, fakeFeedMatch, feedRow } from '../features/feed/testkit.js';
import type { FeedCtx } from '../features/feed/types.js';
import { FILTER_FIELDS } from '../features/search/contract.js';
import type { SearchProfileWire } from '../features/search/index.js';
import { createJobSearchAgent, createPlannerGate } from './agent.js';
import { createIndexProvider, orderedPreview, type IndexPreviewInput, type PreviewSeam } from './index-provider.js';
import { createJobSearchService, type SearchProvider } from './service.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const POSTED = new Date('2026-10-09T12:00:00.000Z');
const GO = getBrand('goapply');
const TOPICS = ['climate', 'Rust'];

/** The three rows: equally recent, all match the query. Newest-first ties break on the id, descending: c, b, a. */
const ROWS = [
  { id: 'c_plain', title: 'Backend Engineer', doc: 'backend engineer payments' },
  { id: 'b_plain', title: 'Backend Engineer, Platform', doc: 'backend engineer platform' },
  // The only row that mentions the topics. By date and id alone it is LAST.
  { id: 'a_topical', title: 'Backend Engineer (Rust), climate', doc: 'backend engineer rust climate' },
];

const profile = (): SearchProfileWire => ({
  id: 'sp1', name: '', isDefault: true, isActive: true, version: 1, schemaVersion: 1, filters: {},
  alertInstantMax: 0, alertDigest: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
});

function realFeed() {
  const repo = new FakeFeedRepo();
  for (const row of ROWS) {
    repo.rows.push(feedRow({
      id: row.id, market: 'cn', title: row.title, titleNormalized: row.title.toLowerCase(),
      companyName: `公司 ${row.id}`, companyNameNormalized: `公司 ${row.id}`, sourceBoard: 'greenhouse', sourceName: 'Greenhouse',
      location: '上海', locationCountry: 'CN', remoteScope: null, postedAt: POSTED, firstSeenAt: POSTED,
    }));
    // The search document of the lexical leg, where the feed's testkit holds one (hybrid retrieval, MKT-4F).
    (repo as unknown as { searchDocs?: Map<string, string> }).searchDocs?.set(row.id, row.doc);
  }
  const feed = createFeedQueryService({
    repo,
    match: fakeFeedMatch({
      repo,
      now: () => NOW,
      context: (userId) => ({
        user: buildMatchUser({
          userId, market: 'cn',
          profile: { firstName: null, lastName: null, country: 'CN', skills: [{ name: 'Rust' }], workAuth: [], cnFields: null },
          education: [], experience: [], resumeParsed: null, searchProfile: { filters: {}, version: 1 }, employerIndustries: [],
        }, NOW),
        resume: { id: 'rv1', resumeMarkdown: '', resumeContentHash: 'h', parsedData: null, targetJobId: null },
      }),
    }),
    search: { getActive: async () => profile(), get: async () => profile() } as never,
    // A GoApply reader with 个性化推荐 off: the list is date and filters, or (with a query text) the fused order.
    personalized: async () => false,
    consumeRefresh: async () => ({ allowed: true, retryAfterSec: 0 }),
    aiAllowed: async () => false,
    planner: async () => ({ queries: [], unverifiedPreferences: [] }),
    env: {},
    now: () => NOW,
  });
  return { feed, repo };
}

const ctx = (userId: string): FeedCtx => ({ userId, market: 'cn', brandId: 'goapply', now: NOW });

function plannedSearch() {
  const { feed } = realFeed();
  const seam = feed as unknown as PreviewSeam<FeedCtx>;
  const reads: Array<{ input: IndexPreviewInput; relevanceApplied: boolean }> = [];
  const preview = async (userId: string, input: IndexPreviewInput) => {
    // The production read (`orderedPreview`), on the real service instead of the facade.
    const answer = await orderedPreview(seam, ctx(userId), input);
    reads.push({ input, relevanceApplied: answer.relevanceApplied });
    return answer;
  };
  const rapid: SearchProvider = { id: 'jsearch', isEnabled: () => true, search: vi.fn(async () => []) };
  const service = createJobSearchService({
    providers: [rapid],
    brandProviders: { goapply: [createIndexProvider({ preview, filterFields: async () => FILTER_FIELDS })] },
    env: () => ({ RAPID_API_KEY: 'fixture-key-not-a-secret' }),
    now: () => NOW.getTime(),
  });
  let n = 0;
  const quota = { reserve: vi.fn(async () => `reservation-${++n}`), finish: vi.fn(async () => undefined) };
  const agent = createJobSearchAgent({
    service,
    quota: quota as never,
    planner: async () => ({ queries: ['backend engineer'], relevanceTerms: TOPICS, unverifiedPreferences: ['五险一金'] }),
    gate: createPlannerGate({ phoneBindingRequired: async () => false, aiAllowed: async () => true, aiTextEnabled: async () => true }),
  });
  return { agent, feed, seam, reads, rapid };
}

const idOf = (job: { sources: Array<{ id: string }> }) => job.sources[0]!.id.replace(/^index:/, '');

describe('MKT-4H gate: a planned GoApply search over the real feed service', () => {
  it('returns the feed\'s rows in the feed\'s order, calls no outside provider, and names an order only when the feed says it applied one', async () => {
    const { agent, seam, reads, rapid } = plannedSearch();
    const response = await agent.search({ request: 'backend engineer jobs at climate companies, ideally using Rust, with 五险一金' }, { userId: 'owner', requestId: 'gate', brand: GO });

    // One read of the index, with the role query as `q` and the topics as `relevance`; no RapidAPI provider.
    expect(reads).toHaveLength(1);
    expect(reads[0]!.input).toMatchObject({ q: 'backend engineer', relevance: 'climate Rust', limit: 50 });
    expect(rapid.search).not.toHaveBeenCalled();

    // 1. All three rows match the query; the API hands them on in the order the feed itself returns for that read.
    const ids = response.jobs.map(idOf);
    expect([...ids].sort()).toEqual(['a_topical', 'b_plain', 'c_plain']);
    const own = await orderedPreview(seam, ctx('owner'), reads[0]!.input);
    expect(ids).toEqual(own.items.map((item) => item.jobId));

    // 2 and 3. The claim is the feed's own statement about this read, never this area's assumption.
    const fedSaysApplied = reads[0]!.relevanceApplied;
    expect(fedSaysApplied).toBe(own.relevanceApplied);
    if (fedSaysApplied) {
      expect(response.agent.rankedBy).toEqual(TOPICS);
      expect(response.agent.unverifiedPreferences).toEqual(['五险一金']);
      // The claim is true of the list: the row that mentions the topics precedes the equally recent row that,
      // by date and id alone, comes before it.
      expect(ids.indexOf('a_topical')).toBeLessThan(ids.indexOf('b_plain'));
    } else {
      expect(response.agent.rankedBy).toEqual([]);
      expect(response.agent.unverifiedPreferences).toEqual(['五险一金', ...TOPICS]);
      expect(response.meta).not.toHaveProperty('rankedBy');
    }
  });

  it('the same search without topics is the feed\'s plain list for the query: date, then id (the order the topics would have to change)', async () => {
    const { seam } = plannedSearch();
    const plain = await orderedPreview(seam, ctx('owner'), { q: 'backend engineer', limit: 50 });
    expect(plain.items.map((item) => item.jobId)).toEqual(['c_plain', 'b_plain', 'a_topical']);
    // No text to order by: nothing can have been applied.
    expect(plain.relevanceApplied).toBe(false);
  });
});

describe('orderedPreview: how this area reads the feed\'s statement about its order', () => {
  const item = { jobId: 'j1', title: 'T', company: { name: 'C' } };

  it('a feed with `previewOrdered` is read through it, and only an explicit `relevanceApplied: true` counts', async () => {
    for (const [said, expected] of [[true, true], [false, false], [undefined, false], ['true', false], [1, false], [null, false]] as const) {
      const feed = { preview: vi.fn(async () => [item]), previewOrdered: vi.fn(async () => ({ items: [item], relevanceApplied: said })) };
      const answer = await orderedPreview(feed, 'u1', { q: 'x', limit: 5, relevance: 'Rust' });
      expect(answer, String(said)).toEqual({ items: [item], relevanceApplied: expected });
      expect(feed.previewOrdered).toHaveBeenCalledWith('u1', { q: 'x', limit: 5, relevance: 'Rust' });
      expect(feed.preview).not.toHaveBeenCalled();
    }
  });

  it('a feed without it is read through `preview`, and says nothing about its order: taken as not applied', async () => {
    const feed = { preview: vi.fn(async () => [item]) };
    expect(await orderedPreview(feed, 'u1', { q: 'x', limit: 5, relevance: 'Rust' })).toEqual({ items: [item], relevanceApplied: false });
    expect(feed.preview).toHaveBeenCalledWith('u1', { q: 'x', limit: 5, relevance: 'Rust' });
  });

  it('a malformed answer yields no rows rather than a crash or a claim', async () => {
    const feed = { preview: vi.fn(async () => []), previewOrdered: vi.fn(async () => ({ items: 'nope', relevanceApplied: true })) };
    expect(await orderedPreview(feed, 'u1', { limit: 5, relevance: 'Rust' })).toEqual({ items: [], relevanceApplied: false });
  });
});
