// backend/src/roboapply/v2/lib/raCrossBankMatch.test.ts
//
// Unit tests for the pure heart of the cross-bank job-search agent team.
// Run: npx vitest run server/src/roboapply/v2/lib/raCrossBankMatch.test.ts

import { afterEach, describe, it, expect, vi } from 'vitest';

vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { logger } from '../../../services/LoggerService.js';
import {
  canonicalizeTag,
  parseSeniorityBand,
  levelIdx,
  resolveMatchInviteScore,
  normalizeSalaryPeriod,
  normalizeWorkMode,
  normalizeEmploymentType,
  computeAcceptanceOdds,
  inviteBand,
  computePreScore,
  preMatchCandidates,
  reserveScorerBudgetByTier,
  mapWithConcurrency,
  mapRecruiterJobToRAJobUpsert,
  computeRaiseOddsLevers,
  synthesizeApplyUrl,
  bankMarket,
  bankPublicJobUrl,
  bankPublicJobUrlProblems,
  bankPublicJobUrlTemplate,
  resetBankPublicJobUrlWarningsForTests,
  PRE_FLOOR,
} from './raCrossBankMatch.js';
import type { BankJobRow, CrossBankExplorerPlan, CandidateSignals, PreMatchedCandidate } from '../types/crossBank.js';

const NOW = new Date('2026-07-11T00:00:00.000Z').getTime();

function job(overrides: Partial<BankJobRow['job']> = {}, bank: BankJobRow['bank'] = 'robohire'): BankJobRow {
  return {
    bank,
    retrievedVia: 'title',
    job: {
      id: overrides.id ?? 'j1',
      title: overrides.title ?? 'Senior Backend Engineer',
      description: overrides.description ?? 'Build Go services.',
      qualifications: overrides.qualifications ?? '5y Go, Postgres.',
      hardRequirements: overrides.hardRequirements ?? null,
      niceToHave: overrides.niceToHave ?? null,
      benefits: overrides.benefits ?? null,
      location: overrides.location ?? 'Remote',
      locationCity: overrides.locationCity ?? null,
      locationCountry: overrides.locationCountry ?? 'US',
      workType: overrides.workType ?? 'remote',
      employmentType: overrides.employmentType ?? 'full-time',
      experienceLevel: overrides.experienceLevel ?? 'senior',
      salaryMin: overrides.salaryMin ?? 150000,
      salaryMax: overrides.salaryMax ?? 200000,
      salaryCurrency: overrides.salaryCurrency ?? 'USD',
      salaryPeriod: overrides.salaryPeriod ?? 'yearly',
      requiredTagSet: overrides.requiredTagSet ?? [],
      preferredTagSet: overrides.preferredTagSet ?? [],
      requiredKeywordSet: overrides.requiredKeywordSet ?? [],
      preferredKeywordSet: overrides.preferredKeywordSet ?? [],
      matchInviteScore: overrides.matchInviteScore ?? null,
      publishedAt: overrides.publishedAt ?? new Date(NOW - 2 * 86_400_000),
    },
    company: { companyName: 'Acme', companyLogoUrl: null },
  };
}

const plan: CrossBankExplorerPlan = {
  primaryTitles: ['Backend Engineer', 'Senior Backend Engineer'],
  adjacentTitles: ['Platform Engineer'],
  stretchTitles: ['SRE'],
  transferableSkillTags: ['go', 'postgresql', 'kubernetes'],
  mustKeywords: ['go', 'postgres'],
  niceKeywords: [],
  seniorityBands: ['senior'],
  rationale: '',
};

const signals: CandidateSignals = {
  currentTitles: ['Senior Backend Engineer'],
  topSkills: ['Go', 'PostgreSQL', 'gRPC'],
  candidateTagSet: ['go', 'postgresql', 'grpc'],
  candidateKeywords: ['go', 'postgresql', 'grpc'],
  seniority: 'senior',
  years: 6,
};

