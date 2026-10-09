// server/src/features/jobs/taxonomy/index.ts — public surface of taxonomy v1.
// Used by PREF (FilterSet.taxonomyIds), INGEST (role tagging, WP-16b), FEED
// (Explore, WP-32/33) and the `/taxonomy` routes (WP-20).

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
export { bestTaxonomyMatch, matchTitle, normalizeTitle, searchTaxonomy, stripLevelWords } from './match.js';
export type { TaxonomySuggestion, TitleMatch } from './match.js';
