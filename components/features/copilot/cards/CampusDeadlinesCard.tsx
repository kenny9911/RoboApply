'use client';

// campus_deadlines — GoApply 网申 deadlines (campus_deadlines tool; flag
// `campusCalendar`). Each row links to the official page (and names the
// source the details were read from, when that is not the official page); a
// missing date says so instead of guessing, and a programme not re-checked
// recently says that too.

import { useLocale, useTranslations } from 'next-intl';

import { useFlag } from '../../../../lib/flags';
import { shortDate } from '../../feed';
import { CardFrame } from './CardFrame';
import { parseCampusDeadlines } from './model';
import type { CardProps } from './types';
import styles from '../copilot.module.css';

export function CampusDeadlinesCard({ card }: CardProps) {
  const t = useTranslations('assistant.cards.campus');
  const locale = useLocale();
  const enabled = useFlag('campusCalendar');
  const data = parseCampusDeadlines(card.data);
  if (!data || !enabled) return null;
  return (
    <CardFrame card={card} title={t('title')}>
      <ul className={styles.cardList}>
        {data.items.map((i, n) => {
          const date = shortDate(i.closesAt, locale);
          return (
            <li key={`${i.company}-${n}`} className={styles.jobRow}>
              <a href={i.officialUrl} target="_blank" rel="noopener noreferrer" className={styles.jobLink}>
                {i.programme ? `${i.company} · ${i.programme}` : i.company}
              </a>
              <span className={styles.jobMeta}>
                <span>{date ? t('closes', { date }) : t('noDate')}</span>
                <span className={styles.label}>{i.sourceName ? t('source', { source: i.sourceName }) : t('official')}</span>
                {i.needsReverify ? <span className={styles.label}>{t('reverify')}</span> : null}
              </span>
            </li>
          );
        })}
      </ul>
    </CardFrame>
  );
}
