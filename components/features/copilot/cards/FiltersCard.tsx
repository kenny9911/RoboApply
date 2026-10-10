'use client';

// filters — the user's active saved search, as plain field/value lines
// (get_current_filters). Values are the user's own choices.

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { diffFilters } from '../../../../hooks/search';
import { useFilterLabels } from '../../filters';
import { CardFrame } from './CardFrame';
import { parseFilters } from './model';
import type { CardProps } from './types';
import styles from '../copilot.module.css';

export function FiltersCard({ card, ctx }: CardProps) {
  const t = useTranslations('assistant.cards.filters');
  const labels = useFilterLabels();
  const data = parseFilters(card.data);
  if (!data) return null;
  const rows = diffFilters({}, data.filters).map((c) => {
    const items = c.addedItems ?? (c.to !== undefined ? [c.to] : []);
    return { field: c.field, text: items.map((v) => labels.value(c.field, v, data.filters)).join(', ') };
  });
  return (
    <CardFrame card={card} title={t('title')}>
      {rows.length === 0 ? (
        <p className={styles.cardText}>{t('none')}</p>
      ) : (
        <dl className={styles.facts}>
          {rows.map((r) => (
            <div key={r.field} style={{ display: 'contents' }}>
              <dt>{labels.field(r.field)}</dt>
              <dd>{r.text}</dd>
            </div>
          ))}
        </dl>
      )}
      <Link href="/jobs" className={styles.link} onClick={ctx.onNavigate}>
        {t('edit')}
      </Link>
    </CardFrame>
  );
}