describe('canonicalizeTag', () => {
  it('accepts both namespaced and bare grammars', () => {
    expect(canonicalizeTag('lang:python')).toContain('python');
    expect(canonicalizeTag('lang:python')).toContain('lang:python');
    expect(canonicalizeTag('Python')).toContain('python');
  });
  it('applies synonyms', () => {
    expect(canonicalizeTag('k8s')).toContain('kubernetes');
    expect(canonicalizeTag('golang')).toContain('go');
    expect(canonicalizeTag('js')).toContain('javascript');
  });
});

describe('parseSeniorityBand + levelIdx (executive→exec [FIX-3])', () => {
  it('maps recruiter "executive" to the exec slot (index 4)', () => {
    expect(parseSeniorityBand('executive')).toBe('exec');
    expect(levelIdx('executive')).toBe(4);
  });
  it('maps common variants', () => {
    expect(parseSeniorityBand('Sr. Engineer')).toBe('senior');
    expect(parseSeniorityBand('Staff Engineer')).toBe('lead');
    expect(parseSeniorityBand('Intern')).toBe('entry');
    expect(parseSeniorityBand('VP of Eng')).toBe('exec');
    expect(parseSeniorityBand('')).toBe('unknown');
  });
});

describe('resolveMatchInviteScore', () => {
  it('clamps to 55-80 and flags default/null', () => {
    expect(resolveMatchInviteScore(null)).toEqual({ inviteBar: 60, barIsDefault: true });
    expect(resolveMatchInviteScore(60)).toEqual({ inviteBar: 60, barIsDefault: true });
    expect(resolveMatchInviteScore(75)).toEqual({ inviteBar: 75, barIsDefault: false });
    expect(resolveMatchInviteScore(40)).toEqual({ inviteBar: 55, barIsDefault: false });
    expect(resolveMatchInviteScore(99)).toEqual({ inviteBar: 80, barIsDefault: false });
  });
});

describe('normalizeSalaryPeriod [FIX-7]', () => {
  it('maps recruiter monthly/yearly to RAJob month/year', () => {
    expect(normalizeSalaryPeriod('monthly')).toBe('month');
    expect(normalizeSalaryPeriod('yearly')).toBe('year');
    expect(normalizeSalaryPeriod('annual')).toBe('year');
    expect(normalizeSalaryPeriod('hourly')).toBe('hour');
    expect(normalizeSalaryPeriod(null)).toBe('year');
    expect(normalizeSalaryPeriod('')).toBe('year');
  });
});

describe('normalizeWorkMode / normalizeEmploymentType', () => {
  it('normalizes work mode with onsite default', () => {
    expect(normalizeWorkMode('remote')).toBe('remote');
    expect(normalizeWorkMode('Hybrid')).toBe('hybrid');
    expect(normalizeWorkMode('whatever')).toBe('onsite');
    expect(normalizeWorkMode(null)).toBe('onsite');
  });
  it('normalizes employment type', () => {
    expect(normalizeEmploymentType('Full-time')).toBe('full_time');
    expect(normalizeEmploymentType('contractor')).toBe('contract');
    expect(normalizeEmploymentType('internship')).toBe('internship');
    expect(normalizeEmploymentType(null)).toBeNull();
  });
});

