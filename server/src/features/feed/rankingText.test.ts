// @vitest-environment node
//
// The published texts of the Recommended order (rankingText.ts). The frozen
// copies below are what /help/ranking publishes since the ranking refinements
// of MKT-4F (freshness with a slow tail; the wrong-title, seen-and-skipped and
// same-role rules): a test that fails here means the published text changed,
// and the page copy (`landing.ranking.*`) and its mirror
// (components/features/marketing/catalog.ts) must change with it.

import { describe, expect, it } from 'vitest';
import * as contract from './contract.js';
import { AFFINITY_DELTAS, EMPTY_AFFINITY, affinityScore, applyAffinity } from './affinity.js';
import { freshness, seenSkippedPenalty } from './ranking.js';
import { ALSO_IN_MAX, FRESHNESS_CURVE, GOAL_ADJUSTMENTS, ORDERING_RULES, RANKING_FACTORS, SEEN_SKIPPED, WRONG_TITLE_WEIGHT } from './rankingText.js';

const FROZEN_RANKING_FACTORS = [
  { key: 'fit', weight: 0.55, what: 'Fit score: the AI score when one exists, otherwise the quick estimate. Both are on the same scale. Until a market has enough scored jobs to line the two up, a job with an AI score is ranked halfway between its quick estimate and its AI score.' },
  {
    key: 'freshness',
    weight: 0.2,
    what: 'How recently the job was posted: 100 × (0.7 × e^(−hours / 48) + 0.3 × e^(−hours / 336)); a post no longer listed by its source counts from when it was last seen.',
  },
  { key: 'affinity', weight: 0.15, what: 'Your own actions: saving, applying and hiding jobs, and companies you marked as preferred; fades 2% a day.' },
  { key: 'source_quality', weight: 0.1, what: 'How complete the posting is: pay listed, a known application system, a real posting date, a detailed description.' },
];

const FROZEN_ORDERING_RULES = [
  {
    key: 'sponsorship_first',
    points: null,
    when: 'You said you need visa sponsorship (RoboApply).',
    what: 'Jobs whose posting mentions sponsorship come first, in the order you chose; jobs whose posting says it does not sponsor are hidden.',
  },
  {
    key: 'skills_boost',
    points: 10,
    when: 'Skills is the only filter that narrows your list.',
    what: 'Jobs that require more of your chosen skills rank higher in Recommended: up to 10 points, in proportion to how many of them the job asks for.',
  },
  {
    key: 'wrong_title',
    points: null,
    when: 'You marked a job "Not interested: wrong title".',
    what: 'Each time you do it, the weight of that role and the weight of that title each go down by 0.25 (weights run from −1 to 1); this fades 2% a day. The "your own actions" factor is the average of the role, company and skills weights, and of the title weight when it is below zero. A title is only ever moved down this way, never up, and your filters are not changed.',
  },
  {
    key: 'seen_skipped',
    points: -10,
    when: 'A job was in your list on three or more visits and you never opened it.',
    what: 'It ranks lower in Recommended: 5 points after three visits, 7.5 after four and 10 from five on.',
  },
  {
    key: 'same_role_collapse',
    points: null,
    when: 'A company posts the same role in several places.',
    what: 'You see one card, the best ranked of those postings, and it lists the other places, at most ten. A posting for the same place, or for an eleventh other place, stays a card of its own.',
  },
];

const FROZEN_GOAL_ADJUSTMENTS = {
  more_senior: { points: 6, when: 'The job is above the lowest level you selected.' },
  management: { points: 6, when: 'The job manages people (role type or title).' },
  higher_pay: { points: 6, when: 'The listed pay is above your minimum, in the same currency.' },
  flexibility: { points: 4, when: 'The job is remote or hybrid.' },
  new_industry: { points: 0, when: 'No adjustment.' },
  different_role: { points: 0, when: 'No adjustment.' },
  learn_skills: { points: 0, when: 'No adjustment.' },
  work_life_balance: { points: 0, when: 'No adjustment.' },
  job_security: { points: 0, when: 'No adjustment.' },
};

