// @vitest-environment node
//
// WP-32 acceptance: ranking formula (the fit input on one scale for scored and
// unscored rows, SM-4; freshness with a slow tail, SM-12; 0.55/0.20/0.15/0.10),
// no recruiter-bank boost, the goal-adjustment table per goal option, ≤2 per
// company per 20, sorts and the fit-tier view filter.
// MKT-4F: seen and skipped, the fused retrieval position as a tie-break,
// reciprocal rank fusion, and the same-role collapse.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CAREER_GOALS } from '../onboarding/contract.js';
import { DEFAULT_MATCH_PRIORS, DEFAULT_MATCH_TIERS, DEFAULT_MATCH_WEIGHTS, applyMap, assembleFit, currentScorerPin, type Fit } from '../match/index.js';
import { jobRecord, matchUser } from '../match/testkit.js';
import { EMPTY_AFFINITY } from './affinity.js';
import { GOAL_ADJUSTMENTS, ORDERING_RULES, RANKING_FACTORS } from './contract.js';
import {
  RANK_BLEND_AI_SHARE,
  collapseSameRole,
  fitBadge,
  fitForRank,
  fuseByReciprocalRank,
  rankFitOf,
  annualPay,
  freshness,
  goalAdjustment,
  passesTier,
  placeOf,
  recommendedRank,
  mentionsSponsorship,
  sameRoleKey,
  scatterByCompany,
  seenSkippedPenalty,
  skillsBoost,
  sortCandidates,
  sourceQuality,
  sponsorshipFirst,
  tierOf,
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

  // Review finding (M1 gate): until a market has its calibration map the order under "Best fit" is not
  // the order of the numbers on the cards (strategy 2.4 prescribes the blend), and the help page said
  // it was. The page and the published factor text now state the blend.
  it('the published text says a job with an AI score is ranked between its two numbers, as the code does', () => {
    // A card showing 78 (AI) with an estimate of 50 ranks on 64, below an unscored card showing 66.
    expect(fitForRank({ ai: 78, estimate: 50 })).toBe(64);
    expect(fitForRank({ estimate: 66 })).toBe(66);
    const what = RANKING_FACTORS.find((f) => f.key === 'fit')!.what;
    expect(what).toMatch(/halfway between its quick estimate and its AI score/);
    const here = path.dirname(fileURLToPath(import.meta.url));
    const staged = JSON.parse(readFileSync(path.resolve(here, '../../../../i18n/staging/landing.en.json'), 'utf8')) as { landing: { ranking: { fit: { body: string } } } };
    expect(staged.landing.ranking.fit.body).toMatch(/halfway between its quick estimate and its analysed score/);
    expect(staged.landing.ranking.fit.body).toMatch(/can differ from the number on its card/);
    // "Halfway" is the constant, not a figure of speech.
    expect(RANK_BLEND_AI_SHARE).toBe(0.5);
  });

  it('fit input without a calibration map: the estimate, plus half of (AI − estimate) for a scored row', () => {
    expect(RANK_BLEND_AI_SHARE).toBe(0.5);
    // An AI score of 70 next to an estimate of 60 ranks on 65.
    expect(fitForRank({ ai: 70, estimate: 60 })).toBe(65);
    expect(fitForRank({ ai: 50, estimate: 80 })).toBe(65);
    // An unscored row ranks on its estimate, with no discount for not being scored.
    expect(fitForRank({ ai: null, estimate: 60 })).toBe(60);
    expect(fitForRank({ estimate: 60 })).toBe(60);
    // An AI score with nothing to estimate from: the AI score. Neither: nothing.
    expect(fitForRank({ ai: 72, estimate: null })).toBe(72);
    expect(fitForRank({ ai: null, estimate: null })).toBeNull();
    expect(fitForRank({})).toBeNull();
    // Always within 0–100.
    expect(fitForRank({ ai: 100, estimate: 100 })).toBe(100);
    expect(fitForRank({ ai: 0, estimate: 0 })).toBe(0);
    expect(fitForRank({ ai: Number.NaN, estimate: 60 })).toBe(60);
  });

  it('fit input with the market\'s calibration map: the AI score when there is one, else map(estimate)', () => {
    const knots = { knots: [[0, 0], [100, 60]] as Array<[number, number]> };
    const map = (estimate: number) => applyMap(knots, estimate);
    expect(fitForRank({ ai: 70, estimate: 60, map })).toBe(70);
    expect(fitForRank({ ai: null, estimate: 80, map })).toBe(48);
    expect(fitForRank({ ai: null, estimate: null, map })).toBeNull();
    expect(fitForRank({ ai: 70, estimate: null, map })).toBe(70);
    // A map that leaves the range is clamped.
    expect(fitForRank({ estimate: 50, map: () => 140 })).toBe(100);
  });

  it('pairwise (invariant 8): of two jobs of equal quality, the scored one never ranks below the other for being scored', () => {
    const row = feedRow({ id: 'same', postedAt: hoursAgo(10) });
    for (const quality of [30, 55, 64, 65, 79, 80, 92]) {
      // Equal quality: the AI score of the scored job equals the estimate both jobs have.
      const scored = fitForRank({ ai: quality, estimate: quality });
      const unscored = fitForRank({ ai: null, estimate: quality });
      expect(scored, String(quality)).toBe(unscored);
      expect(recommendedRank(row, scored, rc()), String(quality)).toBe(recommendedRank(row, unscored, rc()));
      const cands: Candidate[] = [
        { row: feedRow({ id: 'unscored', postedAt: hoursAgo(10) }), badge: null, fit: unscored, rank: recommendedRank(row, unscored, rc()) },
        { row: feedRow({ id: 'scored', postedAt: hoursAgo(10) }), badge: null, fit: scored, rank: recommendedRank(row, scored, rc()) },
      ];
      // Tied on rank and date: the order is the id tie-break, in both sorts, not "scored last".
      expect(sortCandidates([...cands], 'recommended').map((c) => c.row.id)).toEqual(sortCandidates([...cands].reverse(), 'recommended').map((c) => c.row.id));
      expect(sortCandidates([...cands], 'best_fit').map((c) => c.row.id)).toEqual(sortCandidates([...cands].reverse(), 'best_fit').map((c) => c.row.id));
    }
    // And with a map both are on the AI scale: the scored job at its AI score, the other at the mapped estimate.
    const knots = { knots: [[0, 0], [100, 100]] as Array<[number, number]> };
    expect(fitForRank({ ai: 70, estimate: 70, map: (x) => applyMap(knots, x) })).toBe(fitForRank({ estimate: 70, map: (x) => applyMap(knots, x) }));
    // The old rule (ai ?? estimate − 5) is gone: an unscored job is not 5 points down.
    expect(fitForRank({ estimate: 90 })).toBe(90);
  });

  it('the ranking input of a Fit: its AI score blended with its own estimate, or the estimate', () => {
    const base = { job: jobRecord(), user: matchUser(), resume: { id: 'v1', resumeContentHash: 'hash-1' }, config: { weights: { ...DEFAULT_MATCH_WEIGHTS }, tiers: { ...DEFAULT_MATCH_TIERS }, priors: { ...DEFAULT_MATCH_PRIORS } }, pin: currentScorerPin('roboapply', 'm'), now: NOW };
    const estimate = assembleFit(base);
    expect(estimate.kind).toBe('estimate');
    expect(rankFitOf(estimate)).toBe(estimate.score);
    const stored = { resumeVariantId: 'v1', score: 60, tier: 'possible', dimensions: [{ key: 'title_level' as const, weight: 35, score: 60, status: 'scored' as const, evidence: [] }], generatedAt: NOW, modelUsed: 'm', promptVersion: 'scorer_v3', jobContentHash: null, rubricVersion: 'fit_v3', searchProfileVersion: 1, resumeContentHashAtScore: 'hash-1' };
    const ai = assembleFit({ ...base, stored });
    expect(ai).toMatchObject({ kind: 'ai', score: 60, estimateScore: estimate.score });
    expect(rankFitOf(ai)).toBe(estimate.score! + 0.5 * (60 - estimate.score!));
    expect(rankFitOf(ai, (x) => x / 2)).toBe(60);
    expect(rankFitOf(estimate, (x) => x / 2)).toBe(estimate.score! / 2);
    expect(rankFitOf(null)).toBeNull();
  });

  const curve = (h: number) => 100 * (0.7 * Math.exp(-h / 48) + 0.3 * Math.exp(-h / 336));

  it('freshness = 100·(0.7·e^(−h/48) + 0.3·e^(−h/336)): the values at 0, 48, 240 and 960 hours', () => {
    expect(freshness(NOW, null, NOW)).toBe(100);
    expect(freshness(hoursAgo(48), null, NOW)).toBeCloseTo(51.76, 2);
    expect(freshness(hoursAgo(240), null, NOW)).toBeCloseTo(15.16, 2);
    expect(freshness(hoursAgo(960), null, NOW)).toBeCloseTo(1.72, 2);
    for (const h of [0, 48, 240, 960]) expect(freshness(hoursAgo(h), null, NOW)).toBeCloseTo(curve(h), 10);
    // Undated jobs count from when we first saw them; a job with neither date has no freshness.
    expect(freshness(null, hoursAgo(72), NOW)).toBeCloseTo(curve(72), 10);
    expect(freshness(null, null, NOW)).toBe(0);
    // A date in the future is "now", never above 100.
    expect(freshness(new Date(NOW.getTime() + 3_600_000), null, NOW)).toBe(100);
  });

  it('a 10-day-old job still outranks a 40-day-old one on freshness (the old curve tied them at zero)', () => {
    const ten = freshness(hoursAgo(10 * 24), null, NOW);
    const forty = freshness(hoursAgo(40 * 24), null, NOW);
    expect(Math.round(ten)).toBe(15);
    expect(Math.round(forty)).toBe(2);
    // With every other factor equal the 10-day-old job ranks first.
    const row = (id: string, days: number) => feedRow({ id, postedAt: hoursAgo(days * 24), firstSeenAt: hoursAgo(days * 24), lastSeenAt: hoursAgo(1) });
    const cands: Candidate[] = [row('forty', 40), row('ten', 10)].map((r) => ({ row: r, badge: null, fit: 70, rank: recommendedRank(r, 70, rc()) }));
    expect(cands[1]!.rank - cands[0]!.rank).toBeCloseTo(0.2 * (ten - forty), 2);
    expect(sortCandidates(cands, 'recommended').map((c) => c.row.id)).toEqual(['ten', 'forty']);
  });

  it('freshness only ever falls with age', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let h = 0; h <= 24 * 130; h += 6) {
      const f = freshness(hoursAgo(h), null, NOW);
      expect(f, `${h} h`).toBeLessThan(previous);
      expect(f).toBeGreaterThan(0);
      previous = f;
    }
  });

  it('a post its source stopped listing counts from when it was last seen', () => {
    const day = 24;
    // Posted yesterday, last seen 20 days ago: it scores as 20 days old.
    expect(freshness(hoursAgo(day), null, NOW, hoursAgo(20 * day))).toBeCloseTo(curve(20 * day), 10);
    expect(freshness(hoursAgo(day), null, NOW, hoursAgo(20 * day))).toBeLessThan(freshness(hoursAgo(day), null, NOW));
    // Still listed (seen within 48 hours): the posting date alone.
    expect(freshness(hoursAgo(day), null, NOW, hoursAgo(47))).toBeCloseTo(curve(day), 10);
    expect(freshness(hoursAgo(day), null, NOW, hoursAgo(1))).toBeCloseTo(curve(day), 10);
    // The larger of the two: last seen 3 days ago never makes a 30-day-old post fresher.
    expect(freshness(hoursAgo(30 * day), null, NOW, hoursAgo(3 * day))).toBeCloseTo(curve(30 * day), 10);
    // No last-seen date: the posting date.
    expect(freshness(hoursAgo(day), null, NOW, null)).toBeCloseTo(curve(day), 10);
    // The rank reads the row's own lastSeenAt.
    const listed = feedRow({ id: 'listed', postedAt: hoursAgo(day), lastSeenAt: hoursAgo(2) });
    const gone = feedRow({ id: 'gone', postedAt: hoursAgo(day), lastSeenAt: hoursAgo(20 * day) });
    expect(recommendedRank(listed, 70, rc()) - recommendedRank(gone, 70, rc())).toBeCloseTo(0.2 * (curve(day) - curve(20 * day)), 2);
  });

  it('source quality is posting completeness (25 each), nothing about where it came from', () => {
    expect(sourceQuality(feedRow({ id: 'a', salaryDisclosed: true, atsType: 'lever', postedAtEstimated: false, descriptionLength: 900 }))).toBe(100);
    expect(sourceQuality(feedRow({ id: 'b', salaryDisclosed: false, atsType: 'other', postedAtEstimated: true, descriptionLength: 100 }))).toBe(0);
  });

  it('rank = 0.55·fit + 0.20·freshness + 0.15·affinity + 0.10·quality (+ goal)', () => {
    const row = feedRow({ id: 'r', postedAt: hoursAgo(72), salaryDisclosed: false, atsType: 'greenhouse', descriptionLength: 1000 });
    const expected = 0.55 * 80 + 0.2 * curve(72) + 0.15 * 50 + 0.1 * 75;
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

  it('fit-tier view: great ≥80, good ≥65; a job with no fit passes', () => {
    const t = DEFAULT_MATCH_TIERS;
    // An AI badge whose tier is the tier of its number (a new model result takes its own tier).
    const b = (score: number) => ({ tier: tierOf(score, t), score, kind: 'ai' as const, topGap: null, topOverlap: null });
    expect(passesTier(b(79), 'great', t)).toBe(false);
    expect(passesTier(b(80), 'great', t)).toBe(true);
    expect(passesTier(b(64), 'good', t)).toBe(false);
    expect(passesTier(b(65), 'good', t)).toBe(true);
    expect(passesTier(null, 'great', t)).toBe(true);
    expect(passesTier(b(10), 'all', t)).toBe(true);
    expect(passesTier(b(10), undefined, t)).toBe(true);
  });

  it('fit-tier view: an AI score is judged by the tier its card shows, so the card and the view agree (hysteresis)', () => {
    const t = DEFAULT_MATCH_TIERS;
    const ai = (tier: 'unlikely' | 'possible' | 'good' | 'great', score: number) => ({ tier, score, kind: 'ai' as const, topGap: null, topOverlap: null });
    // Stored tier Good, recomputed total 81 (1 point over the Great edge keeps Good): the card says Good, so it is
    // listed under "Good or better" and not under "Great".
    expect(passesTier(ai('good', 81), 'great', t)).toBe(false);
    expect(passesTier(ai('good', 81), 'good', t)).toBe(true);
    // Stored tier Great, recomputed total 79: the card says Great, so the Great view lists it.
    expect(passesTier(ai('great', 79), 'great', t)).toBe(true);
    expect(passesTier(ai('great', 79), 'good', t)).toBe(true);
    // The same at the Good edge.
    expect(passesTier(ai('possible', 66), 'good', t)).toBe(false);
    expect(passesTier(ai('good', 64), 'good', t)).toBe(true);
    expect(passesTier(ai('good', 64), 'great', t)).toBe(false);
  });

  it('fit-tier view: a quick estimate passes only at the threshold AND with confidence that is not low', () => {
    const t = DEFAULT_MATCH_TIERS;
    const pre = (score: number, confidence: 'high' | 'medium' | 'low' | undefined) => ({ tier: 'great' as const, score, kind: 'pre' as const, topGap: null, topOverlap: null, ...(confidence ? { confidence } : {}) });
    // A low-confidence estimate of 82 is not shown as Great, nor as Good or better.
    expect(passesTier(pre(82, 'low'), 'great', t)).toBe(false);
    expect(passesTier(pre(82, 'low'), 'good', t)).toBe(false);
    expect(passesTier(pre(82, 'medium'), 'great', t)).toBe(true);
    expect(passesTier(pre(82, 'high'), 'great', t)).toBe(true);
    expect(passesTier(pre(70, 'medium'), 'good', t)).toBe(true);
    expect(passesTier(pre(70, 'medium'), 'great', t)).toBe(false);
    // Reaching the threshold is still required.
    expect(passesTier(pre(64, 'high'), 'good', t)).toBe(false);
    // The "all" view shows everything.
    expect(passesTier(pre(82, 'low'), 'all', t)).toBe(true);
    // An AI-scored row passes on the tier its card shows, whatever the confidence says.
    expect(passesTier({ ...pre(82, 'low'), kind: 'ai' as const }, 'great', t)).toBe(true);
    // A badge with no confidence (written before estimate v2) is not treated as low.
    expect(passesTier(pre(82, undefined), 'great', t)).toBe(true);
  });

  it('the card shows the fit every surface reads: the AI score when it can be shown, else the quick estimate, with its confidence', () => {
    const fit = (over: Partial<Fit>): Fit =>
      ({
        jobId: 'j', score: 70, tier: 'good', kind: 'estimate', coverage: 0.65, confidence: 'medium', confidenceReason: null, dimensions: [], requirements: [], topOverlap: 'Python', topGap: 'Kubernetes',
        basis: { resumeVariantId: 'v1', resumeContentHash: 'h', jobContentHash: 'j', searchProfileVersion: 1 }, version: { rubric: 'fit_v3', estimator: 'est_v2', model: null, prompt: null },
        scoredAt: NOW.toISOString(), stale: false, calibrated: false, estimateScore: 70, estimateReason: null, skills: { aligned: ['Python'], missing: ['Kubernetes'], softSkills: [], listed: 2 }, prose: null, cached: false,
        ...over,
      }) as Fit;
    expect(fitBadge(fit({ kind: 'ai', score: 88, tier: 'great', confidence: 'high' }))).toEqual({ tier: 'great', score: 88, kind: 'ai', topGap: 'Kubernetes', topOverlap: 'Python', confidence: 'high', confidenceReason: null });
    // An estimate keeps the wire kind `pre`.
    expect(fitBadge(fit({}))).toEqual({ tier: 'good', score: 70, kind: 'pre', topGap: 'Kubernetes', topOverlap: 'Python', confidence: 'medium', confidenceReason: null });
    expect(fitBadge(fit({ confidence: 'low', confidenceReason: 'no_skills_listed' }))).toMatchObject({ kind: 'pre', confidence: 'low', confidenceReason: 'no_skills_listed' });
    // The stored tier of an AI fit is shown as it is (it moves only 3 points past an edge).
    expect(fitBadge(fit({ kind: 'ai', score: 81, tier: 'good' }))).toMatchObject({ score: 81, tier: 'good' });
    // Nothing comparable: no badge.
    expect(fitBadge(fit({ score: null, tier: null }))).toBeNull();
    expect(fitBadge(null)).toBeNull();
  });
});

