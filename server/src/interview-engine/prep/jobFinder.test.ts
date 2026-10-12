// @vitest-environment node
//
// "Which job are you interviewing for?" (prep/jobFinder.ts) with every source
// faked: the resolver's reading, our index, the job boards, the web and the
// taxonomy. Checks the merge, de-duplication and ranking, when each source is
// asked (the metered job boards only when our index is thin, the web only
// when both found little), and the CJK-aware title match.
// Run: npx vitest run server/src/interview-engine/prep/jobFinder.test.ts

import { beforeEach, describe, expect, it, vi } from 'vitest';

// The default sources' backends (loaded lazily by jobFinder.ts): our feed, the licensed job search and its quota.
const src = vi.hoisted(() => {
  class SearchQuotaError extends Error {}
  return { previewOrdered: vi.fn(), search: vi.fn(), reserve: vi.fn(), finish: vi.fn(), SearchQuotaError };
});

vi.mock('../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  generateRequestId: () => 'req-test',
}));
vi.mock('../../features/feed/index.js', () => ({ feedService: { previewOrdered: src.previewOrdered } }));
vi.mock('../../job-search/service.js', () => ({ jobSearchService: { search: src.search } }));
vi.mock('../../job-search/quota.js', () => ({ jobSearchQuota: { reserve: src.reserve, finish: src.finish }, SearchQuotaError: src.SearchQuotaError }));

import { getBrand } from '../../platform/brand/registry.js';
import type { PrepPosting, PrepRoleSuggestion } from './contract.js';
import type { RoleResolverOutput } from './agents.js';
import type { PrepMarketContext } from './marketContext.js';
import {
  PROVIDER_MIN_INDEX,
  defaultJobFinderDeps,
  findJobs,
  rankPostings,
  titleSimilarity,
  titleTokens,
  type JobFinderDeps,
  type SourceAnswer, cleanBoardLocation } from './jobFinder.js';

const ctx: PrepMarketContext = {
  brand: getBrand('roboapply'),
  formatMarket: 'intl',
  country: 'US',
  marketKey: 'us',
  marketLabel: 'United States and Canada',
};

const FDE: RoleResolverOutput = {
  titles: [{ title: 'Forward Deployed Engineer', titleEn: 'Forward Deployed Engineer' }],
  seniority: null,
  industry: 'Artificial Intelligence',
  searchQueries: ['forward deployed engineer'],
  notAJob: false,
};

let seq = 0;
function posting(over: Partial<PrepPosting> & { title: string }): PrepPosting {
  seq += 1;
  return {
    ref: `job:${seq}`,
    source: 'index',
    provider: null,
    jobId: String(seq),
    company: null,
    location: null,
    postedAt: null,
    url: null,
    snippet: null,
    description: null,
    ...over,
  };
}

const answer = (postings: PrepPosting[]): SourceAnswer => ({ status: postings.length ? 'ok' : 'empty', postings });

function makeDeps(over: Partial<JobFinderDeps> = {}) {
  return {
    resolve: vi.fn<JobFinderDeps['resolve']>(async () => structuredClone(FDE)),
    searchIndex: vi.fn<JobFinderDeps['searchIndex']>(async () => answer([])),
    searchProviders: vi.fn<JobFinderDeps['searchProviders']>(async () => answer([])),
    searchWeb: vi.fn<JobFinderDeps['searchWeb']>(async () => answer([])),
    taxonomy: vi.fn<JobFinderDeps['taxonomy']>(() => []),
    ...over,
  };
}

const input = (over: Partial<Parameters<typeof findJobs>[0]> = {}) => ({ userId: 'u1', locale: 'en', query: 'AI FDE', ...over });

