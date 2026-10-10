'use client';

// G4 live panel "现在开放的机会": open jobs and campus programmes for the
// chosen roles and cities, from the GoApply index only (D3). Every number
// shows where it came from and when; pay appears only when at least 20
// postings list monthly CNY pay ("Pay listed on X of N posts"); an unknown
// count renders "—", never 0. A count that covers only one of several chosen
// roles or cities names that role and city instead of claiming the total.

import { useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { MIN_SAMPLE } from '../common';
import { useCnOnboardingApi, type CnSnapshotQuery, type CnSnapshotView } from './api';
import { CN_ANY_CITY, yuanToK } from './logic';
import styles from './OnboardingCn.module.css';

type T = ReturnType<typeof useTranslations>;

/** The job-count line: the whole search, or the one role (and city) the count covers, named. */
export function jobsLine(t: T, d: CnSnapshotView): string {
  const { scope, value } = d.jobs;
  if (scope.complete) return t('intent.panel.jobs', { count: value });
  return scope.city ? t('intent.panel.jobsFor', { count: value, role: scope.role, city: scope.city }) : t('intent.panel.jobsForAllCities', { count: value, role: scope.role });
}

export function OpportunityPanel({ query }: { query: CnSnapshotQuery }) {
  const t = useTranslations('onboardingCn');
  const format = useFormatter();
  const api = useCnOnboardingApi();
  const [state, setState] = useState<{ status: 'idle' | 'loading' | 'done' | 'unavailable'; data: CnSnapshotView | null }>({ status: 'idle', data: null });
  const key = JSON.stringify(query);

  useEffect(() => {
    if (!query.roles.length) return setState({ status: 'idle', data: null });
    let live = true;
    setState((s) => ({ status: 'loading', data: s.data }));
    const timer = setTimeout(() => {
      api
        .marketSnapshot(query)
        .then((data) => live && setState({ status: data ? 'done' : 'unavailable', data }))
        .catch(() => live && setState({ status: 'unavailable', data: null }));
    }, 350);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key]);

  const d = state.data;
  const date = (iso: string) => format.dateTime(new Date(iso), { year: 'numeric', month: 'short', day: 'numeric' });
  const anyCity = query.cities.length === 0 || query.cities.includes(CN_ANY_CITY);

  return (
    <section className={styles.panel} aria-live="polite" aria-busy={state.status === 'loading'}>
      <h2 className={styles.panelTitle}>{t('intent.panel.title')}</h2>
      {state.status === 'idle' ? (
        <p className={styles.note}>{t('intent.panel.pickRole')}</p>
      ) : state.status === 'unavailable' ? (
        <p className={styles.note}>{t('intent.panel.unavailable')}</p>
      ) : !d ? (
        <p className={styles.note}>{t('common.loading')}</p>
      ) : (
        <>
          <p className={styles.stat}>{jobsLine(t, d)}</p>
          {d.jobs.scope.complete ? null : <p className={styles.note}>{t('intent.panel.partial')}</p>}
          <p className={styles.subtitle}>
            {d.campusOpen ? t(d.campusOpen.more ? 'intent.panel.campusMore' : 'intent.panel.campus', { count: d.campusOpen.value }) : t('intent.panel.campusUnknown')}
          </p>
          {d.pay && d.pay.sampleSize >= MIN_SAMPLE ? (
            <p className={styles.subtitle}>
              {d.pay.kind === 'iqr'
                ? `${t('intent.panel.payMedian', { amount: yuanToK(d.pay.median) })} ${t('intent.panel.payRange', { low: yuanToK(d.pay.low), high: yuanToK(d.pay.high) })}`
                : t('intent.panel.payPosted', { low: yuanToK(d.pay.low), high: yuanToK(d.pay.high) })}{' '}
              {t('intent.panel.payN', { listed: d.pay.listedCount, total: d.jobs.value })}
            </p>
          ) : (
            <p className={styles.note}>{t('intent.panel.payNotEnough')}</p>
          )}
          <p className={styles.note}>
            {t('intent.panel.source', { date: date(d.jobs.asOf) })}
            {anyCity && d.jobs.scope.complete ? ` ${t('intent.panel.allCities')}` : ''}
          </p>
        </>
      )}
    </section>
  );
}
