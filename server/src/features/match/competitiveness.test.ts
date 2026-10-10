// @vitest-environment node
// WP-77 — "You and what employers ask": per-post requirement checks (a
// requirement the post does not state is never a miss; an unknown on your
// side is never a miss), the sample rule (n < 20 suppresses every
// comparative number), "asked for in X of Y posts", Broaden options from
// real removal counts (never the role itself or an eligibility answer), the
// plan view, the credit (once per report; reused free the same day; nothing
// for a suppressed sample), and the stored report's staleness.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { getBrand } from '../../platform/brand/registry.js';
import { CreditsExhaustedError } from '../../platform/credits/errors.js';
import { MIN_SAMPLE } from '../../platform/http.js';
import {
  BROADEN_EXCLUDED_FIELDS,
  askedSkills,
  broadenOptions,
  buildReportBody,
  evaluatePost,
  median,
  parseStoredReport,
  reportInputHash,
  toReportView,
  type ReportPost,
} from './competitiveness.js';
import { createCompetitivenessService } from './CompetitivenessService.js';
import { toMatchJob } from './context.js';
import { sampleFilters } from './reportInventory.js';
import { createMemoryFitReportStore } from './reportStore.js';
import { defaultProviderFor } from './scorerRoute.js';
import { createMemoryReportInventory, jobRecord, matchUser, reportJobs, searchProfileWire } from './testkit.js';
import type { MatchJobRecord } from './context.js';
import type { CompetitivenessReport } from './contract.js';

const NOW = new Date('2026-10-10T09:00:00.000Z');

function post(overrides: Partial<MatchJobRecord> = {}): ReportPost {
  const r = jobRecord(overrides);
  return { ...toMatchJob(r), minYears: r.minYears };
}

