// @vitest-environment node
//
// WP-32 route tests: /api/v1/roboapply/feed over a real FeedQueryService on an
// in-memory repo (no database, no network, no model). Auth (401), the
// `jobs.feed` capability (404 feature_disabled), validation (422), the 204
// answers, the refresh limit (429 + Retry-After), limits and the GoApply
// phone-binding gate on the AI route.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestHandler } from 'express';

vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { flagEnvName, setFlagOverrideLoader } from '../../platform/flags.js';
import { explainMatch } from '../compliance/explainMatch.js';
import { cardMeta } from '../jobs/marketHooks.js';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import { buildMatchUser } from '../match/index.js';
import type { SearchProfileWire } from '../search/index.js';
import { createFeedQueryService } from './FeedQueryService.js';
import { createFeedRouter } from './routes.js';
import { FakeFeedRepo, fakeFeedMatch, feedRow } from './testkit.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const P = '/api/v1/roboapply/feed';
type Env<T> = { success: boolean; data: T; code?: string; details?: Record<string, unknown> };

const repo = new FakeFeedRepo();
let refreshAllowed = true;
let currentUser: { id: string } | null = { id: 'u1' };
const limiterCalls: string[] = [];
let profileReads = 0;
let profileFilters: SearchProfileWire['filters'] = {};
const phoneGateCalls: string[] = [];

const profile = (): SearchProfileWire => ({
  id: 'sp1',
  name: '',
  isDefault: true,
  isActive: true,
  version: 1,
  schemaVersion: 1,
  filters: profileFilters,
  alertInstantMax: 1,
  alertDigest: null,
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
});

const service = createFeedQueryService({
  repo,
  // The real fit assembly (match/fit.ts) over the fake repo's rows. The person has experience on file and no resume.
  match: fakeFeedMatch({
    repo,
    now: () => NOW,
    context(userId) {
      const experience = [{ title: 'Backend Engineer', company: 'Acme', startYm: '2022-01', endYm: null, current: true, kind: 'work' }];
      const user = buildMatchUser({ userId, market: 'intl', profile: null, education: [], experience, resumeParsed: null, searchProfile: null, employerIndustries: [] }, NOW);
      return { user, resume: null };
    },
  }),
  search: {
    getActive: async () => {
      profileReads += 1;
      return profile();
    },
    get: async () => {
      profileReads += 1;
      return profile();
    },
  } as never,
  personalized: async () => true,
  cardMeta,
  explain: explainMatch,
  consumeRefresh: async () => ({ allowed: refreshAllowed, retryAfterSec: refreshAllowed ? 0 : 90 }),
  aiAllowed: async () => true,
  planner: async () => ({ queries: ['Data Analyst'], unverifiedPreferences: [] }),
  now: () => NOW,
} as Parameters<typeof createFeedQueryService>[0]);

const limiter = (name: string): RequestHandler => (_req, _res, next) => {
  limiterCalls.push(name);
  next();
};
const phoneGate: RequestHandler = (req, res, next) => {
  phoneGateCalls.push(req.path);
  if (req.headers['x-test-unbound'] === '1') {
    res.status(403).json({ success: false, code: 'phone_binding_required', error: 'Bind a phone.' });
    return;
  }
  next();
};

let h: RouteHarness;
let off: RouteHarness;
/** GoApply's kill switch set explicitly (D5: unset no longer means off). */
let cnOff: RouteHarness;

beforeAll(async () => {
  setFlagOverrideLoader(async () => []);
  const deps = { seekerAuth: [fakeAuth(() => currentUser)], service, limiter, phoneGate };
  h = await startRouteHarness({ env: {}, mounts: [[P, createFeedRouter({ ...deps, env: {} })]] });
  off = await startRouteHarness({
    env: {},
    mounts: [[P, createFeedRouter({ ...deps, env: { [flagEnvName('roboapply', 'jobs.feed')]: 'false' } })]],
  });
  const cnOffEnv = { CN_RECRUITMENT_INFO_MODE: 'off' };
  cnOff = await startRouteHarness({ env: cnOffEnv, mounts: [[P, createFeedRouter({ ...deps, env: cnOffEnv })]] });
});
afterAll(async () => {
  setFlagOverrideLoader(null);
  await h.close();
  await off.close();
  await cnOff.close();
});
beforeEach(() => {
  Object.assign(repo, new FakeFeedRepo());
  for (let i = 0; i < 25; i++) repo.rows.push(feedRow({ id: `j${String(i).padStart(2, '0')}`, postedAt: new Date(NOW.getTime() - (i + 1) * 3_600_000) }));
  refreshAllowed = true;
  currentUser = { id: 'u1' };
  limiterCalls.length = 0;
  phoneGateCalls.length = 0;
  profileReads = 0;
  profileFilters = {};
  service.clearExploreCache();
});

