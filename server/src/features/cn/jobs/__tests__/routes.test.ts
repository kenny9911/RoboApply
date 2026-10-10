// @vitest-environment node
// WP-41: seeker deep-link route and admin fraud/blacklist routes (route
// harness, injected auth and fake service; no DB).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../../../test/routeHarness.js';
import { createCnJobsAdminRouter, createCnJobsRouter } from '../routes.js';
import { cnJob, fakeDeps } from './testkit.js';

const GA = 'goapply.localhost:3621';
const RA = 'localhost:3621';
const deps = fakeDeps();
deps.repo.jobs.set('job_a', cnJob({ id: 'job_a', fraudFlags: [{ rule: 'gambling', evidence: '博彩平台', at: '2026-10-02T00:00:00.000Z', method: 'keywords' }] }));

let h: RouteHarness;
beforeAll(async () => {
  const seeker = fakeAuth({ id: 'u1', role: 'seeker' });
  const admin = fakeAuth((req) => (req.headers['x-test-role'] === 'admin' ? { id: 'admin_1', role: 'admin' } : null));
  h = await startRouteHarness({
    mounts: [
      ['/api/v1/roboapply/cn/jobs', createCnJobsRouter({ seekerAuth: [seeker] })],
      ['/api/v1/roboapply/admin/cn/jobs', createCnJobsAdminRouter({ adminAuth: [admin], service: deps })],
    ],
  });
});
afterAll(() => h.close());

const asAdmin = { 'x-test-role': 'admin' };

describe('GET /cn/jobs/external-links', () => {
  it('GoApply: links built from the query', async () => {
    const res = await h.request<{ data: { links: Array<{ board: string; url: string }> } }>('GET', '/api/v1/roboapply/cn/jobs/external-links?q=%E4%BA%A7%E5%93%81%E7%BB%8F%E7%90%86', { host: GA });
    expect(res.status).toBe(200);
    expect(res.body.data.links.map((l) => l.board)).toEqual(['boss', 'zhaopin', 'liepin']);
    expect(res.body.data.links[0]!.url).toContain(encodeURIComponent('产品经理'));
  });
  it('RoboApply: 404 feature_disabled', async () => {
    const res = await h.request<{ code: string }>('GET', '/api/v1/roboapply/cn/jobs/external-links?q=x', { host: RA });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('feature_disabled');
  });
  it('empty query → 422', async () => {
    expect((await h.request('GET', '/api/v1/roboapply/cn/jobs/external-links?q=', { host: GA })).status).toBe(422);
  });
});

describe('admin routes', () => {
  it('require an admin', async () => {
    expect((await h.request('GET', '/api/v1/roboapply/admin/cn/jobs/fraud', { host: GA })).status).toBe(401);
  });

  it('list → resolve → cleared list', async () => {
    const list = await h.request<{ data: { items: Array<{ jobId: string }> } }>('GET', '/api/v1/roboapply/admin/cn/jobs/fraud', { host: GA, headers: asAdmin });
    expect(list.status).toBe(200);
    expect(list.body.data.items.map((i) => i.jobId)).toEqual(['job_a']);
    const bad = await h.request('POST', '/api/v1/roboapply/admin/cn/jobs/fraud/job_a/resolve', { host: GA, headers: asAdmin, body: { decision: 'maybe' } });
    expect(bad.status).toBe(422);
    const res = await h.request<{ data: { status: string } }>('POST', '/api/v1/roboapply/admin/cn/jobs/fraud/job_a/resolve', { host: GA, headers: asAdmin, body: { decision: 'clear' } });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('cleared');
    const cleared = await h.request<{ data: { items: Array<{ jobId: string }> } }>('GET', '/api/v1/roboapply/admin/cn/jobs/fraud?status=cleared', { host: GA, headers: asAdmin });
    expect(cleared.body.data.items.map((i) => i.jobId)).toEqual(['job_a']);
    const missing = await h.request('POST', '/api/v1/roboapply/admin/cn/jobs/fraud/nope/resolve', { host: GA, headers: asAdmin, body: { decision: 'clear' } });
    expect(missing.status).toBe(404);
  });

  it('blacklist CRUD', async () => {
    const created = await h.request<{ data: { id: string } }>('POST', '/api/v1/roboapply/admin/cn/jobs/blacklist', {
      host: GA,
      headers: asAdmin,
      body: { employerName: '某某培训学校', reason: '培训贷' },
    });
    expect(created.status).toBe(201);
    const dup = await h.request<{ code: string }>('POST', '/api/v1/roboapply/admin/cn/jobs/blacklist', { host: GA, headers: asAdmin, body: { employerName: '某某培训学校', reason: 'x' } });
    expect(dup.status).toBe(409);
    const list = await h.request<{ data: { items: unknown[] } }>('GET', '/api/v1/roboapply/admin/cn/jobs/blacklist', { host: GA, headers: asAdmin });
    expect(list.body.data.items).toHaveLength(1);
    const del = await h.request('DELETE', `/api/v1/roboapply/admin/cn/jobs/blacklist/${created.body.data.id}`, { host: GA, headers: asAdmin });
    expect(del.status).toBe(200);
    expect((await h.request('DELETE', `/api/v1/roboapply/admin/cn/jobs/blacklist/${created.body.data.id}`, { host: GA, headers: asAdmin })).status).toBe(404);
    expect((await h.request('POST', '/api/v1/roboapply/admin/cn/jobs/blacklist', { host: GA, headers: asAdmin, body: { employerName: '' } })).status).toBe(422);
  });
});
