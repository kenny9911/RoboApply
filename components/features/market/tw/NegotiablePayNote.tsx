'use client';

// NegotiablePayNote — "Why is pay not listed?" for Taiwan postings that say
// 面議 / 依公司規定 (TW-03; CN_TW_LAUNCH_PLAN.md §4.2 WP-TW-JOBS).
//
// States the legal rule (Employment Services Act Art. 5: pay may be left
// unlisted only when the regular monthly wage is NT$40,000 or more) and links
// to the law. It never says or implies that THIS job pays NT$40,000 or more:
// the copy says outright that the rule is not the job's pay and that
// unlisted pay is never estimated.
//
// `context="filter"` adds the line that ties it to the "Only jobs that list
// pay" toggle (FiltersDrawer, WP-20 owner; see the WP-42 handoff request).

import { useTranslations } from 'next-intl';

import styles from './tw.module.css';

/** Employment Services Act, Article 5 (national law database, Ministry of Justice). */
export const TW_PAY_LAW_URL = 'https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=N0090001&flno=5';

export interface NegotiablePayNoteProps {
  context?: 'job' | 'filter';
}

export function NegotiablePayNote({ context = 'job' }: NegotiablePayNoteProps) {
  const t = useTranslations('jobsTw.negotiable');
  return (
    <details className={styles.note}>
      <summary className={styles.summary}>{t('summary')}</summary>
      <div className={styles.noteBody}>
        <p>{t('body')}</p>
        <p>{t('notAFigure')}</p>
        {context === 'filter' ? <p>{t('filterHint')}</p> : null}
        <p>
          <a className={styles.link} href={TW_PAY_LAW_URL} target="_blank" rel="noopener noreferrer">
            {t('lawLink')}
          </a>
        </p>
      </div>
    </details>
  );
}

export default NegotiablePayNote;