const ROUTES: Array<[string, string, unknown?]> = [
  ['POST', '/query', {}],
  ['GET', '/counts'],
  ['POST', '/jobs/j01/hide', { reasonCode: 'other' }],
  ['POST', '/jobs/j01/unhide'],
  ['POST', '/jobs/j01/report', { reason: 'scam' }],
  ['POST', '/impressions', { sessionId: 's1', positions: [{ jobId: 'j01', position: 0, ms: 10 }] }],
  ['POST', '/rating', { score: 7, reasons: [] }],
  ['GET', '/explore'],
  ['POST', '/nl-query', { text: 'remote data jobs' }],
  ['GET', '/new-count'],
  ['GET', '/skills-check'],
];

describe('auth and capability', () => {
  it.each(ROUTES)('%s %s → 401 without a session', async (method, path, body) => {
    currentUser = null;
    expect((await h.request(method, `${P}${path}`, { body })).status).toBe(401);
  });

  it.each(ROUTES)('%s %s → 404 feature_disabled when jobs.feed is off', async (method, path, body) => {
    const res = await off.request<Env<unknown>>(method, `${P}${path}`, { body });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('feature_disabled');
  });

  it('GoApply with CN_RECRUITMENT_INFO_MODE=off: the feed is disabled; RoboApply is not affected by that switch', async () => {
    const res = await cnOff.request<Env<unknown>>('POST', `${P}/query`, { host: 'goapply.localhost:3621', body: {} });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('feature_disabled');
    expect((await cnOff.request<Env<unknown>>('POST', `${P}/query`, { body: {} })).status).toBe(200);
  });

  it('GoApply with nothing set: the feed is on (D5 default)', async () => {
    const res = await h.request<Env<{ items: unknown[] }>>('POST', `${P}/query`, { host: 'goapply.localhost:3621', body: {} });
    expect(res.status).toBe(200);
    expect(res.body.code).toBeUndefined();
    expect(Array.isArray(res.body.data.items)).toBe(true);
  });
});

describe('POST /query', () => {
  it('answers the first page in the envelope and paginates by cursor', async () => {
    const p1 = await h.request<Env<{ items: Array<{ jobId: string }>; cursor: string; sessionId: string; endOfFeed: boolean }>>('POST', `${P}/query`, { body: { sort: 'newest' } });
    expect(p1.status).toBe(200);
    expect(p1.body.data.items).toHaveLength(20);
    const p2 = await h.request<Env<{ items: unknown[]; endOfFeed: boolean }>>('POST', `${P}/query`, { body: { sort: 'newest', cursor: p1.body.data.cursor } });
    expect(p2.body.data.items).toHaveLength(5);
    expect(p2.body.data.endOfFeed).toBe(true);
    expect(limiterCalls).toEqual(['feedQuery', 'feedQuery']);
  });

  it('422 on an unknown sort; 422 on deadline outside GoApply', async () => {
    expect((await h.request('POST', `${P}/query`, { body: { sort: 'random' } })).status).toBe(422);
    const res = await h.request<Env<unknown>>('POST', `${P}/query`, { body: { sort: 'deadline' } });
    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({ reason: 'deadline_sort_cn_only' });
  });

  it('429 with Retry-After when refreshes run out', async () => {
    refreshAllowed = false;
    const res = await h.request<Env<unknown>>('POST', `${P}/query`, { body: {} });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('90');
    expect(res.body.details).toMatchObject({ reason: 'feed_refresh_limited', retryAfterSec: 90 });
  });
});

