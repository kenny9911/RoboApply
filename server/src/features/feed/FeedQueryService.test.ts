// @vitest-environment node
//
// WP-32 service tests over an in-memory repo (no database, no network, no model):
// sessions + cursor stability + older-window refill, refresh limit, ranking with
// cached AI scores, fit-tier hiding counts, company scatter, GoApply non-personalised
// order, hide/unhide with filter diffs, report thresholds, impressions, daily
// rating, Explore cache, NL query (aiAllowed), new-count, skills-check, counts.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { HttpError } from '../../platform/http.js';
import { DEFAULT_MATCH_TIERS, DEFAULT_MATCH_WEIGHTS, buildMatchUser } from '../match/index.js';
import type { FilterSet, SearchProfileWire } from '../search/index.js';
import { SearchProfileNotFoundError } from '../search/index.js';
import { createFeedQueryService, type FeedServiceDeps } from './FeedQueryService.js';
import type { PlannerPlan } from './filterDiff.js';
import { FakeFeedRepo, feedRow } from './testkit.js';
import type { FeedCtx } from './types.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
const ctx = (over: Partial<FeedCtx> = {}): FeedCtx => ({ userId: 'u1', market: 'intl', brandId: 'roboapply', now: NOW, ...over });

let repo: FakeFeedRepo;
let profileFilters: FilterSet;
let profileVersion: number;
let personalized: boolean;
let refreshAllowed: boolean;
let aiOk: boolean;
let userContextCalls: number;
let plannerCalls: string[];
let plannerImpl: (text: string) => Promise<PlannerPlan>;

function profile(): SearchProfileWire {
  return {
    id: 'sp1',
    name: '',
    isDefault: true,
    isActive: true,
    version: profileVersion,
    schemaVersion: 1,
    filters: profileFilters,
    alertInstantMax: 1,
    alertDigest: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

function service(over: Partial<FeedServiceDeps> = {}) {
  return createFeedQueryService({
    repo,
    match: {
      async userContext(userId) {
        userContextCalls += 1;
        const user = buildMatchUser(
          {
            userId,
            market: 'intl',
            profile: { firstName: null, lastName: null, country: 'US', skills: [{ name: 'Python' }, { name: 'SQL' }], workAuth: [], cnFields: null },
            education: [],
            experience: [],
            resumeParsed: null,
            searchProfile: { filters: { taxonomyIds: ['backend_engineer'], seniority: ['mid'] }, version: 1 },
            employerIndustries: [],
          },
          NOW,
        );
        return { user, resume: { id: 'rv1', resumeMarkdown: '', resumeContentHash: 'h', parsedData: null, targetJobId: null } };
      },
      config: () => ({ weights: { ...DEFAULT_MATCH_WEIGHTS }, tiers: { ...DEFAULT_MATCH_TIERS } }),
    },
    search: {
      getActive: async () => profile(),
      get: async (_u, id) => {
        if (id !== 'sp1') throw new SearchProfileNotFoundError(id);
        return profile();
      },
    } as FeedServiceDeps['search'],
    personalized: async () => personalized,
    consumeRefresh: async () => ({ allowed: refreshAllowed, retryAfterSec: refreshAllowed ? 0 : 120 }),
    aiAllowed: async () => aiOk,
    planner: async (text) => {
      plannerCalls.push(text);
      return plannerImpl(text);
    },
    now: () => NOW,
    ...over,
  });
}

/** n recent backend jobs, each from its own company, posted `start + i` hours ago. */
function seed(n: number, opts: { prefix?: string; startDaysAgo?: number; company?: (i: number) => string } = {}) {
  const prefix = opts.prefix ?? 'j';
  for (let i = 0; i < n; i++) {
    const id = `${prefix}${String(i).padStart(3, '0')}`;
    repo.rows.push(
      feedRow({
        id,
        postedAt: new Date(daysAgo(opts.startDaysAgo ?? 0).getTime() - (i + 1) * 3_600_000),
        firstSeenAt: new Date(daysAgo(opts.startDaysAgo ?? 0).getTime() - (i + 1) * 3_600_000),
        companyNameNormalized: opts.company ? opts.company(i) : `co-${id}`,
        companyName: opts.company ? opts.company(i) : `Co ${id}`,
      }),
    );
  }
}

async function expectHttp(p: Promise<unknown>, code: string, reason?: string) {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).code).toBe(code);
  if (reason) expect((err as HttpError).details).toMatchObject({ reason });
}