describe('ordering rules (ORDERING_RULES, listed on /help/ranking)', () => {
  it('are documented with their trigger', () => {
    expect(ORDERING_RULES.map((r) => r.key)).toEqual(['sponsorship_first', 'skills_boost', 'wrong_title', 'seen_skipped', 'same_role_collapse']);
    expect(ORDERING_RULES.find((r) => r.key === 'skills_boost')!.points).toBe(10);
    for (const r of ORDERING_RULES) {
      expect(r.when.length, r.key).toBeGreaterThan(10);
      expect(r.what.length, r.key).toBeGreaterThan(10);
    }
  });

  it('seen and skipped: 5 points at three impressions, 7.5 at four, 10 from five on, only for a job never opened', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 99].map((n) => seenSkippedPenalty(n))).toEqual([0, 0, 0, 5, 7.5, 10, 10, 10]);
    expect(seenSkippedPenalty(null)).toBe(0);
    expect(seenSkippedPenalty(undefined)).toBe(0);
    expect(seenSkippedPenalty(Number.NaN)).toBe(0);
    const row = feedRow({ id: 'seen' });
    const plain = recommendedRank(row, 70, rc());
    // The service lists only jobs the person never opened in `seenSkipped`.
    expect(plain - recommendedRank(row, 70, rc({ seenSkipped: new Map([['seen', 3]]) }))).toBeCloseTo(5, 3);
    expect(plain - recommendedRank(row, 70, rc({ seenSkipped: new Map([['seen', 4]]) }))).toBeCloseTo(7.5, 3);
    expect(plain - recommendedRank(row, 70, rc({ seenSkipped: new Map([['seen', 5]]) }))).toBeCloseTo(10, 3);
    expect(plain - recommendedRank(row, 70, rc({ seenSkipped: new Map([['seen', 12]]) }))).toBeCloseTo(10, 3);
    // Another job's impressions, two impressions, or no map: nothing is taken away.
    expect(recommendedRank(row, 70, rc({ seenSkipped: new Map([['other', 9]]) }))).toBe(plain);
    expect(recommendedRank(row, 70, rc({ seenSkipped: new Map([['seen', 2]]) }))).toBe(plain);
    expect(recommendedRank(row, 70, rc({ seenSkipped: null }))).toBe(plain);
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

describe('the fused retrieval position breaks ties, after the date and before the id', () => {
  const same = hoursAgo(5);
  const cand = (id: string, over: Partial<Candidate> = {}): Candidate => ({ row: feedRow({ id, postedAt: same }), badge: null, fit: 70, rank: 60, ...over });

  it('equal rank and equal date: the row the legs placed higher comes first, under every sort', () => {
    for (const sort of ['recommended', 'best_fit', 'newest', 'highest_pay', 'deadline'] as const) {
      const cands = [cand('z', { retrievalRank: 7 }), cand('a', { retrievalRank: 2 }), cand('m', { retrievalRank: 4 })];
      expect(sortCandidates(cands, sort).map((c) => c.row.id), sort).toEqual(['a', 'm', 'z']);
    }
  });

  it('never outranks the sort key or the date; a row without a position follows those that have one; then the id', () => {
    // A better rank wins whatever the retrieval position.
    expect(sortCandidates([cand('a', { retrievalRank: 0, rank: 50 }), cand('b', { retrievalRank: 300, rank: 51 })], 'recommended').map((c) => c.row.id)).toEqual(['b', 'a']);
    // A newer posting wins over a better retrieval position.
    const newer: Candidate = { ...cand('n', { retrievalRank: 300 }), row: feedRow({ id: 'n', postedAt: hoursAgo(1) }) };
    expect(sortCandidates([cand('o', { retrievalRank: 0 }), newer], 'recommended').map((c) => c.row.id)).toEqual(['n', 'o']);
    // A row of an older refill window has no position.
    expect(sortCandidates([cand('late'), cand('placed', { retrievalRank: 399 })], 'recommended').map((c) => c.row.id)).toEqual(['placed', 'late']);
    // Neither has one: the id, descending, as before.
    expect(sortCandidates([cand('a'), cand('b')], 'newest').map((c) => c.row.id)).toEqual(['b', 'a']);
  });
});

describe('reciprocal rank fusion of the retrieval legs', () => {
  const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

  it('scores a row Σ 1 / (60 + rank) over the legs that returned it', () => {
    const fused = fuseByReciprocalRank([['a', 'b', 'c'], ['b', 'd'], ['c', 'b']]);
    const score = Object.fromEntries(fused.map((f) => [f.id, f.score]));
    expect(score.a).toBeCloseTo(1 / 61, 12);
    expect(score.b).toBeCloseTo(1 / 62 + 1 / 61 + 1 / 62, 12);
    expect(score.c).toBeCloseTo(1 / 63 + 1 / 61, 12);
    expect(score.d).toBeCloseTo(1 / 62, 12);
    expect(ids(fused)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('a job in two legs outranks a job in one leg at the same positions', () => {
    const fused = fuseByReciprocalRank([['one', 'both'], ['x', 'both'], []]);
    expect(ids(fused).indexOf('both')).toBeLessThan(ids(fused).indexOf('one'));
    // Even the best single-leg position (1/61) loses to two modest ones (2/100).
    const deep = Array.from({ length: 39 }, (_, i) => `f${i}`);
    expect(ids(fuseByReciprocalRank([['top'], [...deep, 'twice'], [...deep.map((d) => `g${d}`), 'twice']]))[0]).toBe('twice');
  });

  it('disjoint legs interleave by position; ties go to the newer row, then to the id', () => {
    const posted: Record<string, number> = { a1: 3, b1: 9, c1: 5, a2: 1, b2: 1, c2: 1 };
    const fused = fuseByReciprocalRank([['a1', 'a2'], ['b1', 'b2'], ['c1', 'c2']], { newer: (x, y) => posted[y]! - posted[x]! });
    // Rank 1 of each leg ties on 1/61: newest first. Rank 2 ties on 1/62 and on the date: id descending.
    expect(ids(fused)).toEqual(['b1', 'c1', 'a1', 'c2', 'b2', 'a2']);
  });

  it('caps the union (400 by default) and keeps the best', () => {
    const leg = (p: string) => Array.from({ length: 200 }, (_, i) => `${p}${String(i).padStart(3, '0')}`);
    const fused = fuseByReciprocalRank([leg('a'), leg('b'), leg('c')]);
    expect(fused).toHaveLength(400);
    // 600 distinct rows: each leg keeps its best 133 or 134, never its last.
    expect(ids(fused)).toContain('a000');
    expect(ids(fused)).not.toContain('a199');
    expect(ids(fused)).not.toContain('c199');
    expect(fuseByReciprocalRank([leg('a'), leg('b')], { cap: 10 })).toHaveLength(10);
    // Overlapping legs: the union is what it is, below the cap.
    expect(fuseByReciprocalRank([leg('a'), leg('a'), leg('a')])).toHaveLength(200);
  });

  it('a missing or empty leg is left out: the result is the fusion of the others', () => {
    const two = fuseByReciprocalRank([['a', 'b'], ['b', 'c']]);
    expect(fuseByReciprocalRank([['a', 'b'], ['b', 'c'], []])).toEqual(two);
    expect(fuseByReciprocalRank([['a', 'b'], ['b', 'c'], null])).toEqual(two);
    expect(fuseByReciprocalRank([['a', 'b'], ['b', 'c'], undefined])).toEqual(two);
    expect(ids(fuseByReciprocalRank([['a', 'b'], null, null]))).toEqual(['a', 'b']);
    expect(fuseByReciprocalRank([])).toEqual([]);
    // A leg that names a row twice counts its first position.
    expect(fuseByReciprocalRank([['a', 'a', 'b']])).toEqual(fuseByReciprocalRank([['a', 'b']]));
  });
});

describe('the same role in several places collapses into one card', () => {
  const at = (id: string, location: string | null, over: Record<string, unknown> = {}) => ({
    row: feedRow({ id, title: 'Sales Engineer', titleNormalized: 'sales engineer', companyName: 'Acme', companyNameNormalized: 'acme', location, locationCity: null, ...over }),
  });
  const cardIds = (out: { cards: Array<{ row: { id: string } }> }) => out.cards.map((c) => c.row.id);
  const folded = (out: { also: Map<string, Array<{ row: { id: string } }>> }) => Object.fromEntries([...out.also].map(([k, v]) => [k, v.map((c) => c.row.id)]));

  it('three rows of one company and title in three cities: the best ranked is the card, the other two are folded into it', () => {
    const out = collapseSameRole([at('austin', 'Austin, TX'), at('denver', 'Denver, CO'), at('seattle', 'Seattle, WA')]);
    expect(cardIds(out)).toEqual(['austin']);
    expect(folded(out)).toEqual({ austin: ['denver', 'seattle'] });
  });

  it('the same title at another company, or another title at the same company, stays a card', () => {
    const out = collapseSameRole([
      at('a', 'Austin, TX'),
      at('other-co', 'Denver, CO', { companyName: 'Globex', companyNameNormalized: 'globex' }),
      at('other-title', 'Denver, CO', { title: 'Sales Manager', titleNormalized: 'sales manager' }),
      at('b', 'Boston, MA'),
    ]);
    expect(cardIds(out)).toEqual(['a', 'other-co', 'other-title']);
    expect(folded(out)).toEqual({ a: ['b'] });
  });

  it('a posting for the same place, or with no place, stays a card: "N more locations" never counts a city twice', () => {
    const out = collapseSameRole([at('a', 'Austin, TX'), at('a-again', ' austin,  tx '), at('b', 'Boston, MA'), at('b-again', 'Boston, MA'), at('nowhere', null)]);
    expect(cardIds(out)).toEqual(['a', 'a-again', 'b-again', 'nowhere']);
    expect(folded(out)).toEqual({ a: ['b'] });
    expect(placeOf(feedRow({ id: 'x', location: null, locationCity: 'Taipei' }))).toBe('Taipei');
    expect(placeOf(feedRow({ id: 'x', location: '  ', locationCity: null }))).toBeNull();
  });

  it('never folds a private import, a row with no company or title key, or rows of two markets', () => {
    expect(sameRoleKey(feedRow({ id: 'p', visibility: 'private', ownerUserId: 'u1' }))).toBeNull();
    expect(sameRoleKey(feedRow({ id: 'c', companyNameNormalized: '' }))).toBeNull();
    expect(sameRoleKey(feedRow({ id: 't', titleNormalized: '  ' }))).toBeNull();
    expect(sameRoleKey(feedRow({ id: 'i', market: 'intl' }))).not.toBe(sameRoleKey(feedRow({ id: 'i', market: 'cn' })));
    const out = collapseSameRole([
      at('public', 'Austin, TX'),
      at('mine', 'Denver, CO', { visibility: 'private', ownerUserId: 'u1', sourceBoard: 'user_import' }),
      at('cn', '上海', { market: 'cn' }),
      at('no-company', 'Reno, NV', { companyNameNormalized: '' }),
    ]);
    expect(cardIds(out)).toEqual(['public', 'mine', 'cn', 'no-company']);
    expect(out.also.size).toBe(0);
  });

  it('a later window folds into the card the session already has, and skips the places it already covers', () => {
    const first = collapseSameRole([at('austin', 'Austin, TX'), at('denver', 'Denver, CO')]);
    expect(cardIds(first)).toEqual(['austin']);
    const taken = new Map([[sameRoleKey(at('austin', 'Austin, TX').row)!, { cardId: 'austin', places: new Set(['austin, tx', 'denver, co']) }]]);
    const refill = collapseSameRole([at('reno', 'Reno, NV'), at('denver-old', 'Denver, CO'), at('other', 'Miami, FL', { companyNameNormalized: 'globex' })], taken);
    expect(cardIds(refill)).toEqual(['denver-old', 'other']);
    expect(folded(refill)).toEqual({ austin: ['reno'] });
  });

  it('a card holds at most `maxFolded` other places: the next place is a card of its own and takes the places after it', () => {
    const rows = Array.from({ length: 8 }, (_, i) => at(`p${i}`, `City ${i}, TX`));
    const out = collapseSameRole(rows, new Map(), 3);
    // p0 names p1 p2 p3; p4 starts the next card and names p5 p6 p7. Every posting is a card or a named place.
    expect(cardIds(out)).toEqual(['p0', 'p4']);
    expect(folded(out)).toEqual({ p0: ['p1', 'p2', 'p3'], p4: ['p5', 'p6', 'p7'] });
    // No limit given: one card, as before.
    expect(cardIds(collapseSameRole(rows))).toEqual(['p0']);
    // A card an earlier window filled takes no more: the fresh place is a card.
    const key = sameRoleKey(rows[0]!.row)!;
    const full = new Map([[key, { cardId: 'p0', places: new Set(['city 0, tx', 'city 1, tx', 'city 2, tx', 'city 3, tx']), folded: 3 }]]);
    const refill = collapseSameRole([at('p8', 'City 8, TX'), at('p9', 'City 9, TX')], full, 3);
    expect(cardIds(refill)).toEqual(['p8']);
    expect(folded(refill)).toEqual({ p8: ['p9'] });
    // One with room left takes what fits.
    const room = new Map([[key, { cardId: 'p0', places: new Set(['city 0, tx', 'city 1, tx', 'city 2, tx']), folded: 2 }]]);
    const more = collapseSameRole([at('p8', 'City 8, TX'), at('p9', 'City 9, TX')], room, 3);
    expect(cardIds(more)).toEqual(['p9']);
    expect(folded(more)).toEqual({ p0: ['p8'] });
  });
});