describe('published ranking texts', () => {
  it('deep-equal the published values', () => {
    expect(RANKING_FACTORS).toEqual(FROZEN_RANKING_FACTORS);
    expect(ORDERING_RULES).toEqual(FROZEN_ORDERING_RULES);
    expect(GOAL_ADJUSTMENTS).toEqual(FROZEN_GOAL_ADJUSTMENTS);
    // Key order is part of what the page lists.
    expect(Object.keys(GOAL_ADJUSTMENTS)).toEqual(Object.keys(FROZEN_GOAL_ADJUSTMENTS));
    expect(JSON.stringify(RANKING_FACTORS)).toBe(JSON.stringify(FROZEN_RANKING_FACTORS));
    expect(JSON.stringify(ORDERING_RULES)).toBe(JSON.stringify(FROZEN_ORDERING_RULES));
  });

  it('are the very objects the feed contract exports under the same three names', () => {
    expect(contract.RANKING_FACTORS).toBe(RANKING_FACTORS);
    expect(contract.ORDERING_RULES).toBe(ORDERING_RULES);
    expect(contract.GOAL_ADJUSTMENTS).toBe(GOAL_ADJUSTMENTS);
  });

  it('the weights still add up to 1', () => {
    expect(RANKING_FACTORS.reduce((sum, f) => sum + f.weight, 0)).toBeCloseTo(1, 10);
  });

  it('the freshness text is the curve the ranking code computes, constant for constant', () => {
    expect(FRESHNESS_CURVE).toEqual({ fastHours: 48, slowHours: 336, fastShare: 0.7, staleAfterHours: 48 });
    const what = RANKING_FACTORS.find((f) => f.key === 'freshness')!.what;
    expect(what).toContain(`${FRESHNESS_CURVE.fastShare} × e^(−hours / ${FRESHNESS_CURVE.fastHours})`);
    expect(what).toContain(`${Math.round((1 - FRESHNESS_CURVE.fastShare) * 10) / 10} × e^(−hours / ${FRESHNESS_CURVE.slowHours})`);
    expect(what).not.toContain('/ 72');
    // The code: the published formula at 100 hours.
    const now = new Date('2026-10-10T12:00:00Z');
    const posted = new Date(now.getTime() - 100 * 3_600_000);
    expect(freshness(posted, null, now)).toBeCloseTo(100 * (0.7 * Math.exp(-100 / 48) + 0.3 * Math.exp(-100 / 336)), 10);
  });

  it('the old constant is gone from the feed limits (ranking.ts was its only reader)', () => {
    expect('freshnessHalfLifeHours' in contract.FEED_LIMITS).toBe(false);
  });

  it('the numbers in the rule texts are the numbers the code applies', () => {
    const rule = (key: string) => ORDERING_RULES.find((r) => r.key === key)!;
    // Wrong title: the published weight is the affinity delta of the event.
    expect(WRONG_TITLE_WEIGHT).toBe(-0.25);
    expect(AFFINITY_DELTAS.wrong_title).toBe(WRONG_TITLE_WEIGHT);
    // The text states the change of each WEIGHT and how the factor is built from the weights. It does not say
    // the factor itself moves by 0.25: one mark moves it by 0.25 / 3 (same role) or 0.5 / 4 (same role and title).
    expect(rule('wrong_title').what).toContain('the weight of that role and the weight of that title each go down by 0.25');
    expect(rule('wrong_title').what).toContain('is the average of the role, company and skills weights, and of the title weight when it is below zero');
    expect(rule('wrong_title').what).not.toMatch(/count 0\.25 lower/);
    expect(rule('wrong_title').what).toContain('fades 2% a day');
    const neutral = affinityScore(EMPTY_AFFINITY, { taxonomy: 'r', company: 'c', skills: ['s'], title: 't' });
    const marked = applyAffinity(EMPTY_AFFINITY, { taxonomy: 'r', company: 'c', skills: ['s'], title: 't' }, AFFINITY_DELTAS.wrong_title, new Date('2026-10-10T12:00:00Z'), 'wrong_title');
    expect(neutral - affinityScore(marked, { taxonomy: 'r', company: 'other', skills: ['x'], title: 'another title' })).toBeCloseTo((50 * 0.25) / 3, 1);
    expect(neutral - affinityScore(marked, { taxonomy: 'r', company: 'other', skills: ['x'], title: 't' })).toBeCloseTo((50 * 0.5) / 4, 1);
    // Same role, several places: the card's limit is the one the code applies.
    expect(rule('same_role_collapse').what).toContain('at most ten');
    expect(ALSO_IN_MAX).toBe(10);
    // Seen and skipped: 5 at three, 7.5 at four, 10 from five on; the entry's points are the most it takes away.
    expect(SEEN_SKIPPED).toEqual({ fromImpressions: 3, points: [5, 7.5, 10] });
    expect([0, 1, 2, 3, 4, 5, 6, 40].map((n) => seenSkippedPenalty(n))).toEqual([0, 0, 0, 5, 7.5, 10, 10, 10]);
    expect(rule('seen_skipped').points).toBe(-Math.max(...SEEN_SKIPPED.points));
    expect(rule('seen_skipped').what).toBe('It ranks lower in Recommended: 5 points after three visits, 7.5 after four and 10 from five on.');
    // The exploration slot is not built and not published.
    expect(ORDERING_RULES.map((r) => r.key)).toEqual(['sponsorship_first', 'skills_boost', 'wrong_title', 'seen_skipped', 'same_role_collapse']);
    expect(JSON.stringify(ORDERING_RULES)).not.toMatch(/explor/i);
  });
});

describe('feed contract: retrieval limits, the relevance text, the list order and the "also in" field', () => {
  it('keeps the leg size, the fusion constant and the retrieval limit', () => {
    expect(contract.FEED_LIMITS).toMatchObject({ legLimit: 200, rrfK: 60, retrievalLimit: 400, pageSize: 20, maxAgeDays: 120 });
  });

  it('accepts a relevance text of at most 240 characters on the query body and leaves other bodies as they were', () => {
    const parse = (body: unknown) => contract.FeedQueryBodySchema.safeParse(body);
    expect(parse({}).success).toBe(true);
    expect(parse({ sort: 'newest' }).data).toEqual({ sort: 'newest' });
    expect(parse({ relevance: '  climate startups Rust  ' }).data).toMatchObject({ relevance: 'climate startups Rust' });
    expect(parse({ relevance: 'x'.repeat(240) }).success).toBe(true);
    expect(parse({ relevance: 'x'.repeat(241) }).success).toBe(false);
    expect(parse({ relevance: 7 }).success).toBe(false);
    expect(contract.FEED_RELEVANCE_MAX_CHARS).toBe(240);
  });

  it('types the list order value and the "also in" field', () => {
    const order: contract.FeedOrder = 'query_match';
    const alsoIn: NonNullable<contract.FeedItem['alsoIn']> = { count: 2, locations: ['Berlin', 'Munich'], jobIds: ['a', 'b'] };
    expect(order).toBe('query_match');
    expect(alsoIn.count).toBe(2);
  });
});