beforeEach(() => {
  repo = new FakeFeedRepo();
  profileFilters = { taxonomyIds: ['backend_engineer'] };
  profileVersion = 1;
  personalized = true;
  refreshAllowed = true;
  aiOk = true;
  userContextCalls = 0;
  plannerCalls = [];
  plannerImpl = async () => ({ queries: ['Data Analyst'], remote: true, unverifiedPreferences: [] });
});

describe('POST /feed/query — sessions and pagination', () => {
  it('first page: 20 items, a session cursor, positions, the visit stamped, the session stored with ranks', async () => {
    seed(70);
    const res = await service().query(ctx(), { sort: 'recommended' });
    expect(res.items).toHaveLength(20);
    expect(res.cursor).toBe(`${res.sessionId}:20`);
    expect(res.endOfFeed).toBe(false);
    expect(res.order).toBe('personalized');
    expect(res.items.map((i) => i.position)).toEqual([...Array(20).keys()]);
    expect(res.items[0]!.fit).toMatchObject({ kind: 'pre' });
    const session = repo.sessions.get(res.sessionId)!;
    expect(session.jobIds).toHaveLength(70);
    expect((session.ranks as unknown[])[0]).toMatchObject({ jobId: res.items[0]!.jobId, kind: 'pre' });
    expect(session.expiresAt.getTime() - NOW.getTime()).toBe(30 * 60_000);
    expect(repo.visits.get('u1')).toEqual(NOW);
  });

  it('cursor stability: the same cursor returns the same page; pages never overlap', async () => {
    seed(70);
    const s = service();
    const p1 = await s.query(ctx(), { sort: 'newest' });
    const a = await s.query(ctx(), { sort: 'newest', cursor: p1.cursor! });
    const b = await s.query(ctx(), { sort: 'newest', cursor: p1.cursor! });
    expect(a.items.map((i) => i.jobId)).toEqual(b.items.map((i) => i.jobId));
    expect(a.items.map((i) => i.jobId).some((id) => p1.items.some((x) => x.jobId === id))).toBe(false);
    expect(a.items[0]!.position).toBe(20);
  });

  it('widens 14 → 45 days under 60 rows, then refills from the next older window until the age floor', async () => {
    seed(25, { prefix: 'r', startDaysAgo: 0 }); // within 45 days
    seed(30, { prefix: 'o', startDaysAgo: 50 }); // 50–51 days old
    const s = service();
    const p1 = await s.query(ctx(), { sort: 'newest' });
    expect(repo.sessions.get(p1.sessionId)!.jobIds).toHaveLength(25);
    const p2 = await s.query(ctx(), { sort: 'newest', cursor: p1.cursor! });
    expect(p2.items.map((i) => i.jobId.slice(0, 1))).toEqual([...Array(5).fill('r'), ...Array(15).fill('o')]);
    expect(repo.sessions.get(p1.sessionId)!.jobIds).toHaveLength(55);
    const p3 = await s.query(ctx(), { sort: 'newest', cursor: p2.cursor! });
    expect(p3.items).toHaveLength(15);
    expect(p3.endOfFeed).toBe(true);
    expect(p3.cursor).toBeNull();
  });

  it('more than one full window of jobs sharing one postedAt: every job is reached once (keyset refill)', async () => {
    const at = new Date(NOW.getTime() - 2 * 3_600_000);
    for (let i = 0; i < 450; i++) {
      const id = `t${String(i).padStart(3, '0')}`;
      repo.rows.push(feedRow({ id, postedAt: at, firstSeenAt: at, companyName: `Co ${id}`, companyNameNormalized: `co-${id}` }));
    }
    seed(5, { prefix: 'o', startDaysAgo: 3 });
    for (const sort of ['newest', 'recommended'] as const) {
      const s = service();
      const seen: string[] = [];
      let res = await s.query(ctx(), { sort });
      seen.push(...res.items.map((i) => i.jobId));
      for (let guard = 0; res.cursor && guard < 40; guard++) {
        res = await s.query(ctx(), { sort, cursor: res.cursor });
        seen.push(...res.items.map((i) => i.jobId));
      }
      expect(res.endOfFeed).toBe(true);
      expect(new Set(seen).size).toBe(455);
      expect(seen).toHaveLength(455);
      const session = repo.sessions.get(res.sessionId)!;
      expect(session.jobIds).toHaveLength(455);
    }
    const keyset = repo.queries.filter((q) => q.text.includes('(j."postedAt", j."id") < ('));
    expect(keyset.length).toBeGreaterThan(0);
    expect(keyset[0]!.values).toContain('t050');
  });

  it('a posted-within filter is one window: no refill beyond it', async () => {
    profileFilters = { postedWithinDays: 7 };
    seed(5, { prefix: 'r' });
    seed(5, { prefix: 'o', startDaysAgo: 20 });
    const res = await service().query(ctx(), { sort: 'newest' });
    expect(res.items.map((i) => i.jobId[0])).toEqual(Array(5).fill('r'));
    expect(res.endOfFeed).toBe(true);
  });

  it('refresh (no cursor) is limited; cursor pages are not', async () => {
    seed(30);
    const s = service();
    const p1 = await s.query(ctx(), { sort: 'newest' });
    refreshAllowed = false;
    await expectHttp(s.query(ctx(), { sort: 'newest' }), 'rate_limited', 'feed_refresh_limited');
    await expect(s.query(ctx(), { sort: 'newest', cursor: p1.cursor! })).resolves.toMatchObject({ sessionId: p1.sessionId });
  });

  it('a changed query, another user, or an expired session answers 409 feed_session_expired', async () => {
    seed(30);
    const s = service();
    const p1 = await s.query(ctx(), { sort: 'newest' });
    await expectHttp(s.query(ctx(), { sort: 'best_fit', cursor: p1.cursor! }), 'conflict', 'feed_session_expired');
    await expectHttp(s.query(ctx({ userId: 'u2' }), { sort: 'newest', cursor: p1.cursor! }), 'conflict', 'feed_session_expired');
    profileVersion = 2;
    await expectHttp(s.query(ctx(), { sort: 'newest', cursor: p1.cursor! }), 'conflict', 'feed_session_expired');
    profileVersion = 1;
    await expectHttp(service({ now: () => new Date(NOW.getTime() + 31 * 60_000) }).query(ctx({ now: new Date(NOW.getTime() + 31 * 60_000) }), { sort: 'newest', cursor: p1.cursor! }), 'conflict');
    await expectHttp(s.query(ctx(), { sort: 'newest', cursor: 'garbage' }), 'invalid_request');
  });

  it('deadline sort is GoApply only', async () => {
    await expectHttp(service().query(ctx(), { sort: 'deadline' }), 'invalid_request', 'deadline_sort_cn_only');
  });

  it('invalid overrides answer 422 invalid_filters; an unknown profile answers 404', async () => {
    await expectHttp(service().query(ctx(), { sort: 'newest', overrides: { workModels: ['moon'] } }), 'invalid_request', 'invalid_filters');
    await expectHttp(service().query(ctx(), { sort: 'newest', searchProfileId: 'nope' }), 'not_found');
  });
});

