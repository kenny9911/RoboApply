// lib/api/search.ts — Search profiles (the one preference store) and the role taxonomy.
//
// Thin typed wrappers over the area contract (FND-7). Owner: WP-20.
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// Endpoints:
//   GET    /api/v1/roboapply/search-profiles
//   POST   /api/v1/roboapply/search-profiles
//   POST   /api/v1/roboapply/search-profiles/count
//   PATCH  /api/v1/roboapply/search-profiles/:id
//   DELETE /api/v1/roboapply/search-profiles/:id
//   POST   /api/v1/roboapply/search-profiles/:id/activate
//   GET    /api/v1/roboapply/search-profiles/:id/limiting
//   GET    /api/v1/roboapply/taxonomy
//   GET    /api/v1/roboapply/taxonomy/skills

import { call, type CallOptions, type In, seg, withQuery } from './contracts/wire';
import type * as S from './contracts/search';
import type * as F from './contracts/feed';

/** Body of POST /search-profiles/count (contract `CountFiltersBodySchema`). */
export interface CountFiltersBody {
  filters: Partial<S.FilterSet>;
}
/** GET /taxonomy?locale&q (contract `TaxonomyQuerySchema`). */
export type TaxonomyQuery = In<typeof S.TaxonomyQuerySchema>;
/** GET /taxonomy/skills?q (contract `SkillsQuerySchema`). */
export type SkillsQuery = In<typeof S.SkillsQuerySchema>;
/** GET /taxonomy: the tree, or ranked suggestions when `q` is sent. */
export type TaxonomyResponse = S.TaxonomyResponse;
/** One skill suggestion. */
export type SkillSuggestion = S.SkillSuggestionWire;
/** PATCH /search-profiles/:id body: `baseVersion` plus `filters` (replace) or `filtersPatch`. */
export type UpdateSearchProfileBody = In<typeof S.UpdateSearchProfileBodySchema>;

/** `search.list` — GET /api/v1/roboapply/search-profiles */
export function listSearchProfiles(opts?: CallOptions): Promise<S.SearchProfileListWire> {
  return call<S.SearchProfileListWire>('GET', `/api/v1/roboapply/search-profiles`, opts);
}

/** `search.create` — POST /api/v1/roboapply/search-profiles */
export function createSearchProfile(body: In<typeof S.CreateSearchProfileBodySchema>, opts?: CallOptions): Promise<S.SearchProfileWire> {
  return call<S.SearchProfileWire>('POST', `/api/v1/roboapply/search-profiles`, { ...opts, body });
}

/** `search.count` — POST /api/v1/roboapply/search-profiles/count */
export function countFilters(body: CountFiltersBody, opts?: CallOptions): Promise<F.FeedCountResult> {
  return call<F.FeedCountResult>('POST', `/api/v1/roboapply/search-profiles/count`, { ...opts, body });
}

/** `search.update` — PATCH /api/v1/roboapply/search-profiles/:id */
export function updateSearchProfile(id: string, body: UpdateSearchProfileBody, opts?: CallOptions): Promise<S.SearchProfileWire> {
  return call<S.SearchProfileWire>('PATCH', `/api/v1/roboapply/search-profiles/${seg(id)}`, { ...opts, body });
}

/** `search.remove` — DELETE /api/v1/roboapply/search-profiles/:id */
export function deleteSearchProfile(id: string, opts?: CallOptions): Promise<void> {
  return call<void>('DELETE', `/api/v1/roboapply/search-profiles/${seg(id)}`, opts);
}

/** `search.activate` — POST /api/v1/roboapply/search-profiles/:id/activate */
export function activateSearchProfile(id: string, opts?: CallOptions): Promise<S.SearchProfileWire> {
  return call<S.SearchProfileWire>('POST', `/api/v1/roboapply/search-profiles/${seg(id)}/activate`, opts);
}

/** `search.limiting` — GET /api/v1/roboapply/search-profiles/:id/limiting */
export function getLimitingFilters(id: string, opts?: CallOptions): Promise<S.LimitingFiltersResponse> {
  return call<S.LimitingFiltersResponse>('GET', `/api/v1/roboapply/search-profiles/${seg(id)}/limiting`, opts);
}

/** `taxonomy.tree` — GET /api/v1/roboapply/taxonomy */
export function getTaxonomy(query?: TaxonomyQuery, opts?: CallOptions): Promise<TaxonomyResponse> {
  return call<TaxonomyResponse>('GET', withQuery(`/api/v1/roboapply/taxonomy`, query), opts);
}

/** `taxonomy.skills` — GET /api/v1/roboapply/taxonomy/skills */
export function suggestSkills(query: SkillsQuery, opts?: CallOptions): Promise<S.SkillSuggestionsResponse> {
  return call<S.SkillSuggestionsResponse>('GET', withQuery(`/api/v1/roboapply/taxonomy/skills`, query), opts);
}

/** Every wrapper of this area, for callers that prefer one import. */
export const searchApi = {
  listSearchProfiles,
  createSearchProfile,
  countFilters,
  updateSearchProfile,
  deleteSearchProfile,
  activateSearchProfile,
  getLimitingFilters,
  getTaxonomy,
  suggestSkills,
};
