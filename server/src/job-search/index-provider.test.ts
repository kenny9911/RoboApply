// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
vi.mock('../services/LoggerService.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
import { createJobSearchService, providersForBrand, type SearchProvider } from './service.js';
import { createIndexProvider, indexFilters, indexRow, type IndexFeedItem } from './index-provider.js';
import { getBrand } from '../platform/brand/registry.js';
import { FILTER_FIELDS } from '../features/search/contract.js';

const GO = getBrand('goapply');
const RA = getBrand('roboapply');
const NOW = Date.parse('2026-10-11T12:00:00Z');

/** A feed item with the PAR-11 contract fields (apply, source.original / url / lastVerifiedAt / via). */
function board(overrides: Partial<IndexFeedItem> = {}): IndexFeedItem {
  return {
    jobId: 'job_board_1', title: '数据分析师', company: { name: '示例科技', logoUrl: null }, location: '上海',
    workModel: 'onsite', employmentType: 'full_time', pay: null, postedAt: '2026-10-09T00:00:00Z', lastSeenAt: '2026-10-11T02:00:00Z',
    fromRecruiterBank: false,
    source: { name: 'SmartRecruiters', kind: 'ats_public', original: '示例科技', url: 'https://jobs.smartrecruiters.com/Example/1', lastVerifiedAt: '2026-10-11T02:00:00Z', via: 'ats' },
    apply: { url: 'https://careers.example.cn/jobs/1', target: 'employer' },
    ...overrides,
  };
}
const bank = () => board({
  jobId: 'job_bank_1', title: '产品经理', company: { name: '某某网络' }, fromRecruiterBank: true,
  pay: { min: 20000, max: 30000, currency: 'CNY', period: 'month' },
  source: { name: 'GoHire', kind: 'bank', original: 'GoHire', url: 'https://www.gohire.top/p/9', lastVerifiedAt: '2026-10-10T00:00:00Z', via: 'bank' },
  apply: { url: 'https://www.gohire.top/p/9', target: 'gohire' },
});

function setup(items: IndexFeedItem[], env: NodeJS.ProcessEnv = {}) {
  const preview = vi.fn(async () => items);
  const index = createIndexProvider({ preview, filterFields: async () => FILTER_FIELDS });
  const rapid: SearchProvider = { id: 'jsearch', isEnabled: () => true, search: vi.fn(async () => []) };
  const service = createJobSearchService({ providers: [rapid], brandProviders: { goapply: [index] }, env: () => env, now: () => NOW });
  return { service, preview, rapid, env };
}

describe('providersForBrand', () => {
  it('GoApply has one source, our own index; RoboApply keeps its list and has no index', () => {
    expect(providersForBrand(GO).map((p) => p.id)).toEqual(['index']);
    const intl = providersForBrand(RA).map((p) => p.id);
    expect(intl).toContain('jsearch');
    expect(intl).toContain('activejobs');
    expect(intl).not.toContain('index');
  });
});

describe('GoApply search reads the market cn index', () => {
  it('returns real rows with their source and apply link and calls no outside provider', async () => {
    const { service, preview, rapid } = setup([board(), bank()]);
    const result = await service.search({ query: '数据分析师' }, { brand: GO, userId: 'u1' });
    expect(rapid.search).not.toHaveBeenCalled();
    expect(result.meta.providers).toEqual([{ id: 'index', name: 'Job index', status: 'ok', resultCount: 2 }]);
    expect(result.meta.partial).toBe(false);
    const [first, second] = result.jobs;
    expect(first).toMatchObject({
      title: '数据分析师', company: '示例科技', provider: 'index', applyUrl: 'https://careers.example.cn/jobs/1',
      sourceUrl: 'https://jobs.smartrecruiters.com/Example/1', applyIsDirect: true, salary: null,
      postedAt: '2026-10-09T00:00:00.000Z', fetchedAt: '2026-10-11T02:00:00.000Z', country: null,
    });
    expect(first.sources).toEqual([{ provider: 'index', id: 'index:job_board_1', applyUrl: 'https://careers.example.cn/jobs/1', publisher: '示例科技', sourceUrl: 'https://jobs.smartrecruiters.com/Example/1' }]);
    expect(second).toMatchObject({ applyUrl: 'https://www.gohire.top/p/9', applyIsDirect: false, salary: { min: 20000, max: 30000, currency: 'CNY', period: 'month' } });
    expect(second.sources[0].publisher).toBe('GoHire');
    // The reader is the session user or the key's owner; the default country is the brand's.
    expect(preview).toHaveBeenCalledWith('u1', expect.objectContaining({ q: '数据分析师', limit: 50 }));
  });

  it('a row with no apply link is dropped, as on RoboApply; a feed that predates the contract yields an honest empty result', async () => {
    const { service } = setup([board({ apply: undefined }), board({ jobId: 'j2', apply: { url: null } }), board({ jobId: 'j3', apply: { url: 'javascript:alert(1)' } })]);
    const result = await service.search({ query: '数据分析师' }, { brand: GO, userId: 'u1' });
    expect(result.jobs).toEqual([]);
    expect(result.meta.providers[0]).toMatchObject({ id: 'index', status: 'empty', resultCount: 0 });
  });

  it('the reader’s own imports are never a search result', async () => {
    const mine = board({ jobId: 'mine', source: { name: 'Imported', kind: 'user_import', via: 'import' } });
    expect(indexRow(mine)).toBeNull();
    const { service } = setup([mine, board()]);
    expect((await service.search({ query: '数据分析师' }, { brand: GO, userId: 'u1' })).jobs.map((j) => j.sources[0].id)).toEqual(['index:job_board_1']);
  });

  it('clears the reader’s saved filters and sets only what the request states', async () => {
    const { service, preview } = setup([board({ workModel: 'remote', employmentType: 'internship' })]);
    await service.search({ query: '实习', location: '上海', remote: true, datePosted: 'week', employmentTypes: ['internship'] }, { brand: GO, userId: 'u1' });
    const filters = (preview.mock.calls[0] as unknown as [string, { filters: Record<string, unknown> }])[1].filters;
    for (const field of FILTER_FIELDS) expect(field in filters, field).toBe(true);
    expect(filters).toMatchObject({ locations: [{ label: '上海', radiusKm: 0 }], workModels: ['remote'], jobTypes: ['internship'], postedWithinDays: 7 });
    expect(filters.taxonomyIds).toBeUndefined();
    expect(filters.companies).toBeUndefined();
    expect(indexFilters({ query: 'x', country: 'cn', datePosted: 'all' }, ['q', 'titles'])).toEqual({ q: undefined, titles: undefined });
  });

  it('another country returns nothing (the index holds mainland postings only) and reads nothing', async () => {
    const { service, preview } = setup([board()]);
    const result = await service.search({ query: 'engineer', country: 'us' }, { brand: GO, userId: 'u1' });
    expect(result.jobs).toEqual([]);
    expect(result.meta.providers[0].status).toBe('empty');
    expect(preview).not.toHaveBeenCalled();
  });

  it('fails closed without a reader', async () => {
    const { service, preview } = setup([board()]);
    const result = await service.search({ query: '数据分析师' }, { brand: GO });
    expect(result.meta.providers[0]).toMatchObject({ status: 'error', reason: 'failed' });
    expect(preview).not.toHaveBeenCalled();
  });

  it('caches per reader: another user never gets the first user’s result', async () => {
    const { service, preview } = setup([board()]);
    await service.search({ query: '数据分析师' }, { brand: GO, userId: 'u1' });
    expect((await service.search({ query: '数据分析师' }, { brand: GO, userId: 'u1' })).meta.cache).toBe('hit');
    expect((await service.search({ query: '数据分析师' }, { brand: GO, userId: 'u2' })).meta.cache).toBe('miss');
    expect(preview).toHaveBeenCalledTimes(2);
  });

  it('needs no RapidAPI key and ignores RoboApply’s source switches; JOB_SEARCH_DISABLED stops it', async () => {
    const { service, env } = setup([board()], { JOB_SEARCH_PROVIDERS: 'jsearch,activejobs', RA_ONBOARDING_EXTERNAL_JOBS_DISABLED: 'true' });
    expect(service.providers('website', GO)).toEqual([{ id: 'index', name: 'Job index', homepage: '', sourceType: 'index', enabled: true }]);
    expect((await service.search({ query: '数据分析师' }, { brand: GO, userId: 'u1' })).jobs).toHaveLength(1);
    env.JOB_SEARCH_DISABLED = 'true';
    expect(service.providers('website', GO)[0]).toMatchObject({ enabled: false, reason: 'disabled' });
    delete env.JOB_SEARCH_DISABLED; env.CN_JOB_SEARCH_DISABLED = 'true';
    expect(service.providers('website', GO)[0]).toMatchObject({ enabled: false, reason: 'disabled' });
    // The GoApply override never reaches RoboApply.
    env.RAPID_API_KEY = 'fixture'; env.JOB_SEARCH_PROVIDERS = 'jsearch'; delete env.RA_ONBOARDING_EXTERNAL_JOBS_DISABLED;
    expect(service.providers('website', RA)[0]).toMatchObject({ id: 'jsearch', enabled: true });
  });

  it('an integration key needs the operator’s grant for the index, the same rule as RoboApply’s sources', async () => {
    const { service, preview, env } = setup([board()]);
    const refused = await service.search({ query: '数据分析师' }, { brand: GO, userId: 'owner', audience: 'api' });
    expect(refused.jobs).toEqual([]);
    expect(refused.meta.providers[0]).toMatchObject({ id: 'index', reason: 'not_licensed' });
    expect(preview).not.toHaveBeenCalled();
    env.JOB_SEARCH_API_PROVIDERS = 'jsearch,index';
    expect((await service.search({ query: '数据分析师' }, { brand: GO, userId: 'owner', audience: 'api' })).jobs).toHaveLength(1);
    // A GoApply-only grant list wins over the shared one.
    env.CN_JOB_SEARCH_API_PROVIDERS = 'none';
    expect(service.providers('api', GO)[0]).toMatchObject({ enabled: false, reason: 'not_licensed' });
  });

  it('RoboApply is unchanged: its providers, its default country, no index, no reader needed', async () => {
    const { service, rapid, preview } = setup([board()], { RAPID_API_KEY: 'fixture', JOB_SEARCH_PROVIDERS: 'jsearch' });
    const result = await service.search({ query: 'engineer' }, { brand: RA });
    expect(rapid.search).toHaveBeenCalledTimes(1);
    expect((rapid.search as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ country: 'us' });
    expect(result.meta.providers.map((p) => p.id)).toEqual(['jsearch']);
    expect(preview).not.toHaveBeenCalled();
    expect(service.providers('website', RA).map((p) => p.id)).toEqual(['jsearch']);
  });
});
