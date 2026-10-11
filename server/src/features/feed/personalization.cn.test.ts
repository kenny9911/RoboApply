// @vitest-environment node
//
// PIPL Art. 24 on GoApply, at the feed's own route (WP-31 → WP-32 #1; the
// onboarding-cn `feedRankingFor` duplicate is retired in favour of this rule).
//
// The feed reads ONE switch, `isFeedPersonalized` (feed/defaultService.ts
// `defaultPersonalized`): on GoApply the user's newest
// `personalized_recommendation` consent record must be a grant. NO RECORD
// counts as off — a user who has not chosen is not profiled. With it off the
// list is ordered by date posted and filters only, no fit is computed or
// shown, and the profile is not read for ranking.
//
// Real router, real FeedQueryService and the real consent rule over a fake
// consent store and an in-memory repo: no database, no network, no model.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestHandler } from 'express';

vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { setConsentLookup, type ConsentRecordLike } from '../../platform/consent/index.js';
import { setFlagOverrideLoader } from '../../platform/flags.js';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import { explainMatch } from '../compliance/explainMatch.js';
import { buildMatchUser } from '../match/index.js';
import type { SearchProfileWire } from '../search/index.js';
import type { FeedItem, FeedOrder } from './contract.js';
import { defaultPersonalized } from './defaultService.js';
import { createFeedQueryService } from './FeedQueryService.js';
import { isFeedPersonalized } from './index.js';
import { createFeedRouter } from './routes.js';
import { FakeFeedRepo, fakeFeedMatch, feedRow } from './testkit.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const P = '/api/v1/roboapply/feed';
const GOAPPLY = 'goapply.localhost:3621';
/** Nothing set: the GoApply feed is on by default (D5; `off` is the kill switch). This file is about ordering. */
// GoHire has a posting page here: its bank rows are listed (sourceLine.ts `heldBankBoards`).
const ENV: Record<string, string> = { GOHIRE_PUBLIC_JOB_URL_TEMPLATE: 'https://jobs.gohire.example/p/{id}' };

type Env<T> = { success: boolean; data: T; code?: string };
type QueryData = { items: FeedItem[]; order: FeedOrder; sort: string; hiddenByTier: number };

const repo = new FakeFeedRepo();
let records: ConsentRecordLike[] = [];
let userContextCalls = 0;
let affinityReads = 0;

const profile = (): SearchProfileWire => ({
  id: 'sp1',
  name: '',
  isDefault: true,
  isActive: true,
  version: 1,
  schemaVersion: 1,
  filters: {},
  alertInstantMax: 0,
  alertDigest: null,
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
});

const service = createFeedQueryService({
  repo,
  // The real fit assembly (match/fit.ts) over the fake repo's rows; `repo.ai` holds the person's stored AI scores.
  match: fakeFeedMatch({
    repo,
    now: () => NOW,
    context(userId) {
      userContextCalls += 1;
      const user = buildMatchUser(
        {
          userId,
          market: 'cn',
          profile: { firstName: null, lastName: null, country: 'CN', skills: [{ name: 'Python' }], workAuth: [], cnFields: null },
          education: [],
          // The role comes from the person's record (their experience), never from the saved search.
          experience: [{ title: '后端开发工程师', company: '某公司', startYm: '2022-01', endYm: null, current: true, kind: 'work' }],
          resumeParsed: null,
          searchProfile: { filters: { taxonomyIds: ['backend_engineer'] }, version: 1 },
          employerIndustries: [],
        },
        NOW,
      );
      return { user, resume: { id: 'rv1', resumeMarkdown: '', resumeContentHash: 'h', parsedData: null, targetJobId: null } };
    },
  }),
  search: { getActive: async () => profile(), get: async () => profile() } as never,
  // The production rule, not a stub: this is what the test is about.
  personalized: defaultPersonalized,
  consumeRefresh: async () => ({ allowed: true, retryAfterSec: 0 }),
  aiAllowed: async () => true,
  planner: async () => ({ queries: [], unverifiedPreferences: [] }),
  explain: explainMatch,
  env: ENV,
  now: () => NOW,
});

const passThrough: RequestHandler = (_req, _res, next) => next();
let h: RouteHarness;

