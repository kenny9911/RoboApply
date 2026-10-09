'use client';

// hooks/shared/useLaunchPractice.ts — start a practice interview for a job
// (TASK_PLAN.md WP-43; FND-7).
//
// Route contract WP-43 implements: `/practice?job=<jobId>` prefills role,
// company and the posting, plus the primary (or `resume=`) resume; the
// session is created server-side with `jobId`, which re-checks the market.
// Nothing is spent until the user starts the session.

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';

export interface LaunchPracticeArgs {
  jobId: string;
  /** Resume (variant) to practise with; omitted → the primary or the job's tailored one. */
  resumeId?: string | null;
  from?: string;
}

export function practiceHref({ jobId, resumeId, from }: LaunchPracticeArgs): string {
  const params = new URLSearchParams({ job: jobId });
  if (resumeId) params.set('resume', resumeId);
  if (from) params.set('from', from);
  return `/practice?${params.toString()}`;
}

export function useLaunchPractice(): (args: LaunchPracticeArgs) => void {
  const router = useRouter();
  return useCallback((args: LaunchPracticeArgs) => router.push(practiceHref(args)), [router]);
}
