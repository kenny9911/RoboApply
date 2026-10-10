// @vitest-environment node
//
// WP-32 acceptance: ranking formula (fit = ai ?? pre − 5; freshness decay 72 h;
// 0.55/0.20/0.15/0.10), no recruiter-bank boost, the goal-adjustment table per
// goal option, ≤2 per company per 20, sorts and the fit-tier view filter.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CAREER_GOALS } from '../onboarding/contract.js';
import { DEFAULT_MATCH_TIERS, type PreScoreResult } from '../match/index.js';
import { EMPTY_AFFINITY } from './affinity.js';
import { GOAL_ADJUSTMENTS, ORDERING_RULES, RANKING_FACTORS } from './contract.js';
import {
  fitBadge,
  fitOf,
  annualPay,
  freshness,
  goalAdjustment,
  passesTier,
  recommendedRank,
  mentionsSponsorship,
  scatterByCompany,
  skillsBoost,
  sortCandidates,
  sourceQuality,
  sponsorshipFirst,
  type Candidate,
  type RankContext,
} from './ranking.js';
import { feedRow } from './testkit.js';

const NOW = new Date('2026-10-10T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const rc = (over: Partial<RankContext> = {}): RankContext => ({ now: NOW, affinity: EMPTY_AFFINITY, preferredCompanyKeys: new Set(), goal: { goal: null, filters: {} }, ...over });

describe('formula', () => {
  it('weights are 0.55 / 0.20 / 0.15 / 0.10 and sum to 1', () => {
    expect(RANKING_FACTORS.map((f) => [f.key, f.weight])).toEqual([
      ['fit', 0.55],
      ['freshness', 0.2],
      ['affinity', 0.15],
      ['source_quality', 0.1],
    ]);
    expect(RANKING_FACTORS.reduce((a, f) => a + f.weight, 0)).toBeCloseTo(1);
  });

  it('fit = ai ?? pre − 5 (floored at 0); null when neither', () => {
    expect(fitOf(72, 90)).toBe(72);
    expect(fitOf(null, 90)).toBe(85);
    expect(fitOf(undefined, 3)).toBe(0);
    expect(fitOf(null, null)).toBeNull();
  });

  it('freshness = 100·e^(−h/72): 100 now, 1/e after 72 h; undated jobs count from first seen', () => {
    expect(freshness(NOW, null, NOW)).toBe(100);
    expect(freshness(hoursAgo(72), null, NOW)).toBeCloseTo(100 / Math.E, 6);
    expect(freshness(null, hoursAgo(72), NOW)).toBeCloseTo(100 / Math.E, 6);
    expect(freshness(null, null, NOW)).toBe(0);
  });

  it('source quality is posting completeness (25 each), nothing about where it came from', () => {
    expect(sourceQuality(feedRow({ id: 'a', salaryDisclosed: true, atsType: 'lever', postedAtEstimated: false, descriptionLength: 900 }))).toBe(100);
    expect(sourceQuality(feedRow({ id: 'b', salaryDisclosed: false, atsType: 'other', postedAtEstimated: true, descriptionLength: 100 }))).toBe(0);
  });

  it('rank = 0.55·fit + 0.20·freshness + 0.15·affinity + 0.10·quality (+ goal)', () => {
    const row = feedRow({ id: 'r', postedAt: hoursAgo(72), salaryDisclosed: false, atsType: 'greenhouse', descriptionLength: 1000 });
    const expected = 0.55 * 80 + 0.2 * (100 / Math.E) + 0.15 * 50 + 0.1 * 75;
    expect(recommendedRank(row, 80, rc())).toBeCloseTo(expected, 2);
    expect(recommendedRank(row, null, rc())).toBeCloseTo(expected - 44, 2);
  });

  it('gives NO boost to recruiter-bank jobs (filter only)', () => {
    const base = feedRow({ id: 'x' });
    const bank = { ...base, fromRecruiterBank: true, employerVerified: true, sourcePriority: 15, sourceBoard: 'robohire' };
    expect(recommendedRank(bank, 70, rc())).toBe(recommendedRank(base, 70, rc()));
    const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ranking.ts'), 'utf8').replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/fromRecruiterBank|employerVerified|sourcePriority/);
  });

  it('preferred companies count as affinity (never as a filter)', () => {
    const row = feedRow({ id: 'p', companyNameNormalized: 'acme' });
    expect(recommendedRank(row, 70, rc({ preferredCompanyKeys: new Set(['acme']) }))).toBeGreaterThan(recommendedRank(row, 70, rc()));
  });
});

describe('goal adjustment (onboardingAnswers.goal)', () => {
  const manager = feedRow({ id: 'm', title: 'Engineering Manager', roleType: 'manager', seniority: 'lead_staff', workModel: 'onsite' });
  const ic = feedRow({ id: 'i', title: 'Backend Engineer', roleType: 'ic', seniority: 'mid', workModel: 'onsite' });
  const paid = feedRow({ id: 'pay', salaryDisclosed: true, salaryCurrency: 'USD', salaryAnnualMax: 150000, workModel: 'hybrid' });
  const filters = { salaryMin: { amount: 120000, currency: 'USD', period: 'year' as const }, seniority: ['mid' as const] };

  // goal → [manager row, ic row, paid row] points
  const TABLE: Record<(typeof CAREER_GOALS)[number], [number, number, number]> = {
    more_senior: [6, 0, 0],
    management: [6, 0, 0],
    higher_pay: [0, 0, 6],
    new_industry: [0, 0, 0],
    different_role: [0, 0, 0],
    learn_skills: [0, 0, 0],
    work_life_balance: [0, 0, 0],
    job_security: [0, 0, 0],
    flexibility: [0, 0, 4],
  };

  it('covers every onboarding goal option', () => {
    expect(Object.keys(TABLE).sort()).toEqual([...CAREER_GOALS].sort());
    expect(Object.keys(GOAL_ADJUSTMENTS).sort()).toEqual([...CAREER_GOALS].sort());
  });

  it.each(Object.entries(TABLE))('%s', (goal, [m, i, p]) => {
    expect(goalAdjustment(manager, { goal, filters })).toBe(m);
    expect(goalAdjustment(ic, { goal, filters })).toBe(i);
    expect(goalAdjustment(paid, { goal, filters })).toBe(p);
  });

  it('no goal, an unknown goal, or a missing field adds nothing', () => {
    expect(goalAdjustment(manager, { goal: null, filters })).toBe(0);
    expect(goalAdjustment(manager, { goal: 'world_peace', filters })).toBe(0);
    expect(goalAdjustment(paid, { goal: 'higher_pay', filters: {} })).toBe(0);
    expect(goalAdjustment({ ...paid, salaryCurrency: 'EUR' }, { goal: 'higher_pay', filters })).toBe(0);
    expect(goalAdjustment({ ...manager, seniority: null }, { goal: 'more_senior', filters })).toBe(0);
  });

  it('a manager title counts even when roleType is unknown, never when it says IC', () => {
    expect(goalAdjustment({ ...ic, title: 'Head of Data', roleType: null }, { goal: 'management', filters })).toBe(6);
    expect(goalAdjustment({ ...ic, title: 'Lead Engineer', roleType: 'ic' }, { goal: 'management', filters })).toBe(0);
    expect(goalAdjustment({ ...ic, title: '技术经理', roleType: null }, { goal: 'management', filters })).toBe(6);
  });
});

const cand = (id: string, company: string, rank = 0, fit: number | null = null, over = {}): Candidate => ({
  row: feedRow({ id, companyNameNormalized: company, ...over }),
  badge: fit === null ? null : { tier: 'good', score: fit, kind: 'pre', topGap: null, topOverlap: null },
  fit,
  rank,
});

describe('company scatter', () => {
  const windowOk = (ids: string[], companyOf: (id: string) => string) => {
    for (let i = 0; i < ids.length; i++) {
      const w = ids.slice(Math.max(0, i - 19), i + 1).map(companyOf);
      const counts = new Map<string, number>();
      for (const c of w) counts.set(c, (counts.get(c) ?? 0) + 1);
      if ([...counts.values()].some((n) => n > 2)) return false;
    }
    return true;
  };

  it('at most 2 per company in any 20 consecutive items, rank order otherwise kept', () => {
    const items = [
      ...Array.from({ length: 4 }, (_, i) => cand(`a${i}`, 'acme', 100 - i)),
      ...Array.from({ length: 30 }, (_, i) => cand(`o${i}`, `other${i}`, 90 - i)),
    ];
    const out = scatterByCompany(items, (c) => c.row.companyNameNormalized);
    expect(out).toHaveLength(34);
    expect(out.slice(0, 3).map((c) => c.row.id)).toEqual(['a0', 'a1', 'o0']);
    expect(out.findIndex((c) => c.row.id === 'a2')).toBe(20);
    const company = new Map(out.map((c) => [c.row.id, c.row.companyNameNormalized]));
    expect(windowOk(out.map((c) => c.row.id), (id) => company.get(id)!)).toBe(true);
  });

  it('respects the shown head across a refill seam', () => {
    const head = [cand('h1', 'acme'), cand('h2', 'acme')];
    const out = scatterByCompany([cand('n1', 'acme'), cand('n2', 'zeta')], (c) => c.row.companyNameNormalized, { head });
    expect(out.map((c) => c.row.id)).toEqual(['n2', 'n1']);
  });

  it('appends what cannot be spread when only one company is left', () => {
    const out = scatterByCompany([cand('a', 'x'), cand('b', 'x'), cand('c', 'x')], (c) => c.row.companyNameNormalized);
    expect(out.map((c) => c.row.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('sorts and the tier view', () => {
  it('newest / best fit / highest pay (pay-listed first, user currency first) / deadline', () => {
    const a = cand('a', 'a', 1, 90, { postedAt: hoursAgo(50), salaryDisclosed: true, salaryCurrency: 'EUR', salaryAnnualMax: 200000, marketTags: [{ tag: 'apply_closes:2026-10-20', evidenceQuote: '10月20日截止' }] });
    const b = cand('b', 'b', 3, 60, { postedAt: hoursAgo(1), salaryDisclosed: true, salaryCurrency: 'USD', salaryAnnualMax: 100000, marketTags: [{ tag: 'apply_closes:2026-10-12', evidenceQuote: '10月12日截止' }] });
    const c = cand('c', 'c', 2, null, { postedAt: hoursAgo(10), salaryDisclosed: false, expiresAt: hoursAgo(-1) });
    expect(sortCandidates([a, b, c], 'recommended').map((x) => x.row.id)).toEqual(['b', 'c', 'a']);
    expect(sortCandidates([a, b, c], 'newest').map((x) => x.row.id)).toEqual(['b', 'c', 'a']);
    expect(sortCandidates([a, b, c], 'best_fit').map((x) => x.row.id)).toEqual(['a', 'b', 'c']);
    expect(sortCandidates([a, b, c], 'highest_pay', { currency: 'USD' }).map((x) => x.row.id)).toEqual(['b', 'a', 'c']);
    expect(sortCandidates([a, b, c], 'highest_pay', { currency: null }).map((x) => x.row.id)).toEqual(['a', 'b', 'c']);
    expect(sortCandidates([a, b, c], 'deadline', { currency: null, today: '2026-10-10' }).map((x) => x.row.id)).toEqual(['b', 'a', 'c']);
  });

  it('FIX-3: "Highest pay" does not put a figure that cannot be pay ($60,000,000 an hour) at the top', () => {
    const typo = cand('typo', 't', 0, null, { postedAt: hoursAgo(1), salaryDisclosed: true, salaryCurrency: 'USD', salaryPeriod: 'hour', salaryMin: 60_000_000, salaryMax: 90_000_000, salaryAnnualMin: null, salaryAnnualMax: null });
    const real = cand('real', 'r', 0, null, { postedAt: hoursAgo(30), salaryDisclosed: true, salaryCurrency: 'USD', salaryPeriod: 'year', salaryMin: 150_000, salaryMax: 190_000, salaryAnnualMax: 190_000 });
    const lower = cand('lower', 'l', 0, null, { postedAt: hoursAgo(20), salaryDisclosed: true, salaryCurrency: 'USD', salaryPeriod: 'hour', salaryMin: 40, salaryMax: 55, salaryAnnualMax: 114_400 });
    expect(annualPay(typo.row)).toBeNull();
    expect(annualPay(lower.row)).toBe(114_400);
    expect(sortCandidates([typo, lower, real], 'highest_pay', { currency: 'USD' }).map((x) => x.row.id)).toEqual(['real', 'lower', 'typo']);
  });

  it('deadline: stated upcoming close dates first; undated, unquoted or past ones follow newest first (never dropped)', () => {
    const tag = (date: string, quote?: string) => [{ tag: `apply_closes:${date}`, ...(quote ? { evidenceQuote: quote } : {}) }];
    const soon = cand('soon', 's', 0, null, { postedAt: hoursAgo(300), marketTags: tag('2026-10-11', '10月11日截止') });
    const later = cand('later', 'l', 0, null, { postedAt: hoursAgo(1), marketTags: tag('2026-11-30', '11月30日截止') });
    const past = cand('past', 'p', 0, null, { postedAt: hoursAgo(2), marketTags: tag('2026-10-01', '10月1日截止') });
    const unquoted = cand('unquoted', 'u', 0, null, { postedAt: hoursAgo(3), marketTags: tag('2026-10-10') });
    const estimated = cand('estimated', 'e', 0, null, { postedAt: hoursAgo(4), expiresAt: hoursAgo(-2) });
    const out = sortCandidates([estimated, past, later, unquoted, soon], 'deadline', { currency: null, today: '2026-10-10' });
    expect(out.map((x) => x.row.id)).toEqual(['soon', 'later', 'past', 'unquoted', 'estimated']);
  });

  it('fit-tier view: great ≥80, good ≥65; unscored jobs pass', () => {
    const t = DEFAULT_MATCH_TIERS;
    const b = (score: number) => ({ tier: 'good' as const, score, kind: 'pre' as const, topGap: null, topOverlap: null });
    expect(passesTier(b(79), 'great', t)).toBe(false);
    expect(passesTier(b(80), 'great', t)).toBe(true);
    expect(passesTier(b(64), 'good', t)).toBe(false);
    expect(passesTier(b(65), 'good', t)).toBe(true);
    expect(passesTier(null, 'great', t)).toBe(true);
    expect(passesTier(b(10), 'all', t)).toBe(true);
  });

  it('the card shows the AI score when cached, else the quick estimate (with the pre-score gap/overlap)', () => {
    const pre: PreScoreResult = { jobId: 'j', score: 70, tier: 'good', kind: 'pre', dimensions: [], topOverlap: 'Python', topGap: 'Kubernetes' };
    expect(fitBadge(pre, { score: 88, tier: 'great' }, DEFAULT_MATCH_TIERS)).toEqual({ tier: 'great', score: 88, kind: 'ai', topGap: 'Kubernetes', topOverlap: 'Python' });
    expect(fitBadge(pre, null, DEFAULT_MATCH_TIERS)).toEqual({ tier: 'good', score: 70, kind: 'pre', topGap: 'Kubernetes', topOverlap: 'Python' });
    expect(fitBadge({ ...pre, score: null, tier: null }, null, DEFAULT_MATCH_TIERS)).toBeNull();
  });
});

describe('ordering rules (ORDERING_RULES, listed on /help/ranking)', () => {
  it('are documented with their trigger', () => {
    expect(ORDERING_RULES.map((r) => r.key)).toEqual(['sponsorship_first', 'skills_boost']);
    expect(ORDERING_RULES.find((r) => r.key === 'skills_boost')!.points).toBe(10);
  });

  it('sponsorship first: jobs that mention sponsorship (offered, with a quote) lead; order within groups kept', () => {
    const offered = (id: string) => ({ row: feedRow({ id, sponsorship: 'offered', sponsorshipEvidence: 'We sponsor H-1B visas.' }) });
    const plain = (id: string, over = {}) => ({ row: feedRow({ id, ...over }) });
    expect(mentionsSponsorship(feedRow({ id: 'x', sponsorship: 'offered', sponsorshipEvidence: '  ' }))).toBe(false);
    expect(mentionsSponsorship(feedRow({ id: 'x', sponsorship: 'unknown', sponsorshipEvidence: 'visa' }))).toBe(false);
    const items = [plain('a'), offered('b'), plain('c', { sponsorship: 'offered' }), offered('d')];
    const on = sponsorshipFirst(items, true);
    expect([...on.first, ...on.rest].map((c) => c.row.id)).toEqual(['b', 'd', 'a', 'c']);
    const off = sponsorshipFirst(items, false);
    expect([...off.first, ...off.rest].map((c) => c.row.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('skills boost: up to 10 points in proportion to the chosen skills the job asks for; nothing when off', () => {
    const chosen = new Set(['python', 'kubernetes']);
    expect(skillsBoost(feedRow({ id: 'a', skills: ['python', 'kubernetes', 'go'] }), chosen)).toBe(10);
    expect(skillsBoost(feedRow({ id: 'b', skills: ['Python'] }), chosen)).toBe(5);
    expect(skillsBoost(feedRow({ id: 'c', skills: ['rust'] }), chosen)).toBe(0);
    expect(skillsBoost(feedRow({ id: 'd', skills: ['python'] }), null)).toBe(0);
    const row = feedRow({ id: 'e', skills: ['python', 'kubernetes'] });
    expect(recommendedRank(row, 70, rc({ skillsBoost: chosen })) - recommendedRank(row, 70, rc())).toBeCloseTo(10, 3);
  });
});
