// @vitest-environment node
// MKT-5A item 6 (JC-6; MARKET_STRATEGY §1.4 tier 1, M-6; JOB_SOURCES_CN §4.3, §6 tier 1 item 5):
// Active Jobs DB serves GoApply behind the licensed feed's plan gate.
//
//   - the on-demand search adapter serves both markets, the mainland only
//     while the gate is open; JSearch stays international for good;
//   - a mainland request carries role text only: the taxonomy's own Simplified
//     Chinese and English labels and "China" or a city of our city table.
//     Nothing a person typed can reach the request, whatever the stored query
//     holds; the request's parameter names are asserted against an allow-list;
//   - one posting, one market, in both directions: a row the provider files
//     under China that is not in mainland China is not written to the
//     mainland index, and an international query never writes a mainland
//     posting (the two brands would write the same row in turn); an
//     international query for mainland China itself makes no request;
//   - which adapters a brand's ingest knows (providers.ts): GoApply has
//     `activejobs` and `activejobs_feed` while the gate is open, neither while
//     it is closed, and never `jsearch`; the brand registry is untouched.
// And item 7's ingest half: the role's other English names as `titleSynonyms`.
// No network and no database: a mocked fetch, a fake AppConfig, fixed values.
// Every key is a made-up test value; every row is SYNTHETIC.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/prisma.js', () => ({ default: {}, prisma: {} }));
const logged = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../../../services/LoggerService.js', () => ({ logger: logged }));

import { getBrand, runWithBrand } from '../../../../platform/brand/index.js';
import type { ExternalJobNormalized, JobSearchProvider } from '../../../../roboapply/v2/lib/raExternalJobTypes.js';
import { __test as fantasticTest, FANTASTIC_SEARCH_LIMIT, normalizeFantasticJob } from '../../../../roboapply/v2/lib/raFantasticJobs.js';
import feedFixture from '../../normalize/__fixtures__/fantastic-feed.json' with { type: 'json' };
import { adapterDateWindow, adapterEnabledFor, adapterQueryLanguages, getSourceAdapter, registerSourceAdapter, resetSourceAdaptersForTests } from '../../sources/index.js';
import type { IngestQueryParams, JobSourceAdapter, SourceQuery } from '../../sources/index.js';
import { effectiveDailyLimit } from '../config.js';
import { runIngestQuery, type LeasedQueryRow, type PipelineContext } from '../pipeline.js';
import { planQueries, plannableAdapters, type DemandTuple } from '../planner.js';
import { adaptersForBrand, ingestProvidersForBrand, listEnabledAdaptersFor, resetBuiltinAdaptersForTests, sourcesForBrand } from '../providers.js';
import { feedGateForMarket, providerQuotaSnapshots, recordQuotaObservation, resetProviderQuotaForTests } from '../quota.js';
import { createIngestFake } from '../testkit.js';
// The admin System panel's own row builder (another area's internals: read by this test only, to show what the panel says).
import { buildProviderRows, providerSources } from '../../../admin/system.js';
import { createRapidApiAdapter, mainlandSearchParams, rapidApiSearchParams, rowsOfMarket } from './rapidApi.js';

const T0 = new Date('2026-10-12T09:15:00.000Z');
const KEY = 'synthetic-rapidapi-key-0006';
const robo = getBrand('roboapply');
const go = getBrand('goapply');

const ENV_NAMES = [
  'RAPID_API_KEY',
  'FANTASTIC_MONTHLY_JOBS',
  'FANTASTIC_FEED_DISABLED',
  'FANTASTIC_TRANSPORT',
  'FANTASTIC_API_KEY',
  'CN_ACTIVEJOBS_ENABLED',
  'INGEST_ACTIVEJOBS_CN_DAILY_CALLS',
  'INGEST_ACTIVEJOBS_DAILY_CALLS',
  'RA_ONBOARDING_EXTERNAL_JOBS_DISABLED',
  'RA_ONBOARDING_ACTIVEJOBS_DISABLED',
  'RA_ONBOARDING_JSEARCH_DISABLED',
  'RA_ONBOARDING_FANTASTIC_WINDOW',
  'JOB_PROVIDERS_GOAPPLY',
  'JOB_PROVIDERS_ROBOAPPLY',
];

/** The plan gate: open with a paid plan's size and a key, closed otherwise (today's free plan states 250 postings a month). */
function plan(state: 'paid' | 'free' | 'none'): void {
  vi.stubEnv('FANTASTIC_MONTHLY_JOBS', state === 'paid' ? '100000' : '');
  resetProviderQuotaForTests();
  if (state === 'free') {
    // What the free plan's own headers state (SYNTHETIC numbers in the shape of the 2026-10-11 probe).
    recordQuotaObservation({ provider: 'activejobs', status: 200, requestsLimit: 25, requestsRemaining: 20, resetSeconds: 864_000, jobsLimit: 250, jobsRemaining: 112, plan: null, reason: null, at: new Date() });
  }
}

