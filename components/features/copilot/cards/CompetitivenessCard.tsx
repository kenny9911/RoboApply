'use client';

// competitiveness — a link to the "How you compare" report for a job
// (WP-77's /jobs/report; flag `competitiveness`). Hidden when the flag is off.

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { useFlag } from '../../../../lib/flags';
import { CardFrame } from './CardFrame';
import { parseCompetitiveness } from './model';
import type { CardProps } from './types';
import styles from '../copilot.module.css';

export function CompetitivenessCard({ card, ctx }: CardProps) {
  const t = useTranslations('assistant.cards.competitiveness');
  const enabled = useFlag('competitiveness');
  const data = parseCompetitiveness(card.data);
  if (!data || !enabled) return null;
  return (
    <CardFrame card={card} title={t('title')}>
      <Link href={data.href} className={styles.link} onClick={ctx.onNavigate}>
        {t('open')}
      </Link>
    </CardFrame>
  );
}
