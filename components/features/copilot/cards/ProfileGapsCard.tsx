'use client';

// profile_gaps — what is missing from the user's profile (get_profile_gaps),
// with a link to complete it.

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { CardFrame } from './CardFrame';
import { parseProfileGaps } from './model';
import type { CardProps } from './types';
import styles from '../copilot.module.css';

const KNOWN = ['resume', 'skills', 'experience', 'education', 'targetRoles', 'location', 'workAuth', 'salary'];

export function ProfileGapsCard({ card, ctx }: CardProps) {
  const t = useTranslations('assistant.cards.gaps');
  const data = parseProfileGaps(card.data);
  if (!data) return null;
  return (
    <CardFrame card={card} title={t('title')}>
      <ul className={styles.bullets}>
        {data.gaps.map((g) => (
          <li key={g.key}>{t(`keys.${KNOWN.includes(g.key) ? g.key : 'other'}`)}</li>
        ))}
      </ul>
      <Link href={data.gaps[0]?.href ?? '/profile'} className={styles.link} onClick={ctx.onNavigate}>
        {t('open')}
      </Link>
    </CardFrame>
  );
}