function mockFetch(body: unknown[]) {
  const fn = vi.fn(async (_url: string, _init?: { headers?: Record<string, string> }) => ({
    status: 200,
    ok: true,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const cnQuery = (params: Partial<IngestQueryParams> = {}): SourceQuery => ({
  id: 'q-cn',
  provider: 'activejobs',
  market: 'cn',
  origin: 'demand',
  params: { q: '产品经理', taxonomyId: 'product_manager', country: 'CN', datePosted: 'week', ...params },
});

beforeEach(() => {
  resetSourceAdaptersForTests();
  resetBuiltinAdaptersForTests();
  resetProviderQuotaForTests();
  fantasticTest.reset();
  for (const name of ENV_NAMES) vi.stubEnv(name, '');
  vi.stubEnv('RAPID_API_KEY', KEY);
  for (const fn of Object.values(logged)) fn.mockClear();
});

afterEach(() => {
  resetSourceAdaptersForTests();
  resetBuiltinAdaptersForTests();
  resetProviderQuotaForTests();
  fantasticTest.reset();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('markets of the RapidAPI adapters', () => {
  it('Active Jobs DB serves intl and cn; JSearch serves intl only, for good', () => {
    expect([...createRapidApiAdapter('activejobs').markets]).toEqual(['intl', 'cn']);
    expect([...createRapidApiAdapter('jsearch').markets]).toEqual(['intl']);
    // JSearch is never on for the mainland, whatever the plan says.
    plan('paid');
    const jsearch = createRapidApiAdapter('jsearch');
    expect(adapterEnabledFor(jsearch, 'cn')).toBe(false);
    expect(jsearch.supportsCountry('CN')).toBe(true); // an international user may search China through it; never GoApply
  });

  it('declares what the planner reads: per job, English and Simplified Chinese labels, its one fixed window', () => {
    const activejobs = createRapidApiAdapter('activejobs');
    expect(activejobs.costModel).toBe('per_job');
    expect(adapterQueryLanguages(activejobs)).toEqual(['en', 'zh-CN']);
    expect(adapterQueryLanguages(createRapidApiAdapter('jsearch'))).toEqual(['en', 'zh-TW']);
    // The client asks seven days whatever a query says: that is the window stored on its queries.
    expect(activejobs.dateWindows).toEqual(['week']);
    expect(adapterDateWindow(activejobs, 'month')).toBe('week');
    expect(adapterDateWindow(activejobs, '3days')).toBe('week');
    vi.stubEnv('RA_ONBOARDING_FANTASTIC_WINDOW', '24h');
    expect(activejobs.dateWindows).toEqual(['today']);
    expect(adapterDateWindow(activejobs, 'week')).toBe('today');
    // JSearch honours the value it is given.
    expect(createRapidApiAdapter('jsearch').dateWindows).toBeUndefined();
    expect(activejobs.transport!()).toBe('rapidapi');
    vi.stubEnv('FANTASTIC_TRANSPORT', 'direct');
    expect(activejobs.transport!()).toBe('api');
    expect(createRapidApiAdapter('jsearch').transport!()).toBe('rapidapi');
  });
});

describe('the gate: the mainland only with a paid plan', () => {
  it("today's free plan: off for the mainland (reason plan_too_small), on for RoboApply as before; nothing is planned for cn", () => {
    plan('free');
    const adapter = createRapidApiAdapter('activejobs');
    expect(adapterEnabledFor(adapter, 'intl')).toBe(true);
    expect(adapterEnabledFor(adapter, 'cn')).toBe(false);
    expect(adapter.isEnabled()).toBe(true);
    expect(runWithBrand('goapply', () => adapter.disabledReason!())).toBe('plan_too_small');
    expect(runWithBrand('roboapply', () => adapter.disabledReason!())).toBeNull();
    expect(effectiveDailyLimit('activejobs', 'cn')).toBe(0);
    const cn: DemandTuple = { market: 'cn', taxonomyId: 'product_manager', q: 'Product manager', country: 'CN', origin: 'demand', users: 4 };
    expect(planQueries([cn], [adapter])).toEqual([]);
    expect(plannableAdapters([adapter], 'cn')).toEqual({ open: [], skipped: ['activejobs'] });
    // No plan stated at all (no response read, FANTASTIC_MONTHLY_JOBS unset): off too. The gate has a reason of its
    // own for it; the registry reports the plan gate's one code, which the System panel shows as 'gated'.
    plan('none');
    expect(adapterEnabledFor(adapter, 'cn')).toBe(false);
    expect(feedGateForMarket('cn').reason).toBe('plan_unknown');
    expect(runWithBrand('goapply', () => adapter.disabledReason!())).toBe('plan_too_small');
    expect(planQueries([cn], [adapter])).toEqual([]);
  });

  it('a paid plan: on for both markets, 20 mainland calls a day, and a mainland role is planned in Simplified Chinese', () => {
    plan('paid');
    const adapter = createRapidApiAdapter('activejobs');
    expect(adapterEnabledFor(adapter, 'intl')).toBe(true);
    expect(adapterEnabledFor(adapter, 'cn')).toBe(true);
    expect(runWithBrand('goapply', () => adapter.disabledReason!())).toBeNull();
    expect(effectiveDailyLimit('activejobs', 'cn')).toBe(20);
    const cn: DemandTuple = { market: 'cn', taxonomyId: 'product_manager', q: 'Product manager', country: 'CN', city: 'Shanghai', origin: 'demand', users: 4 };
    expect(planQueries([cn], [adapter]).map((p) => [p.provider, p.market, p.params.q, p.params.taxonomyId, p.params.country, p.params.city, p.params.datePosted, p.language])).toEqual([
      ['activejobs', 'cn', '产品经理', 'product_manager', 'CN', 'Shanghai', 'week', 'zh-CN'],
    ]);
    // RoboApply still gets its English query.
    expect(planQueries([{ ...cn, market: 'intl', country: 'US', city: undefined }], [adapter]).map((p) => [p.market, p.params.q, p.language])).toEqual([['intl', 'Product manager', 'en']]);
  });

  it('the switches: CN_ACTIVEJOBS_ENABLED=false, the feed switch, a mainland bound of 0 and the provider\'s own kill switch each keep the mainland off', () => {
    plan('paid');
    const adapter = createRapidApiAdapter('activejobs');
    const reason = () => runWithBrand('goapply', () => adapter.disabledReason!());
    vi.stubEnv('CN_ACTIVEJOBS_ENABLED', 'false');
    expect([adapterEnabledFor(adapter, 'cn'), adapterEnabledFor(adapter, 'intl'), reason()]).toEqual([false, true, 'kill_switch']);
    vi.stubEnv('CN_ACTIVEJOBS_ENABLED', '');
    vi.stubEnv('INGEST_ACTIVEJOBS_CN_DAILY_CALLS', '0');
    expect([adapterEnabledFor(adapter, 'cn'), adapterEnabledFor(adapter, 'intl'), reason()]).toEqual([false, true, 'kill_switch']);
    vi.stubEnv('INGEST_ACTIVEJOBS_CN_DAILY_CALLS', '7');
    expect([adapterEnabledFor(adapter, 'cn'), effectiveDailyLimit('activejobs', 'cn')]).toEqual([true, 7]);
    vi.stubEnv('INGEST_ACTIVEJOBS_CN_DAILY_CALLS', '');
    // The feed's switch stops the window sync; it also closes the gate the mainland search stands behind.
    vi.stubEnv('FANTASTIC_FEED_DISABLED', 'true');
    expect([adapterEnabledFor(adapter, 'cn'), adapterEnabledFor(adapter, 'intl'), reason()]).toEqual([false, true, 'kill_switch']);
    vi.stubEnv('FANTASTIC_FEED_DISABLED', '');
    vi.stubEnv('RA_ONBOARDING_ACTIVEJOBS_DISABLED', 'true');
    expect([adapterEnabledFor(adapter, 'cn'), adapterEnabledFor(adapter, 'intl'), reason()]).toEqual([false, false, 'kill_switch']);
    vi.stubEnv('RA_ONBOARDING_ACTIVEJOBS_DISABLED', '');
    vi.stubEnv('RAPID_API_KEY', '');
    expect([adapterEnabledFor(adapter, 'cn'), adapterEnabledFor(adapter, 'intl'), reason()]).toEqual([false, false, 'no_api_key']);
  });

  it('the test seams answer per market: `isEnabled` the home market, `mainlandOpen` the mainland', () => {
    const adapter = createRapidApiAdapter('activejobs', { isEnabled: () => true, mainlandOpen: () => false });
    expect([adapterEnabledFor(adapter, 'intl'), adapterEnabledFor(adapter, 'cn')]).toEqual([true, false]);
    const both = createRapidApiAdapter('activejobs', { isEnabled: () => false, mainlandOpen: () => true });
    expect([adapterEnabledFor(both, 'intl'), adapterEnabledFor(both, 'cn')]).toEqual([false, true]);
    // JSearch has no mainland to open.
    expect(adapterEnabledFor(createRapidApiAdapter('jsearch', { isEnabled: () => true, mainlandOpen: () => true }), 'cn')).toBe(false);
  });
});

describe('a mainland request is role text only', () => {
  it('the title is the role\'s own Simplified Chinese label and its English label; the location is "China" or a city of our city table', () => {
    expect(mainlandSearchParams({ q: '产品经理', taxonomyId: 'product_manager', country: 'CN', datePosted: 'week' })).toEqual({
      query: '产品经理',
      country: 'cn',
      datePosted: 'week',
      titleQuery: '产品经理',
      titleSynonyms: ['Product manager'],
      locationText: 'China',
    });
    expect(mainlandSearchParams({ q: '产品经理', taxonomyId: 'product_manager', country: 'CN', city: 'Shanghai', datePosted: 'week' })!.locationText).toBe('Shanghai');
    // A city our table does not know in mainland China is not sent: the country stands in.
    for (const city of ['Hong Kong', 'Taipei', 'Springfield', '我家楼下', 'x'.repeat(200)]) {
      expect(mainlandSearchParams({ q: '产品经理', taxonomyId: 'product_manager', country: 'CN', city, datePosted: 'week' })!.locationText, city).toBe('China');
    }
    // `rapidApiSearchParams` with the market builds the same.
    expect(rapidApiSearchParams({ q: '产品经理', taxonomyId: 'product_manager', country: 'CN', datePosted: 'week' }, 'activejobs', 'cn')).toEqual(mainlandSearchParams({ q: '产品经理', taxonomyId: 'product_manager', country: 'CN', datePosted: 'week' }));
  });

  it('whatever the stored query holds, nothing a person typed reaches the request', () => {
    const typed = '我想找上海的产品工作 zhang.san@example.com 13800000000 简历见附件';
    const params = mainlandSearchParams({ q: typed, taxonomyId: 'product_manager', country: 'CN', city: typed, datePosted: 'month', remote: true })!;
    expect(params).toEqual({ query: '产品经理', country: 'cn', datePosted: 'week', titleQuery: '产品经理', titleSynonyms: ['Product manager'], locationText: 'China' });
    expect(JSON.stringify(params)).not.toContain('zhang.san');
    expect(JSON.stringify(params)).not.toContain('13800000000');
    // No remote filter, no language, no free text: the keys are these six and no other.
    expect(Object.keys(params).sort()).toEqual(['country', 'datePosted', 'locationText', 'query', 'titleQuery', 'titleSynonyms']);
  });

  it('a query that names no taxonomy role asks nothing for the mainland', async () => {
    expect(mainlandSearchParams({ q: '产品经理', country: 'CN', datePosted: 'week' })).toBeNull();
    expect(mainlandSearchParams({ q: '产品经理', taxonomyId: 'not_a_role', country: 'CN', datePosted: 'week' })).toBeNull();
    // A category or a group of the tree is not a role.
    expect(mainlandSearchParams({ q: '产品', taxonomyId: 'product', country: 'CN', datePosted: 'week' })).toBeNull();
    expect(rapidApiSearchParams({ q: 'typed by a person', country: 'CN', datePosted: 'week' }, 'activejobs', 'cn')).toEqual({ query: '', country: 'cn', datePosted: 'week' });
    plan('paid');
    const fetchMock = mockFetch([]);
    const search = vi.fn();
    const adapter = createRapidApiAdapter('activejobs', { provider: { id: 'activejobs', isEnabled: () => true, search } as unknown as JobSearchProvider });
    const result = await adapter.fetch(cnQuery({ q: '张三 13800000000', taxonomyId: undefined }), { now: T0 });
    expect(result).toEqual({ jobs: [], calls: 0, notes: { cn_no_role_text: 1 } });
    expect(search).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the request URL: the Active Jobs DB host, parameter names of the allow-list only, and no value that came from a user', async () => {
    plan('paid');
    const fetchMock = mockFetch([feedFixture.cn_shanghai]);
    const adapter = createRapidApiAdapter('activejobs');
    const typed = '想去字节 li.si@example.com 13900000000';
    const result = await adapter.fetch(cnQuery({ q: typed, city: 'Shanghai', remote: true }), { now: T0, requestId: 'user-42' });
    expect(result.error).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(fetchMock.mock.calls[0]![0]);
    expect(url.origin + url.pathname).toBe('https://active-jobs-db.p.rapidapi.com/active-ats');
    // title / location / window / format (and the page size): nothing else may ever be sent for the mainland.
    const ALLOWED = ['title', 'location', 'time_frame', 'description_format', 'limit'];
    for (const name of url.searchParams.keys()) expect(ALLOWED, name).toContain(name);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      title: '"产品经理" OR "product manager"',
      location: 'Shanghai',
      time_frame: '7d',
      description_format: 'text',
      limit: String(FANTASTIC_SEARCH_LIMIT),
    });
    const sent = decodeURIComponent(url.href) + JSON.stringify(fetchMock.mock.calls[0]![1]);
    for (const leak of ['li.si', '13900000000', '字节', 'user-42', 'goapply', 'q-cn']) expect(sent, leak).not.toContain(leak);
    // The country-wide form.
    fantasticTest.reset();
    await adapter.fetch(cnQuery({ taxonomyId: 'backend_engineer' }), { now: T0 });
    expect(Object.fromEntries(new URL(fetchMock.mock.calls[1]![0]).searchParams)).toMatchObject({ title: '"后端开发工程师" OR "backend engineer"', location: 'China' });
  });

  it('a row the provider files under China that is in Hong Kong is not written to the mainland index', async () => {
    plan('paid');
    mockFetch([feedFixture.cn_shanghai, feedFixture.cn_hongkong]);
    const adapter = createRapidApiAdapter('activejobs');
    const result = await adapter.fetch(cnQuery(), { now: T0 });
    expect(result.jobs.map((j) => j.externalId)).toEqual(['activejobs:2900000003']);
    expect(result.notes).toEqual({ wrong_market: 1 });
    expect(result.calls).toBe(1);
    // The mainland row keeps its employer apply link and its publisher.
    expect(result.jobs[0]).toMatchObject({ applyUrl: feedFixture.cn_shanghai.url, applyIsDirect: true, sourcePublisher: 'Successfactors' });
  });

  it('rowsOfMarket: by the posting\'s own resolved location', () => {
    const fetchedAt = new Date('2026-10-12T09:00:00.000Z');
    const inputs = [feedFixture.cn_shanghai, feedFixture.cn_hongkong, feedFixture.us_offered].map((row) => normalizeFantasticJob(row, 'activejobs', fetchedAt) as ExternalJobNormalized);
    expect(rowsOfMarket(inputs, 'cn')).toMatchObject({ kept: [{ externalId: 'activejobs:2900000003' }], dropped: 2 });
    expect(rowsOfMarket(inputs, 'intl').kept.map((r) => r.externalId)).toEqual(['activejobs:2900000004', 'activejobs:2900000001']);
  });

  describe('one posting, one market, in both directions', () => {
    const intlQuery = (params: Partial<IngestQueryParams> = {}): SourceQuery => ({
      id: 'q-intl',
      provider: 'activejobs',
      market: 'intl',
      origin: 'demand',
      params: { q: 'Product manager', taxonomyId: 'product_manager', country: 'HK', datePosted: 'week', ...params },
    });
    const leased = (market: 'intl' | 'cn', params: IngestQueryParams): LeasedQueryRow => ({ id: `q-${market}`, market, provider: 'activejobs', params, origin: 'demand', demandScore: 2, priority: 50, consecutiveEmpty: 0 });
    const context = (db: PipelineContext['db'], market: 'intl' | 'cn'): PipelineContext => ({
      db,
      brand: market === 'cn' ? 'goapply' : 'roboapply',
      market,
      now: T0,
      enqueueMany: async (items) => ({ inserted: items.length }),
      publicDisplayProviders: [],
      // The stubbed process env: the mainland's 20 calls a day follow the plan gate (FANTASTIC_MONTHLY_JOBS, the key).
      env: process.env,
    });

    it('an international query keeps what is not in mainland China and drops the mainland posting (wrong_market)', async () => {
      plan('paid');
      // A Hong Kong search the provider answers with a Shanghai posting among its rows.
      const fetchMock = mockFetch([feedFixture.cn_shanghai, feedFixture.cn_hongkong, feedFixture.us_offered]);
      const adapter = createRapidApiAdapter('activejobs');
      const result = await adapter.fetch(intlQuery(), { now: T0 });
      expect(new URL(fetchMock.mock.calls[0]![0]).searchParams.get('location')).toBe('Hong Kong');
      // The very row the mainland sync writes (the test above keeps it for market cn) is not handed to RoboApply's pipeline.
      expect(result.jobs.map((j) => j.externalId)).toEqual(['activejobs:2900000004', 'activejobs:2900000001']);
      expect(result.notes).toEqual({ wrong_market: 1 });
      expect(result.calls).toBe(1);
    });

    it('the same id never reaches both pipelines: what the mainland keeps, the international market drops, and the other way round', async () => {
      plan('paid');
      const page = [feedFixture.cn_shanghai, feedFixture.cn_hongkong, feedFixture.us_offered];
      mockFetch(page);
      const adapter = createRapidApiAdapter('activejobs');
      const cn = await adapter.fetch(cnQuery(), { now: T0 });
      fantasticTest.reset();
      const intl = await adapter.fetch(intlQuery(), { now: T0 });
      const cnIds = cn.jobs.map((j) => j.externalId);
      const intlIds = intl.jobs.map((j) => j.externalId);
      expect(cnIds.filter((id) => intlIds.includes(id))).toEqual([]);
      expect([...cnIds, ...intlIds].sort()).toEqual(page.map((row) => `activejobs:${row.id}`).sort());
    });

    it('an international query for mainland China itself makes no request: every row it could return is the mainland\'s', async () => {
      plan('paid');
      const fetchMock = mockFetch([feedFixture.cn_shanghai]);
      const search = vi.fn();
      const adapter = createRapidApiAdapter('activejobs', { provider: { id: 'activejobs', isEnabled: () => true, search } as unknown as JobSearchProvider });
      for (const params of [{ country: 'CN' }, { country: 'CN', city: 'Shanghai' }, { country: 'cn' }, { country: 'US', city: 'Shenzhen' }]) {
        expect(await adapter.fetch(intlQuery(params), { now: T0 }), JSON.stringify(params)).toEqual({ jobs: [], calls: 0, notes: { other_market_location: 1 } });
      }
      expect(search).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      // Hong Kong, Taiwan and every other country are asked as before.
      search.mockResolvedValue([]);
      for (const country of ['HK', 'TW', 'US']) expect((await adapter.fetch(intlQuery({ country }), { now: T0 })).calls, country).toBe(1);
      // The planner plans none in the first place (a stored one from before this rule is what the adapter refuses).
      const real = createRapidApiAdapter('activejobs');
      const china: DemandTuple = { market: 'intl', taxonomyId: 'product_manager', q: 'Product manager', country: 'CN', origin: 'demand', users: 4 };
      expect(planQueries([china], [real])).toEqual([]);
      expect(planQueries([{ ...china, country: 'HK' }], [real]).map((p) => p.params.country)).toEqual(['HK']);
    });

    it('JSearch is not rerouted: its rows are written for RoboApply only, and it is still asked for China', async () => {
      const rows = [feedFixture.cn_shanghai, feedFixture.us_offered].map((row) => ({ ...(normalizeFantasticJob(row, 'activejobs', T0) as ExternalJobNormalized), sourceBoard: 'jsearch' as const, externalId: `jsearch:${row.id}` }));
      const search = vi.fn(async () => rows);
      const jsearch = createRapidApiAdapter('jsearch', { provider: { id: 'jsearch', isEnabled: () => true, search } as unknown as JobSearchProvider, isEnabled: () => true });
      const result = await jsearch.fetch({ ...intlQuery({ country: 'CN' }), provider: 'jsearch' }, { now: T0 });
      expect(result.jobs).toHaveLength(2);
      expect(result.notes).toBeUndefined();
      expect(search).toHaveBeenCalledTimes(1);
    });

    it('through the pipeline: an international run never changes the market of a stored mainland row', async () => {
      plan('paid');
      const page = [feedFixture.cn_shanghai, feedFixture.cn_hongkong];
      // GoApply's run first: the Shanghai posting is written for market cn.
      mockFetch(page);
      const mainland = createIngestFake();
      const cnRun = await runIngestQuery(context(mainland.db, 'cn'), createRapidApiAdapter('activejobs'), leased('cn', cnQuery().params));
      expect(cnRun).toMatchObject({ status: 'ok', calls: 1 });
      expect(mainland.written.map((w) => [w.externalId, w.market])).toEqual([['activejobs:2900000003', 'cn']]);
      // RoboApply's run on the same database, the provider answering with the same two rows: the stored mainland row
      // is not in its upsert at all (the upsert would set the row's market to the writer's), only the Hong Kong one is.
      fantasticTest.reset();
      const stored = { id: 'job-cn', externalId: 'activejobs:2900000003', sourceBoard: 'activejobs', firstSeenAt: T0, visibility: 'public', contentHash: null, enrichedEducation: false };
      const shared = createIngestFake({ existing: [stored as never] });
      const intlRun = await runIngestQuery(context(shared.db, 'intl'), createRapidApiAdapter('activejobs'), leased('intl', intlQuery().params));
      expect(intlRun).toMatchObject({ status: 'ok', calls: 1 });
      expect(intlRun.notes).toMatchObject({ wrong_market: 1 });
      expect(shared.written.map((w) => [w.externalId, w.market])).toEqual([['activejobs:2900000004', 'intl']]);
      expect(shared.written.some((w) => w.externalId === 'activejobs:2900000003')).toBe(false);
      // And the stored query for mainland China a RoboApply user left behind is answered without a call or a write.
      const fetchMock = mockFetch(page);
      fantasticTest.reset();
      const old = createIngestFake({ existing: [stored as never] });
      const refused = await runIngestQuery(context(old.db, 'intl'), createRapidApiAdapter('activejobs'), leased('intl', intlQuery({ country: 'CN' }).params));
      expect(refused).toMatchObject({ status: 'ok', calls: 0, notes: { other_market_location: 1 } });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(old.written).toEqual([]);
    });
  });

  it('JSearch is never asked for the mainland', async () => {
    const search = vi.fn(async () => []);
    const jsearch = createRapidApiAdapter('jsearch', { provider: { id: 'jsearch', isEnabled: () => true, search } as unknown as JobSearchProvider, isEnabled: () => true });
    expect(await jsearch.fetch({ ...cnQuery(), provider: 'jsearch' }, { now: T0 })).toEqual({ jobs: [], calls: 0, error: 'market_not_served' });
    expect(search).not.toHaveBeenCalled();
  });
});

describe('the international query: the role as phrases (item 7)', () => {
  it("a taxonomy role gets its other English names as synonyms (at most two); a typed title gets none", () => {
    expect(rapidApiSearchParams({ q: 'Product manager', taxonomyId: 'product_manager', country: 'US', datePosted: 'week' }, 'activejobs')).toEqual({
      query: 'Product manager',
      country: 'us',
      datePosted: 'week',
      titleQuery: 'Product manager',
      titleSynonyms: ['product owner', 'product lead'],
      locationText: 'United States',
    });
    expect(rapidApiSearchParams({ q: 'Chief of staff', country: 'US', datePosted: 'week' }, 'activejobs')).toEqual({ query: 'Chief of staff', country: 'us', datePosted: 'week', titleQuery: 'Chief of staff', locationText: 'United States' });
    // JSearch takes one free-text query: no synonyms.
    expect(rapidApiSearchParams({ q: 'Product manager', taxonomyId: 'product_manager', country: 'US', city: 'Austin', datePosted: 'week' }, 'jsearch')).toEqual({ query: 'Product manager in Austin', country: 'us', datePosted: 'week' });
  });

  it('on the wire: \'"product manager" OR "product owner" OR "product lead"\', 20 rows', async () => {
    const fetchMock = mockFetch([feedFixture.us_offered]);
    const adapter = createRapidApiAdapter('activejobs');
    const result = await adapter.fetch({ id: 'q1', provider: 'activejobs', market: 'intl', origin: 'demand', params: { q: 'Product manager', taxonomyId: 'product_manager', country: 'US', datePosted: 'week' } }, { now: T0 });
    const params = new URL(fetchMock.mock.calls[0]![0]).searchParams;
    expect(params.get('title')).toBe('"product manager" OR "product owner" OR "product lead"');
    expect(params.get('limit')).toBe('20');
    expect(result.jobs).toHaveLength(1);
    // The provider's reading reaches the pipeline through the search path too.
    expect(result.jobs[0]!.sponsorshipProvider).toBe('offered');
    // A short answer is everything the query can return: the run counts for the "missed twice" rule.
    expect(result).not.toHaveProperty('complete');
  });

  it('a full page (20 rows) is not everything the query can return: the run is not counted', async () => {
    const page = Array.from({ length: FANTASTIC_SEARCH_LIMIT }, (_, i) => ({ ...feedFixture.us_offered, id: 3_000_000 + i }));
    mockFetch(page);
    const adapter = createRapidApiAdapter('activejobs');
    const result = await adapter.fetch({ id: 'q2', provider: 'activejobs', market: 'intl', origin: 'demand', params: { q: 'Backend engineer', taxonomyId: 'backend_engineer', country: 'US', datePosted: 'week' } }, { now: T0 });
    expect(result.jobs).toHaveLength(20);
    expect(result.complete).toBe(false);
  });
});

describe('which adapters a brand has (providers.ts; the brand registry is not edited)', () => {
  const providers = (list: JobSourceAdapter[]) => list.map((a) => a.provider);

  it("closed (today's free plan): GoApply's ingest knows neither Active Jobs DB adapter, and never JSearch", () => {
    plan('free');
    expect(providers(adaptersForBrand(go, {}))).toEqual(['bank_gohire']);
    expect(ingestProvidersForBrand(go, {})).toEqual(['bank_gohire']);
    expect(providers(listEnabledAdaptersFor(go, {}))).not.toContain('activejobs');
    // RoboApply is what it was: its own list, on or off.
    expect(providers(adaptersForBrand(robo, {}))).toEqual(['activejobs', 'bank_robohire', 'jsearch']);
    expect(ingestProvidersForBrand(robo, {})).toEqual(['activejobs', 'bank_robohire', 'jsearch']);
  });

  it('closed: the admin list still shows both for GoApply, as off until a larger plan exists', () => {
    plan('free');
    const sources = runWithBrand('goapply', () => sourcesForBrand(go, {}).map((s) => [s.provider, s.kind, s.market, s.costModel, s.status().enabled, s.status().reason]));
    expect(sources.map((s) => s[0])).toEqual(['bank_gohire', 'activejobs', 'activejobs_feed', 'user_import']);
    expect(sources.slice(1, 3)).toEqual([
      ['activejobs', 'search', 'cn', 'per_job', false, 'plan_too_small'],
      ['activejobs_feed', 'search', 'cn', 'per_job', false, 'plan_too_small'],
    ]);
    expect(sourcesForBrand(go, {}).map((s) => s.provider)).not.toContain('jsearch');
    // RoboApply's list shows its feed the same way, directly after the search adapter of the same plan.
    const roboSources = runWithBrand('roboapply', () => sourcesForBrand(robo, {}).map((s) => [s.provider, s.status().enabled, s.status().reason]));
    expect(roboSources.slice(0, 2)).toEqual([
      ['activejobs', true, null],
      ['activejobs_feed', false, 'plan_too_small'],
    ]);
  });

  it('open (a paid plan): GoApply has activejobs and activejobs_feed; JSearch still never', () => {
    plan('paid');
    expect(providers(adaptersForBrand(go, {}))).toEqual(['bank_gohire', 'activejobs', 'activejobs_feed']);
    expect(ingestProvidersForBrand(go, {})).toEqual(['bank_gohire', 'activejobs', 'activejobs_feed']);
    expect(providers(listEnabledAdaptersFor(go, {}))).toEqual(expect.arrayContaining(['activejobs', 'activejobs_feed']));
    expect(providers(adaptersForBrand(robo, {}))).toEqual(['activejobs', 'activejobs_feed', 'bank_robohire', 'jsearch']);
    for (const env of [{}, { CN_EXTERNAL_PROVIDERS: 'jsearch' }, { JOB_PROVIDERS_GOAPPLY: 'jsearch,activejobs,bank_gohire' }]) {
      expect(providers(adaptersForBrand(go, env)), JSON.stringify(env)).not.toContain('jsearch');
      expect(providers(adaptersForBrand(go, env)), JSON.stringify(env)).not.toContain('linkedin');
      expect(sourcesForBrand(go, env).map((s) => s.provider), JSON.stringify(env)).not.toContain('jsearch');
    }
    // The mainland switch takes both out again; RoboApply keeps its feed.
    vi.stubEnv('CN_ACTIVEJOBS_ENABLED', 'false');
    expect(providers(adaptersForBrand(go, {}))).toEqual(['bank_gohire']);
    expect(providers(adaptersForBrand(robo, {}))).toEqual(['activejobs', 'activejobs_feed', 'bank_robohire', 'jsearch']);
  });

  it('JOB_PROVIDERS_GOAPPLY narrows the mainland list and never adds to it', () => {
    plan('paid');
    expect(providers(adaptersForBrand(go, { JOB_PROVIDERS_GOAPPLY: 'bank_gohire' }))).toEqual(['bank_gohire']);
    expect(providers(adaptersForBrand(go, { JOB_PROVIDERS_GOAPPLY: 'activejobs' }))).toEqual(['activejobs']);
    expect(providers(adaptersForBrand(go, { JOB_PROVIDERS_GOAPPLY: 'activejobs_feed,bank_gohire' }))).toEqual(['bank_gohire', 'activejobs_feed']);
    expect(providers(adaptersForBrand(go, { JOB_PROVIDERS_GOAPPLY: 'jsearch' }))).toEqual([]);
    // One brand's variable does not touch the other.
    expect(providers(adaptersForBrand(robo, { JOB_PROVIDERS_GOAPPLY: 'bank_gohire' }))).toEqual(['activejobs', 'activejobs_feed', 'bank_robohire', 'jsearch']);
  });

  it('a registered JSearch adapter that claims the mainland still joins no mainland list', () => {
    plan('paid');
    adaptersForBrand(go, {});
    const rogue: JobSourceAdapter = { ...getSourceAdapter('jsearch')!, markets: ['intl', 'cn'], isEnabled: () => true, isEnabledFor: () => true };
    resetSourceAdaptersForTests();
    resetBuiltinAdaptersForTests();
    // Registered before the built-ins, so it is the adapter the registry holds for the id.
    registerSourceAdapter(rogue);
    expect(getSourceAdapter('jsearch')).toBe(rogue);
    expect(providers(adaptersForBrand(go, {}))).not.toContain('jsearch');
    expect(sourcesForBrand(go, {}).map((s) => s.provider)).not.toContain('jsearch');
    expect(providers(adaptersForBrand(robo, {}))).toContain('jsearch');
  });

  it('the brand registry is unchanged: GoApply lists the GoHire bank and the user\'s own import, RoboApply its three sources', async () => {
    expect([...go.jobProviders]).toEqual(['bank_gohire', 'user_import']);
    expect([...robo.jobProviders]).toEqual(['activejobs', 'bank_robohire', 'jsearch', 'user_import']);
    // The rule lives in ingest/providers.ts, which reads the brand through the brand core's public surface
    // and writes nothing back: no file of this change imports the registry module itself.
    for (const file of ['../providers.ts', './rapidApi.ts', './fantasticFeed.ts', '../planner.ts', '../quota.ts', '../config.ts']) {
      const source = await readFile(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
      expect(source, file).not.toMatch(/from '[^']*platform\/brand\/registry/);
      expect(source, file).not.toMatch(/jobProviders\s*(?:\.push|=[^=>])/);
    }
    // The registry's own list objects are the ones the brand core exports: asking for a brand's adapters never changes them.
    plan('paid');
    adaptersForBrand(go, {});
    sourcesForBrand(go, {});
    expect([...getBrand('goapply').jobProviders]).toEqual(['bank_gohire', 'user_import']);
  });
});

describe('what the admin System panel says (the provider rows; MKT-3F built the panel)', () => {
  const rowsNow = () => {
    const now = new Date();
    const sources = providerSources(['roboapply', 'goapply'], process.env);
    return buildProviderRows({ sources, usage: [], quota: providerQuotaSnapshots(now), now, env: process.env })
      .filter((r) => r.provider.startsWith('activejobs'))
      .map((r) => [r.provider, r.market, r.state, r.limit, r.jobsLimit]);
  };

  it("today's free plan: the feed and GoApply's Active Jobs DB are listed as gated; RoboApply's search row is what it was", () => {
    plan('free');
    expect(rowsNow()).toEqual([
      ['activejobs', 'intl', 'ok', expect.any(Number), 250],
      ['activejobs_feed', 'intl', 'gated', null, 250],
      ['activejobs_feed:cn', 'cn', 'gated', null, 250],
      ['activejobs:cn', 'cn', 'gated', 0, 250],
    ]);
  });

  it('a used-up plan that never stated its postings: the sources behind the gate still read gated, never as a second "exhausted" alarm', () => {
    // A 429 whose headers state requests only (SYNTHETIC): the plan's size in postings is not known.
    vi.stubEnv('FANTASTIC_MONTHLY_JOBS', '');
    resetProviderQuotaForTests();
    recordQuotaObservation({ provider: 'activejobs', status: 429, requestsLimit: 25, requestsRemaining: 0, resetSeconds: 864_000, jobsLimit: null, jobsRemaining: null, plan: 'BASIC', reason: 'monthly_quota', at: new Date() });
    expect(feedGateForMarket('intl').reason).toBe('plan_unknown');
    // The search adapter that really ran is the one alarm; the feed and the mainland rows never ran.
    expect(rowsNow().map((r) => [r[0], r[2]])).toEqual([
      ['activejobs', 'exhausted'],
      ['activejobs_feed', 'gated'],
      ['activejobs_feed:cn', 'gated'],
      ['activejobs:cn', 'gated'],
    ]);
  });

  it('a paid plan: every row is on, and the mainland search has its 20 calls a day', () => {
    vi.stubEnv('FANTASTIC_MONTHLY_JOBS', '');
    resetProviderQuotaForTests();
    recordQuotaObservation({ provider: 'activejobs', status: 200, requestsLimit: 50_000, requestsRemaining: 49_000, resetSeconds: 864_000, jobsLimit: 100_000, jobsRemaining: 99_000, plan: null, reason: null, at: new Date() });
    expect(rowsNow()).toEqual([
      ['activejobs', 'intl', 'ok', expect.any(Number), 100_000],
      ['activejobs_feed', 'intl', 'ok', null, 100_000],
      ['activejobs_feed:cn', 'cn', 'ok', null, 100_000],
      ['activejobs:cn', 'cn', 'ok', 20, 100_000],
    ]);
  });
});