beforeAll(async () => {
  setFlagOverrideLoader(async () => []);
  setConsentLookup(async (_userId, types) => {
    const mine = records.filter((r) => (types as string[]).includes(r.consentType)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return mine[0] ?? null;
  });
  h = await startRouteHarness({
    env: ENV,
    mounts: [[P, createFeedRouter({ seekerAuth: [fakeAuth({ id: 'u1', role: 'seeker' })], service, limiter: () => passThrough, phoneGate: passThrough, env: ENV })]],
  });
});
afterAll(async () => {
  setFlagOverrideLoader(null);
  setConsentLookup(null);
  await h.close();
});

beforeEach(() => {
  Object.assign(repo, new FakeFeedRepo());
  const getAffinity = repo.getAffinity.bind(repo);
  repo.getAffinity = async (userId: string) => {
    affinityReads += 1;
    return getAffinity(userId);
  };
  // Five GoHire postings, newest first by id. The OLDEST one would lead any personalised order.
  for (let i = 0; i < 5; i++) {
    repo.rows.push(
      feedRow({
        id: `j${i}`,
        market: 'cn',
        sourceBoard: 'gohire',
        sourceName: 'GoHire',
        fromRecruiterBank: true,
        locationCountry: 'CN',
        companyName: `公司${i}`,
        companyNameNormalized: `公司${i}`,
        postedAt: new Date(NOW.getTime() - (i + 1) * 3_600_000),
      }),
    );
  }
  repo.ai.set('j4', { score: 98, tier: 'great' });
  records = [];
  userContextCalls = 0;
  affinityReads = 0;
});

const query = (body: Record<string, unknown> = {}) => h.request<Env<QueryData>>('POST', `${P}/query`, { host: GOAPPLY, body });
const consent = (granted: boolean, at: string): ConsentRecordLike => ({ consentType: 'personalized_recommendation', granted, createdAt: new Date(at) });

describe('GoApply feed without a personalized_recommendation record', () => {
  it('the rule itself: no record = off; a grant = on; a later withdrawal = off again; RoboApply is always on', async () => {
    expect(await isFeedPersonalized('u1', 'cn')).toBe(false);
    records = [consent(true, '2026-10-01T00:00:00Z')];
    expect(await isFeedPersonalized('u1', 'cn')).toBe(true);
    records = [consent(true, '2026-10-01T00:00:00Z'), consent(false, '2026-10-05T00:00:00Z')];
    expect(await isFeedPersonalized('u1', 'cn')).toBe(false);
    records = [];
    expect(await isFeedPersonalized('u1', 'intl')).toBe(true);
  });

  it('lists newest first with fit = null on every item, whatever sort was asked for', async () => {
    for (const sort of ['recommended', 'best_fit', 'newest']) {
      const res = await query({ sort });
      expect(res.status, sort).toBe(200);
      expect(res.body.data.order, sort).toBe('recency');
      expect(res.body.data.sort, sort).toBe('newest');
      expect(res.body.data.items.map((i) => i.jobId), sort).toEqual(['j0', 'j1', 'j2', 'j3', 'j4']);
      expect(res.body.data.items.every((i) => i.fit === null), sort).toBe(true);
    }
  });

  it('computes nothing about the user: no profile read for scoring, no stored preference read, and the fit-tier view hides nothing', async () => {
    const res = await query({ sort: 'recommended', fitTier: 'great' });
    expect(res.body.data.items).toHaveLength(5);
    expect(res.body.data.hiddenByTier).toBe(0);
    expect(userContextCalls).toBe(0);
    expect(affinityReads).toBe(0);
  });

  it('says so on every card: the explanation is the by-date one, with how to turn personalisation on', async () => {
    const res = await query({});
    for (const item of res.body.data.items) {
      expect(item.explanation).toMatchObject({ mode: 'non_personalized', headline: { key: 'legal.explain.headline.nonPersonalized' }, reasons: [], gaps: [] });
      expect(item.explanation!.notices.map((n) => n.key)).toContain('legal.explain.notice.turnOn');
    }
  });

  it('acting on a job stores no preference profile either (hide with no reason)', async () => {
    const res = await h.request('POST', `${P}/jobs/j1/hide`, { host: GOAPPLY, body: { reasonCode: 'not_interested' } });
    expect(res.status).toBe(200);
    expect(repo.affinity.size).toBe(0);
  });

  it('control: with a live grant the same request is personalised (the cached AI score leads and fits are shown)', async () => {
    records = [consent(true, '2026-10-01T00:00:00Z')];
    const res = await query({ sort: 'best_fit' });
    expect(res.body.data.order).toBe('personalized');
    expect(res.body.data.sort).toBe('best_fit');
    expect(res.body.data.items[0]).toMatchObject({ jobId: 'j4', fit: { kind: 'ai', score: 98 } });
    expect(res.body.data.items.every((i) => i.fit !== null)).toBe(true);
    expect(userContextCalls).toBeGreaterThan(0);
  });

  it('a withdrawn grant goes back to date order on the next request', async () => {
    records = [consent(true, '2026-10-01T00:00:00Z'), consent(false, '2026-10-09T00:00:00Z')];
    const res = await query({ sort: 'recommended' });
    expect(res.body.data.order).toBe('recency');
    expect(res.body.data.items.map((i) => i.jobId)).toEqual(['j0', 'j1', 'j2', 'j3', 'j4']);
    expect(res.body.data.items.every((i) => i.fit === null)).toBe(true);
  });

  it('a consent store outage fails closed (date order, no fit)', async () => {
    setConsentLookup(async () => {
      throw new Error('db down');
    });
    try {
      const res = await query({ sort: 'recommended' });
      expect(res.body.data.order).toBe('recency');
      expect(res.body.data.items.every((i) => i.fit === null)).toBe(true);
    } finally {
      setConsentLookup(async (_userId, types) => records.filter((r) => (types as string[]).includes(r.consentType)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null);
    }
  });
});
