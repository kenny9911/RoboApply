'use client';

// O2 "Open roles right now" (F-SAL-02 adapted; D3). Every number comes from
// GET /onboarding/market-snapshot as a Sourced value from our own index:
// N is always shown; pay only when the server published it (≥20 pay-listing
// rows in one currency and period), with "Pay listed on {X} of {N} posts";
// skills only at N ≥ 20. Nothing is computed or estimated here.

import { useFormatter, useTranslations } from 'next-intl';

import { useMarketSnapshot } from '../../../../hooks/onboarding/useOnboarding';
import { SourceNote } from '../../common';
import styles from '../onboarding.module.css';

export interface MarketSnapshotPanelProps {
  taxonomyId: string | null;
  title: string | null;
  country: string | null;
  countryLabel: string | null;
  city?: string | null;
}

export function MarketSnapshotPanel({ taxonomyId, title, country, countryLabel, city }: MarketSnapshotPanelProps) {
  const t = useTranslations('onboarding.snapshot');
  const format = useFormatter();
  const snap = useMarketSnapshot({ taxonomyId, country, city: city ?? null });
  if (!taxonomyId || !country || !title) return null;

  const place = city ? `${city}, ${countryLabel ?? country}` : (countryLabel ?? country);
  const money = (n: number, currency: string) => {
    try {
      return format.number(n, { style: 'currency', currency, maximumFractionDigits: 0 });
    } catch {
      return `${currency} ${n}`;
    }
  };

  return (
    <section className={styles.panel} aria-live="polite" aria-labelledby="ob-snapshot-title">
      <h2 id="ob-snapshot-title" className={styles.panelTitle}>
        {t('title')}
      </h2>
      {snap.isLoading ? <p className={styles.panelText}>{t('loading')}</p> : null}
      {snap.isError ? <p className={styles.panelText}>{t('error')}</p> : null}
      {snap.data ? (
        <>
          {snap.data.jobCount.value >= 1 ? (
            <p className={styles.panelStat} data-testid="snapshot-count">
              {t('count', { count: snap.data.jobCount.value, title, place, days: snap.data.windowDays })}
            </p>
          ) : (
            <p className={styles.panelText}>{t('none')}</p>
          )}
          {snap.data.pay ? (
            <>
              <p className={styles.panelText} data-testid="snapshot-pay">
                {t('pay', {
                  listed: snap.data.pay.listedCount,
                  total: snap.data.jobCount.value,
                  range: `${money(snap.data.pay.low, snap.data.pay.currency)}–${money(snap.data.pay.high, snap.data.pay.currency)}`,
                  period: t(`period.${snap.data.pay.period}`),
                })}
              </p>
              <p className={styles.hint}>{t('payBasis', { sample: snap.data.pay.sampleSize, currency: snap.data.pay.currency })}</p>
            </>
          ) : null}
          {snap.data.topSkills.length ? (
            <p className={styles.panelText} data-testid="snapshot-skills">
              {t('skills', { skills: snap.data.topSkills.map((s) => s.value).join(', ') })}
            </p>
          ) : null}
          <SourceNote
            className={styles.hint}
            sourced={{ value: snap.data.jobCount.value, source: 'index', asOf: snap.data.jobCount.asOf }}
          />
          <p className={styles.hint}>{t('footnote')}</p>
        </>
      ) : null}
    </section>
  );
}
