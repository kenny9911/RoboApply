// @vitest-environment node
// WP-58 routes (route harness, injected auth and in-memory service; no DB,
// no network): capability off ⇒ 404 feature_disabled (GoApply: on by default,
// off only with CN_CAMPUS_CALENDAR_ENABLED=false); public reads are
// CDN-cacheable and carry the source; admin only for curation; nothing is
// published without verification.

import type { Request, RequestHandler } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../../../test/routeHarness.js';
import { setFlagOverrideLoader } from '../../../../platform/flags.js';
import { CAMPUS_PUBLIC_CACHE, createCampusAdminRouter, createCampusEventsRouter, createCampusPublicRouter } from '../routes.js';
import type { CampusEventList } from '../contract.js';
import { DAY, NOW, eventRow, fakeCampusRepo, recordingLlm, serviceDeps } from './testkit.js';

const GA = 'goapply.localhost:3621';
const RA = 'localhost:3621';
const ENV = { CN_CAMPUS_CALENDAR_ENABLED: 'true' };

const repo = fakeCampusRepo([
  eventRow({ id: 'ev_a', applyClosesAt: new Date(NOW.getTime() + 5 * DAY) }),
  eventRow({ id: 'ev_draft', status: 'draft', verifiedAt: null }),
]);
const llm = recordingLlm(JSON.stringify({ companyName: { value: '示例科技', quote: '示例科技 2027届校园招聘' } }));
const service = serviceDeps(repo, { llm, env: ENV });

const optional: RequestHandler = (req, _res, next) => {
  if (req.headers['x-test-user']) (req as Request & { user?: { id: string } }).user = { id: String(req.headers['x-test-user']) };
  next();
};

let h: RouteHarness;
beforeAll(async () => {
  setFlagOverrideLoader(async () => []);
  const seeker = fakeAuth((req) => (req.headers['x-test-user'] ? { id: String(req.headers['x-test-user']), role: 'seeker' } : null));
  const admin = fakeAuth((req) => (req.headers['x-test-role'] === 'admin' ? { id: 'admin_1', role: 'admin' } : null));
  const deps = { env: ENV, service, seekerAuth: [seeker], optionalAuth: [optional], adminAuth: [admin] };
  h = await startRouteHarness({
    env: ENV,
    mounts: [
      ['/api/v1/roboapply/cn/campus-events', createCampusEventsRouter(deps)],
      ['/api/v1/public/campus', createCampusPublicRouter(deps)],
      ['/api/v1/roboapply/admin/cn/campus', createCampusAdminRouter(deps)],
    ],
  });
});
afterAll(async () => {
  setFlagOverrideLoader(null);
  await h.close();
});

const asAdmin = { 'x-test-role': 'admin' };
const asUser = { 'x-test-user': 'u1' };

describe('capability', () => {
  it('RoboApply (capability off): every seeker and public route answers 404 feature_disabled', async () => {
    for (const path of ['/api/v1/roboapply/cn/campus-events', '/api/v1/roboapply/cn/campus-events/ev_a', '/api/v1/public/campus', '/api/v1/public/campus/companies/x']) {
      const res = await h.request<{ code: string }>('GET', path, { host: RA, headers: asUser });
      expect(res.status, path).toBe(404);
      expect(res.body.code).toBe('feature_disabled');
    }
  });

  it('GoApply with no CN_ value at all: the calendar is on (200); RoboApply stays off', async () => {
    const plain = await startRouteHarness({ env: {}, mounts: [['/api/v1/public/campus', createCampusPublicRouter({ env: {}, service })]] });
    const res = await plain.request<{ data: CampusEventList }>('GET', '/api/v1/public/campus', { host: GA });
    expect(res.status).toBe(200);
    expect(res.body.data.items.map((i) => i.id)).toEqual(['ev_a']);
    expect((await plain.request('GET', '/api/v1/public/campus', { host: RA })).status).toBe(404);
    await plain.close();
  });

  it('GoApply: 404 feature_disabled only with CN_CAMPUS_CALENDAR_ENABLED=false (the off switch), whatever the job-feed mode is', async () => {
    for (const env of [{ CN_CAMPUS_CALENDAR_ENABLED: 'false' }, { CN_CAMPUS_CALENDAR_ENABLED: 'false', CN_RECRUITMENT_INFO_MODE: 'licensed' }] as Array<Record<string, string>>) {
      const off = await startRouteHarness({ env, mounts: [['/api/v1/public/campus', createCampusPublicRouter({ env, service })]] });
      const res = await off.request<{ code: string }>('GET', '/api/v1/public/campus', { host: GA });
      expect(res.status, JSON.stringify(env)).toBe(404);
      expect(res.body.code).toBe('feature_disabled');
      await off.close();
    }
    // The job-feed mode being off does not hide the calendar.
    const feedOff = { CN_RECRUITMENT_INFO_MODE: 'off' };
    const on = await startRouteHarness({ env: feedOff, mounts: [['/api/v1/public/campus', createCampusPublicRouter({ env: feedOff, service })]] });
    expect((await on.request('GET', '/api/v1/public/campus', { host: GA })).status).toBe(200);
    await on.close();
  });
});