describe('computeAcceptanceOdds (spec §5.3 worked example: JobB > JobA)', () => {
  it('ranks a job far above its own tuned bar over a higher-raw-score job below its bar', () => {
    const jobA = computeAcceptanceOdds({
      llmScore: 92, inviteBar: 80, barIsDefault: false,
      requiredCoverage: 0.5, keywordCoverage: 0.5, preferredOverlap: 0.2,
    });
    const jobB = computeAcceptanceOdds({
      llmScore: 78, inviteBar: 60, barIsDefault: false,
      requiredCoverage: 0.95, keywordCoverage: 0.9, preferredOverlap: 0.7,
    });
    expect(jobB.acceptanceOdds).toBeGreaterThan(jobA.acceptanceOdds);
  });
  it('reweights toward the coverage anchor when the bar is the untuned default', () => {
    const tuned = computeAcceptanceOdds({
      llmScore: 78, inviteBar: 60, barIsDefault: false,
      requiredCoverage: 0.95, keywordCoverage: 0.9, preferredOverlap: 0.7,
    });
    const defaulted = computeAcceptanceOdds({
      llmScore: 78, inviteBar: 60, barIsDefault: true,
      requiredCoverage: 0.95, keywordCoverage: 0.9, preferredOverlap: 0.7,
    });
    expect(defaulted.acceptanceBand).toBe('bar_unset');
    // With a near-full coverage anchor and default reweight, odds stay high.
    expect(defaulted.acceptanceOdds).toBeGreaterThan(70);
    expect(tuned.acceptanceBand).toBe('strong');
  });
  it('inviteBand labels honestly', () => {
    expect(inviteBand(90, 75, false)).toBe('strong');
    expect(inviteBand(76, 75, false)).toBe('on_the_bar');
    expect(inviteBand(60, 75, false)).toBe('reach');
    expect(inviteBand(90, 60, true)).toBe('bar_unset');
  });
});

describe('computePreScore', () => {
  it('gives full required-coverage credit when the recruiter tag set is empty (soft, not a gate)', () => {
    const ps = computePreScore(job(), plan, signals, new Set(['go', 'postgresql']), NOW);
    expect(ps.requiredCoverage).toBe(1); // empty requiredTagSet → 1.0
    expect(ps.tier).toBe('core'); // strong title affinity
    expect(ps.preScore).toBeGreaterThan(PRE_FLOOR);
  });
  it('counts a required keyword satisfied via raw resume tokens (belt-and-suspenders)', () => {
    const r = job({ requiredKeywordSet: ['kafka'] });
    const withToken = computePreScore(r, plan, signals, new Set(['kafka']), NOW);
    const withoutToken = computePreScore(r, plan, signals, new Set(), NOW);
    expect(withToken.keywordCoverage).toBe(1);
    expect(withoutToken.keywordCoverage).toBe(0);
    expect(withoutToken.missingRequiredKeywords).toContain('kafka');
  });
});

describe('preMatchCandidates: cross-bank dedup + alsoOnBank', () => {
  it('dedupes identical twins across banks, keeps one, records alsoOnBank', () => {
    const rows = [
      job({ id: 'rh1' }, 'robohire'),
      job({ id: 'gh1' }, 'gohire'), // same title/company/location → same fingerprint
    ];
    const res = preMatchCandidates({
      rows, plan, signals, draft: {}, resumeTokens: new Set(['go']), scorerBudget: 8, aggressiveness: 'balanced',
    });
    expect(res.droppedTwins).toBe(1);
    expect(res.coverageSet).toHaveLength(1);
    expect(res.coverageSet[0].alsoOnBank).not.toBeNull();
  });
  it('drops recruiter-side test rows with no resolvable company (e.g. 测试简历匹配)', () => {
    const testRow = job({ id: 'tst', title: '测试简历匹配' });
    testRow.company.companyName = '';
    const res = preMatchCandidates({
      rows: [testRow], plan, signals, draft: {}, resumeTokens: new Set(), scorerBudget: 8, aggressiveness: 'balanced',
    });
    expect(res.coverageSet).toHaveLength(0);
  });

  it('drops dealbreaker-company rows', () => {
    const rows = [job({ id: 'x' })];
    const res = preMatchCandidates({
      rows, plan, signals, draft: { dealbreakers: ['Acme'] }, resumeTokens: new Set(), scorerBudget: 8, aggressiveness: 'balanced',
    });
    expect(res.coverageSet).toHaveLength(0);
  });
});

