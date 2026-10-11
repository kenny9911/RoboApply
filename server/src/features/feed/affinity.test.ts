// @vitest-environment node
// WP-32: affinity updates with lazy decay (ARCH §4.9).
// MKT-4F (SM-12): "wrong title" as a title-level negative, the title map and
// its negative-only rule, canonical skill ids as the skill keys.

import { describe, expect, it } from 'vitest';
import { AFFINITY_DELTAS, EMPTY_AFFINITY, affinityKeys, affinityScore, applyAffinity, decayFactor, decayed, readWeights } from './affinity.js';

const T0 = new Date('2026-10-01T00:00:00Z');
const days = (n: number) => new Date(T0.getTime() + n * 86_400_000);
const job = { primaryTaxonomyId: 'backend_engineer', taxonomyIds: ['a', 'b', 'backend_engineer'], companyNameNormalized: 'acme', skills: ['Python', 'SQL', 'Go', 'Rust'] };

describe('affinity', () => {
  it('deltas: save +0.1, apply click +0.15, applied +0.25, hide −0.1, wrong title −0.25', () => {
    expect(AFFINITY_DELTAS).toEqual({ save: 0.1, apply_click: 0.15, applied: 0.25, hide: -0.1, wrong_title: -0.25 });
  });

  it('keys: role, company, first three skills, the normalized title', () => {
    expect(affinityKeys(job)).toEqual({ taxonomy: 'backend_engineer', company: 'acme', skills: ['python', 'sql', 'go'], title: null });
    expect(affinityKeys({ ...job, primaryTaxonomyId: null }).taxonomy).toBe('backend_engineer');
    expect(affinityKeys({ ...job, titleNormalized: ' sales engineer ' }).title).toBe('sales engineer');
    expect(affinityKeys({ ...job, titleNormalized: '' }).title).toBeNull();
  });

  it('skill keys are the first three canonical skill ids when the job has them, else the first three strings', () => {
    const canonical = { ...job, skills: ['Postgres', 'k8s', 'Golang', 'Rust'], skillIds: ['sk_postgresql', 'sk_kubernetes', 'sk_go', 'sk_rust'] };
    expect(affinityKeys(canonical).skills).toEqual(['sk_postgresql', 'sk_kubernetes', 'sk_go']);
    // Two spellings of one skill are one key: liking a "Postgres" job lifts a "PostgreSQL" job.
    const other = { ...job, skills: ['PostgreSQL'], skillIds: ['sk_postgresql'] };
    const liked = applyAffinity(EMPTY_AFFINITY, affinityKeys(canonical), 0.25, T0);
    expect(liked.skill).toEqual({ sk_postgresql: 0.25, sk_kubernetes: 0.25, sk_go: 0.25 });
    expect(affinityScore(liked, { ...affinityKeys(other), taxonomy: null, company: null })).toBeGreaterThan(50);
    // No ids on the row (not enriched to v3 yet), or an empty list: the strings, lower case, as before.
    expect(affinityKeys({ ...job, skillIds: [] }).skills).toEqual(['python', 'sql', 'go']);
    expect(affinityKeys({ ...job, skillIds: null }).skills).toEqual(['python', 'sql', 'go']);
    expect(affinityKeys({ ...job, skillIds: ['', '  '] }).skills).toEqual(['python', 'sql', 'go']);
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

describe('"Not interested: wrong title" is a title-level negative', () => {
  const sales = { primaryTaxonomyId: 'sales_engineer', taxonomyIds: ['sales', 'sales_engineer'], companyNameNormalized: 'acme', skills: ['Salesforce', 'SQL'], titleNormalized: 'sales engineer' };
  const keys = affinityKeys(sales);
  const marked = applyAffinity(EMPTY_AFFINITY, keys, AFFINITY_DELTAS.wrong_title, T0, 'wrong_title');

  it('lowers the role and the title by 0.25, and touches neither the company nor the skills', () => {
    expect(marked.taxonomy).toEqual({ sales_engineer: -0.25 });
    expect(marked.title).toEqual({ 'sales engineer': -0.25 });
    expect(marked.company).toEqual({});
    expect(marked.skill).toEqual({});
  });

  it('other postings with that title rank lower; the same company with another title does not', () => {
    const sameTitleElsewhere = affinityKeys({ ...sales, companyNameNormalized: 'globex' });
    expect(affinityScore(marked, sameTitleElsewhere)).toBeLessThan(50);
    // Role −0.25 and title −0.25 over four parts: 50 + 50 × (−0.5 / 4).
    expect(affinityScore(marked, sameTitleElsewhere)).toBe(43.75);
    // The same title under another role id (a posting classified differently) still counts lower.
    expect(affinityScore(marked, { ...sameTitleElsewhere, taxonomy: 'solutions_engineer' })).toBe(46.88);
    // Another role and title at the same company: untouched.
    const other = affinityKeys({ ...sales, primaryTaxonomyId: 'account_executive', titleNormalized: 'account executive' });
    expect(affinityScore(marked, other)).toBe(50);
  });

  it('repeats add up and stop at −1', () => {
    let s = EMPTY_AFFINITY;
    for (let i = 0; i < 6; i++) s = applyAffinity(s, keys, AFFINITY_DELTAS.wrong_title, T0, 'wrong_title');
    expect(s.title!['sales engineer']).toBe(-1);
    expect(s.taxonomy.sales_engineer).toBe(-1);
    expect(affinityScore(s, keys)).toBe(25);
  });

  it('fades 2% a day like every other weight, and is dropped once negligible', () => {
    const later = decayed(marked, days(30));
    expect(later.title!['sales engineer']).toBeCloseTo(-0.25 * 0.98 ** 30, 6);
    expect(affinityScore(later, keys)).toBeGreaterThan(affinityScore(marked, keys));
    expect(affinityScore(later, keys)).toBeLessThan(50);
    expect(decayed(marked, days(400)).title).toEqual({});
    expect(affinityScore(decayed(marked, days(400)), keys)).toBe(50);
  });

  it('a title is never boosted by the map: saving a job writes no title weight, and a positive one is ignored', () => {
    const saved = applyAffinity(EMPTY_AFFINITY, keys, AFFINITY_DELTAS.save, T0, 'save');
    expect(saved.title).toEqual({});
    expect(applyAffinity(EMPTY_AFFINITY, keys, 0.25, T0).title).toEqual({});
    // Saving a job of a title marked wrong before does not lift the title weight.
    expect(applyAffinity(marked, keys, AFFINITY_DELTAS.applied, T0, 'applied').title).toEqual({ 'sales engineer': -0.25 });
    // A positive weight that reached the column some other way counts for nothing.
    const odd = { ...EMPTY_AFFINITY, title: { 'sales engineer': 0.9 } };
    expect(affinityScore(odd, keys)).toBe(50);
    // And the title-only event with a delta that is not negative writes nothing to the map.
    expect(applyAffinity(EMPTY_AFFINITY, keys, 0.25, T0, 'wrong_title').title).toEqual({});
  });

  it('a negative title weight never raises a score that is already low', () => {
    const disliked = { ...EMPTY_AFFINITY, taxonomy: { sales_engineer: -1 }, company: { acme: -1 }, skill: { salesforce: -1, sql: -1 } };
    const withTitle = { ...disliked, title: { 'sales engineer': -0.25 } };
    expect(affinityScore(disliked, keys)).toBe(0);
    expect(affinityScore(withTitle, keys)).toBe(0);
  });

  it('a job with no title key, and a state stored before the map existed, behave as before', () => {
    const noTitle = affinityKeys({ ...sales, titleNormalized: null });
    const out = applyAffinity(EMPTY_AFFINITY, noTitle, AFFINITY_DELTAS.wrong_title, T0, 'wrong_title');
    expect(out.title).toEqual({});
    expect(out.taxonomy).toEqual({ sales_engineer: -0.25 });
    const old = { taxonomy: { sales_engineer: 0.2 }, company: {}, skill: {}, updatedAt: T0 };
    expect(affinityScore(old, keys)).toBeGreaterThan(50);
    expect(decayed(old, days(1)).title).toEqual({});
    expect(applyAffinity(old, keys, AFFINITY_DELTAS.wrong_title, days(1), 'wrong_title').title).toEqual({ 'sales engineer': -0.25 });
  });

  it('keeps at most 200 titles, the strongest first', () => {
    let s = EMPTY_AFFINITY;
    for (let i = 0; i < 230; i++) s = applyAffinity(s, { ...keys, title: `title ${i}`, taxonomy: null }, AFFINITY_DELTAS.wrong_title, T0, 'wrong_title');
    expect(Object.keys(s.title!)).toHaveLength(200);
  });
});
