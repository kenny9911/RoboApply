// @vitest-environment node
//
// WP-20 route tests: /search-profiles and /taxonomy over a real
// SearchProfileService on the fake Prisma (no network, no database).

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestHandler } from 'express';

vi.mock('../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createFakePrisma } from '../../test/fakePrisma.js';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import { createEntitlementService, DEFAULT_CREDIT_CATALOG, type AccountSnapshot } from '../../platform/credits/index.js';
import { NotImplementedError } from '../../platform/http.js';
import { createSearchProfileService } from './SearchProfileService.js';
import { createSearchProfilesRouter, createTaxonomyRouter, taxonomyResponse } from './routes.js';
import type { SkillSuggestService } from './skills.js';

const FREE: AccountSnapshot = { brand: 'roboapply', timezone: null, subscription: null };
const PRO: AccountSnapshot = {
  brand: 'roboapply',
  timezone: null,
  subscription: { tier: 'pro', planKey: 'pro_monthly', status: 'active', interval: 'month', currentPeriodEnd: new Date('2099-01-01') },
};

let account: AccountSnapshot = FREE;
let fake = createFakePrisma();
const service = createSearchProfileService({
  getDb: async () => fake as never,
  entitlements: createEntitlementService({
    source: { loadAccount: async () => account, loadOverrides: async () => [] },
    loadCatalog: async (b) => DEFAULT_CREDIT_CATALOG[b],
    proSellable: () => true,
    memoTtlMs: 0,
  }),
  loadCatalog: async (b) => DEFAULT_CREDIT_CATALOG[b],
});

const feed = {
  countForFilters: vi.fn(async (_userId: string, _filters: unknown) => {
    throw new NotImplementedError('feed.countForFilters');
  }) as ReturnType<typeof vi.fn>,
  limitingFilters: vi.fn(async () => {
    throw new NotImplementedError('feed.limitingFilters');
  }) as ReturnType<typeof vi.fn>,
};
const skills: SkillSuggestService = { suggest: vi.fn(async (q: string) => [{ value: 'Python', label: 'Python', source: 'postings' as const }].filter(() => q.length > 0)) };
const limiterCalls: string[] = [];
const limiter = (name: string): RequestHandler => (_req, _res, next) => {
  limiterCalls.push(name);
  next();
};

let currentUser: { id: string } | null = { id: 'u1' };
const auth = [fakeAuth(() => currentUser)];
let h: RouteHarness;
const P = '/api/v1/roboapply/search-profiles';
const T = '/api/v1/roboapply/taxonomy';

type Env<T> = { success: boolean; data: T; code?: string; details?: Record<string, unknown> };

beforeAll(async () => {
  h = await startRouteHarness({
    env: {},
    mounts: [
      [P, createSearchProfilesRouter({ seekerAuth: auth, service, feed, limiter })],
      [T, createTaxonomyRouter({ seekerAuth: auth, optionalAuth: [(_q, _s, n) => n()], skills, limiter })],
    ],
  });
});
afterAll(() => h.close());
beforeEach(() => {
  fake = createFakePrisma();
  account = FREE;
  currentUser = { id: 'u1' };
  limiterCalls.length = 0;
});

async function list() {
  const res = await h.request<Env<{ profiles: Array<{ id: string; version: number; isDefault: boolean; isActive: boolean; filters: unknown; name: string }> }>>('GET', P);
  return res.body.data.profiles;
}

describe('auth', () => {
  it('answers 401 without a session on every search-profile route and on /taxonomy/skills', async () => {
    currentUser = null;
    for (const [m, path] of [
      ['GET', P],
      ['POST', P],
      ['POST', `${P}/count`],
      ['PATCH', `${P}/x`],
      ['DELETE', `${P}/x`],
      ['POST', `${P}/x/activate`],
      ['GET', `${P}/x/limiting`],
      ['GET', `${T}/skills?q=py`],
    ] as const) {
      expect((await h.request(m, path, { body: m === 'GET' || m === 'DELETE' ? undefined : {} })).status, `${m} ${path}`).toBe(401);
    }
    // The taxonomy tree is public (S/P).
    expect((await h.request('GET', T)).status).toBe(200);
  });
});

describe('GET/POST /search-profiles', () => {
  it('creates the default profile on first read and caps creation at the entitlement with a Pro note', async () => {
    const res = await h.request<Env<Record<string, unknown>>>('GET', P);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ maxProfiles: 1, proMaxProfiles: 10, upgradable: true });
    const created = await h.request<Env<unknown>>('POST', P, { body: { name: 'Second', filters: {} } });
    expect(created.status).toBe(403);
    expect(created.body).toMatchObject({ code: 'forbidden', details: { reason: 'saved_search_limit', max: 1, upgradable: true } });

    account = PRO;
    const ok = await h.request<Env<{ name: string; filters: unknown }>>('POST', P, { body: { name: 'Data', filters: { titles: ['Analyst'], recruiterJobsOnly: true } } });
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ name: 'Data', filters: { titles: ['Analyst'], recruiterJobsOnly: true } });
  });

  it('refuses invalid filters with 422 invalid_request and the issues', async () => {
    account = PRO;
    const res = await h.request<Env<unknown>>('POST', P, { body: { name: 'x', filters: { jobTypes: ['gig'] } } });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'invalid_request', details: { reason: 'invalid_filters' } });
    const extra = await h.request<Env<unknown>>('POST', P, { body: { name: 'x', filters: {}, colour: 'red' } });
    expect(extra.status).toBe(422);
  });

  it('keeps the recruiter-jobs filter free on the Free plan', async () => {
    const [main] = await list();
    const res = await h.request<Env<{ filters: unknown }>>('PATCH', `${P}/${main.id}`, { body: { baseVersion: 1, filtersPatch: { recruiterJobsOnly: true } } });
    expect(res.status).toBe(200);
    expect(res.body.data.filters).toEqual({ recruiterJobsOnly: true });
  });
});

