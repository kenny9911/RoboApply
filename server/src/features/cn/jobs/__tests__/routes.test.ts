// @vitest-environment node
// WP-41: seeker deep-link route and admin fraud/blacklist routes (route
// harness, injected auth and fake service; no DB).
// MKT-3G (JC-5): the links come in the order of the user's audience: the
// explicit `audience`, else their identity answer (faked here).

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), setRequestUserId: vi.fn() }));
vi.mock('../../../../services/LoggerService.js', () => ({ logger: log }));

import { fakeAuth, startRouteHarness, type RouteHarness } from '../../../../test/routeHarness.js';
import { CN_EXTERNAL_BOARD_SPECS, isVerified, type BoardSpec } from '../deeplinks.js';
import { createCnJobsAdminRouter, createCnJobsRouter } from '../routes.js';
import { cnJob, fakeDeps } from './testkit.js';

const GA = 'goapply.localhost:3621';
const RA = 'localhost:3621';
const deps = fakeDeps();
deps.repo.jobs.set('job_a', cnJob({ id: 'job_a', fraudFlags: [{ rule: 'gambling', evidence: '博彩平台', at: '2026-10-02T00:00:00.000Z', method: 'keywords' }] }));

const LINKS = '/api/v1/roboapply/cn/jobs/external-links';
const NINE = '/nine/cn/jobs/external-links';
const CAMPUS = ['shixiseng', 'nowcoder', 'ncss', 'iguopin'];
const EXPERIENCED = ['boss', 'zhaopin', 'liepin', 'job51', 'lagou'];

/**
 * SYNTHETIC. The real table with every unconfirmed board switched on at a
 * made-up address under the reserved `.test` domain, so the order is tested
 * through the route for all nine boards. None of these is a real search page.
 */
const ALL_NINE: BoardSpec[] = CN_EXTERNAL_BOARD_SPECS.map((s) =>
  isVerified(s) ? s : { ...s, host: `${s.board}.search.test`, url: (k: string) => `https://${s.board}.search.test/jobs?q=${encodeURIComponent(k)}`, verifiedOn: '2026-10-11' },
);

/** userId → the identity answer the faked reader gives. */
const IDENTITIES: Record<string, string | null> = { u_zaixiao: 'zaixiao', u_yingjie: 'yingjie', u_shezhao: 'shezhao', u_none: null, u_other: 'wangjie' };
const cnIdentity = vi.fn(async (userId: string) => {
  if (userId === 'u_broken') throw new Error('database down');
  return IDENTITIES[userId] ?? null;
});

type LinksBody = { data: { links: Array<{ board: string; label: string; url: string; audience: string }> } };
const as = (userId: string) => ({ 'x-test-user': userId });

let h: RouteHarness;
beforeAll(async () => {
  // Signed in as `x-test-user` (default u1); `x-test-user: none` is a signed-out request.
  const seeker = fakeAuth((req) => (req.headers['x-test-user'] === 'none' ? null : { id: String(req.headers['x-test-user'] ?? 'u1'), role: 'seeker' }));
  const admin = fakeAuth((req) => (req.headers['x-test-role'] === 'admin' ? { id: 'admin_1', role: 'admin' } : null));
  h = await startRouteHarness({
    mounts: [
      ['/api/v1/roboapply/cn/jobs', createCnJobsRouter({ seekerAuth: [seeker], cnIdentity })],
      ['/nine/cn/jobs', createCnJobsRouter({ seekerAuth: [seeker], cnIdentity, boardSpecs: ALL_NINE })],
      ['/api/v1/roboapply/admin/cn/jobs', createCnJobsAdminRouter({ adminAuth: [admin], service: deps })],
    ],
  });
});
afterAll(() => h.close());

const asAdmin = { 'x-test-role': 'admin' };

