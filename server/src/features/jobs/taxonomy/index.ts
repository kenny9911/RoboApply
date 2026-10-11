// server/src/features/jobs/taxonomy/index.ts — public surface of taxonomy v1.
// Used by PREF (FilterSet.taxonomyIds), INGEST (role tagging, WP-16b; provider
// query texts per market, `providerQueryLabels`), FEED (Explore, WP-32/33),
// enrichment (title evidence and candidates) and the `/taxonomy` routes (WP-20).

export {
  TAXONOMY_AS_OF,
  TAXONOMY_NODES,
  TAXONOMY_SOURCES,
  TAXONOMY_VERSION,
  expandTaxonomyIds,
  getTaxonomyNode,
  isTaxonomyId,
  taxonomyAncestors,
  taxonomyCategories,
  taxonomyChildren,
  taxonomyLabel,
  taxonomyRolesUnder,
  validateTaxonomy,
} from './taxonomy.js';
export type { TaxonomyData, TaxonomyLevel, TaxonomyNode, TaxonomySource } from './taxonomy.js';
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
export { MAX_QUERY_SYNONYMS, providerQueryLabels, queryLabelsFor } from './queryLabels.js';
export type { ProviderQueryLabel, QueryLanguage } from './queryLabels.js';
