'use client';

// hooks/offers/useOffers.ts — queries and mutations of offer comparison
// (WP-64). All requests go through lib/api/offers.ts. Offers are the user's
// own numbers on their applications; one list query feeds the drawer section
// and the Offers view.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  compareOffers,
  createNegotiationDraft,
  deleteOffer,
  explainOffers,
  getOfferBenchmark,
  listOffers,
  putOffer,
} from '../../lib/api/offers';
import type { In } from '../../lib/api/contracts/wire';
import type * as OF from '../../lib/api/contracts/offers';

export const offersKeys = {
  all: ['offers'] as const,
  list: () => ['offers', 'list'] as const,
  compare: (ids: readonly string[]) => ['offers', 'compare', [...ids]] as const,
  benchmark: (id: string) => ['offers', 'benchmark', id] as const,
};

const listQuery = {
  queryKey: offersKeys.list(),
  queryFn: () => listOffers(),
  staleTime: 30_000,
  retry: false,
} as const;

/** Every application with an offer (newest first). Pass false to skip. */
export function useOffers(enabled = true) {
  return useQuery({ ...listQuery, enabled, select: (r: OF.OffersListResponse) => r.items });
}

/**
 * May the AI actions run for this user? The server's answer on the list read
 * (aiAllowed(user) AND `ai.text`; GoApply needs the AI consent). False while
 * unknown, so an AI action never shows to a user who has not said yes.
 */
export function useOffersAiAvailable(enabled = true): boolean {
  const q = useQuery({ ...listQuery, enabled, select: (r: OF.OffersListResponse) => r.aiAvailable === true });
  return q.data === true;
}

/** The offer on one application, from the list (undefined while loading, null when none). */
export function useOffer(trackerEntryId: string, enabled = true) {
  const q = useOffers(enabled);
  const offer = q.data ? (q.data.find((o) => o.trackerEntryId === trackerEntryId) ?? null) : undefined;
  return { ...q, offer };
}

/** Side-by-side comparison of 2–5 offers (deterministic, server-computed). */
export function useOfferComparison(ids: readonly string[]) {
  return useQuery({
    queryKey: offersKeys.compare(ids),
    queryFn: () => compareOffers({ trackerEntryIds: [...ids] }),
    enabled: ids.length >= 2 && ids.length <= 5,
    retry: false,
  });
}

/** Posted pay for the role of one offer (N shown; absent below the sample). */
export function useOfferBenchmark(trackerEntryId: string, enabled = true) {
  return useQuery({
    queryKey: offersKeys.benchmark(trackerEntryId),
    queryFn: () => getOfferBenchmark(trackerEntryId),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useSaveOffer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { trackerEntryId: string; body: In<typeof OF.PutOfferBodySchema> }) => putOffer(input.trackerEntryId, input.body),
    onSuccess: () => qc.invalidateQueries({ queryKey: offersKeys.all }),
  });
}

export function useDeleteOffer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (trackerEntryId: string) => deleteOffer(trackerEntryId),
    onSuccess: () => qc.invalidateQueries({ queryKey: offersKeys.all }),
  });
}

/** AI: a negotiation message the user edits and sends themselves. */
export function useNegotiationDraft() {
  return useMutation({
    mutationFn: (input: { trackerEntryId: string; body?: In<typeof OF.NegotiationDraftBodySchema> }) => createNegotiationDraft(input.trackerEntryId, input.body ?? {}),
  });
}

/** AI: plain-language trade-offs between the compared offers. */
export function useExplainOffers() {
  return useMutation({
    mutationFn: (ids: readonly string[]) => explainOffers({ trackerEntryIds: [...ids] }),
  });
}
