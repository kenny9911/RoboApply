'use client';

// hooks/search/useFilterQueries.ts — the read-side helpers of the filters UI (WP-20).
//
//   useDebouncedValue(value, ms)     shared debounce (typeahead 300 ms, live count 400 ms)
//   useFilterCount(filters)          POST /search-profiles/count → { count | null, capped }
//   useLimitingFilters(profile)      GET  /search-profiles/:id/limiting (zero results)
//   useTitleSuggestions(q)           GET  /taxonomy?q (roles; ≥2 characters, 1 for Chinese)
//   useCompanySuggestions(q)         GET  /companies?q (our index)
//   useSkillSuggestions(q)           GET  /taxonomy/skills?q (posting skills of this market)
//
// D3: until the feed counts (WP-32) `count` is null and the drawer says
// "Show jobs" without a number; nothing here invents one.

import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useLocale } from 'next-intl';

import { countFilters, getLimitingFilters, getTaxonomy, suggestSkills } from '../../lib/api/search';
import { searchCompanies } from '../../lib/api/jobs';
import type * as S from '../../lib/api/contracts/search';
import { filtersKey, normalizeFilters, type FilterSet } from './filterModel';
import { searchKeys } from './keys';

/** Typeahead debounce (PRODUCT F-FILT-06). */
export const TYPEAHEAD_DEBOUNCE_MS = 300;
/** Live-count debounce while the drawer is edited. */
export const COUNT_DEBOUNCE_MS = 400;

const CJK = /[㐀-鿿豈-﫿]/;

/** 2+ characters, or 1 Chinese character. */
export function typeaheadReady(q: string): boolean {
  const t = q.trim();
  return t.length >= 2 || (t.length === 1 && CJK.test(t));
}

export function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

export interface FilterCountState {
  /** Jobs these filters show; null = not counted yet (or the feed cannot count). */
  count: number | null;
  /** True when the count hit the 5,000 cap ("5,000+"). */
  capped: boolean;
  isFetching: boolean;
}

export function useFilterCount(filters: FilterSet | null, options: { enabled?: boolean } = {}): FilterCountState {
  const key = filters ? filtersKey(filters) : '';
  const debouncedKey = useDebouncedValue(key, COUNT_DEBOUNCE_MS);
  const enabled = (options.enabled ?? true) && !!filters && debouncedKey === key;
  const query = useQuery({
    queryKey: searchKeys.count(debouncedKey),
    queryFn: () => countFilters({ filters: normalizeFilters(filters ?? {}) }),
    enabled,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    retry: false,
  });
  return { count: query.data?.count ?? null, capped: query.data?.capped ?? false, isFetching: query.isFetching };
}

export function useLimitingFilters(profile: Pick<S.SearchProfileWire, 'id' | 'version'> | null, options: { enabled?: boolean } = {}) {
  return useQuery<S.LimitingFiltersResponse>({
    queryKey: searchKeys.limiting(profile?.id ?? '', profile?.version ?? 0),
    queryFn: () => getLimitingFilters(profile!.id),
    enabled: (options.enabled ?? true) && !!profile,
    staleTime: 60_000,
    retry: false,
  });
}

export function useTitleSuggestions(q: string) {
  const locale = useLocale();
  const debounced = useDebouncedValue(q.trim(), TYPEAHEAD_DEBOUNCE_MS);
  return useQuery({
    queryKey: searchKeys.taxonomy(debounced, locale),
    queryFn: () => getTaxonomy({ q: debounced, locale }),
    enabled: typeaheadReady(debounced),
    staleTime: 5 * 60_000,
    select: (r) => r.suggestions,
    retry: false,
  });
}

export function useCompanySuggestions(q: string) {
  const debounced = useDebouncedValue(q.trim(), TYPEAHEAD_DEBOUNCE_MS);
  return useQuery({
    queryKey: searchKeys.companies(debounced),
    queryFn: () => searchCompanies({ q: debounced, limit: 8 }),
    // The companies route needs 2+ characters.
    enabled: debounced.length >= 2,
    staleTime: 5 * 60_000,
    select: (r) => r.items,
    retry: false,
  });
}

export function useSkillSuggestions(q: string) {
  const debounced = useDebouncedValue(q.trim(), TYPEAHEAD_DEBOUNCE_MS);
  return useQuery({
    queryKey: searchKeys.skills(debounced),
    queryFn: () => suggestSkills({ q: debounced }),
    enabled: typeaheadReady(debounced),
    staleTime: 5 * 60_000,
    select: (r) => r.items,
    retry: false,
  });
}

/** id → label for every taxonomy node in the UI locale (one cached GET /taxonomy). */
export function useTaxonomyLabels(options: { enabled?: boolean } = {}): Map<string, string> {
  const locale = useLocale();
  const query = useQuery({
    queryKey: searchKeys.taxonomy('', locale),
    queryFn: () => getTaxonomy({ locale }),
    enabled: options.enabled ?? true,
    staleTime: 60 * 60_000,
    select: (r) => new Map(r.nodes.map((n) => [n.id, n.label] as const)),
    retry: false,
  });
  return query.data ?? EMPTY_LABELS;
}

const EMPTY_LABELS: Map<string, string> = new Map();
