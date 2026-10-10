// @vitest-environment node
//
// The legacy job scope after the /v2 job routes were deleted (INT-13; wave5
// WP-93 #44 and #46). `GET /v2/jobs/:id` and `POST /v2/search/run` are gone
// (index.unmounted.test.ts keeps them at 404), so this file now covers the
// readers that are left:
//   - `legacyJobVisible` itself (market, own import, seed rows, R-14 mode);
//   - `loadLegacyVisibleJob` (RAResumeService / RAResumeAIService);
//   - the weekly summary (`RAInsightService.refresh`): with
//     CN_RECRUITMENT_INFO_MODE=off a GoApply summary names no third-party
//     posting — neither from the job row nor from the entry's stored snapshot;
//   - the stored summary (`RAInsightService.getWeekly`): a summary written
//     while postings were allowed is not shown once the mode is off.
// No network, no database (fake Prisma; the model call is a stub).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakePrisma } from '../../../test/fakePrisma.js';

const fake = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('../../../lib/prisma.js', () => ({
  get default() {
    return fake.db;
  },
}));
vi.mock('../../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../lib/matchBilling.js', () => ({ writeDeductionLog: vi.fn(async () => undefined) }));
vi.mock('../../../lib/deductionCost.js', () => ({ costPatchFromTally: () => ({ platformCostUsd: 0, metadata: {} }) }));

import { runWithBrand } from '../../../lib/requestContext.js';
import { LEGACY_JOB_SCOPE_SELECT, legacyJobVisible, loadLegacyVisibleJob } from '../lib/legacyJobScope.js';
import { createInsightService } from '../services/RAInsightService.js';
import type { RACareerInsightInput } from '../agents/RACareerInsightAgent.js';

const job = (over: Record<string, unknown>) => ({
  title: 'Product manager',
  companyName: 'Example Co',
  description: 'Plan the product.',
  archivedAt: null,
  isCanonical: true,
  ...over,
});

const ROWS = [
  job({ id: 'cn_gohire', title: 'GoHire PM', companyName: 'Bank Employer', market: 'cn', visibility: 'public', ownerUserId: null, sourceBoard: 'gohire', provider: 'gohire' }),
  job({ id: 'cn_own', title: 'My import', companyName: 'Imported Co', market: 'cn', visibility: 'private', ownerUserId: 'u1', sourceBoard: 'user_import', provider: 'user_import' }),
  job({ id: 'cn_other', title: 'Their import', companyName: 'Other Co', market: 'cn', visibility: 'private', ownerUserId: 'u2', sourceBoard: 'user_import', provider: 'user_import' }),
  job({ id: 'intl_public', title: 'Intl PM', companyName: 'Intl Co', market: 'intl', visibility: 'public', ownerUserId: null, sourceBoard: 'greenhouse', provider: 'greenhouse' }),
  job({ id: 'intl_other', title: 'Intl private', companyName: 'Private Co', market: 'intl', visibility: 'private', ownerUserId: 'u2', sourceBoard: 'user_import', provider: 'user_import' }),
  job({ id: 'intl_seed', title: 'Seed', companyName: 'Demo Co', market: 'intl', visibility: 'public', ownerUserId: null, sourceBoard: 'seed', provider: 'seed' }),
];
const byId = (id: string) => ROWS.find((r) => r.id === id)!;

const OFF = { CN_RECRUITMENT_INFO_MODE: 'off' };
const ON = { CN_RECRUITMENT_INFO_MODE: 'partner_deeplink' };

