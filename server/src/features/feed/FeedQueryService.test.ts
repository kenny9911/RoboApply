// @vitest-environment node
//
// WP-32 service tests over an in-memory repo (no database, no network, no model):
// sessions + cursor stability + older-window refill, refresh limit, ranking on the
// fits of match `getFits` (one call per window, never the scorer), fit-tier hiding
// counts with the low-confidence rule, company scatter, GoApply non-personalised
// order, hide/unhide with filter diffs, report thresholds, impressions, daily
// rating, Explore cache, NL query (aiAllowed), new-count, skills-check, counts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { HttpError } from '../../platform/http.js';
import { DEFAULT_MATCH_PRIORS, DEFAULT_MATCH_TIERS, DEFAULT_MATCH_WEIGHTS, buildMatchUser } from '../match/index.js';
import { EMPTY_AFFINITY } from './affinity.js';
import type { FilterSet, SearchProfileWire } from '../search/index.js';
import { SearchProfileNotFoundError } from '../search/index.js';
import { createFeedQueryService, type FeedServiceDeps } from './FeedQueryService.js';
import type { PlannerPlan } from './filterDiff.js';
import { recommendedRank } from './ranking.js';
import { BANK_PAGES_ENV, FakeFeedRepo, fakeFeedMatch, feedRow, type FakeFeedMatch, type FakeFeedMatchOptions } from './testkit.js';
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
let match: FakeFeedMatch;
/** Who the feed is for (default: `person`) and how the fake match is set up, per test. */
let personOf: (userId: string) => ReturnType<typeof person>;
let matchOptions: Partial<FakeFeedMatchOptions>;
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

/** The person: a mid-level backend engineer (their record says so) with Python and SQL, in the US. */
function person(userId: string) {
  userContextCalls += 1;
  const user = buildMatchUser(
    {
      userId,
      market: 'intl',
      profile: { firstName: null, lastName: null, country: 'US', skills: [{ name: 'Python' }, { name: 'SQL' }], workAuth: [], cnFields: null },
      education: [],
      experience: [{ title: 'Backend Engineer', company: 'Acme', startYm: '2022-01', endYm: null, current: true, kind: 'work' }],
      resumeParsed: null,
      searchProfile: { filters: { taxonomyIds: ['backend_engineer'], seniority: ['mid'] }, version: 1 },
      employerIndustries: [],
    },
    NOW,
  );
  return { user, resume: { id: 'rv1', resumeMarkdown: '', resumeContentHash: 'h', parsedData: null, targetJobId: null } };
}

/** A student with no experience and no parsed resume: role from the headline, level from the onboarding answer only. */
function studentWithNoRecord(userId: string): ReturnType<typeof person> {
  userContextCalls += 1;
  const user = buildMatchUser(
    {
      userId,
      market: 'intl',
      profile: { firstName: null, lastName: null, country: 'US', skills: [{ name: 'Python' }, { name: 'SQL' }], workAuth: [], cnFields: null, headline: 'Backend Engineer', seekerType: 'student' },
      education: [],
      experience: [],
      resumeParsed: null,
      searchProfile: { filters: { taxonomyIds: ['backend_engineer'] }, version: 1 },
      employerIndustries: [],
    },
    NOW,
  );
  return { user, resume: { id: 'rv1', resumeMarkdown: '', resumeContentHash: 'h', parsedData: null, targetJobId: null } };
}

