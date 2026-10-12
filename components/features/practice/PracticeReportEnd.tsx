'use client';

// PracticeReportEnd — the end of a practice report (TASK_PLAN.md WP-43;
// PRODUCT_PLAN.md §6.4 "Practice report end"; rulings C16, C42, H8, F17).
//
//   - "Recording off" when the user did not consent to a recording (H8) and
//     no recording exists (a session from before per-session consent can
//     still have one).
//   - ONE line: "Practice again for this job" (or "Practice again"), with the
//     credit path: the practice credits left, or — with none left — a link to
//     packs or Pro. Nothing else upsells here.
//   - "Prefer a person? See coaches" — WP-72's line (renders only when the
//     coaching roster is non-empty).
//   - The score note: scores come from this practice and predict nothing.
//
// When the session is completed it refreshes the getting-started checklist
// once (the server marked the `practice` step at finalize).

import Link from 'next/link';
import { useContext, useEffect, useRef } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';

import { PracticeReportCoachLine } from '../coaching';
import { refreshChecklist } from '../../../hooks/growth';
import { useCredits } from '../../../hooks/useAccount';
import { practiceHref } from '../../../hooks/shared/useLaunchPractice';
import type { PracticeSessionInfo } from '../../../lib/api/interviewEngine';
import styles from './practice.module.css';

/** Where practice packs and Pro are sold (the plan sheet says when nothing is on sale). */
export const PRACTICE_PLANS_HREF = '/settings/billing#plans';

export interface PracticeReportEndProps {
  info: PracticeSessionInfo;
  /** Same-plan replay link for a session that was not for a job. */
  practiceAgainHref: string;
}

function formatBalance(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function PracticeReportEnd({ info, practiceAgainHref }: PracticeReportEndProps) {
  const t = useTranslations('practice.reportEnd');
  const queryClient = useContext(QueryClientContext);
  const credits = useCredits();
  const refreshed = useRef<string | null>(null);

  useEffect(() => {
    if (info.status !== 'completed' || !queryClient || refreshed.current === info.sessionId) return;
    refreshed.current = info.sessionId;
    void refreshChecklist(queryClient).catch(() => undefined);
  }, [info.status, info.sessionId, queryClient]);

  const job = info.job;
  const againHref = job ? practiceHref({ jobId: job.id, from: 'report' }) : practiceAgainHref;
  const balance = credits.data?.balance;
  const known = typeof balance === 'number' && Number.isFinite(balance);
  const none = known && balance! <= 0;

  return (
    <footer aria-label={t('againForJob')}>
      {/* Older sessions (before per-session consent) can still carry a
          recording: only say "Recording off" when nothing was kept. */}
      {!info.recording.consented && !info.recording.available ? (
        <p className={styles.reportNote} data-testid="practice-recording-off">{t('recordingOff')}</p>
      ) : null}

      <p className={styles.reportEnd} data-testid="practice-report-end">
        <Link className={styles.link} href={againHref}>
          {job ? t('againForJob') : t('again')}
        </Link>
        {job && job.title && job.companyName ? (
          <span>{t('forJob', { title: job.title, company: job.companyName })}</span>
        ) : null}
        {none ? (
          <span>
            {t('none')}{' '}
            <Link className={styles.link} href={PRACTICE_PLANS_HREF}>{t('getMore')}</Link>
          </span>
        ) : (
          <span>{known ? t('cost', { balance: formatBalance(balance!) }) : t('costUnknown')}</span>
        )}
      </p>

      <PracticeReportCoachLine sessionId={info.sessionId} jobId={job?.id ?? null} />

      <p className={styles.reportNote}>{t('scoreNote')}</p>
    </footer>
  );
}

export default PracticeReportEnd;