describe('legacyJobVisible', () => {
  it('GoApply, mode off: no third-party posting; the own import is readable', () => {
    expect(legacyJobVisible(byId('cn_gohire'), 'u1', { market: 'cn', env: OFF })).toBe(false);
    expect(legacyJobVisible(byId('cn_own'), 'u1', { market: 'cn', env: OFF })).toBe(true);
    // Unset means off (R-14 default).
    expect(legacyJobVisible(byId('cn_gohire'), 'u1', { market: 'cn', env: {} })).toBe(false);
    // Control: once the mode allows postings the same row is readable (the check is not vacuous).
    expect(legacyJobVisible(byId('cn_gohire'), 'u1', { market: 'cn', env: ON })).toBe(true);
  });

  it("another user's private import, another market's job, a seed row and a missing row are refused", () => {
    expect(legacyJobVisible(byId('cn_other'), 'u1', { market: 'cn', env: ON })).toBe(false);
    expect(legacyJobVisible(byId('intl_other'), 'u1', { market: 'intl', env: {} })).toBe(false);
    expect(legacyJobVisible(byId('cn_own'), 'u1', { market: 'intl', env: {} })).toBe(false);
    expect(legacyJobVisible(byId('intl_public'), 'u1', { market: 'cn', env: ON })).toBe(false);
    expect(legacyJobVisible(byId('intl_seed'), 'u1', { market: 'intl', env: {} })).toBe(false);
    expect(legacyJobVisible(null, 'u1', { market: 'intl', env: {} })).toBe(false);
    expect(legacyJobVisible(byId('intl_public'), 'u1', { market: 'intl', env: {} })).toBe(true);
  });

  it('the scope select names every column the check reads', () => {
    // FIX-4: no `provider` — RAJob has no such column, and selecting it made every resume list answer 500
    // (the select is now checked against Prisma.RAJobSelect in legacyJobScope.ts).
    expect(Object.keys(LEGACY_JOB_SCOPE_SELECT).sort()).toEqual(['market', 'ownerUserId', 'sourceBoard', 'visibility']);
  });
});

describe('loadLegacyVisibleJob (resume services)', () => {
  let prevMode: string | undefined;
  beforeEach(() => {
    prevMode = process.env.CN_RECRUITMENT_INFO_MODE;
    delete process.env.CN_RECRUITMENT_INFO_MODE;
    fake.db = createFakePrisma({ seed: { rAJob: ROWS } });
  });
  afterEach(() => {
    if (prevMode === undefined) delete process.env.CN_RECRUITMENT_INFO_MODE;
    else process.env.CN_RECRUITMENT_INFO_MODE = prevMode;
  });

  it('answers a refused row exactly like a missing one', async () => {
    await runWithBrand('goapply', async () => {
      expect(await loadLegacyVisibleJob('u1', 'cn_gohire')).toBeNull();
      expect(await loadLegacyVisibleJob('u1', 'cn_other')).toBeNull();
      expect(await loadLegacyVisibleJob('u1', 'nope')).toBeNull();
      expect((await loadLegacyVisibleJob('u1', 'cn_own'))?.id).toBe('cn_own');
    });
    await runWithBrand('roboapply', async () => {
      expect((await loadLegacyVisibleJob('u1', 'intl_public'))?.id).toBe('intl_public');
      expect(await loadLegacyVisibleJob('u1', 'cn_own')).toBeNull();
    });
  });
});