describe('evaluatePost', () => {
  const user = matchUser({ highestDegree: 'bachelor', yearsExperience: 6, skills: ['TypeScript', 'Go'], resumeTextNorm: null });

  it('meets, misses and "not stated" per requirement; overall needs every stated one', () => {
    const met = evaluatePost(user, post({ educationLevel: 'bachelor', minYears: 5, skillsDetail: [{ skill: 'TypeScript', required: true }] }));
    expect(met).toMatchObject({ degree: 'met', years: 'met', skills: 'met', overall: 'met' });

    const missed = evaluatePost(user, post({ educationLevel: 'master', minYears: 5, skillsDetail: [{ skill: 'TypeScript', required: true }] }));
    expect(missed).toMatchObject({ degree: 'not_met', overall: 'not_met' });

    const skillMiss = post({ educationLevel: null, minYears: null, skillsDetail: [{ skill: 'Kubernetes', required: true }, { skill: 'Go', required: false }] });
    expect(evaluatePost(user, skillMiss)).toMatchObject({ degree: 'not_stated', years: 'not_stated', skills: 'not_met', overall: 'not_met' });

    const nothing = evaluatePost(user, post({ educationLevel: 'none', minYears: 0, skillsDetail: [{ skill: 'Kubernetes', required: false }] }));
    expect(nothing).toMatchObject({ degree: 'not_stated', years: 'not_stated', skills: 'not_stated', overall: 'not_stated' });
  });

  it('an unknown on your side is "unknown", never a miss', () => {
    const blank = matchUser({ highestDegree: null, yearsExperience: null, skills: [], resumeTextNorm: null });
    const e = evaluatePost(blank, post({ educationLevel: 'bachelor', minYears: 3, skillsDetail: [{ skill: 'Go', required: true }] }));
    expect(e).toMatchObject({ degree: 'unknown', years: 'unknown', skills: 'unknown', overall: 'unknown' });
    // A stated miss still wins over an unknown elsewhere.
    const half = matchUser({ highestDegree: 'associate', yearsExperience: null, skills: [] });
    expect(evaluatePost(half, post({ educationLevel: 'bachelor', minYears: 3 })).overall).toBe('not_met');
  });

  it('a skill counts as shown from the resume text too (the keyword-check rule)', () => {
    const u = matchUser({ skills: [], resumeTextNorm: 'built services on kubernetes and go' });
    expect(evaluatePost(u, post({ skillsDetail: [{ skill: 'Kubernetes', required: true }] })).skills).toBe('met');
  });

  it('asked skills: the required ones, else every listed skill (feed skills-check rule)', () => {
    expect(askedSkills(post({ skillsDetail: [{ skill: 'Go', required: true }, { skill: 'SQL', required: false }] }))).toEqual(['Go']);
    expect(askedSkills(post({ skills: ['python', 'sql'], skillsDetail: null }))).toEqual(['python', 'sql']);
  });

  it('median', () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

function samplePosts(n: number, make: (i: number) => Partial<MatchJobRecord>): ReportPost[] {
  return reportJobs(n, make).map((r) => ({ ...toMatchJob(r), minYears: r.minYears }));
}

const PROFILE = { id: 'sp1', name: 'Backend in Berlin', version: 3 };

describe('buildReportBody', () => {
  const user = matchUser({ highestDegree: 'bachelor', yearsExperience: 4, skills: ['TypeScript', 'Go'], resumeTextNorm: null });

  it('suppresses every comparative number below 20 posts, but still offers Broaden options', () => {
    const body = buildReportBody({
      user,
      posts: samplePosts(MIN_SAMPLE - 1, () => ({ educationLevel: 'bachelor' })),
      profile: PROFILE,
      total: { count: 19, capped: false },
      limiting: [{ field: 'workModels', value: ['onsite'], removalGain: 41 }],
      now: NOW,
    });
    expect(body.suppressed).toBe('too_few_posts');
    expect(body.meetsRequirements).toBeNull();
    expect(body.requirements).toEqual([]);
    expect(body.topSkills).toEqual([]);
    expect(body.broaden).toHaveLength(1);
    expect(body.total).toMatchObject({ value: 19, source: 'index', method: 'search_count' });
  });

  it('shares carry { value, met, sampleSize, source, asOf, method }; not-stated posts are left out of the share', () => {
    // 30 posts: 0–9 ask a master (miss), 10–24 a bachelor (met), 25–29 state nothing.
    const posts = samplePosts(30, (i) => ({
      educationLevel: i < 10 ? 'master' : i < 25 ? 'bachelor' : null,
      minYears: i < 25 ? (i % 2 ? 3 : 5) : null,
      skillsDetail: i < 25 ? [{ skill: 'TypeScript', required: true }] : [{ skill: 'Rust', required: false }],
      skills: i < 25 ? ['typescript'] : ['rust'],
    }));
    const body = buildReportBody({ user, posts, profile: PROFILE, total: { count: 240, capped: false }, limiting: [], now: NOW });
    expect(body.suppressed).toBeNull();
    expect(body.sample).toEqual({ size: 30, maxSize: 50, method: 'newest_posts_sample' });
    expect(body.overall).toEqual({ checked: 25, notStated: 5, unknown: 0 });
    // Met overall: bachelor posts (15) whose years ≤ 4: odd i in 10..24 → 7.
    expect(body.meetsRequirements).toEqual({ value: 0.28, met: 7, sampleSize: 25, source: 'index', asOf: NOW.toISOString(), method: 'newest_posts_sample' });

    const degree = body.requirements.find((r) => r.key === 'degree')!;
    expect(degree).toMatchObject({ stated: 25, youKnown: true, yours: 'bachelor', share: { met: 15, sampleSize: 25, value: 0.6 } });
    expect(degree.typical).toMatchObject({ value: 'bachelor', count: 15, sampleSize: 25, source: 'index' });

    const years = body.requirements.find((r) => r.key === 'years')!;
    expect(years.share).toMatchObject({ met: 12, sampleSize: 25 });
    expect(years.typical).toMatchObject({ value: 5, sampleSize: 25 });

    const skills = body.requirements.find((r) => r.key === 'skills')!;
    expect(skills).toMatchObject({ stated: 25, yours: 2, share: { met: 25, sampleSize: 25, value: 1 } });
    expect(skills.typical).toBeNull();
  });

  it('a requirement stated by fewer than 20 posts has no share and no typical value', () => {
    const posts = samplePosts(25, (i) => ({ educationLevel: i < 5 ? 'master' : null, minYears: null, skillsDetail: null, skills: [] }));
    const body = buildReportBody({ user, posts, profile: PROFILE, total: null, limiting: [], now: NOW });
    const degree = body.requirements.find((r) => r.key === 'degree')!;
    expect(degree.stated).toBe(5);
    expect(degree.share).toBeNull();
    expect(degree.typical).toBeNull();
    expect(body.meetsRequirements).toBeNull();
    expect(body.total).toBeNull();
  });

  it('your side unknown: no share, `youKnown: false`, and those posts are counted as not checked', () => {
    const blank = matchUser({ highestDegree: null, yearsExperience: null, skills: [], resumeTextNorm: null });
    const posts = samplePosts(22, () => ({ educationLevel: 'bachelor', minYears: 2 }));
    const body = buildReportBody({ user: blank, posts, profile: PROFILE, total: null, limiting: [], now: NOW });
    expect(body.requirements.every((r) => r.youKnown === false && r.share === null)).toBe(true);
    expect(body.overall).toEqual({ checked: 0, notStated: 0, unknown: 22 });
  });

  it('most requested skills: "asked for in X of Y posts", at least 2 posts, most asked first, with youHave', () => {
    const posts = samplePosts(20, (i) => ({
      skillsDetail: [
        { skill: 'TypeScript', required: true },
        ...(i < 12 ? [{ skill: 'Kubernetes', required: true }] : []),
        ...(i === 0 ? [{ skill: 'COBOL', required: true }] : []),
      ],
    }));
    const body = buildReportBody({ user, posts, profile: PROFILE, total: null, limiting: [], now: NOW });
    expect(body.topSkills.map((s) => [s.skill, s.askedIn.value, s.askedIn.sampleSize, s.youHave])).toEqual([
      ['TypeScript', 20, 20, true],
      ['Kubernetes', 12, 20, false],
    ]);
    expect(body.topSkills[0]!.askedIn).toMatchObject({ source: 'index', method: 'newest_posts_sample', asOf: NOW.toISOString() });
  });

  it('never words anything as a comparison with other applicants', () => {
    const body = buildReportBody({ user, posts: samplePosts(20, () => ({})), profile: PROFILE, total: null, limiting: [], now: NOW });
    expect(JSON.stringify(body)).not.toMatch(/applicant|percentile|outperform|rank/i);
  });
});

describe('broadenOptions', () => {
  it('real removal counts, biggest first, a one-field patch; never the role, an eligibility answer or a block list', () => {
    const out = broadenOptions(
      [
        { field: 'taxonomyIds', value: ['backend_engineer'], removalGain: 4000 },
        { field: 'country', value: 'DE', removalGain: 3000 },
        { field: 'needsSponsorship', value: true, removalGain: 90 },
        { field: 'excludedCompanies', value: ['Acme'], removalGain: 5 },
        { field: 'postedWithinDays', value: 7, removalGain: 120 },
        { field: 'workModels', value: ['onsite'], removalGain: 5000 },
        { field: 'salaryMin', value: { amount: 1 }, removalGain: 0 },
        { field: 'excludeAgencies', value: true, removalGain: 300 },
        { field: 'degree', value: ['本科'], removalGain: 200 },
        { field: 'hukouTag', value: true, removalGain: 150 },
      ],
      NOW.toISOString(),
      5000,
      { count: 0, capped: false },
    );
    expect(out.map((o) => o.field)).toEqual(['workModels', 'postedWithinDays']);
    expect(out[0]).toEqual({
      field: 'workModels',
      value: ['onsite'],
      patch: { workModels: null },
      extraJobs: { value: 5000, source: 'index', asOf: NOW.toISOString(), method: 'filter_removal_count' },
      capped: true,
    });
    for (const f of ['taxonomyIds', 'titles', 'q', 'country', 'schoolTiers', 'classYear', 'excludeRequirements', 'excludeAgencies', 'degree', 'hukouTag']) {
      expect(BROADEN_EXCLUDED_FIELDS.has(f)).toBe(true);
    }
  });

  it('a gain is "+N or more" when search + gain reaches the cap, the search is capped, or its count is unknown', () => {
    const one = [{ field: 'postedWithinDays', value: 7, removalGain: 100 }];
    const at = NOW.toISOString();
    // base 4,900 + gain 100 = 5,000: the relaxed count hit the cap, the real gain may be 3,100.
    expect(broadenOptions(one, at, 5000, { count: 4900, capped: false })[0]).toMatchObject({ extraJobs: { value: 100 }, capped: true });
    expect(broadenOptions(one, at, 5000, { count: 4899, capped: false })[0]!.capped).toBe(false);
    expect(broadenOptions(one, at, 5000, { count: 240, capped: false })[0]!.capped).toBe(false);
    expect(broadenOptions(one, at, 5000, { count: 5000, capped: true })[0]!.capped).toBe(true);
    expect(broadenOptions(one, at, 5000, null)[0]!.capped).toBe(true);
    expect(broadenOptions(one, at, 5000, { count: null, capped: false })[0]!.capped).toBe(true);
  });

  it('buildReportBody passes the search count through (base 4,900, gain 100 → capped)', () => {
    const body = buildReportBody({
      user: matchUser(),
      posts: [],
      profile: PROFILE,
      total: { count: 4900, capped: false },
      limiting: [{ field: 'postedWithinDays', value: 7, removalGain: 100 }],
      now: NOW,
    });
    expect(body.broaden[0]).toMatchObject({ field: 'postedWithinDays', capped: true });
  });

  it('keeps at most the limit', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ field: `f${i}`, value: i, removalGain: 100 - i }));
    expect(broadenOptions(many, NOW.toISOString(), 5000, { count: 10, capped: false })).toHaveLength(8);
    expect(broadenOptions(many, NOW.toISOString(), 5000, { count: 10, capped: false }, 3)).toHaveLength(3);
  });
});