describe('PATCH /search-profiles/:id', () => {
  it('writes the drawer in one PATCH with baseVersion and answers 409 version_conflict with the current profile', async () => {
    const [main] = await list();
    const first = await h.request<Env<{ version: number; filters: unknown }>>('PATCH', `${P}/${main.id}`, {
      body: { baseVersion: 1, filters: { titles: ['Nurse'], includeUndisclosedPay: false } },
    });
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ version: 2, filters: { titles: ['Nurse'], includeUndisclosedPay: false } });

    const stale = await h.request<Env<unknown>>('PATCH', `${P}/${main.id}`, { body: { baseVersion: 1, filters: { titles: ['Other'] } } });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'version_conflict', details: { currentVersion: 2, profile: { id: main.id, version: 2, filters: { titles: ['Nurse'] } } } });
  });

  it('accepts the `version` alias, applies filtersPatch (null clears) and rejects filters + filtersPatch together', async () => {
    const [main] = await list();
    await h.request('PATCH', `${P}/${main.id}`, { body: { version: 1, filters: { titles: ['A'], skills: ['SQL'] } } });
    const res = await h.request<Env<{ filters: unknown }>>('PATCH', `${P}/${main.id}`, { body: { baseVersion: 2, filtersPatch: { skills: null, excludedSkills: ['PHP'] } } });
    expect(res.body.data.filters).toEqual({ titles: ['A'], excludedSkills: ['PHP'] });
    expect((await h.request('PATCH', `${P}/${main.id}`, { body: { baseVersion: 3, filters: {}, filtersPatch: {} } })).status).toBe(422);
    expect((await h.request('PATCH', `${P}/${main.id}`, { body: { name: 'no version' } })).status).toBe(422);
  });

  it('strips GoApply-only fields on RoboApply and keeps them on GoApply', async () => {
    const [main] = await list();
    const intl = await h.request<Env<{ filters: unknown }>>('PATCH', `${P}/${main.id}`, { body: { baseVersion: 1, filters: { classYear: 2027, needsSponsorship: true } } });
    expect(intl.body.data.filters).toEqual({ needsSponsorship: true });
    account = { ...FREE, brand: 'goapply' };
    currentUser = { id: 'cn1' };
    const [cnMain] = await list();
    const cn = await h.request<Env<{ filters: unknown }>>('PATCH', `${P}/${cnMain.id}`, {
      host: 'goapply.localhost:3621',
      body: { baseVersion: 1, filters: { classYear: 2027, salaryMonthsMin: 13, needsSponsorship: true } },
    });
    expect(cn.body.data.filters).toEqual({ classYear: 2027, salaryMonthsMin: 13 });
  });

  it('404s on someone else’s profile', async () => {
    const [main] = await list();
    currentUser = { id: 'u2' };
    const res = await h.request<Env<unknown>>('PATCH', `${P}/${main.id}`, { body: { baseVersion: 1, name: 'x' } });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'not_found', details: { reason: 'search_profile_not_found' } });
  });
});

describe('DELETE and activate', () => {
  it('never deletes the last or the default profile; activates another', async () => {
    account = PRO;
    const [main] = await list();
    expect((await h.request<Env<unknown>>('DELETE', `${P}/${main.id}`)).body).toMatchObject({ code: 'conflict', details: { reason: 'cannot_delete_last_profile' } });
    const second = (await h.request<Env<{ id: string }>>('POST', `${P}`, { body: { name: 'B', filters: {} } })).body.data;
    expect((await h.request<Env<unknown>>('DELETE', `${P}/${main.id}`)).body).toMatchObject({ code: 'conflict', details: { reason: 'cannot_delete_default_profile' } });
    const act = await h.request<Env<{ isActive: boolean }>>('POST', `${P}/${second.id}/activate`);
    expect(act.body.data.isActive).toBe(true);
    const del = await h.request<Env<null>>('DELETE', `${P}/${second.id}`);
    expect(del.status).toBe(200);
    expect((await list()).map((p) => [p.id, p.isDefault, p.isActive])).toEqual([[main.id, true, true]]);
  });
});

