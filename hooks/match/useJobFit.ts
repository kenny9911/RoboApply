'use client';

// hooks/match/useJobFit.ts — the fit for one job (`POST /jobs/:id/score`,
// ARCHITECTURE.md §4.7; WP-18). The server caches the AI score and answers a
// "Quick estimate" (`kind: 'pre'`) when no model may run, so this is safe to
// call when a job opens: it never spends a user credit (platform-paid, 80 a
// day per user, beyond it the estimate).
//
// The job-detail route (WP-34) mounts the MATCH handler, which answers the
// MATCH `MatchFitView` (a superset of jobs/detail `FitView`).
//
// One fit per job: the answer is always for the person's main resume, so the
// request carries no resume version and the cache has one key per job. A fit
// for another version is a different, separately named measure that only
// tailoring shows ("With this version").

import { useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';

import { scoreJob } from '../../lib/api/jobs';
import { apiErrorCode } from '../../lib/api/contracts/wire';
import type { MatchFitView } from '../../lib/api/contracts/match';

/** The cache key of a job's fit: one per job. */
export const jobFitKey = (jobId: string) => ['match', 'fit', jobId] as const;

/** Errors no retry can fix. */
const FINAL = new Set(['unauthorized', 'not_found', 'not_implemented', 'feature_disabled', 'invalid_request', 'auth_other_brand']);

export function shouldRetryMatch(failureCount: number, error: unknown): boolean {
  const code = apiErrorCode(error);
  if (code && FINAL.has(code)) return false;
  return failureCount < 1;
}

export function useJobFit(jobId: string | null | undefined, options: { enabled?: boolean } = {}): UseQueryResult<MatchFitView> {
  return useQuery<MatchFitView>({
    queryKey: jobFitKey(jobId ?? ''),
    queryFn: async ({ signal }) => {
      const res = await scoreJob(jobId!, {}, { signal });
      return res.fit as unknown as MatchFitView;
    },
    enabled: !!jobId && (options.enabled ?? true),
    staleTime: 5 * 60 * 1000,
    retry: shouldRetryMatch,
  });
}

/** The rewrite did not happen: the server answered something other than the AI fit in the reader's language. */
export class FitRewriteNotDoneError extends Error {
  constructor() {
    super('fit_rewrite_not_done');
    this.name = 'FitRewriteNotDoneError';
  }
}

/** Is this answer the AI fit, written in the language that was asked for? */
export function isRewrittenFit(fit: MatchFitView | null | undefined): fit is MatchFitView {
  return !!fit && fit.kind === 'ai' && fit.summaryLocaleStale === false;
}

/**
 * Rewrite the AI-written parts of a fit in the reader's language (the score
 * route's `regenerateExplanation`). The server keeps the stored score and its
 * components and writes only the summary, strengths and gaps again, when the
 * person asks. It is platform-paid like the score itself.
 *
 * The call can answer 200 without a rewrite (the day's limit is used up, the
 * model failed): that answer is the stored fit still flagged, or a quick
 * estimate. Neither replaces the fit on screen; the mutation fails instead, so
 * the reader is told and the AI fit stays as it was.
 */
export function useRewriteFitText(jobId: string | null | undefined): UseMutationResult<MatchFitView, unknown, void> {
  const qc = useQueryClient();
  return useMutation<MatchFitView, unknown, void>({
    mutationFn: async () => {
      const res = await scoreJob(jobId!, { regenerateExplanation: true });
      const fit = res.fit as unknown as MatchFitView;
      if (!isRewrittenFit(fit)) throw new FitRewriteNotDoneError();
      return fit;
    },
    onSuccess: (fit) => qc.setQueryData(jobFitKey(jobId ?? ''), fit),
  });
}
