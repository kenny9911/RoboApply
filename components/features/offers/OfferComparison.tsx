'use client';

// OfferComparison — side-by-side offers with deterministic totals and stated
// assumptions (TASK_PLAN.md WP-64; ruling C9).
//
// WP-38's Applications page mounts it as the "Offers" view when the `offers`
// flag is on; it renders nothing with the flag off. With no ids it compares
// the offers the user picks (the newest five by default). Totals are worked
// out on the server from the user's numbers only; currencies are never
// converted, so "Highest" shows only when every offer uses one currency. The
// optional explanation is AI-written, labelled, and holds no market data.

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives';
import { PhoneBindingNotice } from '../auth-cn';
import { useFlag } from '../../../lib/flags';
import { useExplainOffers, useOfferComparison, useOffers, useOffersAiAvailable } from '../../../hooks/offers/useOffers';
import type * as OF from '../../../lib/api/contracts/offers';
import { AiText } from './AiText';
import { aiErrorKey, useMoney } from './shared';
import styles from './offers.module.css';

export interface OfferComparisonProps {
  /** RATrackerEntry ids to compare (2–5); omitted = every entry with an offer. */
  trackerEntryIds?: readonly string[];
}

/** Server limit for one comparison. */
export const MAX_COMPARED = 5;

export function OfferComparison(props: OfferComparisonProps = {}) {
  const on = useFlag('offers');
  if (!on) return null;
  return <ComparisonBody {...props} />;
}

function ComparisonBody({ trackerEntryIds }: OfferComparisonProps) {
  const t = useTranslations('offers.compare');
  const list = useOffers();
  const offers = useMemo(() => {
    const all = list.data ?? [];
    return trackerEntryIds ? all.filter((o) => trackerEntryIds.includes(o.trackerEntryId)) : all;
  }, [list.data, trackerEntryIds]);
  const [picked, setPicked] = useState<string[] | null>(null);
  const selected = picked ?? offers.slice(0, MAX_COMPARED).map((o) => o.trackerEntryId);
  const live = selected.filter((id) => offers.some((o) => o.trackerEntryId === id));
  const comparison = useOfferComparison(live);

  function toggle(id: string, checked: boolean) {
    const next = checked ? [...live, id] : live.filter((x) => x !== id);
    setPicked(next.slice(0, MAX_COMPARED));
  }

  return (
    <section className={styles.section} aria-labelledby="offers-compare-title">
      <div className={styles.head}>
        <h2 id="offers-compare-title" className={styles.bigTitle}>
          {t('title')}
        </h2>
      </div>
      <p className={styles.text}>{t('intro')}</p>

      {list.isLoading ? <p className={styles.muted}>{t('loading')}</p> : null}
      {list.isError ? <p className={styles.error}>{t('load_error')}</p> : null}
      {list.data && offers.length < 2 ? <p className={styles.muted}>{t('need_two')}</p> : null}

      {offers.length > 2 ? (
        <fieldset className={styles.picker}>
          <legend className={styles.label}>{t('pick', { max: MAX_COMPARED })}</legend>
          {offers.map((o) => {
            const checked = live.includes(o.trackerEntryId);
            return (
              <label key={o.trackerEntryId} className={styles.check}>
                <input type="checkbox" checked={checked} disabled={!checked && live.length >= MAX_COMPARED} onChange={(e) => toggle(o.trackerEntryId, e.target.checked)} />
                {o.companyName || o.title}
              </label>
            );
          })}
        </fieldset>
      ) : null}

      {offers.length >= 2 && live.length < 2 ? <p className={styles.muted}>{t('pick_two')}</p> : null}
      {comparison.isError ? <p className={styles.error}>{t('load_error')}</p> : null}
      {comparison.data && live.length >= 2 ? <ComparisonTable data={comparison.data} /> : null}
      {comparison.data && live.length >= 2 ? <Explain ids={live} /> : null}
    </section>
  );
}

