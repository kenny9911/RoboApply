// backend/src/roboapply/v2/lib/raBankProviders.test.ts
//
// Unit tests for buildBankJobWhere — the retrieval WHERE must be high-recall:
// ONLY status/published/fresh are hard filters; salary/level/work-mode are
// NEVER SQL cuts (they are ranking weights). [FIX-5 / spec §3.4]

import { describe, it, expect } from 'vitest';
import { __test } from './raBankProviders.js';

const { buildBankJobWhere } = __test;

const cutoff = new Date('2026-06-01T00:00:00.000Z');

describe('buildBankJobWhere', () => {
  const where = buildBankJobWhere({
    titles: ['Backend Engineer', 'Platform Engineer'],
    mustKeywords: ['go', 'postgres'],
    tags: ['lang:go', 'kubernetes'],
    freshnessCutoff: cutoff,
    take: 60,
  }) as Record<string, any>;

  it('only hard-filters on status open + fresh publishedAt', () => {
    expect(where.status).toBe('open');
    expect(where.publishedAt).toEqual({ not: null, gte: cutoff });
  });

  it('never puts salary / level / work-mode in the WHERE (no starvation)', () => {
    const json = JSON.stringify(where);
    expect(json).not.toContain('salaryMin');
    expect(json).not.toContain('salaryMax');
    expect(json).not.toContain('experienceLevel');
    expect(json).not.toContain('workType');
  });

  it('ORs title/keyword/tag signals for recall', () => {
    const or = where.OR as Record<string, any>[];
    expect(or.some((c) => c.title?.contains === 'Backend Engineer')).toBe(true);
    expect(or.some((c) => c.description?.contains === 'go')).toBe(true);
    expect(or.some((c) => c.qualifications?.contains === 'postgres')).toBe(true);
    expect(or.some((c) => Array.isArray(c.requiredTagSet?.hasSome))).toBe(true);
    expect(or.some((c) => Array.isArray(c.preferredTagSet?.hasSome))).toBe(true);
  });

  it('canonicalizes tag forms into hasSome (both bare + namespaced)', () => {
    const or = where.OR as Record<string, any>[];
    const tagClause = or.find((c) => c.requiredTagSet)?.requiredTagSet.hasSome as string[];
    expect(tagClause).toContain('go'); // bare form of lang:go
    expect(tagClause).toContain('kubernetes');
  });

  it('omits the OR block entirely when no signals are given (pure recall by freshness)', () => {
    const bare = buildBankJobWhere({ titles: [], mustKeywords: [], tags: [], freshnessCutoff: cutoff, take: 60 }) as Record<string, any>;
    expect(bare.OR).toBeUndefined();
    expect(bare.status).toBe('open');
  });
});
