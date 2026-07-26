'use client';

// Login — the consumer-facing form card on the right of the auth split screen
// (the brand hero is rendered by (public)/layout.tsx). Presentation only: the
// auth data flow (login → refresh → `next` param → /jobs) is unchanged from the
// placeholder apart from the destination, which no longer branches.

import { FormEvent, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { login } from '../../../lib/api/auth';
import { useAuth } from '../../../lib/auth/AuthProvider';
import { Btn } from '../../../components/v3/primitives/Btn';
import { AuthBrandMark, AuthField, AuthError } from '../../../components/auth/AuthShell';

export default function LoginPage() {
  const t = useTranslations('auth.login');
  const router = useRouter();
  const params = useSearchParams();
  const { refresh } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login({ email, password });
      const me = await refresh();
      // login() resolved (200 + session cookie set), but if the follow-up /me
      // didn't yield a session (transient 5xx/network, or an account the /me
      // gate rejects) DON'T treat it as success: surface an error and stay on
      // the form instead of redirecting into the app on null-`me` defaults.
      if (!me) {
        setError(t('error_generic'));
        return;
      }
      // Only honour a same-origin relative `next` — reject absolute URLs and
      // protocol-relative ("//evil.com") / backslash tricks so a crafted
      // ?next= can't turn the post-login redirect into an open redirect.
      const rawNext = params?.get('next');
      const next = rawNext && /^\/(?![/\\])/.test(rawNext) ? rawNext : null;
      // One destination, no branch. /jobs IS the product (ruling R1), so the
      // JOB_APPLYING_ENABLED fork is gone, and so is the has-a-resume fork:
      // /onboarding no longer exists (setup is a panel in the /jobs filter bar,
      // C21) and ResumeGate already shows the upload prompt to a user with no
      // résumé, in place, on /jobs. A deep-link `next` still wins.
      router.replace(next ?? '/jobs');
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t('error_generic'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-card">
      <AuthBrandMark className="auth-card__brand" />
      <h1 className="auth-title">{t('title')}</h1>
      <p className="auth-subtitle">{t('subtitle')}</p>

      <form onSubmit={onSubmit} className="auth-form">
        <AuthField
          label={t('email')}
          type="email"
          required
          autoComplete="email"
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <AuthField
          label={t('password')}
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error ? <AuthError message={error} /> : null}
        <Btn
          type="submit"
          variant="primary"
          className="auth-submit"
          disabled={submitting}
          aria-busy={submitting}
        >
          {submitting ? t('submitting') : t('submit')}
        </Btn>
      </form>

      <p className="auth-switch">
        {t('no_account')}{' '}
        <Link href="/signup">{t('signup_cta')}</Link>
      </p>
    </div>
  );
}
