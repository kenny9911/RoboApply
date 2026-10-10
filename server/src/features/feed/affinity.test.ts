// @vitest-environment node
// WP-32: affinity updates with lazy decay (ARCH §4.9).

import { describe, expect, it } from 'vitest';
import { AFFINITY_DELTAS, EMPTY_AFFINITY, affinityKeys, affinityScore, applyAffinity, decayFactor, decayed, readWeights } from './affinity.js';

const T0 = new Date('2026-10-01T00:00:00Z');
const days = (n: number) => new Date(T0.getTime() + n * 86_400_000);
const job = { primaryTaxonomyId: 'backend_engineer', taxonomyIds: ['a', 'b', 'backend_engineer'], companyNameNormalized: 'acme', skills: ['Python', 'SQL', 'Go', 'Rust'] };

describe('affinity', () => {
  it('deltas: save +0.1, apply click +0.15, applied +0.25, hide −0.1', () => {
    expect(AFFINITY_DELTAS).toEqual({ save: 0.1, apply_click: 0.15, applied: 0.25, hide: -0.1 });
  });

  it('keys: role, company, first three skills', () => {
    expect(affinityKeys(job)).toEqual({ taxonomy: 'backend_engineer', company: 'acme', skills: ['python', 'sql', 'go'] });
    expect(affinityKeys({ ...job, primaryTaxonomyId: null }).taxonomy).toBe('backend_engineer');
  });

  it('decays ×0.98 per day, lazily (on read and before each write)', () => {
    expect(decayFactor(T0, days(10))).toBeCloseTo(0.98 ** 10, 10);
    const s1 = applyAffinity(EMPTY_AFFINITY, affinityKeys(job), 0.25, T0);
    expect(s1.company.acme).toBeCloseTo(0.25);
    expect(decayed(s1, days(30)).company.acme).toBeCloseTo(0.25 * 0.98 ** 30, 6);
    const s2 = applyAffinity(s1, affinityKeys(job), 0.1, days(30));
    expect(s2.company.acme).toBeCloseTo(0.25 * 0.98 ** 30 + 0.1, 6);
    expect(s2.updatedAt).toEqual(days(30));
  });

  it('clamps to −1..1 and drops negligible weights', () => {
    let s = EMPTY_AFFINITY;
    for (let i = 0; i < 20; i++) s = applyAffinity(s, affinityKeys(job), 0.25, T0);
    expect(s.taxonomy.backend_engineer).toBe(1);
    const faded = decayed(s, days(400));
    expect(faded.company.acme).toBeUndefined();
  });

  it('score is 50 when neutral, rises with liked keys, falls with hidden ones; preferred companies count ≥ +0.5', () => {
    const keys = affinityKeys(job);
    expect(affinityScore(EMPTY_AFFINITY, keys)).toBe(50);
    const liked = applyAffinity(EMPTY_AFFINITY, keys, 0.25, T0);
    const hidden = applyAffinity(EMPTY_AFFINITY, keys, -0.1, T0);
    expect(affinityScore(liked, keys)).toBeGreaterThan(50);
    expect(affinityScore(hidden, keys)).toBeLessThan(50);
    expect(affinityScore(EMPTY_AFFINITY, keys, new Set(['acme']))).toBeCloseTo(50 + (50 * 0.5) / 3, 1);
  });

  it('reads stored JSON defensively', () => {
    expect(readWeights({ a: 0.5, b: 'x', c: 7 })).toEqual({ a: 0.5, c: 1 });
    expect(readWeights(null)).toEqual({});
    expect(readWeights([1])).toEqual({});
  });
});
