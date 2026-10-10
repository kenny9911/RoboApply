// @vitest-environment node
import express from 'express';
import type { Server } from 'node:http';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
vi.mock('../lib/prisma.js', () => ({ default: {} }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (_req: any, _res: any, next: any) => next() }));
vi.mock('../services/LoggerService.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
import { createJobSearchRouters } from './routes.js';
import { JobSearchAccessError } from './keys.js';
import { JobSearchAiOffError, JobSearchAiUnavailableError, JobSearchPhoneBindingError } from './agent.js';
import { SearchQuotaError } from './quota.js';
import { JobSearchValidationError } from './validation.js';
import { getBrand } from '../platform/brand/registry.js';

const emptyResult = {
  jobs: [], meta: { totalReturned: 0, deduplicated: 0, partial: false, searchedAt: '2026-09-12T00:00:00Z', cache: 'miss', providers: [{ id: 'jsearch', name: 'JSearch', status: 'empty', resultCount: 0 }] },
};
const service = { providers: vi.fn(), search: vi.fn() };
const keys = { authenticate: vi.fn(), list: vi.fn(), create: vi.fn(), revoke: vi.fn() };
const quota = { reserve: vi.fn(), finish: vi.fn() };
const agent = { search: vi.fn() };
let server: Server;
let base: string;
/** The environment the routers read (the capability gate). Empty = every default. */
let env: NodeJS.ProcessEnv = {};

beforeAll(async () => {
  const app = express(); app.use(express.json());
  const routers = createJobSearchRouters({ service: service as never, keys: keys as never, quota: quota as never, agent, env: () => env, brand: (req) => getBrand(req.get('x-test-brand') === 'goapply' ? 'goapply' : 'roboapply'), sessionAuth: (req, res, next) => {
    if (req.get('x-test-session') !== 'owner') return res.status(401).json({ code: 'AUTH_REQUIRED' });
    req.user = { id: 'owner' } as any;
    if (req.get('x-test-legacy')) req.apiKeyId = 'legacy';
    next();
  } });
  app.use('/api', routers.api); app.use('/website', routers.website);
  server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(() => {
  vi.resetAllMocks();
  env = {};
  service.providers.mockReturnValue([{ id: 'jsearch', name: 'JSearch', enabled: true }]);
  service.search.mockResolvedValue(structuredClone(emptyResult));
  keys.authenticate.mockImplementation(async (auth) => {
    if (auth !== 'Bearer fixture-key') throw new JobSearchAccessError('invalid_api_key', 401, 'Invalid key');
    return { userId: 'owner', apiKeyId: 'key' };
  });
  quota.reserve.mockResolvedValue('reservation'); quota.finish.mockResolvedValue(undefined);
  agent.search.mockResolvedValue({ ...structuredClone(emptyResult), agent: { queries: ['engineer'], mode: 'planned', criteria: { country: 'tw' }, unverifiedPreferences: ['Visa sponsorship'], linkedinOnly: false }, searches: [{ query: 'engineer', providers: emptyResult.meta.providers }] });
});

describe('job-search agent HTTP API', () => {
  const body = { request: 'Find engineering jobs in Taiwan with visa sponsorship.', locale: 'en' };
  const auth = { Authorization: 'Bearer fixture-key' };
  it('publishes the natural-language contract with the existing scoped-key authentication', async () => {
    const doc = await (await fetch(`${base}/api/openapi.json`)).json();
    expect(doc.paths['/agent/search'].post.operationId).toBe('agentSearchJobs');
    expect(doc.components.schemas.AgentSearchInput.required).toEqual(['request']);
    expect(doc.components.schemas.AgentSearchInput.properties.request.maxLength).toBe(2000);
    expect(doc.components.schemas.Source.properties.sourceUrl).toBeDefined();
    expect(doc.security).toEqual([{ JobSearchKey: [] }]);
  });
  it('rejects missing integration authentication before planning', async () => {
    expect((await post('/api/agent/search', body)).status).toBe(401);
    expect(agent.search).not.toHaveBeenCalled();
  });
  it('passes authenticated identity and API audience without double-reserving usage', async () => {
    const res = await post('/api/agent/search', body, auth);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(agent.search).toHaveBeenCalledWith(body, expect.objectContaining({
      userId: 'owner', apiKeyId: 'key', audience: 'api', requestId: res.headers.get('x-request-id'), signal: expect.any(AbortSignal),
    }));
    expect((await res.json()).agent.unverifiedPreferences).toEqual(['Visa sponsorship']);
    expect(quota.reserve).not.toHaveBeenCalled();
  });
  it('only allows sessions onto the website agent and passes website rights', async () => {
    expect((await post('/website/agent/search', body, auth)).status).toBe(401);
    expect((await post('/website/agent/search', body, { 'x-test-session': 'owner', 'x-test-legacy': 'yes' })).status).toBe(403);
    expect(agent.search).not.toHaveBeenCalled();
    expect((await post('/website/agent/search', body, { 'x-test-session': 'owner' })).status).toBe(200);
    expect(agent.search).toHaveBeenCalledWith(body, expect.objectContaining({ userId: 'owner', audience: 'website' }));
  });
  it.each([
    [new JobSearchValidationError('request', 'Describe your search.'), 400, 'invalid_request'],
    [new JobSearchAccessError('agent_unavailable', 503, 'Planning unavailable.'), 503, 'agent_unavailable'],
    [new SearchQuotaError(60), 429, 'rate_limited'],
  ])('returns typed failures and request identifiers: %s', async (error, status, code) => {
    agent.search.mockRejectedValue(error);
    const res = await post('/api/agent/search', body, auth);
    expect(res.status).toBe(status);
    if (status === 429) expect(res.headers.get('retry-after')).toBe('60');
    expect(await res.json()).toMatchObject({ code, requestId: res.headers.get('x-request-id') });
  });
  it('retains partial successes and query diagnostics when the second query reaches quota', async () => {
    const partial = await agent.search();
    partial.meta.partial = true;
    partial.searches.push({ query: 'software engineer', providers: [], error: { code: 'rate_limited', message: 'Limit reached.' } });
    agent.search.mockResolvedValue(partial);
    const res = await post('/api/agent/search', body, auth);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.meta.partial).toBe(true);
    expect(data.searches[1].error.code).toBe('rate_limited');
  });
  it('returns the plan and diagnostics as a 503 when no source responded', async () => {
    const failed = await agent.search();
    failed.meta.providers[0].status = 'timeout'; failed.meta.partial = true;
    agent.search.mockResolvedValue(failed);
    const res = await post('/api/agent/search', body, auth);
    expect(res.status).toBe(503);
    expect((await res.json()).data.agent.queries).toEqual(['engineer']);
  });
  it('sanitizes unexpected dependency failures', async () => {
    agent.search.mockRejectedValue(new Error('postgres://private-credential'));
    const res = await post('/api/agent/search', body, auth);
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('private-credential');
  });
});
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('job-search HTTP API', () => {
  it('serves a usable OpenAPI document without a key and protects source metadata', async () => {
    const doc = await fetch(`${base}/api/openapi.json`);
    expect(doc.status).toBe(200);
    expect((await doc.json()).paths['/search'].post.operationId).toBe('searchJobs');
    expect((await fetch(`${base}/api/providers`)).status).toBe(401);
  });
  it('validates before reserving quota or querying a provider', async () => {
    const res = await post('/api/search', { query: '', country: 'us' }, { Authorization: 'Bearer fixture-key' });
    expect(res.status).toBe(400); expect(quota.reserve).not.toHaveBeenCalled(); expect(service.search).not.toHaveBeenCalled();
  });
  it('uses the API audience, a durable reservation, and an observable request id', async () => {
    const res = await post('/api/search', { query: 'engineer', country: 'tw' }, { Authorization: 'Bearer fixture-key' });
    expect(res.status).toBe(200); expect(res.headers.get('x-request-id')).toBeTruthy();
    expect(service.search).toHaveBeenCalledWith(expect.objectContaining({ country: 'tw' }), expect.objectContaining({ audience: 'api', requestId: expect.any(String) }));
    // Reserved against the budget of the brand the request is for.
    expect(quota.reserve).toHaveBeenCalledWith('owner', 'key', expect.any(String), expect.objectContaining({ id: 'roboapply' }));
    expect(quota.finish).toHaveBeenCalledWith('reservation', 200, expect.any(Number), 'key');
  });
  it('uses website audience only for sessions and rejects broad legacy API keys', async () => {
    expect((await post('/website/search', { query: 'engineer' })).status).toBe(401);
    expect((await post('/website/search', { query: 'engineer' }, { 'x-test-session': 'owner', 'x-test-legacy': 'yes' })).status).toBe(403);
    expect((await post('/website/search', { query: 'engineer' }, { 'x-test-session': 'owner' })).status).toBe(200);
    expect(service.search).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ audience: 'website' }));
  });
  it('returns 503 diagnostics for unavailable sources without claiming an empty success', async () => {
    service.providers.mockReturnValue([{ id: 'jsearch', enabled: false }]);
    service.search.mockResolvedValue({ jobs: [], meta: { ...emptyResult.meta, partial: true, providers: [{ id: 'jsearch', name: 'JSearch', status: 'unavailable', resultCount: 0 }] } });
    const res = await post('/api/search', { query: 'engineer' }, { Authorization: 'Bearer fixture-key' });
    expect(res.status).toBe(503); expect((await res.json()).data.meta.partial).toBe(true); expect(quota.reserve).not.toHaveBeenCalled();
    expect(service.search).not.toHaveBeenCalled();
  });
  it('never enters a newly recovered provider without a durable reservation', async () => {
    service.providers.mockReturnValueOnce([{ id: 'jsearch', name: 'JSearch', enabled: false, reason: 'budget_or_circuit' }]);
    const res = await post('/api/search', { query: 'engineer' }, { Authorization: 'Bearer fixture-key' });
    expect(res.status).toBe(503);
    expect(service.search).not.toHaveBeenCalled();
    expect(quota.reserve).not.toHaveBeenCalled();
  });
  it('protects key creation and revocation with owner sessions', async () => {
    const created = { key: { id: 'owned-key' }, token: 'once-only-fixture' };
    keys.create.mockResolvedValue(created); keys.revoke.mockResolvedValue(undefined);
    expect((await post('/website/keys', { name: 'App' }, { Authorization: 'Bearer fixture-key' })).status).toBe(401);
    expect(keys.create).not.toHaveBeenCalled();
    const create = await post('/website/keys', { name: 'App' }, { 'x-test-session': 'owner' });
    expect(create.status).toBe(201);
    expect(create.headers.get('cache-control')).toBe('no-store');
    expect(keys.create).toHaveBeenCalledWith('owner', { name: 'App' });
    const revoke = await fetch(`${base}/website/keys/owned-key`, { method: 'DELETE', headers: { 'x-test-session': 'owner' } });
    expect(revoke.status).toBe(204);
    expect(keys.revoke).toHaveBeenCalledWith('owner', 'owned-key');
  });
  it('returns Retry-After and never invokes paid work after quota rejection', async () => {
    quota.reserve.mockRejectedValue(new SearchQuotaError(60));
    const res = await post('/api/search', { query: 'engineer' }, { Authorization: 'Bearer fixture-key' });
    expect(res.status).toBe(429); expect(res.headers.get('retry-after')).toBe('60'); expect(service.search).not.toHaveBeenCalled();
  });
  it('fails closed with a sanitized response when quota storage fails', async () => {
    quota.reserve.mockRejectedValue(new Error('postgres://private-credential'));
    const res = await post('/api/search', { query: 'engineer' }, { Authorization: 'Bearer fixture-key' });
    expect(res.status).toBe(503); expect(await res.text()).not.toContain('private-credential'); expect(service.search).not.toHaveBeenCalled();
  });
});