describe('view, hash and stored rows', () => {
  const user = matchUser({ resumeTextNorm: 'go and typescript' });
  const body = buildReportBody({
    user,
    posts: samplePosts(20, (i) => ({ skillsDetail: Array.from({ length: 8 }, (_, k) => ({ skill: `S${k}`, required: k <= i % 8 || k < 7 })) })),
    profile: PROFILE,
    total: { count: 20, capped: false },
    limiting: Array.from({ length: 6 }, (_, i) => ({ field: `f${i}`, value: i, removalGain: 10 + i })),
    now: NOW,
  });

  it('free view: first 5 skills and 3 options, with how many are hidden; Pro: everything', () => {
    const free = toReportView({ id: 'r1', createdAt: NOW, body }, { full: false, upgradable: true, charged: true, stale: false });
    expect(free.topSkills).toHaveLength(5);
    expect(free.hiddenSkills).toBe(body.topSkills.length - 5);
    expect(free.broaden).toHaveLength(3);
    expect(free.hiddenBroaden).toBe(3);
    expect(free.upgradable).toBe(true);
    const pro = toReportView({ id: 'r1', createdAt: NOW, body }, { full: true, upgradable: true, charged: false, stale: true });
    expect(pro.topSkills).toHaveLength(body.topSkills.length);
    expect(pro).toMatchObject({ hiddenSkills: 0, hiddenBroaden: 0, upgradable: false, stale: true, full: true, id: 'r1', createdAt: NOW.toISOString() });
  });

  it('input hash: stable for the same inputs and day; changes with the search version, your skills or the day', () => {
    const profile = { id: 'sp1', version: 3, filters: { workModels: ['onsite'] } };
    const h = reportInputHash({ profile, user, now: NOW });
    expect(reportInputHash({ profile, user: { ...user, skills: [...user.skills].reverse() }, now: new Date('2026-10-10T23:00:00Z') })).toBe(h);
    expect(reportInputHash({ profile: { ...profile, version: 4 }, user, now: NOW })).not.toBe(h);
    expect(reportInputHash({ profile, user: { ...user, skills: [...user.skills, 'Rust'] }, now: NOW })).not.toBe(h);
    expect(reportInputHash({ profile, user, now: new Date('2026-10-11T01:00:00Z') })).not.toBe(h);
  });

  it('parseStoredReport reads its own body and refuses anything else', () => {
    expect(parseStoredReport(JSON.parse(JSON.stringify(body)))).not.toBeNull();
    expect(parseStoredReport({ schemaVersion: 2 })).toBeNull();
    expect(parseStoredReport(null)).toBeNull();
  });
});

