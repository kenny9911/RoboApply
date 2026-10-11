'use client';

// WhyYouFit / WhatYoureMissing — overlap and gap on job detail (PRODUCT
// F-MATCH-02, F-MATCH-03; ruling R2: the gap is shown as plainly as the
// overlap). Skill chips are deterministic (the posting's skills against your
// resume and profile); the sentences are AI-written and labelled.

import { useTranslations } from 'next-intl';

import { HonestyLine } from '../../v3/primitives';
import { AiGeneratedBadge } from '../market';
import styles from './match.module.css';

/** The deterministic skill split as the server sends it (`MatchFitView.skills`, `FitAnalysisCard.skills`). */
export interface FitSkillLists {
  aligned: string[];
  missing: string[];
  listed: number;
  unchecked?: string[];
}

/**
 * How many of the posting's skills were compared with the resume, and how many
 * were not (nobody has reviewed the skill yet, or the resume's only trace of
 * it is a word with another reading). Every listed skill is aligned, missing
 * or left out, so the number left out is what remains of `listed`: it is right
 * whether or not the server sends the `unchecked` list. Read from the server's
 * own lists, never from lists merged with the model's terms.
 */
export function skillCounts(skills: FitSkillLists): { compared: number; unchecked: number } {
  const compared = skills.aligned.length + skills.missing.length;
  return { compared, unchecked: Math.max(skills.unchecked?.length ?? 0, skills.listed - compared, 0) };
}

/** The posting lists skills and none of them was compared: nothing may be claimed about them, in either direction. */
const noneCompared = (compared: number | undefined, unchecked: number): boolean => compared === 0 && unchecked > 0;

export interface WhyYouFitProps {
  /** AI-written strengths (empty for a quick estimate). */
  strengths: string[];
  /** The posting's skills (and verified terms) your resume/profile shows. */
  aligned: string[];
  /** How many skills the posting lists; 0 → there was nothing to compare. */
  listed?: number;
  /** `skillCounts`: how many of the posting's skills were compared, and how many were not. Absent: every listed skill was. */
  compared?: number;
  unchecked?: number;
}

export function WhyYouFit({ strengths, aligned, listed, compared, unchecked = 0 }: WhyYouFitProps) {
  const t = useTranslations('fit.why');
  const empty = !strengths.length && !aligned.length;
  // "None of the skills this post lists show up" is a claim about skills that were compared.
  const emptyLine = listed === 0 ? t('noSkillsListed') : noneCompared(compared, unchecked) ? t('notChecked') : t('empty');
  return (
    <section className={styles.section} aria-labelledby="fit-why-heading" data-testid="fit-why">
      <div className={styles.summaryHead}>
        <h3 id="fit-why-heading" className={styles.heading}>
          {t('title')}
        </h3>
        {strengths.length ? <AiGeneratedBadge kind="text" /> : null}
      </div>
      {empty ? <p className={styles.muted}>{emptyLine}</p> : null}
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
            {aligned.map((s, i) => (
              <li key={`${i}:${s}`} className={`${styles.chip} ${styles.chipHave}`}>
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
  /** `skillCounts`: how many of the posting's skills were compared. Absent: every listed skill was. */
  compared?: number;
  /**
   * `skillCounts`: how many skills of the posting were not compared. They are
   * never listed as missing; the section says how many there are.
   */
  unchecked?: number;
}

export function WhatYoureMissing({ gaps, missing, listed, compared, unchecked = 0 }: WhatYoureMissingProps) {
  const t = useTranslations('fit.missing');
  const empty = !gaps.length && !missing.length;
  const none = noneCompared(compared, unchecked);
  return (
    <section className={styles.section} aria-labelledby="fit-missing-heading" data-testid="fit-missing">
      <div className={styles.summaryHead}>
        <h3 id="fit-missing-heading" className={styles.heading}>
          {t('title')}
        </h3>
        {gaps.length ? <AiGeneratedBadge kind="text" /> : null}
      </div>
      {/*
        "Every skill we compared": a skill that was not compared is not claimed, so "every skill this post lists"
        would overclaim. When none was compared there is nothing to say but the count below.
      */}
      {empty && listed === 0 ? <p className={styles.muted}>{t('noSkillsListed')}</p> : null}
      {empty && listed !== 0 && !none ? <p className={styles.muted}>{t('emptyCompared')}</p> : null}
      {missing.length ? (
        <>
          <p className={styles.intro}>{t('skillsHeading')}</p>
          <ul className={styles.chips}>
            {missing.map((s, i) => (
              <li key={`${i}:${s}`} className={`${styles.chip} ${styles.chipMissing}`}>
                {s}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {unchecked > 0 ? (
        <p className={styles.muted} data-testid="fit-missing-unchecked">
          {none ? t('noneChecked', { count: unchecked }) : t('unchecked', { count: unchecked })}
        </p>
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