describe('POST /query: cardMeta, explanation and the browse case (WP-33 ← WP-32)', () => {
  type Item = { jobId: string; fit: { tier: string; kind: string } | null; cardMeta?: Record<string, Record<string, unknown>>; explanation?: { mode: string; headline: { key: string; params?: Record<string, unknown> }; notices: Array<{ key: string }> } };

  it('each scored card carries `explanation`; a Taiwan posting carries `cardMeta`; others carry no cardMeta', async () => {
    repo.rows.push(
      feedRow({ id: 'tw1', postedAt: new Date(NOW.getTime() - 60_000), locationCountry: 'TW', location: 'Taipei, Taiwan', salaryDisclosed: false, salaryText: '待遇面議', sourceBoard: 'greenhouse', sourceName: 'Appier · Greenhouse' }),
    );
    const res = await h.request<Env<{ items: Item[] }>>('POST', `${P}/query`, { body: { sort: 'newest' } });
    expect(res.status).toBe(200);
    const tw = res.body.data.items.find((i) => i.jobId === 'tw1')!;
    expect(tw.cardMeta).toMatchObject({ ats_public: { country: 'TW', pay: { posted: '待遇面議', disclosed: false, negotiable: true }, source: { name: 'Appier · Greenhouse', board: 'greenhouse' } } });
    const other = res.body.data.items.find((i) => i.jobId === 'j00')!;
    expect(other).not.toHaveProperty('cardMeta');
    for (const item of res.body.data.items) {
      expect(item.fit, item.jobId).not.toBeNull();
      expect(item.explanation, item.jobId).toMatchObject({ mode: 'personalized', headline: { key: 'legal.explain.headline.personalized', params: { tier: item.fit!.tier } } });
      expect(item.explanation!.notices.map((n) => n.key)).toContain('legal.explain.notice.notHiringChance');
    }
  });

  it('browse: overrides.taxonomyIds with no searchProfileId lists the category by market and visibility rules only', async () => {
    // The saved search would hide every seeded job (it asks for sales roles, onsite).
    profileFilters = { taxonomyIds: ['sales'], workModels: ['onsite'] };
    repo.rows.push(feedRow({ id: 'da1', taxonomyIds: ['data_analytics', 'data_analyst'], primaryTaxonomyId: 'data_analyst', postedAt: new Date(NOW.getTime() - 60_000) }));
    repo.rows.push(feedRow({ id: 'mine', taxonomyIds: ['software_engineering'], visibility: 'private', ownerUserId: 'u1', sourceBoard: 'user_import', postedAt: new Date(NOW.getTime() - 30_000) }));
    const res = await h.request<Env<{ items: Item[]; cursor: string | null; sessionId: string }>>('POST', `${P}/query`, {
      body: { sort: 'newest', overrides: { taxonomyIds: ['software_engineering'] } },
    });
    expect(res.status).toBe(200);
    expect(profileReads).toBe(0);
    // 25 public backend jobs under the category: the first page of 20; never the analytics job or the user's own import.
    expect(res.body.data.items).toHaveLength(20);
    expect(res.body.data.items.map((i) => i.jobId)).not.toContain('da1');
    expect(res.body.data.items.map((i) => i.jobId)).not.toContain('mine');
    const page2 = await h.request<Env<{ items: Item[]; endOfFeed: boolean }>>('POST', `${P}/query`, {
      body: { sort: 'newest', overrides: { taxonomyIds: ['software_engineering'] }, cursor: res.body.data.cursor },
    });
    expect(page2.body.data.items).toHaveLength(5);
    expect(page2.body.data.endOfFeed).toBe(true);
    // The tile count for the same category comes from the same rows (public, live, same age floor).
    repo.categoryCounts = [{ taxonomyId: 'software_engineering', count: 25 }];
    const ex = await h.request<Env<{ categories: Array<{ taxonomyId: string; count: number }> }>>('GET', `${P}/explore`);
    expect(ex.body.data.categories.find((c) => c.taxonomyId === 'software_engineering')!.count).toBe(res.body.data.items.length + page2.body.data.items.length);
  });

  it('the same overrides with a searchProfileId narrow that search (not a browse); an unknown override is still 422', async () => {
    profileFilters = { workModels: ['remote'] };
    const res = await h.request<Env<{ items: Item[] }>>('POST', `${P}/query`, { body: { sort: 'newest', searchProfileId: 'sp1', overrides: { taxonomyIds: ['software_engineering'] } } });
    expect(res.status).toBe(200);
    expect(profileReads).toBe(1);
    const bad = await h.request<Env<unknown>>('POST', `${P}/query`, { body: { overrides: { taxonomyIds: ['software_engineering'], seniority: ['wizard'] } } });
    expect(bad.status).toBe(422);
    expect(bad.body.details).toMatchObject({ reason: 'invalid_filters' });
  });
});

