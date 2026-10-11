// server/src/features/skills/types.ts
//
// The canonical skill vocabulary (MARKET_STRATEGY 2.1 point 2, 2.5 row
// "Skills"; SM-6). One id per skill, labels in three scripts, many aliases,
// and one broader skill a skill is evidence for. Types only: importing this
// file loads nothing.

/** `certification` is a first-class kind (CPA, 教师资格证, 一建, CET-6): strategy 2.5. */
export type SkillKind = 'hard' | 'soft' | 'certification';
export const SKILL_KINDS: readonly SkillKind[] = ['hard', 'soft', 'certification'];

/** An unreviewed skill is shown on cards and is never scored. */
export type SkillStatus = 'reviewed' | 'unreviewed';

/**
 * A third value of the `RASkill.status` column, written by the review tooling
 * only (`review-import`, decision `drop`). A dropped row is not a skill: it
 * never enters a vocabulary. It keeps its alias keys so the same string is
 * neither created again nor sent to the embeddings endpoint again.
 */
export const SKILL_STATUS_DROPPED = 'dropped';

/**
 * A fourth value of the column: the row an automatic step made for a seed
 * skill that had none (`embed-labels`, `attach-ids`, a learned alias, the
 * target of a merge). It is a place to hang a label vector, learned alias keys
 * and identifiers on, not a review decision: the skill's kind, labels, parent
 * and status are read from the committed seed, so a later change to the seed
 * applies. `review-import` with `keep` turns it into a `reviewed` row.
 */
export const SKILL_STATUS_SEED = 'seed';

export interface SkillRecord {
  /** Stable slug: 'postgresql', 'relational_databases', 'cpa'. */
  id: string;
  kind: SkillKind;
  labelEn: string;
  /** Simplified Chinese label, only where the standard term is certain. */
  labelZh: string | null;
  /** Traditional Chinese (Taiwan) label, only where the standard term is certain. */
  labelZhHant: string | null;
  /** Other names of the skill in any script, as people write them ("k8s", "Amazon Web Services", "机器学习"). */
  aliases: string[];
  /** The broader skill this one is evidence for (postgresql → sql → relational_databases). */
  parentId: string | null;
  /** Identifiers of public vocabularies. Null until `attach-ids` finds the label in a file the owner supplied. */
  esco: string | null;
  onet: string | null;
  status: SkillStatus;
  /**
   * Comparison keys taken exactly as they are: what the `RASkill.aliases`
   * column stores. A key is not a spelling and is never keyed a second time
   * (`aliasKey` is not idempotent: "amazon aws" → "amazonaws" → "amazonaw").
   */
  aliasKeys?: string[];
  /** The name is also an ordinary word (terms.ts EVERYDAY_WORDS: rest, excel, swift, go). */
  everydayWord?: boolean;
}

/** The contract every consumer reads (MARKET_TASK_PLAN 3.3, row "Skill vocabulary"). */
export interface SkillVocabulary {
  /** The id of the skill `term` names, in any spelling or script; null when the vocabulary does not know it. */
  idOf(term: string): string | null;
  kindOf(id: string): SkillRecord['kind'] | null;
  /** True for a reviewed skill; false for an unreviewed or unknown id. */
  reviewed(id: string): boolean;
  /**
   * en → labelEn; zh → labelZh, else labelEn; zh-TW → labelZhHant, else
   * labelEn (never the Simplified label for Taiwan). Every other locale reads
   * labelEn. An unknown id comes back as it is.
   *
   * An EMPTY string means "show the posting's own string": an unreviewed skill
   * made from a Chinese posting has only that string as its label, and for
   * zh-TW it is not returned unless it was written in Traditional script.
   */
  label(id: string, locale: string): string;
  parentOf(id: string): string | null;
  /** Direct narrower skills, sorted by id. */
  childrenOf(id: string): string[];
  /** Number of skills. */
  size: number;
}

/** Two skills claimed one alias key; the first in (reviewed, labels, id) order kept it. */
export interface AliasConflict {
  key: string;
  keptId: string;
  lostId: string;
}

/**
 * A vocabulary plus what the write path and the tooling need. `current()`
 * returns this; a consumer that only reads may type it as `SkillVocabulary`.
 */
export interface SkillSnapshot extends SkillVocabulary {
  record(id: string): SkillRecord | null;
  /** Every id, sorted. */
  ids(): string[];
  /** Lookup by a comparison key that is already keyed (`aliasKey`). */
  idOfKey(key: string): string | null;
  /** Lookup by the words of a name as a sentence writes them (phrase.ts): "rest api", never "restapi". */
  idOfPhrase(phrase: string): string | null;
  /** Every comparison key that leads to `id`, sorted. */
  keysOf(id: string): string[];
  /** Was this string reviewed and dropped ("fast-paced environment")? Such a string is never a skill. */
  isDropped(term: string): boolean;
  /** When the database rows were read; null while only the committed seed is loaded. */
  readonly asOf: Date | null;
  readonly source: 'seed' | 'database';
  /** Alias keys two skills claimed. Empty for the committed seed (a test). */
  readonly conflicts: readonly AliasConflict[];
  /** The skill's name is also an ordinary word (seed flag). */
  everydayWord(id: string): boolean;
}

/**
 * `unscored`: the skill is not one the vocabulary has reviewed (an unreviewed
 * skill, or an id it does not hold) and the person does not list exactly it.
 * Such a skill is shown but not scored (MATCH 4.6): nothing may say "Not in
 * your resume" about it, because nobody has checked what it is or what shows it.
 */
export type SkillEvidenceState = 'shown' | 'related' | 'not_shown' | 'unscored';

/** `via` is the more specific skill that counted, for `related` only. */
export interface SkillEvidence {
  state: SkillEvidenceState;
  via: string | null;
}

export interface CanonicalSkill {
  skillId: string | null;
  status: SkillStatus;
  /** How the id was found: an exact alias, a strict embedding neighbour, a newly created unreviewed skill, or not at all. */
  via: 'alias' | 'embedding' | 'new' | 'none';
}
