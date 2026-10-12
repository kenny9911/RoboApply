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

import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useLocale, useMessages } from 'next-intl';

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

type TaxonomyMessages = Partial<Record<'categories' | 'groups' | 'roles', Record<string, string>>>;

export interface TaxonomyLabelState {
  labels: Map<string, string>;
  /** False while the tree is still loading: hold a label rather than show a raw id. */
  ready: boolean;
}

/**
 * id → label in the UI language. The server's tree has English and Simplified
 * Chinese only, so every other language takes the translated names from the
 * `taxonomy` messages (categories, groups, roles) and falls back to the
 * server's English where a name is not translated yet. Pure, for tests.
 */
export function localizedTaxonomyLabels(
  nodes: ReadonlyArray<{ id: string; label: string }>,
  locale: string,
  messages: TaxonomyMessages | null | undefined,
): Map<string, string> {
  const out = new Map(nodes.map((n) => [n.id, n.label] as const));
  // en and zh are the server's own curated names.
  if (locale === 'en' || locale === 'zh' || !messages) return out;
  for (const group of ['categories', 'groups', 'roles'] as const) {
    for (const [id, label] of Object.entries(messages[group] ?? {})) {
      if (out.has(id) && typeof label === 'string' && label.trim()) out.set(id, label);
    }
  }
  return out;
}

/** {@link useTaxonomyLabels} plus whether the labels have arrived. */
export function useTaxonomyLabelState(options: { enabled?: boolean } = {}): TaxonomyLabelState {
  const locale = useLocale();
  const messages = (useMessages() as { taxonomy?: TaxonomyMessages }).taxonomy;
  const query = useQuery({
    queryKey: searchKeys.taxonomy('', locale),
    queryFn: () => getTaxonomy({ locale }),
    enabled: options.enabled ?? true,
    staleTime: 60 * 60_000,
    retry: false,
  });
  const nodes = query.data?.nodes;
  const labels = useMemo(() => (nodes ? localizedTaxonomyLabels(nodes, locale, messages) : EMPTY_LABELS), [nodes, locale, messages]);
  // A failed load is "ready" too: the caller falls back to a readable form of the id.
  return { labels, ready: !!nodes || query.isError };
}

/** id → label for every taxonomy node in the UI locale (one cached GET /taxonomy). */
export function useTaxonomyLabels(options: { enabled?: boolean } = {}): Map<string, string> {
  return useTaxonomyLabelState(options).labels;
}

/** A taxonomy id nobody has a name for ("swe_backend" → "Swe backend"): never the raw id. */
export function readableTaxonomyId(id: string): string {
  const words = id.replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : id;
}

const EMPTY_LABELS: Map<string, string> = new Map();
