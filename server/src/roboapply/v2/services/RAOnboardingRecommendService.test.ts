// backend/src/roboapply/v2/services/RAOnboardingRecommendService.test.ts
//
// Unit tests for the deterministic salary prefilter — specifically review
// finding #1: a row with a salary amount but an UNKNOWN period (null) must NOT
// be coerced to 'year' and compared against an annual floor (that would drop a
// legitimate weekly/daily-paid external job). Run:
//   npx vitest run server/src/roboapply/v2/services/RAOnboardingRecommendService.test.ts

import { describe, it, expect } from 'vitest';
import { passesPrefilter } from './RAOnboardingRecommendService.js';

function cand(over: Record<string, unknown> = {}): any {
  return {
    titleNormalized: 'software engineer',
    companyName: 'acme',
    description: '',
    workType: 'unknown',
    workTypeKnown: false,
    employmentType: null,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    salaryPeriod: null,
    ...over,
  };
}

const floorDraft = { salary: { min: 80000, currency: 'USD', period: 'year' } } as any;
const NO_TOKENS: string[] = []; // skip the title-token gate to isolate salary logic

describe('passesPrefilter — salary floor', () => {
  it('null row period + amount present → PASS, not compared (review #1)', () => {
    const stats = { salaryCompared: 0 };
    const ok = passesPrefilter(
      cand({ salaryMin: 2000, salaryMax: 2000, salaryCurrency: 'USD', salaryPeriod: null }),
      floorDraft,
      NO_TOKENS,
      stats,
    );
    expect(ok).toBe(true);
    expect(stats.salaryCompared).toBe(0);
  });

  it('matching year period below floor → DROP', () => {
    const stats = { salaryCompared: 0 };
    const ok = passesPrefilter(
      cand({ salaryMax: 50000, salaryCurrency: 'USD', salaryPeriod: 'year' }),
      floorDraft,
      NO_TOKENS,
      stats,
    );
    expect(ok).toBe(false);
    expect(stats.salaryCompared).toBe(1);
  });

  it('matching year period at/above floor → PASS and counts as compared', () => {
    const stats = { salaryCompared: 0 };
    expect(
      passesPrefilter(
        cand({ salaryMax: 120000, salaryCurrency: 'USD', salaryPeriod: 'year' }),
        floorDraft,
        NO_TOKENS,
        stats,
      ),
    ).toBe(true);
    expect(stats.salaryCompared).toBe(1);
  });

  it('currency mismatch → PASS, not compared', () => {
    const stats = { salaryCompared: 0 };
    expect(
      passesPrefilter(
        cand({ salaryMax: 500000, salaryCurrency: 'TWD', salaryPeriod: 'year' }),
        floorDraft,
        NO_TOKENS,
        stats,
      ),
    ).toBe(true);
    expect(stats.salaryCompared).toBe(0);
  });

  it('null salary → PASS, not compared', () => {
    const stats = { salaryCompared: 0 };
    expect(passesPrefilter(cand(), floorDraft, NO_TOKENS, stats)).toBe(true);
    expect(stats.salaryCompared).toBe(0);
  });
});
