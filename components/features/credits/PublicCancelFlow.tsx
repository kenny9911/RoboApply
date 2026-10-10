'use client';

// PublicCancelFlow — /cancel without signing in (PRODUCT_PLAN.md §3.4,
// F-BILL-03; §312k BGB "Verträge hier kündigen" → "Jetzt kündigen"):
//
//   1. no token: email → POST /api/v1/public/cancel → the same neutral answer
//      whether or not the email has a subscription (no account enumeration);
//   2. with the one-time token from the email (30 min, single use): one
//      button cancels → access until the period end + confirmation email.
//
// The token is read once from the URL and stripped from the address bar so it
// does not linger in history or get shared by copy-paste.
//
// A link that is unknown, already used or older than 30 minutes answers 410
// with the envelope code `cancel_token_invalid` (top-level `code`; the server
// puts no `details.reason` on it). `isCancelTokenInvalid` reads the code and,
// so a later move into `details.reason` cannot silently turn "this link has
// expired" into a generic error, the reason as well.

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import { apiErrorCode, apiErrorReason } from '../../../lib/api/contracts/wire';
import { useAuth } from '../../../lib/auth/useAuth';
import { useConfirmPublicCancel, useRequestCancelLink } from '../../../hooks/credits/usePublicCancel';
import { parseDate } from './labels';
import styles from './credits.module.css';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const CANCEL_TOKEN_INVALID = 'cancel_token_invalid';

/** The confirm call failed because the link itself is no good (not because of a network or provider error). */
export function isCancelTokenInvalid(err: unknown): boolean {
  return apiErrorCode(err) === CANCEL_TOKEN_INVALID || apiErrorReason(err) === CANCEL_TOKEN_INVALID;
}

export interface PublicCancelFlowProps {
  /** The one-time token from the emailed link (`/cancel?token=…`), if any. */
  token?: string | null;
}

export function PublicCancelFlow({ token: initialToken = null }: PublicCancelFlowProps) {
  const t = useTranslations('credits.cancelPage');
  const format = useFormatter();
  const { status } = useAuth();
  // Read once on mount; the URL is cleaned below, the token stays in memory.
  const [token] = useState<string | null>(initialToken && initialToken.length >= 16 ? initialToken : null);
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState(false);
  const requestLink = useRequestCancelLink();
  const confirm = useConfirmPublicCancel();

  useEffect(() => {
    if (!initialToken) return;
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has('token')) {
        url.searchParams.delete('token');
        window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
      }
    } catch {
      /* non-browser test env */
    }
  }, [initialToken]);

  const onRequest = (e: FormEvent) => {
    e.preventDefault();
    if (!EMAIL_RE.test(email.trim())) {
      setEmailError(true);
      return;
    }
    setEmailError(false);
    requestLink.mutate({ email });
  };

  const tokenInvalid = confirm.isError && isCancelTokenInvalid(confirm.error);

  return (
    <div className={styles.publicPage} data-testid="public-cancel">
      <h1 className={styles.title}>{token ? t('confirmTitle') : t('title')}</h1>

      {token && confirm.data ? (
        <div className={`${styles.notice} ${styles.ok}`} role="status" data-testid="public-cancel-done">
          <p className={styles.body}>
            {confirm.data.status === 'already_cancelled'
              ? t('already')
              : (() => {
                  const d = parseDate(confirm.data.accessUntil);
                  return d ? t('done', { date: format.dateTime(d, { dateStyle: 'medium' }) }) : t('doneNoDate');
                })()}
          </p>
        </div>
      ) : null}

      {token && !confirm.data && !tokenInvalid ? (
        <div className={styles.stack}>
          <p className={styles.body}>{t('confirmSub')}</p>
          {confirm.isError ? (
            <p className={styles.error} role="alert">
              {t('error')}
            </p>
          ) : null}
          <div className={styles.actions}>
            <Btn variant="primary" disabled={confirm.isPending} onClick={() => confirm.mutate({ token })}>
              {confirm.isPending ? t('confirming') : t('confirm')}
            </Btn>
          </div>
        </div>
      ) : null}

      {tokenInvalid ? (
        <p className={styles.error} role="alert">
          {t('tokenInvalid')}
        </p>
      ) : null}

      {!token || tokenInvalid ? (
        requestLink.isSuccess ? (
          <div className={styles.notice} role="status" data-testid="public-cancel-sent">
            <p className={styles.body}>{t('sent')}</p>
          </div>
        ) : (
          <form className={styles.form} onSubmit={onRequest} noValidate>
            <p className={styles.body}>{t('sub')}</p>
            <label className={styles.label} htmlFor="cancel-email">
              {t('email')}
            </label>
            <input
              id="cancel-email"
              className={styles.input}
              type="email"
              autoComplete="email"
              inputMode="email"
              value={email}
              aria-invalid={emailError || undefined}
              aria-describedby={emailError ? 'cancel-email-error' : undefined}
              onChange={(e) => setEmail(e.target.value)}
            />
            {emailError ? (
              <p className={styles.error} id="cancel-email-error">
                {t('invalidEmail')}
              </p>
            ) : null}
            {requestLink.isError ? (
              <p className={styles.error} role="alert">
                {t('error')}
              </p>
            ) : null}
            <div className={styles.actions}>
              <Btn type="submit" variant="primary" disabled={requestLink.isPending}>
                {requestLink.isPending ? t('sending') : t('send')}
              </Btn>
            </div>
          </form>
        )
      ) : null}

      {status === 'authenticated' ? (
        <p className={styles.muted}>
          {t('signedIn')}{' '}
          <Link href="/settings#billing" className={styles.link}>
            {t('settingsLink')}
          </Link>
        </p>
      ) : null}
    </div>
  );
}

export default PublicCancelFlow;
