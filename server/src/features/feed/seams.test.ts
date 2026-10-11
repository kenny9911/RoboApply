// @vitest-environment node
//
// INT-05: the feed seams other areas call, over an in-memory repo (no
// database, no network, no model):
//   - sampleForFilters   job ids, newest first, public only, ≤ 400, no ranking (WP-77)
//   - alertCandidates    the feed's own filter rules for a saved search's alert (WP-39a)
//   - publicList         the SEO pages' public rules (WP-78)
//   - browse             POST /feed/query with overrides.taxonomyIds and no profile (WP-33)
//   - cardMeta / explanation on FeedItem (WP-33, WP-41, WP-42, WP-13)
//   - GoApply: the seams return postings by default (D5); with the
//     recruitment-info mode set to off every seam answers empty

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { cnJobCapabilities } from '../cn/jobs/index.js';
import { explainMatch } from '../compliance/explainMatch.js';
import { cardMeta } from '../jobs/marketHooks.js';
import { buildMatchUser } from '../match/index.js';
import type { FilterSet, SearchProfileWire } from '../search/index.js';
import { createFeedQueryService, type FeedServiceDeps } from './FeedQueryService.js';
import { BANK_PAGES_ENV, FakeFeedRepo, fakeFeedMatch, feedRow } from './testkit.js';
import type { FeedCtx } from './types.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const daysAgo = (d: number) => hoursAgo(d * 24);
const ctx = (over: Partial<FeedCtx> = {}): FeedCtx => ({ userId: 'u1', market: 'intl', brandId: 'roboapply', now: NOW, ...over });
const cnCtx = (over: Partial<FeedCtx> = {}) => ctx({ market: 'cn', brandId: 'goapply', ...over });

let repo: FakeFeedRepo;
let profileFilters: FilterSet;
let personalized: boolean;
let profileReads: number;
let userContextCalls: number;

