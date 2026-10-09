'use client';

// Forgot / reset password (WP-10; F-ACCT-02). The request always answers the
// same way (no account enumeration); the link works once, for 30 minutes,
// and saving a new password signs the user out everywhere else.
// When the brand has no email transport configured, reset is unavailable and
// the page says to contact support instead of pretending to send.

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { requestPasswordReset, resetPassword } from '../../../lib/api/auth';
import { RoboApiError } from '../../../lib/api/client';
import { useAuth } from '../../../lib/auth/AuthProvider';
import { signInRoute } from '../../../lib/auth/signInRoute';
import { useCapabilities } from '../../../lib/flags';
import { Btn } from '../../v3/primitives/Btn';
import { AuthBrandMark, AuthError, AuthField } from '../../auth/AuthShell';
import { PasswordRules, passwordOk } from './PasswordRules';
import styles from './auth.module.css';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ForgotPasswordView() {
  const t = useTranslations('auth');
  const params = useSearchParams();
  const { flags } = useCapabilities();
  const [email, setEmail] = useState(params?.get('email') ?? '');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const unavailable = flags !== null && flags['auth.passwordReset'] !== true;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const clean = email.trim().toLowerCase();
    if (!EMAIL_RE.test(clean)) {
      setError(t('signupForm.emailInvalid'));
      return;
    }
    setSubmitting(true);
    try {
      await requestPasswordReset(clean);
      setSentTo(clean);
    } catch (err) {
      const code = err instanceof RoboApiError ? err.code : undefined;
      setError(code === 'rate_limited' ? t('errors.rateLimited') : t('errors.network'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-card">
      <AuthBrandMark className="auth-card__brand" />
      <h1 className="auth-title">{t('forgot.title')}</h1>
      {unavailable ? (
        <div className={`${styles.notice} ${styles.status}`} role="status">
          <p>{t('forgot.unavailable')}</p>
        </div>
      ) : sentTo ? (
        <div className={`${styles.notice} ${styles.status}`} role="status" data-testid="reset-sent">
          <p className={styles.noticeTitle}>{t('forgot.sentTitle')}</p>
          <p>{t('forgot.sentBody', { email: sentTo })}</p>
        </div>
      ) : (
        <>
          <p className="auth-subtitle">{t('forgot.subtitle')}</p>
          <form onSubmit={onSubmit} className="auth-form" noValidate>
            <AuthField label={t('login.email')} type="email" name="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            {error ? <AuthError message={error} /> : null}
            <Btn type="submit" variant="primary" className="auth-submit" disabled={submitting} aria-busy={submitting}>
              {submitting ? t('forgot.submitting') : t('forgot.submit')}
            </Btn>
          </form>
        </>
      )}
      <p className="auth-switch">
        <Link href="/login">{t('common.backToSignIn')}</Link>
      </p>
    </div>
  );
}

export function ResetPasswordView({ token }: { token: string }) {
  const t = useTranslations('auth');
  const router = useRouter();
  const { refresh } = useAuth();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<{ key: string; requestNew?: boolean } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!passwordOk(password)) {
      setError({ key: 'signupForm.weakPassword' });
      return;
    }
    setSubmitting(true);
    try {
      const res = await resetPassword(token, password);
      const me = await refresh();
      router.replace(res.next || signInRoute(me, null));
    } catch (err) {
      const code = err instanceof RoboApiError ? ((err.payload as { code?: string } | undefined)?.code ?? err.code) : undefined;
      if (code === 'token_expired') setError({ key: 'reset.expired', requestNew: true });
      else if (code === 'token_invalid') setError({ key: 'reset.invalid', requestNew: true });
      else if (code === 'invalid_request' || code === 'weak_password') setError({ key: 'signupForm.weakPassword' });
      else if (code === 'rate_limited') setError({ key: 'errors.rateLimited' });
      else setError({ key: 'errors.network' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-card">
      <AuthBrandMark className="auth-card__brand" />
      <h1 className="auth-title">{t('reset.title')}</h1>
      <p className="auth-subtitle">{t('reset.subtitle')}</p>
      <form onSubmit={onSubmit} className="auth-form" noValidate>
        <div>
          <AuthField
            label={t('reset.password')}
            type="password"
            name="password"
            required
            autoComplete="new-password"
            aria-describedby="reset-password-rules"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <PasswordRules password={password} id="reset-password-rules" />
        </div>
        {error ? (
          <div>
            <AuthError message={t(error.key)} />
            {error.requestNew ? (
              <p className={styles.inline} style={{ marginTop: 8 }}>
                <Link href="/forgot-password">{t('reset.requestNew')}</Link>
              </p>
            ) : null}
          </div>
        ) : null}
        <Btn type="submit" variant="primary" className="auth-submit" disabled={submitting} aria-busy={submitting}>
          {submitting ? t('reset.submitting') : t('reset.submit')}
        </Btn>
      </form>
      <p className="auth-switch">
        <Link href="/login">{t('common.backToSignIn')}</Link>
      </p>
    </div>
  );
}