describe('reserveScorerBudgetByTier', () => {
  it('never exceeds the budget and guarantees stretch attention', () => {
    const mk = (id: string, tier: PreMatchedCandidate['tier'], pre: number): PreMatchedCandidate => ({
      bank: 'robohire', job: job({ id }).job, company: { companyName: 'A', companyLogoUrl: null },
      retrievedVia: 'title', preScore: pre, tier, requiredCoverage: 1, keywordCoverage: 1, preferredOverlap: 0,
      projectedScore: 80, inviteBar: 60, barIsDefault: true, fingerprint: id, alsoOnBank: null, recency01: 1,
      missingRequiredTags: [], missingRequiredKeywords: [],
    });
    const set = [
      ...Array.from({ length: 20 }, (_, i) => mk(`c${i}`, 'core', 90 - i)),
      ...Array.from({ length: 5 }, (_, i) => mk(`s${i}`, 'stretch', 50 - i)),
    ];
    const picked = reserveScorerBudgetByTier(set, 16, 'balanced');
    expect(picked.length).toBeLessThanOrEqual(16);
    expect(picked.some((c) => c.tier === 'stretch')).toBe(true); // MIN_STRETCH_SCORED
  });
  it('returns nothing for a zero budget', () => {
    expect(reserveScorerBudgetByTier([], 0, 'balanced')).toHaveLength(0);
  });

  it('never oversubscribes the budget yet keeps a stretch pick even when core+adjacent are plentiful [review FIX-1]', () => {
    const mk = (id: string, tier: PreMatchedCandidate['tier'], pre: number): PreMatchedCandidate => ({
      bank: 'robohire', job: job({ id }).job, company: { companyName: 'A', companyLogoUrl: null },
      retrievedVia: 'title', preScore: pre, tier, requiredCoverage: 1, keywordCoverage: 1, preferredOverlap: 0,
      projectedScore: 80, inviteBar: 60, barIsDefault: true, fingerprint: id, alsoOnBank: null, recency01: 1,
      missingRequiredTags: [], missingRequiredKeywords: [],
    });
    // Balanced/16: quotas would be 10 core + 4 adj + 3 stretch = 17 > 16 pre-fix.
    const set = [
      ...Array.from({ length: 40 }, (_, i) => mk(`c${i}`, 'core', 99 - i)),
      ...Array.from({ length: 40 }, (_, i) => mk(`a${i}`, 'adjacent', 59 - i)),
      ...Array.from({ length: 40 }, (_, i) => mk(`s${i}`, 'stretch', 19 - i)),
    ];
    const picked = reserveScorerBudgetByTier(set, 16, 'balanced');
    expect(picked.length).toBe(16); // exactly budget, never 17
    expect(picked.filter((c) => c.tier === 'stretch').length).toBeGreaterThanOrEqual(3); // floor survives
  });
});

describe('mapWithConcurrency', () => {
  it('processes all items and never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 25 }, (_, i) => i);
    const out = await mapWithConcurrency(items, 8, async (n) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return n * 2;
    });
    expect(out).toEqual(items.map((n) => n * 2));
    expect(maxInFlight).toBeLessThanOrEqual(8);
  });
});

