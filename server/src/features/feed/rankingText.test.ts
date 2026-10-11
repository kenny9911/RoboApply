// @vitest-environment node
//
// The published ranking texts moved to rankingText.ts without a changed word,
// weight or number (MKT-2H item 7). The frozen copies below were taken from
// contract.ts before the move (commit 0dbe2ef); a test that fails here means
// what /help/ranking publishes changed.

import { describe, expect, it } from 'vitest';
import * as contract from './contract.js';
import { FRESHNESS_CURVE, GOAL_ADJUSTMENTS, ORDERING_RULES, RANKING_FACTORS } from './rankingText.js';

const FROZEN_RANKING_FACTORS = [
  { key: 'fit', weight: 0.55, what: 'Fit score: the AI score when one exists, otherwise the quick estimate. Both are on the same scale. Until a market has enough scored jobs to line the two up, a job with an AI score is ranked halfway between its quick estimate and its AI score.' },
  { key: 'freshness', weight: 0.2, what: 'How recently the job was posted: 100 × e^(−hours since posting / 72).' },
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
  it('deep-equal their values from before the move', () => {
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

  it('carries the freshness curve of phase M4, not read yet: the value in use and its published text are unchanged', () => {
    expect(FRESHNESS_CURVE).toEqual({ fastHours: 48, slowHours: 336, fastShare: 0.7 });
    expect(contract.FEED_LIMITS.freshnessHalfLifeHours).toBe(72);
    expect(RANKING_FACTORS.find((f) => f.key === 'freshness')!.what).toContain('/ 72)');
  });
});

describe('feed contract pre-wiring for phase M4 (additive, unused in this phase)', () => {
  it('adds the leg size and the fusion constant and keeps the retrieval limit', () => {
    expect(contract.FEED_LIMITS).toMatchObject({ legLimit: 200, rrfK: 60, retrievalLimit: 400, pageSize: 20, maxAgeDays: 120, freshnessHalfLifeHours: 72 });
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

  it('types the list order value and the "also in" field (compile-time; nothing sends them yet)', () => {
    const order: contract.FeedOrder = 'query_match';
    const alsoIn: NonNullable<contract.FeedItem['alsoIn']> = { count: 2, locations: ['Berlin', 'Munich'], jobIds: ['a', 'b'] };
    expect(order).toBe('query_match');
    expect(alsoIn.count).toBe(2);
  });
});
