'use client';

// WhyYouFit / WhatYoureMissing — overlap and gap on job detail (PRODUCT
// F-MATCH-02, F-MATCH-03; ruling R2: the gap is shown as plainly as the
// overlap). Skill chips are deterministic (the posting's skills against your
// resume and profile); the sentences are AI-written and labelled.

import { useTranslations } from 'next-intl';

import { HonestyLine } from '../../v3/primitives';
import { AiGeneratedBadge } from '../market';
import styles from './match.module.css';

export interface WhyYouFitProps {
  /** AI-written strengths (empty for a quick estimate). */
  strengths: string[];
  /** The posting's skills (and verified terms) your resume/profile shows. */
  aligned: string[];
  /** How many skills the posting lists; 0 → there was nothing to compare. */
  listed?: number;
}

export function WhyYouFit({ strengths, aligned, listed }: WhyYouFitProps) {
  const t = useTranslations('fit.why');
  const empty = !strengths.length && !aligned.length;
  return (
    <section className={styles.section} aria-labelledby="fit-why-heading" data-testid="fit-why">
      <div className={styles.summaryHead}>
        <h3 id="fit-why-heading" className={styles.heading}>
          {t('title')}
        </h3>
        {strengths.length ? <AiGeneratedBadge kind="text" /> : null}
      </div>
      {empty ? <p className={styles.muted}>{listed === 0 ? t('noSkillsListed') : t('empty')}</p> : null}
      {strengths.length ? (
        <>
          <ul className={styles.list}>
            {strengths.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
          <HonestyLine kind="ai_written" />
        </>
      ) : null}
      {aligned.length ? (
        <>
          <p className={styles.intro}>{t('haveSkills')}</p>
          <ul className={styles.chips}>
            {aligned.map((s) => (
              <li key={s} className={`${styles.chip} ${styles.chipHave}`}>
                <span className={styles.chipMark} aria-hidden="true">
                  ✓
                </span>
                {s}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

export interface WhatYoureMissingProps {
  /** AI-written gaps, phrased as observations about the resume. */
  gaps: string[];
  /** The posting's skills (and verified terms) your resume/profile does not mention — the complete list. */
  missing: string[];
  /** How many skills the posting lists; 0 → there was nothing to check. */
  listed?: number;
}

export function WhatYoureMissing({ gaps, missing, listed }: WhatYoureMissingProps) {
  const t = useTranslations('fit.missing');
  const empty = !gaps.length && !missing.length;
  return (
    <section className={styles.section} aria-labelledby="fit-missing-heading" data-testid="fit-missing">
      <div className={styles.summaryHead}>
        <h3 id="fit-missing-heading" className={styles.heading}>
          {t('title')}
        </h3>
        {gaps.length ? <AiGeneratedBadge kind="text" /> : null}
      </div>
      {empty ? <p className={styles.muted}>{listed === 0 ? t('noSkillsListed') : t('empty')}</p> : null}
      {missing.length ? (
        <>
          <p className={styles.intro}>{t('skillsHeading')}</p>
          <ul className={styles.chips}>
            {missing.map((s) => (
              <li key={s} className={`${styles.chip} ${styles.chipMissing}`}>
                {s}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {gaps.length ? (
        <>
          <ul className={styles.list}>
            {gaps.map((g, i) => (
              <li key={i}>{g}</li>
            ))}
          </ul>
          <HonestyLine kind="ai_written" />
        </>
      ) : null}
    </section>
  );
}
