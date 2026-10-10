'use client';

// hooks/useJobDetail.ts
//
// @deprecated (WP-34) — use `hooks/job` (`useJob`, `useSimilarJobs`) and
// `hooks/shared/useJobActions` over `lib/api/jobs.ts` (GET /api/v1/roboapply/jobs/:id).
// `components/v3/today/*` still imports this until WP-33's rework lands;
// WP-75 deletes it after a zero-importer grep.
//
// Read a single job (with optional matchScore + keywords). Used by:
//   • /search right pane (selected job id from URL state)
//   • /jobs/[id] standalone full-page detail
//
// Also exposes mutations for the three action buttons:
//   • save  (POST /jobs/:id/save  → creates a 'bookmarked' tracker entry)
//   • apply (POST /jobs/:id/apply → creates an 'applied' tracker entry)
// Both invalidate the tracker list + the job detail (the trackerEntry field
// flips) + the search list (the isBookmarked flag flips).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { raV2Api } from '../lib/api/v2';
import type {
  JobApplyBody,
  JobApplyResponse,
  JobGetParams,
  JobGetResponse,
  JobSaveResponse,
} from '../lib/api/v2';

function jobKey(id: string | null | undefined, params: JobGetParams | undefined) {
  return ['v2', 'job', id ?? '', params ?? {}] as const;
}

/** @deprecated Use `useJob` from hooks/job (WP-34). */
export function useJobDetail(
  id: string | null | undefined,
  params?: JobGetParams,
) {
  return useQuery<JobGetResponse>({
    queryKey: jobKey(id, params),
    queryFn: () => {
      if (!id) {
        throw new Error('Missing job id');
      }
      return raV2Api.jobs.get(id, params);
    },
    enabled: Boolean(id),
  });
}

/** @deprecated Use `useJobActions(jobId).save()` from hooks/shared (WP-34). */
export function useSaveJob() {
  const qc = useQueryClient();
  return useMutation<JobSaveResponse, Error, { id: string; excitementStars?: number }>(
    {
      mutationFn: ({ id, excitementStars }) =>
        raV2Api.jobs.save(id, excitementStars !== undefined ? { excitementStars } : undefined),
      onSuccess: (_data, vars) => {
        void qc.invalidateQueries({ queryKey: ['v2', 'tracker'] });
        void qc.invalidateQueries({ queryKey: ['v2', 'search'] });
        void qc.invalidateQueries({ queryKey: ['v2', 'job', vars.id] });
        void qc.invalidateQueries({ queryKey: ['v2', 'home', 'jobs'] });
      },
    },
  );
}

/** @deprecated Use `useJobActions(jobId).applyOnCompanySite()` / `.markApplied()` (WP-34). */
export function useApplyJob() {
  const qc = useQueryClient();
  return useMutation<JobApplyResponse, Error, { id: string; body: JobApplyBody }>({
    mutationFn: ({ id, body }) => raV2Api.jobs.apply(id, body),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ['v2', 'tracker'] });
      void qc.invalidateQueries({ queryKey: ['v2', 'search'] });
      void qc.invalidateQueries({ queryKey: ['v2', 'job', vars.id] });
      void qc.invalidateQueries({ queryKey: ['v2', 'home', 'jobs'] });
    },
  });
}