describe('report inventory helpers', () => {
  it('the sample never applies the fit-tier view (a view filter would bias it toward good fits)', () => {
    expect(sampleFilters({ fitTier: 'great', workModels: ['remote'] })).toEqual({ workModels: ['remote'] });
    expect(sampleFilters({})).toEqual({});
  });
});

// ── Service ───────────────────────────────────────────────────────────────

function setup(opts: { posts?: number; jobs?: MatchJobRecord[]; exhausted?: boolean; full?: boolean } = {}) {
  const jobs = opts.jobs ?? reportJobs(opts.posts ?? 24, (i) => ({ educationLevel: 'bachelor', minYears: i % 2 ? 2 : 8, skillsDetail: [{ skill: 'TypeScript', required: true }] }));
  const inventory = createMemoryReportInventory({
    samples: { sp1: jobs.map((j) => j.id) },
    limiting: [{ field: 'workModels', value: ['onsite'], removalGain: 57 }],
  });
  const store = createMemoryFitReportStore(() => clock);
  const credit = vi.fn(async <T,>(_opts: unknown, fn: (r: { id: string }) => Promise<T>): Promise<T> => {
    if (opts.exhausted) throw new CreditsExhaustedError({ bucket: 'competitiveness', resetsAt: new Date('2026-10-17T00:00:00Z'), upgradable: true, cap: 1, window: 'week' });
    return fn({ id: 'ledger_1' });
  });
  let clock = NOW;
  const service = createCompetitivenessService({
    inventory,
    store,
    userContext: async () => matchUser({ highestDegree: 'bachelor', yearsExperience: 5, skills: ['TypeScript'], resumeTextNorm: null }),
    getJobs: async (ids) => jobs.filter((j) => ids.includes(j.id)),
    withCredit: credit as never,
    entitlements: async () => ({ full: !!opts.full, upgradable: true }),
    brand: () => getBrand('roboapply'),
    now: () => clock,
  });
  return { service, inventory, store, credit, setClock: (d: Date) => (clock = d) };
}