describe('findJobs', () => {
  it('merges our index, the job boards and the web, de-duplicates, and ranks by the resolved title', async () => {
    const partial = posting({ title: 'Deployment Engineer', company: 'Acme', location: 'Austin, TX' });
    const exact = posting({ title: 'Forward Deployed Engineer', company: 'Globex', location: 'New York, NY' });
    const board = posting({ ref: 'ext:jsearch:9', source: 'provider', provider: 'jsearch', jobId: null, title: 'Senior Forward Deployed Engineer', company: 'Initech' });
    const noise = posting({ ref: 'ext:jsearch:10', source: 'provider', provider: 'jsearch', jobId: null, title: 'Sales Manager', company: 'Umbrella' });
    const deps = makeDeps({
      searchIndex: vi.fn(async ({ query }) => (query === 'AI FDE' ? answer([partial]) : answer([exact, { ...partial, ref: 'job:dup' }]))),
      searchProviders: vi.fn(async () => answer([board, noise])),
    });

    const result = await findJobs(input(), ctx, deps);

    // The exact title first (index ahead of a board at the same match), the partial match last, the noise dropped,
    // and the posting both index searches returned listed once.
    expect(result.postings.map((p) => p.title)).toEqual(['Forward Deployed Engineer', 'Senior Forward Deployed Engineer', 'Deployment Engineer']);
    expect(result.sources).toEqual([
      { id: 'index', status: 'ok', count: 2 },
      { id: 'providers', status: 'ok', count: 1 },
      { id: 'web', status: 'skipped', count: 0 },
    ]);
    expect(result).toMatchObject({
      query: 'AI FDE',
      understood: { titles: ['Forward Deployed Engineer'], seniority: null, industry: 'Artificial Intelligence' },
      roles: [{ title: 'Forward Deployed Engineer', titleEn: null, source: 'ai', context: null }],
      market: { key: 'us', country: 'US' },
    });
    // Five postings were found before the web leg: it is not asked.
    expect(deps.searchWeb).not.toHaveBeenCalled();
  });

  it('searches the index again with the expanded English title, only when it differs from the typed text', async () => {
    const deps = makeDeps();
    await findJobs(input(), ctx, deps);
    // Both index searches stay in the candidate's job market.
    expect(deps.searchIndex.mock.calls.map(([call]) => call)).toEqual([
      { userId: 'u1', query: 'AI FDE', locale: 'en', limit: 10, country: 'US' },
      { userId: 'u1', query: 'Forward Deployed Engineer', locale: 'en', limit: 10, country: 'US' },
    ]);
    expect(deps.resolve).toHaveBeenCalledWith(expect.objectContaining({ query: 'AI FDE', company: null, industry: null, locale: 'en', ctx }));

    const same = makeDeps({
      resolve: vi.fn(async () => ({ ...FDE, titles: [{ title: 'Software Engineer', titleEn: 'software  engineer' }], searchQueries: [] })),
    });
    await findJobs(input({ query: 'Software Engineer' }), ctx, same);
    expect(same.searchIndex).toHaveBeenCalledTimes(1);
  });

  it('GoApply searches its own index without a country filter (mainland rows often state none)', async () => {
    const deps = makeDeps();
    const cnCtx: PrepMarketContext = { brand: getBrand('goapply'), formatMarket: 'cn', country: 'CN', marketKey: 'cn', marketLabel: 'Mainland China' };
    await findJobs(input(), cnCtx, deps);
    for (const [call] of deps.searchIndex.mock.calls) expect(call.country).toBeNull();
  });

  it(`asks the metered job boards only when our index (both searches together) holds fewer than ${PROVIDER_MIN_INDEX} postings in the market`, async () => {
    expect(PROVIDER_MIN_INDEX).toBe(6);
    const fde = (from: string, n: number) =>
      Array.from({ length: n }, (_, i) => posting({ title: 'Forward Deployed Engineer', company: `${from} ${i}`, location: 'New York, NY' }));
    const split = (first: number, second: number) =>
      makeDeps({ searchIndex: vi.fn(async ({ query }) => answer(query === 'AI FDE' ? fde('Typed', first) : fde('Expanded', second))) });

    // Three from the typed text and three from the expanded title: enough, the boards are not asked.
    const enough = split(3, PROVIDER_MIN_INDEX - 3);
    const full = await findJobs(input(), ctx, enough);
    expect(enough.searchProviders).not.toHaveBeenCalled();
    expect(enough.searchWeb).not.toHaveBeenCalled();
    expect(full.sources).toEqual([
      { id: 'index', status: 'ok', count: PROVIDER_MIN_INDEX },
      { id: 'providers', status: 'skipped', count: 0 },
      { id: 'web', status: 'skipped', count: 0 },
    ]);

    // One fewer and the boards are asked, after both index searches.
    const thin = split(3, PROVIDER_MIN_INDEX - 4);
    await findJobs(input(), ctx, thin);
    expect(thin.searchProviders).toHaveBeenCalledTimes(1);
    expect(thin.searchIndex).toHaveBeenCalledTimes(2);
    const lastIndexCall = Math.max(...thin.searchIndex.mock.invocationCallOrder);
    expect(thin.searchProviders.mock.invocationCallOrder[0]).toBeGreaterThan(lastIndexCall);

    // Remote roles "open anywhere" pass the market filter but are not the local
    // market: six of them are not enough, the boards are asked.
    const anywhere = (n: number) =>
      Array.from({ length: n }, (_, i) => posting({ title: 'Forward Deployed Engineer', company: `Remote ${i}`, location: 'Anywhere' }));
    const remoteOnly = makeDeps({ searchIndex: vi.fn(async () => answer(anywhere(PROVIDER_MIN_INDEX))) });
    await findJobs(input(), ctx, remoteOnly);
    expect(remoteOnly.searchProviders).toHaveBeenCalledTimes(1);
  });

  it('drops the listing site a job board appends to a location', () => {
    expect(cleanBoardLocation('東京都 • 提供元: ムービン')).toBe('東京都');
    expect(cleanBoardLocation('Austin, TX • via LinkedIn')).toBe('Austin, TX');
    expect(cleanBoardLocation('霧島市, 鹿児島県, JP')).toBe('霧島市, 鹿児島県, JP');
    expect(cleanBoardLocation('  ')).toBeNull();
  });

  it('ranks a posting in the candidate market above an equal one open anywhere', () => {
    const remote = posting({ title: 'Forward Deployed Engineer', company: 'Far', location: 'Anywhere' });
    const local = posting({ title: 'Forward Deployed Engineer', company: 'Near', location: 'Austin, TX' });
    expect(rankPostings([remote, local], ['Forward Deployed Engineer'], null, 'US').map((p) => p.company)).toEqual(['Near', 'Far']);
  });

  it('asks the web only when the index and the boards found fewer than four postings', async () => {
    const web = posting({ ref: 'web:abc', source: 'web', provider: 'jobs.lever.co', jobId: null, title: 'Forward Deployed Engineer', company: 'Hooli' });
    const few = makeDeps({
      searchIndex: vi.fn(async ({ query }) => (query === 'AI FDE' ? answer([posting({ title: 'Forward Deployed Engineer', company: 'A' })]) : answer([]))),
      searchProviders: vi.fn(async () => answer([posting({ source: 'provider', title: 'Forward Deployed Engineer', company: 'B' }), posting({ source: 'provider', title: 'Forward Deployed Engineer', company: 'C' })])),
      searchWeb: vi.fn(async () => answer([web])),
    });
    const result = await findJobs(input(), ctx, few);
    expect(few.searchWeb).toHaveBeenCalledTimes(1);
    expect(few.searchWeb).toHaveBeenCalledWith({ title: 'forward deployed engineer', company: null, ctx, locale: 'en' });
    expect(result.postings.map((p) => p.company)).toContain('Hooli');
    expect(result.sources.find((s) => s.id === 'web')).toEqual({ id: 'web', status: 'ok', count: 1 });

    const four = makeDeps({
      searchIndex: vi.fn(async ({ query }) => (query === 'AI FDE' ? answer([posting({ title: 'Forward Deployed Engineer', company: 'A' })]) : answer([posting({ title: 'Forward Deployed Engineer', company: 'D' })]))),
      searchProviders: vi.fn(async () => answer([posting({ source: 'provider', title: 'Forward Deployed Engineer', company: 'B' }), posting({ source: 'provider', title: 'Forward Deployed Engineer', company: 'C' })])),
    });
    await findJobs(input(), ctx, four);
    expect(four.searchWeb).not.toHaveBeenCalled();
  });

  it('external=false keeps the search on our own index', async () => {
    const deps = makeDeps();
    const result = await findJobs(input({ external: false }), ctx, deps);
    expect(deps.searchProviders).not.toHaveBeenCalled();
    expect(deps.searchWeb).not.toHaveBeenCalled();
    expect(deps.searchIndex).toHaveBeenCalledTimes(2);
    expect(result.sources).toEqual([
      { id: 'index', status: 'empty', count: 0 },
      { id: 'providers', status: 'skipped', count: 0 },
      { id: 'web', status: 'skipped', count: 0 },
    ]);
  });

  it('names the company to the boards and ranks its postings first', async () => {
    const deps = makeDeps({
      searchIndex: vi.fn(async ({ query }) =>
        query === 'AI FDE' ? answer([posting({ title: 'Forward Deployed Engineer', company: 'Acme' }), posting({ title: 'Forward Deployed Engineer', company: 'Globex Corp' })]) : answer([]),
      ),
    });
    const result = await findJobs(input({ company: 'Globex' }), ctx, deps);
    expect(deps.searchProviders).toHaveBeenCalledWith(expect.objectContaining({ query: 'forward deployed engineer Globex', userId: 'u1', ctx }));
    expect(result.postings.map((p) => p.company)).toEqual(['Globex Corp', 'Acme']);
  });

  it('without a resolver answer, the taxonomy (then the typed text) leads the search', async () => {
    const taxonomy: PrepRoleSuggestion[] = [{ title: 'Frontend Engineer', titleEn: null, source: 'taxonomy', context: 'Software › Engineering', taxonomyId: 'r-fe' }];
    const cjk = posting({ title: '高级前端工程师', company: '某公司' });
    const deps = makeDeps({
      resolve: vi.fn(async () => null),
      taxonomy: vi.fn(() => taxonomy),
      searchIndex: vi.fn(async ({ query }) => (query === '前端工程师' ? answer([cjk]) : answer([]))),
    });
    const result = await findJobs(input({ query: '前端工程师', locale: 'zh' }), ctx, deps);
    expect(deps.taxonomy).toHaveBeenCalledWith('前端工程师', 'zh');
    expect(deps.searchIndex.mock.calls.map(([call]) => call.query)).toEqual(['前端工程师', 'Frontend Engineer']);
    expect(deps.searchProviders).toHaveBeenCalledWith(expect.objectContaining({ query: 'Frontend Engineer' }));
    expect(deps.searchWeb).toHaveBeenCalledWith(expect.objectContaining({ title: 'Frontend Engineer' }));
    expect(result.understood).toEqual({ titles: ['Frontend Engineer'], seniority: null, industry: null });
    expect(result.roles).toEqual(taxonomy);
    // The typed CJK text still matches a posting that only shares its characters.
    expect(result.postings.map((p) => p.title)).toEqual(['高级前端工程师']);

    // Nothing understood at all: the typed text is the query everywhere.
    const bare = makeDeps({ resolve: vi.fn(async () => null) });
    const plain = await findJobs(input({ query: 'Lighthouse keeper', industry: 'Maritime' }), ctx, bare);
    expect(bare.searchIndex).toHaveBeenCalledTimes(1);
    expect(bare.searchProviders).toHaveBeenCalledWith(expect.objectContaining({ query: 'Lighthouse keeper' }));
    expect(plain.understood).toEqual({ titles: [], seniority: null, industry: 'Maritime' });
    expect(plain.roles).toEqual([]);
  });

  it('suggests the resolver’s titles first, then taxonomy roles it did not already name', async () => {
    const deps = makeDeps({
      resolve: vi.fn(async () => ({ ...FDE, titles: [{ title: '前端工程师', titleEn: 'Frontend Engineer' }, { title: 'Web 开发工程师', titleEn: 'Web Developer' }] })),
      taxonomy: vi.fn(() => [
        { title: 'Frontend Engineer', titleEn: null, source: 'taxonomy' as const, context: 'Software', taxonomyId: 'r-fe' },
        { title: 'UI Engineer', titleEn: null, source: 'taxonomy' as const, context: 'Software', taxonomyId: 'r-ui' },
      ]),
    });
    const result = await findJobs(input({ query: '前端', locale: 'zh' }), ctx, deps);
    expect(result.roles.map((role) => [role.title, role.titleEn, role.source])).toEqual([
      ['前端工程师', 'Frontend Engineer', 'ai'],
      ['Web 开发工程师', 'Web Developer', 'ai'],
      ['UI Engineer', null, 'taxonomy'],
    ]);
  });
});

