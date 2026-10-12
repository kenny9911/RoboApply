'use client';

// PublicCancelFlow — /cancel without signing in (PRODUCT_PLAN.md §3.4,
// F-BILL-03; §312k BGB "Verträge hier kündigen" → "Jetzt kündigen"):
//
//   1. no token: email → POST /api/v1/public/cancel → the same neutral answer
//      whether or not the email has a subscription (no account enumeration);
//   2. with the one-time token from the email (30 min, single use): one
//      button cancels → access until the period end + confirmation email.
//
// With a token the page first asks what the link can do (ST-9; MARKET_STRATEGY
// §4.4 "Statutory withdrawal"). The question does not use the link up. While
// a withdrawal is open for the purchase (14 days; EU, EEA, UK, Taiwan) the
// page shows two labelled choices instead of one button:
//
//   - "Cancel at the end of the period": exactly the cancel above;
//   - "Withdraw from contract and refund {amount}", with its last day: the
//     plan ends at once and the amount the server quoted goes back. Two steps
//     for the visitor: open the link, press the button.
//
// Without an open withdrawal, with an older server, or when the question
// fails for any reason other than a bad link (also when it takes too long:
// the hook gives up after a few seconds), the page is the one button it
// always was. If the withdrawal is no longer available when the button is
// pressed, the server cancels at the end of the period instead and the page
// says so; if it refuses the withdrawal outright (409
// `withdrawal_not_available`), the page says the purchase can no longer be
// withdrawn and offers the ordinary cancel only, for the rest of this page
// view: the refusal is remembered, so the withdrawal is not shown again while
// that cancel is sent or after it fails. The amount and the last day are the
// server's; nothing is computed here.
//
// The token is read once from the URL and stripped from the address bar so it
// does not linger in history or get shared by copy-paste.
//
// A link that is unknown, already used or older than 30 minutes answers 410
// with the envelope code `cancel_token_invalid` (top-level `code`; the server
// puts no `details.reason` on it), on the question as on the cancel itself.
// `isCancelTokenInvalid` reads the code and, so a later move into
// `details.reason` cannot silently turn "this link has expired" into a
// generic error, the reason as well.

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import { apiErrorCode, apiErrorReason } from '../../../lib/api/contracts/wire';
import type { PublicCancelPreview } from '../../../lib/api/account';
import { useAuth } from '../../../lib/auth/useAuth';
import { useBrand } from '../../../lib/brand/BrandProvider';
import { WITHDRAWAL_UNAVAILABLE_CODE } from '../../../hooks/credits/useBillingActions';
import { useConfirmPublicCancel, usePreviewPublicCancel, useRequestCancelLink } from '../../../hooks/credits/usePublicCancel';
import { chargedMoney, parseDate } from './labels';
import styles from './credits.module.css';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const CANCEL_TOKEN_INVALID = 'cancel_token_invalid';

/** The confirm call failed because the link itself is no good (not because of a network or provider error). */
export function isCancelTokenInvalid(err: unknown): boolean {
  return apiErrorCode(err) === CANCEL_TOKEN_INVALID || apiErrorReason(err) === CANCEL_TOKEN_INVALID;
}

/** The withdrawal this link can still make at `now`: the server's quote, unless its last day has passed. */
export function openLinkWithdrawal(preview: PublicCancelPreview | null | undefined, now: Date): NonNullable<PublicCancelPreview['withdrawal']> | null {
  const w = preview?.withdrawal ?? null;
  const deadline = parseDate(w?.deadline);
  return w && deadline && deadline.getTime() > now.getTime() ? w : null;
}

export interface PublicCancelFlowProps {
  /** The one-time token from the emailed link (`/cancel?token=…`), if any. */
  token?: string | null;
  /** Clock (tests). */
  now?: () => Date;
}

