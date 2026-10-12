'use client';

// AlertConfirm — /alerts/confirm/[token]: the second step of the double
// opt-in for logged-out job alerts (WP-78; F-NOTIF-03).
//
// Opening the link changes nothing (mail scanners open links): the page reads
// what the link is for (GET) and the visitor presses "Confirm job alerts"
// (POST). States: pending → confirmed; already confirmed; unsubscribed (an
// old link never puts an address back); invalid or expired (72 h).

import Link from 'next/link';
import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useMutation, useQuery } from '@tanstack/react-query';

import { apiErrorCode } from '../../../lib/api/contracts/wire';
import type { AnonAlertView } from '../../../lib/api/contracts/visitor';
import { confirmAnonAlert, submitAnonAlertConfirm } from '../../../lib/api/visitor';
import { Btn } from '../../v3/primitives';
import { filtersLabel, regionName, signupHref } from './model';
import styles from './visitor.module.css';

export interface AlertConfirmProps {
  token: string;
}

export function AlertConfirm({ token }: AlertConfirmProps) {
  const t = useTranslations('visitor.confirm');
  const locale = useLocale();
  const [confirmed, setConfirmed] = useState<AnonAlertView | null>(null);
  const valid = token.length >= 16 && token.length <= 512;

  const view = useQuery<AnonAlertView>({
    queryKey: ['visitor', 'alertConfirm', token],
    queryFn: () => confirmAnonAlert({ token }),
    enabled: valid,
    retry: false,
    staleTime: Infinity,
  });
  const confirm = useMutation({
    mutationFn: () => submitAnonAlertConfirm({ token }),
    onSuccess: (v) => setConfirmed(v),
  });

  const current = confirmed ?? view.data ?? null;
  const code = view.isError ? apiErrorCode(view.error) : null;

  let body;
  if (!valid || code === 'not_found') {
    body = (
      <>
        <h1 className={styles.h1}>{t('invalidTitle')}</h1>
        <p className={styles.body}>{t('invalidBody')}</p>
        <Link href="/tools/job-alerts" className={styles.gateCta}>
          {t('again')}
        </Link>
      </>
    );
  } else if (code === 'feature_disabled') {
    body = <p className={styles.body}>{t('unavailable')}</p>;
  } else if (view.isError) {
    body = (
      <div className={styles.notice} role="alert">
        <p className={styles.body}>{t('error')}</p>
        <Btn onClick={() => void view.refetch()}>{t('retry')}</Btn>
      </div>
    );
  } else if (!current) {
    body = (
      <p className={styles.muted} role="status">
        {t('loading')}
      </p>
    );
  } else {
    const search = filtersLabel(current.filters, (c) => regionName(c, locale)) || t('searchAny');
    const cadence = t(`cadence.${current.cadence}`);
    if (current.state === 'pending') {
      body = (
        <>
          <h1 className={styles.h1}>{t('pendingTitle')}</h1>
          <p className={styles.body}>{t('pendingBody', { email: current.emailMasked, search, cadence })}</p>
          {confirm.isError ? (
            <p className={styles.error} role="alert">
              {t('error')}
            </p>
          ) : null}
          <div className={styles.gateActions}>
            <Btn variant="primary" onClick={() => confirm.mutate()} disabled={confirm.isPending}>
              {confirm.isPending ? t('confirming') : t('confirm')}
            </Btn>
          </div>
        </>
      );
    } else if (current.state === 'confirmed') {
      body = (
        <div role="status" data-alert-state="confirmed">
          <h1 className={styles.h1}>{t('confirmedTitle')}</h1>
          <p className={styles.body}>{t('confirmedBody', { search, cadence })}</p>
          <div className={styles.gateActions}>
            <Link href={signupHref('alert-confirm')} className={styles.gateSecondary}>
              {t('seeJobs')}
            </Link>
          </div>
        </div>
      );
    } else {
      body = (
        <>
          <h1 className={styles.h1}>{t('unsubscribedTitle')}</h1>
          <p className={styles.body}>{t('unsubscribedBody')}</p>
          <Link href="/tools/job-alerts" className={styles.gateCta}>
            {t('again')}
          </Link>
        </>
      );
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.panel} data-alert-confirm={current?.state ?? (code ? 'error' : 'loading')}>
        {body}
      </div>
    </div>
  );
}
