'use client';

// CancelSubscription — one-click cancel (PRODUCT_PLAN.md §6.4 "Cancel",
// F-BILL-03, F-BILL-06; TASK_PLAN.md WP-21b):
//
//   - `Cancel subscription` is the primary action and completes in ONE click:
//     no confirmation dialog, no survey first, no retention screen.
//   - After it completes: access continues to the period end, a confirmation
//     email goes out (server), and — once, ever, as a secondary link — "Switch
//     to the 7-day pass instead?" when the server offers that alternative.
//     It never blocks or undoes the cancellation.
//   - An optional "why?" survey AFTER cancelling. It goes to its own
//     endpoint (POST /credits/cancel/survey), which only stores the answer.
//   - If the in-app call fails, the public /cancel page is offered.

import Link from 'next/link';
import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import { useCancelSubscription, useCancelSurvey } from '../../../hooks/credits/useBillingActions';
import type { CancelResponse, CancelSurveyReason } from '../../../lib/api/contracts/credits';
import { parseDate } from './labels';
import styles from './credits.module.css';

export const CANCEL_ALTERNATIVE_STORAGE_KEY = 'ra.credits.cancelAlternativeShown';
export const WEEK_PASS_HREF = '/settings/billing?plan=pro_week_pass#plans';
/** The contract's `CANCEL_SURVEY_REASONS` (the server refuses any other value). */
const SURVEY_REASONS = ['price', 'found_job', 'not_useful', 'pause', 'other'] as const satisfies readonly CancelSurveyReason[];

/** The plan sheet with the server's alternative selected (and shown, even to a subscriber). */
function alternativeHref(res: CancelResponse): string {
  const key = res.alternative?.planKey;
  return key ? `/settings/billing?plan=${encodeURIComponent(key)}#plans` : WEEK_PASS_HREF;
}

function alternativeAlreadyShown(): boolean {
  try {
    return window.localStorage.getItem(CANCEL_ALTERNATIVE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function markAlternativeShown(): void {
  try {
    window.localStorage.setItem(CANCEL_ALTERNATIVE_STORAGE_KEY, '1');
  } catch {
    /* storage blocked: the server still offers it only once */
  }
}

export interface CancelSubscriptionProps {
  /** End of the paid period (ISO), for the "you keep Pro until" line. */
  periodEnd: string | null;
  /** Called once the cancel succeeded (the parent keeps this view mounted). */
  onCancelled?: () => void;
}

export function CancelSubscription({ periodEnd, onCancelled }: CancelSubscriptionProps) {
  const t = useTranslations('credits.cancel');
  const format = useFormatter();
  const cancel = useCancelSubscription();
  const survey = useCancelSurvey();
  const [result, setResult] = useState<{ res: CancelResponse; showAlternative: boolean } | null>(null);
  const [reason, setReason] = useState<CancelSurveyReason | null>(null);
  const [note, setNote] = useState('');

  const fmt = (iso: string | null | undefined) => {
    const d = parseDate(iso);
    return d ? format.dateTime(d, { dateStyle: 'medium' }) : null;
  };

  if (result) {
    const until = fmt(result.res.accessUntil ?? periodEnd);
    const already = result.res.status === 'already_cancelled';
    return (
      <div className={styles.stack} data-testid="cancel-done">
        <div className={`${styles.notice} ${styles.ok}`} role="status">
          <p className={styles.body}>
            {already ? t('already') : until ? t('done', { date: until }) : t('doneNoDate')}
          </p>
        </div>
        {result.showAlternative ? (
          <Link href={alternativeHref(result.res)} className={styles.link} data-testid="cancel-alternative">
            {t('alternative')}
          </Link>
        ) : null}
        {survey.isError ? (
          <p className={styles.error} role="alert">
            {t('survey.error')}
          </p>
        ) : null}
        {survey.isSuccess ? (
          <p className={styles.muted} role="status">
            {t('survey.sent')}
          </p>
        ) : (
          <fieldset className={styles.fieldset}>
            <legend className={styles.legend}>{t('survey.title')}</legend>
            <div className={styles.actions} role="group">
              {SURVEY_REASONS.map((r) => (
                <Btn key={r} variant={reason === r ? 'violet' : 'default'} aria-pressed={reason === r} onClick={() => setReason(r)}>
                  {t(`survey.${r}`)}
                </Btn>
              ))}
            </div>
            <label className={styles.label} htmlFor="cancel-survey-note">
              {t('survey.note')}
            </label>
            <textarea
              id="cancel-survey-note"
              className={styles.input}
              style={{ minHeight: 88, paddingTop: 'var(--sp-2)' }}
              maxLength={1000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <div className={styles.actions}>
              <Btn disabled={survey.isPending || (!reason && !note.trim())} onClick={() => survey.mutate({ reason: reason ?? undefined, note })}>
                {t('survey.send')}
              </Btn>
            </div>
          </fieldset>
        )}
      </div>
    );
  }

  const until = fmt(periodEnd);
  return (
    <div className={styles.stack} data-testid="cancel-subscription">
      <p className={styles.muted}>{until ? t('help', { date: until }) : t('helpNoDate')}</p>
      {cancel.isError ? (
        <p className={styles.error} role="alert">
          {t('error')}{' '}
          <Link href="/cancel" className={styles.link}>
            {t('cancelPageLink')}
          </Link>
        </p>
      ) : null}
      <div className={styles.actions}>
        <Btn
          variant="primary"
          disabled={cancel.isPending}
          onClick={() =>
            cancel.mutate(undefined, {
              onSuccess: (res) => {
                const showAlternative = !!res.alternative && res.status === 'cancelled' && !alternativeAlreadyShown();
                if (showAlternative) markAlternativeShown();
                setResult({ res, showAlternative });
                onCancelled?.();
              },
            })
          }
        >
          {cancel.isPending ? t('pending') : t('button')}
        </Btn>
      </div>
    </div>
  );
}

export default CancelSubscription;
