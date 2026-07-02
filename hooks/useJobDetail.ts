'use client';

// hooks/useJobDetail.ts
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
