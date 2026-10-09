'use client';

// JobFit — the fit block for job detail (WP-34 places it): score with its
// honesty line, why you fit / what you're missing, and "What we compared".
// Loads through hooks/match `useJobFit` (platform-paid; never a user credit).

import { useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives';
import { useJobFit } from '../../../hooks/match';
import type { MatchFitView } from '../../../lib/api/contracts/match';
import { DimensionList } from './DimensionList';
import { FitScore } from './FitScore';
import { WhatYoureMissing, WhyYouFit } from './WhyYouFit';
import styles from './match.module.css';

export interface JobFitViewProps {
  fit: MatchFitView;
}

const uniq = (xs: string[]) => xs.filter((v, i, a) => a.findIndex((x) => x.toLowerCase() === v.toLowerCase()) === i);

/**
 * Overlap and gap chips: the complete deterministic skill split (the posting's
 * skills against your resume and profile) plus the model's terms the server
 * verified (in the post; in your resume or not). AI strengths/gaps are the
 * labelled sentences.
 */
export function JobFitView({ fit }: JobFitViewProps) {
  const aligned = uniq([...fit.skills.aligned, ...fit.keywordsMatched]);
  const missing = uniq([...fit.skills.missing, ...fit.keywordsMissing]);
  return (
    <div className={styles.score} data-testid="job-fit">
      <section className={styles.section}>
        <FitScore fit={fit} />
      </section>
      <div className={styles.twoUp}>
        <WhyYouFit strengths={fit.strengths} aligned={aligned} listed={fit.skills.listed} />
        <WhatYoureMissing gaps={fit.gaps} missing={missing} listed={fit.skills.listed} />
      </div>
      <DimensionList dimensions={fit.dimensions} />
    </div>
  );
}

export function JobFit({ jobId, resumeVariantId }: { jobId: string; resumeVariantId?: string | null }) {
  const t = useTranslations('fit');
  const q = useJobFit(jobId, { resumeVariantId });
  if (q.isPending) {
    return (
      <section className={styles.section} aria-busy="true">
        <FitScore fit={null} />
        <p className={styles.muted} role="status">
          {t('loading')}
        </p>
      </section>
    );
  }
  if (q.isError || !q.data) {
    return (
      <section className={styles.section}>
        <FitScore fit={null} />
        <p className={styles.alert} role="alert">
          {t('error')}
        </p>
        <div className={styles.actions}>
          <Btn className={styles.action} onClick={() => void q.refetch()}>
            {t('retry')}
          </Btn>
        </div>
      </section>
    );
  }
  return <JobFitView fit={q.data} />;
}