function profile(): SearchProfileWire {
  return {
    id: 'sp1',
    name: '',
    isDefault: true,
    isActive: true,
    version: 3,
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
    // The real fit assembly (match/fit.ts) over the fake repo's rows; `repo.ai` holds the person's stored AI scores.
    match: fakeFeedMatch({
      repo,
      now: () => NOW,
      context(userId) {
        userContextCalls += 1;
        const user = buildMatchUser(
          {
            userId,
            market: 'intl',
            profile: { firstName: null, lastName: null, country: 'US', skills: [{ name: 'Python' }, { name: 'SQL' }], workAuth: [], cnFields: null },
            education: [],
            // The role and the level come from the person's record, never from the saved search.
            experience: [{ title: 'Backend Engineer', company: 'Acme', startYm: '2022-01', endYm: null, current: true, kind: 'work' }],
            resumeParsed: null,
            searchProfile: { filters: { taxonomyIds: ['backend_engineer'], seniority: ['mid'] }, version: 1 },
            employerIndustries: [],
          },
          NOW,
        );
        return { user, resume: { id: 'rv1', resumeMarkdown: '', resumeContentHash: 'h', parsedData: null, targetJobId: null } };
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
      findById: async (id: string) => (id === 'sp1' ? { id: 'sp1', userId: 'u1', version: 3, filters: profileFilters } : null),
    } as FeedServiceDeps['search'],
    personalized: async () => personalized,
    consumeRefresh: async () => ({ allowed: true, retryAfterSec: 0 }),
    aiAllowed: async () => true,
    planner: async () => ({ queries: [], unverifiedPreferences: [] }),
    now: () => NOW,
    postingsAllowed: () => true,
    ...over,
  });
}

function seed(n: number, over: (i: number) => Partial<ReturnType<typeof feedRow>> = () => ({})) {
  for (let i = 0; i < n; i++) {
    const id = `j${String(i).padStart(3, '0')}`;
    repo.rows.push(feedRow({ id, postedAt: hoursAgo(i + 1), firstSeenAt: hoursAgo(i + 1), companyName: `Co ${id}`, companyNameNormalized: `co-${id}`, ...over(i) }));
  }
}

beforeEach(() => {
  repo = new FakeFeedRepo();
  profileFilters = {};
  personalized = true;
  profileReads = 0;
  userContextCalls = 0;
  // Both banks have a posting page in this file: bank rows are listed (the held case is in FeedQueryService.test.ts).
  for (const [k, v] of Object.entries(BANK_PAGES_ENV)) vi.stubEnv(k, v);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('sampleForFilters (competitiveness report sample)', () => {
  it('returns ids only, newest first, with no ranking, no fit, no session and no profile read', async () => {
    seed(6);
    // A cached AI score would lead a ranked list; the sample ignores it.
    repo.ai.set('j005', { score: 99, tier: 'great' });
    const ids = await service().sampleForFilters(ctx(), {}, { order: 'newest', limit: 400, publicOnly: true });
    expect(ids).toEqual(['j000', 'j001', 'j002', 'j003', 'j004', 'j005']);
    expect(repo.sessions.size).toBe(0);
    expect(userContextCalls).toBe(0);
    expect(profileReads).toBe(0);
    const sql = repo.queries.at(-1)!;
    expect(sql.text).toMatch(/^SELECT j\."id"\s/);
    expect(sql.text).toContain('ORDER BY j."postedAt" DESC NULLS LAST, j."id" DESC');
  });

  it('public only: the user’s own imported jobs are left out by the query itself (no post-filter)', async () => {
    seed(3);
    repo.rows.push(feedRow({ id: 'mine', visibility: 'private', ownerUserId: 'u1', sourceBoard: 'user_import', postedAt: hoursAgo(0.5) }));
    const svc = service();
    expect(await svc.sampleForFilters(ctx(), {}, { limit: 50 })).toEqual(['j000', 'j001', 'j002']);
    const sql = repo.queries.at(-1)!.text;
    expect(sql).toContain(`j."visibility" = 'public'`);
    expect(sql).not.toContain('"ownerUserId"');
    // `publicOnly: false` is the feed's own scope (public or the user's own).
    expect(await svc.sampleForFilters(ctx(), {}, { limit: 50, publicOnly: false })).toEqual(['mine', 'j000', 'j001', 'j002']);
  });

  it('the limit is capped at 400 and floored at 1; hidden jobs and the fit-tier view never reach the sample', async () => {
    seed(450);
    const svc = service();
    expect(await svc.sampleForFilters(ctx(), {}, { limit: 5000 })).toHaveLength(400);
    expect(repo.queries.at(-1)!.values.at(-1)).toBe(400);
    expect(await svc.sampleForFilters(ctx(), {}, { limit: 0 })).toHaveLength(1);
    repo.hidden.set('u1:j000', { at: NOW, reason: 'other' });
    expect((await svc.sampleForFilters(ctx(), { fitTier: 'great' }, { limit: 3 }))).toEqual(['j001', 'j002', 'j003']);
  });

  it('applies the feed’s filter predicates and age floor (the same SQL parts as the list)', async () => {
    seed(2);
    repo.rows.push(feedRow({ id: 'old', postedAt: daysAgo(200), firstSeenAt: daysAgo(200) }));
    await service().sampleForFilters(ctx(), { workModels: ['remote'], postedWithinDays: 7 }, { limit: 10 });
    const sql = repo.queries.at(-1)!;
    expect(sql.text).toContain('j."workModel" = ANY(');
    expect(sql.text).toContain('j."fraudFlags" IS NULL');
    expect(sql.text).toContain('j."closedAt" IS NULL');
    expect(await service().sampleForFilters(ctx(), {}, { limit: 10 })).toEqual(['j000', 'j001']); // 120-day floor drops `old`
  });
});

describe('alertCandidates (saved-search alerts)', () => {
  it('selects the same jobs a feed query lists for the same profile and window', async () => {
    seed(12, (i) => ({ postedAt: daysAgo(i + 0.5), firstSeenAt: daysAgo(i + 0.5) }));
    repo.rows.push(feedRow({ id: 'mine', visibility: 'private', ownerUserId: 'u1', sourceBoard: 'user_import', postedAt: daysAgo(1.2), firstSeenAt: daysAgo(1.2) }));
    repo.hidden.set('u1:j002', { at: NOW, reason: 'other' });
    profileFilters = { postedWithinDays: 7 };
    const svc = service();

    const feed = await svc.query(ctx(), { sort: 'newest' });
    const feedPublicIds = feed.items.filter((i) => i.source.kind !== 'user_import').map((i) => i.jobId);
    const cands = await svc.alertCandidates({ market: 'intl', now: NOW }, 'sp1', { since: daysAgo(7), limit: 100 });

    // Same window (7 days), same hidden-state rule; alerts never include the user's own import.
    expect(feedPublicIds).toEqual(['j000', 'j001', 'j003', 'j004', 'j005', 'j006']);
    expect(cands).toEqual({ ids: feedPublicIds, truncated: false });
    expect(cands.ids).not.toContain('mine');
    expect(cands.ids).not.toContain('j002');
  });

  it('builds its SQL from the feed’s own predicates: radius, posted-within and GoApply fields', async () => {
    profileFilters = {
      locations: [{ label: '上海', city: '上海', country: 'CN', lat: 31.23, lng: 121.47, radiusKm: 40 }],
      postedWithinDays: 7,
      classYear: 2027,
      employmentType: ['campus'],
      hukouTag: true,
    };
    await service().alertCandidates({ market: 'cn', now: NOW }, 'sp1', { since: daysAgo(1), limit: 100 });
    const sql = repo.queries.at(-1)!;
    expect(sql.text).toContain('asin(sqrt('); // haversine radius, not an exact-city match
    expect(sql.text).toContain(`'hukou' = ANY(j."employerTags")`);
    expect(sql.values).toContainEqual(['class_year:2027']);
    expect(sql.values).toContainEqual(['cn_hire:campus']);
    expect(sql.text).toContain('j."firstSeenAt" > $');
    expect(sql.text).toContain('ORDER BY j."firstSeenAt" DESC, j."id" DESC');
    expect(sql.text).toContain(`j."visibility" = 'public'`);
    expect(sql.text).not.toContain('j."ownerUserId"');
    expect(sql.text).toContain('j."fraudFlags" IS NULL');
    expect(sql.text).toContain('j."postedAt" >= $'); // posted within 7 days
    // No ranking and no session.
    expect(repo.sessions.size).toBe(0);
    expect(userContextCalls).toBe(0);
  });

  it('only jobs first seen after `since`; `postedSince` also drops old postings but keeps undated ones; `truncated` when more matched', async () => {
    seed(5, (i) => ({ postedAt: daysAgo(i + 1), firstSeenAt: hoursAgo(i + 1) }));
    repo.rows.push(feedRow({ id: 'undated', postedAt: null, firstSeenAt: hoursAgo(0.5) }));
    repo.rows.push(feedRow({ id: 'seen_long_ago', postedAt: daysAgo(1), firstSeenAt: daysAgo(9) }));
    const svc = service();
    const instant = await svc.alertCandidates({ market: 'intl', now: NOW }, 'sp1', { since: daysAgo(1), postedSince: daysAgo(3.5), limit: 100 });
    expect(instant).toEqual({ ids: ['undated', 'j000', 'j001', 'j002'], truncated: false });
    const cut = await svc.alertCandidates({ market: 'intl', now: NOW }, 'sp1', { since: daysAgo(1), limit: 2 });
    expect(cut).toEqual({ ids: ['j000', 'j001'], truncated: true });
  });

  it('a profile that is gone has no candidates; stored filters of the other market are ignored, not an error', async () => {
    seed(2);
    expect(await service().alertCandidates({ market: 'intl', now: NOW }, 'missing', { since: daysAgo(7), limit: 10 })).toEqual({ ids: [], truncated: false });
    profileFilters = { classYear: 2027 } as FilterSet; // a GoApply-only field on a RoboApply profile
    expect((await service().alertCandidates({ market: 'intl', now: NOW }, 'sp1', { since: daysAgo(7), limit: 10 })).ids).toEqual(['j000', 'j001']);
  });
});

describe('publicList (visitor list and the visitor assistant)', () => {
  it('one archived, one private, one non-publicDisplay and one valid job → only the valid one', async () => {
    repo.rows.push(feedRow({ id: 'valid', postedAt: hoursAgo(1) }));
    repo.rows.push(feedRow({ id: 'archived', postedAt: hoursAgo(2) }));
    repo.rows.push(feedRow({ id: 'private', postedAt: hoursAgo(3), visibility: 'private', ownerUserId: 'u1' }));
    repo.rows.push(feedRow({ id: 'no_display', postedAt: hoursAgo(4) }));
    repo.notPublicDisplay.add('no_display');
    // The public-page predicate (seo basePublicWhere, checked in repo.test.ts) refuses an archived row.
    repo.notPublicPage.add('archived');
    const items = await service().publicList({ market: 'intl', now: NOW }, { limit: 20 });
    expect(items.map((i) => i.jobId)).toEqual(['valid']);
    expect(items[0]).not.toHaveProperty('fit');
    expect(items[0]).not.toHaveProperty('cardMeta');
    expect(repo.sessions.size).toBe(0);
  });

  it('a job closed or removed since it was listed can no longer be named', async () => {
    seed(3);
    const svc = service();
    expect((await svc.publicList({ market: 'intl', now: NOW }, { limit: 20 })).map((i) => i.jobId)).toEqual(['j000', 'j001', 'j002']);
    repo.notPublicPage.add('j001');
    expect((await svc.publicList({ market: 'intl', now: NOW }, { limit: 20 })).map((i) => i.jobId)).toEqual(['j000', 'j002']);
  });
});

describe('publicList: the public-page rules are part of the statement, so its LIMIT counts listable rows', () => {
  it('newer rows that are expired, or from a board no longer allowed, do not push valid older rows out of a short list', async () => {
    // Five newest rows fail a rule; three older ones are listable.
    for (let i = 0; i < 3; i++) repo.rows.push(feedRow({ id: `expired${i}`, postedAt: hoursAgo(1 + i), expiresAt: hoursAgo(1) }));
    for (let i = 0; i < 2; i++) repo.rows.push(feedRow({ id: `dropped${i}`, postedAt: hoursAgo(4 + i), sourceBoard: 'jsearch' }));
    repo.rows.push(feedRow({ id: 'bank', postedAt: hoursAgo(10), sourceBoard: 'robohire', fromRecruiterBank: true }));
    repo.rows.push(feedRow({ id: 'open1', postedAt: hoursAgo(11), expiresAt: new Date(NOW.getTime() + 86_400_000) }));
    repo.rows.push(feedRow({ id: 'open2', postedAt: hoursAgo(12) }));
    const items = await service().publicList({ market: 'intl', now: NOW }, { limit: 3 });
    expect(items.map((i) => i.jobId)).toEqual(['bank', 'open1', 'open2']);
    const stmt = repo.queries.at(-1)!;
    expect(stmt.text).toContain('(j."expiresAt" IS NULL OR j."expiresAt" >');
    expect(stmt.text).toContain('(j."fromRecruiterBank" = true OR j."sourceBoard" = ANY(');
    expect(stmt.values).toContainEqual(['activejobs']);
  });

  it('no board allowed (PUBLIC_DISPLAY_PROVIDERS empty) → recruiter-bank rows only', async () => {
    repo.allowedBoards = [];
    repo.rows.push(feedRow({ id: 'search', postedAt: hoursAgo(1) }));
    repo.rows.push(feedRow({ id: 'bank', postedAt: hoursAgo(2), sourceBoard: 'robohire', fromRecruiterBank: true }));
    expect((await service().publicList({ market: 'intl', now: NOW }, { limit: 20 })).map((i) => i.jobId)).toEqual(['bank']);
  });
});

describe('browse: overrides.taxonomyIds with no searchProfileId (Explore → a category)', () => {
  beforeEach(() => {
    seed(4, (i) => ({ taxonomyIds: i < 2 ? ['data_analytics', 'data_analyst_group', 'data_analyst'] : ['software_engineering', 'swe_backend', 'backend_engineer'], primaryTaxonomyId: null }));
    // A posting tagged with the category only (no role under it) still belongs to the tile.
    repo.rows.push(feedRow({ id: 'cat_only', taxonomyIds: ['data_analytics'], primaryTaxonomyId: null, postedAt: hoursAgo(9) }));
    repo.rows.push(feedRow({ id: 'mine', taxonomyIds: ['data_analytics'], visibility: 'private', ownerUserId: 'u1', sourceBoard: 'user_import', postedAt: hoursAgo(0.5) }));
  });

  it('lists the category with the market and visibility rules only: none of the saved filters, public rows, no profile read', async () => {
    // The saved search would exclude everything here (another role, onsite only).
    profileFilters = { taxonomyIds: ['sales'], workModels: ['onsite'], excludedCompanies: ['Co j000'] };
    const res = await service().query(ctx(), { sort: 'newest', overrides: { taxonomyIds: ['data_analytics'] } });
    expect(res.items.map((i) => i.jobId)).toEqual(['j000', 'j001', 'cat_only']);
    expect(profileReads).toBe(0);
    const sql = repo.queries.find((q) => q.text.includes('AND j."taxonomyIds" && '))!;
    expect(sql.text).toContain(`j."visibility" = 'public'`);
    expect(sql.text).not.toContain('j."ownerUserId" = ');
    expect(sql.text).not.toContain('j."workModel" = ANY(');
    expect(sql.text).not.toContain('"companyNameNormalized" <> ALL');
    // The category id itself and every role under it (the rows the Explore tile counts).
    const ids = sql.values.find((v) => Array.isArray(v) && v.includes('data_analytics')) as string[];
    expect(ids).toContain('data_analyst');
  });

  it('pages by cursor inside the browse, stores no profile on the session and does not count as a feed visit', async () => {
    for (let i = 0; i < 25; i++) repo.rows.push(feedRow({ id: `d${String(i).padStart(2, '0')}`, taxonomyIds: ['data_analytics'], postedAt: hoursAgo(20 + i) }));
    const svc = service();
    const body = { sort: 'newest' as const, overrides: { taxonomyIds: ['data_analytics'] } };
    const p1 = await svc.query(ctx(), body);
    expect(p1.items).toHaveLength(20);
    const session = repo.sessions.get(p1.sessionId)!;
    expect(session).toMatchObject({ searchProfileId: null, profileVersion: null });
    expect(repo.visits.has('u1')).toBe(false);
    const p2 = await svc.query(ctx(), { ...body, cursor: p1.cursor! });
    expect(p2.items).toHaveLength(8);
    expect(p2.endOfFeed).toBe(true);
    expect([...p1.items, ...p2.items].map((i) => i.jobId)).not.toContain('mine');
  });

  it('with a searchProfileId the same overrides narrow that profile instead (not a browse)', async () => {
    profileFilters = { workModels: ['onsite'] };
    await service().query(ctx(), { sort: 'newest', searchProfileId: 'sp1', overrides: { taxonomyIds: ['data_analytics'] } });
    expect(profileReads).toBe(1);
    const sql = repo.queries.find((q) => q.text.includes('LIMIT'))!;
    expect(sql.text).toContain('j."workModel" = ANY(');
    expect(sql.text).toContain('j."ownerUserId" = ');
  });

  it('the Explore tile counts use the lists’ age floor, so a tile and its browse list agree', async () => {
    await service().explore({ market: 'intl', now: NOW }, 'en');
    const sql = repo.queries.at(-1)!;
    expect(sql.text).toContain('j."postedAt" >= $');
    expect(sql.values).toContainEqual(daysAgo(120));
  });
});

describe('cardMeta and explanation on FeedItem', () => {
  const deps = { cardMeta, explain: explainMatch };

  it('GoApply: every card carries the cn card meta (source line, pay in the posting’s words, quoted tags)', async () => {
    repo.rows.push(
      feedRow({
        id: 'cn1',
        market: 'cn',
        sourceBoard: 'gohire',
        sourceName: 'GoHire',
        fromRecruiterBank: true,
        employerVerified: true,
        isAgency: false,
        salaryDisclosed: true,
        salaryText: '15-25K·13薪',
        marketTags: [{ tag: 'hukou', evidenceQuote: '可落户上海', evidenceUrl: null }],
        postedAt: hoursAgo(1),
      }),
    );
    const res = await service(deps).query(cnCtx(), { sort: 'newest' });
    expect(res.items[0]!.cardMeta).toMatchObject({
      cn: { sourceLine: { kind: 'direct', sourceName: 'GoHire' }, salary: { text: '15-25K·13薪', disclosed: true }, tags: [{ tag: 'hukou', evidenceQuote: '可落户上海' }] },
    });
  });

  it('Taiwan: the tw card meta reads the page’s extra fields (links, locations, the posting text for a quoted permit tag)', async () => {
    repo.rows.push(
      feedRow({
        id: 'tw1',
        locationCountry: 'TW',
        location: 'Taipei, Taiwan',
        salaryDisclosed: false,
        salaryText: '待遇面議',
        sourceBoard: 'greenhouse',
        sourceName: 'Appier · Greenhouse',
        marketTags: [{ tag: 'tw_work_permit_support', evidenceQuote: '可協助申請工作許可', evidenceUrl: null }],
        postedAt: hoursAgo(1),
      }),
    );
    repo.cardExtras.set('tw1', { sourceUrl: 'https://boards.greenhouse.io/appier/jobs/1', applyUrl: 'https://boards.greenhouse.io/appier/jobs/1#app', descriptionPlain: '我們可協助申請工作許可。' });
    const res = await service(deps).query(ctx(), { sort: 'newest' });
    const meta = res.items[0]!.cardMeta as { ats_public: { country: string; pay: { negotiable: boolean; disclosed: boolean }; source: { url: string | null } } };
    expect(meta.ats_public).toMatchObject({ country: 'TW', pay: { negotiable: true, disclosed: false }, source: { url: 'https://boards.greenhouse.io/appier/jobs/1' } });
    // One extras read for the page, by id.
    expect(repo.queries.filter((q) => q.text.includes('"descriptionPlain"') && q.text.includes('jsonb_array_length')).length).toBe(1);
  });

  it('a card no market hook has lines for carries no cardMeta; an extras outage still renders the cards', async () => {
    seed(2);
    const res = await service(deps).query(ctx(), { sort: 'newest' });
    expect(res.items.every((i) => !('cardMeta' in i))).toBe(true);
    repo.queryCardExtras = async () => {
      throw new Error('db down');
    };
    repo.rows.forEach((r) => (r.market = 'cn'));
    const cn = await service(deps).query(cnCtx(), { sort: 'newest' });
    expect(cn.items).toHaveLength(2);
    expect(cn.items[0]!.cardMeta).toHaveProperty('cn');
  });

  it('personalised: each scored card explains its fit from the scored dimensions, never a hiring chance', async () => {
    seed(2);
    const res = await service(deps).query(ctx(), { sort: 'recommended' });
    const item = res.items[0]!;
    expect(item.fit).not.toBeNull();
    expect(item.explanation).toMatchObject({ mode: 'personalized', headline: { key: 'legal.explain.headline.personalized', params: { tier: item.fit!.tier } } });
    expect(item.explanation!.notices.map((n) => n.key)).toEqual(expect.arrayContaining(['legal.explain.notice.notHiringChance', 'legal.explain.notice.quickEstimate']));
    expect(item.explanation!.reasons.length).toBeGreaterThan(0);
  });

  it('an AI-scored card explains from the stored AI dimensions and is not called a quick estimate', async () => {
    seed(1);
    repo.ai.set('j000', {
      score: 91,
      tier: 'great',
      dimensions: [{ key: 'skills', weight: 30, score: 91, status: 'scored', evidence: [{ text: 'Built payment APIs in Python', source: 'resume' }] }],
    });
    const res = await service(deps).query(ctx(), { sort: 'recommended' });
    const ex = res.items[0]!.explanation!;
    expect(res.items[0]!.fit).toMatchObject({ kind: 'ai', score: 91, tier: 'great' });
    expect(ex.reasons[0]).toEqual({ key: 'legal.explain.reason.skills', params: { evidence: 'Built payment APIs in Python', source: 'resume' } });
    expect(ex.notices.map((n) => n.key)).not.toContain('legal.explain.notice.quickEstimate');
  });

  it('GoApply without 个性化推荐: the explanation says the list is by date and filters, with no reasons', async () => {
    personalized = false;
    seed(2, () => ({ market: 'cn' }));
    const res = await service(deps).query(cnCtx(), { sort: 'recommended' });
    expect(res.items[0]!.fit).toBeNull();
    expect(res.items[0]!.explanation).toMatchObject({ mode: 'non_personalized', reasons: [], gaps: [] });
    expect(res.items[0]!.explanation!.notices.map((n) => n.key)).toContain('legal.explain.notice.turnOn');
  });

  it('the Assistant preview carries the same fields; without the deps the items carry neither', async () => {
    seed(2);
    const withDeps = await service(deps).preview(ctx(), { limit: 2, sort: 'recommended' });
    expect(withDeps[0]!.explanation?.mode).toBe('personalized');
    expect(withDeps[0]!.position).toBeNull();
    const bare = await service().preview(ctx(), { limit: 2, sort: 'recommended' });
    expect(bare[0]).not.toHaveProperty('explanation');
    expect(bare[0]).not.toHaveProperty('cardMeta');
  });
});

describe('GoApply: the seams return postings by default, and answer empty with CN_RECRUITMENT_INFO_MODE=off', () => {
  const off = { postingsAllowed: undefined, env: { ...BANK_PAGES_ENV, CN_RECRUITMENT_INFO_MODE: 'off' } as Record<string, string> };
  const byDefault = { postingsAllowed: undefined, env: { ...BANK_PAGES_ENV } as Record<string, string> };
  const on = { postingsAllowed: undefined, env: { ...BANK_PAGES_ENV, CN_RECRUITMENT_INFO_MODE: 'partner_deeplink' } };

  beforeEach(() => {
    seed(3, () => ({ market: 'cn', sourceBoard: 'gohire', sourceName: 'GoHire', fromRecruiterBank: true }));
    repo.countResponder = () => 3;
  });

  it('counts, limiting filters, preview, sample, alert candidates and the public list return nothing', async () => {
    profileFilters = { workModels: ['onsite'] };
    const svc = service(off);
    expect(await svc.countForFilters(cnCtx(), {})).toEqual({ count: 0, capped: false });
    expect(await svc.limitingFilters(cnCtx(), 'sp1')).toEqual([]);
    expect(await svc.preview(cnCtx(), { limit: 10 })).toEqual([]);
    expect(await svc.sampleForFilters(cnCtx(), {}, { limit: 400 })).toEqual([]);
    expect(await svc.alertCandidates({ market: 'cn', now: NOW }, 'sp1', { since: daysAgo(7), limit: 100 })).toEqual({ ids: [], truncated: false });
    expect(await svc.publicList({ market: 'cn', now: NOW }, { limit: 20 })).toEqual([]);
    // Nothing was even read.
    expect(repo.queries).toHaveLength(0);
  });

  it('default (no CN_RECRUITMENT_INFO_MODE): counts, preview, sample, alert candidates return the public market cn rows (D5)', async () => {
    const svc = service(byDefault);
    expect(await svc.countForFilters(cnCtx(), {})).toEqual({ count: 3, capped: false });
    expect(await svc.sampleForFilters(cnCtx(), {}, { limit: 400 })).toEqual(['j000', 'j001', 'j002']);
    const preview = await svc.preview(cnCtx(), { limit: 10, sort: 'newest' });
    expect(preview.map((i) => i.jobId)).toEqual(['j000', 'j001', 'j002']);
    expect(preview.every((i) => i.source.kind === 'bank')).toBe(true);
    const alerts = await svc.alertCandidates({ market: 'cn', now: NOW }, 'sp1', { since: daysAgo(30), limit: 100 });
    expect(alerts.ids.length).toBe(3);
    expect(repo.queries.length).toBeGreaterThan(0);
  });

  it('the seams follow cn/jobs cnJobCapabilities().postings in every mode (one mode, one resolver)', async () => {
    for (const mode of [undefined, 'off', 'partner_deeplink', 'licensed', 'nonsense']) {
      const env: Record<string, string> = mode ? { CN_RECRUITMENT_INFO_MODE: mode } : {};
      const allowed = cnJobCapabilities(env).postings;
      const res = await service({ postingsAllowed: undefined, env }).countForFilters(cnCtx(), {});
      expect(res, String(mode)).toEqual({ count: allowed ? 3 : 0, capped: false });
    }
  });

  it('control: once the mode allows postings the same seams return them; RoboApply never depends on the mode', async () => {
    const svc = service(on);
    expect(await svc.countForFilters(cnCtx(), {})).toEqual({ count: 3, capped: false });
    expect(await svc.sampleForFilters(cnCtx(), {}, { limit: 400 })).toEqual(['j000', 'j001', 'j002']);
    expect((await svc.preview(cnCtx(), { limit: 10, sort: 'newest' })).map((i) => i.jobId)).toEqual(['j000', 'j001', 'j002']);
    repo.rows.forEach((r) => (r.market = 'intl'));
    expect(await service(off).sampleForFilters(ctx(), {}, { limit: 400 })).toEqual(['j000', 'j001', 'j002']);
  });
});