describe('the default sources', () => {
  const APPLY = 'https://acme.example/apply?ref=';
  const exactly2048 = APPLY + 'x'.repeat(2048 - APPLY.length);
  const tooLong = `${exactly2048}x`;
  const indexQuery = { userId: 'u1', query: 'Engineer', locale: 'en', limit: 10 };
  const goCtx: PrepMarketContext = { brand: getBrand('goapply'), formatMarket: 'cn', country: 'CN', marketKey: 'cn', marketLabel: 'Mainland China' };

  beforeEach(() => {
    for (const fake of [src.previewOrdered, src.search, src.reserve, src.finish]) fake.mockReset();
    src.reserve.mockResolvedValue('res-1');
    src.finish.mockResolvedValue(undefined);
  });

  it('our index: a posting keeps its link only when it is a whole http(s) link of at most 2048 characters', async () => {
    src.previewOrdered.mockResolvedValue({
      items: [
        { jobId: 'j1', title: 'Backend Engineer', company: { name: 'Acme' }, location: 'Berlin', postedAt: '2026-10-01', apply: { url: 'https://acme.example/apply/1' }, source: { name: 'greenhouse' } },
        { jobId: 'j2', title: 'Frontend Engineer', company: null, location: null, postedAt: null, apply: { url: 'javascript:alert(1)' }, source: null },
        { jobId: 'j3', title: 'Data Engineer', apply: { url: exactly2048 } },
        { jobId: 'j4', title: 'ML Engineer', apply: { url: tooLong } },
        { jobId: 'j5', title: 'QA Engineer' },
      ],
    });
    const out = await defaultJobFinderDeps.searchIndex(indexQuery);
    expect(src.previewOrdered).toHaveBeenCalledWith('u1', { q: 'Engineer', limit: 10, locale: 'en' });
    expect(out.status).toBe('ok');
    expect(out.postings.map((p) => [p.ref, p.jobId, p.url])).toEqual([
      ['job:j1', 'j1', 'https://acme.example/apply/1'],
      ['job:j2', 'j2', null],
      ['job:j3', 'j3', exactly2048],
      ['job:j4', 'j4', null],
      ['job:j5', 'j5', null],
    ]);
    expect(out.postings[0]).toMatchObject({ source: 'index', provider: 'greenhouse', title: 'Backend Engineer', company: 'Acme', location: 'Berlin', postedAt: '2026-10-01' });
  });

  it('our index: nothing found is "empty"; a failure is "error", never a throw', async () => {
    src.previewOrdered.mockResolvedValue({ items: [] });
    expect(await defaultJobFinderDeps.searchIndex(indexQuery)).toEqual({ status: 'empty', postings: [] });
    src.previewOrdered.mockRejectedValue(new Error('db down'));
    expect(await defaultJobFinderDeps.searchIndex(indexQuery)).toEqual({ status: 'error', postings: [] });
  });

  it('the job boards: GoApply is never asked (its source is its own index)', async () => {
    expect(await defaultJobFinderDeps.searchProviders({ userId: 'u1', query: '后端工程师', ctx: goCtx })).toEqual({ status: 'skipped', postings: [] });
    expect(src.reserve).not.toHaveBeenCalled();
    expect(src.search).not.toHaveBeenCalled();
  });

  it('the job boards: one quota reservation per search, settled with the outcome; a safe apply link, else the source link', async () => {
    src.search.mockResolvedValue({
      jobs: [
        { provider: 'jsearch', id: 'a1', title: 'Backend Engineer', company: 'Acme', location: 'Austin, TX', postedAt: '2026-10-02', applyUrl: 'ftp://acme.example/apply', sourceUrl: 'https://boards.example/a1', description: 'Build APIs.' },
        { provider: 'activejobs', id: 'b2', title: 'Backend Engineer', company: 'Globex', location: null, postedAt: null, applyUrl: tooLong, sourceUrl: null, description: '' },
        { provider: 'jsearch', id: 'c3', title: 'Backend Engineer', company: 'Initech', location: null, postedAt: null, applyUrl: 'https://initech.example/apply', sourceUrl: 'https://boards.example/c3', description: null },
      ],
    });
    const out = await defaultJobFinderDeps.searchProviders({ userId: 'u1', query: 'Backend Engineer Acme', ctx, requestId: 'r1' });
    expect(src.reserve).toHaveBeenCalledWith('u1', undefined, 'r1', ctx.brand);
    expect(src.search).toHaveBeenCalledWith(
      { query: 'Backend Engineer Acme', country: 'us', limit: 10 },
      expect.objectContaining({ audience: 'website', brand: ctx.brand, userId: 'u1', requestId: 'r1' }),
    );
    expect(out.status).toBe('ok');
    expect(out.postings.map((p) => [p.ref, p.url])).toEqual([
      ['ext:jsearch:a1', 'https://boards.example/a1'],
      ['ext:activejobs:b2', null],
      ['ext:jsearch:c3', 'https://initech.example/apply'],
    ]);
    expect(out.postings[0]).toMatchObject({ source: 'provider', provider: 'jsearch', jobId: null, snippet: 'Build APIs.', description: 'Build APIs.' });
    expect(src.finish).toHaveBeenCalledTimes(1);
    expect(src.finish).toHaveBeenCalledWith('res-1', 200, expect.any(Number));
  });

  it('the job boards: an exhausted quota or a disabled provider is "unavailable"; any other failure is "error"', async () => {
    src.search.mockRejectedValueOnce(new src.SearchQuotaError('daily limit reached'));
    expect(await defaultJobFinderDeps.searchProviders({ userId: 'u1', query: 'x', ctx })).toEqual({ status: 'unavailable', postings: [] });
    expect(src.finish).toHaveBeenLastCalledWith('res-1', 429, expect.any(Number));

    src.search.mockRejectedValueOnce(new Error('provider disabled'));
    expect(await defaultJobFinderDeps.searchProviders({ userId: 'u1', query: 'x', ctx })).toEqual({ status: 'unavailable', postings: [] });
    src.search.mockRejectedValueOnce(new Error('upstream 502'));
    expect(await defaultJobFinderDeps.searchProviders({ userId: 'u1', query: 'x', ctx })).toEqual({ status: 'error', postings: [] });
    expect(src.finish).toHaveBeenLastCalledWith('res-1', 500, expect.any(Number));

    // A refused reservation searches nothing and settles nothing.
    src.search.mockClear();
    src.finish.mockClear();
    src.reserve.mockRejectedValueOnce(new src.SearchQuotaError('over quota'));
    expect(await defaultJobFinderDeps.searchProviders({ userId: 'u1', query: 'x', ctx })).toEqual({ status: 'unavailable', postings: [] });
    expect(src.search).not.toHaveBeenCalled();
    expect(src.finish).not.toHaveBeenCalled();
  });
});

