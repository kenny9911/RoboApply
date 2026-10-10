'use client';

// notice — a plain system notice in the conversation (daily limit reached,
// busy, blocked content, expired suggestion). Fixed wording, no first person.

import { useTranslations } from 'next-intl';

import { CardFrame } from './CardFrame';
import { parseNotice } from './model';
import type { CardProps } from './types';
import styles from '../copilot.module.css';

export function NoticeCard({ card }: CardProps) {
  const t = useTranslations('assistant.cards.notice');
  const data = parseNotice(card.data);
  if (!data) return null;
  return (
    <CardFrame card={card}>
      <p className={styles.cardText} role="status">
        {t(data.code)}
      </p>
    </CardFrame>
  );
}