describe('ranking in the feed', () => {
  it('prefers a cached AI score (kind ai) and ranks by it', async () => {
    seed(10);
    repo.ai.set('j009', { score: 97, tier: 'great' });
    const res = await service().query(ctx(), { sort: 'best_fit' });
    expect(res.items[0]).toMatchObject({ jobId: 'j009', fit: { kind: 'ai', score: 97, tier: 'great' } });
  });

  it('fit-tier view hides weaker fits and says how many', async () => {
    seed(10);
    // Unrelated postings score low on the quick estimate.
    for (const r of repo.rows) Object.assign(r, { taxonomyIds: ['sales'], primaryTaxonomyId: 'sales', skills: ['negotiation'], seniority: 'director_exec', title: 'Sales Director', workModel: 'onsite', locationCountry: 'DE' });
    repo.ai.set('j001', { score: 90, tier: 'great' });
    repo.ai.set('j002', { score: 85, tier: 'great' });
    const res = await service().query(ctx(), { sort: 'recommended', fitTier: 'great' });
    expect(res.items.map((i) => i.jobId).sort()).toEqual(['j001', 'j002']);
    expect(res.hiddenByTier).toBe(8);
  });

  it('company scatter: at most 2 of one company in the first 20', async () => {
    seed(40, { company: (i) => (i < 10 ? 'megacorp' : `co${i}`) });
    const res = await service().query(ctx(), { sort: 'recommended' });
    expect(res.items.filter((i) => i.company.name === 'megacorp').length).toBeLessThanOrEqual(2);
  });

  it('GoApply with 个性化推荐 off or not chosen: date order, filters only, no fit, no profile read for ranking', async () => {
    personalized = false;
    seed(5);
    repo.rows.forEach((r) => (r.market = 'cn'));
    const res = await service().query(ctx({ market: 'cn', brandId: 'goapply' }), { sort: 'recommended', fitTier: 'great' });
    expect(res.order).toBe('recency');
    expect(res.sort).toBe('newest');
    expect(res.items.map((i) => i.jobId)).toEqual(['j000', 'j001', 'j002', 'j003', 'j004']);
    expect(res.items.every((i) => i.fit === null)).toBe(true);
    expect(res.hiddenByTier).toBe(0);
    expect(userContextCalls).toBe(0);
  });

  it('"I need visa sponsorship": jobs that mention sponsorship come first under every sort', async () => {
    seed(30);
    profileFilters = { taxonomyIds: ['backend_engineer'], needsSponsorship: true };
    for (const id of ['j020', 'j025']) Object.assign(repo.rows.find((r) => r.id === id)!, { sponsorship: 'offered', sponsorshipEvidence: 'Visa sponsorship is available.' });
    // "offered" without the posting's words does not count as a mention.
    Object.assign(repo.rows.find((r) => r.id === 'j010')!, { sponsorship: 'offered', sponsorshipEvidence: null });
    for (const sort of ['recommended', 'newest', 'best_fit', 'highest_pay'] as const) {
      const res = await service().query(ctx(), { sort });
      expect(res.items.slice(0, 2).map((i) => i.jobId)).toEqual(['j020', 'j025']);
    }
    profileFilters = { taxonomyIds: ['backend_engineer'] };
    const off = await service().query(ctx(), { sort: 'newest' });
    expect(off.items[0]!.jobId).toBe('j000');
  });

  it('skills as the only narrowing filter boosts Recommended by skill overlap; with another filter it does not', async () => {
    seed(6);
    repo.rows.find((r) => r.id === 'j005')!.skills = ['python', 'sql', 'kubernetes', 'terraform'];
    // Equal fit for every job, so only freshness and the boost differ.
    for (const r of repo.rows) repo.ai.set(r.id, { score: 70, tier: 'good' });
    profileFilters = { skills: ['Kubernetes', 'Terraform'] };
    const boosted = await service().query(ctx(), { sort: 'recommended' });
    expect(boosted.items[0]!.jobId).toBe('j005');
    profileFilters = { skills: ['Kubernetes', 'Terraform'], workModels: ['remote'] };
    const plain = await service().query(ctx(), { sort: 'recommended' });
    expect(plain.items[0]!.jobId).not.toBe('j005');
  });

  it('GoApply deadline: stated close dates first (soonest first), then the rest newest first; estimated expiries ignored', async () => {
    personalized = false;
    seed(4);
    repo.rows.forEach((r) => (r.market = 'cn'));
    Object.assign(repo.rows[3]!, { marketTags: [{ tag: 'apply_closes:2026-10-15', evidenceQuote: '网申截止：10月15日' }] });
    Object.assign(repo.rows[2]!, { marketTags: [{ tag: 'apply_closes:2026-10-12', evidenceQuote: '10月12日截止' }] });
    Object.assign(repo.rows[0]!, { expiresAt: new Date('2026-10-11T00:00:00Z') });
    const res = await service().query(ctx({ market: 'cn', brandId: 'goapply' }), { sort: 'deadline' });
    expect(res.items.map((i) => i.jobId)).toEqual(['j002', 'j003', 'j000', 'j001']);
    expect(res.items[0]!.campus).toMatchObject({ applyClosesAt: '2026-10-12' });
    expect(res.items[2]!.campus).toBeNull();
    expect(res.endOfFeed).toBe(true);
    expect(repo.queries[0]!.text).not.toContain('expiresAt" >=');
  });

  it('a hidden job never comes back', async () => {
    seed(5);
    const s = service();
    await s.hide(ctx(), 'j000', { reasonCode: 'not_interested' });
    const res = await s.query(ctx(), { sort: 'newest' });
    expect(res.items.map((i) => i.jobId)).not.toContain('j000');
  });
});

