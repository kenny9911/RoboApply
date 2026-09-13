// @vitest-environment node
import express from 'express';
import type { Server } from 'node:http';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
vi.mock('../lib/prisma.js', () => ({ default: {} }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (_req: any, _res: any, next: any) => next() }));
vi.mock('../services/LoggerService.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
import { createJobSearchRouters } from './routes.js';
import { JobSearchAccessError } from './keys.js';
import { SearchQuotaError } from './quota.js';

const emptyResult = {
  jobs: [], meta: { totalReturned: 0, deduplicated: 0, partial: false, searchedAt: '2026-09-12T00:00:00Z', cache: 'miss', providers: [{ id: 'jsearch', name: 'JSearch', status: 'empty', resultCount: 0 }] },
};
const service = { providers: vi.fn(), search: vi.fn() };
const keys = { authenticate: vi.fn(), list: vi.fn(), create: vi.fn(), revoke: vi.fn() };
const quota = { reserve: vi.fn(), finish: vi.fn() };
let server: Server;
let base: string;

beforeAll(async () => {
  const app = express(); app.use(express.json());
  const routers = createJobSearchRouters({ service: service as never, keys: keys as never, quota: quota as never, sessionAuth: (req, res, next) => {
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
  service.providers.mockReturnValue([{ id: 'jsearch', name: 'JSearch', enabled: true }]);
  service.search.mockResolvedValue(structuredClone(emptyResult));
  keys.authenticate.mockImplementation(async (auth) => {
    if (auth !== 'Bearer fixture-key') throw new JobSearchAccessError('invalid_api_key', 401, 'Invalid key');
    return { userId: 'owner', apiKeyId: 'key' };
  });
  quota.reserve.mockResolvedValue('reservation'); quota.finish.mockResolvedValue(undefined);
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
    expect(quota.reserve).toHaveBeenCalledWith('owner', 'key', expect.any(String));
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
