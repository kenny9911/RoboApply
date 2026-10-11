'use client';

// hooks/feed/useExplore.ts — Explore (PRODUCT F-FEED-13, F-FEED-17):
// the function categories with live counts (`GET /feed/explore`, cached 10
// minutes by the server) and the plain-language search that turns a sentence
// into a filter change the user confirms (`POST /feed/nl-query`).
//
// What the sentence left over (SM-9). The parts of a request that became no
// filter come back in two lists: `rankedBy` (topics the list can be ORDERED
// by: "climate startups", "Rust") and `unmatched` (every left-over phrase, in
// the person's words). Nothing in either list is checked against a posting.
//   • `nlLines` splits them into what the page says: the ranking terms, and
//     the phrases that are simply not checked;
//   • when the person applies the proposal, `rankListBy` hands the ranking
//     terms to the list, and `useListRelevance` gives them to /jobs, which
//     sends them as `relevance` with every page (useFeed.ts) until the search
//     changes or the person clears them. The state lives in memory for the
//     visit: a reload shows the plain order again;
//   • a request that changes no filter (the saved search already has the role)
//     can still leave ranking terms. The person may rank the list by them
//     without saving anything: `rankListBy({ saved: false })`. No new version
//     of the search follows, so the terms belong to the version on screen and
//     end at its next change.

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';

import { getExplore, nlQuery } from '../../lib/api/feed';
import { createStore } from '../shared/store';
import { feedKeys } from './keys';
import { FEED_RELEVANCE_MAX } from './useFeed';

export function useExplore(enabled = true) {
  return useQuery({
    queryKey: feedKeys.explore(),
    queryFn: ({ signal }) => getExplore({ signal }),
    enabled,
    staleTime: 10 * 60 * 1000,
    retry: false,
  });
}

export function useNlQuery() {
  return useMutation({
    mutationFn: (vars: { text: string; searchProfileId?: string }) =>
      nlQuery(vars.searchProfileId ? { text: vars.text, searchProfileId: vars.searchProfileId } : { text: vars.text }),
  });
}

// ── The two lines of a proposal ───────────────────────────────────────────

const fold = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * What the page says about the left-over parts of a request: `rankedBy` as it
 * came, and `notChecked` = the unmatched phrases no ranking term was taken
 * from (a pay, visa or schedule wish that became no filter). The same rule as
 * the server's own sentence (feed `uncheckedPhrases`). Pure.
 */
export function nlLines(input: { rankedBy?: readonly string[] | null; unmatched?: readonly string[] | null }): { rankedBy: string[]; notChecked: string[] } {
  const clean = (list: readonly string[] | null | undefined) => (Array.isArray(list) ? list.filter((t): t is string => typeof t === 'string' && !!t.trim()).map((t) => t.trim()) : []);
  const rankedBy = clean(input.rankedBy);
  const terms = rankedBy.map(fold);
  const notChecked = clean(input.unmatched).filter((phrase) => {
    const p = fold(phrase);
    return !terms.some((t) => p.includes(t) || t.includes(p));
  });
  return { rankedBy, notChecked };
}

// ── The words a list is ranked by ─────────────────────────────────────────

export interface ListRelevance {
  searchProfileId: string;
  /** The ranking terms, as the server named them. */
  terms: string[];
  /** The terms joined by a space: what is sent as `relevance`. */
  text: string;
  /** The saved search's version the proposal was made against. */
  baseVersion: number;
  /**
   * The version of the search the terms belong to. A saved change: the version
   * it produced, once /jobs has seen it (null until then). Nothing saved: the
   * version the terms were chosen against, from the start.
   */
  version: number | null;
}

const listRelevance = createStore<ListRelevance | null>(null);

/**
 * Called when the person applies a plain-language proposal: rank that saved
 * search's list by the proposal's terms. No terms (or terms too long to send)
 * clears any earlier ones: a new search starts from the plain order.
 *
 * `saved` (default true): the proposal's filter change was saved, so the
 * search's next version is the applied change and the terms last until the
 * version after it. `saved: false`: nothing was saved (the request changed no
 * filter): the terms belong to `baseVersion` itself and end at its next change.
 */
export function rankListBy(input: { searchProfileId: string; baseVersion: number; rankedBy: readonly string[] | null | undefined; saved?: boolean }): void {
  const terms = nlLines({ rankedBy: input.rankedBy }).rankedBy;
  const text = terms.join(' ');
  if (!terms.length || text.length > FEED_RELEVANCE_MAX) {
    listRelevance.set(null);
    return;
  }
  listRelevance.set({ searchProfileId: input.searchProfileId, terms, text, baseVersion: input.baseVersion, version: input.saved === false ? input.baseVersion : null });
}

/** The sorts whose order the ranking terms take part in (the server runs its lexical and dense legs for these only). */
export function sortUsesRelevance(sort: string | null | undefined): boolean {
  return sort === 'recommended' || sort === 'best_fit';
}

export function clearListRelevance(): void {
  listRelevance.set(null);
}

/** Do the stored terms belong to the search on screen, as it is now? Pure. */
export function relevanceFor(value: ListRelevance | null, profile: { id: string; version: number } | null): ListRelevance | null {
  if (!value || !profile || value.searchProfileId !== profile.id) return null;
  // Until /jobs has seen the applied change, the search may still show the version the proposal was made against.
  if (value.version === null) return profile.version >= value.baseVersion ? value : null;
  return profile.version === value.version ? value : null;
}

/**
 * The words the list of `profile` is ranked by, and the way to clear them.
 * They last until the search changes (any later version of it, or another
 * search) or the person clears them.
 */
export function useListRelevance(profile: { id: string; version: number } | null): { relevance: ListRelevance | null; clear: () => void } {
  const value = useSyncExternalStore(listRelevance.subscribe, listRelevance.get, () => null);
  const id = profile?.id ?? null;
  const version = profile?.version ?? null;
  useEffect(() => {
    if (!value || id === null || version === null) return;
    if (value.searchProfileId !== id) listRelevance.set(null);
    else if (value.version === null) {
      // The first version after the one the proposal was made against is the applied change.
      if (version > value.baseVersion) listRelevance.set({ ...value, version });
    } else if (value.version !== version) listRelevance.set(null);
  }, [value, id, version]);
  const clear = useCallback(() => listRelevance.set(null), []);
  return { relevance: relevanceFor(value, id !== null && version !== null ? { id, version } : null), clear };
}

/** Tests only. */
export const __listRelevanceStore = listRelevance;
