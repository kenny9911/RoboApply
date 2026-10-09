// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { selectTaxonomyCandidates, taxonomyIdsFor } from './candidates.js';
import { MAX_TAXONOMY_CANDIDATES } from './schema.js';
import { CN_POSTING, INTL_POSTING } from './__tests__/fixtures.js';
import { isTaxonomyId } from '../taxonomy/index.js';

describe('taxonomy candidate preselection', () => {
  it('puts the deterministic title match first and never exceeds 15', () => {
    const candidates = selectTaxonomyCandidates('Senior Backend Engineer', INTL_POSTING);
    expect(candidates[0]!.id).toBe('backend_engineer');
    expect(candidates.length).toBeGreaterThan(1);
    expect(candidates.length).toBeLessThanOrEqual(MAX_TAXONOMY_CANDIDATES);
    for (const c of candidates) expect(isTaxonomyId(c.id)).toBe(true);
    expect(new Set(candidates.map((c) => c.id)).size).toBe(candidates.length);
  });

  it('respects a smaller limit', () => {
    expect(selectTaxonomyCandidates('Backend Engineer', INTL_POSTING, 3)).toHaveLength(3);
    expect(selectTaxonomyCandidates('Backend Engineer', INTL_POSTING, 99).length).toBeLessThanOrEqual(MAX_TAXONOMY_CANDIDATES);
  });

  it('finds candidates for a Chinese title', () => {
    const candidates = selectTaxonomyCandidates('数据分析师（校招）', CN_POSTING);
    expect(candidates[0]!.id).toBe('data_analyst');
    expect(candidates[0]!.zh).toBe('数据分析师');
  });

  it('uses description words when the title says little', () => {
    const ids = selectTaxonomyCandidates('Associate', 'You will design backend services and APIs in Java.').map((c) => c.id);
    expect(ids).toContain('backend_engineer');
  });

  it('returns an empty list for text with no role words', () => {
    expect(selectTaxonomyCandidates('', '')).toEqual([]);
  });

  it('labels each candidate with its category path', () => {
    const c = selectTaxonomyCandidates('Backend Engineer', '')[0]!;
    expect(c.path).toContain('Backend and platform');
  });

  it('expands a role id to [category, group, role]', () => {
    expect(taxonomyIdsFor('backend_engineer')).toEqual(['software_engineering', 'swe_backend', 'backend_engineer']);
    expect(taxonomyIdsFor('not_a_role')).toEqual([]);
  });
});
