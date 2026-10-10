'use client';

// rewrite_ready — AI-written rewrites for one resume-check issue, after the
// user confirmed the `rewrite` credit action. Nothing is applied to the resume
// here: the link opens the check, where the user picks and applies one.

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { AiGeneratedBadge } from '../../market';
import { CardFrame } from './CardFrame';
import { parseRewriteReady } from './model';
import type { CardProps } from './types';
import styles from '../copilot.module.css';

export function RewriteReadyCard({ card, ctx }: CardProps) {
  const t = useTranslations('assistant.cards.rewriteReady');
  const data = parseRewriteReady(card.data);
  if (!data) return null;
  return (
    <CardFrame card={card} title={t('title')}>
      {data.suggestions.length ? <AiGeneratedBadge /> : null}
      {data.suggestions.length ? (
        <ul className={styles.cardList}>
          {data.suggestions.map((s, i) => (
            <li key={i} className={styles.cardText}>
              {s}
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.cardText}>{t('none')}</p>
      )}
      {data.blocked > 0 ? <p className={styles.cardText}>{t('blocked', { count: data.blocked })}</p> : null}
      <Link href={data.href} className={styles.link} onClick={ctx.onNavigate}>
        {t('open')}
      </Link>
    </CardFrame>
  );
}
