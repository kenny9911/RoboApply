'use client';

// hooks/tailor/useTailorTargets.ts — the jobs a user can tailor for when the
// tailor flow starts without one (the editor's Tailor button; INT-10).
//
// They are the user's own saved and applied jobs from the applications
// tracker (lib/api/tracker.ts), newest activity first. An entry the user
// added by hand without a job record has no posting text to tailor from, so
// it is not offered; closed postings are still offered (the text is kept).
// Nothing here searches for jobs.

import { useQuery } from '@tanstack/react-query';

import { listTracker } from '../../lib/api/tracker';
import type { TrackerEntryView } from '../../lib/api/contracts/tracker';

export interface TailorTargetJob {
  jobId: string;
  title: string;
  company: string | null;
}

export const TAILOR_TARGET_LIMIT = 30;

/** Tracker entries → one row per job that has a posting (first seen wins). */
export function targetJobsOf(entries: readonly Pick<TrackerEntryView, 'jobId' | 'job'>[]): TailorTargetJob[] {
  const seen = new Set<string>();
  const out: TailorTargetJob[] = [];
  for (const e of entries) {
    if (!e.jobId || !e.job?.title || seen.has(e.jobId)) continue;
    seen.add(e.jobId);
    out.push({ jobId: e.jobId, title: e.job.title, company: e.job.companyName?.trim() || null });
  }
  return out;
}

export function useTailorTargets(enabled = true) {
  return useQuery<TailorTargetJob[]>({
    queryKey: ['tailor', 'targets'],
    queryFn: async ({ signal }) => targetJobsOf((await listTracker({ limit: TAILOR_TARGET_LIMIT, sortBy: 'updated', sortDir: 'desc' }, { signal })).entries),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}
