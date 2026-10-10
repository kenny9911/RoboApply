// backend/src/roboapply/v2/services/RACrossBankSearchService.test.ts
//
// Integration test for the orchestrator: drives run() end-to-end with every
// external seam mocked (prisma, bank providers, the three agents, billing), so
// the STEP 0-11 flow — retrieve → pre-match → materialize → score → rank →
// bucket → persist — is exercised against real logic without a live DB.

import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import type { BankJobRow } from '../types/crossBank.js';
import { jobScoringContentHash } from '../lib/raCrossBankMatch.js';

// ─── Mock every I/O seam BEFORE importing the service ──────────────────────
const upsertRAJob = vi.fn(async (args: any) => ({ id: `raj_${args.where.externalId_sourceBoard.externalId}` }));
const findManyRAJob = vi.fn(async (_args: any) => [] as any[]);
const upsertScore = vi.fn(async () => ({}));
const findManyScore = vi.fn(async () => [] as any[]);
const findManyTracker = vi.fn(async () => [] as any[]);
const findFirstVariant = vi.fn(async () => ({
  id: 'var1', resumeMarkdown: '# Jane\nGo, PostgreSQL, gRPC. 6y backend.', resumeContentHash: 'h1',
  parsedData: { skills: ['Go', 'PostgreSQL', 'gRPC'], title: 'Senior Backend Engineer', yearsExperience: 6 }, summary: 'Senior backend engineer',
}));
const findFirstSession = vi.fn(async () => ({ draftPreferences: { targetRoles: ['Backend Engineer'] } }));
const updateManyRAJob = vi.fn(async () => ({ count: 0 }));

vi.mock('../../../lib/prisma.js', () => ({
  prisma: {
    rAResumeVariant: { findFirst: (...a: any[]) => findFirstVariant(...a) },
    rAOnboardingSession: { findFirst: (...a: any[]) => findFirstSession(...a) },
    rAJob: { upsert: (...a: any[]) => upsertRAJob(...a), updateMany: (...a: any[]) => updateManyRAJob(...a), findMany: (...a: any[]) => findManyRAJob(a[0]) },
    rAJobMatchScore: { findMany: (...a: any[]) => findManyScore(...a), upsert: (...a: any[]) => upsertScore(...a) },
    rATrackerEntry: { findMany: (...a: any[]) => findManyTracker(...a) },
  },
}));

const listEnabledBanks = vi.fn(() => ['robohire', 'gohire'] as const);
/** Banks that are read over HTTPS (no database client): the search reads our synced mirror of them. */
const mirrorBanks = new Set<string>();
vi.mock('../lib/raBankClients.js', () => ({
  listEnabledBanks: () => listEnabledBanks(),
  getBankClient: () => ({}),
  isBankEnabled: () => true,
  bankReadsMirror: (b: string) => mirrorBanks.has(b),
}));

function mkJob(id: string, title: string, bank: BankJobRow['bank'], invite: number | null): BankJobRow {
  return {
    bank, retrievedVia: 'title',
    job: {
      id, title, description: 'Build Go microservices with PostgreSQL.', qualifications: '5y Go, Postgres.',
      hardRequirements: null, niceToHave: null, benefits: null, location: 'Remote', locationCity: 'Remote',
      locationCountry: null, workType: 'remote', employmentType: 'full-time', experienceLevel: 'senior',
      salaryMin: 150000, salaryMax: 200000, salaryCurrency: 'USD', salaryPeriod: 'yearly',
      requiredTagSet: [], preferredTagSet: [], requiredKeywordSet: [], preferredKeywordSet: [],
      matchInviteScore: invite, publishedAt: new Date(Date.now() - 2 * 86_400_000),
    },
    company: { companyName: `Co-${id}`, companyLogoUrl: null },
  };
}

const searchBank = vi.fn(async (bank: 'robohire' | 'gohire') => {
  if (bank === 'robohire') return [mkJob('rh1', 'Senior Backend Engineer', 'robohire', 70), mkJob('rh2', 'Data Analyst', 'robohire', null)];
  return [mkJob('gh1', 'Backend Engineer', 'gohire', 65)];
});
vi.mock('../lib/raBankProviders.js', () => ({ searchBank: (...a: any[]) => searchBank(...a) }));

const explorerRun = vi.fn(async () => ({
  primaryTitles: ['Backend Engineer', 'Senior Backend Engineer'], adjacentTitles: ['Platform Engineer'],
  stretchTitles: [], transferableSkillTags: ['go', 'postgresql'], mustKeywords: ['go', 'postgres'],
  niceKeywords: [], seniorityBands: ['senior'], rationale: '',
}));
vi.mock('../agents/RACrossBankExplorerAgent.js', () => ({ raCrossBankExplorerAgent: { run: (...a: any[]) => explorerRun(...a) } }));

