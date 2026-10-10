'use client';

// PostedPay — posted pay for an offer's role (WP-64; D3). The only market
// figure in the offers area: the middle half (p25–p75) and median of posted
// pay from our own index, in the offer's currency, with N and the date via
// SourceNote. Below MIN_SAMPLE it says there is not enough data and shows
// no figure. Loaded on demand. When the posted pay uses another period than
// the offer (yearly vs monthly vs hourly), the converted base and the factor
// are shown, so the comparison states its assumption.

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Btn, SourceNote } from '../../v3/primitives';
import { useOfferBenchmark } from '../../../hooks/offers/useOffers';
import { useMoney } from './shared';
import styles from './offers.module.css';

export interface PostedPayProps {
  trackerEntryId: string;
  currency: string;
  /** The offer's own pay period ('year' | 'month' | 'hour'). */
  period: string;
  /** The offer's base pay for a year (server totals), for the conversion note. */
  baseAnnual: number;
}

export function PostedPay({ trackerEntryId, currency, period, baseAnnual }: PostedPayProps) {
  const t = useTranslations('offers.benchmark');
  const money = useMoney();
  const [open, setOpen] = useState(false);
  const q = useOfferBenchmark(trackerEntryId, open);

  if (!open) {
    return (
      <div>
        <Btn variant="ghost" onClick={() => setOpen(true)}>
          {t('show')}
        </Btn>
      </div>
    );
  }

  const b = q.data;
  const r = b?.postedRange ?? null;
  return (
    <section className={styles.panel} aria-label={t('title')}>
      <h4 className={styles.title}>{t('title')}</h4>
      {q.isLoading ? <p className={styles.muted}>{t('loading')}</p> : null}
      {q.isError ? <p className={styles.muted}>{t('unavailable')}</p> : null}
      {b && r ? (
        <>
          <p className={styles.text}>
            {t('range', { low: money(r.low.value, r.currency), high: money(r.high.value, r.currency), median: money(r.median.value, r.currency), period: r.period })}
          </p>
          {b.offerBaseInRangePeriod !== null && r.period !== period ? (
            <p className={styles.muted}>
              {t('converted', { period: r.period, amount: money(b.offerBaseInRangePeriod, r.currency), annual: money(baseAnnual, r.currency) })}
            </p>
          ) : null}
          {b.position ? <p className={styles.text}>{t('position', { position: b.position })}</p> : null}
          <p className={styles.muted}>{t('counts', { listed: b.listedCount, total: b.totalCount })}</p>
          <SourceNote sourced={r.median} className={styles.muted} />
        </>
      ) : null}
      {b && !r ? (
        <p className={styles.muted}>
          {b.reason === 'no_role'
            ? t('no_role')
            : b.reason === 'unavailable'
              ? t('unavailable')
              : t('not_enough', { currency, listed: b.listedCount, min: b.minSample })}
        </p>
      ) : null}
    </section>
  );
}
