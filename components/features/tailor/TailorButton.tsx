'use client';

// TailorButton — "Tailor resume" from any job surface (job card, job detail,
// Ready to apply, tracker, Assistant; WP-36a). It opens the shared route
// contract of hooks/shared/useLaunchTailor (`/resume[/<id>]?tailor=<jobId>`),
// where TailorLaunchHost runs the flow.
//
// Renders nothing when AI tailoring is off for this user or brand (R-04;
// TASK_PLAN.md §2.2: no UI entry, zero LLM calls). Without a `resumeId` the
// user's main resume decides the consent check, and the flow lets them pick.

import { useTranslations } from 'next-intl';

import { Btn, type BtnVariant } from '../../v3/primitives';
import { useLaunchTailor } from '../../../hooks/shared/useLaunchTailor';
import { useTailorAvailability } from '../../../hooks/tailor';
import { useResumeList } from '../../../hooks/useResumes';

export interface TailorButtonProps {
  jobId: string;
  /** The resume to tailor; omitted → the user picks (main resume first). */
  resumeId?: string | null;
  /** Analytics source (job_card, job_detail, ready, tracker, assistant…). */
  from?: string;
  /** Job title for the accessible name. */
  jobTitle?: string | null;
  variant?: BtnVariant;
  className?: string;
}

export function TailorButton({ jobId, resumeId = null, from, jobTitle = null, variant = 'default', className }: TailorButtonProps) {
  const t = useTranslations('tailor.entry');
  const launch = useLaunchTailor();
  const list = useResumeList();
  const primary = resumeId ?? list.data?.resumes.find((r) => r.isPrimary)?.id ?? list.data?.resumes[0]?.id ?? null;
  const { available } = useTailorAvailability(primary);
  if (!available) return null;
  return (
    <Btn
      variant={variant}
      className={className}
      aria-label={jobTitle ? t('aria', { title: jobTitle }) : undefined}
      onClick={() => launch({ jobId, resumeId, from })}
    >
      {t('button')}
    </Btn>
  );
}
