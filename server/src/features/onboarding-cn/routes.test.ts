// @vitest-environment node
//
// WP-31 routes (mounted by INT at /api/v1/roboapply/onboarding/cn): auth,
// GoApply-only (feature_disabled on RoboApply), schools, places, defaults and
// the market snapshot over the fake Prisma. No network, no database.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Prisma } from '../../generated/prisma/client.js';
import { createFakePrisma } from '../../test/fakePrisma.js';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import { createOnboardingCnRouter } from './routes.js';

const P = '/api/v1/roboapply/onboarding/cn';
const GO = 'goapply.localhost:3611';
const RA = 'localhost:3611';
const NOW = new Date('2026-10-10T04:00:00Z');

let currentUser: { id: string } | null = { id: 'u1' };
const fake = createFakePrisma({
  seed: {
    rAJob: [
      {
        market: 'cn', visibility: 'public', isCanonical: true, archivedAt: null, closedAt: null, fraudFlags: Prisma.DbNull, lastSeenAt: new Date('2026-10-09'),
        title: '产品经理', location: '上海', locationCity: '上海', salaryDisclosed: false,
      },
    ],
    rACampusEvent: [],
  },
});
let h: RouteHarness;
type Env<T> = { success: boolean; data: T; code?: string };

beforeAll(async () => {
  h = await startRouteHarness({
    env: {},
    mounts: [[P, createOnboardingCnRouter({ seekerAuth: [fakeAuth(() => currentUser)], db: fake as never, now: () => NOW })]],
  });
});
afterAll(() => h.close());

describe('onboarding-cn routes', () => {
  it('need a session', async () => {
    currentUser = null;
    for (const path of ['/schools?q=北京', '/provinces', '/defaults', '/market-snapshot']) {
      expect((await h.request('GET', `${P}${path}`, { host: GO })).status, path).toBe(401);
    }
    currentUser = { id: 'u1' };
  });

  it('do not exist on RoboApply (404 feature_disabled)', async () => {
    for (const path of ['/schools?q=北京', '/provinces', '/defaults', '/market-snapshot']) {
      const res = await h.request<Env<unknown>>('GET', `${P}${path}`, { host: RA });
      expect(res.status, path).toBe(404);
      expect(res.body.code).toBe('feature_disabled');
    }
  });

  it('school typeahead returns listed schools with their source', async () => {
    const res = await h.request<Env<{ items: Array<{ name: string; tags: string[] }>; source: { asOf: string | null; verified: boolean } }>>('GET', `${P}/schools?q=${encodeURIComponent('复旦')}`, { host: GO });
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([{ id: '复旦大学', name: '复旦大学', province: '上海', tags: ['985', '211', 'double_first_class'] }]);
    expect(res.body.data.source).toMatchObject({ verified: false, asOf: null });
    expect((await h.request('GET', `${P}/schools`, { host: GO })).status).toBe(422);
  });

  it('places and 届别 defaults', async () => {
    const places = await h.request<Env<{ items: unknown[] }>>('GET', `${P}/provinces`, { host: GO });
    expect(places.body.data.items).toHaveLength(33);
    const defaults = await h.request<Env<unknown>>('GET', `${P}/defaults`, { host: GO });
    expect(defaults.body.data).toEqual({ graduationClass: { yingjie: 2027, zaixiao: 2028 }, graduationMonth: 6 });
  });

  it('market snapshot counts our index and validates the query', async () => {
    const res = await h.request<Env<{ jobCount: { value: number }; pay: unknown }>>('GET', `${P}/market-snapshot?roles=${encodeURIComponent('产品经理')}&cities=${encodeURIComponent('上海')}`, { host: GO });
    expect(res.status).toBe(200);
    expect(res.body.data.jobCount.value).toBe(1);
    expect(res.body.data.pay).toBeNull();
    expect((await h.request('GET', `${P}/market-snapshot?class=2040`, { host: GO })).status).toBe(422);
    expect((await h.request('GET', `${P}/market-snapshot?cities=a,b,c,d,e,f`, { host: GO })).status).toBe(422);
  });
});
