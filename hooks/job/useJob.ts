'use client';

// hooks/job/useJob.ts — job detail queries (WP-34). Query keys are rooted at
// 'job' so `useJobActions` (hooks/shared) refreshes them after save, apply and
// undo (JOB_RELATED_QUERY_ROOTS).
//
// Two reads of one job page: the person opened the job (`getJob`: the server
// records the view, which the feed's "seen and skipped" rule reads), or the
// page is shown before they picked it (`preview`: the desktop Jobs list's
// first job; `getJobPreview` records nothing). Each has its own cache entry,
// so opening a previewed job reads the page again and the view is recorded;
// while that read runs, the page already on screen stays (no skeleton).

import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { getCompanyJobs, getCompanyNews, getJob, getJobPreview, getSimilarJobs } from '../../lib/api/jobs';
import { apiErrorCode } from '../../lib/api/contracts/wire';
import type { CompanyNewsResponse, JobDetailResponse, SimilarJobsResponse } from '../../lib/api/contracts/jobs/detail';
import type { CompanyJobsResponse } from '../../lib/api/contracts/jobs/companies';

export const jobKeys = {
  all: ['job'] as const,
  detail: (id: string) => ['job', 'detail', id] as const,
  /** The same page read as a preview (no view recorded). Under `detail(id)`, so whatever refreshes the job's page refreshes both. */
  preview: (id: string) => ['job', 'detail', id, 'preview'] as const,
  similar: (id: string) => ['job', 'similar', id] as const,
  news: (id: string) => ['job', 'news', id] as const,
  companyJobs: (companyId: string) => ['job', 'companyJobs', companyId] as const,
};

/** Errors no retry can fix. */
const FINAL = new Set(['not_found', 'unauthorized', 'auth_expired', 'AUTH_REQUIRED', 'auth_other_brand', 'feature_disabled', 'not_implemented', 'invalid_request']);

export function shouldRetryJob(failureCount: number, error: unknown): boolean {
  const code = apiErrorCode(error);
  if (code && FINAL.has(code)) return false;
  return failureCount < 1;
}

export interface UseJobOptions {
  /**
   * Show the page without counting it as the person opening the job
   * (`GET /jobs/:id?preview=1`; see the header). Default: an open.
   */
  preview?: boolean;
}

export function useJob(jobId: string | null | undefined, options: UseJobOptions = {}): UseQueryResult<JobDetailResponse> {
  const preview = options.preview === true;
  return useQuery<JobDetailResponse>({
    queryKey: preview ? jobKeys.preview(jobId ?? '') : jobKeys.detail(jobId ?? ''),
    queryFn: ({ signal }) => (preview ? getJobPreview(jobId!, { signal }) : getJob(jobId!, { signal })),
    enabled: !!jobId,
    staleTime: 60 * 1000,
    retry: shouldRetryJob,
    // The same job read the other way (a preview the person then opens) stays on screen while this read runs.
    // Never another job's page.
    placeholderData: (previous) => (previous?.job?.id && previous.job.id === jobId ? previous : undefined),
  });
}

export function useSimilarJobs(jobId: string | null | undefined, options: { enabled?: boolean } = {}): UseQueryResult<SimilarJobsResponse> {
  return useQuery<SimilarJobsResponse>({
    queryKey: jobKeys.similar(jobId ?? ''),
    queryFn: ({ signal }) => getSimilarJobs(jobId!, { signal }),
    enabled: !!jobId && (options.enabled ?? true),
    staleTime: 5 * 60 * 1000,
    retry: shouldRetryJob,
  });
}

/** V2 company news: call only when the `companyNews` flag is on. */
export function useCompanyNews(jobId: string | null | undefined, options: { enabled?: boolean } = {}): UseQueryResult<CompanyNewsResponse> {
  return useQuery<CompanyNewsResponse>({
    queryKey: jobKeys.news(jobId ?? ''),
    queryFn: ({ signal }) => getCompanyNews(jobId!, { signal }),
    enabled: !!jobId && (options.enabled ?? false),
    staleTime: 30 * 60 * 1000,
    retry: false,
  });
}

/** Live jobs at a company (first page), for the Company tab. */
export function useCompanyJobs(companyId: string | null | undefined, options: { enabled?: boolean } = {}): UseQueryResult<CompanyJobsResponse> {
  return useQuery<CompanyJobsResponse>({
    queryKey: jobKeys.companyJobs(companyId ?? ''),
    queryFn: ({ signal }) => getCompanyJobs(companyId!, undefined, { signal }),
    enabled: !!companyId && (options.enabled ?? true),
    staleTime: 5 * 60 * 1000,
    retry: shouldRetryJob,
  });
}
