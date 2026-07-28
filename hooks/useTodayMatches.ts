'use client';

// hooks/useTodayMatches.ts
//
// Data layer for /jobs (destination 1 of 4). Composes existing RaV2Api
// surfaces — no new contract:
//
//   • useResumeList()  → resolve the user's default resume variant. The match
//                        score for every card is computed against this variant
//                        (the base "Master Resume" by default).
//   • usePreferences() → the user's stated search. See RETRIEVAL below.
//   • search.run({ sortBy:'match_desc', …filters })  → the feed (RAJobListItem).
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
// ─── RETRIEVAL ────────────────────────────────────────────────────────────
//
// This hook used to call `search.run({ sortBy:'match_desc', limit })` and
// nothing else — no q, no location, no workType, no salaryMin, no
// employmentType — even though `routes/search.ts` accepts all five and
// `RAJobIndexService.search` applies all five (title/company `contains`,
// `where.workType`, `where.employmentType`, `salaryMax >= salaryMin`).
//
// The effect: every preference in the product was inert. A user who said
// "remote only, $150k+, backend" saw the same list as everyone else, in the
// same order, because the only thing that ever reached the server was the sort.
// Capturing preferences more elegantly would not have changed a single row.
//
// Two rules govern what we send, both learned the hard way:
//
//   1. NEVER send a filter the user did not state. `location` is a substring
//      match against the job's location text, so passing a city we merely
//      inferred from a résumé address zeroes the feed for exactly the people
//      most likely to be searching outside it — someone in Bangalore looking
//      for remote EU/US work is the canonical case. Location is opt-in.
//   2. Absence means unfiltered, not zero. Every filter below is omitted when
//      the user has not set it, so a fresh account gets the whole index ranked
//      by fit rather than an empty screen.
//
// Query keys are namespaced `['v3','today',…]` per the build rules, and the
// filter set is part of the key so changing a preference refetches.

import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { raV2Api } from '../lib/api/v2';
import type {
  JobScoreResponse,
  RAPreferences,
  RAResumeVariantSummary,
  SearchRunResponse,
  SearchQuery,
} from '../lib/api/v2';
import { useResumeList } from './useResumes';
import { usePreferences } from './usePreferences';

export const todayKeys = {
  all: ['v3', 'today'] as const,
  feed: (variantId: string | null, limit: number, filters: FeedFilters) =>
    ['v3', 'today', 'feed', variantId ?? '', limit, filters] as const,
  score: (jobId: string, variantId: string) =>
    ['v3', 'today', 'score', jobId, variantId] as const,
};

/** The subset of SearchQuery the feed derives from stored preferences. */
type FeedFilters = Pick<
  SearchQuery,
  'q' | 'location' | 'workType' | 'salaryMin' | 'employmentType'
>;

/**
 * Stored preferences → search filters.
 *
 * Only fields the user actually stated survive. Everything here is omitted
 * rather than defaulted, because `RAJobIndexService` treats a present filter as
 * a hard constraint: `location` is a `contains` match and `workType` /
 * `employmentType` are equality, so a guessed value does not bias the ranking,
 * it deletes rows.
 */
export function preferencesToFilters(
  prefs: RAPreferences | undefined,
): FeedFilters {
  if (!prefs) return {};
  const out: FeedFilters = {};

  // Role titles drive the keyword match against title/company. Joined because
  // `q` is a single needle; the scorer does the nuanced work downstream.
  const roles = (prefs.roleTitles ?? []).map((r) => r.trim()).filter(Boolean);
  if (roles.length === 1) out.q = roles[0];

  // Work mode is only a filter when the user narrowed to exactly one. Having
  // all three on (the default) means "no preference", and sending one of them
  // would silently hide the other two thirds of the index.
  const modes = prefs.workModes ?? { remote: false, hybrid: false, onsite: false };
  const on = (['remote', 'hybrid', 'onsite'] as const).filter((m) => modes[m]);
  if (on.length === 1) out.workType = on[0];

  // Location: opt-in only, and only when a single city is set. `cities` is
  // populated by the user, never seeded from the résumé address (see RETRIEVAL
  // note 1).
  const cities = (prefs.cities ?? []).map((c) => c.trim()).filter(Boolean);
  if (cities.length === 1 && !modes.remote) out.location = cities[0];

  // Salary is deliberately NOT a filter, and this is the one worth explaining.
  //
  // `RAJobIndexService` applies it as `where.salaryMax = { gte: salaryMin }`.
  // In Prisma a `gte` comparison does not match NULL, so a stated floor removes
  // every posting that does not publish a salary — which is most of them. A
  // user who says "$180k+" would not get well-paid jobs; they would get the
  // small subset of jobs that happen to advertise a range, and silently lose
  // the rest. The fixture demonstrates it exactly: salaryMinK 180 empties the
  // whole feed.
  //
  // Pay still counts — the scorer weighs it inside "Location, pay, and visa"
  // and can reason about an absent figure instead of treating it as a
  // disqualification. Ranking degrades gracefully; a hard filter does not.

  return out;
}

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

function useTodayFeed(
  resumeVariantId: string | null,
  limit: number,
  filters: FeedFilters,
  enabled: boolean,
) {
  return useQuery<SearchRunResponse>({
    queryKey: todayKeys.feed(resumeVariantId, limit, filters),
    // The feed itself doesn't need the variant to load — but we want a stable
    // cache entry per variant so re-scoring keys line up.
    queryFn: () => raV2Api.search.run({ sortBy: 'match_desc', limit, ...filters }),
    // Hold the request until preferences resolve. Firing early would run the
    // unfiltered search, then refire with filters — two requests, and the user
    // watches a correct-looking feed get replaced by a different one.
    enabled,
  });
}

/** Top-level /jobs data hook. */
export function useTodayMatches(limit = 8): UseTodayMatchesResult {
  const resumeList = useResumeList();
  const prefs = usePreferences();
  const resumeVariantId = useMemo(
    () => pickDefaultVariant(resumeList.data?.resumes),
    [resumeList.data?.resumes],
  );
  const filters = useMemo(
    () => preferencesToFilters(prefs.data?.preferences),
    [prefs.data],
  );
  // A preferences FAILURE must not block the feed — an unfiltered list of real
  // jobs beats an empty screen, so we proceed once the query settles either way.
  const feed = useTodayFeed(
    resumeVariantId,
    limit,
    filters,
    !prefs.isLoading,
  );

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
