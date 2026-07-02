'use client';

// hooks/useTodayMatches.ts
//
// Data layer for the V3 Today screen (/home · Route 1). Composes three
// existing RaV2Api surfaces — no new contract:
//
//   • useResumeList()  → resolve the user's default resume variant. The match
//                        score for every card is computed against this variant
//                        (the base "Master Resume" by default).
//   • search.run({ sortBy:'match_desc' })  → the match feed rows (RAJobListItem).
//   • jobs.score(id,{resumeVariantId})      → a deterministic 0..100 score per
//                        card. The stub seeds NO scores, so `matchScoreCached`
//                        on the list rows is null on cold load; we score each
//                        visible card lazily so the donut shows a real number.
//                        Cached after the first call (stub keeps the Map).
//
// The expanded reasoning (rationale / signals) is fetched separately by the
// card via `useJobDetail(id,{resumeVariantId})` — once `jobs.score` has run for
// that (job, variant) pair, `jobs.get` returns the cached RAJobMatchScoreView.
//
// Query keys are namespaced `['v3','today',…]` per the build rules.

import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { raV2Api } from '../lib/api/v2';
import type {
  JobScoreResponse,
  RAResumeVariantSummary,
  SearchRunResponse,
} from '../lib/api/v2';
import { useResumeList } from './useResumes';

export const todayKeys = {
  all: ['v3', 'today'] as const,
  feed: (variantId: string | null, limit: number) =>
    ['v3', 'today', 'feed', variantId ?? '', limit] as const,
  score: (jobId: string, variantId: string) =>
    ['v3', 'today', 'score', jobId, variantId] as const,
};

/** Pick the resume variant the feed scores against: prefer the `base` master
 *  resume, else the first variant in the list. Returns null while loading. */
function pickDefaultVariant(
  resumes: RAResumeVariantSummary[] | undefined,
): string | null {
  if (!resumes || resumes.length === 0) return null;
  const base = resumes.find((r) => r.kind === 'base');
  return (base ?? resumes[0]).id;
}

export interface UseTodayMatchesResult {
  /** The match feed (RAJobListItem[]). */
  feed: ReturnType<typeof useTodayFeed>;
  /** The resume variant id every card scores against (null while loading). */
  resumeVariantId: string | null;
  /** True until the resume list resolves (needed before the feed can score). */
  isResolvingResume: boolean;
}

function useTodayFeed(resumeVariantId: string | null, limit: number) {
  return useQuery<SearchRunResponse>({
    queryKey: todayKeys.feed(resumeVariantId, limit),
    // The feed itself doesn't need the variant to load — but we want a stable
    // cache entry per variant so re-scoring keys line up.
    queryFn: () => raV2Api.search.run({ sortBy: 'match_desc', limit }),
  });
}

/** Top-level Today data hook. */
export function useTodayMatches(limit = 8): UseTodayMatchesResult {
  const resumeList = useResumeList();
  const resumeVariantId = useMemo(
    () => pickDefaultVariant(resumeList.data?.resumes),
    [resumeList.data?.resumes],
  );
  const feed = useTodayFeed(resumeVariantId, limit);

  return {
    feed,
    resumeVariantId,
    isResolvingResume: resumeList.isLoading,
  };
}

/** Deterministic per-card score (0..100). Lazily computes + caches the match
 *  score for one (job, variant) pair. `enabled` gates it so a card only scores
 *  once its variant is known. The result is also written to the v2 job-detail
 *  cache so the expanded reasoning resolves instantly. */
export function useJobScore(
  jobId: string,
  resumeVariantId: string | null,
) {
  return useQuery<JobScoreResponse>({
    queryKey: resumeVariantId
      ? todayKeys.score(jobId, resumeVariantId)
      : ['v3', 'today', 'score', jobId, 'null'],
    enabled: Boolean(resumeVariantId),
    // Scores are deterministic + cached server-side; no need to refetch.
    staleTime: Infinity,
    queryFn: () => {
      if (!resumeVariantId) throw new Error('Missing resume variant');
      return raV2Api.jobs.score(jobId, { resumeVariantId });
    },
  });
}

/** "Pass" a match — a local dismiss with no server write in the stub world.
 *  Exposed as a mutation-shaped helper so the card can show a transient state;
 *  the actual feed filtering is client-side (per the proto's `onPass`). */
export function usePassMatch() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async () => {
      // No-op against the contract: passing is a feed-local decision today.
      // (Real impl would POST a "not interested" signal; out of scope.)
      return;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['v3', 'activity', 'orbStats'] });
    },
  });
}