describe('hide / unhide / report', () => {
  it('hide persists the exclusion, logs it, and proposes the exact filter change with its count', async () => {
    seed(3);
    repo.countResponder = () => 42;
    const res = await service().hide(ctx(), 'j001', { reasonCode: 'company' });
    expect(repo.hidden.get('u1:j001')).toMatchObject({ reason: 'company' });
    expect(repo.interactions.at(-1)).toMatchObject({ kind: 'hide', reasonCode: 'company', jobId: 'j001' });
    expect(res.proposedFilterDiff).toEqual({
      searchProfileId: 'sp1',
      baseVersion: 1,
      ops: [{ op: 'add', path: 'excludedCompanies', value: 'Co j001' }],
      patch: { excludedCompanies: ['Co j001'] },
      countAfter: 42,
    });
  });

  it('a hide with no specific reason lowers affinity (−0.1); location opens the editor', async () => {
    seed(2);
    const s = service();
    await s.hide(ctx(), 'j000', { reasonCode: 'not_interested' });
    expect(repo.affinity.get('u1')?.company['co-j000']).toBeCloseTo(-0.1);
    expect(await s.hide(ctx(), 'j001', { reasonCode: 'wrong_location' })).toEqual({ proposedFilterDiff: null, editor: 'location' });
  });

  it('GoApply without 个性化推荐: hides and saves store no preference profile (PIPL Art. 24)', async () => {
    personalized = false;
    seed(2);
    repo.rows.forEach((r) => (r.market = 'cn'));
    const s = service();
    await s.hide(ctx({ market: 'cn' }), 'j000', { reasonCode: 'not_interested' });
    await s.recordInteraction(ctx({ market: 'cn' }), 'j001', 'save');
    expect(repo.hidden.has('u1:j000')).toBe(true);
    expect(repo.affinity.has('u1')).toBe(false);
    personalized = true;
    await s.recordInteraction(ctx({ market: 'cn' }), 'j001', 'save');
    expect(repo.affinity.has('u1')).toBe(true);
  });

  it("another market's job, or someone else's private import, is 404", async () => {
    repo.rows.push(feedRow({ id: 'cnjob', market: 'cn' }), feedRow({ id: 'priv', visibility: 'private', ownerUserId: 'u9' }));
    await expectHttp(service().hide(ctx(), 'cnjob', { reasonCode: 'other' }), 'not_found', 'job_not_found');
    await expectHttp(service().report(ctx(), 'priv', { reason: 'scam' }), 'not_found');
  });

  it('unhide clears the exclusion', async () => {
    seed(1);
    const s = service();
    await s.hide(ctx(), 'j000', { reasonCode: 'other' });
    await s.unhide(ctx(), 'j000');
    expect(repo.hidden.has('u1:j000')).toBe(false);
    expect(repo.interactions.at(-1)?.kind).toBe('unhide');
  });

  it('report hides for the reporter; 3 distinct users (scam/closed class) close the job as reported', async () => {
    seed(1);
    const s = service();
    expect(await s.report(ctx({ userId: 'a' }), 'j000', { reason: 'scam' })).toEqual({ closed: false });
    expect(repo.hidden.get('a:j000')).toMatchObject({ reason: 'report:scam' });
    expect(await s.report(ctx({ userId: 'a' }), 'j000', { reason: 'fee_required' })).toEqual({ closed: false });
    expect(await s.report(ctx({ userId: 'b' }), 'j000', { reason: 'wrong_info' })).toEqual({ closed: false });
    expect(await s.report(ctx({ userId: 'b' }), 'j000', { reason: 'expired' })).toEqual({ closed: false });
    expect(await s.report(ctx({ userId: 'c' }), 'j000', { reason: 'training_loan' })).toEqual({ closed: true });
    expect(repo.closed).toEqual(['j000']);
  });

  it("a user's own private import is never closed by reports", async () => {
    repo.rows.push(feedRow({ id: 'mine', visibility: 'private', ownerUserId: 'u1' }));
    expect(await service().report(ctx(), 'mine', { reason: 'scam' })).toEqual({ closed: false });
  });
});