function service(over: Partial<FeedServiceDeps> = {}) {
  // The real fit assembly (match/fit.ts) over the fake repo's rows; `repo.ai` holds the person's stored AI scores.
  match = fakeFeedMatch({ repo, context: (userId) => personOf(userId), now: () => NOW, ...matchOptions });
  return createFeedQueryService({
    repo,
    match,
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
  personOf = person;
  matchOptions = {};
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

  it('relevance is accepted and part of the session identity, and does not change the order in this phase', async () => {
    seed(70);
    const s = service();
    const plain = await s.query(ctx(), { sort: 'recommended' });
    const ranked = await s.query(ctx(), { sort: 'recommended', relevance: 'climate startups Rust' });
    // Same list, same order: nothing reads the text for ordering before phase M4.
    expect(ranked.items.map((i) => i.jobId)).toEqual(plain.items.map((i) => i.jobId));
    expect(ranked.order).toBe(plain.order);
    // A different session hash: a cursor of one query is not a cursor of the other.
    const hashPlain = repo.sessions.get(plain.sessionId)!.queryHash;
    const hashRanked = repo.sessions.get(ranked.sessionId)!.queryHash;
    expect(hashRanked).not.toBe(hashPlain);
    await expectHttp(s.query(ctx(), { sort: 'recommended', cursor: ranked.cursor! }), 'conflict', 'feed_session_expired');
    const next = await s.query(ctx(), { sort: 'recommended', relevance: 'climate startups Rust', cursor: ranked.cursor! });
    expect(next.items[0]!.position).toBe(20);
    // The text is trimmed; another text is another session; an empty one is no text at all.
    const padded = await s.query(ctx(), { sort: 'recommended', relevance: '  climate startups Rust ' });
    expect(repo.sessions.get(padded.sessionId)!.queryHash).toBe(hashRanked);
    const other = await s.query(ctx(), { sort: 'recommended', relevance: 'fintech Go' });
    expect(repo.sessions.get(other.sessionId)!.queryHash).not.toBe(hashRanked);
    const blank = await s.query(ctx(), { sort: 'recommended', relevance: '   ' });
    expect(repo.sessions.get(blank.sessionId)!.queryHash).toBe(hashPlain);
  });

  it('relevance longer than 240 characters is refused, on the query and on the preview seam', async () => {
    seed(5);
    await expectHttp(service().query(ctx(), { sort: 'newest', relevance: 'x'.repeat(241) }), 'invalid_request', 'relevance_too_long');
    await expectHttp(service().preview(ctx(), { limit: 5, relevance: 'x'.repeat(241) }), 'invalid_request', 'relevance_too_long');
    // The preview accepts the field and answers the list it answers without it.
    const without = await service().preview(ctx(), { limit: 5, sort: 'newest' });
    const withText = await service().preview(ctx(), { limit: 5, sort: 'newest', relevance: 'climate startups' });
    expect(withText.map((i) => i.jobId)).toEqual(without.map((i) => i.jobId));
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

  it('the fits of a window come from one getFits call (never the scorer), and the card carries the fit with its confidence', async () => {
    seed(30);
    repo.ai.set('j003', { score: 91, tier: 'great' });
    const s = service();
    const res = await s.query(ctx(), { sort: 'recommended' });
    // One call for the window of 30 rows; the page of 20 is cut from it without a second read.
    expect(match.calls.getFits).toHaveLength(1);
    expect(match.calls.getFits[0]!.slice().sort()).toEqual(repo.rows.map((r) => r.id).sort());
    expect(match.calls.userContext).toBe(1);
    // The window's own rows travel with the call, so the fit read loads no job row and no description again.
    expect(match.calls.rowsHanded).toEqual([30]);
    const fits = await match.getFits('u1', repo.rows.map((r) => r.id));
    for (const item of res.items) {
      const fit = fits.get(item.jobId)!;
      // The same score, tier and kind the fit contract answers for this person and job (wire kind `pre` for an estimate).
      expect(item.fit, item.jobId).toEqual({ tier: fit.tier, score: fit.score, kind: fit.kind === 'ai' ? 'ai' : 'pre', topGap: fit.topGap, topOverlap: fit.topOverlap, confidence: fit.confidence, confidenceReason: fit.confidenceReason });
    }
    expect(res.items.find((i) => i.jobId === 'j003')!.fit).toMatchObject({ kind: 'ai', score: 91, tier: 'great' });
    expect(res.items.find((i) => i.jobId === 'j000')!.fit).toMatchObject({ kind: 'pre', score: 83, tier: 'great', confidence: 'high', confidenceReason: null });
    // The second page reads no fit again: the session and its cache answer.
    match.calls.getFits.length = 0;
    await s.query(ctx(), { sort: 'recommended', cursor: res.cursor! });
    expect(match.calls.getFits.flat().filter((id) => res.items.some((i) => i.jobId === id))).toEqual([]);
  });

  it('the card, the session ranks and "Why this job" all come from the same fit', async () => {
    seed(6);
    repo.ai.set('j002', { score: 72, tier: 'good', dimensions: [{ key: 'title_level', weight: 35, score: 72, status: 'scored', evidence: [] }, { key: 'skills', weight: 30, score: 72, status: 'scored', evidence: [] }] });
    const explained: Array<Record<string, unknown>> = [];
    const s = service({
      explain: (input) => {
        explained.push(input as unknown as Record<string, unknown>);
        return { mode: 'personalized', headline: { key: 'h' }, reasons: [], gaps: [], notices: [] };
      },
    });
    const res = await s.query(ctx(), { sort: 'recommended' });
    const fits = await match.getFits('u1', repo.rows.map((r) => r.id));
    const ranks = repo.sessions.get(res.sessionId)!.ranks as Array<{ jobId: string; fit: number | null; kind: string; rank: number }>;
    expect(explained).toHaveLength(6);
    for (const [i, item] of res.items.entries()) {
      const fit = fits.get(item.jobId)!;
      const wire = fit.kind === 'ai' ? 'ai' : 'pre';
      // The card.
      expect([item.fit!.score, item.fit!.tier, item.fit!.kind], item.jobId).toEqual([fit.score, fit.tier, wire]);
      // The session ranks.
      expect(ranks.find((r) => r.jobId === item.jobId), item.jobId).toMatchObject({ fit: fit.score, kind: wire });
      // "Why this job": the components and the skill split of that fit (the AI's for the AI score, the estimate's otherwise).
      // The tier too: the headline names the tier on the card, which is not always the score's own (hysteresis, admin thresholds).
      expect(explained[i], item.jobId).toMatchObject({ personalized: true, score: fit.score, tier: fit.tier, kind: wire, dimensions: fit.dimensions, skills: { aligned: fit.skills.aligned, missing: fit.skills.missing } });
    }
    expect(fits.get('j002')!.dimensions.map((d) => d.score)).toEqual([72, 72]);
  });

  it('"Why this job" leaves out a logistics part that only repeats the person\'s own filters (neither a reason nor a gap)', async () => {
    seed(2);
    // The saved search filters on remote work: every listed job meets it, so the check says nothing about the job.
    profileFilters = { taxonomyIds: ['backend_engineer'], workModels: ['remote'] };
    personOf = (userId) => {
      const base = person(userId);
      return { ...base, user: { ...base.user, workModels: ['remote'], hardFilters: { location: true, pay: false } } };
    };
    const explained: Array<{ dimensions?: Array<{ key: string }> }> = [];
    const s = service({
      explain: (input) => {
        explained.push(input);
        return { mode: 'personalized', headline: { key: 'h' }, reasons: [], gaps: [], notices: [] };
      },
    });
    await s.query(ctx(), { sort: 'recommended' });
    const fit = (await match.getFits('u1', ['j000'])).get('j000')!;
    const logistics = fit.dimensions.find((d) => d.key === 'logistics')!;
    // Not compared (it counts at its prior in the total), with the one line that says why.
    expect(logistics).toMatchObject({ status: 'not_stated', score: null });
    expect(logistics.evidence.map((e) => e.ref)).toEqual(['logistics_by_your_filters']);
    expect(logistics.evidence[0]!.text.trim()).not.toBe('');
    expect(explained[0]!.dimensions!.map((d) => d.key)).toEqual(['title_level', 'skills', 'industry', 'career_path']);
  });

  it('the ranking input is on one scale: a scored job equal to its estimate ranks with its unscored twin; an AI score moves it half way', async () => {
    seed(3);
    // The three rows are twins (same posting facts, same date), so only the fit input differs.
    const at = new Date(NOW.getTime() - 3_600_000);
    for (const r of repo.rows) Object.assign(r, { postedAt: at, firstSeenAt: at });
    repo.ai.set('j001', { score: 83, tier: 'great' }); // the AI agrees with the estimate (83)
    repo.ai.set('j002', { score: 63, tier: 'possible' }); // the AI says 20 less
    const res = await service().query(ctx(), { sort: 'recommended' });
    const ranks = Object.fromEntries((repo.sessions.get(res.sessionId)!.ranks as Array<{ jobId: string; rank: number }>).map((r) => [r.jobId, r.rank]));
    const rc = { now: NOW, affinity: EMPTY_AFFINITY, preferredCompanyKeys: new Set<string>(), goal: { goal: null, filters: {} } };
    const row = repo.rows[0]!;
    // Unscored, estimate 83 → ranked on 83. Scored 83 with estimate 83 → 83: not a point lower for being scored.
    expect(ranks.j000).toBe(recommendedRank(row, 83, rc));
    expect(ranks.j001).toBe(ranks.j000);
    // Scored 63 next to an estimate of 83 → 83 + 0.5 × (63 − 83) = 73.
    expect(ranks.j002).toBe(recommendedRank(row, 73, rc));
    expect(res.items.at(-1)!.jobId).toBe('j002');
    // With the market's calibration map the scored job ranks on its AI score and the others on the mapped estimate.
    matchOptions = { map: () => ({ knots: [[0, 0], [100, 50]] }) };
    const mapped = await service().query(ctx(), { sort: 'recommended' });
    const mappedRanks = Object.fromEntries((repo.sessions.get(mapped.sessionId)!.ranks as Array<{ jobId: string; rank: number }>).map((r) => [r.jobId, r.rank]));
    expect(mappedRanks.j000).toBe(recommendedRank(row, 41.5, rc));
    expect(mappedRanks.j001).toBe(recommendedRank(row, 83, rc));
    expect(mappedRanks.j002).toBe(recommendedRank(row, 63, rc));
    // The card of an unscored job shows the mapped estimate.
    expect(mapped.items.find((i) => i.jobId === 'j000')!.fit).toMatchObject({ kind: 'pre', score: 42 });
  });

  it('an unscored low-confidence job with an estimate of 82 is hidden by the Great view and counted in hiddenByTier', async () => {
    seed(4);
    for (const r of repo.rows) r.seniority = 'intern_newgrad';
    // A student with no resume and no experience on file: the level is only their onboarding answer, so every estimate is low confidence.
    personOf = studentWithNoRecord;
    matchOptions = { config: () => ({ weights: { ...DEFAULT_MATCH_WEIGHTS }, tiers: { ...DEFAULT_MATCH_TIERS }, priors: { ...DEFAULT_MATCH_PRIORS, industry: 17 } }) };
    // One of the four has an AI score: it is judged on that score, whatever the estimate's confidence.
    repo.ai.set('j003', { score: 84, tier: 'great' });

    const all = await service().query(ctx(), { sort: 'recommended' });
    expect(all.items.find((i) => i.jobId === 'j000')!.fit).toMatchObject({ kind: 'pre', score: 82, tier: 'great', confidence: 'low' });
    expect(all.hiddenByTier).toBe(0);

    const great = await service().query(ctx(), { sort: 'recommended', fitTier: 'great' });
    expect(great.items.map((i) => i.jobId)).toEqual(['j003']);
    expect(great.hiddenByTier).toBe(3);
    const good = await service().query(ctx(), { sort: 'recommended', fitTier: 'good' });
    expect(good.items.map((i) => i.jobId)).toEqual(['j003']);
    expect(good.hiddenByTier).toBe(3);
  });

  it('an AI score is listed by the tier its card shows: Good at 81 is not under Great, Great at 79 is', async () => {
    seed(3);
    // Stored tiers that the recomputed totals have not moved 3 points past (hysteresis): the card keeps the stored tier.
    repo.ai.set('j001', { score: 81, tier: 'good' });
    repo.ai.set('j002', { score: 79, tier: 'great' });
    const all = await service().query(ctx(), { sort: 'best_fit' });
    expect(all.items.find((i) => i.jobId === 'j001')!.fit).toMatchObject({ kind: 'ai', score: 81, tier: 'good' });
    expect(all.items.find((i) => i.jobId === 'j002')!.fit).toMatchObject({ kind: 'ai', score: 79, tier: 'great' });

    const great = await service().query(ctx(), { sort: 'best_fit', fitTier: 'great' });
    // Every card in the Great view says Great; the Good card at 81 is not among them.
    expect(great.items.every((i) => i.fit!.tier === 'great')).toBe(true);
    expect(great.items.map((i) => i.jobId)).toContain('j002');
    expect(great.items.map((i) => i.jobId)).not.toContain('j001');
    const good = await service().query(ctx(), { sort: 'best_fit', fitTier: 'good' });
    expect(good.items.map((i) => i.jobId)).toEqual(expect.arrayContaining(['j001', 'j002']));
  });

  it('fits that cannot be read never drop a row: the window is listed without a fit', async () => {
    seed(5);
    const s = service();
    match.getFits = async () => {
      throw new Error('match store down');
    };
    const res = await s.query(ctx(), { sort: 'recommended' });
    expect(res.items).toHaveLength(5);
    expect(res.items.every((i) => i.fit === null)).toBe(true);
    // With no fit the tier view hides nothing it cannot judge.
    const great = await s.query(ctx(), { sort: 'recommended', fitTier: 'great' });
    expect(great.items).toHaveLength(5);
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

  it('returns rankedBy next to the diff: the topics of the request, never a pay phrase; explanation and unmatched are as before', async () => {
    repo.countResponder = () => 9;
    plannerImpl = async () => ({ queries: ['Backend Engineer'], unverifiedPreferences: ['climate startups', 'using Rust', 'salary above 150k'] });
    const res = await service().nlQuery(ctx(), { text: 'backend jobs at climate startups using Rust, salary above 150k' }, 'en');
    expect(res.rankedBy).toEqual(['climate startups', 'Rust']);
    expect(res.unmatched).toEqual(['climate startups', 'using Rust', 'salary above 150k']);
    expect(res.explanation).toBe('climate startups; using Rust; salary above 150k');
    expect(res.diff.patch).toMatchObject({ titles: ['Backend Engineer'] });
    // The planner's own terms win when it gives them.
    plannerImpl = async () => ({ queries: ['Backend Engineer'], unverifiedPreferences: ['salary above 150k'], relevanceTerms: ['climate tech', 'Rust'] }) as never;
    expect((await service().nlQuery(ctx(), { text: 'backend jobs' }, 'en')).rankedBy).toEqual(['climate tech', 'Rust']);
    // Nothing left over: an empty list, never undefined.
    plannerImpl = async () => ({ queries: ['Data Analyst'], unverifiedPreferences: [] });
    expect((await service().nlQuery(ctx(), { text: 'data analyst' }, 'en')).rankedBy).toEqual([]);
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

  it('the badge counts by the rule of the "Good or better" view: a low-confidence quick estimate does not count', async () => {
    seed(4);
    repo.visits.set('u1', new Date(NOW.getTime() - 5.5 * 3_600_000));
    for (const r of repo.rows) r.seniority = 'intern_newgrad';
    // A student with no resume and no experience on file: every estimate is low confidence, however high.
    personOf = studentWithNoRecord;
    // One job has an AI score at Good: it counts on that score.
    repo.ai.set('j002', { score: 70, tier: 'good' });
    const res = await service().newCount(ctx(), {});
    const fits = await match.getFits('u1', repo.rows.map((r) => r.id));
    expect(['j000', 'j001', 'j003'].map((id) => [fits.get(id)!.confidence, fits.get(id)!.score! >= 65])).toEqual([['low', true], ['low', true], ['low', true]]);
    expect(res.count).toBe(1);
    // The same rows for a person whose record backs the estimate: all four count.
    personOf = person;
    for (const r of repo.rows) r.seniority = 'mid';
    expect((await service().newCount(ctx(), {})).count).toBe(4);
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
    // "Added by you" = the user's own imports that are still open (WP-35): sourceBoard 'user_import', not archived.
    repo.rows.push(feedRow({ id: 'imp', visibility: 'private', ownerUserId: 'u1', sourceBoard: 'user_import' }));
    repo.rows.push(feedRow({ id: 'imp_gone', visibility: 'private', ownerUserId: 'u1', sourceBoard: 'user_import', archivedAt: NOW }));
    repo.rows.push(feedRow({ id: 'imp_other', visibility: 'private', ownerUserId: 'u2', sourceBoard: 'user_import' }));
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

// ── Source header, thin results and the mainland apply-link rule (GOAPPLY_PARITY_PLAN §3.9, §5) ──

describe('GoApply: where postings come from, thin results, and no posting without an apply link', () => {
  const cn = () => ctx({ market: 'cn', brandId: 'goapply' });
  const cnRow = (id: string, over: Partial<Parameters<typeof feedRow>[0]> = {}) =>
    feedRow({ id, market: 'cn', sourceBoard: 'smartrecruiters', sourceName: '示例 · SmartRecruiters', companyName: '示例公司', companyNameNormalized: '示例公司', postedAt: daysAgo(1), firstSeenAt: daysAgo(1), ...over });

  beforeEach(() => {
    personalized = false;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sources: employer boards are counted from the rows the query can reach; gohire only when a GoHire row is listed', async () => {
    repo.rows.push(
      cnRow('b1', { companyNameNormalized: 'bosch', sourceBoard: 'smartrecruiters' }),
      cnRow('b2', { companyNameNormalized: 'bosch', sourceBoard: 'smartrecruiters' }),
      cnRow('b3', { companyNameNormalized: 'riot', sourceBoard: 'greenhouse' }),
      cnRow('b4', { companyNameNormalized: 'veeva', sourceBoard: 'lever' }),
      // Not a board: the user's own import and another market's row never count.
      cnRow('own', { visibility: 'private', ownerUserId: 'u1', sourceBoard: 'user_import', companyNameNormalized: 'mine' }),
      feedRow({ id: 'intl1', sourceBoard: 'greenhouse', companyNameNormalized: 'acme' }),
    );
    const boardsOnly = await service().query(cn(), { sort: 'newest' });
    expect(boardsOnly.sources).toEqual({ gohire: false, employerBoards: 3 });
    expect(boardsOnly.items.map((i) => i.jobId).sort()).toEqual(['b1', 'b2', 'b3', 'b4', 'own']);

    repo.rows.push(cnRow('g1', { sourceBoard: 'gohire', sourceName: 'GoHire', fromRecruiterBank: true, companyNameNormalized: 'bank co' }));
    // GoHire has no posting page: its row is held, so the header does not name GoHire.
    expect((await service().query(cn(), { sort: 'newest' })).sources).toEqual({ gohire: false, employerBoards: 3 });
    vi.stubEnv('GOHIRE_PUBLIC_JOB_URL_TEMPLATE', BANK_PAGES_ENV.GOHIRE_PUBLIC_JOB_URL_TEMPLATE!);
    const withBank = await service().query(cn(), { sort: 'newest' });
    expect(withBank.sources).toEqual({ gohire: true, employerBoards: 3 });
    // The header statement reads public rows of this market only, whoever asks.
    const stmt = repo.sourceQueries.at(-1)!;
    expect(stmt.text).toContain(`j."visibility" = 'public'`);
    expect(stmt.text).not.toContain('"ownerUserId" =');
    expect(stmt.values).toContain('cn');
  });

  it('sources is counted, never guessed: a failed count leaves the field off and the list still answers; RoboApply sends none', async () => {
    repo.rows.push(cnRow('b1'));
    repo.failSources = true;
    const res = await service().query(cn(), { sort: 'newest' });
    expect(res.items.map((i) => i.jobId)).toEqual(['b1']);
    expect(res).not.toHaveProperty('sources');
    repo.failSources = false;

    personalized = true;
    seed(3);
    const intl = await service().query(ctx(), { sort: 'newest' });
    expect(intl).not.toHaveProperty('sources');
    expect(repo.sourceQueries.filter((q) => q.values.includes('intl'))).toHaveLength(0);
    expect(intl.thin).toBe(true);
  });

  it('thin: true under the thin-result threshold (60), false at or above it, on every page', async () => {
    for (let i = 0; i < 59; i++) repo.rows.push(cnRow(`t${String(i).padStart(2, '0')}`, { postedAt: new Date(daysAgo(1).getTime() - i * 60_000), companyNameNormalized: `co${i}` }));
    const thin = await service().query(cn(), { sort: 'newest' });
    expect(thin.thin).toBe(true);
    expect((await service().query(cn(), { sort: 'newest', cursor: thin.cursor! })).thin).toBe(true);
    repo.rows.push(cnRow('t59', { postedAt: daysAgo(2), companyNameNormalized: 'co59' }));
    const enough = await service().query(cn(), { sort: 'newest' });
    expect(enough.thin).toBe(false);
    // An empty list is thin too (the web shows the search links to other sites).
    repo.rows = [];
    const empty = await service().query(cn(), { sort: 'newest' });
    expect(empty).toMatchObject({ items: [], thin: true, sources: { gohire: false, employerBoards: 0 } });
  });

  it('thin is about the whole list: 30 recent postings and 100 older ones is not a thin list, on any page', async () => {
    // Employer-board postings stay open for months: the first window (45 days) holds 30, the list (120 days) 130.
    for (let i = 0; i < 30; i++) repo.rows.push(cnRow(`n${String(i).padStart(3, '0')}`, { postedAt: new Date(daysAgo(2).getTime() - i * 3_600_000), companyNameNormalized: `new${i}` }));
    for (let i = 0; i < 100; i++) repo.rows.push(cnRow(`o${String(i).padStart(3, '0')}`, { postedAt: new Date(daysAgo(60).getTime() - i * 8 * 3_600_000), companyNameNormalized: `old${i}` }));
    const first = await service().query(cn(), { sort: 'newest' });
    expect(first.items).toHaveLength(20);
    expect(first.cursor).not.toBeNull();
    expect(first.thin).toBe(false);
    // Paging on reaches the older postings: the list was never thin.
    let page = first;
    const seen = new Set(first.items.map((i) => i.jobId));
    while (page.cursor) {
      page = await service().query(cn(), { sort: 'newest', cursor: page.cursor });
      expect(page.thin).toBe(false);
      for (const item of page.items) seen.add(item.jobId);
    }
    expect(seen.size).toBe(130);
  });

  it('thin is known on the first page: 30 postings and nothing older is thin although a second page follows', async () => {
    for (let i = 0; i < 30; i++) repo.rows.push(cnRow(`n${String(i).padStart(3, '0')}`, { postedAt: new Date(daysAgo(2).getTime() - i * 3_600_000), companyNameNormalized: `new${i}` }));
    const first = await service().query(cn(), { sort: 'newest' });
    expect(first.cursor).not.toBeNull();
    expect(first.thin).toBe(true);
    // Without the count nothing says the list is short until it ends: not thin while more may come, thin at the end.
    repo.failSources = true;
    const blind = await service().query(cn(), { sort: 'newest' });
    expect(blind.thin).toBe(false);
    const last = await service().query(cn(), { sort: 'newest', cursor: blind.cursor! });
    expect(last).toMatchObject({ endOfFeed: true, thin: true });
    repo.failSources = false;
  });

  it('a public mainland row with no usable apply link reaches no list, count seam, sample, alert or preview; the own import does', async () => {
    repo.rows.push(
      cnRow('ok'),
      cnRow('empty', { applyUrl: '' }),
      cnRow('blank', { applyUrl: '   ' }),
      cnRow('nolink', { applyUrl: null }),
      cnRow('script', { applyUrl: 'javascript:alert(1)' }),
      cnRow('own', { visibility: 'private', ownerUserId: 'u1', sourceBoard: 'user_import', applyUrl: '' }),
    );
    const findById = async () => ({ ...profile(), userId: 'u1', brand: 'goapply' as const });
    const svc = service({ search: { getActive: async () => profile(), get: async () => profile(), findById } as unknown as FeedServiceDeps['search'] });
    const listed = await svc.query(cn(), { sort: 'newest' });
    expect(listed.items.map((i) => i.jobId).sort()).toEqual(['ok', 'own']);
    // No listed public mainland item is without its apply link.
    for (const item of listed.items.filter((i) => i.source.kind !== 'user_import')) expect(item.apply?.url).toMatch(/^https?:/);
    expect(await svc.sampleForFilters(cn(), {}, { limit: 400 })).toEqual(['ok']);
    const preview = await svc.preview(cn(), { limit: 10, sort: 'newest' });
    expect(preview.map((i) => i.jobId).sort()).toEqual(['ok', 'own']);
    // The preview seam (the Assistant's tools, the job-search `index` provider) carries the same contract fields.
    expect(preview.find((i) => i.jobId === 'ok')).toMatchObject({ apply: { url: 'https://jobs.example.com/apply/ok', target: 'employer' }, source: { via: 'ats', original: '示例公司' } });
    expect((await svc.alertCandidates({ market: 'cn', now: NOW }, 'sp1', { since: daysAgo(30), limit: 100 })).ids).toEqual(['ok']);
    // Every statement over the mainland index carries the guard (count statements included).
    await svc.countForFilters(cn(), {});
    const cnStatements = repo.queries.filter((q) => q.values.includes('cn') && /FROM "RAJob" j LEFT JOIN/.test(q.text));
    expect(cnStatements.length).toBeGreaterThan(4);
    for (const q of cnStatements) expect(q.text).toContain(`(j."visibility" <> 'public' OR j."applyUrl" ~* '^[[:space:]]*https?://')`);
  });

  it('no posting-age cut-off for board or bank rows: a board posting 300 days old is listed, counted, sampled and previewed; an aggregator row that old is not', async () => {
    const old = { postedAt: daysAgo(300), firstSeenAt: daysAgo(300) };
    repo.rows.push(
      cnRow('recent'),
      cnRow('old_board', { ...old, sourceBoard: 'greenhouse', companyNameNormalized: 'riot' }),
      cnRow('old_agg', { ...old, sourceBoard: 'activejobs', companyNameNormalized: 'agg' }),
      // The user's own import keeps the age floor, as before.
      cnRow('old_own', { ...old, visibility: 'private', ownerUserId: 'u1', sourceBoard: 'user_import', companyNameNormalized: 'mine' }),
    );
    const res = await service().query(cn(), { sort: 'newest' });
    expect(res.items.map((i) => i.jobId)).toEqual(['recent', 'old_board']);
    expect(res.endOfFeed).toBe(true);
    // The header counts what the list shows: the old board is one of the two employer boards.
    expect(res.sources).toEqual({ gohire: false, employerBoards: 2 });
    // The session-less seams: the preview (Assistant tools, the job-search `index` provider), the report sample, the deadline order.
    expect((await service().preview(cn(), { limit: 10, sort: 'newest' })).map((i) => i.jobId)).toEqual(['recent', 'old_board']);
    expect(await service().sampleForFilters(cn(), {}, { limit: 400 })).toEqual(['recent', 'old_board']);
    expect((await service().query(cn(), { sort: 'deadline' })).items.map((i) => i.jobId)).toEqual(['recent', 'old_board']);
    // The user's own "posted within" stays a hard bound for every row.
    expect((await service().query(cn(), { sort: 'newest', overrides: { postedWithinDays: 30 } })).items.map((i) => i.jobId)).toEqual(['recent']);
    // RoboApply: the same rule for its board and bank rows (the aggregator rows keep the 120-day floor).
    personalized = true;
    vi.stubEnv('ROBOHIRE_PUBLIC_JOB_URL_TEMPLATE', BANK_PAGES_ENV.ROBOHIRE_PUBLIC_JOB_URL_TEMPLATE!);
    repo.rows.push(
      feedRow({ id: 'i_board', ...old, sourceBoard: 'lever' }),
      feedRow({ id: 'i_bank', ...old, sourceBoard: 'robohire', fromRecruiterBank: true }),
      feedRow({ id: 'i_agg', ...old, sourceBoard: 'jsearch' }),
    );
    expect((await service().query(ctx(), { sort: 'newest' })).items.map((i) => i.jobId).sort()).toEqual(['i_bank', 'i_board']);
  });

  it('board rows older than the age floor page to the end: more of them than one window holds, then the list ends', async () => {
    // 450 open board postings, all between 200 and 219 days old (one window reads 400).
    for (let i = 0; i < 450; i++) {
      const at = new Date(daysAgo(200).getTime() - i * 3_600_000);
      repo.rows.push(cnRow(`o${String(i).padStart(3, '0')}`, { postedAt: at, firstSeenAt: at, sourceBoard: 'greenhouse', companyNameNormalized: `co${i}` }));
    }
    let page = await service().query(cn(), { sort: 'newest' });
    expect(page.items).toHaveLength(20);
    expect(page.items[0]!.jobId).toBe('o000');
    const seen = new Set(page.items.map((i) => i.jobId));
    let pages = 1;
    while (page.cursor && pages < 40) {
      page = await service().query(cn(), { sort: 'newest', cursor: page.cursor });
      for (const item of page.items) seen.add(item.jobId);
      pages += 1;
    }
    expect(seen.size).toBe(450);
    expect(page).toMatchObject({ cursor: null, endOfFeed: true });
  });

  it('a recruiter-bank row is listed only while its bank has a posting page: feed, header, preview, sample, alerts, Explore', async () => {
    // Stored before the rule: the link is the bank site's "Page not found", a valid http URL.
    repo.rows.push(cnRow('b1'), cnRow('g1', { sourceBoard: 'gohire', sourceName: 'GoHire', fromRecruiterBank: true, applyUrl: 'https://www.gohire.top/jobs/x', companyNameNormalized: 'bank co' }));
    const findById = async () => ({ ...profile(), userId: 'u1', brand: 'goapply' as const });
    const deps = { search: { getActive: async () => profile(), get: async () => profile(), findById } as unknown as FeedServiceDeps['search'] };
    const held = service(deps);
    const listed = await held.query(cn(), { sort: 'newest' });
    expect(listed.items.map((i) => i.jobId)).toEqual(['b1']);
    expect(listed.sources).toEqual({ gohire: false, employerBoards: 1 });
    expect((await held.preview(cn(), { limit: 10, sort: 'newest' })).map((i) => i.jobId)).toEqual(['b1']);
    expect(await held.sampleForFilters(cn(), {}, { limit: 400 })).toEqual(['b1']);
    expect((await held.alertCandidates({ market: 'cn', now: NOW }, 'sp1', { since: daysAgo(30), limit: 100 })).ids).toEqual(['b1']);
    await held.countForFilters(cn(), {});
    await held.explore({ market: 'cn', now: NOW }, 'zh');
    await held.publicList({ market: 'cn', now: NOW }, { limit: 20 });
    // Every statement over the index holds both banks out (neither has a page here).
    const statements = repo.queries.filter((q) => /FROM "RAJob" j /.test(q.text));
    expect(statements.length).toBeGreaterThan(6);
    for (const q of statements) {
      expect(q.text).toContain('NOT (j."fromRecruiterBank" = true AND j."sourceBoard" = ANY(');
      expect(q.values).toContainEqual(['robohire', 'gohire']);
    }
    // The bank has a page: its rows are listed, and only the other bank is still held.
    vi.stubEnv('GOHIRE_PUBLIC_JOB_URL_TEMPLATE', BANK_PAGES_ENV.GOHIRE_PUBLIC_JOB_URL_TEMPLATE!);
    const open = await service(deps).query(cn(), { sort: 'newest' });
    expect(open.items.map((i) => i.jobId).sort()).toEqual(['b1', 'g1']);
    expect(open.sources).toEqual({ gohire: true, employerBoards: 1 });
    expect(repo.queries.at(-1)!.values).toContainEqual(['robohire']);
    // The service reads the setting from its own env when it is given one.
    expect((await service({ ...deps, env: {} }).query(cn(), { sort: 'newest' })).items.map((i) => i.jobId)).toEqual(['b1']);
    // RoboApply: the same rule for a RoboHire bank row.
    personalized = true;
    repo.rows.push(feedRow({ id: 'r1', sourceBoard: 'robohire', sourceName: 'RoboHire', fromRecruiterBank: true }), feedRow({ id: 'a1' }));
    expect((await service().query(ctx(), { sort: 'newest' })).items.map((i) => i.jobId)).toEqual(['a1']);
    vi.stubEnv('ROBOHIRE_PUBLIC_JOB_URL_TEMPLATE', BANK_PAGES_ENV.ROBOHIRE_PUBLIC_JOB_URL_TEMPLATE!);
    expect((await service().query(ctx(), { sort: 'newest' })).items.map((i) => i.jobId).sort()).toEqual(['a1', 'r1']);
    // With a page for every bank no statement carries the predicate.
    await service().query(ctx(), { sort: 'newest' });
    expect(repo.queries.at(-1)!.text).not.toContain('NOT (j."fromRecruiterBank" = true');
  });

  it('RoboApply statements are unchanged by the mainland rule', async () => {
    personalized = true;
    seed(2);
    repo.rows[0]!.applyUrl = '';
    const res = await service().query(ctx(), { sort: 'newest' });
    expect(res.items).toHaveLength(2);
    expect(repo.queries.every((q) => !q.text.includes('"applyUrl" ~*'))).toBe(true);
  });
});