describe('mapRecruiterJobToRAJobUpsert', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetBankPublicJobUrlWarningsForTests();
  });

  const cand = (bank: 'gohire' | 'robohire' = 'gohire'): PreMatchedCandidate => ({
    bank, job: job({ id: 'gh42', salaryPeriod: 'monthly' }).job,
    company: { companyName: 'Acme', companyLogoUrl: 'https://logo' },
    retrievedVia: 'tag', preScore: 70, tier: 'core', requiredCoverage: 1, keywordCoverage: 1, preferredOverlap: 0,
    projectedScore: 80, inviteBar: 72, barIsDefault: false, fingerprint: 'fp', alsoOnBank: 'robohire', recency01: 1,
    missingRequiredTags: ['rust'], missingRequiredKeywords: [],
  });

  it('maps a recruiter job to an idempotent RAJob upsert with bank sourceBoard and the bank\'s posting page as the apply URL', () => {
    vi.stubEnv('GOHIRE_PUBLIC_JOB_URL_TEMPLATE', 'https://example.test/p/{id}');
    const args = mapRecruiterJobToRAJobUpsert(cand())!;
    expect(args.where.externalId_sourceBoard).toEqual({ externalId: 'gh42', sourceBoard: 'gohire' });
    expect(args.create.sourceBoard).toBe('gohire');
    expect(args.create.salaryPeriod).toBe('month'); // monthly → month
    expect((args.create.seedTags as any).alsoOnBank).toBe('robohire');
    expect((args.create.seedTags as any).missingRequiredTags).toEqual(['rust']);
    expect(args.create.applyUrl).toBe('https://example.test/p/gh42');
    expect(args.update.applyUrl).toBe('https://example.test/p/gh42');
  });

  it('a row materialised from the GoHire bank has market cn on create and on update (invisible to RoboApply\'s feed); RoboHire is intl', () => {
    vi.stubEnv('GOHIRE_PUBLIC_JOB_URL_TEMPLATE', 'https://example.test/p/{id}');
    vi.stubEnv('ROBOHIRE_PUBLIC_JOB_URL_TEMPLATE', 'https://jobs.example.test/r/{id}');
    const gh = mapRecruiterJobToRAJobUpsert(cand('gohire'))!;
    expect(gh.create.market).toBe('cn');
    expect(gh.update.market).toBe('cn');
    const rh = mapRecruiterJobToRAJobUpsert(cand('robohire'))!;
    expect(rh.create.market).toBe('intl');
    expect(rh.update.market).toBe('intl');
    expect(bankMarket('gohire')).toBe('cn');
    expect(bankMarket('robohire')).toBe('intl');
  });

  it('skips a candidate with no apply URL: the bank has no candidate-facing posting page', () => {
    expect(mapRecruiterJobToRAJobUpsert(cand('gohire'))).toBeNull();
    expect(mapRecruiterJobToRAJobUpsert(cand('robohire'))).toBeNull();
    // The old base-URL variables pointed at the missing /jobs/<id> route: they no longer produce a link.
    vi.stubEnv('GOHIRE_PUBLIC_JOB_BASE_URL', 'https://www.gohire.top');
    expect(mapRecruiterJobToRAJobUpsert(cand('gohire'))).toBeNull();
  });

  it('maps Chinese employment labels like the English ones', () => {
    expect(normalizeEmploymentType('全职')).toBe('full_time');
    expect(normalizeEmploymentType('兼职')).toBe('part_time');
    expect(normalizeEmploymentType('实习')).toBe('internship');
    expect(normalizeEmploymentType('合同')).toBe('contract');
    expect(normalizeEmploymentType('劳务')).toBe('contract');
    expect(normalizeEmploymentType('full-time')).toBe('full_time');
    expect(normalizeEmploymentType('')).toBeNull();
  });
});

describe('computeRaiseOddsLevers', () => {
  it('prefers missing recruiter predicates, falls back to scorer gaps', () => {
    const base = { bank: 'robohire', job: job().job, company: { companyName: 'A', companyLogoUrl: null }, retrievedVia: 'title', preScore: 70, tier: 'core', requiredCoverage: 1, keywordCoverage: 1, preferredOverlap: 0, projectedScore: 80, inviteBar: 60, barIsDefault: true, fingerprint: 'f', alsoOnBank: null, recency01: 1 } as const;
    const withPredicates = computeRaiseOddsLevers({ ...base, missingRequiredTags: ['kubernetes'], missingRequiredKeywords: [] }, ['some gap']);
    expect(withPredicates).toEqual(['kubernetes']);
    const noPredicates = computeRaiseOddsLevers({ ...base, missingRequiredTags: [], missingRequiredKeywords: [] }, ['add Kafka experience']);
    expect(noPredicates).toEqual(['add Kafka experience']);
  });
});

