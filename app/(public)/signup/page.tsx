'use client';

// Signup — the consumer-facing form card on the right of the auth split screen
// (the brand hero is rendered by (public)/layout.tsx). Presentation only: the
// auth data flow (signup → refresh → jobApplyingEnabled routing) is unchanged
// from the placeholder.

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { signup } from '../../../lib/api/auth';
import { useAuth } from '../../../lib/auth/AuthProvider';
import { Btn } from '../../../components/v3/primitives/Btn';
import { AuthBrandMark, AuthField, AuthError } from '../../../components/auth/AuthShell';

export default function SignupPage() {
  const t = useTranslations('auth.signup');
  const router = useRouter();
  const { refresh } = useAuth();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signup({ email, password, name: name || undefined });
      await refresh();
      // New users pick a plan first (Free / Starter / Growth). The plan step
      // then forwards to onboarding (or the Resume Builder when job-applying is
      // off) — its own routing mirrors the jobApplyingEnabled logic.
      router.replace('/choose-plan');
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
          label={t('name')}
          type="text"
          autoComplete="name"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <AuthField
          label={t('email')}
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <AuthField
          label={t('password')}
          type="password"
          required
          autoComplete="new-password"
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
        {t('has_account')}{' '}
        <Link href="/login">{t('login_cta')}</Link>
      </p>
    </div>
  );
}