describe('impressions and rating', () => {
  it('impressions count only jobs of the caller’s session; unknown sessions 404', async () => {
    seed(3);
    const s = service();
    const p = await s.query(ctx(), { sort: 'newest' });
    await s.impressions(ctx(), { sessionId: p.sessionId, positions: [{ jobId: 'j000', position: 0, ms: 900 }, { jobId: 'zzz', position: 1, ms: 5 }, { jobId: 'j000', position: 0, ms: 5 }] });
    expect(repo.impressions).toEqual([{ userId: 'u1', jobIds: ['j000'] }]);
    await expectHttp(s.impressions(ctx({ userId: 'u2' }), { sessionId: p.sessionId, positions: [{ jobId: 'j000', position: 0, ms: 1 }] }), 'not_found');
  });

  it('one rating a day; reasons kept only under 8', async () => {
    const s = service();
    await s.rating(ctx(), { score: 9, reasons: ['jobs_old'] });
    expect(repo.ratings[0]).toMatchObject({ dayKey: '2026-10-10', score: 9, reasons: [] });
    await expectHttp(s.rating(ctx(), { score: 5, reasons: ['wrong_level'] }), 'conflict', 'feed_rating_already_today');
    await s.rating(ctx({ userId: 'u2' }), { score: 5, reasons: ['wrong_level', 'wrong_level'] });
    expect(repo.ratings[1]).toMatchObject({ reasons: ['wrong_level'] });
  });
});