function ComparisonTable({ data }: { data: OF.OfferComparison }) {
  const t = useTranslations('offers.compare');
  const tr = useTranslations('offers.rows');
  const ts = useTranslations('offers.section');
  const money = useMoney();
  const names = new Map(data.offers.map((o) => [o.trackerEntryId, o.companyName || o.title]));

  const cell = (key: OF.OfferRowKey, value: string | number | boolean | null, offer: OF.OfferView): string => {
    if (value === null) return '—';
    switch (key) {
      case 'base':
        return ts('per_period', { amount: money(Number(value), offer.offer.currency), period: offer.offer.period });
      case 'bonusAmount':
      case 'signingBonus':
        return money(Number(value), offer.offer.currency);
      case 'socialInsuranceBase':
        return money(Number(value), offer.offer.currency);
      case 'housingFundPercent':
        return `${value}%`;
      case 'hukou':
        return value ? t('yes') : t('no');
      default:
        return String(value);
    }
  };

  const totalRow = (label: string, pick: (x: OF.OfferTotals) => number | null, highest?: readonly string[]) => (
    <tr className={styles.totalRow}>
      <th scope="row">{label}</th>
      {data.totals.map((x) => {
        const v = pick(x);
        return (
          <td key={x.trackerEntryId}>
            {money(v, x.currency)}
            {highest && highest.length < data.totals.length && highest.includes(x.trackerEntryId) ? <span className={styles.highest}>{t('highest')}</span> : null}
          </td>
        );
      })}
    </tr>
  );
  const anyFund = data.totals.some((x) => x.housingFundAnnual !== null);
  const anyFirstYearDiff = data.totals.some((x) => x.firstYear !== x.recurringAnnual);

  return (
    <>
      {!data.sameCurrency ? <p className={styles.muted}>{t('different_currencies')}</p> : null}
      <div className={styles.tableWrap} role="region" aria-label={t('table_label')} tabIndex={0}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">{t('offer')}</th>
              {data.offers.map((o) => (
                <th key={o.trackerEntryId} scope="col">
                  {o.companyName || '—'}
                  {o.title ? <span className={styles.colRole}>{o.title}</span> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={row.key}>
                <th scope="row">{tr(row.key)}</th>
                {row.values.map((v, i) => (
                  <td key={data.offers[i]!.trackerEntryId}>{cell(row.key, v, data.offers[i]!)}</td>
                ))}
              </tr>
            ))}
            <tr>
              <th scope="row">{tr('base_annual')}</th>
              {data.totals.map((x) => (
                <td key={x.trackerEntryId}>{money(x.baseAnnual, x.currency)}</td>
              ))}
            </tr>
            {anyFund ? (
              <tr>
                <th scope="row">{tr('housing_fund_annual')}</th>
                {data.totals.map((x) => (
                  <td key={x.trackerEntryId}>{money(x.housingFundAnnual, x.currency)}</td>
                ))}
              </tr>
            ) : null}
            {totalRow(ts('yearly_total'), (x) => x.recurringAnnual, data.highest?.recurringAnnual)}
            {anyFirstYearDiff ? totalRow(ts('first_year'), (x) => x.firstYear, data.highest?.firstYear) : null}
          </tbody>
        </table>
      </div>
      <div>
        <p className={styles.label}>{t('assumptions_title')}</p>
        <ul className={styles.assumptions}>
          {data.assumptions.map((a, i) => (
            <li key={`${a.code}-${i}`}>
              {t(`assumption.${a.code}`, { months: 12, hours: 40, weeks: 52, ...(a.params ?? {}) })}
              {a.trackerEntryIds && a.trackerEntryIds.length < data.offers.length
                ? ` ${t('applies_to', { names: a.trackerEntryIds.map((id) => names.get(id) ?? '').filter(Boolean).join(', ') })}`
                : null}
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

function Explain({ ids }: { ids: readonly string[] }) {
  const t = useTranslations('offers.compare');
  const td = useTranslations('offers.draft');
  // Hidden unless the server says the AI can run for this user (consent AND ai.text, §2.2).
  const capability = useFlag('ai.text');
  const aiOn = useOffersAiAvailable(capability) && capability;
  const explain = useExplainOffers();
  if (!aiOn) return null;
  const errKey = explain.isError ? aiErrorKey(explain.error) : null;
  const current = explain.data && explain.data.trackerEntryIds.join() === ids.join() ? explain.data : null;
  return (
    <div className={styles.form}>
      <div className={styles.actions}>
        <Btn variant="default" disabled={explain.isPending} onClick={() => explain.mutate(ids)}>
          {explain.isPending ? t('explaining') : t('explain')}
        </Btn>
      </div>
      {errKey ? (
        <p className={styles.error} role="alert">
          {td(`error.${errKey}`)}
        </p>
      ) : null}
      {explain.isError ? <PhoneBindingNotice error={explain.error} /> : null}
      {current ? <AiText label={t('ai_label')} text={current.text} /> : null}
    </div>
  );
}

export default OfferComparison;
