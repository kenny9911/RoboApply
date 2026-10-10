'use client';

// job_imported — a job the user asked to add from a link was added.

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { jobDetailHref } from '../../job';
import { CardFrame } from './CardFrame';
import { parseJobImported } from './model';
import type { CardProps } from './types';
import styles from '../copilot.module.css';

export function JobImportedCard({ card, ctx }: CardProps) {
  const t = useTranslations('assistant.cards.jobImported');
  const data = parseJobImported(card.data);
  if (!data) return null;
  return (
    <CardFrame card={card} title={t('title')}>
      <p className={styles.cardText}>{data.company ? `${data.title} · ${data.company}` : data.title}</p>
      <Link href={jobDetailHref(data.jobId)} className={styles.link} onClick={ctx.onNavigate}>
        {t('open')}
      </Link>
    </CardFrame>
  );
}