describe('explore', () => {
  it('L1 categories with live counts, cached 10 minutes, labels per locale, sourced', async () => {
    repo.categoryCounts = [{ taxonomyId: 'software_engineering', count: 1234 }];
    let t = NOW;
    const s = service({ now: () => t });
    const a = await s.explore({ market: 'intl', now: t }, 'en');
    expect(a.categories.length).toBeGreaterThanOrEqual(20);
    const swe = a.categories.find((c) => c.taxonomyId === 'software_engineering')!;
    expect(swe).toMatchObject({ count: 1234, sourced: { value: 1234, source: 'aggregate', asOf: NOW.toISOString() } });
    expect(a.categories.find((c) => c.taxonomyId !== 'software_engineering')!.count).toBe(0);
    await s.explore({ market: 'intl', now: new Date(NOW.getTime() + 9 * 60_000) }, 'zh');
    expect(repo.queries).toHaveLength(1);
    t = new Date(NOW.getTime() + 11 * 60_000);
    const zh = await s.explore({ market: 'intl', now: t }, 'zh');
    expect(repo.queries).toHaveLength(2);
    expect(zh.categories.find((c) => c.taxonomyId === 'software_engineering')!.label).not.toBe(swe.label);
  });
});

describe('NL query', () => {
  it('without AI consent: 503 ai_unavailable and the planner is never called', async () => {
    aiOk = false;
    await expectHttp(service().nlQuery(ctx(), { text: 'remote data jobs' }, 'en'), 'ai_unavailable', 'ai_off');
    expect(plannerCalls).toEqual([]);
  });

  it('plan → FilterDiff the user confirms (nothing saved)', async () => {
    repo.countResponder = () => 17;
    plannerImpl = async () => ({ queries: ['Data Analyst'], remote: true, unverifiedPreferences: ['paying over €70k', 'great culture'] });
    const res = await service().nlQuery(ctx(), { text: 'remote data jobs paying over €70k' }, 'en');
    expect(res.diff.patch).toMatchObject({ titles: ['Data Analyst'], workModels: ['remote'], salaryMin: { amount: 70000, currency: 'EUR', period: 'year' } });
    expect(res.diff.countAfter).toBe(17);
    expect(res.unmatched).toEqual(['great culture']);
    expect(res.explanation).toBe('great culture');
  });

  it('a request with no role is 422; a planner failure is 503', async () => {
    plannerImpl = async () => {
      const e = new Error('Include a job role');
      e.name = 'JobSearchValidationError';
      throw e;
    };
    await expectHttp(service().nlQuery(ctx(), { text: 'something nice' }, 'en'), 'invalid_request', 'nl_query_no_role');
    plannerImpl = async () => {
      throw new Error('timeout');
    };
    await expectHttp(service().nlQuery(ctx(), { text: 'data jobs' }, 'en'), 'ai_unavailable', 'planner_failed');
  });
});

