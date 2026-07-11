// backend/src/roboapply/v2/services/RACrossBankSearchService.test.ts
//
// Integration test for the orchestrator: drives run() end-to-end with every
// external seam mocked (prisma, bank providers, the three agents, billing), so
// the STEP 0-11 flow — retrieve → pre-match → materialize → score → rank →
// bucket → persist — is exercised against real logic without a live DB.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BankJobRow } from '../types/crossBank.js';

// ─── Mock every I/O seam BEFORE importing the service ──────────────────────
const upsertRAJob = vi.fn(async (args: any) => ({ id: `raj_${args.where.externalId_sourceBoard.externalId}` }));
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
    rAJob: { upsert: (...a: any[]) => upsertRAJob(...a), updateMany: (...a: any[]) => updateManyRAJob(...a) },
    rAJobMatchScore: { findMany: (...a: any[]) => findManyScore(...a), upsert: (...a: any[]) => upsertScore(...a) },
    rATrackerEntry: { findMany: (...a: any[]) => findManyTracker(...a) },
  },
}));

const listEnabledBanks = vi.fn(() => ['robohire', 'gohire'] as const);
vi.mock('../lib/raBankClients.js', () => ({
  listEnabledBanks: () => listEnabledBanks(),
  getBankClient: () => ({}),
  isBankEnabled: () => true,
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
  pickJobMatchScorerModel: () => 'openrouter/anthropic/claude-sonnet-4.6',
}));

vi.mock('./RAOnboardingRecommendService.js', () => ({
  evaluateCachedScore: () => ({ fresh: false, scoreOnly: false }),
}));
const writeDeductionLog = vi.fn(async () => undefined);
vi.mock('../../../lib/matchBilling.js', () => ({ writeDeductionLog: (...a: any[]) => writeDeductionLog(...a) }));
vi.mock('../../../lib/deductionCost.js', () => ({ costPatchFromTally: () => ({ platformCostUsd: 0.3, metadata: {} }) }));

// Import AFTER mocks are registered.
const { RACrossBankSearchService } = await import('./RACrossBankSearchService.js');

describe('RACrossBankSearchService.run (integration)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listEnabledBanks.mockReturnValue(['robohire', 'gohire'] as any);
    findManyScore.mockResolvedValue([]);
    findManyTracker.mockResolvedValue([]);
    searchBank.mockImplementation(async (bank: any) =>
      bank === 'robohire'
        ? [mkJob('rh1', 'Senior Backend Engineer', 'robohire', 70), mkJob('rh2', 'Data Analyst', 'robohire', null)]
        : [mkJob('gh1', 'Backend Engineer', 'gohire', 65)],
    );
  });

  it('runs end-to-end: materializes, scores, buckets backend into Recommended and the analyst into Explore', async () => {
    const svc = new RACrossBankSearchService();
    const res = await svc.run({ userId: 'u1', resumeVariantId: null, locale: 'en' });

    expect(res.zeroResults).toBe(false);
    expect(res.banksSwept).toEqual(['robohire', 'gohire']);
    // Backend roles (score 84 ≥ 60) land in Recommended.
    expect(res.recommended.length).toBeGreaterThanOrEqual(1);
    expect(res.recommended.every((c) => c.matchScore >= 60)).toBe(true);
    expect(res.recommended.every((c) => c.source === 'robohire' || c.source === 'gohire')).toBe(true);
    // The materialize upsert fired for retrieved jobs.
    expect(upsertRAJob).toHaveBeenCalled();
    // Scores were persisted for scored pairs.
    expect(upsertScore).toHaveBeenCalled();
    // Insight portfolio summary surfaced.
    expect(res.insight?.portfolioSummary).toContain('backend');
    // Cards carry acceptance-odds + honest bands.
    const top = res.recommended[0];
    expect(top.acceptanceOdds).toBeGreaterThan(0);
    expect(['strong', 'on_the_bar', 'reach', 'bar_unset']).toContain(top.acceptanceBand);
    expect(top.applyUrl).toMatch(/\/jobs\//);
  });

  it('degrades to one bank when the other returns null, never throws', async () => {
    searchBank.mockImplementation(async (bank: any) =>
      bank === 'robohire' ? [mkJob('rh1', 'Backend Engineer', 'robohire', 70)] : null,
    );
    const svc = new RACrossBankSearchService();
    const res = await svc.run({ userId: 'u1', resumeVariantId: null, locale: 'en' });
    expect(res.banksDegraded).toContain('gohire');
    expect(res.zeroResults).toBe(false);
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