const insightRun = vi.fn(async (input: any) => ({
  portfolioSummary: 'Two strong backend matches.',
  perJob: input.shortlist.map((s: any) => ({ jobId: s.jobId, acceptanceNote: 'Your Go depth fits.', raiseOddsNote: null })),
}));
vi.mock('../agents/RACrossBankInsightAgent.js', () => ({ raCrossBankInsightAgent: { run: (...a: any[]) => insightRun(...a) } }));

// Score backend roles high, the data-analyst role low → bucket split.
const scorerRun = vi.fn(async (input: any) => {
  const backend = /backend|platform/i.test(input.jobTitle);
  return {
    score: backend ? 84 : 42, summary: backend ? 'Strong Go fit.' : 'Different discipline.',
    strengths: backend ? ['Go depth'] : [], gaps: backend ? [] : ['no analytics'],
    keywordsMatched: backend ? ['go'] : [], keywordsMissing: [],
  };
});
vi.mock('../agents/RAJobMatchScorerAgent.js', () => ({
  raJobMatchScorerAgent: { run: (...a: any[]) => scorerRun(...a) },
  resolvedJobMatchScorerModel: () => 'provider/test-matching-model',
}));

const writeDeductionLog = vi.fn(async () => undefined);
vi.mock('../../../lib/matchBilling.js', () => ({ writeDeductionLog: (...a: any[]) => writeDeductionLog(...a) }));
vi.mock('../../../lib/deductionCost.js', () => ({ costPatchFromTally: () => ({ platformCostUsd: 0.3, metadata: {} }) }));

// Import AFTER mocks are registered.
const { RACrossBankSearchService } = await import('./RACrossBankSearchService.js');
const { runWithBrand } = await import('../../../lib/requestContext.js');

const INPUT = { userId: 'u1', resumeVariantId: null, locale: 'en' } as const;
/** A run on GoApply's host. A run with no brand context is RoboApply's (the default brand). */
const runOnGoApply = () => runWithBrand('goapply', () => new RACrossBankSearchService().run({ ...INPUT }));