describe('actions', () => {
  it('hide → proposal; unhide/report/impressions/rating → 204', async () => {
    const hide = await h.request<Env<{ proposedFilterDiff: unknown; editor: unknown }>>('POST', `${P}/jobs/j01/hide`, { body: { reasonCode: 'company' } });
    expect(hide.status).toBe(200);
    expect(hide.body.data.proposedFilterDiff).toMatchObject({ ops: [{ op: 'add', path: 'excludedCompanies' }] });
    expect((await h.request('POST', `${P}/jobs/j01/unhide`)).status).toBe(204);
    expect((await h.request('POST', `${P}/jobs/j01/report`, { body: { reason: 'scam', note: 'asks for a fee' } })).status).toBe(204);
    expect(limiterCalls).toContain('feedReport');
    const q = await h.request<Env<{ sessionId: string }>>('POST', `${P}/query`, { body: {} });
    expect((await h.request('POST', `${P}/impressions`, { body: { sessionId: q.body.data.sessionId, positions: [{ jobId: 'j00', position: 0, ms: 800 }] } })).status).toBe(204);
    expect((await h.request('POST', `${P}/rating`, { body: { score: 6, reasons: ['wrong_level'] } })).status).toBe(204);
    const again = await h.request<Env<unknown>>('POST', `${P}/rating`, { body: { score: 6 } });
    expect(again.status).toBe(409);
    expect(again.body.details).toMatchObject({ reason: 'feed_rating_already_today' });
  });

  it('validation: unknown hide reason, rating out of range, too many impressions', async () => {
    expect((await h.request('POST', `${P}/jobs/j01/hide`, { body: { reasonCode: 'meh' } })).status).toBe(422);
    expect((await h.request('POST', `${P}/rating`, { body: { score: 11 } })).status).toBe(422);
    const many = Array.from({ length: 101 }, (_, i) => ({ jobId: `j${i}`, position: i, ms: 1 }));
    expect((await h.request('POST', `${P}/impressions`, { body: { sessionId: 's', positions: many } })).status).toBe(422);
  });

  it('a job in another market is 404', async () => {
    repo.rows.push(feedRow({ id: 'cn1', market: 'cn' }));
    const res = await h.request<Env<unknown>>('POST', `${P}/jobs/cn1/hide`, { body: { reasonCode: 'other' } });
    expect(res.status).toBe(404);
  });
});

describe('reads', () => {
  it('counts, explore (locale), new-count, skills-check', async () => {
    repo.countResponder = () => 25;
    expect((await h.request<Env<{ forYou: number }>>('GET', `${P}/counts`)).body.data.forYou).toBe(25);
    const ex = await h.request<Env<{ categories: Array<{ label: string }> }>>('GET', `${P}/explore?locale=zh`);
    expect(ex.status).toBe(200);
    expect(ex.body.data.categories.length).toBeGreaterThanOrEqual(20);
    const nc = await h.request<Env<{ count: number; since: string }>>('GET', `${P}/new-count?since=2026-10-09T00:00:00.000Z&markVisited=true`);
    expect(nc.status).toBe(200);
    expect(nc.body.data.since).toBe('2026-10-09T00:00:00.000Z');
    expect(repo.visits.get('u1')).toEqual(NOW);
    expect((await h.request('GET', `${P}/new-count?since=yesterday`)).status).toBe(422);
    expect((await h.request<Env<{ skills: unknown[] }>>('GET', `${P}/skills-check`)).body.data.skills).toEqual([
      { skill: 'python', askedIn: 25, outOf: 25 },
      { skill: 'sql', askedIn: 25, outOf: 25 },
    ]);
  });

  it('nl-query passes the phone-binding gate and is rate limited', async () => {
    const ok = await h.request<Env<{ diff: { patch: unknown } }>>('POST', `${P}/nl-query`, { body: { text: 'data analyst jobs' } });
    expect(ok.status).toBe(200);
    expect(ok.body.data.diff.patch).toMatchObject({ titles: ['Data Analyst'] });
    expect(phoneGateCalls).toEqual(['/nl-query']);
    expect(limiterCalls).toContain('feedNlQuery');
    const blocked = await h.request<Env<unknown>>('POST', `${P}/nl-query`, { body: { text: 'data analyst jobs' }, headers: { 'x-test-unbound': '1' } });
    expect(blocked.status).toBe(403);
  });
});
