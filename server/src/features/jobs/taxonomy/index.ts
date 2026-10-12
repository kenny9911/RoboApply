// server/src/features/jobs/taxonomy/index.ts — public surface of taxonomy v1.
// Used by PREF (FilterSet.taxonomyIds), INGEST (role tagging, WP-16b; provider
// query texts per market, `providerQueryLabels`), FEED (Explore, WP-32/33),
// enrichment (title evidence and candidates) and the `/taxonomy` routes (WP-20).

export {
  TAXONOMY_AS_OF,
  TAXONOMY_NODES,
  TAXONOMY_SOURCES,
  TAXONOMY_VERSION,
  TAXONOMY_ZH_HANT_REVIEW,
  expandTaxonomyIds,
  exportTaxonomyLabels,
  getTaxonomyNode,
  isTaxonomyId,
  taxonomyAncestors,
  taxonomyCategories,
  taxonomyChildren,
  taxonomyLabel,
  taxonomyNodeLabel,
  taxonomyRolesUnder,
  validateTaxonomy,
} from './taxonomy.js';
export type { TaxonomyData, TaxonomyLabelBundle, TaxonomyLevel, TaxonomyNode, TaxonomySource, TaxonomyZhHantReview } from './taxonomy.js';
export {
  ALONE_ONLY_PHRASES,
  CJK_HEAD_WORDS,
  HEAD_NOUNS,
  MODIFIER_MATCH_SCORE,
  TITLE_MATCH_TRUSTED,
  bestTaxonomyMatch,
  headNounOf,
  headNounRoles,
  lexiconCandidates,
  matchTitle,
  normalizeTitle,
  oneWordRolesIn,
  searchTaxonomy,
  stripLevelWords,
} from './match.js';
export type { TaxonomySuggestion, TitleMatch } from './match.js';
export { MAX_QUERY_SYNONYMS, providerQueryLabels, queryLabelsFor, taiwanQueryText } from './queryLabels.js';
export type { ProviderQueryLabel, QueryLanguage } from './queryLabels.js';
// 通俗職業分類 (台灣就業通 open data) → the role tree (MKT-3E, JT-4).
export { TW_JOBNO_MAJORS, TW_JOBNO_MINORS, TW_JOBNO_SOURCE, TW_JOBNO_VERSION, twCategoryForMajor, twRoleForJobno, validateTwJobno } from './twJobno.js';
export type { TwJobnoData, TwJobnoMajor, TwJobnoMinor } from './twJobno.js';
