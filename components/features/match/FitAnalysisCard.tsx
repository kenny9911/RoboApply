'use client';

// FitAnalysisCard — the structured fit analysis (PRODUCT F-ORION-03): the
// score with its honesty line, why you fit / what you're missing, education,
// and every part with its evidence. Uses the `fit_analysis` credit only when
// a model call is needed (the server says `charged`); a quick estimate (AI
// off, no resume) is free and labelled.

import { useTranslations } from 'next-intl';

import { Btn, CreditNotice } from '../../v3/primitives';
import { useFitAnalysis } from '../../../hooks/match';
import type { FitAnalysisCard as FitAnalysisCardData } from '../../../lib/api/contracts/match';
import { DimensionList } from './DimensionList';
import { FitScore } from './FitScore';
import { useDegreeLabel } from './labels';
import { WhatYoureMissing, WhyYouFit } from './WhyYouFit';
import styles from './match.module.css';

export interface FitAnalysisViewProps {
  card: FitAnalysisCardData;
}

export function FitAnalysisView({ card }: FitAnalysisViewProps) {
  const t = useTranslations('fit.analysis');
  const degree = useDegreeLabel();
  const required = degree(card.education.required);
  const yours = degree(card.education.yours);
  return (
    <div className={styles.score} data-testid="fit-analysis">
      <section className={styles.section} aria-labelledby="fit-analysis-heading">
        <h2 id="fit-analysis-heading" className={styles.heading}>
          {t('title')}
        </h2>
        <FitScore fit={{ score: card.score, tier: card.tier, kind: card.kind, summary: card.summary, estimateReason: card.estimateReason }} />
        {card.charged || card.kind === 'ai' ? <p className={styles.muted}>{card.charged ? t('charged') : t('notCharged')}</p> : null}
      </section>
      <div className={styles.twoUp}>
        <WhyYouFit strengths={card.highlights} aligned={card.skills.aligned} listed={card.skills.listed} />
        <WhatYoureMissing gaps={card.gaps} missing={card.skills.missing} listed={card.skills.listed} />
      </div>
      <section className={styles.section} aria-labelledby="fit-education-heading">
        <h3 id="fit-education-heading" className={styles.heading}>
          {t('education.title')}
        </h3>
        <div className={styles.facts}>
          <span>{required ? t('education.required', { degree: required }) : t('education.notStated')}</span>
          {yours ? <span>{t('education.yours', { degree: yours })}</span> : required ? <span className={styles.muted}>{t('education.unknown')}</span> : null}
          {card.education.meets === true ? <span className={styles.muted}>{t('education.meets')}</span> : null}
          {card.education.meets === false ? <span className={styles.alert}>{t('education.doesNotMeet')}</span> : null}
        </div>
      </section>
      <DimensionList dimensions={card.dimensions} />
    </div>
  );
}

export interface FitAnalysisCardProps {
  jobId: string;
  resumeVariantId?: string | null;
}

/** The connected card: an explicit "Get the full fit analysis" action with its credit line. */
export function FitAnalysisCard({ jobId, resumeVariantId }: FitAnalysisCardProps) {
  const t = useTranslations('fit.analysis');
  const { card, status, gate, run } = useFitAnalysis(jobId, { resumeVariantId });
  if (card) return <FitAnalysisView card={card} />;
  const running = status === 'running';
  return (
    <section className={styles.section} aria-labelledby="fit-analysis-cta-heading" data-testid="fit-analysis-cta">
      <h2 id="fit-analysis-cta-heading" className={styles.heading}>
        {t('title')}
      </h2>
      <p className={styles.intro}>{t('intro')}</p>
      <div className={styles.actions}>
        <Btn variant="primary" className={styles.action} onClick={() => void run()} disabled={running} aria-busy={running}>
          {running ? t('running') : t('run')}
        </Btn>
        <CreditNotice bucket={gate.summary} />
      </div>
      {status === 'unavailable' ? (
        <p className={styles.alert} role="alert">
          {t('unavailable')}
        </p>
      ) : null}
      {status === 'error' ? (
        <p className={styles.alert} role="alert">
          {t('error')}
        </p>
      ) : null}
      {status === 'out_of_credits' ? (
        <p className={styles.alert} role="status">
          {t('outOfCredits')}
        </p>
      ) : null}
    </section>
  );
}
