// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { selectTaxonomyCandidates, taxonomyIdsFor } from './candidates.js';
import { MAX_TAXONOMY_CANDIDATES } from './schema.js';
import { CN_POSTING, INTL_POSTING } from './__tests__/fixtures.js';
import { isTaxonomyId, matchTitle } from '../taxonomy/index.js';

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

  it('reads a Taiwan title in its mainland form too', () => {
    expect(selectTaxonomyCandidates('資料分析師', '')[0]!.id).toBe('data_analyst');
    expect(selectTaxonomyCandidates('資深後端工程師', '負責後端服務與資料庫設計').map((c) => c.id)).toContain('backend_engineer');
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

  it('SM-2: the deterministic pick is always offered, first', () => {
    for (const title of ['Java Backend Architect', 'Senior Backend Engineer, Payments Platform', 'Software Engineer', 'Nurse Manager', '前端研发工程师']) {
      const det = matchTitle(title, { limit: 1 })[0]!;
      expect(selectTaxonomyCandidates(title, '')[0]!.id, title).toBe(det.id);
      expect(selectTaxonomyCandidates(title, INTL_POSTING, 1).map((c) => c.id), title).toEqual([det.id]);
    }
  });

  it('SM-2: a head-noun title is offered the roles its modifiers connect to and the other readings of the head noun', () => {
    const ids = selectTaxonomyCandidates('Java Backend Architect', 'You will design distributed services in Java and review system designs.').map((c) => c.id);
    expect(ids[0]).toBe('software_architect');
    // The building profession ("architect" alone) and the named tech architects are all on the list.
    expect(ids).toEqual(expect.arrayContaining(['architect', 'software_architect', 'cloud_engineer', 'data_architect', 'security_architect', 'network_engineer']));
    expect(ids.length).toBeLessThanOrEqual(MAX_TAXONOMY_CANDIDATES);
    // "Landscape Architect" filed by name still shows the software reading to the model.
    expect(selectTaxonomyCandidates('Landscape Architect', '').map((c) => c.id)).toEqual(expect.arrayContaining(['architect', 'software_architect']));
  });

  it('SM-2: a head noun with dozens of roles adds only the connected ones and leaves room for the description', () => {
    const ids = selectTaxonomyCandidates('Kubernetes Platform Engineer', 'You will run payment APIs in Go on AWS and write Terraform.').map((c) => c.id);
    expect(ids.slice(0, 2).sort()).toEqual(['infrastructure_engineer', 'platform_engineer']);
    expect(ids.length).toBeLessThanOrEqual(MAX_TAXONOMY_CANDIDATES);
    // A bare head noun adds nothing from the title: only the description speaks.
    expect(selectTaxonomyCandidates('Principal Engineer', '')).toEqual([]);
    expect(selectTaxonomyCandidates('Principal Engineer', 'You will design backend services and APIs in Java.').map((c) => c.id)).toContain('backend_engineer');
  });

  it('SM-2: the role a row already holds is offered, so the model can keep it', () => {
    const without = selectTaxonomyCandidates('Head of Special Projects', '').map((c) => c.id);
    expect(without).not.toContain('strategy_manager');
    const held = selectTaxonomyCandidates('Head of Special Projects', '', undefined, ['strategy_manager', null, 'not_a_role']).map((c) => c.id);
    expect(held[0]).toBe('strategy_manager');
    expect(held.slice(1)).toEqual(without);
    // It never displaces the deterministic pick, and a limit still holds.
    expect(selectTaxonomyCandidates('Java Backend Architect', '', 2, ['architect']).map((c) => c.id)).toEqual(['software_architect', 'architect']);
  });

  it('expands a role id to [category, group, role]', () => {
    expect(taxonomyIdsFor('backend_engineer')).toEqual(['software_engineering', 'swe_backend', 'backend_engineer']);
    expect(taxonomyIdsFor('not_a_role')).toEqual([]);
  });
});
