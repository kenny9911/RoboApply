'use client';

// salary — posted pay (salary_context): the job's own listed pay (source
// `posting`), and the middle half of the ranges employers listed in similar
// posts in our index. Always Sourced: below MIN_SAMPLE posts the value is "—"
// and the note says there is not enough data (D3); never a market estimate
// the server did not compute.

import { useLocale, useTranslations } from 'next-intl';

import { SourceNote, SourcedValue } from '../../common';
import { CardFrame } from './CardFrame';
import { parseSalary, type PayRange, type PostedPay } from './model';
import type { CardProps } from './types';
import styles from '../copilot.module.css';

function money(locale: string, currency: string, value: number): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 0 }).format(value);
  } catch {
    return `${currency} ${Math.round(value)}`;
  }
}

/** "€60,000–€80,000 / year" in the UI locale. Pure. */
export function formatRange(r: PayRange, locale: string, range: (min: string, max: string) => string, period: (p: PayRange['period']) => string): string {
  const lo = r.min !== null ? money(locale, r.currency, r.min) : null;
  const hi = r.max !== null ? money(locale, r.currency, r.max) : null;
  const amount = lo && hi ? range(lo, hi) : (lo ?? hi ?? '');
  return `${amount} ${period(r.period)}`.trim();
}

export function SalaryCard({ card }: CardProps) {
  const t = useTranslations('assistant.cards');
  const tPeriod = useTranslations('assistant.period');
  const locale = useLocale();
  const data = parseSalary(card.data);
  if (!data) return null;
  const what = [data.title, data.location].filter(Boolean).join(' · ');
  const fmt = (r: PayRange) => formatRange(r, locale, (min, max) => t('jobList.range', { min, max }), (p) => tPeriod(p));
  const fmtPosted = (p: PostedPay) => (p.range ? fmt(p.range) : (p.text ?? '—'));
  return (
    <CardFrame card={card} title={t('salary.title')} showSources={false}>
      {what ? <p className={styles.cardText}>{t('salary.for', { what })}</p> : null}
      {data.posted ? (
        <>
          <h4 className={styles.subTitle}>{t('salary.posted')}</h4>
          <p className={styles.cardTitle}>
            <SourcedValue value={data.posted} format={fmtPosted} />
          </p>
          <SourceNote sourced={data.posted} />
        </>
      ) : null}
      {data.range ? (
        <>
          <h4 className={styles.subTitle}>{t('salary.across')}</h4>
          <p className={styles.cardTitle}>
            <SourcedValue value={data.range} format={(r) => (r ? fmt(r) : '—')} />
          </p>
          <SourceNote sourced={data.range} />
        </>
      ) : null}
    </CardFrame>
  );
}
