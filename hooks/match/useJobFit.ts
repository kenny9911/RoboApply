'use client';

// hooks/match/useJobFit.ts — the fit for one job (`POST /jobs/:id/score`,
// ARCHITECTURE.md §4.7; WP-18). The server caches the AI score and answers a
// "Quick estimate" (`kind: 'pre'`) when no model may run, so this is safe to
// call when a job opens: it never spends a user credit (platform-paid, 80 a
// day per user, beyond it the estimate).
//
// The job-detail route (WP-34) mounts the MATCH handler, which answers the
// MATCH `MatchFitView` (a superset of jobs/detail `FitView`).

import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { scoreJob } from '../../lib/api/jobs';
import { apiErrorCode } from '../../lib/api/contracts/wire';
import type { MatchFitView } from '../../lib/api/contracts/match';

export const jobFitKey = (jobId: string, resumeVariantId?: string | null) => ['match', 'fit', jobId, resumeVariantId ?? 'primary'] as const;

/** Errors no retry can fix. */
const FINAL = new Set(['unauthorized', 'not_found', 'not_implemented', 'feature_disabled', 'invalid_request', 'auth_other_brand']);

export function shouldRetryMatch(failureCount: number, error: unknown): boolean {
  const code = apiErrorCode(error);
  if (code && FINAL.has(code)) return false;
  return failureCount < 1;
}

export function useJobFit(
  jobId: string | null | undefined,
  options: { resumeVariantId?: string | null; enabled?: boolean } = {},
): UseQueryResult<MatchFitView> {
  return useQuery<MatchFitView>({
    queryKey: jobFitKey(jobId ?? '', options.resumeVariantId),
    queryFn: async ({ signal }) => {
      const res = await scoreJob(jobId!, options.resumeVariantId ? { resumeVariantId: options.resumeVariantId } : {}, { signal });
      return res.fit as unknown as MatchFitView;
    },
    enabled: !!jobId && (options.enabled ?? true),
    staleTime: 5 * 60 * 1000,
    retry: shouldRetryMatch,
  });
}
