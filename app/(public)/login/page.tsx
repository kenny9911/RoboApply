'use client';

// Login — the consumer-facing form card on the right of the auth split screen
// (the brand hero is rendered by (public)/layout.tsx). Presentation only: the
// auth data flow (login → refresh → next-param / jobApplyingEnabled / hasResume
// routing) is unchanged from the placeholder.

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
      const next = params?.get('next');
      const hasResume = !!me?.onboardingState?.completedSteps?.includes('resume');
      // When job-applying is off, the auto-apply onboarding + Today home are
      // gone: returning users land on Mock Interview, new users on the Resume
      // Builder. (`next` from a deep-link still wins; the route gates redirect
      // it if it points at a now-hidden surface.)
      const jobApplyingEnabled = me?.jobApplyingEnabled !== false;
      if (next) {
        router.replace(next);
      } else if (jobApplyingEnabled) {
        // Skip onboarding for returning users who already uploaded a
        // master resume — they should land on the home dashboard, not
        // the upload-resume step.
        router.replace(hasResume ? '/home' : '/onboarding');
      } else {
        router.replace(hasResume ? '/mock-interview' : '/resumes');
      }
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
