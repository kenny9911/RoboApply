'use client';

// tailor_ready — a tailored resume finished (after a confirmed tailor action).

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { CardFrame } from './CardFrame';
import { parseTailorReady } from './model';
import type { CardProps } from './types';
import styles from '../copilot.module.css';

export function TailorReadyCard({ card, ctx }: CardProps) {
  const t = useTranslations('assistant.cards.tailorReady');
  const data = parseTailorReady(card.data);
  if (!data) return null;
  return (
    <CardFrame card={card} title={t('title')}>
      {data.jobTitle ? <p className={styles.cardText}>{data.company ? `${data.jobTitle} · ${data.company}` : data.jobTitle}</p> : null}
      <Link href={data.href} className={styles.link} onClick={ctx.onNavigate}>
        {t('open')}
      </Link>
    </CardFrame>
  );
}
