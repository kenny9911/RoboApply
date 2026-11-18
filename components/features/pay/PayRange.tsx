'use client';

// PayRange — one currency of a pay check: a bar with the 25th–75th percentile
// band and the median's mark, the three figures in words and numbers, and the
// source line (N posts, as of). The bar is a picture of the three figures and
// nothing else: its ends are padding around the band, never the lowest or the
// highest post (D3). Rendered only for a currency whose figures the server
// sent (at or above the sample rule).

import type { CSSProperties } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { SourceNote } from '../../v3/primitives';
import type { PayCheckCurrency } from '../../../lib/api/contracts/feed';
import { formatMoney, rangeBar } from './format';
import styles from './pay.module.css';

export interface PayRangeProps {
  /** A currency with its three figures (the caller skips one without). */
  entry: PayCheckCurrency & { p25: NonNullable<PayCheckCurrency['p25']>; median: NonNullable<PayCheckCurrency['median']>; p75: NonNullable<PayCheckCurrency['p75']> };
}

/** True when the server sent this currency's three figures. Pure. */
export function hasFigures(entry: PayCheckCurrency): entry is PayRangeProps['entry'] {
  return entry.p25 !== null && entry.median !== null && entry.p75 !== null;
}

export function PayRange({ entry }: PayRangeProps) {
  const t = useTranslations('payCheck.range');
  const locale = useLocale();
  const money = (n: number) => formatMoney(n, entry.currency, locale);
  const low = money(entry.p25.value);
  const median = money(entry.median.value);
  const high = money(entry.p75.value);
  const bar = rangeBar(entry.p25.value, entry.median.value, entry.p75.value);
  const barStyle = { '--band-start': `${bar.start}%`, '--band-end': `${bar.end}%`, '--median-at': `${bar.median}%` } as CSSProperties;

  return (
    <section className={styles.range} aria-labelledby={`pay-${entry.currency}`} data-testid="pay-range" data-currency={entry.currency}>
      <header className={styles.rangeHead}>
        <h3 className={styles.rangeTitle} id={`pay-${entry.currency}`}>
          {t('heading', { currency: entry.currency })}
        </h3>
        <p className={styles.muted}>{t('sample', { count: entry.sampleSize, currency: entry.currency })}</p>
      </header>
      <div className={styles.bar} style={barStyle} aria-hidden="true">
        <span className={styles.band} />
        <span className={styles.medianMark} />
      </div>
      <dl className={styles.figures}>
        <div>
          <dt>{t('p25')}</dt>
          <dd data-testid="pay-p25">{low}</dd>
        </div>
        <div className={styles.figureMedian}>
          <dt>{t('median')}</dt>
          <dd data-testid="pay-median">{median}</dd>
        </div>
        <div className={styles.figureEnd}>
          <dt>{t('p75')}</dt>
          <dd data-testid="pay-p75">{high}</dd>
        </div>
      </dl>
      <p className={styles.text}>{t('summary', { low, high, median })}</p>
      <SourceNote sourced={entry.median} className={styles.source} />
    </section>
  );
}
