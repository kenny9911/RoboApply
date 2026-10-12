'use client';

// hooks/tailor/useTailorAvailability.ts — may this user tailor with AI?
// (WP-36a; TASK_PLAN.md §2.2 and R-04: a disabled AI path has no UI entry).
//
// Two checks, both fail closed:
//   1. the brand capability `ai.text` (GET /public/brand or /auth/me flags);
//   2. the user's AI consent — the server answers it as `aiAvailable` on the
//      resume check's latest-check read (aiAllowed(user) AND ai.text; GoApply
//      needs the `ai_resume_parsing` grant), which is cached per resume.
// Without a resume id only the capability is known: `available` stays false
// until a resume is chosen, so no AI entry shows for a user who said no.

import { useFlag } from '../../lib/flags';
import { useLatestResumeCheck } from '../resume/useResumeCheck';

export interface TailorAvailability {
  /** True only when both checks passed. */
  available: boolean;
  /** Still waiting for the server's answer. */
  loading: boolean;
  /** The brand has an AI text model (the consent may still be missing). */
  capability: boolean;
}

export function useTailorAvailability(resumeId: string | null | undefined): TailorAvailability {
  const capability = useFlag('ai.text');
  const latest = useLatestResumeCheck(capability ? resumeId : null);
  const consent = latest.data?.aiAvailable === true;
  return {
    available: capability && Boolean(resumeId) && consent,
    loading: capability && Boolean(resumeId) && latest.isLoading,
    capability,
  };
}
