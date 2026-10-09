'use client';

// hooks/shared/useLaunchTailor.ts — start tailoring a resume for a job from
// any surface (job card, job detail, Ready to apply, tracker, Assistant;
// TASK_PLAN.md WP-36a; FND-7).
//
// The route contract WP-36a implements:
//   /resume?tailor=<jobId>                 pick a base resume, then tailor
//   /resume/<resumeId>?tailor=<jobId>      tailor that resume for the job
// plus `&from=<source>` for analytics. The flow itself spends the `tailor`
// credit (useCreditGate) only when the user presses Generate.

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';

export interface LaunchTailorArgs {
  jobId: string;
  /** Base resume (variant) id; omitted → the user picks one. */
  resumeId?: string | null;
  /** Where the launch came from (job_card, job_detail, ready, tracker, assistant…). */
  from?: string;
}

export function tailorHref({ jobId, resumeId, from }: LaunchTailorArgs): string {
  const params = new URLSearchParams({ tailor: jobId });
  if (from) params.set('from', from);
  const base = resumeId ? `/resume/${encodeURIComponent(resumeId)}` : '/resume';
  return `${base}?${params.toString()}`;
}

export function useLaunchTailor(): (args: LaunchTailorArgs) => void {
  const router = useRouter();
  return useCallback((args: LaunchTailorArgs) => router.push(tailorHref(args)), [router]);
}