describe('new-count and skills-check', () => {
  it('counts ≥ Good fit jobs first seen since the last visit; markVisited stamps it', async () => {
    seed(6);
    repo.visits.set('u1', new Date(NOW.getTime() - 3.5 * 3_600_000));
    repo.ai.set('j000', { score: 90, tier: 'great' });
    repo.ai.set('j001', { score: 40, tier: 'unlikely' });
    repo.ai.set('j002', { score: 66, tier: 'good' });
    const s = service();
    const res = await s.newCount(ctx(), {});
    expect(res).toEqual({ count: 2, since: new Date(NOW.getTime() - 3.5 * 3_600_000).toISOString(), capped: false });
    // A polling badge (no markVisited) never resets itself.
    expect(repo.visits.get('u1')).not.toEqual(NOW);
    await s.newCount(ctx(), { since: daysAgo(1).toISOString(), markVisited: true });
    expect(repo.visits.get('u1')).toEqual(NOW);
  });

  it('a polling badge is cached for 2 minutes per user and visit; markVisited drops the cache', async () => {
    seed(3);
    repo.visits.set('u1', daysAgo(1));
    let t = NOW;
    const s = service({ now: () => t });
    await s.newCount(ctx(), {});
    await s.newCount(ctx({ now: new Date(NOW.getTime() + 60_000) }), {});
    expect(repo.queries).toHaveLength(1);
    expect(userContextCalls).toBe(1);
    t = new Date(NOW.getTime() + 3 * 60_000);
    await s.newCount(ctx({ now: t }), {});
    expect(repo.queries).toHaveLength(2);
    // Another user is counted on their own.
    await s.newCount(ctx({ userId: 'u2', now: t }), {});
    expect(repo.queries).toHaveLength(3);
    await s.newCount(ctx({ now: t }), { markVisited: true });
    const after = await s.newCount(ctx({ now: t }), {});
    expect(repo.queries).toHaveLength(4);
    expect(after.since).toBe(t.toISOString());
  });

  it('says when the personalised count hit the 400-job window (capped)', async () => {
    seed(401);
    repo.visits.set('u1', daysAgo(30));
    const res = await service().newCount(ctx(), {});
    expect(res.capped).toBe(true);
  });

  it('without personalisation it runs a capped count query of new matching jobs (no scoring)', async () => {
    personalized = false;
    repo.countResponder = () => 4;
    const res = await service().newCount(ctx({ market: 'cn' }), { since: daysAgo(1).toISOString() });
    expect(res).toEqual({ count: 4, since: daysAgo(1).toISOString(), capped: false });
    expect(repo.queries.at(-1)!.text).toContain('j."firstSeenAt" > $');
    expect(repo.queries.at(-1)!.text).toContain('count(*)');
    expect(userContextCalls).toBe(0);
    repo.countResponder = () => 5001;
    expect(await service().newCount(ctx({ market: 'cn' }), { since: daysAgo(2).toISOString() })).toMatchObject({ count: 5000, capped: true });
  });

  it('skills-check: required skills missing from the profile, "asked in X of Y"', async () => {
    seed(5);
    repo.rows[0]!.skillsDetail = [{ skill: 'Kubernetes', required: true }, { skill: 'Python', required: true }];
    repo.rows[1]!.skillsDetail = [{ skill: 'kubernetes', required: true }, { skill: 'Terraform', required: true }];
    repo.rows[2]!.skillsDetail = [{ skill: 'Terraform', required: true }, { skill: 'Go', required: false }];
    repo.rows[3]!.skills = ['rust'];
    repo.rows[4]!.skills = ['rust'];
    repo.skills = ['Python'];
    profileFilters = { taxonomyIds: ['backend_engineer'], excludedSkills: ['Rust'] };
    const res = await service().skillsCheck(ctx());
    expect(res.skills).toEqual([
      { skill: 'Kubernetes', askedIn: 2, outOf: 5 },
      { skill: 'Terraform', askedIn: 2, outOf: 5 },
    ]);
  });
});

