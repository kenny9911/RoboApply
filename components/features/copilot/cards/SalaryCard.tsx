'use client';

// salary — posted pay for a role, from the ranges employers listed in our
// index (salary_context). Always Sourced: below MIN_SAMPLE posts the value is
// "—" and the note says there is not enough data (D3); never a market
// estimate the server did not compute.

import { useLocale, useTranslations } from 'next-intl';

import { SourceNote, SourcedValue } from '../../common';
import { CardFrame } from './CardFrame';
import { parseSalary, type PayRange } from './model';
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
  return (
    <CardFrame card={card} title={t('salary.title')} showSources={false}>
      {what ? <p className={styles.cardText}>{t('salary.for', { what })}</p> : null}
      <p className={styles.cardTitle}>
        <SourcedValue
          value={data.range}
          format={(r) => (r ? formatRange(r, locale, (min, max) => t('jobList.range', { min, max }), (p) => tPeriod(p)) : '—')}
        />
      </p>
      <SourceNote sourced={data.range} />
    </CardFrame>
  );
}