describe('public reads', () => {
  it('lists published programmes with source and verification date, cacheable, with asOf', async () => {
    const res = await h.request<{ data: CampusEventList }>('GET', '/api/v1/public/campus?openNow=true', { host: GA });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(CAMPUS_PUBLIC_CACHE);
    expect(res.body.data.asOf).toBe(NOW.toISOString());
    expect(res.body.data.items.map((i) => i.id)).toEqual(['ev_a']);
    expect(res.body.data.items[0]).toMatchObject({ officialUrl: 'https://campus.example.cn/2027', sourceName: '示例科技校园招聘官网', verifiedAt: expect.any(String), subscribed: false });
  });
  it('company page by slug; 404 for an unknown company; 422 for a bad 届别', async () => {
    expect((await h.request('GET', `/api/v1/public/campus/companies/${encodeURIComponent('示例科技')}`, { host: GA })).status).toBe(200);
    expect((await h.request('GET', '/api/v1/public/campus/companies/nobody', { host: GA })).status).toBe(404);
    expect((await h.request('GET', '/api/v1/public/campus?class=1999', { host: GA })).status).toBe(422);
  });
});

describe('seeker routes', () => {
  it('subscriptions need a session', async () => {
    expect((await h.request('GET', '/api/v1/roboapply/cn/campus-events/subscriptions', { host: GA })).status).toBe(401);
  });
  it('remind me → listed as subscribed → unsubscribe', async () => {
    const created = await h.request<{ data: { id: string } }>('POST', '/api/v1/roboapply/cn/campus-events/subscriptions', {
      host: GA,
      headers: asUser,
      body: { kind: 'event', eventId: 'ev_a' },
    });
    expect(created.status).toBe(201);
    const list = await h.request<{ data: CampusEventList }>('GET', '/api/v1/roboapply/cn/campus-events', { host: GA, headers: asUser });
    expect(list.body.data.items.find((i) => i.id === 'ev_a')!.subscribed).toBe(true);
    const one = await h.request<{ data: { subscribed: boolean } }>('GET', '/api/v1/roboapply/cn/campus-events/ev_a', { host: GA, headers: asUser });
    expect(one.body.data.subscribed).toBe(true);
    expect((await h.request('GET', '/api/v1/roboapply/cn/campus-events/ev_draft', { host: GA })).status).toBe(404);
    const del = await h.request('DELETE', `/api/v1/roboapply/cn/campus-events/subscriptions/${created.body.data.id}`, { host: GA, headers: asUser });
    expect(del.status).toBe(200);
  });
  it('follow a company validates the 届别', async () => {
    const bad = await h.request('POST', '/api/v1/roboapply/cn/campus-events/subscriptions', { host: GA, headers: asUser, body: { kind: 'company', companyName: 'x', graduationClass: '2027' } });
    expect(bad.status).toBe(422);
    const ok = await h.request('POST', '/api/v1/roboapply/cn/campus-events/subscriptions', { host: GA, headers: asUser, body: { kind: 'company', companyName: '示例科技', graduationClass: '2027届' } });
    expect(ok.status).toBe(201);
  });
});

