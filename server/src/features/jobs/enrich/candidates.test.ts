// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { CANDIDATE_ROLES, MAX_NEIGHBOUR_CANDIDATES, selectTaxonomyCandidates, taxonomyIdsFor, titleIsWeak } from './candidates.js';
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

  describe('SM-2: the roles nearest to the title by embedding (extraIds)', () => {
    const WEAK = 'Head of Special Projects';
    const NEAREST = ['strategy_manager', 'program_manager', 'operations_manager', 'project_manager'];

    it('the ids used here are roles of the tree', () => {
      const ids = new Set(CANDIDATE_ROLES.map((r) => r.id));
      for (const id of NEAREST) expect(ids.has(id), id).toBe(true);
      expect(MAX_NEIGHBOUR_CANDIDATES).toBe(3);
    });

    it('ACCEPT: a weak title gets three extra candidates; without them the list is what it was', () => {
      expect(titleIsWeak(WEAK)).toBe(true);
      // The title alone: what the deterministic steps offer.
      const fromTitle = selectTaxonomyCandidates(WEAK, '').map((c) => c.id);
      expect(NEAREST.some((id) => fromTitle.includes(id))).toBe(false);
      // The three nearest roles join before the roles that only share words with the posting, so those cannot push them out.
      expect(selectTaxonomyCandidates(WEAK, '', undefined, [], NEAREST).map((c) => c.id)).toEqual([...NEAREST.slice(0, 3), ...fromTitle]);
      // With a posting whose words fill the list to the cap, they are still on it.
      const before = selectTaxonomyCandidates(WEAK, INTL_POSTING).map((c) => c.id);
      expect(before).toHaveLength(MAX_TAXONOMY_CANDIDATES);
      const after = selectTaxonomyCandidates(WEAK, INTL_POSTING, undefined, [], NEAREST).map((c) => c.id);
      expect(after).toHaveLength(MAX_TAXONOMY_CANDIDATES);
      expect(after.filter((id) => !before.includes(id))).toEqual(NEAREST.slice(0, 3));
      expect(new Set(after).size).toBe(after.length);
      // No neighbours (the client is unavailable): today's list, in today's order.
      expect(selectTaxonomyCandidates(WEAK, INTL_POSTING, undefined, [], []).map((c) => c.id)).toEqual(before);
      expect(selectTaxonomyCandidates(WEAK, INTL_POSTING, undefined, [], undefined).map((c) => c.id)).toEqual(before);
    });

    it('ACCEPT: a title that names its role outright gets none', () => {
      expect(titleIsWeak('Backend Engineer')).toBe(false);
      const before = selectTaxonomyCandidates('Backend Engineer', INTL_POSTING).map((c) => c.id);
      expect(selectTaxonomyCandidates('Backend Engineer', INTL_POSTING, undefined, [], NEAREST).map((c) => c.id)).toEqual(before);
    });

    it('takes at most three, after the deterministic pick and the held role, and stays inside the cap of 15', () => {
      const ids = selectTaxonomyCandidates('Java Backend Architect', 'You will design distributed services in Java.', undefined, ['architect'], NEAREST).map((c) => c.id);
      expect(ids[0]).toBe('software_architect');
      expect(ids).toContain('architect');
      expect(NEAREST.slice(0, 3).every((id) => ids.includes(id))).toBe(true);
      expect(ids).not.toContain(NEAREST[3]);
      expect(ids.length).toBeLessThanOrEqual(MAX_TAXONOMY_CANDIDATES);
      expect(new Set(ids).size).toBe(ids.length);
      // The held role comes before them.
      expect(ids.indexOf('architect')).toBeLessThan(ids.indexOf('strategy_manager'));
      // A neighbour that is already a candidate adds nothing; an id that is not a role is ignored.
      const withKnown = selectTaxonomyCandidates('Java Backend Architect', '', undefined, [], ['software_architect', 'not_a_role', null]).map((c) => c.id);
      expect(withKnown).toEqual(selectTaxonomyCandidates('Java Backend Architect', '').map((c) => c.id));
      // A small limit still holds.
      expect(selectTaxonomyCandidates(WEAK, '', 2, [], NEAREST)).toHaveLength(2);
    });

    it('never pushes the other reading of a head noun out: the head noun\'s roles are picked first, the neighbours after them (review probe)', () => {
      const FAMILY = ['architect', 'software_architect', 'cloud_engineer', 'data_architect', 'security_architect', 'network_engineer', 'interior_designer', 'ux_designer'];
      // Three neighbours that have nothing to do with the head noun, as an embedding may return them.
      for (const [title, description] of [
        ['Associate Architect', ''],
        ['Java Backend Architect', 'You will design distributed services in Java and review system designs.'],
        ['Java Backend Architect', INTL_POSTING],
      ] as const) {
        expect(titleIsWeak(title), title).toBe(true);
        const without = selectTaxonomyCandidates(title, description).map((c) => c.id);
        const withNeighbours = selectTaxonomyCandidates(title, description, undefined, [], NEAREST).map((c) => c.id);
        // The building profession and the software reading are both still offered, with the rest of the family.
        expect(without, title).toEqual(expect.arrayContaining(FAMILY));
        expect(withNeighbours, title).toEqual(expect.arrayContaining(FAMILY));
        expect(withNeighbours, title).toEqual(expect.arrayContaining(NEAREST.slice(0, 3)));
        expect(withNeighbours.length).toBeLessThanOrEqual(MAX_TAXONOMY_CANDIDATES);
        // They come after every role the head noun brought, and before the roles that only share words with the posting.
        const firstNeighbour = withNeighbours.indexOf(NEAREST[0]!);
        for (const id of FAMILY) expect(withNeighbours.indexOf(id), `${title}: ${id}`).toBeLessThan(firstNeighbour);
        // Up to the first neighbour the list is exactly what it is without them; after the three, it goes on as before.
        expect(withNeighbours.slice(0, firstNeighbour)).toEqual(without.slice(0, firstNeighbour));
        expect(withNeighbours.slice(firstNeighbour + 3)).toEqual(without.slice(firstNeighbour, firstNeighbour + withNeighbours.length - firstNeighbour - 3));
      }
    });
  });

  it('expands a role id to [category, group, role]', () => {
    expect(taxonomyIdsFor('backend_engineer')).toEqual(['software_engineering', 'swe_backend', 'backend_engineer']);
    expect(taxonomyIdsFor('not_a_role')).toEqual([]);
  });
});
