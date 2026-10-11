// @vitest-environment node
//
// WP-32 service tests over an in-memory repo (no database, no network, no model):
// sessions + cursor stability + older-window refill, refresh limit, ranking on the
// fits of match `getFits` (one call per window, never the scorer), fit-tier hiding
// counts with the low-confidence rule, company scatter, GoApply non-personalised
// order, hide/unhide with filter diffs, report thresholds, impressions, daily
// rating, Explore cache, NL query (aiAllowed), new-count, skills-check, counts.
//
// MKT-4F: hybrid retrieval (three legs fused by reciprocal rank, the three
// sources of the query text, the query-vector cache and timeout, every consent
// case, FEED_HYBRID=off, refills), the text to rank by, the same-role collapse,
// "wrong title" as a title-level negative, seen and skipped, and the one
// targeted ingest a thin saved search asks for. The legs are answered by the
// in-memory repo from `searchDocs` and `vectors`; the embeddings client and the
// stored vectors are counting fakes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { HttpError } from '../../platform/http.js';
import { logger } from '../../services/LoggerService.js';
import { toTsQuery } from '../retrieval/index.js';
import { DEFAULT_MATCH_PRIORS, DEFAULT_MATCH_TIERS, DEFAULT_MATCH_WEIGHTS, buildMatchUser } from '../match/index.js';
import { EMPTY_AFFINITY } from './affinity.js';
import type { FilterSet, SearchProfileWire } from '../search/index.js';
import { SearchProfileNotFoundError } from '../search/index.js';
import { ALSO_IN_MAX, createFeedQueryService, profileQueryText, uncheckedPhrases, type FeedEmbeddings, type FeedRetrieval, type FeedServiceDeps } from './FeedQueryService.js';
import type { PlannerPlan } from './filterDiff.js';
import { recommendedRank } from './ranking.js';
import { BANK_PAGES_ENV, FAKE_VECTOR_MODEL, FakeFeedRepo, fakeFeedMatch, feedRow, testVector, type FakeFeedMatch, type FakeFeedMatchOptions } from './testkit.js';
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

  it('relevance is part of the session identity; with no search document to match, the list is the one it is without the text', async () => {
    seed(70);
    const s = service();
    const plain = await s.query(ctx(), { sort: 'recommended' });
    const ranked = await s.query(ctx(), { sort: 'recommended', relevance: 'climate startups Rust' });
    // No row has a search document or a vector here, so the lexical and dense legs find nothing: the same list.
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
    // The preview accepts the field; with no search document to match it answers the list it answers without it.
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

  it('a job counts once per feed session, however often its card scrolls past; a new session counts again', async () => {
    seed(3);
    let clock = NOW;
    const s = service({ now: () => clock });
    const at = () => ctx({ now: clock });
    const shown = (id: string) => repo.impressionRows.get(`u1:${id}`)?.impressions ?? 0;
    const first = await s.query(at(), { sort: 'newest' });
    // Down, back up and down again in one sitting: three batches name j000, two name j001.
    clock = new Date(NOW.getTime() + 10_000);
    await s.impressions(at(), { sessionId: first.sessionId, positions: [{ jobId: 'j000', position: 0, ms: 900 }, { jobId: 'j001', position: 1, ms: 900 }] });
    clock = new Date(NOW.getTime() + 25_000);
    await s.impressions(at(), { sessionId: first.sessionId, positions: [{ jobId: 'j000', position: 0, ms: 400 }, { jobId: 'j002', position: 2, ms: 400 }] });
    clock = new Date(NOW.getTime() + 40_000);
    await s.impressions(at(), { sessionId: first.sessionId, positions: [{ jobId: 'j000', position: 0, ms: 400 }, { jobId: 'j001', position: 1, ms: 400 }] });
    expect([shown('j000'), shown('j001'), shown('j002')]).toEqual([1, 1, 1]);
    // The next visit (a new list) counts each job it shows once more.
    clock = new Date(NOW.getTime() + 3_600_000);
    const second = await s.query(at(), { sort: 'newest' });
    clock = new Date(NOW.getTime() + 3_610_000);
    await s.impressions(at(), { sessionId: second.sessionId, positions: [{ jobId: 'j000', position: 0, ms: 900 }] });
    await s.impressions(at(), { sessionId: second.sessionId, positions: [{ jobId: 'j000', position: 0, ms: 900 }] });
    expect([shown('j000'), shown('j001'), shown('j002')]).toEqual([2, 1, 1]);
    // A late batch of the first session adds nothing: the job was shown since that session began.
    await s.impressions(at(), { sessionId: first.sessionId, positions: [{ jobId: 'j000', position: 0, ms: 900 }, { jobId: 'j001', position: 1, ms: 900 }] });
    expect([shown('j000'), shown('j001')]).toEqual([2, 1]);
    // So five scroll passes are not "five visits": the seen-and-skipped rule needs three sessions.
    expect(repo.impressions).toHaveLength(6);
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
    // "great culture" is a topic the list can be ranked by; nothing else stayed unmatched.
    expect(res.rankedBy).toEqual(['great culture']);
    expect(res.explanation).toBe('Ranked by closeness to: great culture.');
  });

  it('returns rankedBy next to the diff: the topics of the request, never a pay phrase; the explanation says what is ranked by and what was not checked', async () => {
    repo.countResponder = () => 9;
    plannerImpl = async () => ({ queries: ['Backend Engineer'], unverifiedPreferences: ['climate startups', 'using Rust', 'salary above 150k'] });
    const res = await service().nlQuery(ctx(), { text: 'backend jobs at climate startups using Rust, salary above 150k' }, 'en');
    expect(res.rankedBy).toEqual(['climate startups', 'Rust']);
    expect(res.unmatched).toEqual(['climate startups', 'using Rust', 'salary above 150k']);
    // In the user's words; the phrases the ranking terms came from are not repeated as "not checked".
    expect(res.explanation).toBe('Ranked by closeness to: climate startups, Rust. Not checked as requirements: salary above 150k.');
    expect(res.explanation).not.toMatch(/verified|confirmed|match(es|ed)/i);
    expect(res.diff.patch).toMatchObject({ titles: ['Backend Engineer'] });
    // The planner's own terms win when it gives them.
    plannerImpl = async () => ({ queries: ['Backend Engineer'], unverifiedPreferences: ['salary above 150k'], relevanceTerms: ['climate tech', 'Rust'] }) as never;
    expect((await service().nlQuery(ctx(), { text: 'backend jobs' }, 'en')).rankedBy).toEqual(['climate tech', 'Rust']);
    // Nothing left over: an empty list, never undefined, and nothing to explain.
    plannerImpl = async () => ({ queries: ['Data Analyst'], unverifiedPreferences: [] });
    const none = await service().nlQuery(ctx(), { text: 'data analyst' }, 'en');
    expect(none.rankedBy).toEqual([]);
    expect(none.explanation).toBe('');
    // Only requirements were left over: nothing is ranked by, and they are named as not checked.
    plannerImpl = async () => ({ queries: ['Data Analyst'], unverifiedPreferences: ['a 4-day week', 'health insurance'] });
    const only = await service().nlQuery(ctx(), { text: 'data analyst, a 4-day week, health insurance' }, 'en');
    expect(only.rankedBy).toEqual([]);
    expect(only.explanation).toBe(`Not checked as requirements: ${only.unmatched.join('; ')}.`);
  });

  it('uncheckedPhrases: what stayed unmatched and is not a ranking term', () => {
    expect(uncheckedPhrases(['climate startups', 'Rust'], ['climate startups', 'using Rust', 'salary above 150k'])).toEqual(['salary above 150k']);
    expect(uncheckedPhrases([], ['salary above 150k'])).toEqual(['salary above 150k']);
    expect(uncheckedPhrases(['climate tech'], [])).toEqual([]);
    // Case, width and spacing do not make a phrase new.
    expect(uncheckedPhrases(['Ｒust'], ['using  RUST'])).toEqual([]);
  });

  it('GoApply: the same planner path with the AI consent; refused without it', async () => {
    plannerImpl = async () => ({ queries: ['后端开发工程师'], unverifiedPreferences: ['新能源 创业公司', '使用 Rust'] });
    const res = await service().nlQuery(ctx({ market: 'cn', brandId: 'goapply' }), { text: '新能源创业公司的后端岗位，使用 Rust' }, 'zh');
    expect(res.rankedBy.length).toBeGreaterThan(0);
    expect(res.explanation.startsWith('Ranked by closeness to: ')).toBe(true);
    aiOk = false;
    await expectHttp(service().nlQuery(ctx({ market: 'cn', brandId: 'goapply' }), { text: '后端' }, 'zh'), 'ai_unavailable', 'ai_off');
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

// ── Hybrid retrieval (MKT-4F; MARKET_STRATEGY 2.1 point 3, 2.5 "Consent") ──────────────────────────

/** A counting embeddings client: `answer(text)` is the vector, or 'unavailable', or an error to throw. */
function embedFake(answer: (text: string) => number[] | 'unavailable' | Error | Promise<number[]> = () => testVector(1, 0)) {
  const calls: Array<{ brand: string; text: string; options: { purpose: string; carriesUserData: boolean; userId?: string | null } }> = [];
  const client: FeedEmbeddings = {
    async embedTexts(brand, texts, options) {
      calls.push({ brand, text: texts[0]!, options });
      const out = await answer(texts[0]!);
      if (out === 'unavailable') return { unavailable: 'no_key' };
      if (out instanceof Error) throw out;
      return { vectors: [out], model: FAKE_VECTOR_MODEL };
    },
  };
  return Object.assign(client, { calls });
}

/** Counting stored vectors: `vectors[userId]` is the person's own vector. */
function retrievalFake(vectors: Record<string, number[]> = {}, tag: string | null = FAKE_VECTOR_MODEL) {
  const reads: Array<{ userId: string; market: string; modelTag: string }> = [];
  const retrieval: FeedRetrieval = {
    currentModelTag: async () => tag,
    userVector: async (userId, market, modelTag) => {
      reads.push({ userId, market, modelTag });
      return vectors[userId] ?? null;
    },
    queryModelTag: () => tag,
  };
  return Object.assign(retrieval, { reads });
}

const POSTED = new Date(NOW.getTime() - 2 * 86_400_000);
/** A row like every other of its test: same date, same fit, its own company. Only the legs can tell such rows apart. */
function twin(id: string, over: Partial<Parameters<typeof feedRow>[0]> = {}) {
  const row = feedRow({ id, postedAt: POSTED, firstSeenAt: POSTED, ...over });
  repo.rows.push(row);
  return row;
}

const legStatements = (leg: 'recency' | 'lexical' | 'dense') => repo.queries.filter((q) => FakeFeedRepo.legOf(q) === leg);
/** The kinds of list statement run so far, each once (a recency statement is also what widens a window and what refills a session). */
const legsUsed = () => [...new Set(repo.legsRun())].sort();
/** The lexical query a leg-B statement carries (the parameter of its ORDER BY). */
const lexicalQueryOf = (q: { text: string; values: unknown[] }) => q.values[Number(q.text.match(/ORDER BY ts_rank_cd\(j\."searchTsv", to_tsquery\('simple', \$(\d+)\)\)/)![1]) - 1] as string;
const limitOf = (q: { values: unknown[] }) => q.values[q.values.length - 1];
const cnCtx = () => ctx({ market: 'cn', brandId: 'goapply' });
const mocked = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

describe('hybrid retrieval: three legs fused by reciprocal rank', () => {
  beforeEach(() => {
    for (const fn of [logger.info, logger.warn, logger.error]) mocked(fn).mockClear();
  });

  it('Recommended runs the recency, lexical and dense legs together, 200 rows each, and lists the union in the fused order when everything else ties', async () => {
    for (const id of ['r1', 'r2', 'r3', 'r4', 'r5', 'r6']) twin(id);
    // Lexical: r1 names the words three times, r2 once. Dense: r2 is the query's direction, r3 near it.
    repo.searchDocs.set('r1', 'climate rust rust');
    repo.searchDocs.set('r2', 'rust services');
    repo.vectors.set('r2', testVector(1, 0));
    repo.vectors.set('r3', testVector(1, 1));
    const embeddings = embedFake(() => testVector(1, 0));
    const res = await service({ embeddings, retrieval: retrievalFake() }).query(ctx(), { sort: 'recommended', relevance: 'climate rust' });
    expect(legsUsed()).toEqual(['dense', 'lexical', 'recency']);
    for (const leg of ['recency', 'lexical', 'dense'] as const) expect(limitOf(legStatements(leg)[0]!)).toBe(200);
    // A (same date, id descending): r6 r5 r4 r3 r2 r1. B: r1 r2. C: r2 r3.
    // r2 is in all three legs, r3 and r1 in two, the rest in one: 1/65+1/62+1/61 > 1/64+1/62 > 1/66+1/61 > 1/61 > 1/62 > 1/63.
    expect(res.items.map((i) => i.jobId)).toEqual(['r2', 'r3', 'r1', 'r6', 'r5', 'r4']);
    expect(res.order).toBe('personalized');
    // Ranking itself is unchanged: every row carries its fit, and the rank is the Recommended rank.
    expect(res.items.every((i) => i.fit?.kind === 'pre')).toBe(true);
    const ranks = repo.sessions.get(res.sessionId)!.ranks as Array<{ jobId: string; rank: number }>;
    expect(new Set(ranks.map((r) => r.rank)).size).toBe(1);
    expect(repo.sessions.get(res.sessionId)!.jobIds).toEqual(['r2', 'r3', 'r1', 'r6', 'r5', 'r4']);
    // The same filters without the text: no leg tells the rows apart, so it is today's order.
    repo.queries.length = 0;
    const plain = await service({ embeddings: embedFake(), retrieval: retrievalFake() }).query(ctx(), { sort: 'recommended' });
    expect(plain.items.map((i) => i.jobId)).toEqual(['r6', 'r5', 'r4', 'r3', 'r2', 'r1']);
  });

  it('the fused position only breaks ties: a better fit or a newer posting still comes first', async () => {
    twin('match', { skills: ['cobol'] });
    twin('fit');
    repo.searchDocs.set('match', 'climate rust');
    const res = await service().query(ctx(), { sort: 'recommended', relevance: 'climate rust' });
    // `fit` asks for the person's own skills; `match` only matches the text.
    expect(res.items.map((i) => i.jobId)).toEqual(['fit', 'match']);
    expect(res.items[0]!.fit!.score).toBeGreaterThan(res.items[1]!.fit!.score);
  });

  it('caps the union at 400, keeps what several legs agree on, and loses no row: later windows read on from leg A', async () => {
    seed(250, { prefix: 'n' }); // the newest: leg A takes 200 of them
    for (let i = 0; i < 200; i++) {
      const l = feedRow({ id: `l${String(i).padStart(3, '0')}`, postedAt: new Date(daysAgo(30).getTime() - i * 3_600_000), companyNameNormalized: `lco-${i}`, companyName: `LCo ${i}` });
      const d = feedRow({ id: `d${String(i).padStart(3, '0')}`, postedAt: new Date(daysAgo(60).getTime() - i * 3_600_000), companyNameNormalized: `dco-${i}`, companyName: `DCo ${i}` });
      repo.rows.push(l, d);
      repo.searchDocs.set(l.id, 'kafka streaming');
      repo.vectors.set(d.id, testVector(1, i / 1000));
    }
    const s = service({ embeddings: embedFake(() => testVector(1, 0)), retrieval: retrievalFake() });
    let res = await s.query(ctx(), { sort: 'recommended', relevance: 'kafka' });
    const session = () => repo.sessions.get(res.sessionId)!;
    // 200 + 200 + 200 disjoint rows: the union is cut at 400.
    expect(session().jobIds).toHaveLength(400);
    expect(session().totalEstimate).toBe(400);
    const first = new Set(session().jobIds);
    for (const p of ['n', 'l', 'd']) expect([...first].filter((id) => id.startsWith(p)).length, p).toBeGreaterThan(120);
    // The best of each leg is in; the last of each leg is what the cut dropped.
    for (const id of ['n000', 'l000', 'd000']) expect(first.has(id), id).toBe(true);
    for (const id of ['n199', 'l199', 'd199']) expect(first.has(id), id).toBe(false);
    // Page to the end: every row inside the age floor is listed exactly once.
    const seen = res.items.map((i) => i.jobId);
    for (let guard = 0; res.cursor && guard < 60; guard++) {
      res = await s.query(ctx(), { sort: 'recommended', relevance: 'kafka', cursor: res.cursor });
      seen.push(...res.items.map((i) => i.jobId));
    }
    expect(res.endOfFeed).toBe(true);
    expect(seen).toHaveLength(650);
    expect(new Set(seen).size).toBe(650);
    // The refill is recency-keyed: the statements after the first window are plain windows, never a leg B or C.
    expect(legStatements('lexical')).toHaveLength(1);
    expect(legStatements('dense')).toHaveLength(1);
  });

  it('refills skip jobs the lexical leg already brought in from an older window', async () => {
    seed(25, { prefix: 'r' });
    seed(30, { prefix: 'o', startDaysAgo: 50 });
    for (const id of ['o003', 'o007']) repo.searchDocs.set(id, 'kafka');
    const s = service();
    const p1 = await s.query(ctx(), { sort: 'recommended', relevance: 'kafka' });
    // The two old matches are in the first window, among 25 recent rows.
    const firstWindow = repo.sessions.get(p1.sessionId)!.jobIds;
    expect(firstWindow).toHaveLength(27);
    expect(firstWindow.filter((id) => id === 'o003' || id === 'o007')).toHaveLength(2);
    // Paging on reads the older window by date; it does not list the two a second time.
    const seen = p1.items.map((i) => i.jobId);
    let res = p1;
    for (let guard = 0; res.cursor && guard < 10; guard++) {
      res = await s.query(ctx(), { sort: 'recommended', relevance: 'kafka', cursor: res.cursor });
      seen.push(...res.items.map((i) => i.jobId));
    }
    expect(seen).toHaveLength(55);
    expect(new Set(seen).size).toBe(55);
    expect(seen.filter((id) => id === 'o003' || id === 'o007')).toHaveLength(2);
  });

  it('"Hiding N weaker fits" counts a row once: a later window does not judge again what the first window\'s view hid', async () => {
    profileFilters = { taxonomyIds: ['backend_engineer'], fitTier: 'great' };
    const build = (withDocs: boolean) => {
      repo = new FakeFeedRepo();
      for (let i = 0; i < 5; i++) {
        repo.rows.push(feedRow({ id: `great${i}`, postedAt: new Date(NOW.getTime() - (i + 1) * 3_600_000), companyName: `G ${i}`, companyNameNormalized: `g-${i}` }));
        repo.ai.set(`great${i}`, { score: 90, tier: 'great' });
      }
      // Ten postings 50 days old (below the recency leg's 45-day window) that score Unlikely.
      for (let i = 0; i < 10; i++) {
        repo.rows.push(feedRow({ id: `weak${i}`, postedAt: new Date(daysAgo(50).getTime() - i * 3_600_000), companyName: `W ${i}`, companyNameNormalized: `w-${i}` }));
        repo.ai.set(`weak${i}`, { score: 30, tier: 'unlikely' });
        // With a search document they match the lexical leg (the person's titles and skills): the first window holds them.
        if (withDocs) repo.searchDocs.set(`weak${i}`, 'backend engineer python sql');
      }
    };
    build(false);
    const plain = await service().query(ctx(), { sort: 'recommended' });
    expect(plain.items).toHaveLength(5);
    expect(plain.hiddenByTier).toBe(10);

    build(true);
    const res = await service().query(ctx(), { sort: 'recommended' });
    expect(repo.legsRun()).toContain('lexical');
    expect(res.items.map((i) => i.jobId).sort()).toEqual(['great0', 'great1', 'great2', 'great3', 'great4']);
    // The first page needs 21 cards and has 5, so it reads the next older window: the ten rows the lexical leg
    // already brought in, and the view already hid. They are counted once.
    expect(res.hiddenByTier).toBe(10);
    const session = repo.sessions.get(res.sessionId)!;
    expect(session.totalEstimate).toBe(15);
    expect(session.jobIds).toHaveLength(5);
    // They are remembered on the session as entries that are not cards, and are never served.
    const hidden = (session.ranks as Array<{ jobId: string; h?: true }>).filter((r) => r.h);
    expect(hidden.map((r) => r.jobId).sort()).toEqual(Array.from({ length: 10 }, (_, i) => `weak${i}`));
    expect(hidden.every((r) => !session.jobIds.includes(r.jobId))).toBe(true);
    expect(res.endOfFeed).toBe(true);
    // Paging the same session again changes nothing.
    const again = await service().query(ctx(), { sort: 'recommended' });
    expect(again.hiddenByTier).toBe(10);
    // A row the view hid ABOVE the refill boundary is never read again, so it is not stored.
    build(true);
    repo.rows.push(feedRow({ id: 'weak-recent', postedAt: new Date(NOW.getTime() - 7_200_000), companyName: 'WR', companyNameNormalized: 'wr' }));
    repo.ai.set('weak-recent', { score: 30, tier: 'unlikely' });
    const mixed = await service().query(ctx(), { sort: 'recommended' });
    expect(mixed.hiddenByTier).toBe(11);
    const stored = (repo.sessions.get(mixed.sessionId)!.ranks as Array<{ jobId: string; h?: true }>).filter((r) => r.h).map((r) => r.jobId);
    expect(stored).not.toContain('weak-recent');
    expect(stored).toHaveLength(10);
  });

  it('the query text of the legs: what the user wrote (the typed q and the text to rank by, together), else the person\'s recent titles and top skills with their own vector', async () => {
    seed(5);
    const embeddings = embedFake();
    const retrieval = retrievalFake({ u1: testVector(0, 1) });
    const s = service({ embeddings, retrieval });

    // 1. A typed q and a text to rank by are one query text, for both legs. Only q filters: the predicate binds
    //    the q's own word, the leg's order the words of both.
    await s.query(ctx(), { sort: 'recommended', q: 'engineer', relevance: 'climate rust' });
    const both = legStatements('lexical')[0]!;
    expect(lexicalQueryOf(both)).toBe("'engineer' | 'climate' | 'rust'");
    expect(lexicalQueryOf(both)).toBe(toTsQuery('engineer climate rust'));
    expect(both.values.filter((v) => v === "'engineer'")).toHaveLength(1);
    expect(legStatements('recency')[0]!.values).toContain("'engineer'");
    expect(legStatements('recency')[0]!.values.some((v) => typeof v === 'string' && /climate|rust/.test(v))).toBe(false);
    expect(embeddings.calls.map((c) => c.text)).toEqual(['engineer climate rust']);
    expect(embeddings.calls[0]).toMatchObject({ brand: 'roboapply', options: { purpose: 'query', carriesUserData: true, userId: 'u1' } });
    expect(retrieval.reads).toEqual([]);

    // 1b. A typed q alone.
    repo.queries.length = 0;
    await s.query(ctx(), { sort: 'recommended', q: 'engineer' });
    expect(lexicalQueryOf(legStatements('lexical')[0]!)).toBe(toTsQuery('engineer'));
    expect(embeddings.calls.map((c) => c.text)).toEqual(['engineer climate rust', 'engineer']);

    // 2. No q: the text to rank by.
    repo.queries.length = 0;
    await s.query(ctx(), { sort: 'recommended', relevance: 'climate rust' });
    expect(lexicalQueryOf(legStatements('lexical')[0]!)).toBe("'climate' | 'rust'");
    expect(embeddings.calls.map((c) => c.text)).toEqual(['engineer climate rust', 'engineer', 'climate rust']);
    expect(retrieval.reads).toEqual([]);

    // 3. Neither: the profile. No embedding call; the stored vector of the market's query tag is read.
    repo.queries.length = 0;
    await s.query(ctx(), { sort: 'recommended' });
    const profileQuery = lexicalQueryOf(legStatements('lexical')[0]!);
    expect(profileQuery).toBe(toTsQuery(profileQueryText(person('u1').user, 'intl')));
    for (const token of ["'backend'", "'engineer'", "'python'", "'sql'"]) expect(profileQuery).toContain(token);
    expect(embeddings.calls).toHaveLength(3);
    expect(retrieval.reads).toEqual([{ userId: 'u1', market: 'intl', modelTag: FAKE_VECTOR_MODEL }]);
    expect(legStatements('dense')).toHaveLength(1);
    expect(legStatements('dense')[0]!.values).toContain(FAKE_VECTOR_MODEL);
  });

  it('the profile query: the recent title and role names first, then at most eight skills; nothing for a person with neither', () => {
    const text = profileQueryText({ recentTitle: 'Backend Engineer', evidenceRoleIds: ['backend_engineer', 'data_engineer', 'ignored_third'], skills: ['Go', 'Rust', 'SQL', 'Kafka', 'gRPC', 'AWS', 'Docker', 'Redis', 'Ninth'] }, 'intl')!;
    expect(text.startsWith('Backend Engineer')).toBe(true);
    expect(text.toLowerCase()).toContain('data engineer');
    expect(text).toContain('Redis');
    expect(text).not.toContain('Ninth');
    expect(toTsQuery(text)!.split(' | ').length).toBeLessThanOrEqual(24);
    // GoApply reads the Chinese role name first.
    expect(profileQueryText({ recentTitle: null, evidenceRoleIds: ['backend_engineer'], skills: [] }, 'cn')).toMatch(/[一-鿿]/);
    expect(profileQueryText({ recentTitle: null, evidenceRoleIds: [], skills: [] }, 'intl')).toBeNull();
    expect(profileQueryText(null, 'intl')).toBeNull();
  });

  it('one embedding call per query text in ten minutes; the model tag is the vector\'s own', async () => {
    seed(5);
    repo.vectors.set('j000', testVector(1, 0));
    let clock = NOW;
    const embeddings = embedFake();
    const s = service({ embeddings, retrieval: retrievalFake(), now: () => clock });
    await s.query(ctx(), { sort: 'recommended', relevance: 'climate rust' });
    await s.query(ctx(), { sort: 'best_fit', relevance: 'climate rust' });
    await s.preview(ctx(), { limit: 5, relevance: 'climate rust' });
    expect(embeddings.calls).toHaveLength(1);
    expect(legStatements('dense')).toHaveLength(3);
    for (const q of legStatements('dense')) expect(q.values[0]).toBe(FAKE_VECTOR_MODEL);
    await s.query(ctx(), { sort: 'recommended', relevance: 'fintech go' });
    expect(embeddings.calls).toHaveLength(2);
    clock = new Date(NOW.getTime() + 11 * 60_000);
    await s.query(ctx({ now: clock }), { sort: 'recommended', relevance: 'climate rust' });
    expect(embeddings.calls).toHaveLength(3);
  });

  it('a slow embedding call is not waited for past FEED_QUERY_EMBED_TIMEOUT_MS: the list runs without the dense leg, and the vector is there for the next request', async () => {
    seed(5);
    repo.vectors.set('j000', testVector(1, 0));
    const embeddings = embedFake(() => new Promise((resolve) => setTimeout(() => resolve(testVector(1, 0)), 60)));
    const s = service({ embeddings, retrieval: retrievalFake(), env: { FEED_QUERY_EMBED_TIMEOUT_MS: '10' } });
    const res = await s.query(ctx(), { sort: 'recommended', relevance: 'climate rust' });
    expect(res.items).toHaveLength(5);
    expect(legsUsed()).toEqual(['lexical', 'recency']);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 90));
    repo.queries.length = 0;
    await s.query(ctx(), { sort: 'recommended', relevance: 'climate rust' });
    expect(legsUsed()).toEqual(['dense', 'lexical', 'recency']);
    expect(embeddings.calls).toHaveLength(1);
  });

  it('with the embeddings client unavailable the list is the fusion of legs A and B, and nothing is logged above info', async () => {
    for (const id of ['r1', 'r2', 'r3', 'r4']) twin(id);
    repo.searchDocs.set('r1', 'climate rust');
    repo.vectors.set('r4', testVector(1, 0));
    const input = { sort: 'recommended' as const, relevance: 'climate rust' };
    const twoLegs = (await service().query(ctx(), input)).items.map((i) => i.jobId);
    expect(twoLegs).toEqual(['r1', 'r4', 'r3', 'r2']);
    const failed = Object.assign(new Error('The embeddings endpoint answered 503.'), { name: 'EmbeddingsError', code: 'http' });
    for (const answer of [() => 'unavailable' as const, () => failed]) {
      repo.queries.length = 0;
      const embeddings = embedFake(answer);
      const s = service({ embeddings, retrieval: retrievalFake() });
      expect((await s.query(ctx(), input)).items.map((i) => i.jobId)).toEqual(twoLegs);
      expect(embeddings.calls).toHaveLength(1);
      expect(legsUsed()).toEqual(['lexical', 'recency']);
      // "No vector now" is not remembered: the next request asks again.
      await s.query(ctx(), input);
      expect(embeddings.calls).toHaveLength(2);
    }
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
    // No embedding key for the brand: nothing is asked at all.
    const unasked = embedFake();
    await service({ embeddings: unasked, retrieval: retrievalFake({}, null) }).query(ctx(), input);
    expect(unasked.calls).toHaveLength(0);
    // A vector of zeros is no embedding: never used as a query.
    repo.queries.length = 0;
    await service({ embeddings: embedFake(() => testVector()), retrieval: retrievalFake() }).query(ctx(), input);
    expect(repo.legsRun()).not.toContain('dense');
  });

  it('a leg whose statement fails is left out; the list is built from the others', async () => {
    for (const id of ['r1', 'r2', 'r3']) twin(id);
    repo.searchDocs.set('r1', 'climate rust');
    repo.vectors.set('r2', testVector(1, 0));
    const deps = () => ({ embeddings: embedFake(), retrieval: retrievalFake() });
    repo.failLeg = 'lexical';
    expect((await service(deps()).query(ctx(), { sort: 'recommended', relevance: 'climate rust' })).items.map((i) => i.jobId)).toEqual(['r2', 'r3', 'r1']);
    repo.failLeg = 'dense';
    expect((await service(deps()).query(ctx(), { sort: 'recommended', relevance: 'climate rust' })).items.map((i) => i.jobId)).toEqual(['r1', 'r3', 'r2']);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    // Without the recency leg there is no list to answer with.
    repo.failLeg = 'recency';
    await expect(service(deps()).query(ctx(), { sort: 'recommended', relevance: 'climate rust' })).rejects.toThrow('recency leg unavailable');
  });

  it('the stored user vector is of the market\'s query tag; a market with no tag, or a person with no vector, runs without the dense leg', async () => {
    seed(5);
    repo.vectors.set('j000', testVector(0, 1));
    await service({ embeddings: embedFake(), retrieval: retrievalFake({ u1: testVector(0, 1) }) }).query(ctx(), { sort: 'recommended' });
    expect(repo.legsRun()).toContain('dense');
    for (const retrieval of [retrievalFake({}), retrievalFake({ u1: testVector(0, 1) }, null)]) {
      repo.queries.length = 0;
      const res = await service({ embeddings: embedFake(), retrieval }).query(ctx(), { sort: 'recommended' });
      expect(res.items).toHaveLength(5);
      expect(legsUsed()).toEqual(['lexical', 'recency']);
    }
  });

  it('FEED_HYBRID=off: the recency leg alone, 400 rows, as before; no vector is asked for or read', async () => {
    for (let i = 0; i < 450; i++) {
      const id = `m${String(i).padStart(3, '0')}`;
      repo.rows.push(feedRow({ id, postedAt: new Date(NOW.getTime() - (i + 1) * 60_000), companyName: `Co ${id}`, companyNameNormalized: `co-${id}` }));
    }
    const embeddings = embedFake();
    const retrieval = retrievalFake({ u1: testVector(0, 1) });
    const off = await service({ embeddings, retrieval, env: { FEED_HYBRID: 'off' } }).query(ctx(), { sort: 'recommended', relevance: 'climate rust' });
    expect(legsUsed()).toEqual(['recency']);
    expect(limitOf(legStatements('recency')[0]!)).toBe(400);
    expect(repo.sessions.get(off.sessionId)!.jobIds).toHaveLength(400);
    expect(embeddings.calls).toHaveLength(0);
    expect(retrieval.reads).toHaveLength(0);
    // On (the default, and any other value): leg A is 200 rows of the three.
    for (const env of [{}, { FEED_HYBRID: 'on' }, { FEED_HYBRID: ' OFF ' }]) {
      repo.queries.length = 0;
      const res = await service({ env }).query(ctx(), { sort: 'recommended' });
      const hybrid = (env as { FEED_HYBRID?: string }).FEED_HYBRID?.trim().toLowerCase() !== 'off';
      expect(limitOf(legStatements('recency')[0]!)).toBe(hybrid ? 200 : 400);
      expect(repo.sessions.get(res.sessionId)!.jobIds).toHaveLength(hybrid ? 200 : 400);
    }
  });

  it('Newest, Highest pay, a browse and GoApply\'s deadline keep their single statement, with or without a query text', async () => {
    seed(30);
    repo.rows.push(...Array.from({ length: 5 }, (_, i) => feedRow({ id: `c${i}`, market: 'cn', postedAt: POSTED })));
    const embeddings = embedFake();
    const retrieval = retrievalFake({ u1: testVector(0, 1) });
    const s = service({ embeddings, retrieval });
    const legsOf = async (run: () => Promise<unknown>) => {
      repo.queries.length = 0;
      await run();
      return legsUsed();
    };
    expect(await legsOf(() => s.query(ctx(), { sort: 'newest' }))).toEqual(['recency']);
    expect(await legsOf(() => s.query(ctx(), { sort: 'newest', relevance: 'kafka' }))).toEqual(['recency']);
    expect(await legsOf(() => s.query(ctx(), { sort: 'newest', q: 'backend' }))).toEqual(['recency']);
    expect(await legsOf(() => s.query(ctx(), { sort: 'highest_pay', relevance: 'kafka' }))).toEqual(['recency']);
    expect(await legsOf(() => s.query(ctx(), { sort: 'recommended', overrides: { taxonomyIds: ['software_engineering'] } }))).toEqual(['recency']);
    expect(await legsOf(() => s.query(cnCtx(), { sort: 'deadline', relevance: 'kafka' }))).toEqual([]);
    // None of them asks for a vector or reads one, and each is the old 400-row window.
    expect(embeddings.calls).toHaveLength(0);
    expect(retrieval.reads).toHaveLength(0);
    repo.queries.length = 0;
    await s.query(ctx(), { sort: 'newest', q: 'backend', relevance: 'kafka' });
    expect(limitOf(legStatements('recency')[0]!)).toBe(400);
    // Recommended and Best fit are the lists that run the legs.
    expect(await legsOf(() => s.query(ctx(), { sort: 'best_fit' }))).toEqual(['dense', 'lexical', 'recency']);
    expect(await legsOf(() => s.query(ctx(), { sort: 'recommended', q: 'backend' }))).toEqual(['dense', 'lexical', 'recency']);
  });

  it('a list asked for by date is in date order from its first row to its last, also with a query text', async () => {
    seed(25, { prefix: 'r' });
    seed(30, { prefix: 'o', startDaysAgo: 50 });
    // Two old postings match the words, and one old posting is the nearest in meaning: under Recommended the
    // lexical and dense legs bring them into the first window. Under Newest they wait for their place by date.
    for (const id of ['o003', 'o007']) repo.searchDocs.set(id, 'kafka');
    repo.vectors.set('o011', testVector(1, 0));
    const s = service({ embeddings: embedFake(() => testVector(1, 0)), retrieval: retrievalFake() });
    const pagesOf = async (input: { sort: 'newest'; relevance?: string; q?: string }) => {
      let res = await s.query(ctx(), input);
      const out = [...res.items];
      for (let guard = 0; res.cursor && guard < 10; guard++) {
        res = await s.query(ctx(), { ...input, cursor: res.cursor });
        out.push(...res.items);
      }
      return out;
    };
    const ranked = await pagesOf({ sort: 'newest', relevance: 'kafka' });
    expect(ranked).toHaveLength(55);
    const dates = ranked.map((i) => Date.parse(i.postedAt!));
    // postedAt never increases along the pages.
    for (let i = 1; i < dates.length; i++) expect(dates[i]!, `${ranked[i - 1]!.jobId} then ${ranked[i]!.jobId}`).toBeLessThanOrEqual(dates[i - 1]!);
    expect(ranked.map((i) => i.jobId)).toEqual((await pagesOf({ sort: 'newest' })).map((i) => i.jobId));
    // With a typed q the list holds the postings that carry the word and nothing else, newest first.
    repo.searchDocs.set('r004', 'backend engineer kafka');
    const typed = await pagesOf({ sort: 'newest', q: 'kafka' });
    expect(typed.map((i) => i.jobId)).toEqual(['r004', 'o003', 'o007']);
  });

  it('counts, limiting filters, samples and alert candidates keep their single statement', async () => {
    seed(5);
    repo.countFromRows = true;
    const s = service({ embeddings: embedFake(), retrieval: retrievalFake({ u1: testVector(0, 1) }), search: { getActive: async () => profile(), get: async () => profile(), findById: async () => ({ ...profile(), userId: 'u1' }) } as never });
    await s.countForFilters(ctx(), { q: 'backend' });
    await s.sampleForFilters(ctx(), { q: 'backend' }, { limit: 10 });
    await s.alertCandidates({ market: 'intl', now: NOW }, 'sp1', { since: daysAgo(30), limit: 10 });
    expect(repo.legsRun().filter((l) => l !== 'recency')).toEqual([]);
    expect(repo.queries.some((q) => /ts_rank_cd|RAJobEmbedding/.test(q.text))).toBe(false);
  });

  it('the Assistant\'s preview and the precompute pick read the same fused first window', async () => {
    for (const id of ['r1', 'r2', 'r3', 'r4']) twin(id);
    repo.searchDocs.set('r1', 'climate rust');
    const embeddings = embedFake();
    const items = await service({ embeddings, retrieval: retrievalFake() }).preview(ctx(), { limit: 3, relevance: 'climate rust' });
    expect(legsUsed()).toEqual(['dense', 'lexical', 'recency']);
    expect(items.map((i) => i.jobId)).toEqual(['r1', 'r4', 'r3']);
    expect(repo.sessions.size).toBe(0);
    // No text: the profile legs, the same top as the list's own.
    const listed = (await service().query(ctx(), { sort: 'recommended' })).items.slice(0, 3).map((i) => i.jobId);
    expect((await service().preview(ctx(), { limit: 3 })).map((i) => i.jobId)).toEqual(listed);
  });
});

describe('hybrid retrieval: the typed query finds a word that is only in the description', () => {
  beforeEach(() => {
    repo.rows.push(
      feedRow({ id: 'title', title: 'Terraform Engineer', titleNormalized: 'terraform engineer' }),
      feedRow({ id: 'body', title: 'Platform Engineer', titleNormalized: 'platform engineer' }),
      feedRow({ id: 'unindexed', title: 'Terraform Specialist', titleNormalized: 'terraform specialist' }),
      feedRow({ id: 'other', title: 'Data Analyst', titleNormalized: 'data analyst' }),
    );
    // `body` names Terraform in its description only; `unindexed` has no search document yet.
    repo.searchDocs.set('title', 'terraform engineer infrastructure');
    repo.searchDocs.set('body', 'platform engineer you will manage our cloud with terraform and kubernetes');
    repo.searchDocs.set('other', 'data analyst sql dashboards');
    repo.countFromRows = true;
  });

  it('the list returns the description-only job once it has a search document, and still finds an unindexed row by its title', async () => {
    const res = await service().query(ctx(), { sort: 'recommended', q: 'terraform' });
    expect(res.items.map((i) => i.jobId).sort()).toEqual(['body', 'title', 'unindexed']);
    // Before its search document exists, the description-only job is not found (nothing is guessed).
    repo.searchDocs.delete('body');
    const before = await service().query(ctx(), { sort: 'recommended', q: 'terraform' });
    expect(before.items.map((i) => i.jobId).sort()).toEqual(['title', 'unindexed']);
  });

  it('the count, a sample and the alert candidates include the same description-only job', async () => {
    profileFilters = { q: 'terraform' };
    const s = service({ search: { getActive: async () => profile(), get: async () => profile(), findById: async () => ({ ...profile(), userId: 'u1' }) } as never });
    expect(await s.countForFilters(ctx(), { q: 'terraform' })).toEqual({ count: 3, capped: false });
    expect((await s.sampleForFilters(ctx(), { q: 'terraform' }, { limit: 10 })).sort()).toEqual(['body', 'title', 'unindexed']);
    const alert = await s.alertCandidates({ market: 'intl', now: NOW }, 'sp1', { since: daysAgo(30), limit: 10 });
    expect(alert.ids.sort()).toEqual(['body', 'title', 'unindexed']);
    expect((await s.counts(ctx())).forYou).toBe(3);
  });

  it('a typed query of two words keeps the postings that carry BOTH, on every surface that filters by it', async () => {
    repo.rows = [];
    repo.searchDocs.clear();
    const add = (id: string, title: string, doc: string | null, hoursAgo: number) => {
      repo.rows.push(feedRow({ id, title, titleNormalized: title.toLowerCase(), postedAt: new Date(NOW.getTime() - hoursAgo * 3_600_000), firstSeenAt: new Date(NOW.getTime() - hoursAgo * 3_600_000), skills: [] }));
      if (doc) repo.searchDocs.set(id, doc);
    };
    add('pm-title', 'Product Manager', 'product manager roadmap', 5);
    // Both words, apart and in the description only.
    add('pm-body', 'Growth Lead', 'growth lead you manage the product as its manager', 4);
    // One of the words each: newer than both matches, and far more of them.
    for (let i = 0; i < 30; i++) add(`product${i}`, 'Product Designer', 'product designer figma', 1 + i / 100);
    for (let i = 0; i < 30; i++) add(`manager${i}`, 'Engineering Manager', 'engineering manager people', 2 + i / 100);
    // No search document yet: found by the phrase in its title, as before.
    add('pm-unindexed', 'Senior Product Manager', null, 6);
    const both = ['pm-body', 'pm-title', 'pm-unindexed'];
    profileFilters = { q: 'product manager' };
    const s = service({ search: { getActive: async () => profile(), get: async () => profile(), findById: async () => ({ ...profile(), userId: 'u1' }) } as never });

    // The count ("Show N jobs", For you) and the lists agree.
    expect(await s.countForFilters(ctx(), { q: 'product manager' })).toEqual({ count: 3, capped: false });
    expect((await s.counts(ctx())).forYou).toBe(3);
    for (const sort of ['recommended', 'best_fit', 'newest', 'highest_pay'] as const) {
      const res = await s.query(ctx(), { sort });
      expect(res.items.map((i) => i.jobId).sort(), sort).toEqual(both);
      expect(res.endOfFeed, sort).toBe(true);
    }
    // Newest is by date among them, not the newest rows that say either word.
    expect((await s.query(ctx(), { sort: 'newest' })).items.map((i) => i.jobId)).toEqual(['pm-body', 'pm-title', 'pm-unindexed']);
    // Samples, alert candidates, the Assistant's preview and the visitor list.
    expect((await s.sampleForFilters(ctx(), { q: 'product manager' }, { limit: 50 })).sort()).toEqual(both);
    expect((await s.alertCandidates({ market: 'intl', now: NOW }, 'sp1', { since: daysAgo(30), limit: 50 })).ids.sort()).toEqual(both);
    expect((await s.preview(ctx(), { q: 'product manager', limit: 50 })).map((i) => i.jobId).sort()).toEqual(both);
    expect((await s.publicList({ market: 'intl', now: NOW }, { role: 'product manager', limit: 50 })).map((i) => i.jobId).sort()).toEqual(both);
    // One word is unchanged: every posting that carries it.
    expect((await s.countForFilters(ctx(), { q: 'product' })).count).toBe(33);
    // The lexical leg still ORDERS by any word of its text; the filter beside it holds every word.
    repo.queries.length = 0;
    await s.query(ctx(), { sort: 'recommended' });
    const lexical = legStatements('lexical')[0]!;
    expect(lexicalQueryOf(lexical)).toBe("'product' | 'manager'");
    expect(lexical.values).toContain("'product' & 'manager'");
    expect(legStatements('recency')[0]!.values).toContain("'product' & 'manager'");
  });

  it('with job vectors the list still holds what the count counts: the dense leg applies the typed q under Recommended and Best fit (M4 cross-review)', async () => {
    // Every posting has a vector, and the one that does NOT carry the word is the nearest to the query vector.
    repo.vectors.set('other', testVector(1, 0));
    repo.vectors.set('title', testVector(0.6, 0.8));
    repo.vectors.set('body', testVector(0, 1));
    repo.vectors.set('unindexed', testVector(0.1, 1));
    // More rows that do not carry the word, all with vectors nearer than the matches (the reported case in small).
    for (let i = 0; i < 12; i++) {
      repo.rows.push(feedRow({ id: `far${i}`, title: 'Data Analyst', titleNormalized: 'data analyst' }));
      repo.searchDocs.set(`far${i}`, 'data analyst sql dashboards');
      repo.vectors.set(`far${i}`, testVector(1, 0.01 * i));
    }
    const s = service({ embeddings: embedFake(() => testVector(1, 0)), retrieval: retrievalFake() });
    const matches = ['body', 'title', 'unindexed'];
    expect(await s.countForFilters(ctx(), { q: 'terraform' })).toEqual({ count: 3, capped: false });
    for (const sort of ['recommended', 'best_fit'] as const) {
      repo.queries.length = 0;
      const res = await s.query(ctx(), { sort, q: 'terraform' });
      expect(res.items.map((i) => i.jobId).sort(), sort).toEqual(matches);
      expect(res.endOfFeed, sort).toBe(true);
      // The dense leg ran, and it carried the q rule like legs A and B.
      expect(legsUsed(), sort).toEqual(['dense', 'lexical', 'recency']);
      for (const leg of ['recency', 'lexical', 'dense'] as const) expect(legStatements(leg)[0]!.text, `${sort} ${leg}`).toContain('j."searchText" ILIKE');
    }
    // What the Assistant's search_jobs and the job-search API read: the same filtered window.
    expect((await s.preview(ctx(), { q: 'terraform', limit: 5 })).map((i) => i.jobId).sort()).toEqual(matches);
    // The dense leg still ORDERS among the matches: with no fit to tell them apart the nearest one leads.
    repo.queries.length = 0;
    await s.query(ctx(), { sort: 'recommended', q: 'terraform' });
    const dense = await repo.queryRows({ text: legStatements('dense')[0]!.text, values: legStatements('dense')[0]!.values } as never);
    expect(dense.map((r) => r.id)).toEqual(['title', 'unindexed', 'body']);
  });

  it('with no typed q the dense leg is unconstrained: the ranking words and the person\'s own vector may add a job that says it another way', async () => {
    repo.vectors.set('other', testVector(1, 0));
    const s = service({ embeddings: embedFake(() => testVector(1, 0)), retrieval: retrievalFake() });
    const res = await s.query(ctx(), { sort: 'recommended', relevance: 'terraform' });
    expect(res.items.map((i) => i.jobId)).toContain('other');
    expect(legStatements('dense')[0]!.text).not.toContain('searchText');
  });

  it('a typed query filters on every word, the ones an OR query drops included: "IT support", "social work", 招聘专员', async () => {
    repo.rows = [];
    repo.searchDocs.clear();
    const add = (id: string, title: string, doc: string) => {
      repo.rows.push(feedRow({ id, title, titleNormalized: title.toLowerCase(), skills: [] }));
      repo.searchDocs.set(id, doc);
    };
    add('it-support', 'IT Support Specialist', 'it support specialist helpdesk windows');
    add('help-desk', 'Help Desk Technician', 'help desk technician you give it support to 200 staff');
    add('csm', 'Customer Success Manager', 'customer success manager support renewals');
    add('backend', 'Backend Engineer', 'backend engineer on call support rotation');
    add('nurse', 'Registered Nurse', 'registered nurse support patients');
    add('social-worker', 'Social Worker', 'licensed social worker case work social work');
    add('social-media', 'Social Media Manager', 'social media manager campaigns');
    add('recruiter-cn', '招聘专员', '招聘 专员 人力 资源');
    add('admin-cn', '行政专员', '行政 专员 前台');
    const s = service({ embeddings: embedFake(() => testVector(1, 0)), retrieval: retrievalFake(), search: { getActive: async () => profile(), get: async () => profile(), findById: async () => ({ ...profile(), userId: 'u1' }) } as never });
    const cases: Array<[string, string[]]> = [
      // Before: the filter was 'support' alone and listed the Customer Success Manager, the Backend Engineer and the nurse.
      ['IT support', ['help-desk', 'it-support']],
      // Before: 'social' alone kept the Social Media Manager.
      ['social work', ['social-worker']],
      // Before: '专员' alone kept the 行政专员.
      ['招聘专员', ['recruiter-cn']],
      ['招聘 专员', ['recruiter-cn']],
    ];
    for (const [q, expected] of cases) {
      expect((await s.countForFilters(ctx(), { q })).count, q).toBe(expected.length);
      for (const sort of ['recommended', 'best_fit', 'newest'] as const) {
        expect((await s.query(ctx(), { sort, q })).items.map((i) => i.jobId).sort(), `${q} ${sort}`).toEqual(expected);
      }
      expect((await s.sampleForFilters(ctx(), { q }, { limit: 50 })).sort(), q).toEqual(expected);
      profileFilters = { q };
      expect((await s.alertCandidates({ market: 'intl', now: NOW }, 'sp1', { since: daysAgo(30), limit: 50 })).ids.sort(), q).toEqual(expected);
    }
  });
});

describe('hybrid retrieval: GoApply consent (PIPL Art. 24; invariant I8)', () => {
  const cnRows = (n: number) => {
    for (let i = 0; i < n; i++) twin(`c${i}`, { market: 'cn', title: '后端开发工程师', titleNormalized: '后端开发工程师', postedAt: new Date(POSTED.getTime() - i * 3_600_000) });
  };
  beforeEach(() => {
    for (const fn of [logger.info, logger.warn, logger.error]) mocked(fn).mockClear();
  });

  it('without 个性化推荐 and with a query text: legs A and B only, in their fused order (query_match); no profile, no vector, no fit', async () => {
    personalized = false;
    cnRows(6);
    repo.searchDocs.set('c4', '后端 开发 kafka kafka');
    repo.searchDocs.set('c2', '后端 开发 kafka');
    repo.vectors.set('c5', testVector(1, 0));
    const embeddings = embedFake();
    const retrieval = retrievalFake({ u1: testVector(1, 0) });
    const res = await service({ embeddings, retrieval }).query(cnCtx(), { sort: 'recommended', relevance: 'kafka' });
    expect(legsUsed()).toEqual(['lexical', 'recency']);
    expect(res.order).toBe('query_match');
    expect(res.sort).toBe('newest');
    // A (newest first): c0 c1 c2 c3 c4 c5. B: c4 c2. Fused: c2 (1/63 + 1/62), c4 (1/65 + 1/61), then c0 c1 c3 c5.
    expect(res.items.map((i) => i.jobId)).toEqual(['c2', 'c4', 'c0', 'c1', 'c3', 'c5']);
    expect(res.items.every((i) => i.fit === null)).toBe(true);
    expect(userContextCalls).toBe(0);
    expect(match.calls.getFits).toEqual([]);
    expect(embeddings.calls).toHaveLength(0);
    expect(retrieval.reads).toHaveLength(0);
    // The cursor of a query_match list pages on.
    expect(repo.sessions.get(res.sessionId)!.sort).toBe('newest');
  });

  it('without 个性化推荐: a typed q is the query too; with no query text the list is by date from one statement, as before', async () => {
    personalized = false;
    cnRows(6);
    repo.searchDocs.set('c5', '后端 开发 工程师 资深');
    const typed = await service({ embeddings: embedFake(), retrieval: retrievalFake() }).query(cnCtx(), { sort: 'best_fit', q: '后端' });
    expect(typed.order).toBe('query_match');
    expect(legsUsed()).toEqual(['lexical', 'recency']);
    // c5 is the only row both legs return.
    expect(typed.items[0]!.jobId).toBe('c5');
    repo.queries.length = 0;
    const plain = await service({ embeddings: embedFake(), retrieval: retrievalFake() }).query(cnCtx(), { sort: 'recommended' });
    expect(plain.order).toBe('recency');
    expect(legsUsed()).toEqual(['recency']);
    expect(limitOf(legStatements('recency')[0]!)).toBe(400);
    expect(plain.items.map((i) => i.jobId)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5']);
  });

  it('without 个性化推荐: choosing Newest keeps the date order even with a query text', async () => {
    personalized = false;
    cnRows(4);
    repo.searchDocs.set('c3', 'kafka');
    const res = await service().query(cnCtx(), { sort: 'newest', relevance: 'kafka' });
    expect(res.order).toBe('recency');
    expect(res.items.map((i) => i.jobId)).toEqual(['c0', 'c1', 'c2', 'c3']);
  });

  it('a list in query order carries no "sorted by date" line on its cards; a list by date does', async () => {
    personalized = false;
    cnRows(3);
    repo.searchDocs.set('c1', 'kafka');
    const explain = vi.fn(() => ({ mode: 'non_personalized' as const, headline: 'Sorted by date posted and your filters', reasons: [], gaps: [], notices: [] }));
    const s = service({ explain: explain as never });
    const byQuery = await s.query(cnCtx(), { sort: 'recommended', relevance: 'kafka' });
    expect(byQuery.items.every((i) => i.explanation === undefined)).toBe(true);
    const byDate = await s.query(cnCtx(), { sort: 'recommended' });
    expect(byDate.items.every((i) => i.explanation?.mode === 'non_personalized')).toBe(true);
  });

  it('personalised but without the AI consent: no embedding call for a query text and no user vector read; legs A and B answer', async () => {
    aiOk = false;
    cnRows(5);
    repo.vectors.set('c0', testVector(1, 0));
    const embeddings = embedFake();
    const retrieval = retrievalFake({ u1: testVector(1, 0) });
    const s = service({ embeddings, retrieval });
    for (const input of [{ sort: 'recommended' as const, relevance: 'kafka' }, { sort: 'recommended' as const, q: '后端' }, { sort: 'recommended' as const }]) {
      repo.queries.length = 0;
      const res = await s.query(cnCtx(), input);
      expect(res.order).toBe('personalized');
      expect(res.items.length).toBeGreaterThan(0);
      expect(repo.legsRun()).not.toContain('dense');
    }
    await s.preview(cnCtx(), { limit: 5, relevance: 'kafka' });
    expect(embeddings.calls).toHaveLength(0);
    expect(retrieval.reads).toHaveLength(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('with both consents GoApply runs the same three legs as RoboApply (D5), inside its own market', async () => {
    cnRows(5);
    repo.rows.push(feedRow({ id: 'intl-twin', market: 'intl', postedAt: POSTED }));
    repo.searchDocs.set('c3', 'kafka');
    repo.searchDocs.set('intl-twin', 'kafka');
    repo.vectors.set('c4', testVector(1, 0));
    repo.vectors.set('intl-twin', testVector(1, 0));
    const embeddings = embedFake();
    const retrieval = retrievalFake({ u1: testVector(1, 0) });
    const s = service({ embeddings, retrieval });
    const res = await s.query(cnCtx(), { sort: 'recommended', relevance: 'kafka' });
    expect(legsUsed()).toEqual(['dense', 'lexical', 'recency']);
    expect(embeddings.calls).toEqual([{ brand: 'goapply', text: 'kafka', options: { purpose: 'query', carriesUserData: true, userId: 'u1' } }]);
    expect(res.items.map((i) => i.jobId)).not.toContain('intl-twin');
    expect(legStatements('dense')[0]!.values.slice(0, 2)).toEqual([FAKE_VECTOR_MODEL, 'cn']);
    // No query text: the stored vector, read for the mainland market only.
    await s.query(cnCtx(), { sort: 'recommended' });
    expect(retrieval.reads).toEqual([{ userId: 'u1', market: 'cn', modelTag: FAKE_VECTOR_MODEL }]);
    expect(embeddings.calls).toHaveLength(1);
  });

  it('RoboApply reads its stored user vector without an AI-consent question (it has none), and never asks for one on a list with a query text', async () => {
    aiOk = false;
    seed(5);
    const retrieval = retrievalFake({ u1: testVector(1, 0) });
    const embeddings = embedFake();
    const s = service({ embeddings, retrieval });
    await s.query(ctx(), { sort: 'recommended' });
    expect(retrieval.reads).toHaveLength(1);
    await s.query(ctx(), { sort: 'recommended', relevance: 'kafka' });
    expect(embeddings.calls).toHaveLength(0);
    expect(retrieval.reads).toHaveLength(1);
  });
});

// ── The text to rank by (SM-9) ────────────────────────────────────────────────────────────────────

describe('natural-language search: the residual text ranks the list and is never a predicate', () => {
  it('"backend jobs at climate startups using Rust": the posting that mentions them comes before an equally fresh one that does not', async () => {
    profileFilters = { taxonomyIds: ['backend_engineer'] };
    twin('plain-b');
    twin('mentions');
    twin('plain-a');
    repo.searchDocs.set('mentions', 'backend engineer at a climate startup our services are written in rust');
    repo.searchDocs.set('plain-a', 'backend engineer payments java');
    repo.searchDocs.set('plain-b', 'backend engineer logistics go');
    const s = service();
    const ranked = await s.query(ctx(), { sort: 'recommended', relevance: 'climate startups Rust' });
    expect(ranked.items.map((i) => i.jobId)).toEqual(['mentions', 'plain-b', 'plain-a']);
    // Without the text the order is today's.
    const plain = await s.query(ctx(), { sort: 'recommended' });
    expect(plain.items.map((i) => i.jobId)).toEqual(['plain-b', 'plain-a', 'mentions']);
    // Never a predicate: the list still holds every posting the filters allow, and no statement filters on the text.
    expect(ranked.items).toHaveLength(3);
    for (const q of repo.queries) expect(q.text).not.toContain('searchText');
    const lexical = legStatements('lexical');
    expect(lexical.some((q) => lexicalQueryOf(q) === "'climate' | 'startups' | 'rust'")).toBe(true);
  });

  it('a typed q and the text to rank by work together: q filters, both order; the preview seam says when the text took part', async () => {
    // Three equally fresh postings that all match the typed q; only `a` mentions the topics.
    for (const id of ['c', 'b', 'a']) twin(id);
    repo.searchDocs.set('c', 'backend engineer');
    repo.searchDocs.set('b', 'backend engineer');
    repo.searchDocs.set('a', 'backend engineer climate rust');
    repo.rows.push(feedRow({ id: 'off-topic', title: 'Data Analyst', titleNormalized: 'data analyst', postedAt: POSTED, firstSeenAt: POSTED }));
    repo.searchDocs.set('off-topic', 'data analyst climate rust');
    const s = service();
    // Without the text: the recency order of equal rows (id descending).
    const plain = await s.previewOrdered(ctx(), { q: 'backend', limit: 10 });
    expect(plain.items.map((i) => i.jobId)).toEqual(['c', 'b', 'a']);
    expect(plain.relevanceApplied).toBe(false);
    // With it: A is c b a, B is a c b; fused c (1/61 + 1/62) > a (1/63 + 1/61) > b (1/62 + 1/63). `a` now precedes `b`.
    const ranked = await s.previewOrdered(ctx(), { q: 'backend', relevance: 'climate rust', limit: 10 });
    expect(ranked.items.map((i) => i.jobId)).toEqual(['c', 'a', 'b']);
    expect(ranked.relevanceApplied).toBe(true);
    // Never a predicate: the posting that mentions the topics but not the typed word is not listed.
    expect(ranked.items.map((i) => i.jobId)).not.toContain('off-topic');
    // `preview` is the same rows; the list itself orders the same way.
    expect((await s.preview(ctx(), { q: 'backend', relevance: 'climate rust', limit: 10 })).map((i) => i.jobId)).toEqual(['c', 'a', 'b']);
    expect((await s.query(ctx(), { sort: 'recommended', q: 'backend', relevance: 'climate rust' })).items.map((i) => i.jobId)).toEqual(['c', 'a', 'b']);
    // The report is per read, never assumed: no leg answered, the legs are off, or the list is by date.
    repo.searchDocs.clear();
    expect((await s.previewOrdered(ctx(), { q: 'backend', relevance: 'climate rust', limit: 10 })).relevanceApplied).toBe(false);
    // The lexical leg answers for the typed word, and no listed posting mentions the topics: the order is the plain
    // one, and it is not reported as ranked by them (M4 cross-review). The posting that mentions them is outside q.
    for (const id of ['c', 'b', 'a']) repo.searchDocs.set(id, 'backend engineer');
    repo.searchDocs.set('off-topic', 'data analyst climate rust');
    const unmatched = await s.previewOrdered(ctx(), { q: 'backend', relevance: 'climate rust', limit: 10 });
    expect(unmatched.items.map((i) => i.jobId)).toEqual(['c', 'b', 'a']);
    expect(unmatched.relevanceApplied).toBe(false);
    repo.searchDocs.clear();
    repo.searchDocs.set('a', 'backend engineer climate rust');
    expect((await service({ env: { FEED_HYBRID: 'off' } }).previewOrdered(ctx(), { q: 'backend', relevance: 'climate rust', limit: 10 })).relevanceApplied).toBe(false);
    expect((await s.previewOrdered(ctx(), { q: 'backend', relevance: 'climate rust', sort: 'newest', limit: 10 })).relevanceApplied).toBe(false);
    expect((await s.previewOrdered(ctx(), { relevance: 'climate rust', limit: 10 })).relevanceApplied).toBe(true);
    // GoApply without 个性化推荐: legs A and B in their fused order, so the text decides the order outright.
    personalized = false;
    repo.rows.forEach((r) => (r.market = 'cn'));
    const cn = await s.previewOrdered(cnCtx(), { q: 'backend', relevance: 'climate rust', limit: 10 });
    expect(cn.relevanceApplied).toBe(true);
    expect(cn.items[0]!.jobId).toBe('a');
    // Recruitment-info mode off: nothing is listed and nothing is claimed.
    expect(await service({ postingsAllowed: () => false }).previewOrdered(cnCtx(), { q: 'backend', relevance: 'climate rust', limit: 10 })).toEqual({ items: [], relevanceApplied: false });
  });

  it('the job-search API\'s read (MKT-4H): a GoApply reader without 个性化推荐, the role as q and the topics as relevance', async () => {
    // The fixture of job-search/index-feed.gate.test.ts: three equally recent rows that all match the query; by
    // date and id alone the only row that mentions the topics is LAST.
    personalized = false;
    aiOk = false;
    for (const [id, title, doc] of [
      ['c_plain', 'Backend Engineer', 'backend engineer payments'],
      ['b_plain', 'Backend Engineer, Platform', 'backend engineer platform'],
      ['a_topical', 'Backend Engineer (Rust), climate', 'backend engineer rust climate'],
    ] as const) {
      twin(id, { market: 'cn', title, titleNormalized: title.toLowerCase(), location: '上海', locationCountry: 'CN', remoteScope: null });
      repo.searchDocs.set(id, doc);
    }
    const embeddings = embedFake();
    const s = service({ embeddings, retrieval: retrievalFake() });
    const plain = await s.previewOrdered(cnCtx(), { q: 'backend engineer', limit: 50 });
    expect(plain).toMatchObject({ relevanceApplied: false });
    expect(plain.items.map((i) => i.jobId)).toEqual(['c_plain', 'b_plain', 'a_topical']);
    const ordered = await s.previewOrdered(cnCtx(), { q: 'backend engineer', relevance: 'climate Rust', limit: 50 });
    expect(ordered.relevanceApplied).toBe(true);
    // The row that mentions the topics now precedes the equally recent row that came before it.
    expect(ordered.items.map((i) => i.jobId)).toEqual(['c_plain', 'a_topical', 'b_plain']);
    // No profile, no fit, no vector and no model call for this reader (invariant I8).
    expect(ordered.items.every((i) => i.fit === null)).toBe(true);
    expect(userContextCalls).toBe(0);
    expect(embeddings.calls).toHaveLength(0);
    expect(repo.legsRun()).not.toContain('dense');
  });

  it('the count of a search does not move with the text to rank by', async () => {
    seed(8);
    repo.countFromRows = true;
    const s = service();
    const before = await s.countForFilters(ctx(), profileFilters);
    await s.query(ctx(), { sort: 'recommended', relevance: 'climate startups Rust' });
    expect(await s.countForFilters(ctx(), profileFilters)).toEqual(before);
    expect(before.count).toBe(8);
  });

  it('the same flow on GoApply with the consents given', async () => {
    for (const id of ['g1', 'g2', 'g3']) twin(id, { market: 'cn', title: '后端开发工程师', titleNormalized: '后端开发工程师' });
    repo.searchDocs.set('g1', '后端 开发 新能源 创业 公司 rust');
    const res = await service({ embeddings: embedFake(), retrieval: retrievalFake() }).query(cnCtx(), { sort: 'recommended', relevance: '新能源 Rust' });
    expect(res.order).toBe('personalized');
    expect(res.items.map((i) => i.jobId)).toEqual(['g1', 'g3', 'g2']);
    expect(res.items.every((i) => i.fit !== null)).toBe(true);
  });
});

// ── The same role in several places (SM-12) ───────────────────────────────────────────────────────

describe('the same role in several cities collapses into one card', () => {
  const role = (id: string, location: string, over: Partial<Parameters<typeof feedRow>[0]> = {}) =>
    repo.rows.push(
      feedRow({ id, title: 'Sales Engineer', titleNormalized: 'sales engineer', companyName: 'Acme', companyNameNormalized: 'acme', location, workModel: 'onsite', remoteScope: null, postedAt: POSTED, ...over }),
    );

  it('three rows of one company and title in three cities: one card that names the two other places', async () => {
    role('austin', 'Austin, TX');
    role('denver', 'Denver, CO');
    role('seattle', 'Seattle, WA');
    repo.rows.push(feedRow({ id: 'elsewhere', title: 'Sales Engineer', titleNormalized: 'sales engineer', companyName: 'Globex', companyNameNormalized: 'globex', postedAt: POSTED }));
    const res = await service().query(ctx(), { sort: 'recommended' });
    const cards = res.items.filter((i) => i.company.name === 'Acme');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.jobId).toBe('seattle');
    expect(cards[0]!.alsoIn).toEqual({ count: 2, locations: ['Denver, CO', 'Austin, TX'], jobIds: ['denver', 'austin'] });
    // The same title at another company stays its own card, with nothing folded into it.
    const other = res.items.find((i) => i.jobId === 'elsewhere')!;
    expect(other.alsoIn).toBeUndefined();
    // The session lists cards; the folded postings are remembered on the card's entry.
    const session = repo.sessions.get(res.sessionId)!;
    expect(session.jobIds.sort()).toEqual(['elsewhere', 'seattle']);
    expect((session.ranks as Array<{ jobId: string; also?: string[] }>).find((r) => r.jobId === 'seattle')!.also).toEqual(['denver', 'austin']);
    // Cards are what is counted: nothing is "hidden by tier" because it was folded.
    expect(session.totalEstimate).toBe(2);
    expect(res.hiddenByTier).toBe(0);
  });

  it('the page size stays 20 cards, and a later page reads its cards\' other places from the session', async () => {
    seed(19);
    for (let i = 0; i < 11; i++) {
      role(`a${i}`, `City ${i}, TX`, { postedAt: new Date(daysAgo(4).getTime() - i * 60_000) });
      role(`b${i}`, `Town ${i}, CA`, { postedAt: new Date(daysAgo(5).getTime() - i * 60_000), title: 'Account Manager', titleNormalized: 'account manager', companyName: 'Globex', companyNameNormalized: 'globex' });
    }
    const s = service();
    const p1 = await s.query(ctx(), { sort: 'newest' });
    expect(p1.items).toHaveLength(20);
    const acme = p1.items[19]!;
    expect(acme.jobId).toBe('a0');
    // Ten other places: all counted, all named and linked, each name beside its own job id.
    expect(acme.alsoIn!.count).toBe(ALSO_IN_MAX);
    expect(acme.alsoIn!.jobIds).toEqual(Array.from({ length: 10 }, (_, i) => `a${i + 1}`));
    for (const [i, id] of acme.alsoIn!.jobIds.entries()) expect(acme.alsoIn!.locations[i]).toBe(repo.rows.find((r) => r.id === id)!.location);
    const p2 = await s.query(ctx(), { sort: 'newest', cursor: p1.cursor! });
    expect(p2.items).toHaveLength(1);
    expect(p2.items[0]!.jobId).toBe('b0');
    expect(p2.items[0]!.alsoIn!.count).toBe(10);
    expect(p2.endOfFeed).toBe(true);
    expect(repo.sessions.get(p1.sessionId)!.jobIds).toHaveLength(21);
  });

  it('a card names at most ten other places: the twelfth posting of a role is a card of its own, so every posting can be opened from a card', async () => {
    for (let i = 0; i < 25; i++) role(`a${String(i).padStart(2, '0')}`, `City ${i}, TX`, { postedAt: new Date(daysAgo(4).getTime() - i * 60_000) });
    const res = await service().query(ctx(), { sort: 'newest' });
    // 25 postings: a00 names a01 to a10, a11 names a12 to a21, a22 names a23 and a24.
    expect(res.items.map((i) => i.jobId)).toEqual(['a00', 'a11', 'a22']);
    expect(res.items.map((i) => i.alsoIn!.count)).toEqual([10, 10, 2]);
    for (const item of res.items) {
      expect(item.alsoIn!.jobIds).toHaveLength(item.alsoIn!.count);
      expect(item.alsoIn!.locations).toHaveLength(item.alsoIn!.count);
    }
    const reachable = res.items.flatMap((i) => [i.jobId, ...i.alsoIn!.jobIds]);
    expect(reachable).toHaveLength(25);
    expect(new Set(reachable).size).toBe(25);
    expect(repo.sessions.get(res.sessionId)!.totalEstimate).toBe(3);
  });

  it('hiding the card hides that posting only: on the next load the next posting of the role is the card', async () => {
    role('austin', 'Austin, TX');
    role('denver', 'Denver, CO');
    role('seattle', 'Seattle, WA');
    const s = service();
    const before = await s.query(ctx(), { sort: 'recommended' });
    expect(before.items.map((i) => i.jobId)).toEqual(['seattle']);
    await s.hide(ctx(), 'seattle', { reasonCode: 'already_applied' });
    const after = await s.query(ctx(), { sort: 'recommended' });
    expect(after.items.map((i) => i.jobId)).toEqual(['denver']);
    expect(after.items[0]!.alsoIn).toEqual({ count: 1, locations: ['Austin, TX'], jobIds: ['austin'] });
    // A folded posting hidden since the session started drops out of the card on a later read of that page.
    repo.hidden.set('u1:austin', { at: NOW, reason: 'other' });
    const again = await service().query(ctx(), { sort: 'recommended' });
    expect(again.items[0]!.alsoIn).toBeUndefined();
  });

  it('a posting for the same city, a user\'s own import, and a posting that mentions sponsorship when you need it are never folded away', async () => {
    role('austin-1', 'Austin, TX');
    role('austin-2', 'Austin, TX');
    role('mine', 'Reno, NV', { visibility: 'private', ownerUserId: 'u1', sourceBoard: 'user_import' });
    const res = await service().query(ctx(), { sort: 'recommended' });
    expect(res.items.map((i) => i.jobId).sort()).toEqual(['austin-1', 'austin-2', 'mine']);
    expect(res.items.every((i) => i.alsoIn === undefined)).toBe(true);
    // "I need visa sponsorship": the posting that mentions it leads, and is not folded into one that does not.
    repo.rows = [];
    profileFilters = { needsSponsorship: true };
    role('zz-plain', 'Austin, TX');
    role('aa-sponsor', 'Denver, CO', { sponsorship: 'offered', sponsorshipEvidence: 'We sponsor H-1B visas.' });
    // By rank alone `zz-plain` would be the card (the id breaks the tie). The posting that mentions sponsorship
    // leads instead and is the card; the other place is folded into it, never the other way round.
    const sponsored = await service().query(ctx(), { sort: 'recommended' });
    expect(sponsored.items.map((i) => i.jobId)).toEqual(['aa-sponsor']);
    expect(sponsored.items[0]!.alsoIn).toEqual({ count: 1, locations: ['Austin, TX'], jobIds: ['zz-plain'] });
    profileFilters = {};
    const plain = await service().query(ctx(), { sort: 'recommended' });
    expect(plain.items.map((i) => i.jobId)).toEqual(['zz-plain']);
  });

  it('the "Great" view hides weak fits first; what it hides is counted, what is folded is not', async () => {
    profileFilters = { taxonomyIds: ['backend_engineer'], fitTier: 'great' };
    role('austin', 'Austin, TX');
    role('denver', 'Denver, CO');
    role('weak', 'Boise, ID', { title: 'Receptionist', titleNormalized: 'receptionist', companyNameNormalized: 'other', companyName: 'Other' });
    for (const id of ['austin', 'denver']) repo.ai.set(id, { score: 90, tier: 'great' });
    repo.ai.set('weak', { score: 30, tier: 'unlikely' });
    const res = await service().query(ctx(), { sort: 'recommended' });
    expect(res.items.map((i) => i.jobId)).toEqual(['denver']);
    expect(res.items[0]!.alsoIn!.count).toBe(1);
    expect(res.hiddenByTier).toBe(1);
  });

  /** Every page of a list, with the cards each page delivered. */
  const pagesOf = async (s: ReturnType<typeof service>, sort: 'newest' | 'recommended' = 'newest') => {
    let res = await s.query(ctx(), { sort });
    const pages = [res.items];
    for (let guard = 0; res.cursor && guard < 10; guard++) {
      res = await s.query(ctx(), { sort, cursor: res.cursor });
      pages.push(res.items);
    }
    return { pages, sessionId: res.sessionId };
  };

  /**
   * Every posting the session folded away is named, with its place, by a card
   * on a page that was delivered: nothing is folded into a card the client
   * already held. Also: no job is listed twice, as a card or as a place.
   */
  const expectEveryFoldReachable = (pages: Array<Awaited<ReturnType<ReturnType<typeof service>['query']>>['items']>, sessionId: string) => {
    const ranks = repo.sessions.get(sessionId)!.ranks as Array<{ jobId: string; also?: string[] }>;
    const delivered = new Map(pages.flat().map((i) => [i.jobId, i]));
    for (const entry of ranks) {
      for (const folded of entry.also ?? []) {
        const card = delivered.get(entry.jobId);
        expect(card, `${folded} was folded into ${entry.jobId}, which no page delivered`).toBeDefined();
        expect(card!.alsoIn?.jobIds ?? [], `${entry.jobId} was delivered without naming ${folded}`).toContain(folded);
      }
    }
    const cards = pages.flat().map((i) => i.jobId);
    const places = pages.flat().flatMap((i) => i.alsoIn?.jobIds ?? []);
    expect(new Set([...cards, ...places]).size).toBe(cards.length + places.length);
  };

  it('a later window folds another place of a role into a card that is still to be sent; a place the card already names stays a card', async () => {
    seed(5);
    role('recent', 'Austin, TX', { postedAt: daysAgo(1) });
    // Older than the first window (45 days once it is widened): the first page reads them from the next window.
    role('old-denver', 'Denver, CO', { postedAt: daysAgo(60) });
    role('old-austin', 'Austin, TX', { postedAt: daysAgo(61) });
    const { pages, sessionId } = await pagesOf(service());
    expect(pages).toHaveLength(1);
    const recent = pages[0]!.find((i) => i.jobId === 'recent')!;
    // Denver joined the recent card, which this very page delivers; the older Austin posting names the card's own city and stays a card.
    expect(recent.alsoIn).toEqual({ count: 1, locations: ['Denver, CO'], jobIds: ['old-denver'] });
    expect(pages[0]!.map((i) => i.jobId).filter((id) => ['recent', 'old-denver', 'old-austin'].includes(id))).toEqual(['recent', 'old-austin']);
    expectEveryFoldReachable(pages, sessionId);
  });

  it('a posting whose role already has a card on a page the client holds is never folded into it: it is a card of its own, and reachable', async () => {
    seed(60); // enough recent rows that the first window is not widened, and three full pages come before any refill
    role('recent', 'Austin, TX', { postedAt: daysAgo(1) });
    role('old-denver', 'Denver, CO', { postedAt: daysAgo(30) });
    role('old-boston', 'Boston, MA', { postedAt: daysAgo(31) });
    const { pages, sessionId } = await pagesOf(service());
    // `recent` went out on page 2; the window that brings the two old postings is read for page 4.
    expect(pages[1]!.map((i) => i.jobId)).toContain('recent');
    expect(pages[1]!.find((i) => i.jobId === 'recent')!.alsoIn).toBeUndefined();
    const last = pages[pages.length - 1]!;
    // The role gets a second card there: the newer of the two, which names the other one's place.
    const denver = last.find((i) => i.jobId === 'old-denver')!;
    expect(denver).toBeDefined();
    expect(denver.alsoIn).toEqual({ count: 1, locations: ['Boston, MA'], jobIds: ['old-boston'] });
    expect(pages.flat().map((i) => i.jobId)).not.toContain('old-boston');
    const ranks = repo.sessions.get(sessionId)!.ranks as Array<{ jobId: string; also?: string[] }>;
    expect(ranks.find((r) => r.jobId === 'recent')!.also).toBeUndefined();
    expectEveryFoldReachable(pages, sessionId);
  });

  it('the same holds under Recommended with the legs, page after page', async () => {
    seed(45);
    for (let i = 0; i < 6; i++) {
      role(`near${i}`, `City ${i}, TX`, { postedAt: daysAgo(3 + i) });
      role(`far${i}`, `Town ${i}, CA`, { postedAt: daysAgo(50 + i) });
    }
    const { pages, sessionId } = await pagesOf(service(), 'recommended');
    expect(pages.length).toBeGreaterThan(1);
    expectEveryFoldReachable(pages, sessionId);
    // Every one of the twelve postings is a card or a named place of one.
    const all = [...pages.flat().map((i) => i.jobId), ...pages.flat().flatMap((i) => i.alsoIn?.jobIds ?? [])];
    for (let i = 0; i < 6; i++) for (const id of [`near${i}`, `far${i}`]) expect(all, id).toContain(id);
  });

  it('"I need visa sponsorship": a later window never folds a posting that mentions it into an earlier card that does not', async () => {
    profileFilters = { needsSponsorship: true };
    seed(5);
    role('plain', 'Austin, TX', { postedAt: daysAgo(1) });
    role('old-sponsor', 'Denver, CO', { postedAt: daysAgo(60), sponsorship: 'offered', sponsorshipEvidence: 'We sponsor H-1B visas.' });
    role('old-plain', 'Reno, NV', { postedAt: daysAgo(61) });
    const { pages, sessionId } = await pagesOf(service());
    const cards = pages.flat();
    // Both postings are cards: the one that mentions sponsorship is not hidden behind the one that does not.
    expect(cards.find((i) => i.jobId === 'plain')!.alsoIn).toBeUndefined();
    const sponsor = cards.find((i) => i.jobId === 'old-sponsor')!;
    expect(sponsor).toBeDefined();
    // From then on the card that mentions sponsorship stands for the role: the other old place joins it.
    expect(sponsor.alsoIn).toEqual({ count: 1, locations: ['Reno, NV'], jobIds: ['old-plain'] });
    expectEveryFoldReachable(pages, sessionId);
    // Without the need, the same rows fold into the recent card as usual.
    profileFilters = {};
    const usual = await pagesOf(service());
    expect(usual.pages.flat().find((i) => i.jobId === 'plain')!.alsoIn).toEqual({ count: 2, locations: ['Denver, CO', 'Reno, NV'], jobIds: ['old-sponsor', 'old-plain'] });
    expectEveryFoldReachable(usual.pages, usual.sessionId);
  });

  it('the Assistant\'s preview carries the other places too', async () => {
    role('austin', 'Austin, TX');
    role('denver', 'Denver, CO');
    const items = await service().preview(ctx(), { limit: 5 });
    expect(items).toHaveLength(1);
    expect(items[0]!.alsoIn).toEqual({ count: 1, locations: ['Austin, TX'], jobIds: ['austin'] });
  });
});

// ── "Not interested: wrong title", seen and skipped (SM-12) ───────────────────────────────────────

describe('"Not interested: wrong title" is a title-level negative', () => {
  const sales = (id: string, over: Partial<Parameters<typeof feedRow>[0]> = {}) =>
    repo.rows.push(feedRow({ id, title: 'Sales Engineer', titleNormalized: 'sales engineer', primaryTaxonomyId: 'sales_engineer', taxonomyIds: ['sales', 'sales_engineer'], postedAt: POSTED, ...over }));

  it('lowers the role and the title by 0.25, leaves the company and the skills alone, and still proposes the filter change', async () => {
    sales('s1');
    repo.countResponder = () => 12;
    const res = await service().hide(ctx(), 's1', { reasonCode: 'wrong_title' });
    const affinity = repo.affinity.get('u1')!;
    expect(affinity.taxonomy).toEqual({ sales_engineer: -0.25 });
    expect(affinity.title).toEqual({ 'sales engineer': -0.25 });
    expect(affinity.company).toEqual({});
    expect(affinity.skill).toEqual({});
    // The proposal is unchanged: the person may decline it, and the saved filters are untouched either way.
    expect(res.proposedFilterDiff).toMatchObject({ ops: [{ op: 'add', path: 'excludedTitles', value: 'Sales Engineer' }], countAfter: 12 });
    expect(profileFilters).toEqual({ taxonomyIds: ['backend_engineer'] });
  });

  it('other "Sales Engineer" postings rank lower in Recommended while the role filter is unchanged; the weight fades with time', async () => {
    profileFilters = {};
    sales('hidden');
    sales('same-title', { companyNameNormalized: 'globex', companyName: 'Globex' });
    repo.rows.push(feedRow({ id: 'other-title', postedAt: POSTED, skills: ['salesforce'] }));
    const s = service();
    const rankOf = async (svc: ReturnType<typeof service>, at = NOW) => {
      const res = await svc.query(ctx({ now: at }), { sort: 'recommended' });
      return Object.fromEntries((repo.sessions.get(res.sessionId)!.ranks as Array<{ jobId: string; rank: number }>).map((r) => [r.jobId, r.rank]));
    };
    const before = await rankOf(s);
    await s.hide(ctx(), 'hidden', { reasonCode: 'wrong_title' });
    const after = await rankOf(s);
    // Affinity is 15% of the rank: 50 → 43.75 for the same role and title.
    expect(before['same-title']! - after['same-title']!).toBeCloseTo(0.15 * 6.25, 2);
    expect(after['other-title']).toBe(before['other-title']);
    expect(after.hidden).toBeUndefined();
    // Sixty days on the weight has faded to under a third of what it was.
    const later = new Date(NOW.getTime() + 60 * 86_400_000);
    const faded = await rankOf(service({ now: () => later }), later);
    repo.affinity.delete('u1');
    const lateClean = await rankOf(service({ now: () => later }), later);
    const lost = lateClean['same-title']! - faded['same-title']!;
    expect(lost).toBeGreaterThan(0);
    expect(lost).toBeLessThan((before['same-title']! - after['same-title']!) / 3);
  });

  it('a GoApply user without 个性化推荐 stores nothing; every other reason with a specific meaning stores nothing either', async () => {
    sales('s1', { market: 'cn' });
    sales('s2', { market: 'cn' });
    personalized = false;
    await service().hide(cnCtx(), 's1', { reasonCode: 'wrong_title' });
    expect(repo.hidden.has('u1:s1')).toBe(true);
    expect(repo.affinity.has('u1')).toBe(false);
    personalized = true;
    for (const reasonCode of ['wrong_level', 'wrong_location', 'pay_too_low', 'company', 'already_applied'] as const) await service().hide(cnCtx(), 's2', { reasonCode });
    expect(repo.affinity.has('u1')).toBe(false);
    await service().hide(cnCtx(), 's2', { reasonCode: 'wrong_title' });
    expect(repo.affinity.get('u1')!.title).toEqual({ 'sales engineer': -0.25 });
  });

  it('skill affinity is keyed by canonical skill ids when the job has them', async () => {
    repo.rows.push(feedRow({ id: 'canon', skills: ['Postgres', 'k8s'], skillIds: ['sk_postgresql', 'sk_kubernetes'] }), feedRow({ id: 'plain', skills: ['Python', 'SQL'] }));
    const s = service();
    await s.recordInteraction(ctx(), 'canon', 'save');
    expect(repo.affinity.get('u1')!.skill).toEqual({ sk_postgresql: 0.1, sk_kubernetes: 0.1 });
    await s.recordInteraction(ctx(), 'plain', 'save');
    expect(repo.affinity.get('u1')!.skill).toMatchObject({ python: 0.1, sql: 0.1 });
    expect(repo.affinity.get('u1')!.title).toEqual({});
  });
});

describe('seen and skipped', () => {
  const ranksOfQuery = async (svc: ReturnType<typeof service>, sort: 'recommended' | 'best_fit' = 'recommended') => {
    const res = await svc.query(ctx(), { sort });
    return Object.fromEntries((repo.sessions.get(res.sessionId)!.ranks as Array<{ jobId: string; rank: number }>).map((r) => [r.jobId, r.rank]));
  };

  it('a job shown five times and never opened ranks 10 points lower; three times 5, four times 7.5; an opened job loses nothing', async () => {
    for (const id of ['five', 'four', 'three', 'two', 'opened', 'fresh']) twin(id);
    const base = await ranksOfQuery(service());
    repo.impressionRows.set('u1:five', { impressions: 5, viewedAt: null });
    repo.impressionRows.set('u1:four', { impressions: 4, viewedAt: null });
    repo.impressionRows.set('u1:three', { impressions: 3, viewedAt: null });
    repo.impressionRows.set('u1:two', { impressions: 2, viewedAt: null });
    repo.impressionRows.set('u1:opened', { impressions: 9, viewedAt: daysAgo(1) });
    repo.impressionRows.set('u2:fresh', { impressions: 9, viewedAt: null });
    const after = await ranksOfQuery(service());
    expect(base.five! - after.five!).toBeCloseTo(10, 3);
    expect(base.four! - after.four!).toBeCloseTo(7.5, 3);
    expect(base.three! - after.three!).toBeCloseTo(5, 3);
    for (const id of ['two', 'opened', 'fresh']) expect(after[id], id).toBe(base[id]);
    // The list order follows.
    const res = await service().query(ctx(), { sort: 'recommended' });
    expect(res.items.map((i) => i.jobId).slice(-3)).toEqual(['three', 'four', 'five']);
  });

  it('applies to the Recommended order of a personalised list only, and a failing read takes nothing away', async () => {
    for (const id of ['a', 'b']) twin(id);
    repo.impressionRows.set('u1:a', { impressions: 9, viewedAt: null });
    const spy = vi.spyOn(repo, 'impressionStates');
    const bestFit = await service().query(ctx(), { sort: 'best_fit' });
    expect(bestFit.items.map((i) => i.jobId)).toEqual(['b', 'a']);
    await service().query(ctx(), { sort: 'newest' });
    expect(spy).not.toHaveBeenCalled();
    personalized = false;
    repo.rows.forEach((r) => (r.market = 'cn'));
    await service().query(cnCtx(), { sort: 'recommended' });
    expect(spy).not.toHaveBeenCalled();
    personalized = true;
    repo.rows.forEach((r) => (r.market = 'intl'));
    spy.mockRejectedValueOnce(new Error('down'));
    const res = await service().query(ctx(), { sort: 'recommended' });
    expect(res.items.map((i) => i.jobId)).toEqual(['b', 'a']);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// ── A thin saved search asks for one targeted ingest (SM-9) ───────────────────────────────────────

describe('a thin list for a saved search queues one targeted ingest', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('under 60 rows: exactly one request for that profile version, none on the next page, refresh or another sort', async () => {
    seed(25);
    const asked: string[] = [];
    const s = service({ requestIngest: async (id) => void asked.push(id) });
    const p1 = await s.query(ctx(), { sort: 'recommended' });
    await settle();
    expect(asked).toEqual(['sp1']);
    await s.query(ctx(), { sort: 'recommended', cursor: p1.cursor! });
    await s.query(ctx(), { sort: 'recommended' });
    await s.query(ctx(), { sort: 'newest' });
    await settle();
    expect(asked).toEqual(['sp1']);
    // A changed search is a new version: one more request.
    profileVersion = 2;
    await s.query(ctx(), { sort: 'recommended' });
    await settle();
    expect(asked).toEqual(['sp1', 'sp1']);
  });

  it('remembered for six hours per profile version', async () => {
    seed(12);
    let clock = NOW;
    const asked: string[] = [];
    const s = service({ requestIngest: (id) => void asked.push(id), now: () => clock });
    await s.query(ctx(), { sort: 'recommended' });
    clock = new Date(NOW.getTime() + 5 * 3_600_000);
    await s.query(ctx({ now: clock }), { sort: 'recommended' });
    await settle();
    expect(asked).toHaveLength(1);
    clock = new Date(NOW.getTime() + 6 * 3_600_000 + 1000);
    await s.query(ctx({ now: clock }), { sort: 'recommended' });
    await settle();
    expect(asked).toHaveLength(2);
  });

  it('not for a list of 60 rows or more, a browse, a one-off override or a typed query', async () => {
    seed(60);
    const asked: string[] = [];
    const s = service({ requestIngest: (id) => void asked.push(id) });
    await s.query(ctx(), { sort: 'recommended' });
    await s.query(ctx(), { sort: 'recommended', overrides: { taxonomyIds: ['software_engineering'] } });
    await s.query(ctx(), { sort: 'recommended', searchProfileId: 'sp1', overrides: { workModels: ['onsite'] } });
    await s.query(ctx(), { sort: 'recommended', q: 'nothing matches this' });
    await s.preview(ctx(), { limit: 5, q: 'nothing matches this' });
    await settle();
    expect(asked).toEqual([]);
  });

  it('a failing request never fails the feed, and is logged', async () => {
    seed(3);
    mocked(logger.warn).mockClear();
    const res = await service({
      requestIngest: async () => {
        throw new Error('queue down');
      },
    }).query(ctx(), { sort: 'recommended' });
    expect(res.items).toHaveLength(3);
    await settle();
    expect(mocked(logger.warn).mock.calls.some((c) => String(c[1]).includes('targeted ingest'))).toBe(true);
    // A request that throws at once is swallowed too.
    const sync = await service({
      requestIngest: () => {
        throw new Error('sync');
      },
    }).query(ctx(), { sort: 'recommended' });
    expect(sync.items).toHaveLength(3);
    await settle();
  });

  it('GoApply asks in the same way (its own pipeline reaches no search provider); the response never waits for it', async () => {
    seed(4);
    repo.rows.forEach((r) => (r.market = 'cn'));
    let release: () => void = () => undefined;
    const asked: string[] = [];
    const s = service({
      requestIngest: (id) =>
        new Promise<void>((resolve) => {
          asked.push(id);
          release = resolve;
        }),
    });
    const res = await s.query(cnCtx(), { sort: 'recommended' });
    expect(res.items).toHaveLength(4);
    expect(res).not.toHaveProperty('ingest');
    await settle();
    expect(asked).toEqual(['sp1']);
    release();
  });

  it('with no requestIngest dependency nothing is asked', async () => {
    seed(3);
    await expect(service().query(ctx(), { sort: 'recommended' })).resolves.toMatchObject({ endOfFeed: true });
  });
});
