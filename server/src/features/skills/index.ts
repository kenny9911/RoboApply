// server/src/features/skills/index.ts
//
// The canonical skill vocabulary (SM-6; MARKET_TASK_PLAN 3.3, row "Skill
// vocabulary"). Importing this module opens no database connection and calls
// no model: the table is read by `ready()` / `loadVocabulary()`, and the
// write path does only what its caller passes in.
//
//   termKey, displayTerm, …       how terms are compared and written (terms.ts)
//   await ready()                 once, before the first synchronous read
//   current()                     the vocabulary (the committed seed until loaded)
//   canonicalize(term, deps?)     string → { skillId, status, via }
//   userSkillIds(skills, text)    a person's canonical skills
//   evidenceFor(id, haveIds)      shown | related | not_shown

export type { AliasConflict, CanonicalSkill, SkillEvidence, SkillEvidenceState, SkillKind, SkillRecord, SkillSnapshot, SkillStatus, SkillVocabulary } from './types.js';
export { SKILL_KINDS, SKILL_STATUS_DROPPED, SKILL_STATUS_SEED } from './types.js';
// The term primitives (terms.ts). features/match/terms.ts re-exports them from here.
export { dedupeTerms, displayTerm, EVERYDAY_WORDS, isEverydayWord, SHOWN_BY, termKey, termParts, termWords } from './terms.js';
export { aliasKey, isListOnlyWord, LIST_ONLY_KEYS, SHORT_NAMES_WITH_ONE_READING } from './keys.js';
export {
  buildVocabulary,
  createVocabularyLoader,
  current,
  labelScriptOf,
  loadVocabulary,
  ready,
  resetVocabularyForTests,
  setVocabularyForTests,
  VOCABULARY_TTL_MS,
  type VocabularyLoader,
} from './vocabulary.js';
export { evidenceFor, narrowerSkills } from './related.js';
export { skillIdsInText } from './text.js';
export {
  canonicalize,
  canonicalizeMany,
  missingRowOf,
  nearestSkills,
  SKILL_EMBED_DIMENSIONS,
  SKILL_EMBED_MARGIN,
  SKILL_EMBED_MATCH_MIN_DEFAULT,
  skillEmbedMatchMin,
  skillStoreDeps,
  userSkillIds,
  writeSkillEmbedding,
  type CanonicalizeDeps,
  type SkillNeighbour,
} from './canonicalize.js';
export { createMemorySkillRepo, createPrismaSkillRepo, type SkillRepo, type SkillRow } from './repo.js';