export function PublicCancelFlow({ token: initialToken = null, now = () => new Date() }: PublicCancelFlowProps) {
  const t = useTranslations('credits.cancelPage');
  const format = useFormatter();
  const locale = useLocale();
  const brand = useBrand();
  const { status } = useAuth();
  // Read once on mount; the URL is cleaned below, the token stays in memory.
  const [token] = useState<string | null>(initialToken && initialToken.length >= 16 ? initialToken : null);
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState(false);
  const requestLink = useRequestCancelLink();
  const preview = usePreviewPublicCancel(token);
  const confirm = useConfirmPublicCancel();
  // The server refused the withdrawal itself (409: withdrawn elsewhere, or the payment was already refunded). Kept
  // for the page view: whatever the next call does, this link's withdrawal is not offered again.
  const [withdrawGone, setWithdrawGone] = useState(false);

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

  // A bad link shows on the question already; the cancel itself can still find it bad later.
  const tokenInvalid = (preview.isError && isCancelTokenInvalid(preview.error)) || (confirm.isError && isCancelTokenInvalid(confirm.error));
  // The question is still out: the page waits for it, so the two choices never appear under a button already pressed.
  const checking = !!token && preview.isPending && !confirm.data;
  const askedWithdraw = confirm.variables?.withdraw === true;
  // The refusal as the withdraw call's own error (true from the render that shows it), and as remembered afterwards.
  const refusalIsLastError = confirm.isError && askedWithdraw && apiErrorCode(confirm.error) === WITHDRAWAL_UNAVAILABLE_CODE;
  const refused = withdrawGone || refusalIsLastError;
  // What is left after a refused withdrawal is the ordinary cancel, which then answers for the plan as it is now.
  const withdrawal = refused ? null : openLinkWithdrawal(preview.data, now());
  const onWithdraw = () => {
    if (!token) return;
    confirm.mutate(
      { token, withdraw: true },
      {
        onError: (err) => {
          if (apiErrorCode(err) === WITHDRAWAL_UNAVAILABLE_CODE) setWithdrawGone(true);
        },
      },
    );
  };
  const day = (iso: string | null | undefined) => {
    const d = parseDate(iso);
    return d ? format.dateTime(d, { dateStyle: 'medium' }) : null;
  };
  const moment = (iso: string) => {
    const d = parseDate(iso);
    return d ? format.dateTime(d, { dateStyle: 'medium', timeStyle: 'short' }) : iso;
  };
  const amount = (minor: number, currency: string) => chargedMoney(locale, minor, currency, brand.currency);

  /** What the link did, in the server's own terms. */
  const outcome = () => {
    const res = confirm.data;
    if (!res) return null;
    const until = day(res.accessUntil);
    const cancelled = res.status === 'already_cancelled' ? t('already') : until ? t('done', { date: until }) : t('doneNoDate');
    if (!askedWithdraw) return <p className={styles.body}>{cancelled}</p>;
    const w = res.withdrawal;
    if (w?.status === 'withdrawn') {
      return (
        <p className={styles.body} data-testid="public-cancel-withdrawn">
          {w.refundMinor !== null && w.currency ? t('withdrawn', { amount: amount(w.refundMinor, w.currency) }) : t('withdrawnNoAmount')}
        </p>
      );
    }
    // Asked to withdraw, and the server cancelled at the end of the period instead.
    return (
      <>
        <p className={styles.body} data-testid="public-cancel-withdraw-gone">
          {t('withdrawGone')}
        </p>
        <p className={styles.body}>
          {res.status === 'already_cancelled' ? t('already') : until ? t('cancelledInstead', { date: until }) : t('cancelledInsteadNoDate')}
        </p>
      </>
    );
  };

  // The refusal has its own line; a later failure of the ordinary cancel is a plain error.
  const confirmError =
    confirm.isError && !tokenInvalid && !refusalIsLastError ? (
      <p className={styles.error} role="alert">
        {t('error')}
      </p>
    ) : null;
  // Said for as long as the single button is what is left of the two choices.
  const withdrawGoneLine = refused ? (
    <p className={styles.error} role="alert" data-testid="public-cancel-withdraw-refused">
      {t('withdrawGone')}
    </p>
  ) : null;

  return (
    <div className={styles.publicPage} data-testid="public-cancel">
      <h1 className={styles.title}>{token ? t('confirmTitle') : t('title')}</h1>

      {token && confirm.data ? (
        <div className={`${styles.notice} ${styles.ok}`} role="status" data-testid="public-cancel-done">
          {outcome()}
        </div>
      ) : null}

      {checking && !tokenInvalid ? (
        <p className={styles.muted} aria-busy="true" data-testid="public-cancel-checking">
          {t('checking')}
        </p>
      ) : null}

      {token && !checking && !confirm.data && !tokenInvalid && withdrawal ? (
        <div className={styles.stack} data-testid="public-cancel-choices">
          <p className={styles.body}>{t('choose')}</p>
          {confirmError}
          <section className={styles.card} aria-labelledby="public-cancel-keep">
            <h2 className={styles.h2} id="public-cancel-keep">
              {t('cancelChoiceTitle')}
            </h2>
            <p className={styles.body}>
              {(() => {
                const until = day(preview.data?.accessUntil);
                return until ? t('cancelChoiceSub', { date: until }) : t('cancelChoiceSubNoDate');
              })()}
            </p>
            <div className={styles.actions}>
              <Btn disabled={confirm.isPending} onClick={() => confirm.mutate({ token })}>
                {confirm.isPending && !askedWithdraw ? t('confirming') : t('cancelChoiceButton')}
              </Btn>
            </div>
          </section>
          <section className={styles.card} aria-labelledby="public-cancel-withdraw">
            <h2 className={styles.h2} id="public-cancel-withdraw">
              {t('withdrawChoiceTitle')}
            </h2>
            <p className={styles.body}>
              {t('withdrawChoiceSub', { amount: amount(withdrawal.refundMinor, withdrawal.currency), date: moment(withdrawal.deadline) })}
            </p>
            {withdrawal.rule === 'withdrawal_14d_prorata' ? <p className={styles.body}>{t('withdrawProrata')}</p> : null}
            <div className={styles.actions}>
              <Btn disabled={confirm.isPending} onClick={onWithdraw}>
                {confirm.isPending && askedWithdraw ? t('withdrawing') : t('withdrawButton', { amount: amount(withdrawal.refundMinor, withdrawal.currency) })}
              </Btn>
            </div>
          </section>
        </div>
      ) : null}

      {token && !checking && !confirm.data && !tokenInvalid && !withdrawal ? (
        <div className={styles.stack}>
          <p className={styles.body}>{t('confirmSub')}</p>
          {withdrawGoneLine}
          {confirmError}
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
