// lib/api/contracts/taxonomy.ts — type-only mirror (FND-7). No runtime code here;
// the taxonomy v1 node types (server/src/features/jobs/taxonomy, FND-4) that
// the `/taxonomy` routes return (WP-20).
export type {
  TaxonomyLevel,
  TaxonomyNode,
  TaxonomySource,
  TaxonomySuggestion,
  TitleMatch,
} from '../../../server/src/features/jobs/taxonomy/index';