describe('count and limiting (feed seam)', () => {
  it('returns {count:null} until the feed counts, then the feed answer; rate-limited', async () => {
    const res = await h.request<Env<unknown>>('POST', `${P}/count`, { body: { filters: { titles: ['A'] } } });
    expect(res.body.data).toEqual({ count: null, capped: false });
    expect(limiterCalls).toEqual(['searchProfileCount']);
    feed.countForFilters.mockResolvedValueOnce({ count: 42, capped: false });
    const live = await h.request<Env<unknown>>('POST', `${P}/count`, { body: { filters: { titles: ['A'] } } });
    expect(live.body.data).toEqual({ count: 42, capped: false });
    expect(feed.countForFilters).toHaveBeenLastCalledWith('u1', { titles: ['A'] });
    expect((await h.request('POST', `${P}/count`, { body: { filters: { nope: 1 } } })).status).toBe(422);
  });

  it('returns {available:false} until the feed measures relaxations, 404 for an unknown profile', async () => {
    const [main] = await list();
    const res = await h.request<Env<unknown>>('GET', `${P}/${main.id}/limiting`);
    expect(res.body.data).toEqual({ items: [], available: false });
    feed.limitingFilters.mockResolvedValueOnce([{ field: 'workModels', value: ['onsite'], removalGain: 12 }]);
    const live = await h.request<Env<unknown>>('GET', `${P}/${main.id}/limiting`);
    expect(live.body.data).toEqual({ items: [{ field: 'workModels', value: ['onsite'], removalGain: 12 }], available: true });
    expect((await h.request('GET', `${P}/missing/limiting`)).status).toBe(404);
    expect(limiterCalls.filter((n) => n === 'searchProfileLimiting')).toHaveLength(3);
  });
});

describe('/taxonomy', () => {
  it('returns the tree with labels by locale (zh → Simplified, zh-TW → English) and sources', async () => {
    const en = await h.request<Env<{ nodes: Array<{ id: string; label: string; level: number }>; sources: unknown[] }>>('GET', T);
    expect(en.headers.get('cache-control')).toContain('max-age=3600');
    const cat = en.body.data.nodes.find((n) => n.id === 'software_engineering')!;
    expect(cat).toMatchObject({ level: 1, label: 'Software engineering' });
    expect(en.body.data.sources.length).toBeGreaterThan(0);
    const zh = await h.request<Env<{ nodes: Array<{ id: string; label: string }> }>>('GET', `${T}?locale=zh`);
    expect(zh.body.data.nodes.find((n) => n.id === 'software_engineering')!.label).toMatch(/[一-鿿]/);
    const tw = await h.request<Env<{ nodes: Array<{ id: string; label: string }>; locale: string }>>('GET', `${T}?locale=zh-TW`);
    expect(tw.body.data.locale).toBe('en');
  });

  it('suggests titles for q (typeahead) and nothing for one Latin letter', () => {
    const r = taxonomyResponse({ q: 'backend' });
    expect(r.nodes).toEqual([]);
    expect(r.suggestions.length).toBeGreaterThan(0);
    expect(r.suggestions[0]).toHaveProperty('context');
    expect(taxonomyResponse({ q: 'b' }).suggestions).toEqual([]);
  });

  it('suggests skills for the request market; a failing aggregate answers an empty list', async () => {
    const ok = await h.request<Env<{ items: unknown[] }>>('GET', `${T}/skills?q=py`);
    expect(ok.body.data.items).toEqual([{ value: 'Python', label: 'Python', source: 'postings' }]);
    expect(skills.suggest).toHaveBeenLastCalledWith('py', 'intl');
    await h.request('GET', `${T}/skills?q=py`, { host: 'goapply.localhost:3621' });
    expect(skills.suggest).toHaveBeenLastCalledWith('py', 'cn');
    vi.mocked(skills.suggest).mockRejectedValueOnce(new Error('db down'));
    const failed = await h.request<Env<{ items: unknown[] }>>('GET', `${T}/skills?q=py`);
    expect(failed.status).toBe(200);
    expect(failed.body.data.items).toEqual([]);
  });

  it('rate-limits /taxonomy/skills (and not the static tree)', async () => {
    await h.request('GET', `${T}/skills?q=py`);
    expect(limiterCalls).toEqual(['taxonomySkills']);
    await h.request('GET', `${T}?q=back`);
    expect(limiterCalls).toEqual(['taxonomySkills']);
  });
});
