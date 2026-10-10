'use client';

// hooks/jobimport/useJobImport.ts — "Added by you" state (WP-35; F-TRK-04).
//
//   const list = useAddedJobs();             infinite list of the user's added jobs
//   const flow = useJobImport();
//   await flow.readLink(url)                 → a draft to confirm (nothing saved, no credit)
//   await flow.save(fields)                  → the saved job (`job_import` credit, charged by the server)
//   flow.result / flow.error / flow.pending
//   flow.reset()
//   const remove = useRemoveAddedJob();      remove(jobId)
//
// Saving is not pre-checked against the credit summary (useCreditGate would
// refuse the call at "0 left"): re-adding the user's own job or a job already
// in our listings costs nothing, and only the server knows which one this is.
// A real `402 credits_exhausted` opens the out-of-credits sheet the same way
// the gate does (creditsExhaustedFrom → reportCreditsExhausted).
//
// API calls go through lib/api/jobImport.ts only. Query keys start with
// 'jobs' so useJobActions' invalidation (JOB_RELATED_QUERY_ROOTS) refreshes
// the list after save / apply / remove from any surface.

import { useCallback, useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import { importJob, listAddedJobs, removeAddedJob } from '../../lib/api/jobImport';
import { apiErrorCode, apiErrorDetails, newIdempotencyKey } from '../../lib/api/contracts/wire';
import type { AddedJobsResponse, ImportJobResponse, ManualJob } from '../../lib/api/contracts/jobs/import';
import { creditsExhaustedFrom, reportCreditsExhausted } from '../shared/useCreditGate';
import { useInvalidateCredits } from '../shared/useCredits';

export const jobImportKeys = {
  all: ['jobs', 'added'] as const,
  list: () => ['jobs', 'added', 'list'] as const,
};

export const ADDED_PAGE_SIZE = 20;

export function useAddedJobs(options: { enabled?: boolean } = {}) {
  return useInfiniteQuery<AddedJobsResponse, unknown, { pages: AddedJobsResponse[] }, readonly string[], string | null>({
    queryKey: jobImportKeys.list(),
    queryFn: ({ pageParam, signal }) => listAddedJobs({ limit: ADDED_PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) }, { signal }),
    initialPageParam: null,
    getNextPageParam: (last) => last.cursor ?? null,
    enabled: options.enabled ?? true,
    staleTime: 30_000,
  });
}

/** How a failed import call should read to the user. */
export type ImportErrorView =
  | { kind: 'locked'; until: string | null }
  | { kind: 'hourly'; retryAfterSec: number | null }
  | { kind: 'credits_exhausted' }
  | { kind: 'feature_disabled' }
  | { kind: 'invalid' }
  | { kind: 'failed' };

export function importErrorView(err: unknown): ImportErrorView {
  const code = apiErrorCode(err);
  const details = apiErrorDetails<{ reason?: unknown; lockedUntil?: unknown; retryAfterSec?: unknown }>(err) ?? {};
  if (code === 'rate_limited') {
    if (details.reason === 'import_locked') return { kind: 'locked', until: typeof details.lockedUntil === 'string' ? details.lockedUntil : null };
    return { kind: 'hourly', retryAfterSec: typeof details.retryAfterSec === 'number' ? details.retryAfterSec : null };
  }
  if (code === 'credits_exhausted') return { kind: 'credits_exhausted' };
  if (code === 'feature_disabled') return { kind: 'feature_disabled' };
  if (code === 'invalid_request') return { kind: 'invalid' };
  return { kind: 'failed' };
}

export interface JobImportFlow {
  /** The last answer from the server (draft, needs-text, failure or saved job). */
  result: ImportJobResponse | null;
  error: ImportErrorView | null;
  pending: 'read' | 'save' | null;
  readLink(url: string): Promise<ImportJobResponse | null>;
  /** Save confirmed fields; `importId` names the draft they confirm. */
  save(fields: ManualJob, importId?: string | null): Promise<ImportJobResponse | null>;
  reset(): void;
}

export function useJobImport(): JobImportFlow {
  const queryClient = useQueryClient();
  const invalidateCredits = useInvalidateCredits();
  const [result, setResult] = useState<ImportJobResponse | null>(null);
  const [error, setError] = useState<ImportErrorView | null>(null);
  const [pending, setPending] = useState<JobImportFlow['pending']>(null);

  const readLink = useCallback(async (url: string) => {
    setPending('read');
    setError(null);
    try {
      const r = await importJob({ url: url.trim() });
      setResult(r);
      return r;
    } catch (err) {
      setError(importErrorView(err));
      return null;
    } finally {
      setPending(null);
    }
  }, []);

  const save = useCallback(
    async (fields: ManualJob, importId?: string | null) => {
      setPending('save');
      setError(null);
      try {
        // One key per save, so a network retry inside the call never charges twice.
        const saved = await importJob(importId ? { manual: fields, importId } : { manual: fields }, { idempotencyKey: newIdempotencyKey() });
        setResult(saved);
        void queryClient.invalidateQueries({ queryKey: jobImportKeys.all });
        void queryClient.invalidateQueries({ queryKey: ['feed'] });
        return saved;
      } catch (err) {
        const exhausted = creditsExhaustedFrom(err, 'job_import');
        if (exhausted) reportCreditsExhausted(exhausted);
        setError(importErrorView(err));
        return null;
      } finally {
        setPending(null);
        void invalidateCredits();
      }
    },
    [invalidateCredits, queryClient],
  );

  const reset = useCallback(() => {
    setResult(null);
    setError(null);
  }, []);

  return { result, error, pending, readLink, save, reset };
}

export function useRemoveAddedJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => removeAddedJob(jobId),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: jobImportKeys.all });
      void queryClient.invalidateQueries({ queryKey: ['feed'] });
    },
  });
}
