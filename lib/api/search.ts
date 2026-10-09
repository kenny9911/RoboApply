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

import { call, type CallOptions, type In, type Items, seg, withQuery } from './contracts/wire';
import type * as S from './contracts/search';
import type * as F from './contracts/feed';
import type * as T from './contracts/taxonomy';

/** Body of POST /search-profiles/count (route-only schema in search/routes.ts; WP-20 may move it to contract.ts). */
export interface CountFiltersBody {
  filters: Partial<S.FilterSet>;
}
/** GET /taxonomy?locale&q (route-only schema in search/routes.ts). */
export interface TaxonomyQuery {
  locale?: string;
  q?: string;
}
/** GET /taxonomy/skills?q (route-only schema in search/routes.ts). */
export interface SkillsQuery {
  q: string;
  locale?: string;
}
/**
 * Provisional response of GET /taxonomy (the contract names none yet): the
 * tree (`nodes`), or ranked suggestions when `q` is sent. WP-20 confirms it
 * in search/contract.ts and switches this wrapper.
 */
export interface TaxonomyResponse {
  version: string;
  nodes: T.TaxonomyNode[];
  suggestions: T.TaxonomySuggestion[];
}
/** Provisional response of GET /taxonomy/skills (WP-20 confirms it). */
export interface SkillSuggestion {
  value: string;
  label: string;
}

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
export function updateSearchProfile(id: string, body: In<typeof S.UpdateSearchProfileBodySchema>, opts?: CallOptions): Promise<S.SearchProfileWire> {
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
export function getLimitingFilters(id: string, opts?: CallOptions): Promise<Items<F.LimitingFilter>> {
  return call<Items<F.LimitingFilter>>('GET', `/api/v1/roboapply/search-profiles/${seg(id)}/limiting`, opts);
}

/** `taxonomy.tree` — GET /api/v1/roboapply/taxonomy */
export function getTaxonomy(query?: TaxonomyQuery, opts?: CallOptions): Promise<TaxonomyResponse> {
  return call<TaxonomyResponse>('GET', withQuery(`/api/v1/roboapply/taxonomy`, query), opts);
}

/** `taxonomy.skills` — GET /api/v1/roboapply/taxonomy/skills */
export function suggestSkills(query: SkillsQuery, opts?: CallOptions): Promise<Items<SkillSuggestion>> {
  return call<Items<SkillSuggestion>>('GET', withQuery(`/api/v1/roboapply/taxonomy/skills`, query), opts);
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
