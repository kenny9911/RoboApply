// @vitest-environment node
// MKT-2G item 2: the related-evidence rule. A narrower skill shows the broader
// one, never the other way round, and siblings say nothing about each other.
import { describe, expect, it } from 'vitest';

import { evidenceFor, narrowerSkills } from './related.js';
import type { SkillRecord } from './types.js';
import { buildVocabulary } from './vocabulary.js';

function skill(id: string, parentId: string | null = null): SkillRecord {
  return { id, kind: 'hard', labelEn: id, labelZh: null, labelZhHant: null, aliases: [], parentId, esco: null, onet: null, status: 'reviewed' };
}

const vocabulary = buildVocabulary([
  skill('relational_databases'),
  skill('sql', 'relational_databases'),
  skill('postgresql', 'sql'),
  skill('mysql', 'sql'),
  skill('oracle', 'relational_databases'),
  skill('nosql'),
  skill('mongodb', 'nosql'),
  skill('kubernetes'),
]);

const have = (...ids: string[]) => new Set(ids);

describe('evidenceFor', () => {
  it('shown: the person has the skill itself', () => {
    expect(evidenceFor('postgresql', have('postgresql'), vocabulary)).toEqual({ state: 'shown', via: null });
    // Having a narrower skill as well does not turn "shown" into "related".
    expect(evidenceFor('sql', have('sql', 'postgresql'), vocabulary)).toEqual({ state: 'shown', via: null });
  });

  it('related: the person has a narrower skill, and `via` names it', () => {
    expect(evidenceFor('relational_databases', have('postgresql'), vocabulary)).toEqual({ state: 'related', via: 'postgresql' });
    expect(evidenceFor('sql', have('mysql'), vocabulary)).toEqual({ state: 'related', via: 'mysql' });
    expect(evidenceFor('relational_databases', have('oracle'), vocabulary)).toEqual({ state: 'related', via: 'oracle' });
    expect(evidenceFor('nosql', have('mongodb', 'postgresql'), vocabulary)).toEqual({ state: 'related', via: 'mongodb' });
  });

  it('names the nearest narrower skill, and the first by id among equally near ones', () => {
    expect(evidenceFor('relational_databases', have('postgresql', 'sql'), vocabulary).via).toBe('sql');
    expect(evidenceFor('relational_databases', have('postgresql', 'oracle'), vocabulary).via).toBe('oracle');
    expect(evidenceFor('sql', have('postgresql', 'mysql'), vocabulary).via).toBe('mysql');
  });

  it('never the other way round: a broader skill does not show a narrower one', () => {
    expect(evidenceFor('postgresql', have('relational_databases'), vocabulary)).toEqual({ state: 'not_shown', via: null });
    expect(evidenceFor('postgresql', have('sql'), vocabulary)).toEqual({ state: 'not_shown', via: null });
    expect(evidenceFor('sql', have('relational_databases'), vocabulary)).toEqual({ state: 'not_shown', via: null });
  });

  it('siblings are not related evidence', () => {
    expect(evidenceFor('postgresql', have('mysql'), vocabulary)).toEqual({ state: 'not_shown', via: null });
    expect(evidenceFor('sql', have('oracle'), vocabulary)).toEqual({ state: 'not_shown', via: null });
    expect(evidenceFor('nosql', have('postgresql'), vocabulary)).toEqual({ state: 'not_shown', via: null });
  });

  it('not_shown: nothing, an unrelated skill, an unknown id', () => {
    expect(evidenceFor('kubernetes', have(), vocabulary)).toEqual({ state: 'not_shown', via: null });
    expect(evidenceFor('kubernetes', have('postgresql'), vocabulary)).toEqual({ state: 'not_shown', via: null });
    expect(evidenceFor('no_such_skill', have('postgresql'), vocabulary)).toEqual({ state: 'not_shown', via: null });
    // An id the vocabulary does not know is still "shown" when the person has exactly it.
    expect(evidenceFor('no_such_skill', have('no_such_skill'), vocabulary).state).toBe('shown');
  });

  it('ends on a loop in bad data', () => {
    const loop = { ...vocabulary, childrenOf: (id: string) => (id === 'a' ? ['b'] : id === 'b' ? ['a'] : []) };
    expect(evidenceFor('a', have('zzz'), loop)).toEqual({ state: 'not_shown', via: null });
    expect(narrowerSkills('a', loop)).toEqual(['b']);
  });
});

describe('narrowerSkills', () => {
  it('lists every narrower skill, nearest first', () => {
    expect(narrowerSkills('relational_databases', vocabulary)).toEqual(['oracle', 'sql', 'mysql', 'postgresql']);
    expect(narrowerSkills('postgresql', vocabulary)).toEqual([]);
  });
});
