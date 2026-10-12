'use client';

// PracticeReportCoachLine — one line at the end of a practice report:
// "Prefer a person? See coaches" (TASK_PLAN.md WP-72; PRODUCT_PLAN.md §5.14
// F-COACH-05; rulings F17 + C28). WP-43's report renders it for every
// finished session with `{ sessionId, jobId }`.
//
// It shows only when the `coaching` flag is on AND the brand's roster has at
// least one listed coach (real people only). It shares the nav entry's
// roster query (`useCoachRosterAvailable`, fail closed: nothing while
// loading, on error, or with an empty roster). No pop-up, no bundle, no
// trial offer (F-COACH-06 is skipped): one plain link.

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { useFlag } from '../../../lib/flags';
import { useCoachRosterAvailable } from '../../../hooks/shared/navBadges';
import styles from './coaching.module.css';

export interface PracticeReportCoachLineProps {
  /** The practice session the report belongs to. */
  sessionId: string;
  /** The job the session practised for, when there was one. */
  jobId?: string | null;
}

export function PracticeReportCoachLine({ sessionId }: PracticeReportCoachLineProps) {
  const t = useTranslations('coaching.reportLine');
  const flagOn = useFlag('coaching');
  const rosterNonEmpty = useCoachRosterAvailable(flagOn);
  if (!flagOn || !rosterNonEmpty) return null;
  return (
    <p className={styles.reportLine} data-testid="practice-report-coach-line" data-session-id={sessionId}>
      <span>{t('lead')}</span>
      <Link className={styles.link} href="/coaching?from=practice_report">
        {t('link')}
      </Link>
    </p>
  );
}

export default PracticeReportCoachLine;