describe('title matching', () => {
  it('reads CJK titles as character pairs, so a longer posting title still matches', () => {
    expect([...titleTokens('前端工程师')]).toEqual(['前端', '端工', '工程', '程师']);
    expect(titleSimilarity('高级前端工程师', '前端工程师')).toBe(1);
    expect(titleSimilarity('前端工程师', '高级前端工程师')).toBeCloseTo(4 / 6);
    expect(titleSimilarity('シニアバックエンドエンジニア', 'バックエンドエンジニア')).toBe(1);
    expect(titleSimilarity('销售经理', '前端工程师')).toBe(0);
  });

  it('keeps symbols that name a skill and digits; drops other single letters', () => {
    const tokens = titleTokens('Senior C++ / C# Engineer, Level 3 (a team)');
    expect([...tokens]).toEqual(expect.arrayContaining(['senior', 'c++', 'c#', 'engineer', 'level', '3', 'team']));
    expect(tokens.has('a')).toBe(false);
    expect(titleSimilarity('', 'Engineer')).toBe(0);
    expect(titleSimilarity('Engineer', '')).toBe(0);
    expect(titleSimilarity('Senior Backend Engineer', 'backend engineer')).toBe(1);
  });

  it('rankPostings drops what shares nothing with the wanted titles, prefers fresh postings, and caps the list at ten', () => {
    const now = new Date().toISOString();
    const stale = posting({ title: 'Backend Engineer', company: 'Old', postedAt: '2020-01-01T00:00:00.000Z' });
    const fresh = posting({ title: 'Backend Engineer', company: 'New', postedAt: now });
    const unrelated = posting({ title: 'Barista', company: 'Cafe' });
    expect(rankPostings([stale, unrelated, fresh], ['Backend Engineer'], null).map((p) => p.company)).toEqual(['New', 'Old']);
    // With nothing wanted there is nothing to filter against.
    expect(rankPostings([unrelated], [], null)).toHaveLength(1);
    const many = Array.from({ length: 14 }, (_, i) => posting({ title: 'Backend Engineer', company: `Co ${i}` }));
    expect(rankPostings(many, ['Backend Engineer'], null)).toHaveLength(10);
  });
});
