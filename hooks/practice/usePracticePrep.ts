'use client';

// hooks/practice/usePracticePrep.ts — the practice setup's interview prep:
// the industry list, an industry's roles, the job search as the candidate
// types, and the interview plan for the chosen target.
//
// The search and the plan reach a language model and search vendors, so they
// are debounced, cached by their inputs, and never retried automatically: a
// failure shows its own state and the candidate decides to try again.

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useLocale } from 'next-intl';

import { prepApi, type PrepPlanBody, type PrepSearchBody } from '../../lib/api/interviewEngine';
import { typeaheadReady, useDebouncedValue } from '../search/useFilterQueries';

/** A search runs once the candidate pauses this long (it asks a model and job boards). */
export const PREP_SEARCH_DEBOUNCE_MS = 650;

export const practicePrepKeys = {
  all: ['practice', 'prep'] as const,
  industries: (locale: string) => [...practicePrepKeys.all, 'industries', locale] as const,
  roles: (industry: string, locale: string) => [...practicePrepKeys.all, 'roles', industry, locale] as const,
  search: (body: PrepSearchBody, locale: string) => [...practicePrepKeys.all, 'search', locale, body.query, body.company ?? '', body.industry ?? ''] as const,
  plan: (body: PrepPlanBody, locale: string) => [...practicePrepKeys.all, 'plan', locale, JSON.stringify(body)] as const,
};

export function usePrepIndustries(enabled = true) {
  const locale = useLocale();
  return useQuery({
    queryKey: practicePrepKeys.industries(locale),
    queryFn: () => prepApi.industries(),
    enabled,
    staleTime: 60 * 60_000,
    retry: false,
    select: (data) => data.industries,
  });
}

/** The roles of an industry (listed or typed); null = nothing chosen. */
export function useIndustryRoles(industry: string | null) {
  const locale = useLocale();
  const value = (industry ?? '').trim();
  return useQuery({
    queryKey: practicePrepKeys.roles(value, locale),
    queryFn: () => prepApi.roles(value),
    enabled: value.length > 0,
    staleTime: 60 * 60_000,
    retry: false,
    select: (data) => data.roles,
  });
}

/** Job search for what the candidate typed, debounced; the last answer stays on screen while the next one loads. */
export function usePrepSearch(input: { query: string; company?: string; industry?: string | null; enabled?: boolean }) {
  const locale = useLocale();
  const body: PrepSearchBody = {
    query: input.query.trim(),
    ...(input.company?.trim() ? { company: input.company.trim() } : {}),
    ...(input.industry?.trim() ? { industry: input.industry.trim() } : {}),
  };
  // Debounce the serialized body: a string only changes when the inputs do.
  const serialized = JSON.stringify(body);
  const debouncedSerialized = useDebouncedValue(serialized, PREP_SEARCH_DEBOUNCE_MS);
  const debounced = JSON.parse(debouncedSerialized) as PrepSearchBody;
  const ready = (input.enabled ?? true) && typeaheadReady(debounced.query);
  const query = useQuery({
    queryKey: practicePrepKeys.search(debounced, locale),
    queryFn: ({ signal }) => prepApi.search(debounced, { signal }),
    enabled: ready,
    staleTime: 5 * 60_000,
    retry: false,
    placeholderData: keepPreviousData,
  });
  // "Still typing" counts as searching (from the first keystroke, before the
  // debounce settles), so the screen never flashes an empty result.
  const liveReady = (input.enabled ?? true) && typeaheadReady(body.query);
  const pending = liveReady && (query.isFetching || debouncedSerialized !== serialized);
  return { ...query, ready, pending, settledQuery: debounced.query };
}

/** The interview plan for a target; null body = no target yet. */
export function usePrepPlan(body: PrepPlanBody | null) {
  const locale = useLocale();
  return useQuery({
    queryKey: body ? practicePrepKeys.plan(body, locale) : [...practicePrepKeys.all, 'plan', 'none'],
    queryFn: ({ signal }) => prepApi.plan(body as PrepPlanBody, { signal }),
    enabled: body !== null,
    staleTime: 30 * 60_000,
    gcTime: 60 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    select: (data) => data.plan,
  });
}
