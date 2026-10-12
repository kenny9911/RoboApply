'use client';

// BindPhoneForm — /bind-phone (TASK_PLAN.md WP-11; CN-L-08 real-name).
// After WeChat sign-in an account has no verified number; AI features answer
// 403 phone_binding_required until one is bound. +86 only, SMS code with a
// 60 s resend countdown. When the number already belongs to an account on
// this site and the WeChat account is new and empty, the server moves the
// WeChat sign-in onto that account (`merged`) and says so here.

import { useId, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { bindPhone, sendPhoneCode } from '../../../lib/api/authCn';
import { apiErrorCode } from '../../../lib/api/contracts/wire';
import { useAuth } from '../../../lib/auth/AuthProvider';
import { isTwoFactorRequired, twoFactorHref } from '../../../lib/auth/twoFactor';
import { useFlag } from '../../../lib/flags';
import { Btn } from '../../v3/primitives/Btn';
import { errorMessage, isValidCnPhone, maskPhoneInput, normalizePhoneInput, OTP_RE, safeNextPath, useCountdown } from './shared';
import styles from './AuthCn.module.css';

export interface BindPhoneFormProps {
  /** Where to continue afterwards (same-site path); the server's route wins when onboarding is unfinished. */
  next?: string | null;
}

export function BindPhoneForm({ next }: BindPhoneFormProps) {
  const t = useTranslations('authCn');
  const router = useRouter();
  const { status, refresh } = useAuth();
  const phoneOtp = useFlag('auth.phoneOtp');
  const ids = useId();
  const countdown = useCountdown();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [merged, setMerged] = useState<string | null>(null);
  const phoneOk = isValidCnPhone(phone);
  const safe = safeNextPath(next);

  if (status === 'unauthenticated') {
    return (
      <div className={styles.form}>
        <p className={styles.notice}>{t('bind.signInFirst')}</p>
        <Btn as="a" href={`/login?next=${encodeURIComponent(`/bind-phone${safe ? `?next=${encodeURIComponent(safe)}` : ''}`)}`} variant="primary" className={styles.submit}>
          {t('bind.signInCta')}
        </Btn>
      </div>
    );
  }

  if (!phoneOtp) {
    return <p className={styles.notice}>{t('errors.feature_disabled')}</p>;
  }

  if (merged) {
    return (
      <div className={styles.form}>
        <p className={styles.notice} role="status">
          {t('bind.merged')}
        </p>
        <Btn variant="primary" className={styles.submit} onClick={() => router.replace(merged)}>
          {t('submit')}
        </Btn>
      </div>
    );
  }

  async function onSend() {
    setError(null);
    if (!phoneOk) {
      setError(t('phone.invalid'));
      return;
    }
    setSending(true);
    try {
      const res = await sendPhoneCode({ phone: normalizePhoneInput(phone), purpose: 'bind' });
      countdown.start(res.resendInSec);
      setSentTo(maskPhoneInput(phone));
    } catch (err) {
      setError(errorMessage(err, t));
    } finally {
      setSending(false);
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!phoneOk) return setError(t('phone.invalid'));
    if (!OTP_RE.test(code)) return setError(t('code.invalid'));
    setSubmitting(true);
    try {
      const res = await bindPhone({ phone: normalizePhoneInput(phone), code, ...(safe ? { next: safe } : {}) });
      await refresh();
      if (res.merged) setMerged(res.nextRoute);
      else router.replace(res.nextRoute);
    } catch (err) {
      // The number belongs to an account with two-step sign-in on: finish there.
      if (isTwoFactorRequired(err)) {
        router.replace(twoFactorHref(err, safeNextPath(next)));
        return;
      }
      if (apiErrorCode(err) === 'unauthorized') await refresh();
      setError(errorMessage(err, t));
    } finally {
      setSubmitting(false);
    }
  }

  const phoneId = `${ids}-phone`;
  const codeId = `${ids}-code`;
  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate aria-busy={submitting}>
      <div className={styles.field}>
        <label htmlFor={phoneId} className={styles.label}>
          {t('phone.label')}
        </label>
        <div className={styles.inputWrap}>
          <span className={styles.prefix} aria-hidden="true">
            {t('phone.prefix')}
          </span>
          <input
            id={phoneId}
            className={styles.input}
            type="tel"
            inputMode="numeric"
            autoComplete="tel-national"
            maxLength={14}
            placeholder={t('phone.placeholder')}
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/[^\d+\s-]/g, ''))}
          />
        </div>
      </div>
      <div className={styles.field}>
        <label htmlFor={codeId} className={styles.label}>
          {t('code.label')}
        </label>
        <div className={styles.control}>
          <div className={styles.inputWrap}>
            <input
              id={codeId}
              className={styles.input}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder={t('code.placeholder')}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            />
          </div>
          <button type="button" className={styles.sendBtn} onClick={onSend} disabled={!phoneOk || sending || countdown.left > 0}>
            {sending ? t('code.sending') : countdown.left > 0 ? t('code.resendIn', { seconds: countdown.left }) : t('code.send')}
          </button>
        </div>
        {sentTo ? (
          <p className={styles.hint} role="status">
            {t('code.sent', { phone: sentTo })}
          </p>
        ) : null}
      </div>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      <Btn type="submit" variant="primary" className={styles.submit} disabled={submitting} aria-busy={submitting}>
        {submitting ? t('bind.submitting') : t('bind.submit')}
      </Btn>
      <Link href={safe ?? '/resume'} className={styles.linkBtn}>
        {t('bind.skip')}
      </Link>
    </form>
  );
}

/** The /bind-phone card inside the (public) sign-in layout. */
export function BindPhoneCard({ next }: BindPhoneFormProps) {
  const t = useTranslations('authCn');
  return (
    <div className="auth-card">
      <h1 className="auth-title">{t('bind.title')}</h1>
      <p className="auth-subtitle">{t('bind.subtitle')}</p>
      <div className="auth-form">
        <BindPhoneForm next={next} />
      </div>
    </div>
  );
}
