'use client';

// job_imported — the result of adding a job from a link: added (open the
// job), or not finished (some fields could not be read; the user completes
// it on Added jobs). Nothing is invented for a field the import did not read.

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { CardFrame } from './CardFrame';
import { parseJobImported } from './model';
import type { CardProps } from './types';
import styles from '../copilot.module.css';

export function JobImportedCard({ card, ctx }: CardProps) {
  const t = useTranslations('assistant.cards.jobImported');
  const data = parseJobImported(card.data);
  if (!data) return null;
  const what = [data.title, data.company].filter(Boolean).join(' · ');
  return (
    <CardFrame card={card} title={data.jobId ? t('title') : t('unfinishedTitle')}>
      {what ? <p className={styles.cardText}>{what}</p> : null}
      {data.jobId ? null : <p className={styles.cardText}>{t('unfinished')}</p>}
      <Link href={data.href} className={styles.link} onClick={ctx.onNavigate}>
        {data.jobId ? t('open') : t('finish')}
      </Link>
    </CardFrame>
  );
}
