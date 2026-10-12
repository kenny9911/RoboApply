'use client';

// PracticeJobBanner — "/practice?job=<id>" names the job being practised and
// the resume the interviewer reads (TASK_PLAN.md WP-43; PRODUCT_PLAN F-INT-06).
// Both come from the server (`practiceApi.setup`), never guessed.

import { useTranslations } from 'next-intl';

import type { PracticeSetup } from '../../../lib/api/interviewEngine';
import styles from './practice.module.css';

export interface PracticeJobBannerProps {
  job: NonNullable<PracticeSetup['job']>;
  resume: PracticeSetup['resume'];
  /** Drop the job and practise from a role or a pasted post instead. */
  onClear: () => void;
}

export function PracticeJobBanner({ job, resume, onClear }: PracticeJobBannerProps) {
  const t = useTranslations('practice.job');
  return (
    <section className={styles.jobBanner} aria-labelledby="practice-job-title" data-testid="practice-job-banner">
      <p className={styles.jobEyebrow}>{t('eyebrow')}</p>
      <h2 id="practice-job-title" className={styles.jobTitle}>
        {t('title', { title: job.title, company: job.companyName })}
      </h2>
      {job.location ? <p className={styles.jobMeta}>{job.location}</p> : null}
      {job.closed ? <p className={styles.jobMeta}>{t('closed')}</p> : null}
      <p className={styles.jobMeta}>
        {resume ? t(`resume.${resume.kind}`, { name: resume.name }) : t('resume.none')}
      </p>
      <div className={styles.jobActions}>
        <button type="button" className={styles.link} onClick={onClear}>
          {t('clear')}
        </button>
      </div>
    </section>
  );
}

export default PracticeJobBanner;