describe('job-search API on GoApply (D5: the same API, GoApply sources)', () => {
  const GO = { 'x-test-brand': 'goapply' };
  const key = { Authorization: 'Bearer fixture-key' };
  const session = { 'x-test-session': 'owner' };
  const get = (path: string, headers: Record<string, string>) => fetch(`${base}${path}`, { headers });
  const indexResult = () => ({
    jobs: [{ id: 'job_1', title: '数据分析师', company: '示例科技', applyUrl: 'https://careers.example.cn/jobs/1', sourceUrl: 'https://careers.example.cn/jobs/1', provider: 'index',
      sources: [{ provider: 'index', id: 'index:j1', applyUrl: 'https://careers.example.cn/jobs/1', publisher: '示例科技', sourceUrl: 'https://careers.example.cn/jobs/1' }] }],
    meta: { totalReturned: 1, deduplicated: 0, partial: false, searchedAt: '2026-10-11T00:00:00Z', cache: 'miss', providers: [{ id: 'index', name: 'Job index', status: 'ok', resultCount: 1 }] },
  });
  beforeEach(() => {
    env = {};
    service.providers.mockImplementation((_audience: string, brand: { market: string }) => (brand.market === 'cn'
      ? [{ id: 'index', name: 'Job index', enabled: true }] : [{ id: 'jsearch', name: 'JSearch', enabled: true }]));
  });

  it('keyword search is served from the brand sources, with the brand, the reader and the brand default country', async () => {
    service.search.mockResolvedValue(indexResult());
    const res = await post('/website/search', { query: '数据分析师' }, { ...GO, ...session });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobs[0]).toMatchObject({ provider: 'index', applyUrl: 'https://careers.example.cn/jobs/1' });
    expect(body.jobs[0].sources[0].publisher).toBe('示例科技');
    expect(service.providers).toHaveBeenCalledWith('website', expect.objectContaining({ id: 'goapply' }));
    expect(service.search).toHaveBeenCalledWith(expect.objectContaining({ query: '数据分析师', country: 'cn' }),
      expect.objectContaining({ audience: 'website', userId: 'owner', brand: expect.objectContaining({ id: 'goapply' }) }));
  });

  it('an integration key is checked against the brand of the host it is sent to', async () => {
    service.search.mockResolvedValue(indexResult());
    expect((await post('/api/search', { query: '数据分析师' }, { ...GO, ...key })).status).toBe(200);
    expect(keys.authenticate).toHaveBeenLastCalledWith('Bearer fixture-key', 'goapply');
    expect((await post('/api/search', { query: 'engineer' }, key)).status).toBe(200);
    expect(keys.authenticate).toHaveBeenLastCalledWith('Bearer fixture-key', 'roboapply');
    expect(service.search).toHaveBeenLastCalledWith(expect.objectContaining({ country: 'us' }), expect.objectContaining({ userId: 'owner', brand: expect.objectContaining({ id: 'roboapply' }) }));
  });

  it('a key of the other brand is refused: 401 before quota or search', async () => {
    keys.authenticate.mockImplementation(async (_auth: string, brandId: string) => {
      if (brandId !== 'roboapply') throw new JobSearchAccessError('invalid_api_key', 401, 'This API key is invalid, expired, or revoked.');
      return { userId: 'owner', apiKeyId: 'key' };
    });
    const res = await post('/api/search', { query: '数据分析师' }, { ...GO, ...key });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(quota.reserve).not.toHaveBeenCalled(); expect(service.search).not.toHaveBeenCalled();
  });

  it('the planner gets the brand; each refusal of its gate is a typed answer (phone binding, AI consent, AI text off)', async () => {
    const body = { request: '找上海的产品经理职位，最近一周发布' };
    expect((await post('/website/agent/search', body, { ...GO, ...session })).status).toBe(200);
    expect(agent.search).toHaveBeenCalledWith(body, expect.objectContaining({ userId: 'owner', audience: 'website', brand: expect.objectContaining({ id: 'goapply' }) }));
    for (const [error, status, code] of [
      [new JobSearchPhoneBindingError(), 403, 'phone_binding_required'],
      [new JobSearchAiOffError(), 403, 'ai_off'],
      [new JobSearchAiUnavailableError(), 503, 'ai_unavailable'],
    ] as const) {
      agent.search.mockRejectedValue(error);
      for (const [path, headers] of [['/api/agent/search', { ...GO, ...key }], ['/website/agent/search', { ...GO, ...session }]] as const) {
        const refused = await post(path, body, headers);
        expect(refused.status, `${code} ${path}`).toBe(status);
        expect(await refused.json(), `${code} ${path}`).toMatchObject({ code, requestId: refused.headers.get('x-request-id') });
      }
    }
  });

  it('keyword search reserves usage against the GoApply budget', async () => {
    service.search.mockResolvedValue(indexResult());
    expect((await post('/api/search', { query: '数据分析师' }, { ...GO, ...key })).status).toBe(200);
    expect(quota.reserve).toHaveBeenCalledWith('owner', 'key', expect.any(String), expect.objectContaining({ id: 'goapply' }));
  });

  it('the key list says what a key of this brand can read: the sources as a key sees them', async () => {
    keys.list.mockResolvedValue({ keys: [] });
    service.providers.mockImplementation((audience: string, brand: { market: string }) => (brand.market === 'cn'
      ? [{ id: 'index', name: 'Job index', enabled: audience !== 'api', ...(audience === 'api' ? { reason: 'not_licensed' } : {}) }]
      : [{ id: 'jsearch', name: 'JSearch', enabled: true }]));
    const cn = await (await get('/website/keys', { ...GO, ...session })).json();
    expect(cn).toEqual({ keys: [], sources: [{ id: 'index', name: 'Job index', enabled: false, reason: 'not_licensed' }] });
    expect(service.providers).toHaveBeenLastCalledWith('api', expect.objectContaining({ id: 'goapply' }));
    const intl = await (await get('/website/keys', session)).json();
    expect(intl.sources).toEqual([{ id: 'jsearch', name: 'JSearch', enabled: true }]);
    expect(service.providers).toHaveBeenLastCalledWith('api', expect.objectContaining({ id: 'roboapply' }));
  });

  it('the key workspace works on GoApply and the OpenAPI document names the brand, its country and its source', async () => {
    keys.list.mockResolvedValue({ keys: [] });
    keys.create.mockResolvedValue({ key: { id: 'k1' }, token: 'once-only-fixture' });
    expect((await get('/website/keys', { ...GO, ...session })).status).toBe(200);
    expect((await post('/website/keys', { name: 'App' }, { ...GO, ...session })).status).toBe(201);
    expect(keys.create).toHaveBeenCalledWith('owner', { name: 'App' });
    const cn = await (await get('/api/openapi.json', GO)).json();
    expect(cn.info.title).toBe(`${getBrand('goapply').name} Job Search API`);
    expect(JSON.stringify(cn)).not.toMatch(/RoboApply|Taipei|Taiwan/);
    expect(cn.components.schemas.SearchInput.properties.country.default).toBe('cn');
    expect(cn.paths['/agent/search'].post.responses['403'].description).toMatch(/phone_binding_required.*ai_off/);
    expect(cn.paths['/agent/search'].post.responses['503'].description).toContain('ai_unavailable');
    // Key access to the index is the operator's grant, and the document says so.
    expect(cn.info.description).toMatch(/only after the site operator has turned key access on/);
    expect(cn.info.description).toContain('the recruiter bank');
    expect(cn.components.schemas.AgentSearchInput.properties.linkedinOnly.description).toContain('400 invalid_request');
    expect(cn.components.schemas.Provider.properties.sourceType.enum).toContain('index');
    const intl = await (await get('/api/openapi.json', {})).json();
    expect(intl.info.title).toBe('RoboApply Job Search API');
    expect(intl.components.schemas.SearchInput.properties.country.default).toBe('us');
    expect(intl.paths['/agent/search'].post.responses['403']).toBeUndefined();
  });

  it('CN_RECRUITMENT_INFO_MODE=off: every route of both routers answers 404 feature_disabled before any key, session, quota, source or planner call', async () => {
    env = { CN_RECRUITMENT_INFO_MODE: 'off' };
    keys.list.mockResolvedValue({ keys: [] });
    const calls: Array<[string, Promise<Response>]> = [
      ['GET /api/openapi.json', get('/api/openapi.json', GO)],
      ['GET /api/providers', get('/api/providers', { ...GO, ...key })],
      ['POST /api/search', post('/api/search', { query: 'engineer', country: 'cn' }, { ...GO, ...key })],
      ['POST /api/agent/search', post('/api/agent/search', { request: '找上海的产品经理职位' }, { ...GO, ...key })],
      ['GET /website/providers', get('/website/providers', { ...GO, ...session })],
      ['POST /website/search', post('/website/search', { query: 'engineer' }, { ...GO, ...session })],
      ['POST /website/agent/search', post('/website/agent/search', { request: '找上海的产品经理职位' }, { ...GO, ...session })],
      ['GET /website/keys', get('/website/keys', { ...GO, ...session })],
      ['POST /website/keys', post('/website/keys', { name: 'App' }, { ...GO, ...session })],
      ['DELETE /website/keys/k1', fetch(`${base}/website/keys/k1`, { method: 'DELETE', headers: { ...GO, ...session } })],
      // No credentials at all: still 404, not 401 (the product is not there to sign in to).
      ['POST /website/search (no session)', post('/website/search', { query: 'engineer' }, GO)],
    ];
    for (const [route, pending] of calls) {
      const res = await pending;
      expect(res.status, route).toBe(404);
      expect(await res.json(), route).toMatchObject({ code: 'feature_disabled', requestId: res.headers.get('x-request-id') });
    }
    for (const fn of [keys.authenticate, keys.list, keys.create, keys.revoke, quota.reserve, service.providers, service.search, agent.search]) expect(fn).not.toHaveBeenCalled();
  });

  it('the off switch is GoApply-only: RoboApply is served with it set, and unknown mode values leave GoApply on', async () => {
    env = { CN_RECRUITMENT_INFO_MODE: 'off' };
    expect((await get('/api/openapi.json', {})).status).toBe(200);
    expect((await post('/api/agent/search', { request: 'Find engineering jobs.' }, key)).status).toBe(200);
    expect((await post('/website/search', { query: 'engineer' }, session)).status).toBe(200);
    env = { CN_RECRUITMENT_INFO_MODE: 'partner_deeplink' };
    expect((await get('/api/openapi.json', GO)).status).toBe(200);
  });
});