describe('the bank posting page (no default: neither bank has a /jobs/<id> page)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetBankPublicJobUrlWarningsForTests();
    vi.mocked(logger.warn).mockClear();
  });

  it('with no template there is no apply URL, for either bank', () => {
    expect(synthesizeApplyUrl('robohire', 'abc')).toBeNull();
    expect(synthesizeApplyUrl('gohire', 'xyz')).toBeNull();
    expect(bankPublicJobUrl('gohire', 'xyz', {})).toBeNull();
    expect(bankPublicJobUrlTemplate('robohire', {})).toBeNull();
  });

  it('builds the URL from each bank\'s own template, encoding the id into every {id}', () => {
    const env = { GOHIRE_PUBLIC_JOB_URL_TEMPLATE: 'https://example.test/p/{id}', ROBOHIRE_PUBLIC_JOB_URL_TEMPLATE: 'https://jobs.example.test/r/{id}?ref={id}' };
    expect(bankPublicJobUrl('gohire', 'xyz', env)).toBe('https://example.test/p/xyz');
    expect(bankPublicJobUrl('robohire', 'a b/c', env)).toBe('https://jobs.example.test/r/a%20b%2Fc?ref=a%20b%2Fc');
    expect(bankPublicJobUrl('gohire', '  ', env)).toBeNull();
    // One bank's template never serves the other.
    expect(bankPublicJobUrl('robohire', 'abc', { GOHIRE_PUBLIC_JOB_URL_TEMPLATE: 'https://example.test/p/{id}' })).toBeNull();
    vi.stubEnv('GOHIRE_PUBLIC_JOB_URL_TEMPLATE', 'https://example.test/p/{id}');
    expect(synthesizeApplyUrl('gohire', 'xyz')).toBe('https://example.test/p/xyz');
    expect(synthesizeApplyUrl('robohire', 'abc')).toBeNull();
  });

  it('a template must be https and contain {id}; an unusable one gives no URL and is reported by name', () => {
    for (const bad of ['http://example.test/p/{id}', 'https://example.test/p/', 'not a url {id}', '{id}']) {
      const env = { GOHIRE_PUBLIC_JOB_URL_TEMPLATE: bad };
      expect(bankPublicJobUrl('gohire', 'x', env)).toBeNull();
      expect(bankPublicJobUrlProblems(env)).toHaveLength(1);
      expect(bankPublicJobUrlProblems(env)[0]).toMatchObject({ bank: 'gohire', variable: 'GOHIRE_PUBLIC_JOB_URL_TEMPLATE' });
    }
    expect(bankPublicJobUrlProblems({ GOHIRE_PUBLIC_JOB_URL_TEMPLATE: 'https://example.test/p/{id}' })).toEqual([]);
  });

  it('the old base-URL variables are ignored, with one warning that names the new variable', () => {
    const env = { GOHIRE_PUBLIC_JOB_BASE_URL: 'https://www.gohire.top', ROBOHIRE_PUBLIC_JOB_BASE_URL: 'https://www.robohire.io' };
    expect(bankPublicJobUrlProblems(env)).toEqual([
      { bank: 'robohire', variable: 'ROBOHIRE_PUBLIC_JOB_BASE_URL', problem: 'legacy_base_url_ignored', use: 'ROBOHIRE_PUBLIC_JOB_URL_TEMPLATE' },
      { bank: 'gohire', variable: 'GOHIRE_PUBLIC_JOB_BASE_URL', problem: 'legacy_base_url_ignored', use: 'GOHIRE_PUBLIC_JOB_URL_TEMPLATE' },
    ]);
    const warn = vi.mocked(logger.warn);
    warn.mockClear();
    for (let i = 0; i < 3; i += 1) {
      expect(bankPublicJobUrl('gohire', 'x', env)).toBeNull();
      expect(bankPublicJobUrl('robohire', 'x', env)).toBeNull();
    }
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.map((c) => String(c[1])).join(' ')).toMatch(/GOHIRE_PUBLIC_JOB_BASE_URL is ignored.*GOHIRE_PUBLIC_JOB_URL_TEMPLATE/s);
  });
});
