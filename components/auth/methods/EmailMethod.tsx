'use client';

// EmailMethod — email + password sign-in and sign-up (both brands; GoApply's
// fallback). WP-10, PRODUCT_PLAN.md O0.
//
//   login   email · password · "Forgot password?" (only when reset is
//           available) → /auth/login → /auth/me → the onboarding screen when
//           unfinished, else `next`, else /jobs (sign-in only, never on every
//           page view). A 409 account_other_brand (password matched an
//           account of the other brand) shows the "continue there" notice.
//   signup  email · password with its rule checklist · the agreements
//           (marketing unchecked, required age, PDPA for zh-TW/TW) →
//           /auth/signup → the first onboarding screen. An email that belongs
//           to the other brand gets the same "check your email" screen.
// No partial-signup capture: nothing is sent before the visitor submits.

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { login, signup } from '../../../lib/api/auth';
import { RoboApiError } from '../../../lib/api/client';
import { useAuth } from '../../../lib/auth/AuthProvider';
import { signInRoute } from '../../../lib/auth/signInRoute';
import { browserTimeZone } from '../../../lib/auth/entry';
import { useFlag } from '../../../lib/flags';
import { Btn } from '../../v3/primitives/Btn';
import { AuthError, AuthField } from '../AuthShell';
import { agreementsComplete, consentsFrom, useAuthEntry } from '../agreements';
import { AgreementsFields } from '../../features/auth/AgreementsFields';
import { OtherBrandNotice, otherBrandUrlOf } from '../../features/auth/OtherBrandNotice';
import { PasswordRules, passwordOk } from '../../features/auth/PasswordRules';
import styles from '../../features/auth/auth.module.css';
import type { AuthMethodProps } from './registry';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function rawCode(err: unknown): string | undefined {
  if (!(err instanceof RoboApiError)) return undefined;
  return (err.payload as { code?: string } | undefined)?.code ?? err.code;
}

export function EmailMethod({ mode, next, onSuccess }: AuthMethodProps) {
  return mode === 'signup' ? <SignupForm next={next} onSuccess={onSuccess} /> : <LoginForm next={next} onSuccess={onSuccess} />;
}