describe('RACrossBankSearchService.run (integration)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mirrorBanks.clear();
    // Both banks have a candidate-facing posting page in these tests unless a test says otherwise.
    vi.stubEnv('ROBOHIRE_PUBLIC_JOB_URL_TEMPLATE', 'https://jobs.example.test/r/{id}');
    vi.stubEnv('GOHIRE_PUBLIC_JOB_URL_TEMPLATE', 'https://example.test/p/{id}');
    findManyRAJob.mockResolvedValue([]);
    listEnabledBanks.mockReturnValue(['robohire', 'gohire'] as any);
    findManyScore.mockResolvedValue([]);
    findManyTracker.mockResolvedValue([]);
    searchBank.mockImplementation(async (bank: any) =>
      bank === 'robohire'
        ? [mkJob('rh1', 'Senior Backend Engineer', 'robohire', 70), mkJob('rh2', 'Data Analyst', 'robohire', null)]
        : [mkJob('gh1', 'Backend Engineer', 'gohire', 65)],
    );
  });

  afterEach(() => vi.unstubAllEnvs());

  it('runs end-to-end: materializes, scores, buckets backend into Recommended and the analyst into Explore', async () => {
    const svc = new RACrossBankSearchService();
    const res = await svc.run({ userId: 'u1', resumeVariantId: null, locale: 'en' });

    expect(res.zeroResults).toBe(false);
    // RoboApply sweeps RoboHire only, although both banks are enabled.
    expect(res.banksSwept).toEqual(['robohire']);
    // Backend roles (score 84 ≥ 60) land in Recommended.
    expect(res.recommended.length).toBeGreaterThanOrEqual(1);
    expect(res.recommended.every((c) => c.matchScore >= 60)).toBe(true);
    expect([...res.recommended, ...res.explore].every((c) => c.source === 'robohire')).toBe(true);
    // The materialize upsert fired for retrieved jobs.
    expect(upsertRAJob).toHaveBeenCalled();
    // Scores were persisted for scored pairs.
    expect(upsertScore).toHaveBeenCalled();
    expect(scorerRun.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      model: 'provider/test-matching-model',
    }));
    expect(upsertScore.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      create: expect.objectContaining({ modelUsed: 'provider/test-matching-model' }),
      update: expect.objectContaining({ modelUsed: 'provider/test-matching-model' }),
    }));
    // Insight portfolio summary surfaced.
    expect(res.insight?.portfolioSummary).toContain('backend');
    // Cards carry acceptance-odds + honest bands.
    const top = res.recommended[0];
    expect(top.acceptanceOdds).toBeGreaterThan(0);
    expect(['strong', 'on_the_bar', 'reach', 'bar_unset']).toContain(top.acceptanceBand);
    // The apply link is the bank's own posting page (the configured template), never a made-up /jobs/<id>.
    expect(res.recommended.every((c) => c.applyUrl.startsWith('https://jobs.example.test/r/'))).toBe(true);
    expect(top.applyUrl).not.toBe('');
    // A RoboHire job is written to market intl, on create and on update.
    const written = upsertRAJob.mock.calls.map((c) => c[0] as any);
    expect(written.length).toBeGreaterThan(0);
    for (const args of written) expect(args).toMatchObject({ where: { externalId_sourceBoard: { sourceBoard: 'robohire' } }, create: { market: 'intl' }, update: { market: 'intl' } });
  });

  it('a run sweeps the banks of its own brand only: RoboApply never reads GoHire, GoApply never reads RoboHire', async () => {
    await new RACrossBankSearchService().run({ ...INPUT });
    expect(searchBank.mock.calls.map((c) => c[0])).toEqual(['robohire']);
    expect(explorerRun.mock.calls[0]?.[0]).toMatchObject({ banks: ['robohire'] });

    searchBank.mockClear();
    upsertRAJob.mockClear();
    const cn = await runOnGoApply();
    expect(searchBank.mock.calls.map((c) => c[0])).toEqual(['gohire']);
    expect(cn.banksSwept).toEqual(['gohire']);
    expect([...cn.recommended, ...cn.explore].every((c) => c.source === 'gohire' && c.applyUrl.startsWith('https://example.test/p/'))).toBe(true);
    // A GoHire job is written to market cn, on create and on update.
    const written = upsertRAJob.mock.calls.map((c) => c[0] as any);
    expect(written.length).toBeGreaterThan(0);
    for (const args of written) expect(args).toMatchObject({ where: { externalId_sourceBoard: { sourceBoard: 'gohire' } }, create: { market: 'cn' }, update: { market: 'cn' } });

    // A brand whose bank is not enabled has nothing to sweep, whatever the other bank holds.
    listEnabledBanks.mockReturnValue(['robohire'] as any);
    searchBank.mockClear();
    expect(await runOnGoApply()).toMatchObject({ zeroResults: true, banksSwept: [] });
    expect(searchBank).not.toHaveBeenCalled();
  });

  it('a run archives nothing: a bank row never closes by posting age (ingest closes it by listing diff, tombstone or bank status)', async () => {
    const old = mkJob('rh_old', 'Backend Engineer', 'robohire', 70);
    old.job.publishedAt = new Date(Date.now() - 400 * 86_400_000);
    searchBank.mockImplementation(async () => [old]);
    await new RACrossBankSearchService().run({ ...INPUT });
    searchBank.mockImplementation(async () => [{ ...old, bank: 'gohire' as const }]);
    await runOnGoApply();
    expect(updateManyRAJob).not.toHaveBeenCalled();
    for (const args of upsertRAJob.mock.calls.map((c) => c[0] as any)) {
      expect(args.update).not.toHaveProperty('archivedAt');
      expect(args.create.archivedAt ?? null).toBeNull();
    }
  });

  it('a bank with no posting page contributes no job: nothing is materialised, scored or shown for it', async () => {
    vi.stubEnv('GOHIRE_PUBLIC_JOB_URL_TEMPLATE', '');
    const cn = await runOnGoApply();
    expect(cn).toMatchObject({ zeroResults: true, recommended: [], explore: [] });
    expect(upsertRAJob).not.toHaveBeenCalled();
    expect(scorerRun).not.toHaveBeenCalled();
    // The other brand's bank still has its page, so its run is unaffected.
    const intl = await new RACrossBankSearchService().run({ ...INPUT });
    expect([...intl.recommended, ...intl.explore].length).toBeGreaterThan(0);
    expect([...intl.recommended, ...intl.explore].every((c) => c.applyUrl.startsWith('https://jobs.example.test/r/'))).toBe(true);
    // Without its page RoboHire has nothing to show either.
    vi.stubEnv('ROBOHIRE_PUBLIC_JOB_URL_TEMPLATE', '');
    upsertRAJob.mockClear();
    scorerRun.mockClear();
    const none = await new RACrossBankSearchService().run({ ...INPUT });
    expect(none).toMatchObject({ zeroResults: true, recommended: [], explore: [] });
    expect(upsertRAJob).not.toHaveBeenCalled();
    expect(scorerRun).not.toHaveBeenCalled();
  });

  it('a bank read over HTTPS is searched in the synced mirror: its rows are RAJob rows already, so nothing is upserted for it', async () => {
    mirrorBanks.add('gohire');
    findManyRAJob.mockImplementation(async (args: any) =>
      args.where.sourceBoard === 'gohire' ? args.where.externalId.in.map((externalId: string) => ({ id: `mirror_${externalId}`, externalId })) : [],
    );
    const res = await runOnGoApply();
    expect(upsertRAJob).not.toHaveBeenCalled();
    expect(findManyRAJob).toHaveBeenCalledWith(expect.objectContaining({ where: { sourceBoard: 'gohire', externalId: { in: ['gh1'] }, archivedAt: null, visibility: 'public' } }));
    const gohire = [...res.recommended, ...res.explore].find((c) => c.source === 'gohire');
    expect(gohire).toMatchObject({ id: 'mirror_gh1', applyUrl: 'https://example.test/p/gh1' });
    // A mirrored row that is no longer open (archived since) is simply not shown.
    findManyRAJob.mockResolvedValue([]);
    const gone = await runOnGoApply();
    expect([...gone.recommended, ...gone.explore].some((c) => c.source === 'gohire')).toBe(false);
  });

  it('recomputes a hash-current cache row produced by an old scorer model', async () => {
    const job = mkJob('rh1', 'Senior Backend Engineer', 'robohire', 70).job;
    findManyScore.mockResolvedValueOnce([
      {
        jobId: 'raj_rh1',
        score: 91,
        explanation: {
          responseLanguage: 'en',
          promptVersion: 'crossbank_v1',
          crossBank: { jobContentHash: jobScoringContentHash(job) },
        },
        resumeContentHashAtScore: 'h1',
        modelUsed: 'anthropic/claude-sonnet-4.6',
      },
    ]);

    const svc = new RACrossBankSearchService();
    const res = await svc.run({ userId: 'u1', resumeVariantId: null, locale: 'en' });

    expect(findManyScore.mock.calls[0]?.[0].select).toEqual(expect.objectContaining({
      modelUsed: true,
    }));
    expect(res.scorerCacheHits).toBe(0);
    // Both RoboHire jobs are scored again (the run sweeps RoboHire only).
    expect(scorerRun).toHaveBeenCalledTimes(2);
  });

  it('reuses a cache row only when its scorer model is still current', async () => {
    const job = mkJob('rh1', 'Senior Backend Engineer', 'robohire', 70).job;
    findManyScore.mockResolvedValueOnce([
      {
        jobId: 'raj_rh1',
        score: 91,
        explanation: {
          rationale: 'Cached current-model score.',
          strengths: ['Go depth'],
          gaps: [],
          responseLanguage: 'en',
          promptVersion: 'crossbank_v1',
          crossBank: { jobContentHash: jobScoringContentHash(job) },
        },
        resumeContentHashAtScore: 'h1',
        modelUsed: 'provider/test-matching-model',
      },
    ]);

    const svc = new RACrossBankSearchService();
    const res = await svc.run({ userId: 'u1', resumeVariantId: null, locale: 'en' });

    expect(res.scorerCacheHits).toBe(1);
    expect(scorerRun).toHaveBeenCalledTimes(1);
  });

  it('a bank that fails is reported as degraded, never thrown', async () => {
    searchBank.mockImplementation(async () => null);
    const svc = new RACrossBankSearchService();
    const res = await svc.run({ userId: 'u1', resumeVariantId: null, locale: 'en' });
    expect(res.banksSwept).toEqual(['robohire']);
    expect(res.banksDegraded).toEqual(['robohire']);
    expect(res.zeroResults).toBe(true);
  });

  it('returns zeroResults (no throw) when no banks are enabled', async () => {
    listEnabledBanks.mockReturnValue([] as any);
    const svc = new RACrossBankSearchService();
    const res = await svc.run({ userId: 'u1', resumeVariantId: null, locale: 'en' });
    expect(res.zeroResults).toBe(true);
    expect(res.recommended).toHaveLength(0);
  });

  it('returns zeroResults when the candidate has no resume', async () => {
    findFirstVariant.mockResolvedValueOnce(null as any);
    const svc = new RACrossBankSearchService();
    const res = await svc.run({ userId: 'u1', resumeVariantId: null, locale: 'en' });
    expect(res.zeroResults).toBe(true);
  });

  it('attributes the round platform cost exactly once (rollup row), not per scorer call', async () => {
    const svc = new RACrossBankSearchService();
    await svc.run({ userId: 'u1', resumeVariantId: null, locale: 'en' });
    const rollupRows = writeDeductionLog.mock.calls.filter((c: any[]) => (c[0] as any).metadata?.rollup === true);
    expect(rollupRows).toHaveLength(1);
    expect((rollupRows[0][0] as any).platformCostUsd).toBe(0.3);
    // Per-call score rows carry NO platformCostUsd.
    const perCall = writeDeductionLog.mock.calls.filter((c: any[]) => (c[0] as any).units === 1 && (c[0] as any).sku === 'ra_crossbank_score');
    expect(perCall.length).toBeGreaterThan(0);
    expect(perCall.every((c: any[]) => (c[0] as any).platformCostUsd === undefined)).toBe(true);
  });
});
