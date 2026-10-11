// server/src/features/skills/related.ts
//
// The related-evidence rule (SM-6; MATCH 4.6, the three states of the keyword
// check). A more specific skill shows the broader one: PostgreSQL on a resume
// is related evidence for "relational databases". Never the other way round: a
// resume that says "relational databases" does not show PostgreSQL. Two
// skills under the same broader skill say nothing about each other: MySQL is
// not evidence of PostgreSQL.
//
// Pure. The graph is the `parentId` edges of the vocabulary.

import type { SkillEvidence, SkillVocabulary } from './types.js';
import { current } from './vocabulary.js';

/**
 * What a person's skill ids say about one skill:
 *   shown      they have the skill itself;
 *   related    they have a narrower skill (`via`: the nearest one, by id among
 *              equally near ones);
 *   not_shown  neither.
 */
export function evidenceFor(skillId: string, haveIds: ReadonlySet<string>, vocabulary: SkillVocabulary = current()): SkillEvidence {
  if (haveIds.has(skillId)) return { state: 'shown', via: null };
  // Breadth first, so the nearest narrower skill is the one named. `seen` ends a loop in bad data.
  const seen = new Set([skillId]);
  let level = vocabulary.childrenOf(skillId);
  while (level.length) {
    const next: string[] = [];
    for (const id of level) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (haveIds.has(id)) return { state: 'related', via: id };
      next.push(...vocabulary.childrenOf(id));
    }
    level = next;
  }
  return { state: 'not_shown', via: null };
}

/** Every narrower skill of `skillId`, nearest first. */
export function narrowerSkills(skillId: string, vocabulary: SkillVocabulary = current()): string[] {
  const seen = new Set([skillId]);
  const out: string[] = [];
  let level = vocabulary.childrenOf(skillId);
  while (level.length) {
    const next: string[] = [];
    for (const id of level) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      next.push(...vocabulary.childrenOf(id));
    }
    level = next;
  }
  return out;
}