function LoginForm({ next, onSuccess }: Pick<AuthMethodProps, 'next' | 'onSuccess'>) {
  const t = useTranslations('auth');
  const router = useRouter();
  const { refresh } = useAuth();
  const entry = useAuthEntry();
  const resetAvailable = useFlag('auth.passwordReset');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [otherBrandUrl, setOtherBrandUrl] = useState<string | null | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setOtherBrandUrl(undefined);
    setSubmitting(true);
    try {
      await login({ email, password });
      const me = await refresh();
      // login() set the cookie, but without a /me the session is unusable:
      // stay on the form rather than entering the app on empty defaults.
      if (!me) {
        setError(t('login.error_generic'));
        return;
      }
      onSuccess?.();
      router.replace(signInRoute(me, next ?? entry?.next ?? null));
    } catch (err) {
      const code = rawCode(err);
      if (code === 'account_other_brand') setOtherBrandUrl(otherBrandUrlOf((err as RoboApiError).payload));
      else if (code === 'account_disabled') setError(t('loginForm.disabled'));
      else if (code === 'account_deleted') setError(t('loginForm.deleted'));
      else if (code === 'rate_limited') setError(t('errors.rateLimited'));
      else if (code === 'network_error' || code === 'server_error') setError(t('errors.network'));
      else setError(t('login.error_generic'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="auth-form" noValidate>
      <AuthField
        label={t('login.email')}
        type="email"
        name="email"
        required
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <AuthField
        label={t('login.password')}
        type="password"
        name="password"
        required
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {resetAvailable ? (
        <div className={styles.linkRow}>
          <Link href={email ? `/forgot-password?email=${encodeURIComponent(email)}` : '/forgot-password'}>{t('loginForm.forgot')}</Link>
        </div>
      ) : null}
      {otherBrandUrl !== undefined ? <OtherBrandNotice url={otherBrandUrl} /> : null}
      {error ? <AuthError message={error} /> : null}
      <Btn type="submit" variant="primary" className="auth-submit" disabled={submitting || !email || !password} aria-busy={submitting}>
        {submitting ? t('login.submitting') : t('login.submit')}
      </Btn>
    </form>
  );
}

function SignupForm({ next, onSuccess }: Pick<AuthMethodProps, 'next' | 'onSuccess'>) {
  const t = useTranslations('auth');
  const router = useRouter();
  const { refresh } = useAuth();
  const entry = useAuthEntry();
  const agreements = entry?.agreements ?? { age: false, pdpa: false, marketing: false, pdpaRequired: false };

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<{ key: string; signIn?: boolean } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [checkEmail, setCheckEmail] = useState<string | null>(null);
  const [touchedEmail, setTouchedEmail] = useState(false);

  const emailValid = EMAIL_RE.test(email.trim());

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!emailValid) {
      setTouchedEmail(true);
      setError({ key: 'signupForm.emailInvalid' });
      return;
    }
    if (!passwordOk(password)) {
      setError({ key: 'signupForm.weakPassword' });
      return;
    }
    if (!agreementsComplete(agreements)) {
      setError({ key: agreements.age ? 'signupForm.pdpaRequired' : 'signupForm.ageRequired' });
      return;
    }
    setSubmitting(true);
    try {
      const res = await signup({
        email: email.trim().toLowerCase(),
        password,
        locale: entry?.locale,
        consents: consentsFrom(agreements),
        marketingOptIn: agreements.marketing,
        attribution: entry?.attribution,
        timezone: browserTimeZone(),
      });
      if (res.status === 'check_email') {
        setCheckEmail(email.trim().toLowerCase());
        return;
      }
      const me = await refresh();
      onSuccess?.();
      router.replace(('next' in res && res.next) || signInRoute(me, next ?? entry?.next ?? null));
    } catch (err) {
      const code = rawCode(err);
      if (code === 'email_taken') setError({ key: 'signupForm.emailTaken', signIn: true });
      else if (code === 'age_consent_required') setError({ key: 'signupForm.ageRequired' });
      else if (code === 'pdpa_consent_required') setError({ key: 'signupForm.pdpaRequired' });
      else if (code === 'weak_password' || code === 'invalid_password') setError({ key: 'signupForm.weakPassword' });
      else if (code === 'invalid_email') setError({ key: 'signupForm.emailInvalid' });
      else if (code === 'rate_limited') setError({ key: 'errors.rateLimited' });
      // GoApply email signup is closed server-side until WP-93 (invite + CN-0 consents).
      else if (code === 'signup_closed') setError({ key: 'signupForm.closed' });
      else setError({ key: 'signup.error_generic' });
    } finally {
      setSubmitting(false);
    }
  }

  if (checkEmail) {
    return (
      <div className={`${styles.notice} ${styles.status}`} role="status" data-testid="check-email">
        <p className={styles.noticeTitle}>{t('signupForm.checkEmailTitle')}</p>
        <p>{t('signupForm.checkEmailBody', { email: checkEmail })}</p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="auth-form" noValidate>
      <AuthField
        label={t('signup.email')}
        type="email"
        name="email"
        required
        autoComplete="email"
        value={email}
        aria-invalid={touchedEmail && !emailValid}
        onBlur={() => setTouchedEmail(true)}
        onChange={(e) => setEmail(e.target.value)}
      />
      {touchedEmail && email && !emailValid ? <p className={styles.error}>{t('signupForm.emailInvalid')}</p> : null}
      <div>
        <AuthField
          label={t('signup.password')}
          type="password"
          name="password"
          required
          autoComplete="new-password"
          aria-describedby="signup-password-rules"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <PasswordRules password={password} id="signup-password-rules" />
      </div>
      {entry?.setAgreements ? <AgreementsFields value={agreements} onChange={entry.setAgreements} /> : null}
      {error ? (
        error.signIn ? (
          <div className="auth-error" role="alert">
            <span>
              {t.rich(error.key, {
                signin: (chunks) => <Link href={`/login${typeof window !== 'undefined' ? window.location.search : ''}`}>{chunks}</Link>,
              })}
            </span>
          </div>
        ) : (
          <AuthError message={t(error.key)} />
        )
      ) : null}
      <Btn type="submit" variant="primary" className="auth-submit" disabled={submitting} aria-busy={submitting}>
        {submitting ? t('signupForm.submitting') : t('signupForm.submit')}
      </Btn>
    </form>
  );
}

export default EmailMethod;