describe('CompetitivenessService', () => {
  it('creates a report, spends one credit with the client idempotency key, and stores it', async () => {
    const { service, credit, store } = setup();
    const r = await service.create('u1', 'sp1', 'key-0001-abcd');
    expect(r).toMatchObject({ searchProfileId: 'sp1', searchProfileVersion: 3, charged: true, stale: false, full: false, suppressed: null });
    expect(r.meetsRequirements).toMatchObject({ met: 12, sampleSize: 24 });
    expect(r.broaden[0]).toMatchObject({ field: 'workModels', extraJobs: { value: 57 } });
    expect(credit).toHaveBeenCalledTimes(1);
    expect(credit.mock.calls[0]![0]).toMatchObject({ userId: 'u1', bucket: 'competitiveness', idempotencyKey: 'key-0001-abcd', refId: 'sp1', brand: 'roboapply' });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ kind: 'competitiveness', creditLedgerId: 'ledger_1' });
  });

  it('reuses an identical report from the same day without charging again', async () => {
    const { service, credit, inventory, setClock } = setup();
    const first = await service.create('u1', 'sp1', 'key-0001-abcd');
    setClock(new Date('2026-10-10T15:00:00.000Z'));
    const again = await service.create('u1', 'sp1', 'key-0002-abcd');
    expect(first.reused).toBe(false);
    expect(again).toMatchObject({ id: first.id, charged: false, reused: true });
    expect(credit).toHaveBeenCalledTimes(1);
    expect(inventory.state.calls.sample).toBe(1);
  });

  it('a sample under 20 posts is saved without charging and only offers Broaden options', async () => {
    const { service, credit } = setup({ posts: 12 });
    const r = await service.create('u1', 'sp1', 'key-0001-abcd');
    expect(r).toMatchObject({ suppressed: 'too_few_posts', charged: false, reused: false, meetsRequirements: null, topSkills: [] });
    expect(r.broaden).toHaveLength(1);
    expect(credit).not.toHaveBeenCalled();
  });

  it('out of credits: the 402 error propagates and nothing is stored', async () => {
    const { service, store } = setup({ exhausted: true });
    await expect(service.create('u1', 'sp1', 'key-0001-abcd')).rejects.toBeInstanceOf(CreditsExhaustedError);
    expect(store.rows).toHaveLength(0);
  });

  it('an unknown saved search is 404', async () => {
    const { service } = setup();
    await expect(service.create('u1', 'nope', 'key-0001-abcd')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('D3 aggregate scope: the sample counts only public posts of this brand (never the user\'s own imports, other markets or archived)', async () => {
    const jobs = [
      ...reportJobs(20, () => ({})),
      jobRecord({ id: 'cn1', market: 'cn' }),
      jobRecord({ id: 'priv', visibility: 'private', ownerUserId: 'someone_else' }),
      jobRecord({ id: 'mine', visibility: 'private', ownerUserId: 'u1' }),
      jobRecord({ id: 'old', archivedAt: new Date('2026-09-01') }),
    ];
    const { service } = setup({ jobs });
    const r = await service.create('u1', 'sp1', 'key-0001-abcd');
    // 'mine' is the user's own private import: listed by the feed, never counted.
    expect(r.sample.size).toBe(20);
  });

  it('a failed count or removal count degrades to "—" / no options instead of failing', async () => {
    const { service, inventory } = setup();
    inventory.state.fail = { count: true, limiting: true };
    const r = await service.create('u1', 'sp1', 'key-0001-abcd');
    expect(r.total).toBeNull();
    expect(r.broaden).toEqual([]);
  });

  it('latest: null before any report; stale after the search changes or is deleted; filtered by search', async () => {
    const { service, inventory } = setup();
    expect(await service.latest('u1')).toBeNull();
    await service.create('u1', 'sp1', 'key-0001-abcd');
    expect(await service.latest('u1')).toMatchObject({ searchProfileId: 'sp1', stale: false, charged: false, reused: false });
    expect(await service.latest('u1', 'sp2')).toBeNull();
    inventory.state.profiles = [searchProfileWire({ version: 4 })];
    expect((await service.latest('u1', 'sp1'))!.stale).toBe(true);
    inventory.state.profiles = [];
    expect((await service.latest('u1'))!.stale).toBe(true);
    expect(await service.latest('u2')).toBeNull();
  });

  it('Pro sees every skill and option; the free view says how many more exist', async () => {
    const jobs = reportJobs(20, () => ({ skillsDetail: Array.from({ length: 9 }, (_, k) => ({ skill: `Skill${k}`, required: true })) }));
    const free: CompetitivenessReport = await setup({ jobs }).service.create('u1', 'sp1', 'key-0001-abcd');
    expect(free.topSkills).toHaveLength(5);
    expect(free.hiddenSkills).toBe(4);
    const pro = await setup({ jobs, full: true }).service.create('u1', 'sp1', 'key-0001-abcd');
    expect(pro.topSkills).toHaveLength(9);
    expect(pro.hiddenSkills).toBe(0);
  });
});

// ── Carry-over (Wave 2 → WP-77): GoApply bare scorer model ids ─────────────

describe('defaultProviderFor', () => {
  it('GoApply reads only CN_LLM_PROVIDER (no fallback to the global provider)', async () => {
    const goapply = getBrand('goapply');
    expect(await defaultProviderFor(goapply, { CN_LLM_PROVIDER: ' DeepSeek ', LLM_PROVIDER: 'openrouter' })).toBe('deepseek');
    expect(await defaultProviderFor(goapply, { LLM_PROVIDER: 'openrouter' })).toBeNull();
  });
});

