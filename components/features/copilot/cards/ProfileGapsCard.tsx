'use client';

// profile_gaps — what is missing from the user's profile (get_profile_gaps:
// the profile's completeness rule keys), with a link to complete it. Labels
// are the profile page's own `profile.missing.<key>`; a key this build does
// not know reads "Another profile detail".

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { CardFrame } from './CardFrame';
import { parseProfileGaps } from './model';
import type { CardProps } from './types';
import styles from '../copilot.module.css';

export function ProfileGapsCard({ card, ctx }: CardProps) {
  const t = useTranslations('assistant.cards.gaps');
  const tMissing = useTranslations('profile.missing');
  const data = parseProfileGaps(card.data);
  if (!data) return null;
  return (
    <CardFrame card={card} title={t('title')}>
      <ul className={styles.bullets}>
        {data.gaps.map((g) => (
          <li key={g.key}>{tMissing.has(g.key) ? tMissing(g.key) : t('keys.other')}</li>
        ))}
      </ul>
      <Link href={data.href} className={styles.link} onClick={ctx.onNavigate}>
        {t('open')}
      </Link>
    </CardFrame>
  );
}
