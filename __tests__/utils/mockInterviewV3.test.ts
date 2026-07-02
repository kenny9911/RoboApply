// Mock Interview v3 — personas + tracks + setup helpers.
//
// Pins: 6 personas, 6 formats, exactly 124 tracks split across 6 categories,
// and buildSetupMock returns a session-ready mock with persona metadata.

import { describe, it, expect } from 'vitest';
import { PERSONAS, personaById } from '../../lib/mockInterview/personas';
import { FORMATS, formatById } from '../../lib/mockInterview/formats';
import { ALL_TRACKS, TRACKS_BY_CATEGORY } from '../../lib/mockInterview/tracks';
import { buildSetupMock, readSetupForMock } from '../../lib/mockInterview/setup';

describe('Mock Interview v3 — personas', () => {
  it('ships 6 distinct personas including the spicy Dr. Voss', () => {
    expect(PERSONAS).toHaveLength(6);
    expect(PERSONAS.map((p) => p.id)).toEqual(['maya', 'voss', 'kai', 'priya', 'rex', 'june']);
    const voss = personaById('voss');
    expect(voss.difficulty).toBe('hard');
    expect(voss.archetype).toMatch(/Skeptical/i);
  });
  it('personaById falls back to a sensible default', () => {
    const p = personaById('nope');
    expect(p.id).toBeDefined();
  });
});

describe('Mock Interview v3 — formats', () => {
  it('ships the 6 formats in the prescribed order', () => {
    expect(FORMATS.map((f) => f.id)).toEqual([
      'behavioral', 'technical', 'system_design', 'case', 'culture', 'final_round',
    ]);
  });
  it('Behavioral leans on behavioral question kind', () => {
    expect(formatById('behavioral').questionKinds).toContain('behavioral');
  });
});

describe('Mock Interview v3 — tracks', () => {
  it('contains exactly 124 tracks', () => {
    expect(ALL_TRACKS).toHaveLength(124);
  });
  it('every track has a category in the six leaves', () => {
    const cats = new Set(['eng', 'product', 'design', 'data', 'gtm', 'ops']);
    for (const t of ALL_TRACKS) {
      expect(cats.has(t.category)).toBe(true);
    }
  });
  it('categories sum to 124', () => {
    const sum = Object.values(TRACKS_BY_CATEGORY).reduce((s, arr) => s + arr.length, 0);
    expect(sum).toBe(124);
  });
});

describe('Mock Interview v3 — setup flow', () => {
  it('buildSetupMock saves to localStorage with persona + format metadata', () => {
    // Use a deterministic track id from the fixtures.
    const trackId = ALL_TRACKS[0].id;
    const mock = buildSetupMock({ trackId, personaId: 'voss', formatId: 'behavioral' });
    expect(mock.isCustom).toBe(true);
    expect(mock.persona).toBe('voss');
    expect(mock.format).toBe('behavioral');
    expect(mock.questions).toHaveLength(6);
    const blob = readSetupForMock(mock.id);
    expect(blob?.persona).toBe('voss');
    expect(blob?.format).toBe('behavioral');
  });
});