describe('weekly summary (RAInsightService.refresh) names only jobs the viewer may read', () => {
  const NOW = new Date('2026-10-10T12:00:00.000Z');
  const entry = (id: string, jobId: string | null, externalSnapshot: unknown = null) => ({
    id,
    userId: 'u1',
    jobId,
    status: 'applied',
    excitementStars: 0,
    dateSaved: new Date('2026-10-05T00:00:00Z'),
    dateApplied: new Date('2026-10-06T00:00:00Z'),
    notesMarkdown: null,
    externalSnapshot,
    deletedAt: null,
    updatedAt: new Date('2026-10-06T00:00:00Z'),
  });

  let prevMode: string | undefined;
  let seen: RACareerInsightInput | null = null;
  const runAgent = vi.fn(async (input: RACareerInsightInput) => {
    seen = input;
    return { headline: 'This week', bodyMarkdown: 'You applied [[tracker:t_own]].', citedTrackerIds: ['t_own'], recommendations: [], model: 'test/model' };
  });

  function service(db: unknown) {
    return createInsightService({
      getDb: async () => db as never,
      tracker: { weeklyFacts: async () => ({ weekStart: '2026-10-04', weekEnd: '2026-10-10', applied: 4, interviews: 0, offers: 0, ended: 0, noReply10d: 0 }) },
      aiAllowed: async () => true,
      aiTextEnabled: () => true,
      runAgent: runAgent as never,
      now: () => NOW,
    });
  }

  function seed() {
    return createFakePrisma({
      seed: {
        rAJob: ROWS,
        rATrackerEntry: [
          // A GoHire posting tracked while the mode allowed postings; its snapshot is a copy of the posting.
          entry('t_gohire', 'cn_gohire', { title: 'GoHire PM', companyName: 'Bank Employer' }),
          entry('t_own', 'cn_own'),
          // Typed by the user, no job row behind it.
          entry('t_manual', null, { title: 'Analyst', companyName: 'Typed Co' }),
          // The job row no longer exists: the user's own snapshot is all that is left.
          entry('t_gone', 'deleted_job', { title: 'Old role', companyName: 'Gone Co' }),
        ],
        rAResumeVariant: [],
      },
    });
  }

  beforeEach(() => {
    prevMode = process.env.CN_RECRUITMENT_INFO_MODE;
    delete process.env.CN_RECRUITMENT_INFO_MODE;
    seen = null;
    runAgent.mockClear();
  });
  afterEach(() => {
    if (prevMode === undefined) delete process.env.CN_RECRUITMENT_INFO_MODE;
    else process.env.CN_RECRUITMENT_INFO_MODE = prevMode;
  });

  const named = () =>
    Object.fromEntries((seen?.trackerEntriesLast4Weeks ?? []).map((t) => [t.id, { job: t.job, externalSnapshot: t.externalSnapshot }]));

  it('GoApply, mode off: the prompt names no third-party posting', async () => {
    await runWithBrand('goapply', () => service(seed()).refresh('u1', 'zh'));
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(named()).toEqual({
      t_gohire: { job: null, externalSnapshot: null },
      t_own: { job: { title: 'My import', companyName: 'Imported Co' }, externalSnapshot: null },
      t_manual: { job: null, externalSnapshot: { title: 'Analyst', companyName: 'Typed Co' } },
      t_gone: { job: null, externalSnapshot: { title: 'Old role', companyName: 'Gone Co' } },
    });
    const prompt = JSON.stringify(seen);
    expect(prompt).not.toContain('GoHire PM');
    expect(prompt).not.toContain('Bank Employer');
  });

  it('GoApply, postings allowed: the same entry is named (the check is not vacuous)', async () => {
    process.env.CN_RECRUITMENT_INFO_MODE = 'partner_deeplink';
    await runWithBrand('goapply', () => service(seed()).refresh('u1', 'zh'));
    expect(named().t_gohire).toEqual({ job: { title: 'GoHire PM', companyName: 'Bank Employer' }, externalSnapshot: { title: 'GoHire PM', companyName: 'Bank Employer' } });
  });

  it("RoboApply: another market's job and another user's import are not named", async () => {
    const db = createFakePrisma({
      seed: {
        rAJob: ROWS,
        rATrackerEntry: [entry('t_pub', 'intl_public'), entry('t_cn', 'cn_gohire', { title: 'GoHire PM', companyName: 'Bank Employer' }), entry('t_priv', 'intl_other')],
        rAResumeVariant: [],
      },
    });
    await runWithBrand('roboapply', () => service(db).refresh('u1', 'en'));
    expect(named()).toEqual({
      t_pub: { job: { title: 'Intl PM', companyName: 'Intl Co' }, externalSnapshot: null },
      t_cn: { job: null, externalSnapshot: null },
      t_priv: { job: null, externalSnapshot: null },
    });
  });
});

