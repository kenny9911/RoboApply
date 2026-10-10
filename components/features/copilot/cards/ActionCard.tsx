'use client';

// action — something the page applies on the user's click (F-ORION-05):
//   set_sort  → "Show jobs sorted this way" opens /jobs?sort=<sort>;
//   open_link → a link to an app page the tool named (People tab, resume check,
//               resumes, Added jobs, …); the label comes from a fixed list.
//
// The sort link is on (WP-93 #1e). It is only honest when /jobs reads
// `?sort=` (a valid key selects that order, an unknown one is ignored): that
// reader is the jobs web bundle's change (INT-06) and MUST ship in the same
// merge. `ACTION_CARD_CAPS.sortLink` stays as the one switch: if the reader is
// not there, set it to false: the card then renders NOTHING rather than
// promise an order the page would not show, and the cheatsheet stops offering
// the sort question (Cheatsheet.tsx `cheatsheetExtra`). Nothing changes before
// the click.

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { CardFrame } from './CardFrame';
import { parseAction } from './model';
import type { CardProps } from './types';
import styles from '../copilot.module.css';

/** What the destinations of an action card support. `sortLink`: /jobs honours `?sort=<FeedSort>`. */
export const ACTION_CARD_CAPS: { sortLink: boolean } = { sortLink: true };

/** The feed with a sort applied (`/jobs?sort=newest`). Pure. */
export function sortHref(sort: string): string {
  return `/jobs?sort=${encodeURIComponent(sort)}`;
}

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
      <Link href={sortHref(data.sort)} className={styles.link} onClick={ctx.onNavigate}>
        {t('apply')}
      </Link>
    </CardFrame>
  );
}