describe('admin routes', () => {
  it('require an admin', async () => {
    for (const [m, p] of [
      ['GET', '/events'],
      ['POST', '/events/extract'],
      ['POST', '/events'],
      ['POST', '/events/ev_a/publish'],
    ] as const) {
      expect((await h.request(m, `/api/v1/roboapply/admin/cn/campus${p}`, { host: GA, ...(m === 'GET' ? {} : { body: {} }) })).status, `${m} ${p}`).toBe(401);
    }
  });

  it('extract proposes and saves nothing; create → 409 on publish → verify → publish', async () => {
    const before = repo.events.size;
    const ex = await h.request<{ data: { aiGenerated: boolean } }>('POST', '/api/v1/roboapply/admin/cn/campus/events/extract', {
      host: RA,
      headers: asAdmin,
      body: { officialUrl: 'https://campus.example.cn/2027' },
    });
    expect(ex.status).toBe(200);
    expect(ex.body.data.aiGenerated).toBe(true);
    expect(repo.events.size).toBe(before);

    const agg = await h.request<{ details: { reason: string } }>('POST', '/api/v1/roboapply/admin/cn/campus/events', {
      host: GA,
      headers: asAdmin,
      body: { companyName: '某公司', title: '2027届校园招聘', graduationClass: '2027届', officialUrl: 'https://www.yingjiesheng.com/x' },
    });
    expect(agg.status).toBe(422);
    expect(agg.body.details.reason).toBe('aggregator_source');

    const created = await h.request<{ data: { id: string; status: string } }>('POST', '/api/v1/roboapply/admin/cn/campus/events', {
      host: GA,
      headers: asAdmin,
      body: { companyName: '某公司', title: '2027届校园招聘', graduationClass: '2027届', officialUrl: 'https://campus.example.cn/2027', applyClosesAt: '2026-10-31T15:59:00.000Z' },
    });
    expect(created.status).toBe(201);
    expect(created.body.data.status).toBe('draft');
    const id = created.body.data.id;
    const early = await h.request<{ details: { reason: string } }>('POST', `/api/v1/roboapply/admin/cn/campus/events/${id}/publish`, { host: GA, headers: asAdmin });
    expect(early.status).toBe(409);
    expect(early.body.details.reason).toBe('campus_event_not_verified');
    expect((await h.request('POST', `/api/v1/roboapply/admin/cn/campus/events/${id}/verify`, { host: GA, headers: asAdmin })).status).toBe(200);
    const pub = await h.request<{ data: { status: string; verifiedByUserId: string } }>('POST', `/api/v1/roboapply/admin/cn/campus/events/${id}/publish`, { host: GA, headers: asAdmin });
    expect(pub.status).toBe(200);
    expect(pub.body.data).toMatchObject({ status: 'published', verifiedByUserId: 'admin_1' });

    const listed = await h.request<{ data: { items: Array<{ id: string }> } }>('GET', '/api/v1/roboapply/admin/cn/campus/events?status=published', { host: GA, headers: asAdmin });
    expect(listed.body.data.items.map((i) => i.id)).toContain(id);
    const del = await h.request<{ data: { result: string } }>('DELETE', `/api/v1/roboapply/admin/cn/campus/events/${id}`, { host: GA, headers: asAdmin });
    expect(del.body.data.result).toBe('archived');
  });

  it('PATCH with one field keeps every other field, the verification and the published status', async () => {
    const stages = [{ kind: 'bishi' as const, startsAt: '2026-11-05T01:00:00.000Z' }, { kind: 'mianshi' as const, note: '线下' }];
    const verifiedAt = new Date(NOW.getTime() - DAY);
    repo.events.set('ev_patch', eventRow({ id: 'ev_patch', kind: 'test', stages, cities: ['北京', '上海'], roles: ['产品', '研发'], verifiedAt }));
    const res = await h.request<{ data: { status: string; kind: string; stages: unknown; cities: string[]; roles: string[]; sourceNote: string; verifiedAt: string; verifiedByUserId: string } }>(
      'PATCH',
      '/api/v1/roboapply/admin/cn/campus/events/ev_patch',
      { host: GA, headers: asAdmin, body: { sourceNote: '官网公告' } },
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      status: 'published',
      kind: 'test',
      stages,
      cities: ['北京', '上海'],
      roles: ['产品', '研发'],
      sourceNote: '官网公告',
      verifiedAt: verifiedAt.toISOString(),
      verifiedByUserId: 'admin_1',
    });
    const stored = repo.events.get('ev_patch')!;
    expect(stored).toMatchObject({ status: 'published', kind: 'test', stages, cities: ['北京', '上海'], roles: ['产品', '研发'] });
    expect(stored.verifiedAt?.getTime()).toBe(verifiedAt.getTime());

    // A changed fact still clears the verification and takes it off the calendar.
    const edited = await h.request<{ data: { status: string; verifiedAt: string | null; cities: string[] } }>('PATCH', '/api/v1/roboapply/admin/cn/campus/events/ev_patch', {
      host: GA,
      headers: asAdmin,
      body: { cities: ['深圳'] },
    });
    expect(edited.body.data).toMatchObject({ status: 'draft', verifiedAt: null, cities: ['深圳'] });
    expect(repo.events.get('ev_patch')!.roles).toEqual(['产品', '研发']);
  });
});