describe('stored weekly summary (RAInsightService.getWeekly) is re-checked on every read', () => {
  const NOW = new Date('2026-10-10T12:00:00.000Z');
  const WEEK = new Date('2026-10-04T00:00:00.000Z');
  const FACTS = { weekStart: '2026-10-04', weekEnd: '2026-10-10', applied: 4, interviews: 0, offers: 0, ended: 0, noReply10d: 0 };
  const entry = (id: string, jobId: string | null) => ({
    id,
    userId: 'u1',
    jobId,
    status: 'applied',
    excitementStars: 0,
    dateSaved: new Date('2026-10-05T00:00:00Z'),
    dateApplied: new Date('2026-10-06T00:00:00Z'),
    notesMarkdown: null,
    externalSnapshot: null,
    deletedAt: null,
    updatedAt: new Date('2026-10-06T00:00:00Z'),
  });
  const runAgent = vi.fn(async () => ({ headline: 'This week', bodyMarkdown: 'You applied to GoHire PM at Bank Employer.', citedTrackerIds: [], recommendations: [], model: 'test/model' }));

  function service(db: unknown) {
    return createInsightService({
      getDb: async () => db as never,
      tracker: { weeklyFacts: async () => FACTS },
      aiAllowed: async () => true,
      aiTextEnabled: () => true,
      runAgent: runAgent as never,
      now: () => NOW,
    });
  }
  const seed = (entries: unknown[], jobs: unknown[] = ROWS) => createFakePrisma({ seed: { rAJob: jobs, rATrackerEntry: entries, rAResumeVariant: [] } });
  const stored = (metrics: unknown) => ({
    id: 'old',
    userId: 'u1',
    weekStartUtc: WEEK,
    summaryMarkdown: '## This week\n\nYou applied to GoHire PM at Bank Employer.',
    citedTrackerIds: [],
    modelUsed: 'test/model',
    generatedAt: NOW,
    metrics,
  });

  let prevMode: string | undefined;
  beforeEach(() => {
    prevMode = process.env.CN_RECRUITMENT_INFO_MODE;
    delete process.env.CN_RECRUITMENT_INFO_MODE;
  });
  afterEach(() => {
    if (prevMode === undefined) delete process.env.CN_RECRUITMENT_INFO_MODE;
    else process.env.CN_RECRUITMENT_INFO_MODE = prevMode;
  });

  it('GoApply: written under partner_deeplink, read under off → no summary, the counts stay, and a refresh is offered', async () => {
    const db = seed([entry('t_gohire', 'cn_gohire'), entry('t_own', 'cn_own')]);
    process.env.CN_RECRUITMENT_INFO_MODE = 'partner_deeplink';
    const written = await runWithBrand('goapply', () => service(db).refresh('u1', 'zh'));
    expect(written.insight?.summaryMarkdown).toContain('Bank Employer');
    expect((db.$rows('rACareerInsight')[0] as { metrics: { namedJobIds: string[] } }).metrics.namedJobIds).toEqual(['cn_gohire', 'cn_own']);
    // Control: while the mode still allows postings the stored text is shown.
    expect((await runWithBrand('goapply', () => service(db).getWeekly('u1'))).insight?.summaryMarkdown).toContain('Bank Employer');

    process.env.CN_RECRUITMENT_INFO_MODE = 'off';
    const read = await runWithBrand('goapply', () => service(db).getWeekly('u1'));
    expect(read).toEqual({ insight: null, facts: FACTS, week: { startUtc: '2026-10-04', endUtc: '2026-10-10' }, aiAvailable: true });
    // Unset means off as well (R-14 default).
    delete process.env.CN_RECRUITMENT_INFO_MODE;
    expect((await runWithBrand('goapply', () => service(db).getWeekly('u1'))).insight).toBeNull();
  });

  it('GoApply, mode off: a summary that named only the own import (or no job row) is still shown', async () => {
    const db = seed([entry('t_gohire', 'cn_gohire'), entry('t_own', 'cn_own')]);
    await runWithBrand('goapply', () => service(db).refresh('u1', 'zh'));
    expect((db.$rows('rACareerInsight')[0] as { metrics: { namedJobIds: string[] } }).metrics.namedJobIds).toEqual(['cn_own']);
    expect((await runWithBrand('goapply', () => service(db).getWeekly('u1'))).insight).not.toBeNull();

    const none = seed([entry('t_manual', null)]);
    await runWithBrand('goapply', () => service(none).refresh('u1', 'zh'));
    expect((none.$rows('rACareerInsight')[0] as { metrics: { namedJobIds: string[] } }).metrics.namedJobIds).toEqual([]);
    expect((await runWithBrand('goapply', () => service(none).getWeekly('u1'))).insight).not.toBeNull();
  });

  it('a named job row that no longer exists does not hide the summary; one that exists and is refused does', async () => {
    const gone = seed([], []);
    gone.$rows('rACareerInsight').push(stored({ namedJobIds: ['deleted_job'] }));
    expect((await runWithBrand('roboapply', () => service(gone).getWeekly('u1'))).insight).not.toBeNull();

    const refused = seed([]);
    refused.$rows('rACareerInsight').push(stored({ namedJobIds: ['intl_public', 'intl_other'] }));
    expect((await runWithBrand('roboapply', () => service(refused).getWeekly('u1'))).insight).toBeNull();
  });

  it('a summary stored before the marker existed is hidden only on GoApply with the mode off', async () => {
    const db = seed([]);
    db.$rows('rACareerInsight').push(stored({ applicationsCount: 4 }));
    expect((await runWithBrand('goapply', () => service(db).getWeekly('u1'))).insight).toBeNull();
    process.env.CN_RECRUITMENT_INFO_MODE = 'partner_deeplink';
    expect((await runWithBrand('goapply', () => service(db).getWeekly('u1'))).insight).not.toBeNull();
    delete process.env.CN_RECRUITMENT_INFO_MODE;
    expect((await runWithBrand('roboapply', () => service(db).getWeekly('u1'))).insight).not.toBeNull();
  });
});
