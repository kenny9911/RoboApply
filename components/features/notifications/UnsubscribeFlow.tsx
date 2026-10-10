'use client';

// UnsubscribeFlow — /unsubscribe/<token>, the page every email footer links to
// (PRODUCT_PLAN.md F-NOTIF-04; RFC 8058). Works without signing in.
//
//   1. GET the preview (what the link turns off). Nothing changes on load:
//      mail scanners open links, so leaving a list needs a click.
//   2. "Unsubscribe" → POST; then "You're unsubscribed".
//   3. An optional reason (one choice + an optional note) → POST survey.
// A bad, partial or other-site token (a 4xx answer) gets one plain message and
// a way to change emails in Settings after signing in; a network or server
// failure says so and offers a retry. The explanation is per list (tips stop
// in the inbox too; alert emails stop instant and summaries alike) and, for a
// logged-out alert subscription, never mentions an inbox or Settings.

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import { useUnsubscribe, useUnsubscribePreview, useUnsubscribeSurvey } from '../../../hooks/notifications';
import { RoboApiError } from '../../../lib/api/client';
import type { UnsubscribeReason } from '../../../lib/api/contracts/notifications';
import styles from './notifications.module.css';

/** Mirrors UNSUBSCRIBE_REASONS in the server contract (the client mirror is type-only). */
export const UNSUBSCRIBE_REASON_ORDER: readonly UnsubscribeReason[] = ['too_many', 'not_relevant', 'never_signed_up', 'found_job', 'other'];
const KNOWN_LISTS = ['alerts', 'digest', 'reminders', 'tips', 'marketing'] as const;
type KnownList = (typeof KNOWN_LISTS)[number];

/** Which explanation a list gets: 'digest' and 'alerts' share one email switch; no account → 'anon'. */
export function unsubscribeVariant(list: KnownList, hasAccount: boolean): 'alerts' | 'reminders' | 'tips' | 'marketing' | 'anon' {
  if (!hasAccount) return 'anon';
  return list === 'digest' ? 'alerts' : list;
}

/** A 4xx answer means the link itself is bad (forged, cut short, another site's); anything else may pass. */
function isBadLink(err: unknown): boolean {
  return err instanceof RoboApiError && (err.status === 400 || err.status === 404 || err.status === 422);
}

function Survey({ token }: { token: string }) {
  const t = useTranslations('inbox.unsubscribe');
  const survey = useUnsubscribeSurvey();
  const [reason, setReason] = useState<UnsubscribeReason | null>(null);
  const [note, setNote] = useState('');

  if (survey.isSuccess) return <p className={styles.status} role="status">{t('thanks')}</p>;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!reason) return;
    survey.mutate({ token, reason, ...(note.trim() ? { note: note.trim().slice(0, 1000) } : {}) });
  };

  return (
    <form onSubmit={submit}>
      <fieldset className={styles.survey}>
        <legend className={styles.surveyLegend}>{t('surveyTitle')}</legend>
        {UNSUBSCRIBE_REASON_ORDER.map((r) => (
          <label key={r} className={styles.radio}>
            <input type="radio" name="reason" value={r} checked={reason === r} onChange={() => setReason(r)} />
            {t(`reasons.${r}`)}
          </label>
        ))}
        <label className={styles.selectLabel}>
          {t('noteLabel')}
          <textarea className={styles.textarea} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        {survey.isError ? (
          <p className={styles.error} role="alert">
            {t('surveyFailed')}
          </p>
        ) : null}
        <div className={styles.buttons}>
          <Btn type="submit" disabled={!reason || survey.isPending}>
            {t('send')}
          </Btn>
        </div>
      </fieldset>
    </form>
  );
}

export function UnsubscribeFlow({ token }: { token: string }) {
  const t = useTranslations('inbox.unsubscribe');
  const preview = useUnsubscribePreview(token);
  const leave = useUnsubscribe(token);

  const list = preview.data?.category;
  const known = list && (KNOWN_LISTS as readonly string[]).includes(list) ? (list as KnownList) : null;
  const listLabel = known ? t(`lists.${known}`) : null;
  const hasAccount = preview.data?.hasAccount !== false;
  const variant = known ? unsubscribeVariant(known, hasAccount) : 'alerts';

  let body;
  if (token.length < 16 || (preview.isError && isBadLink(preview.error)) || (preview.isSuccess && !listLabel)) {
    body = (
      <>
        <h1 className={styles.unsubTitle}>{t('invalidTitle')}</h1>
        <p className={styles.unsubSub}>{t('invalidSub')}</p>
        <div className={styles.buttons}>
          <Btn as="a" href="/login?next=%2Fsettings%23notifications" variant="primary">
            {t('signIn')}
          </Btn>
        </div>
      </>
    );
  } else if (preview.isError) {
    body = (
      <>
        <p className={styles.error} role="alert">
          {t('previewFailed')}
        </p>
        <div className={styles.buttons}>
          <Btn onClick={() => void preview.refetch()} disabled={preview.isFetching}>
            {t('retry')}
          </Btn>
        </div>
      </>
    );
  } else if (!preview.isSuccess || !listLabel) {
    body = (
      <p className={styles.status} role="status">
        {t('loading')}
      </p>
    );
  } else if (leave.isSuccess || preview.data.alreadyUnsubscribed) {
    body = (
      <>
        <h1 className={styles.unsubTitle}>{t('doneTitle')}</h1>
        <p className={styles.unsubSub} role="status">
          {leave.isSuccess ? t(`doneSub.${variant}`) : t('already', { list: listLabel })}
        </p>
        {hasAccount ? (
          <div className={styles.buttons}>
            <Btn as="a" href="/settings#notifications">
              {t('settings')}
            </Btn>
          </div>
        ) : null}
        {leave.isSuccess ? <Survey token={token} /> : null}
      </>
    );
  } else {
    body = (
      <>
        <h1 className={styles.unsubTitle}>{t('confirmTitle', { list: listLabel })}</h1>
        <p className={styles.unsubSub}>{t(`confirmSub.${variant}`)}</p>
        {leave.isError ? (
          <p className={styles.error} role="alert">
            {t('failed')}
          </p>
        ) : null}
        <div className={styles.buttons}>
          <Btn variant="primary" onClick={() => leave.mutate()} disabled={leave.isPending}>
            {t('confirm')}
          </Btn>
        </div>
      </>
    );
  }

  return (
    <section className={styles.unsub} aria-label={t('pageTitle')}>
      {body}
    </section>
  );
}

export default UnsubscribeFlow;
