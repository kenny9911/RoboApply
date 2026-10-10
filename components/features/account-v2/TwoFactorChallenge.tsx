'use client';

// TwoFactorChallenge — /login/2fa, the second step of a password sign-in
// (F-TRUST-07; TASK_PLAN.md WP-79). POST /auth/login answered 401
// `two_factor_required` and set the httpOnly challenge cookie; this page
// takes a code from the authenticator app (or a recovery code) and, on
// success, enters the app the way the email form does: /auth/me, then the
// unfinished onboarding screen, `next`, or /jobs. An expired or used
// challenge sends the person back to sign in. Nothing here can skip the code.

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import { AuthBrandMark, AuthError } from '../../auth/AuthShell';
import { completeTwoFactorSignIn } from '../../../lib/api/accountV2';
import { RoboApiError } from '../../../lib/api/client';
import { useAuth } from '../../../lib/auth/AuthProvider';
import { signInRoute } from '../../../lib/auth/signInRoute';
import { CodeInput } from './TwoFactorSettings';
import styles from './accountV2.module.css';

const CODE_RE = /^\d{6}$/;
const RECOVERY_RE = /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i;

function failure(err: unknown): { code: string | null; attemptsLeft: number | null } {
  if (!(err instanceof RoboApiError)) return { code: null, attemptsLeft: null };
  const payload = err.payload as { code?: unknown; details?: { attemptsLeft?: unknown } } | undefined;
  const code = typeof payload?.code === 'string' ? payload.code : err.code;
  const left = payload?.details?.attemptsLeft;
  return { code, attemptsLeft: typeof left === 'number' ? left : null };
}

export function TwoFactorChallenge() {
  const t = useTranslations('accountV2');
  const router = useRouter();
  const params = useSearchParams();
  const { refresh } = useAuth();
  const [useRecovery, setUseRecovery] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const next = params?.get('next') ?? null;
  const loginHref = next ? `/login?next=${encodeURIComponent(next)}` : '/login';
  const valid = useRecovery ? RECOVERY_RE.test(value) : CODE_RE.test(value);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!valid || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await completeTwoFactorSignIn(useRecovery ? { recoveryCode: value } : { code: value });
      const me = await refresh();
      if (!me) {
        setError(t('common.generic'));
        return;
      }
      router.replace(signInRoute(me, next));
    } catch (err) {
      const { code, attemptsLeft } = failure(err);
      if (code === 'two_factor_challenge_invalid') {
        setExpired(true);
      } else if (code === 'totp_invalid') {
        setError(attemptsLeft !== null ? `${t('challenge.invalid')} ${t('challenge.triesLeft', { n: attemptsLeft })}` : t('challenge.invalid'));
        if (attemptsLeft === 0) setExpired(true);
      } else if (code === 'totp_key_missing') {
        setError(t('twoFactor.errors.totp_key_missing'));
        setUseRecovery(true);
        setValue('');
      } else if (code === 'rate_limited') {
        setError(t('common.rateLimited'));
      } else if (code === 'network_error' || code === 'server_error' || code === 'two_factor_unavailable') {
        setError(t('common.network'));
      } else {
        setError(t('common.generic'));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-card" data-auth-mode="login" data-testid="two-factor-challenge">
      <AuthBrandMark className="auth-card__brand" />
      <h1 className="auth-title">{t('challenge.title')}</h1>
      <p className="auth-subtitle">{useRecovery ? t('challenge.subRecovery') : t('challenge.sub')}</p>
      {expired ? (
        <div className={styles.stack}>
          <AuthError message={t('challenge.expired')} />
          <div className={styles.actions}>
            <Btn as="a" href={loginHref} variant="primary">
              {t('challenge.backToLogin')}
            </Btn>
          </div>
        </div>
      ) : (
        <form className={`auth-form ${styles.stack}`} onSubmit={onSubmit} noValidate>
          <CodeInput
            label={useRecovery ? t('challenge.recoveryLabel') : t('challenge.codeLabel')}
            value={value}
            onChange={setValue}
            recovery={useRecovery}
          />
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => {
              setUseRecovery((v) => !v);
              setValue('');
              setError(null);
            }}
          >
            {useRecovery ? t('challenge.useCode') : t('challenge.useRecovery')}
          </button>
          {error ? <AuthError message={error} /> : null}
          <Btn type="submit" variant="primary" className="auth-submit" disabled={!valid || submitting} aria-busy={submitting || undefined}>
            {submitting ? t('challenge.submitting') : t('challenge.submit')}
          </Btn>
          <Link href={loginHref} className={styles.linkButton}>
            {t('challenge.backToLogin')}
          </Link>
        </form>
      )}
    </div>
  );
}

export default TwoFactorChallenge;