describe('GET /cn/jobs/external-links', () => {
  it('GoApply: links built from the query', async () => {
    const res = await h.request<LinksBody>('GET', `${LINKS}?q=%E4%BA%A7%E5%93%81%E7%BB%8F%E7%90%86`, { host: GA });
    expect(res.status).toBe(200);
    // Only the boards whose search URL pattern is confirmed are offered.
    expect(res.body.data.links.map((l) => l.board)).toEqual(CN_EXTERNAL_BOARD_SPECS.filter(isVerified).map((s) => s.board));
    expect(res.body.data.links.slice(0, 3).map((l) => [l.board, l.audience])).toEqual([
      ['boss', 'experienced'],
      ['zhaopin', 'experienced'],
      ['liepin', 'experienced'],
    ]);
    expect(res.body.data.links[0]!.url).toBe(`https://www.zhipin.com/web/geek/job?query=${encodeURIComponent('产品经理')}`);
  });
  it('RoboApply: 404 feature_disabled', async () => {
    const res = await h.request<{ code: string }>('GET', `${LINKS}?q=x`, { host: RA });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('feature_disabled');
    expect((await h.request<{ code: string }>('GET', `${LINKS}?q=x&audience=campus`, { host: RA })).body.code).toBe('feature_disabled');
  });
  it('empty query → 422', async () => {
    expect((await h.request('GET', `${LINKS}?q=`, { host: GA })).status).toBe(422);
  });
  it('still needs a signed-in user', async () => {
    cnIdentity.mockClear();
    for (const path of [`${LINKS}?q=x`, `${LINKS}?q=x&audience=campus`, `${NINE}?q=x`]) {
      expect((await h.request('GET', path, { host: GA, headers: as('none') })).status).toBe(401);
    }
    expect(cnIdentity).not.toHaveBeenCalled();
  });

  it('a 校招 user (在校生 or 应届) gets the campus boards first, then the five general boards', async () => {
    for (const user of ['u_zaixiao', 'u_yingjie']) {
      const res = await h.request<LinksBody>('GET', `${NINE}?q=${encodeURIComponent('管培生')}&city=${encodeURIComponent('成都')}`, { host: GA, headers: as(user) });
      expect(res.status).toBe(200);
      expect(res.body.data.links.map((l) => l.board)).toEqual([...CAMPUS, ...EXPERIENCED]);
      expect(res.body.data.links.map((l) => l.label)).toEqual(['实习僧', '牛客', '24365', '国聘', 'BOSS直聘', '智联招聘', '猎聘', '前程无忧', '拉勾']);
      expect(res.body.data.links.map((l) => l.audience)).toEqual([...CAMPUS.map(() => 'campus'), ...EXPERIENCED.map(() => 'experienced')]);
      for (const l of res.body.data.links) expect([...new URL(l.url).searchParams.values()]).toEqual(['管培生 成都']);
    }
  });

  it('an experienced user, a user with no identity answer and a failed identity read get the general boards first', async () => {
    log.warn.mockClear();
    for (const user of ['u_shezhao', 'u_none', 'u_other']) {
      const res = await h.request<LinksBody>('GET', `${NINE}?q=x`, { host: GA, headers: as(user) });
      expect(res.status).toBe(200);
      expect(res.body.data.links.map((l) => l.board)).toEqual([...EXPERIENCED, ...CAMPUS]);
    }
    expect(log.warn).not.toHaveBeenCalled();
    // The failed read still answers the links, and leaves one warning that does not name the user.
    const broken = await h.request<LinksBody>('GET', `${NINE}?q=x`, { host: GA, headers: as('u_broken') });
    expect(broken.status).toBe(200);
    expect(broken.body.data.links.map((l) => l.board)).toEqual([...EXPERIENCED, ...CAMPUS]);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith('CN_JOBS', expect.stringContaining('identity read failed'), { error: 'database down' });
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('u_broken');
  });

  it('an explicit audience wins over the profile, and the identity is not read', async () => {
    cnIdentity.mockClear();
    const campus = await h.request<LinksBody>('GET', `${NINE}?q=x&audience=campus`, { host: GA, headers: as('u_shezhao') });
    expect(campus.body.data.links.map((l) => l.board)).toEqual([...CAMPUS, ...EXPERIENCED]);
    const experienced = await h.request<LinksBody>('GET', `${NINE}?q=x&audience=experienced`, { host: GA, headers: as('u_zaixiao') });
    expect(experienced.body.data.links.map((l) => l.board)).toEqual([...EXPERIENCED, ...CAMPUS]);
    expect(cnIdentity).not.toHaveBeenCalled();
    await h.request('GET', `${NINE}?q=x`, { host: GA, headers: as('u_zaixiao') });
    expect(cnIdentity).toHaveBeenCalledWith('u_zaixiao');
  });

  it('an unknown audience → 422', async () => {
    for (const bad of ['both', 'student', '']) {
      const res = await h.request<{ code: string }>('GET', `${NINE}?q=x&audience=${bad}`, { host: GA });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('invalid_request');
    }
  });

  it('the links carry nothing about the user: only the query and the city they typed', async () => {
    const res = await h.request<LinksBody>('GET', `${NINE}?q=${encodeURIComponent('数据分析')}&audience=campus`, { host: GA, headers: as('u_zaixiao') });
    const text = JSON.stringify(res.body);
    for (const leak of ['u_zaixiao', 'zaixiao', 'userId', 'utm_', 'ref=']) expect(text).not.toContain(leak);
    for (const l of res.body.data.links) {
      expect(Object.keys(l).sort()).toEqual(['audience', 'board', 'label', 'url']);
      expect([...new URL(l.url).searchParams.values()]).toEqual(['数据分析']);
    }
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
