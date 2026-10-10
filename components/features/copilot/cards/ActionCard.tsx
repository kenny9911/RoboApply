'use client';

// action — something the page applies on the user's click (F-ORION-05):
//   set_sort  → "Show jobs sorted this way" opens /jobs?sort=<sort> (gated, below);
//   open_link → a link to an app page the tool named (People tab, resume check,
//               resumes, Added jobs, …); the label comes from a fixed list.
//
// Honesty gate: /jobs keeps its sort in local state and does not read
// `?sort=` yet (WP-33 / INT request), so a link promising a sorted list would
// land on the default order. Until the feed honours the param, this card
// renders NOTHING (`ACTION_CARD_CAPS.sortLink` is false). INT flips it in the
// same change that makes /jobs read `?sort=`. Nothing changes before the click.

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { CardFrame } from './CardFrame';
import { parseAction } from './model';
import type { CardProps } from './types';
import styles from '../copilot.module.css';

/** What the destinations of an action card support today. Flip only when /jobs reads `?sort=`. */
export const ACTION_CARD_CAPS: { sortLink: boolean } = { sortLink: false };

export function ActionCard({ card, ctx }: CardProps) {
  const t = useTranslations('assistant.cards.action');
  const tSort = useTranslations('jobs.workspace');
  const data = parseAction(card.data);
  if (!data) return null;
  if (data.kind === 'open_link') {
    return (
      <CardFrame card={card}>
        <Link href={data.href} className={styles.link} onClick={ctx.onNavigate}>
          {t(`open.${data.label}`)}
        </Link>
      </CardFrame>
    );
  }
  if (!ACTION_CARD_CAPS.sortLink) return null;
  return (
    <CardFrame card={card}>
      <p className={styles.cardText}>{t('sort', { sort: tSort(`sort.${data.sort}`) })}</p>
      <Link href={`/jobs?sort=${encodeURIComponent(data.sort)}`} className={styles.link} onClick={ctx.onNavigate}>
        {t('apply')}
      </Link>
    </CardFrame>
  );
}
