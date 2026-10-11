'use client';

// JobFit — the fit block for job detail (WP-34 places it): score with its
// honesty line (and, for a quick estimate that rests on little, the one
// reason: `FitScore` reads `confidence` and `confidenceReason` from the fit it
// is handed whole), why you fit / what you're missing, and "What we compared".
// Loads through hooks/match `useJobFit` (platform-paid; never a user credit).

import { useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives';
import { useJobFit, useRewriteFitText } from '../../../hooks/match';
import type { MatchFitView } from '../../../lib/api/contracts/match';
import { DimensionList } from './DimensionList';
import { FitScore } from './FitScore';
import { WhatYoureMissing, WhyYouFit } from './WhyYouFit';
import styles from './match.module.css';

export interface JobFitViewProps {
  fit: MatchFitView;
  /**
   * Rewrite the AI-written parts in the reader's language. Offered only when
   * they were written in another one (`fit.summaryLocaleStale`): the text is
   * never left in the wrong language without saying so.
   */
  rewrite?: { run: () => void; pending: boolean; failed: boolean };
}

/** One chip per term: case, spacing and punctuation do not make a second one ("Node.js" / "nodejs" / "NODE JS"). */
const chipKey = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s._\-/]+/g, '');
export const uniq = (xs: string[]) => xs.filter((v, i, a) => !!chipKey(v) && a.findIndex((x) => chipKey(x) === chipKey(v)) === i);

/**
 * Overlap and gap chips: the complete deterministic skill split (the posting's
 * skills against your resume and profile) plus the model's terms the server
 * verified (in the post; in your resume or not). AI strengths/gaps are the
 * labelled sentences.
 */
export function JobFitView({ fit, rewrite }: JobFitViewProps) {
  const t = useTranslations('fit.otherLanguage');
  const written = fit.kind === 'ai' && (!!fit.summary || fit.strengths.length > 0 || fit.gaps.length > 0);
  const stale = written && fit.summaryLocaleStale === true;
  const aligned = uniq([...fit.skills.aligned, ...fit.keywordsMatched]);
  // A term the resume shows is never also listed as missing.
  const have = new Set(aligned.map(chipKey));
  const missing = uniq([...fit.skills.missing, ...fit.keywordsMissing]).filter((s) => !have.has(chipKey(s)));
  return (
    <div className={styles.score} data-testid="job-fit">
      <section className={styles.section}>
        <FitScore fit={fit} />
        {stale ? (
          <div className={styles.actions} data-testid="fit-other-language">
            <p className={styles.muted} role="status">
              {t('note')}
            </p>
            {rewrite ? (
              <Btn className={styles.action} onClick={rewrite.run} disabled={rewrite.pending}>
                {rewrite.pending ? t('rewriting') : t('rewrite')}
              </Btn>
            ) : null}
            {rewrite?.failed ? (
              <p className={styles.alert} role="alert">
                {t('failed')}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>
      <div className={styles.twoUp}>
        <WhyYouFit strengths={fit.strengths} aligned={aligned} listed={fit.skills.listed} />
        <WhatYoureMissing gaps={fit.gaps} missing={missing} listed={fit.skills.listed} />
      </div>
      <DimensionList dimensions={fit.dimensions} />
    </div>
  );
}

/** The job's one fit (the person's main resume). It takes no resume version: only tailoring shows another measure. */
export function JobFit({ jobId }: { jobId: string }) {
  const t = useTranslations('fit');
  const q = useJobFit(jobId);
  const rewrite = useRewriteFitText(jobId);
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
  return <JobFitView fit={q.data} rewrite={{ run: () => rewrite.mutate(), pending: rewrite.isPending, failed: rewrite.isError }} />;
}