describe('counts and the search seams', () => {
  it('For you / Saved / Added by you / Applied', async () => {
    repo.countResponder = () => 123;
    repo.tracker.set('a', 'bookmarked').set('b', 'applied').set('c', 'bookmarked');
    repo.rows.push(feedRow({ id: 'imp', visibility: 'private', ownerUserId: 'u1' }));
    expect(await service().counts(ctx())).toEqual({ forYou: 123, saved: 2, external: 1, applied: 1 });
  });

  it('countForFilters caps at 5,000', async () => {
    repo.countResponder = () => 5001;
    expect(await service().countForFilters(ctx(), {})).toEqual({ count: 5000, capped: true });
    repo.countResponder = () => 12;
    expect(await service().countForFilters(ctx(), {})).toEqual({ count: 12, capped: false });
  });

  it('limitingFilters: one count per relaxation, gains sorted, zero-gain filters dropped', async () => {
    profileFilters = { workModels: ['remote'], country: 'US', excludeAgencies: true, fitTier: 'great' };
    repo.countResponder = (sql) => {
      const remote = sql.text.includes('j."workModel" = ANY(');
      const us = sql.text.includes('j."locationCountry" = $');
      return remote && us ? 0 : remote ? 40 : us ? 7 : 999;
    };
    const res = await service().limitingFilters(ctx(), 'sp1');
    expect(res).toEqual([
      { field: 'country', value: 'US', removalGain: 40 },
      { field: 'workModels', value: ['remote'], removalGain: 7 },
    ]);
    expect(repo.queries).toHaveLength(4);
  });

  it('recordInteraction raises affinity for saves (+0.1)', async () => {
    seed(1);
    await service().recordInteraction(ctx(), 'j000', 'save');
    expect(repo.affinity.get('u1')?.taxonomy.backend_engineer).toBeCloseTo(0.1);
  });

  it('publicList: publicDisplay jobs only, no fit, no session', async () => {
    seed(2);
    const s = service();
    const items = await s.publicList({ market: 'intl', now: NOW }, { role: 'engineer', limit: 20 });
    expect(items[0]).not.toHaveProperty('fit');
    expect(repo.queries.at(-1)!.text).toContain('j."publicDisplay" = true');
    expect(repo.sessions.size).toBe(0);
  });

  it('preview: top ranked items for the Assistant, no session', async () => {
    seed(8);
    const items = await service().preview(ctx(), { limit: 3, sort: 'newest' });
    expect(items.map((i) => i.jobId)).toEqual(['j000', 'j001', 'j002']);
    expect(repo.sessions.size).toBe(0);
  });
});
